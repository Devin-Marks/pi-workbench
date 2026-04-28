import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";
import { errorSchema } from "./_schemas.js";

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
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // Pre-flight: check model + auth BEFORE fire-and-forget. The SDK's
      // session.prompt() rejects async on these conditions which the route's
      // 202-fire-and-forget contract can't surface to the client — the user
      // would see a silent no-op. Cheap to validate here so we can return a
      // typed 400 the UI renders inline.
      const model = live.session.model;
      if (model === undefined) {
        return reply.code(400).send({ error: "no_model_configured" });
      }
      if (!live.session.modelRegistry.hasConfiguredAuth(model)) {
        return reply.code(400).send({
          error: "no_api_key",
          message: `No API key configured for provider "${model.provider}". Add one via PUT /api/v1/config/auth/${model.provider}.`,
        });
      }

      const opts: Parameters<typeof live.session.prompt>[1] = {};
      if (req.body.streamingBehavior !== undefined) {
        opts.streamingBehavior = req.body.streamingBehavior;
      }
      // Fire-and-forget. Pre-flight already covered the common synchronous
      // failure modes; remaining rejections are LLM/network errors that
      // surface to the client as agent_end with errorMessage over SSE.
      try {
        live.session.prompt(req.body.text, opts).catch((err: unknown) => {
          fastify.log.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id },
            "session.prompt rejected",
          );
        });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id },
          "session.prompt threw synchronously",
        );
      }
      return reply.code(202).send({ accepted: true });
    },
  );
};
