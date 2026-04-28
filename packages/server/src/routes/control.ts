import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { getModel } from "@mariozechner/pi-ai";
import {
  EntryNotFoundError,
  forkSession,
  getSession,
  SessionNotFoundError,
} from "../session-registry.js";
import { errorSchema, liveSummaryBody, liveSummarySchema } from "./_schemas.js";

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "session_not_found" });
}

/**
 * Map SDK throws — which are plain `Error` with English messages — to stable
 * error codes the API contract documents. The SDK has no typed error classes
 * for these cases, so message-substring matching is the best we can do; if
 * any message ever changes the route falls back to a generic 500 with no
 * SDK string in the body.
 */
function mapSdkError(reply: FastifyReply, err: unknown): FastifyReply {
  if (!(err instanceof Error)) {
    reply.log.error({ err }, "unexpected non-Error throw");
    return reply.code(500).send({ error: "internal_error" });
  }
  const m = err.message;
  if (/entry .* not found/i.test(m)) {
    return reply.code(400).send({ error: "entry_not_found" });
  }
  if (/already compacted/i.test(m)) {
    return reply.code(400).send({ error: "already_compacted" });
  }
  if (/nothing to compact/i.test(m)) {
    return reply.code(400).send({ error: "nothing_to_compact" });
  }
  if (/no model/i.test(m)) {
    return reply.code(400).send({ error: "no_model_configured" });
  }
  if (/no api key found/i.test(m)) {
    return reply.code(400).send({ error: "no_api_key" });
  }
  if (/compaction cancelled/i.test(m)) {
    // User-driven abort during compact — not an internal error. The route
    // itself returned 200/202 successfully; this catch path is for the
    // cancellation propagating up from session.compact().
    return reply.code(409).send({ error: "compaction_cancelled" });
  }
  reply.log.error({ err: m }, "unmapped SDK error");
  return reply.code(500).send({ error: "internal_error" });
}

