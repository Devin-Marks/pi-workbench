import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";
import { createSSEClient } from "../sse-bridge.js";

/**
 * Phase 5 minimal stream route. Phase 6 expands the surface (resume from
 * disk, auto-create, project lookup); for now this only attaches to a
 * session that's already live in the registry, returning 404 otherwise.
 */
export const streamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/stream",
    {
      schema: {
        description:
          "Open a Server-Sent Events stream for a live session. Sends a " +
          "`snapshot` event on connect to hydrate state, then forwards " +
          "filtered AgentSessionEvents until the client disconnects. " +
          "The session must already be in the in-memory registry; " +
          "auto-resume from disk lands in Phase 6.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        // SSE responses cannot be JSON-schema-described meaningfully —
        // they're a stream of `data: <json>\n\n` frames over text/event-stream,
        // not a single typed body. The route hijacks the reply, so Fastify's
        // serializer never runs against any 200 schema. We omit the 200
        // response from the schema entirely (Fastify's
        // FST_ERR_SCH_CONTENT_MISSING_SCHEMA forbids an empty `content` block,
        // and `type: string` would lie about the shape). The event catalogue
        // lives in docs/sse-events.md (Phase 17).
        response: {
          404: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      createSSEClient(reply, live);
      // hijack() means we own the reply; returning anything would error.
      // The connection stays open until the client disconnects.
      return reply;
    },
  );
};
