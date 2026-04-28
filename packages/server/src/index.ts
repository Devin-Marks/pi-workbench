import Fastify from "fastify";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
});

fastify.get(
  "/api/v1/health",
  {
    schema: {
      description: "Health check — no auth required.",
      tags: ["health"],
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

async function start(): Promise<void> {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`pi-workbench server listening on :${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

void start();
