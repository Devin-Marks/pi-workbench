import type { FastifyPluginAsync } from "fastify";
import { sessionCount } from "../session-registry.js";
import { ptyCount } from "../pty-manager.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    {
      config: { public: true },
      schema: {
        description: "Health check — no auth required.",
        tags: ["health"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["status", "activeSessions", "activePtys"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              activeSessions: { type: "integer", minimum: 0 },
              activePtys: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok" as const,
      activeSessions: sessionCount(),
      activePtys: ptyCount(),
    }),
  );
};
