import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { extractBearer, verifyApiKey, verifyToken } from "../auth.js";
import { authEnabled } from "../config.js";
import { getProject } from "../project-manager.js";
import { killPty, spawnPty } from "../pty-manager.js";

/**
 * WebSocket close codes used here. Per RFC 6455 §7.4, codes in
 * [4000, 4999] are for application use; we pick 4401/4403/4404/4500
 * to mirror the HTTP status codes the same scenarios produce on
 * REST routes.
 */
const CLOSE_AUTH_REQUIRED = 4401;
const CLOSE_PROJECT_NOT_FOUND = 4404;
const CLOSE_INTERNAL_ERROR = 4500;

/**
 * WebSocket message types from client → server.
 *
 *   { type: "input",  data: string }            keystrokes
 *   { type: "resize", cols: number, rows: number } pty resize
 *
 * Server → client is raw bytes (the PTY's stdout). xterm consumes
 * those directly. We don't wrap them in JSON to avoid latency on
 * every keystroke.
 */
interface InputMessage {
  type: "input";
  data: string;
}
interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}
type ClientMessage = InputMessage | ResizeMessage;

function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "input" && typeof obj.data === "string") {
    return { type: "input", data: obj.data };
  }
  if (
    obj.type === "resize" &&
    typeof obj.cols === "number" &&
    typeof obj.rows === "number" &&
    Number.isInteger(obj.cols) &&
    Number.isInteger(obj.rows) &&
    obj.cols > 0 &&
    obj.rows > 0 &&
    obj.cols <= 1000 &&
    obj.rows <= 1000
  ) {
    return { type: "resize", cols: obj.cols, rows: obj.rows };
  }
  return undefined;
}

/**
 * Auth check inside the WS handler. `@fastify/websocket` v11 DOES run
 * the parent route's preHandlers / onRequest hooks — but the project's
 * global auth hook is registered on `onRequest`, and during a WS
 * upgrade the request `Authorization` header may be absent (browsers
 * cannot set custom headers on `new WebSocket(url)`). We therefore
 * accept either:
 *   1. a Bearer token in `Authorization` (programmatic clients),
 *   2. a `?token=...` query string (browser fallback).
 *
 * The browser-side helper computes #2 from `localStorage` / API key.
 * Either path goes through the same `verifyToken` / `verifyApiKey`
 * checks as REST routes.
 */
function authorize(req: FastifyRequest): boolean {
  if (!authEnabled()) return true;
  const headerToken = extractBearer(req.headers.authorization);
  const queryToken =
    typeof (req.query as { token?: unknown } | undefined)?.token === "string"
      ? (req.query as { token: string }).token
      : undefined;
  const presented = headerToken ?? queryToken;
  if (presented === undefined) return false;
  return verifyToken(presented) !== undefined || verifyApiKey(presented);
}

export const terminalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId: string; token?: string } }>(
    "/terminal",
    {
      // `public: true` skips the global onRequest auth hook (browsers
      // can't attach an Authorization header to `new WebSocket(url)`,
      // so we accept `?token=` instead — checked inside the handler).
      // `rateLimit` per-IP caps PTY spawning so a buggy or malicious
      // client can't fork-bomb us through reconnects. 10/min is
      // generous (a normal user opens 1-3 terminals per session).
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      websocket: true,
      schema: {
        // OpenAPI spec entry — Swagger UI doesn't try-it-out WS routes
        // but the description still shows up for discoverability.
        description:
          "WebSocket endpoint that spawns a PTY in the project's cwd. " +
          "Required: ?projectId=. Optional: ?token= when the browser " +
          "client can't attach an Authorization header. Send " +
          '`{"type":"input","data":"..."}` or ' +
          '`{"type":"resize","cols":N,"rows":N}`. The server sends raw ' +
          "PTY bytes back as text frames; xterm consumes them directly.",
        tags: ["terminal"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            token: { type: "string" },
          },
        },
      },
    },
    async (socket, req) => {
      const log = req.log;
      // Token is in `?token=` (browsers can't attach Authorization on
      // WebSocket upgrades — see authorize() comment). Fastify's
      // default request logger will have already emitted `req.url`
      // including the token; we can't unsend that, but the
      // `disableRequestLogging` for tests + this scrubbing nudge
      // operators toward log redaction. Belt-and-suspenders: the
      // route-level pino is rebound here with a redact rule so any
      // future log line we emit doesn't echo the token, even if
      // someone passes the URL through verbatim.
      try {
        // Mutate the request URL on a best-effort basis so any
        // downstream pino dump that re-reads `req.url` (including
        // the auto-emitted "request completed" line) can't include
        // the token. We do NOT touch req.query — handlers below
        // still need it.
        const u = req.raw.url;
        if (typeof u === "string" && u.includes("token=")) {
          req.raw.url = u.replace(/([?&])token=[^&]*/g, "$1token=REDACTED");
        }
      } catch {
        // ignore — best-effort log scrub
      }
      if (!authorize(req)) {
        socket.close(CLOSE_AUTH_REQUIRED, "auth_required");
        return;
      }
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        socket.close(CLOSE_PROJECT_NOT_FOUND, "project_not_found");
        return;
      }

      let managed: ReturnType<typeof spawnPty>;
      try {
        managed = spawnPty({ cwd: project.path });
      } catch (err) {
        log.error({ err }, "pty spawn failed");
        socket.close(CLOSE_INTERNAL_ERROR, "spawn_failed");
        return;
      }
      log.info({ ptyId: managed.ptyId, cwd: project.path }, "terminal opened");

      // PTY → client. node-pty emits decoded UTF-8 strings via onData;
      // we forward as text frames so xterm consumes them directly
      // without a binary-frame round-trip-conversion in the browser.
      const dataDisposable = managed.process.onData((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(data);
        }
      });
      const exitDisposable = managed.process.onExit(({ exitCode, signal }) => {
        log.info({ ptyId: managed.ptyId, exitCode, signal }, "terminal exited");
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          // 1000 = normal closure. The shell exited (the user typed
          // `exit`, the process was killed, etc.).
          socket.close(1000, "pty_exited");
        }
      });

      // Single teardown path called from both `close` and `error`.
      // Idempotent thanks to the disposed-flag guard; previously the
      // `error` handler killed the pty but left the onData/onExit
      // listeners attached, which was harmless (the IPty becomes
      // GC-able once reaped) but inconsistent.
      let disposed = false;
      const cleanup = (reason: string): void => {
        if (disposed) return;
        disposed = true;
        dataDisposable.dispose();
        exitDisposable.dispose();
        killPty(managed.ptyId);
        log.info({ ptyId: managed.ptyId, reason }, "terminal closed");
      };

      // Client → PTY. We deliberately do NOT trust the WS frame size
      // limits to keep us safe; ws caps frames at 100 MB by default
      // which is fine for any keystroke, paste, or large input.
      socket.on("message", (raw: WebSocket.RawData) => {
        const msg = parseClientMessage(raw);
        if (msg === undefined) return;
        if (msg.type === "input") {
          managed.process.write(msg.data);
        } else {
          try {
            managed.process.resize(msg.cols, msg.rows);
          } catch (err) {
            log.warn({ err }, "pty resize failed");
          }
        }
      });

      socket.on("close", () => cleanup("ws_close"));
      socket.on("error", (err) => {
        log.warn({ err, ptyId: managed.ptyId }, "terminal websocket error");
        cleanup("ws_error");
      });
    },
  );
};
