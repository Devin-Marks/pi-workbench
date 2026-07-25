import type { FastifyPluginAsync } from "fastify";
import { serializeSSE } from "../sse-bridge.js";
import { listRunningSessionActivity } from "../session-registry.js";
import { subscribeSessionActivity } from "../session-activity.js";

/** Lightweight global lifecycle stream used exclusively by the sidebar. */
export const sessionActivityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/session-activity/stream",
    {
      schema: {
        description: "Open a global SSE stream of sessions with an active agent turn.",
        tags: ["sessions"],
      },
    },
    async (_req, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      let unsubscribe = (): void => undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        raw.off("close", close);
        raw.off("error", close);
      };
      const send = (event: { type: string; [key: string]: unknown }): void => {
        if (closed || raw.destroyed) return;
        try {
          raw.write(serializeSSE(event));
        } catch {
          close();
        }
      };
      raw.on("close", close);
      raw.on("error", close);
      send({ type: "session_activity_snapshot", running: listRunningSessionActivity() });
      unsubscribe = subscribeSessionActivity((activity) => {
        send({ type: "session_activity_changed", ...activity });
      });
      return reply;
    },
  );
};
