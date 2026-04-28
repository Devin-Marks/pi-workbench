import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { getModel } from "@mariozechner/pi-ai";
import { forkSession, getSession, SessionNotFoundError } from "../session-registry.js";

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "session_not_found" });
}

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
  },
} as const;

export const controlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; mode?: "steer" | "followUp" };
  }>(
    "/sessions/:id/steer",
    {
      schema: {
        description:
          "Queue a message to be delivered while the agent is streaming. " +
          '`mode: "steer"` (default) interrupts the current turn after its ' +
          'tool calls finish; `mode: "followUp"` waits for the agent to ' +
          "go fully idle.",
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
          404: { type: "object", properties: { error: { type: "string" } } },
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
          "idle. Idempotent on already-idle sessions.",
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
          "registers it as a fresh live session in the same project.",
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
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const forked = await forkSession(req.params.id, req.body.entryId);
        return reply.code(201).send({
          sessionId: forked.sessionId,
          projectId: forked.projectId,
          workspacePath: forked.workspacePath,
          createdAt: forked.createdAt.toISOString(),
          lastActivityAt: forked.lastActivityAt.toISOString(),
          isLive: true,
        });
      } catch (err) {
        if (err instanceof SessionNotFoundError) return notFound(reply);
        if (err instanceof Error && err.message === "fork_failed") {
          return reply.code(400).send({ error: "fork_failed" });
        }
        throw err;
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
          "`cancelled` to detect user-driven aborts.",
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
          404: { type: "object", properties: { error: { type: "string" } } },
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
      const result = await live.session.navigateTree(req.body.entryId, opts);
      const out: Record<string, unknown> = { cancelled: result.cancelled };
      if (result.aborted !== undefined) out.aborted = result.aborted;
      if (result.editorText !== undefined) out.editorText = result.editorText;
      return out;
    },
  );

  fastify.post<{ Params: { id: string }; Body: { customInstructions?: string } }>(
    "/sessions/:id/compact",
    {
      schema: {
        description:
          "Manually compact the session context. Aborts any in-flight " +
          "agent operation first. Returns the compaction summary metadata.",
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
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const result = await live.session.compact(req.body.customInstructions);
      return result as unknown as Record<string, unknown>;
    },
  );

  fastify.post<{ Params: { id: string }; Body: { provider: string; modelId: string } }>(
    "/sessions/:id/model",
    {
      schema: {
        description:
          "Set the active model for the session. Body: `{ provider, modelId }`. " +
          "Returns 400 if the provider/model isn't registered or no auth is " +
          "configured for it.",
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
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      let model;
      try {
        // getModel's TypeScript signature narrows to KnownProvider/KnownModel
        // unions, but at the HTTP boundary we accept any string; the function
        // throws on unknowns which we catch immediately. Runtime behavior is
        // the contract here, not the static union.
        const dyn = getModel as unknown as (provider: string, modelId: string) => unknown;
        model = dyn(req.body.provider, req.body.modelId);
      } catch {
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
