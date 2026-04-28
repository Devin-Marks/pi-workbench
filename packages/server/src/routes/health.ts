import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    {
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
      activeSessions: 0,
      activePtys: 0,
    }),
  );
};
