import type { FastifyPluginAsync } from "fastify";
import { resumeSessionById, SessionNotFoundError } from "../session-registry.js";
import { createSSEClient } from "../sse-bridge.js";

/**
 * SSE stream for a session. If the session is in the live registry, attach
 * directly; otherwise auto-resume from disk via resumeSessionById (which
 * walks projects to find the .jsonl and rehydrates an AgentSession). 404
 * only when no project on disk owns the id.
 */
export const streamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/stream",
    {
      schema: {
        description:
          "Open an SSE stream for a session. Sends a `snapshot` event on " +
          "connect, then forwards filtered AgentSessionEvents until the " +
          "client disconnects. Auto-resumes the session from disk if it's " +
          "not already live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        // SSE responses don't fit Fastify's response-schema model — see the
        // Phase-5 review notes in REVIEW_FIXES.md. Only the 404 shape is
        // declared; the catalog of SSE event types lives in
        // docs/sse-events.md (Phase 17).
        response: {
          404: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      let live;
      try {
        live = await resumeSessionById(req.params.id);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: "session_not_found" });
        }
        throw err;
      }
      createSSEClient(reply, live);
      return reply;
    },
  );
};
