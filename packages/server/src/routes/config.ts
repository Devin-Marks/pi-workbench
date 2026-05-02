import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthProviderNotFoundError,
  liveProvidersListing,
  getAllSkillOverrides,
  listSkills,
  readAuthSummary,
  readModelsJsonRedacted,
  readSettings,
  removeApiKey,
  setSkillEnabled,
  SkillNotFoundError,
  updateSettings,
  writeApiKey,
  writeModelsJson,
  type ModelsJson,
} from "../config-manager.js";
import { buildExportTar, importConfigFromBuffer, MAX_IMPORT_BYTES } from "../config-export.js";
import {
  ensureProjectLoaded as mcpEnsureProjectLoaded,
  getStatus as mcpGetStatus,
} from "../mcp/manager.js";
import { BUILTIN_TOOL_NAMES } from "../session-registry.js";
import { readToolOverrides, setToolEnabled, type ToolFamily } from "../tool-overrides.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

const modelsJsonSchema = {
  type: "object",
  required: ["providers"],
  additionalProperties: true,
  properties: {
    // Loose validation: route accepts any shape under `providers` and lets
    // the SDK reject malformed configs at load time. Tighter validation can
    // come once the dev plan freezes the provider config schema.
    providers: { type: "object", additionalProperties: true },
  },
} as const;

const settingsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    // Each field accepts its real type OR null (which the handler interprets
    // as "delete this key"). Loose typing on purpose — strict enums break the
    // null-delete contract documented on the PUT route. The SDK validates
    // settings.json shape on next read.
    defaultProvider: { type: ["string", "null"] },
    defaultModel: { type: ["string", "null"] },
    defaultThinkingLevel: { type: ["string", "null"] },
    steeringMode: { type: ["string", "null"] },
    followUpMode: { type: ["string", "null"] },
    skills: { type: ["array", "null"], items: { type: "string" } },
    enableSkillCommands: { type: ["boolean", "null"] },
  },
} as const;

const authSummarySchema = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["configured"],
        properties: {
          configured: { type: "boolean" },
          source: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
} as const;