export const controlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; mode?: "steer" | "followUp" };
  }>(
    "/sessions/:id/steer",
    {
      schema: {
        description:
          'Queue a message for an in-progress agent run. `mode: "steer"` ' +
          "(default) interrupts the current turn after its tool calls finish; " +
          '`mode: "followUp"` waits for the agent to go fully idle. The SDK ' +
          "queues regardless of streaming state — a steer/followUp on an idle " +
          "session sits on the queue and is delivered when the next prompt runs.",
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
            mode: { type: "string", enum: ["steer", "followUp"] },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted"],
            properties: { accepted: { type: "boolean", const: true } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const mode = req.body.mode ?? "steer";
      // Fire-and-forget: steer/followUp resolve when the message is delivered,
      // which can be many seconds out. The route returns immediately.
      const target =
        mode === "followUp"
          ? live.session.followUp(req.body.text)
          : live.session.steer(req.body.text);
      target.catch((err: unknown) => {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id, mode },
          "session.steer/followUp rejected",
        );
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/abort",
    {
      schema: {
        description:
          "Abort the agent's current operation and wait for it to become " +
          "idle. Idempotent on already-idle sessions (resolves immediately). " +
          "Session must be live; open the SSE stream first to auto-resume " +
          "from disk if it isn't.",
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
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      await live.session.abort();
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string }; Body: { entryId: string } }>(
    "/sessions/:id/fork",
    {
      schema: {
        description:
          "Create a new session from an entry on the current session's " +
          "tree. Writes a new .jsonl file containing the path-to-leaf and " +
          "registers it as a fresh live session in the same project. The " +
          "source session is left live and untouched.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["entryId"],
          additionalProperties: false,
          properties: { entryId: { type: "string" } },
        },
        response: {
          201: liveSummarySchema,
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const forked = await forkSession(req.params.id, req.body.entryId);
        return reply.code(201).send(
          liveSummaryBody({
            sessionId: forked.sessionId,
            projectId: forked.projectId,
            workspacePath: forked.workspacePath,
            createdAt: forked.createdAt,
            lastActivityAt: forked.lastActivityAt,
            name: forked.session.sessionName,
            messageCount: forked.session.messages.length,
            isStreaming: forked.session.isStreaming,
          }),
        );
      } catch (err) {
        if (err instanceof SessionNotFoundError) return notFound(reply);
        if (err instanceof EntryNotFoundError) {
          return reply.code(400).send({ error: "entry_not_found" });
        }
        if (err instanceof Error && err.message === "fork_failed") {
          return reply.code(400).send({ error: "fork_failed" });
        }
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: {
      entryId: string;
      summarize?: boolean;
      customInstructions?: string;
      label?: string;
    };
  }>(
    "/sessions/:id/navigate",
    {
      schema: {
        description:
          "Navigate the session leaf to a different entry on its tree. " +
          "Operates IN-PLACE on the same session file (unlike fork which " +
          "creates a new file). Returns the navigation result; check " +
          "`cancelled` to detect user-driven aborts. Returns 400 if " +
          "`entryId` doesn't exist on the session's tree.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["entryId"],
          additionalProperties: false,
          properties: {
            entryId: { type: "string" },
            summarize: { type: "boolean" },
            customInstructions: { type: "string" },
            label: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["cancelled"],
            properties: {
              cancelled: { type: "boolean" },
              aborted: { type: "boolean" },
              editorText: { type: "string" },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const opts: Parameters<typeof live.session.navigateTree>[1] = {};
      if (req.body.summarize !== undefined) opts.summarize = req.body.summarize;
      if (req.body.customInstructions !== undefined)
        opts.customInstructions = req.body.customInstructions;
      if (req.body.label !== undefined) opts.label = req.body.label;
      try {
        const result = await live.session.navigateTree(req.body.entryId, opts);
        const out: Record<string, unknown> = { cancelled: result.cancelled };
        if (result.aborted !== undefined) out.aborted = result.aborted;
        if (result.editorText !== undefined) out.editorText = result.editorText;
        return out;
      } catch (err) {
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { customInstructions?: string } }>(
    "/sessions/:id/compact",
    {
      schema: {
        description:
          "Manually compact the session context. Aborts any in-flight " +
          "agent operation first. Returns 400 with a stable error code if " +
          "the session is too small to compact, has already been compacted, " +
          "or has no model configured.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { customInstructions: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              summary: { type: "string" },
              tokensBefore: { type: "integer", minimum: 0 },
              tokensAfter: { type: "integer", minimum: 0 },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      try {
        const result = await live.session.compact(req.body.customInstructions);
        return result as unknown as Record<string, unknown>;
      } catch (err) {
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { provider: string; modelId: string } }>(
    "/sessions/:id/model",
    {
      schema: {
        description:
          "Set the active model for the session. Body: `{ provider, modelId }`. " +
          'Returns 400 with `error: "unknown_model"` if the provider/model isn\'t ' +
          'registered, or `error: "set_model_failed"` if no auth is configured.',
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["provider", "modelId"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1 },
            modelId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["provider", "modelId"],
            properties: {
              provider: { type: "string" },
              modelId: { type: "string" },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      // getModel's TypeScript signature narrows to KnownProvider/KnownModel
      // unions, but at the HTTP boundary we accept any string. The function
      // RETURNS undefined (does not throw) for unknown provider/modelId — this
      // is the contract from pi-ai/dist/models.js. Without an explicit
      // undefined check, setModel(undefined) crashes with a TypeError that
      // leaks Node-internal detail.
      const dyn = getModel as unknown as (provider: string, modelId: string) => unknown;
      const model = dyn(req.body.provider, req.body.modelId);
      if (model === undefined) {
        return reply.code(400).send({ error: "unknown_model" });
      }
      try {
        await live.session.setModel(model as Parameters<typeof live.session.setModel>[0]);
      } catch (err) {
        return reply.code(400).send({
          error: "set_model_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { provider: req.body.provider, modelId: req.body.modelId };
    },
  );
};
