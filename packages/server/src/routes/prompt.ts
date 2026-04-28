import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";

/**
 * Prompt route. Per CLAUDE.md "Pi SDK Key Facts": session.prompt() is async
 * but only resolves after the entire agent run finishes (including retries
 * and compaction). Routes MUST NOT await it — call without await and return
 * 202 immediately. Output streams over SSE.
 *
 * Multipart attachments arrive in Phase 14; this is text-only for now.
 */
export const promptRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; streamingBehavior?: "steer" | "followUp" };
  }>(
    "/sessions/:id/prompt",
    {
      schema: {
        description:
          "Send a prompt to the session. Returns 202 immediately; the agent " +
          "response streams over GET /sessions/:id/stream. Required body: " +
          "{ text }. During streaming, set streamingBehavior to 'steer' or " +
          "'followUp' to control queue semantics.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted"],
            properties: { accepted: { type: "boolean", const: true } },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const opts: Parameters<typeof live.session.prompt>[1] = {};
      if (req.body.streamingBehavior !== undefined) {
        opts.streamingBehavior = req.body.streamingBehavior;
      }
      // Fire-and-forget. session.prompt() validation throws are async (the
      // method is async); attach .catch so an unhandled rejection doesn't
      // crash the process — the error also surfaces over SSE as agent_end
      // with errorMessage, which is what the client should react to.
      live.session.prompt(req.body.text, opts).catch((err: unknown) => {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id },
          "session.prompt rejected",
        );
      });
      return reply.code(202).send({ accepted: true });
    },
  );
};
