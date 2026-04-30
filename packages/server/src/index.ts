import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { config, authEnabled } from "./config.js";
import { extractBearer, verifyApiKey, verifyToken } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/sessions.js";
import { streamRoutes } from "./routes/stream.js";
import { promptRoutes } from "./routes/prompt.js";
import { controlRoutes } from "./routes/control.js";
import { configRoutes } from "./routes/config.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { terminalRoutes } from "./routes/terminal.js";
import { disposeAllSessions } from "./session-registry.js";
import { disposeAllPtys } from "./pty-manager.js";

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
    logger: {
      level: config.logLevel,
      // Scrub the `?token=...` query param from logged URLs. Browsers can't
      // attach Authorization headers to a WebSocket upgrade, so the terminal
      // route ferries its short-TTL JWT in the query string. Without this
      // serializer Fastify's default "incoming request" line logs the URL
      // verbatim, which puts the token into stdout / journald / log shippers.
      serializers: {
        req(req: FastifyRequest) {
          const url = req.url ?? "";
          const safeUrl = url.includes("token=")
            ? url.replace(/([?&])token=[^&]*/g, "$1token=REDACTED")
            : url;
          return {
            method: req.method,
            url: safeUrl,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
      // Belt-and-suspenders redaction of secret-shaped log fields. Pino's
      // redact runs across every log line (not just the `req` serializer),
      // so an operator-supplied API key in a request body — or a JWT in
      // an Authorization header that bypasses the serializer — never lands
      // in stdout / journald / log shippers in cleartext.
      //
      // Wildcard syntax (`body.providers["*"].apiKey`) follows pino's
      // documented JSONPath-lite — only key segments separated by `.` and
      // `[*]` patterns work; deeper nesting needs explicit paths.
      redact: {
        paths: [
          "headers.authorization",
          "req.headers.authorization",
          "body.password",
          "body.apiKey",
          'body.providers["*"].apiKey',
          'body.providers["*"].apiKeyCommand',
        ],
        censor: "[REDACTED]",
        remove: false,
      },
    },
    disableRequestLogging: config.isTest,
    trustProxy: config.trustProxy,
    // Phase 14 attachment uploads can be up to 8 × 10 MB = 80 MB per
    // request before the per-file `fileSize` cap fires per-part. Lift
    // Fastify's default 1 MB bodyLimit so the request reaches the
    // multipart parser, which then enforces the per-file limit and
    // marks oversize files via `file.truncated`. Pad with a little
    // headroom for boundary + field overhead.
    //
    // Memory worst case: a single request hits ~80 MB of file bytes
    // PLUS ~107 MB of base64-expanded image strings held in memory
    // before they pass to the SDK — call it ~190 MB resident. Single-
    // tenant assumption keeps this acceptable; do NOT raise the
    // bodyLimit further without revisiting `parseMultipart` to stream
    // attachments to disk instead of buffering.
    bodyLimit: 100 * 1024 * 1024,
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

  // Security headers — set on every response, both API and static.
  // Done as an onSend hook rather than via @fastify/helmet to avoid the
  // extra dep; the set we need is small and stable.
  //
  // CSP rationale (see also packages/client/index.html):
  //   - script-src 'self' — Vite's bundle. No inline-script is rendered.
  //   - style-src 'self' 'unsafe-inline' — required for Tailwind v4's
  //     inline @style emission and the CodeMirror inline cursor styles.
  //   - img-src 'self' data: blob: — chat attachments + diff inline icons.
  //   - connect-src 'self' ws: wss: — WebSocket terminal. ws/wss broad
  //     (rather than self) because operators behind a TLS-terminating
  //     proxy may speak wss while the browser sees the proxy's host.
  //   - worker-src 'self' blob: — Vite PWA service worker.
  //   - object-src 'none', base-uri 'self', frame-ancestors 'none' —
  //     defense in depth against legacy / clickjacking surfaces.
  fastify.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    // HSTS is harmless on plain HTTP (browsers ignore it without TLS),
    // useful behind a TLS proxy. 180 days is a balance: long enough to
    // matter, short enough that an operator can recover from accidentally
    // setting up HTTPS wrong.
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  // WebSocket support for the integrated terminal (Phase 11). Must be
  // registered before any route uses `{ websocket: true }`. Inherits
  // the same listening server as Fastify; no extra port needed.
  await fastify.register(websocket);

  // Multipart support for the prompt route's attachment handling
  // (Phase 14). Per-file cap is enforced via `limits.fileSize`; routes
  // that don't expect attachments will reject multipart with a typed
  // 415 from Fastify's content-type matching, so this register is
  // safe to apply globally.
  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB / file (matches dev plan)
      // Tightened from 8 → 6 after security review: the prompt route
      // accepts at most 4 images + 4 text files, so 6 is the smallest
      // cap that doesn't constrain real use (one operator may hit
      // 4-images / 2-text or vice versa). Keeps multipart parsing
      // bounded as defense in depth.
      files: 6,
      fields: 8,
    },
    attachFieldsToBody: false,
    // Default `throwFileSizeLimit: true` makes the plugin throw
    // RequestFileTooLargeError → Fastify renders a generic 413 with
    // "Payload Too Large", losing our typed error code. Set false so
    // the plugin instead marks `file.truncated: true` and lets our
    // route handler decide the response shape.
    throwFileSizeLimit: false,
  });

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
    // Three layered checks:
    //   1. EXPOSE_DOCS=false → 404 unconditionally (production default).
    //   2. Auth disabled + EXPOSE_DOCS=true → open (dev default).
    //   3. Auth enabled → require a valid token even when docs are exposed.
    const isDocs = path === "/api/docs" || path.startsWith("/api/docs/");
    if (isDocs) {
      if (!config.exposeDocs) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
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
      await api.register(sessionRoutes);
      await api.register(streamRoutes);
      await api.register(promptRoutes);
      await api.register(controlRoutes);
      await api.register(configRoutes);
      await api.register(fileRoutes);
      await api.register(gitRoutes);
      await api.register(terminalRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ---- static client (production) ----
  // In Docker / `npm run build && node dist/index.js`, Fastify serves the
  // Vite build directly so the whole app runs on a single port. In dev,
  // Vite owns :5173 and proxies to us, so we skip this when the dist
  // directory doesn't exist (or `SERVE_CLIENT=false`).
  //
  // SPA fallback: any non-/api/* GET that didn't match a static asset
  // returns `index.html` so the React Router-less hash-free URLs (e.g.
  // bookmarked deep links) hydrate the SPA instead of 404ing.
  if (config.serveClient && existsSync(config.clientDistPath)) {
    // onSend hook tags the right Cache-Control by request path. Doing it
    // here (rather than @fastify/static's `setHeaders`) is reliable because
    // it runs after the static plugin sets its default `max-age=0`, so we
    // overwrite cleanly. /assets/ paths are content-addressed by Vite, so
    // they're year-long immutable; index.html (which is what / and any
    // SPA-fallback path returns) must always revalidate so a fresh deploy
    // lands on the next reload.
    fastify.addHook("onSend", async (req, reply) => {
      const path = req.url.split("?")[0] ?? req.url;
      // API responses already control their own caching headers (or
      // intentionally don't); skip the static-asset branching for them.
      if (path.startsWith("/api/")) return;
      if (path.startsWith("/assets/")) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (reply.getHeader("content-type")?.toString().startsWith("text/html") === true) {
        reply.header("Cache-Control", "no-cache");
      }
    });

    await fastify.register(fastifyStatic, {
      root: config.clientDistPath,
      index: "index.html",
    });

    fastify.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? req.url;
      // The API surface explicitly 404s — never fall through to the SPA.
      if (path.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      // SPA fallback: bare GETs without a file extension are deep links
      // (/projects/abc, /sessions/xyz). Anything with an extension that
      // got here is a missing static asset and should 404 honestly so
      // the browser surfaces it instead of silently rendering the shell.
      const lastSegment = path.split("/").pop() ?? "";
      const looksLikeAsset = lastSegment.includes(".");
      if (req.method !== "GET" || looksLikeAsset) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).type("text/html").sendFile("index.html");
    });

    fastify.log.info({ root: config.clientDistPath }, "serving client from disk");
  } else {
    fastify.log.info(
      { dist: config.clientDistPath, exists: existsSync(config.clientDistPath) },
      "client dist not served (dev mode or SERVE_CLIENT=false)",
    );
  }

  // Clean teardown on fastify.close() (called by both graceful shutdown and
  // tests via `await fastify.close()`). Disposes every live session, which
  // will also become load-bearing in Phase 5 to flush SSE clients.
  fastify.addHook("onClose", async () => {
    disposeAllSessions();
    disposeAllPtys();
  });

  return fastify;
}

async function start(): Promise<void> {
  // Ensure the workspace + workbench data dirs exist before anything
  // tries to write under them. mkdir(recursive:true) is a no-op on an
  // existing dir, so this is safe to run on every boot. We do NOT
  // create PI_CONFIG_DIR — that's the SDK's territory and the SDK
  // creates it itself on first auth/models read.
  for (const dir of [config.workspacePath, config.workbenchDataDir]) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      // EACCES on `/workspace` (the legacy default) was the most common
      // dev startup failure. Surface a clear hint instead of letting
      // Fastify start in a broken state.
      console.error(`[pi-workbench] failed to create directory ${dir}:`, (err as Error).message);
      console.error(
        `[pi-workbench] hint: set WORKSPACE_PATH/WORKBENCH_DATA_DIR to a writable location`,
      );
      process.exit(1);
    }
  }
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
