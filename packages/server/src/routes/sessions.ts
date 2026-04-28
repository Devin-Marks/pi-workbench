import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { getProject } from "../project-manager.js";
import {
  createSession,
  disposeSession,
  findSessionLocation,
  getSession,
  listSessionsForProject,
  resumeSessionById,
  SessionNotFoundError,
  type UnifiedSession,
} from "../session-registry.js";

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

const liveSummarySchema = {
  type: "object",
  required: ["sessionId", "projectId", "workspacePath", "createdAt", "lastActivityAt", "isLive"],
  properties: {
    sessionId: { type: "string" },
    projectId: { type: "string" },
    workspacePath: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    lastActivityAt: { type: "string", format: "date-time" },
    isLive: { type: "boolean" },
    name: { type: "string" },
    messageCount: { type: "integer", minimum: 0 },
    isStreaming: { type: "boolean" },
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
          404: { type: "object", properties: { error: { type: "string" } } },
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
      // No projectId — merge across all known projects. Importing here to
      // avoid a project-manager dep at the top of the closure.
      const { readProjects } = await import("../project-manager.js");
      const projects = await readProjects();
      const all: UnifiedSession[] = [];
      for (const p of projects) {
        const list = await listSessionsForProject(p.id, p.path);
        all.push(...list);
      }
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
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.body.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const live = await createSession(project.id, project.path);
      return reply.code(201).send({
        sessionId: live.sessionId,
        projectId: live.projectId,
        workspacePath: live.workspacePath,
        createdAt: live.createdAt.toISOString(),
        lastActivityAt: live.lastActivityAt.toISOString(),
        isLive: true,
        messageCount: live.session.messages.length,
        isStreaming: live.session.isStreaming,
      });
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
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live !== undefined) {
        return {
          sessionId: live.sessionId,
          projectId: live.projectId,
          workspacePath: live.workspacePath,
          createdAt: live.createdAt.toISOString(),
          lastActivityAt: live.lastActivityAt.toISOString(),
          isLive: true,
          name: live.session.sessionName,
          messageCount: live.session.messages.length,
          isStreaming: live.session.isStreaming,
        };
      }
      const loc = await findSessionLocation(req.params.id);
      if (loc === undefined) return notFound(reply);
      // On-disk only — pull metadata via the unified merge for this project.
      const list = await listSessionsForProject(loc.projectId, loc.workspacePath);
      const match = list.find((s) => s.sessionId === req.params.id);
      if (match === undefined) return notFound(reply);
      const out: Record<string, unknown> = {
        sessionId: match.sessionId,
        projectId: match.projectId,
        workspacePath: match.workspacePath,
        createdAt: match.createdAt.toISOString(),
        lastActivityAt: match.lastActivityAt.toISOString(),
        isLive: false,
        messageCount: match.messageCount,
        isStreaming: false,
      };
      if (match.name !== undefined) out.name = match.name;
      return out;
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    {
      schema: {
        description:
          "Dispose the in-memory live session. The on-disk JSONL is " +
          "preserved; the session can be resumed later. 404 if it was " +
          "never live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const ok = disposeSession(req.params.id);
      if (!ok) return notFound(reply);
      return reply.code(204).send();
    },
  );

  // Helper export for tests — not a route. We don't ship this as a function;
  // the resumeSessionById helper lives in session-registry. Re-export here
  // would be confusing.
  void resumeSessionById;
  void SessionNotFoundError;
};