const providersListingSchema = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "array",
      items: {
        type: "object",
        required: ["provider", "models"],
        properties: {
          provider: { type: "string" },
          models: {
            type: "array",
            items: {
              type: "object",
              required: [
                "id",
                "name",
                "contextWindow",
                "maxTokens",
                "reasoning",
                "input",
                "hasAuth",
              ],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                contextWindow: { type: "integer" },
                maxTokens: { type: "integer" },
                reasoning: { type: "boolean" },
                input: { type: "array", items: { type: "string" } },
                hasAuth: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const skillSchema = {
  type: "object",
  required: [
    "name",
    "description",
    "source",
    "filePath",
    "enabled",
    "effective",
    "disableModelInvocation",
  ],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    source: { type: "string", enum: ["global", "project"] },
    filePath: { type: "string" },
    enabled: { type: "boolean" },
    /** Tri-state per-project override; absent = inherit from global. */
    projectOverride: { type: "string", enum: ["enabled", "disabled"] },
    /** Resolved state the agent in the queried project would see. */
    effective: { type: "boolean" },
    disableModelInvocation: { type: "boolean" },
  },
} as const;

function internalError(reply: FastifyReply, err: unknown): FastifyReply {
  reply.log.error({ err }, "config route error");
  return reply.code(500).send({ error: "internal_error" });
}

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  // ---------------------- models.json ----------------------
  fastify.get(
    "/config/models",
    {
      schema: {
        description:
          "Read `models.json` (custom provider configurations). Inline `apiKey` " +
          "and `apiKeyCommand` fields are returned as `***REDACTED***` so the " +
          "raw secret never leaves the server. The persisted file is unchanged " +
          "— PUT /config/models takes the actual values; the redaction is on " +
          "the read path only.",
        tags: ["config"],
        response: { 200: modelsJsonSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readModelsJsonRedacted();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: ModelsJson }>(
    "/config/models",
    {
      schema: {
        description:
          "Replace `models.json` atomically. The SDK validates the structure " +
          "on the next session creation; malformed configs are rejected then.",
        tags: ["config"],
        body: modelsJsonSchema,
        response: { 200: modelsJsonSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        await writeModelsJson(req.body);
        return req.body;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- live providers ----------------------
  fastify.get(
    "/config/providers",
    {
      schema: {
        description:
          "Live provider + model listing assembled from the SDK's ModelRegistry " +
          "(combines built-in models with anything in `models.json`). Each model " +
          "carries a `hasAuth` boolean so the UI can dim entries with no key.",
        tags: ["config"],
        response: { 200: providersListingSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await liveProvidersListing();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- settings.json ----------------------
  fastify.get(
    "/config/settings",
    {
      schema: {
        description: "Read `settings.json` (default provider/model, modes, skills list, etc).",
        tags: ["config"],
        response: { 200: settingsSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readSettings();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: Record<string, unknown> }>(
    "/config/settings",
    {
      schema: {
        description:
          "Partial-merge update for `settings.json`. Sending `null` for any key " +
          "deletes it; other values overwrite. Atomic write.",
        tags: ["config"],
        body: settingsSchema,
        response: { 200: settingsSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        return await updateSettings(req.body);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- auth.json (presence only) ----------------------
  fastify.get(
    "/config/auth",
    {
      schema: {
        description:
          "Provider credential PRESENCE map. Never includes actual key values — " +
          "the response shape is presence + source + label only.",
        tags: ["config"],
        response: { 200: authSummarySchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return readAuthSummary();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Params: { provider: string }; Body: { apiKey: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description:
          "Store an API key for a provider. The key is written to `auth.json` " +
          "(file-locked via the SDK); existing keys for OTHER providers are " +
          "untouched. Body: `{ apiKey }`.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["apiKey"],
          additionalProperties: false,
          properties: { apiKey: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["provider", "configured"],
            properties: {
              provider: { type: "string" },
              configured: { type: "boolean", const: true },
            },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        writeApiKey(req.params.provider, req.body.apiKey);
        return { provider: req.params.provider, configured: true };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { provider: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description: "Remove credentials for a provider.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        response: { 204: { type: "null" }, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        removeApiKey(req.params.provider);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof AuthProviderNotFoundError) {
          return reply.code(404).send({ error: "auth_provider_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- skills ----------------------
  fastify.get<{ Querystring: { projectId: string } }>(
    "/config/skills",
    {
      schema: {
        description:
          "List skills discovered for a project. Skills come from two sources: " +
          "the global `~/.pi/agent/skills/` and the project-local `.pi/skills/`. " +
          "Each skill carries `enabled` reflecting whether it's listed in " +
          "`settings.skills`. Required: `?projectId=`.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const skills = await listSkills(project.path, project.id);
        return { skills };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // Cascade view: every per-project override across every project,
  // for the Settings UI's per-skill expand-and-show-all-projects
  // affordance. Single small JSON file on disk; one fetch per
  // tab-open is fine.
  fastify.get(
    "/config/skills/overrides",
    {
      schema: {
        description:
          "All per-project skill overrides across all projects. Returns " +
          "`{ projects: { <projectId>: { enable: [...], disable: [...] } } }`. " +
          "Absent project keys mean 'no overrides defined' (the project " +
          "inherits everything from global).",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  required: ["enable", "disable"],
                  properties: {
                    enable: { type: "array", items: { type: "string" } },
                    disable: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        return await getAllSkillOverrides();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { name: string };
    Querystring: { projectId: string };
    Body: { enabled: boolean; scope?: "global" | "project" };
  }>(
    "/config/skills/:name/enabled",
    {
      schema: {
        description:
          "Toggle a skill's enabled state. Default scope=`global` mutates " +
          "pi's `settings.skills` (canonical enable/disable list shared with " +
          "the pi TUI). scope=`project` writes to the workbench-private " +
          "overrides file at `${WORKBENCH_DATA_DIR}/skills-overrides.json` " +
          "for the project named in `?projectId=`. Project-scope overrides " +
          "follow tri-state semantics: `enabled` adds, `disabled` removes; " +
          "absence (cleared via DELETE) inherits from global. Skill changes " +
          "apply on the NEXT session created in the affected project — live " +
          "sessions keep the skill set they booted with.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            scope: { type: "string", enum: ["global", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const scope = req.body.scope ?? "global";
        const skills = await setSkillEnabled(req.params.name, req.body.enabled, project.path, {
          scope,
          projectId: project.id,
        });
        return { skills };
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          return reply.code(404).send({ error: "skill_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{
    Params: { name: string };
    Querystring: { projectId: string };
  }>(
    "/config/skills/:name/enabled",
    {
      schema: {
        description:
          "Clear a skill's PROJECT override (= return it to inherit from " +
          "global). Does not affect pi's settings.skills. Use the PUT " +
          "endpoint to change global state.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const skills = await setSkillEnabled(req.params.name, undefined, project.path, {
          scope: "project",
          projectId: project.id,
        });
        return { skills };
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          return reply.code(404).send({ error: "skill_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- export / import ----------------------
  // Two routes that round-trip the workbench's portable config
  // (mcp.json + settings.json + models.json — see config-export.ts
  // header for what's in and what's out).
  fastify.get(
    "/config/export",
    {
      schema: {
        description:
          "Stream a `.tar.gz` of the portable workbench config: " +
          "`mcp.json`, `settings.json`, and `models.json`. Excludes " +
          "`auth.json` (provider keys / OAuth tokens) and any " +
          "installation-bound files (jwt-secret, password-hash). " +
          "The header `X-Pi-Workbench-Files` lists the names actually " +
          "included so a client can warn when a file was missing on " +
          "disk and therefore omitted from the export.",
        tags: ["config"],
        response: {
          200: {
            description: "gzip-compressed tar of the included files",
            type: "string",
            format: "binary",
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        const { files, stream } = await buildExportTar();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        reply
          .header("Content-Type", "application/gzip")
          .header("Content-Disposition", `attachment; filename="pi-workbench-config-${ts}.tar.gz"`)
          .header("X-Pi-Workbench-Files", files.join(","));
        return reply.send(stream);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.post(
    "/config/import",
    {
      schema: {
        description:
          "Restore a `.tar.gz` previously produced by `/config/export`. " +
          "The archive must contain only the three top-level files " +
          "`mcp.json`, `settings.json`, `models.json` — anything else " +
          "is reported in `skipped`. Each accepted file is parsed as " +
          "JSON; ALL files must validate before ANY are written. " +
          "Imported files land atomically (`.tmp` + rename). " +
          "**Provider auth is NOT included in exports** — re-authenticate " +
          "providers via the Auth settings page after import.",
        tags: ["config"],
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            required: ["imported", "skipped", "errors"],
            properties: {
              imported: { type: "array", items: { type: "string" } },
              skipped: { type: "array", items: { type: "string" } },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  required: ["file", "reason"],
                  properties: {
                    file: { type: "string" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          413: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req: FastifyRequest, reply) => {
      // Single multipart file expected. Anything beyond the first is
      // ignored — the import contract is "one tar.gz per request."
      let buf: Buffer;
      try {
        const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
        if (file === undefined) {
          return reply.code(400).send({ error: "no_file" });
        }
        buf = await file.toBuffer();
        // toBuffer caps silently at the size limit; detect via the
        // `truncated` flag the multipart stream sets, otherwise the
        // user gets a confused "tar parse error" instead of the right
        // 413 with a clear message.
        if (file.file.truncated) {
          return reply.code(413).send({
            error: "file_too_large",
            message: `import archive exceeds ${MAX_IMPORT_BYTES} bytes`,
          });
        }
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_multipart",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const summary = await importConfigFromBuffer(buf);
        return summary;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- per-tool overrides ----------------------
  // Surface the unified tool view (builtins + per-MCP-server tools)
  // and a single toggle endpoint. The agent-side filter that applies
  // these overrides lives in `session-registry.buildToolsAllowlist`
  // and runs at every `createAgentSession` site — see that function
  // for the runtime semantics. This route pair is just the operator
  // interface.
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/config/tools",
    {
      schema: {
        description:
          "List every tool the agent could see, with its current " +
          "enable/disable state. Two families: `builtin` (pi's seven " +
          "shipped coding tools — read, bash, edit, write, grep, " +
          "find, ls) and `mcp` (one entry per connected MCP server, " +
          "each with its tool list). When `?projectId=` is provided, " +
          "project-scoped MCP servers are included alongside global " +
          "ones; the project-scope server-name shadowing rule from " +
          "`mcp/manager.customToolsForProject` applies. Tool changes " +
          "apply on the NEXT session created — live sessions keep " +
          "the tool set they booted with.",
        tags: ["config"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["builtin", "mcp"],
            properties: {
              builtin: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "description", "enabled"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    enabled: { type: "boolean" },
                  },
                },
              },
              mcp: {
                type: "array",
                items: {
                  type: "object",
                  required: ["server", "scope", "enabled", "state", "tools"],
                  properties: {
                    server: { type: "string" },
                    scope: { type: "string", enum: ["global", "project"] },
                    projectId: { type: "string" },
                    enabled: { type: "boolean" },
                    state: { type: "string" },
                    lastError: { type: "string" },
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["name", "shortName", "description", "enabled"],
                        properties: {
                          name: { type: "string" },
                          shortName: { type: "string" },
                          description: { type: "string" },
                          enabled: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const overrides = await readToolOverrides();
        const builtinDisabled = new Set(overrides.builtin);
        const mcpDisabled = new Set(overrides.mcp);

        // Project-scope MCP servers are loaded lazily; trigger a load
        // before reading status so a fresh-after-restart UI fetch
        // doesn't show an empty MCP list for a previously-configured
        // project. Best-effort — load failures shouldn't 500 the
        // whole tool listing.
        if (typeof req.query.projectId === "string" && req.query.projectId.length > 0) {
          const project = await getProject(req.query.projectId);
          if (project !== undefined) {
            await mcpEnsureProjectLoaded(project.id, project.path).catch(() => undefined);
          }
        }

        const mcpServers = mcpGetStatus(
          typeof req.query.projectId === "string" ? { projectId: req.query.projectId } : undefined,
        );

        return {
          builtin: BUILTIN_TOOL_NAMES.map((name) => ({
            name,
            description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? "",
            enabled: !builtinDisabled.has(name),
          })),
          mcp: mcpServers.map((s) => {
            const out: {
              server: string;
              scope: "global" | "project";
              projectId?: string;
              enabled: boolean;
              state: string;
              lastError?: string;
              tools: { name: string; shortName: string; description: string; enabled: boolean }[];
            } = {
              server: s.name,
              scope: s.scope,
              enabled: s.enabled,
              state: s.state,
              tools: s.tools.map((t) => ({
                name: t.name,
                shortName: t.shortName,
                description: t.description,
                enabled: !mcpDisabled.has(t.name),
              })),
            };
            if (s.projectId !== undefined) out.projectId = s.projectId;
            if (s.lastError !== undefined) out.lastError = s.lastError;
            return out;
          }),
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { family: ToolFamily; name: string };
    Body: { enabled: boolean };
  }>(
    "/config/tools/:family/:name/enabled",
    {
      schema: {
        description:
          "Toggle a single tool by family + name. Family is `builtin` " +
          "(short bare name like `bash`) or `mcp` (bridged name like " +
          "`<server>__<tool>` — same name pi sees on the wire). " +
          "Allow-by-default — `enabled: false` adds the name to the " +
          "disabled set; `enabled: true` removes it (returning to the " +
          "implicit-enabled default). Idempotent. Applies on the NEXT " +
          "session created; live sessions are unaffected.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["family", "name"],
          properties: {
            family: { type: "string", enum: ["builtin", "mcp"] },
            name: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
        response: {
          200: {
            type: "object",
            required: ["family", "name", "enabled"],
            properties: {
              family: { type: "string" },
              name: { type: "string" },
              enabled: { type: "boolean" },
            },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await setToolEnabled(req.params.family, req.params.name, req.body.enabled);
        return {
          family: req.params.family,
          name: req.params.name,
          enabled: req.body.enabled,
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );
};

/**
 * One-line user-facing description per built-in tool. Kept here
 * (not in pi's SDK metadata) because we want operator-friendly
 * copy that explains the tool's PURPOSE for an audit-style view,
 * not the LLM-facing prompt snippet the SDK ships. Update if pi
 * adds new builtins to `ToolName`.
 */
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents from the project tree.",
  bash: "Run shell commands in the project directory.",
  edit: "Apply a search/replace edit to a file (produces a unified diff).",
  write: "Create or overwrite a file with new content.",
  grep: "Search file contents with a regex (ripgrep-backed).",
  find: "Find files by path glob.",
  ls: "List directory entries.",
};
