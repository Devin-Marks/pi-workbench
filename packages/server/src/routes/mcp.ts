import type { FastifyPluginAsync } from "fastify";
import {
  deleteMcpServer,
  readMcpJsonRedacted,
  setMcpDisabled,
  upsertMcpServer,
  type McpServerConfig,
  type McpTransport,
} from "../mcp/config.js";
import {
  customToolsForProject,
  ensureProjectLoaded,
  getStatus,
  isGloballyEnabled,
  probe,
  reloadGlobal,
} from "../mcp/manager.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

interface McpServerBody {
  url: string;
  transport?: McpTransport;
  enabled?: boolean;
  headers?: Record<string, string>;
}

const serverConfigSchema = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1 },
    transport: { type: "string", enum: ["auto", "streamable-http", "sse"] },
    enabled: { type: "boolean" },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} as const;

const statusEntrySchema = {
  type: "object",
  required: ["scope", "name", "url", "enabled", "state", "toolCount"],
  properties: {
    scope: { type: "string", enum: ["global", "project"] },
    projectId: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    enabled: { type: "boolean" },
    state: {
      type: "string",
      enum: ["idle", "connecting", "connected", "error", "disabled"],
    },
    toolCount: { type: "integer", minimum: 0 },
    lastError: { type: "string" },
    transport: { type: "string", enum: ["auto", "streamable-http", "sse"] },
  },
} as const;

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- master enable/disable + connection summary ----
  fastify.get(
    "/mcp/settings",
    {
      schema: {
        description:
          "Master MCP toggle + a compact connection summary the header " +
          "badge consumes. `enabled` mirrors `mcp.json#disabled === false`. " +
          "`connected` / `total` count GLOBAL servers only (project-scope " +
          "counts come from /mcp/servers?projectId=...).",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["enabled", "connected", "total"],
            properties: {
              enabled: { type: "boolean" },
              connected: { type: "integer", minimum: 0 },
              total: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    async () => {
      const status = getStatus();
      const enabled = isGloballyEnabled();
      const total = status.length;
      const connected = status.filter((s) => s.state === "connected").length;
      return { enabled, connected, total };
    },
  );

  fastify.put<{ Body: { enabled: boolean } }>(
    "/mcp/settings",
    {
      schema: {
        description:
          "Toggle the master MCP enable/disable flag. When disabled, no " +
          "MCP tools are passed into createAgentSession (existing live " +
          "sessions are unaffected — start a new session to apply).",
        tags: ["config"],
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
        response: {
          200: {
            type: "object",
            required: ["enabled", "connected", "total"],
            properties: {
              enabled: { type: "boolean" },
              connected: { type: "integer", minimum: 0 },
              total: { type: "integer", minimum: 0 },
            },
          },
          400: errorSchema,
        },
      },
    },
    async (req) => {
      await setMcpDisabled(!req.body.enabled);
      await reloadGlobal();
      const status = getStatus();
      return {
        enabled: isGloballyEnabled(),
        total: status.length,
        connected: status.filter((s) => s.state === "connected").length,
      };
    },
  );

  // ---- list global servers (config view; redacted) ----
  fastify.get(
    "/mcp/servers",
    {
      schema: {
        description:
          "List the GLOBAL MCP server registry (workbench-owned at " +
          "${WORKBENCH_DATA_DIR}/mcp.json). Header values are redacted with " +
          "the same '***REDACTED***' sentinel pattern as models.json. Pass " +
          "?projectId=<id> to also include the project-scoped registry " +
          "(read from <projectPath>/.mcp.json).",
        tags: ["config"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["servers", "status"],
            properties: {
              servers: { type: "object", additionalProperties: serverConfigSchema },
              status: { type: "array", items: statusEntrySchema },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (req) => {
      const projectId = (req.query as { projectId?: string }).projectId;
      // If a project was passed, eagerly load its .mcp.json so the
      // status array reflects current state. The global file is
      // already loaded at server boot.
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project !== undefined) {
          await ensureProjectLoaded(project.id, project.path);
        }
      }
      const cfg = await readMcpJsonRedacted();
      return {
        servers: cfg.servers,
        status: getStatus(projectId !== undefined ? { projectId } : undefined),
      };
    },
  );

  // ---- create / replace a global server ----
  fastify.put<{ Params: { name: string }; Body: McpServerBody }>(
    "/mcp/servers/:name",
    {
      schema: {
        description:
          "Create or replace a GLOBAL MCP server entry. Project-scoped " +
          "servers are read-only via this API — edit `.mcp.json` at the " +
          "project root. Headers carrying the '***REDACTED***' sentinel " +
          "are merged with the prior on-disk value (same pattern as " +
          "PUT /config/models).",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
        body: serverConfigSchema,
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req) => {
      const { name } = req.params;
      const cfg: McpServerConfig = { url: req.body.url };
      if (req.body.transport !== undefined) cfg.transport = req.body.transport;
      if (req.body.enabled !== undefined) cfg.enabled = req.body.enabled;
      if (req.body.headers !== undefined) cfg.headers = req.body.headers;
      await upsertMcpServer(name, cfg);
      await reloadGlobal();
      return { ok: true };
    },
  );

  // ---- delete a global server ----
  fastify.delete<{ Params: { name: string } }>(
    "/mcp/servers/:name",
    {
      schema: {
        description:
          "Remove a GLOBAL MCP server entry. Project-scoped servers must " +
          "be removed by editing the project's `.mcp.json` file directly.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["removed"],
            properties: { removed: { type: "boolean" } },
          },
          500: errorSchema,
        },
      },
    },
    async (req) => {
      const removed = await deleteMcpServer(req.params.name);
      if (removed) await reloadGlobal();
      return { removed };
    },
  );

  // ---- probe (force reconnect + relist tools) ----
  fastify.post<{ Params: { name: string }; Querystring: { projectId?: string } }>(
    "/mcp/servers/:name/probe",
    {
      schema: {
        description:
          "Force a reconnect for the named server and return the new " +
          "status entry. Pass ?projectId=<id> to probe a project-scoped " +
          "server (defaults to the global server with that name).",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: statusEntrySchema },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const projectId = req.query.projectId;
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project === undefined) {
          return reply.code(404).send({ error: "project_not_found" });
        }
        await ensureProjectLoaded(project.id, project.path);
        const status = await probe({ project: project.id }, name);
        if (status === undefined) {
          return reply.code(404).send({ error: "mcp_server_not_found" });
        }
        return { status };
      }
      const status = await probe("global", name);
      if (status === undefined) {
        return reply.code(404).send({ error: "mcp_server_not_found" });
      }
      return { status };
    },
  );

  // ---- list aggregated tools for a project ----
  fastify.get<{ Querystring: { projectId: string } }>(
    "/mcp/tools",
    {
      schema: {
        description:
          "Flat list of every MCP tool currently available to sessions in " +
          "the given project (global ∪ project, project wins on name " +
          "collision). Use this for diagnostic/status displays — the actual " +
          "wiring into createAgentSession happens server-side.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["tools"],
            properties: {
              tools: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "description"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      await ensureProjectLoaded(project.id, project.path);
      const tools = customToolsForProject(project.id).map((t) => ({
        name: t.name,
        description: t.description,
      }));
      return { tools };
    },
  );
};
