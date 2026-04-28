import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config, authEnabled } from "./config.js";
import { extractBearer, verifyApiKey, verifyToken } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";

const PUBLIC_PATHS = new Set<string>([
  "/api/v1/health",
  "/api/v1/auth/login",
  "/api/v1/auth/status",
]);

export async function buildServer() {
  const fastify = Fastify({
    logger: { level: config.logLevel },
    disableRequestLogging: config.isTest,
    trustProxy: config.trustProxy,
  });

  await fastify.register(cors, {
    // Default to `true` (reflect request origin) so the same-origin browser
    // workflow described in the dev plan works without extra config.
    // `false` (the previous default) blocks all CORS preflights, including
    // the dev proxy. Pin to a specific origin via CORS_ORIGIN in production.
    origin: config.corsOrigin ?? true,
    credentials: false,
  });

  // Rate limiting is per-route only — no global cap by design (see dev plan
  // Phase 2 § Rate limiter scope). The login route applies its own limit via
  // route-level `config.rateLimit`. Registering the plugin here makes that
  // route-level config available; defaults are intentionally minimal and not
  // applied to anything because `global: false`.
  await fastify.register(rateLimit, { global: false });

  await fastify.register(swagger, {
    openapi: {
      info: { title: "pi-workbench API", version: "1.0.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/api/docs",
    uiConfig: { docExpansion: "list" },
  });

  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/v1/")) return;
    const path = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;
    if (!authEnabled()) return;

    const presented = extractBearer(req.headers.authorization);
    if (presented === undefined) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }
    if (verifyToken(presented) !== undefined || verifyApiKey(presented)) return;
    reply.code(401).send({ error: "invalid_token" });
  });

  await fastify.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(projectRoutes);
    },
    { prefix: "/api/v1" },
  );

  return fastify;
}

async function start(): Promise<void> {
  const fastify = await buildServer();
  try {
    await fastify.listen({ port: config.port, host: config.host });
    fastify.log.info(`pi-workbench server listening on :${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  void start();
}
