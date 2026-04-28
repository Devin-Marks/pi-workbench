import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config, authEnabled } from "./config.js";
import { extractBearer, verifyApiKey, verifyToken } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { streamRoutes } from "./routes/stream.js";
import { disposeAllSessions } from "./session-registry.js";

/**
 * Per-route auth metadata. Routes that should skip the auth preHandler set
 * `config.public: true` via Fastify route config. The preHandler reads the
 * matched route's config rather than maintaining a hard-coded path Set,
 * which scales as the API grows (closes the Phase 6 deferred item).
 */
declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
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

  // Rate limiting is per-route only — no global cap by design. The login
  // route applies its own limit via route-level `config.rateLimit`.
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

  /**
   * Auth gate. Applies to:
   *   - All `/api/v1/*` routes that are NOT marked `config.public: true`
   *     (those are health, auth/login, auth/status — see route definitions).
   *   - `/api/docs*` — the OpenAPI UI and JSON spec leak the route catalogue,
   *     so they are gated when auth is enabled. (Closes the Phase-8 deferred
   *     item.) When auth is disabled (UI_PASSWORD and API_KEY both unset),
   *     /api/docs is open — useful for local dev.
   *
   * Token check: accepts a valid JWT or a constant-time-matched API key.
   */
  fastify.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    const path = url.split("?")[0] ?? url;

    // /api/docs* gating — these are not Fastify-defined routes (they're
    // injected by @fastify/swagger-ui) so we can't rely on route config.
    const isDocs = path === "/api/docs" || path.startsWith("/api/docs/");
    if (isDocs) {
      if (!authEnabled()) return;
      const presented = extractBearer(req.headers.authorization);
      if (
        presented === undefined ||
        (verifyToken(presented) === undefined && !verifyApiKey(presented))
      ) {
        reply.code(401).send({ error: "auth_required" });
        return;
      }
      return;
    }

    if (!path.startsWith("/api/v1/")) return;

    // Route-level public marker — set on health and auth routes via
    // schema/config (see those route files).
    const routeConfig = req.routeOptions?.config;
    if (routeConfig?.public === true) return;
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
      await api.register(streamRoutes);
    },
    { prefix: "/api/v1" },
  );

  // Clean teardown on fastify.close() (called by both graceful shutdown and
  // tests via `await fastify.close()`). Disposes every live session, which
  // will also become load-bearing in Phase 5 to flush SSE clients.
  fastify.addHook("onClose", async () => {
    disposeAllSessions();
  });

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

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void start();
}
