import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { getProject, readProjects } from "../project-manager.js";
import {
  createSession,
  disposeSession,
  findSessionLocation,
  getSession,
  listSessionsForProject,
  type UnifiedSession,
} from "../session-registry.js";
import { errorSchema, liveSummaryBody, liveSummarySchema } from "./_schemas.js";
import { buildTurnDiff } from "../turn-diff-builder.js";

const unifiedSchema = {
  type: "object",
  required: [
    "sessionId",
    "projectId",
    "isLive",
    "workspacePath",
    "lastActivityAt",
    "createdAt",
    "messageCount",
    "firstMessage",
  ],
  properties: {
    sessionId: { type: "string" },
    projectId: { type: "string" },
    isLive: { type: "boolean" },
    name: { type: "string" },
    workspacePath: { type: "string" },
    lastActivityAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    messageCount: { type: "integer", minimum: 0 },
    firstMessage: { type: "string" },
  },
} as const;

function unifiedFromUnified(u: UnifiedSession): Record<string, unknown> {
  // Fastify's response serializer drops `undefined`-valued keys, but emit a
  // stable shape: convert dates to ISO strings + only include `name` when set.
  const out: Record<string, unknown> = {
    sessionId: u.sessionId,
    projectId: u.projectId,
    isLive: u.isLive,
    workspacePath: u.workspacePath,
    lastActivityAt: u.lastActivityAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    messageCount: u.messageCount,
    firstMessage: u.firstMessage,
  };
  if (u.name !== undefined) out.name = u.name;
  return out;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "session_not_found" });
}

export const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/sessions",
    {
      schema: {
        description:
          "List sessions for a project (live and on-disk merged, deduped by " +
          "id, sorted by recency). Without `projectId`, returns sessions from " +
          "every project the workbench knows about.",
        tags: ["sessions"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["sessions"],
            properties: {
              sessions: { type: "array", items: unifiedSchema },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const projectId = req.query.projectId;
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project === undefined) {
          return reply.code(404).send({ error: "project_not_found" });
        }
        const sessions = await listSessionsForProject(projectId, project.path);
        return { sessions: sessions.map(unifiedFromUnified) };
      }
      // Cross-project: fan out in parallel — each project's listing is
      // independent disk I/O. Use Promise.allSettled so one corrupt
      // project's session dir doesn't take down the whole sidebar; the
      // failure is logged and that project's sessions are skipped.
      const projects = await readProjects();
      const settled = await Promise.all(
        projects.map(async (p) => {
          try {
            return await listSessionsForProject(p.id, p.path);
          } catch (err) {
            req.log.warn(
              { err: err instanceof Error ? err.message : String(err), projectId: p.id },
              "listSessionsForProject failed; skipping project in cross-project listing",
            );
            return [] as UnifiedSession[];
          }
        }),
      );
      const all: UnifiedSession[] = settled.flat();
      all.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      return { sessions: all.map(unifiedFromUnified) };
    },
  );

  fastify.post<{ Body: { projectId: string } }>(
    "/sessions",
    {
      schema: {
        description: "Create a new session in the given project.",
        tags: ["sessions"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: { projectId: { type: "string" } },
        },
        response: {
          201: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.body.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const live = await createSession(project.id, project.path);
      return reply.code(201).send(
        liveSummaryBody({
          sessionId: live.sessionId,
          projectId: live.projectId,
          workspacePath: live.workspacePath,
          createdAt: live.createdAt,
          lastActivityAt: live.lastActivityAt,
          name: live.session.sessionName,
          messageCount: live.session.messages.length,
          isStreaming: live.session.isStreaming,
        }),
      );
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    {
      schema: {
        description:
          "Get session metadata. Looks up live sessions first, falls back to " +
          "the on-disk index. Does not load the session into memory.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live !== undefined) {
        return liveSummaryBody({
          sessionId: live.sessionId,
          projectId: live.projectId,
          workspacePath: live.workspacePath,
          createdAt: live.createdAt,
          lastActivityAt: live.lastActivityAt,
          name: live.session.sessionName,
          messageCount: live.session.messages.length,
          isStreaming: live.session.isStreaming,
        });
      }
      const loc = await findSessionLocation(req.params.id);
      if (loc === undefined) return notFound(reply);
      // On-disk only — pull metadata via the unified merge for this project.
      const list = await listSessionsForProject(loc.projectId, loc.workspacePath);
      const match = list.find((s) => s.sessionId === req.params.id);
      if (match === undefined) return notFound(reply);
      return liveSummaryBody({
        sessionId: match.sessionId,
        projectId: match.projectId,
        workspacePath: match.workspacePath,
        createdAt: match.createdAt,
        lastActivityAt: match.lastActivityAt,
        name: match.name,
        messageCount: match.messageCount,
        isStreaming: false,
        isLive: false,
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/messages",
    {
      schema: {
        description:
          "Return the live session's full messages array — the same shape " +
          "the SSE stream sends in its `snapshot` event. Used by the chat " +
          "view to refresh after `agent_end` without reconnecting the SSE. " +
          "404 if the session isn't currently live in the registry.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["messages"],
            properties: {
              messages: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      return { messages: live.session.messages };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/turn-diff",
    {
      schema: {
        description:
          "Aggregate every write/edit tool result from the session's most " +
          "recent turn into one reviewable changeset. Returns " +
          "`{ entries: [{ file, tool, diff, additions, deletions, isPureAddition }] }`. " +
          "Prefers `git diff HEAD -- <path>` for cumulative diffs; falls back " +
          "to a pure-addition diff when the file is untracked or the project " +
          "has no `.git`. 404 if the session isn't currently live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["entries"],
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["file", "tool", "diff", "additions", "deletions", "isPureAddition"],
                  properties: {
                    file: { type: "string" },
                    tool: { type: "string", enum: ["write", "edit"] },
                    diff: { type: "string" },
                    additions: { type: "integer", minimum: 0 },
                    deletions: { type: "integer", minimum: 0 },
                    isPureAddition: { type: "boolean" },
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
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const entries = await buildTurnDiff(
        live.session,
        live.workspacePath,
        live.lastAgentStartIndex,
      );
      return { entries };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { name: string } }>(
    "/sessions/:id/name",
    {
      schema: {
        description:
          "Rename the session. Calls the SDK's `setSessionName` which appends " +
          "a `session_info` entry to the JSONL. The new name is the user-visible " +
          "title in the sidebar; the empty string clears any prior name. Session " +
          "must be live; open the SSE stream first to auto-resume from disk.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", maxLength: 200 } },
        },
        response: {
          200: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      live.session.setSessionName(req.body.name);
      return liveSummaryBody({
        sessionId: live.sessionId,
        projectId: live.projectId,
        workspacePath: live.workspacePath,
        createdAt: live.createdAt,
        lastActivityAt: live.lastActivityAt,
        name: live.session.sessionName,
        messageCount: live.session.messages.length,
        isStreaming: live.session.isStreaming,
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    {
      schema: {
        description:
          "Dispose the in-memory live session. The on-disk JSONL is " +
          "preserved; the session can be resumed later via the SSE stream " +
          "endpoint. 404 if it was never live (deleting an on-disk-only " +
          "session is not currently supported — see DEFERRED.md).",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const ok = disposeSession(req.params.id);
      if (!ok) return notFound(reply);
      return reply.code(204).send();
    },
  );
};
