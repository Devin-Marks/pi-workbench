import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { extractBearer, verifyApiKey, verifyToken } from "../auth.js";
import { authEnabled } from "../config.js";
import { getProject } from "../project-manager.js";
import { attachSink, findPtyByTabId, spawnPty } from "../pty-manager.js";

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
  // Sanity cap: a single keystroke (or paste) over 1 MB is almost
  // certainly a misuse of the channel; refuse rather than block the
  // event loop on a node-pty `write()` of a huge buffer. The server-
  // side ws frame limit is much higher (`@fastify/websocket` defaults
  // to 100 MB), so this is the meaningful guard.
  const MAX_INPUT_BYTES = 1 * 1024 * 1024;
  if (typeof raw === "string" ? raw.length > MAX_INPUT_BYTES : raw.byteLength > MAX_INPUT_BYTES) {
    return undefined;
  }
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
  fastify.get<{ Querystring: { projectId: string; tabId?: string; token?: string } }>(
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
            // Stable client tab id. When the client reconnects with
            // a previously-seen tabId (within the project) the
            // server reattaches to the existing PTY and replays the
            // rolling output buffer instead of spawning a new shell.
            tabId: { type: "string", minLength: 1, maxLength: 128 },
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

      // Reattach path: client supplied a stable `tabId` AND a PTY
      // for that tab in this project is still alive on the server
      // (i.e. previous WS dropped within IDLE_REAP_MS). Skip the
      // spawn — the PTY's rolling buffer will be replayed by
      // attachSink so xterm shows recent output, not just a fresh
      // prompt.
      const requestedTabId = req.query.tabId;
      let managed: ReturnType<typeof spawnPty> | undefined;
      let reattached = false;
      if (requestedTabId !== undefined) {
        const existing = findPtyByTabId(requestedTabId, project.id);
        if (existing !== undefined) {
          managed = existing;
          reattached = true;
        }
      }
      if (managed === undefined) {
        try {
          managed = spawnPty({
            cwd: project.path,
            tabId: requestedTabId ?? `srv-${Date.now().toString(36)}`,
            projectId: project.id,
          });
        } catch (err) {
          log.error({ err }, "pty spawn failed");
          socket.close(CLOSE_INTERNAL_ERROR, "spawn_failed");
          return;
        }
      }
      log.info(
        { ptyId: managed.ptyId, tabId: managed.tabId, cwd: project.path, reattached },
        reattached ? "terminal reattached" : "terminal opened",
      );

      // PTY → client via the manager. attachSink handles the
      // initial buffer replay (recent output before any new
      // streaming) and gives back a detach() we call on socket
      // close — that detach starts the idle reaper but does NOT
      // kill the PTY, so the next reconnect can pick it up.
      //
      // The 4th arg is the "displace previous attachment" callback:
      // if a NEW WebSocket attaches to the same PTY (same tabId from
      // a different browser window), pty-manager calls this to close
      // OUR socket cleanly so we don't end up with two browsers both
      // writing keystrokes into the same shell.
      const closeOnDisplace = (): void => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          socket.close(4409, "replaced_by_new_attach");
        }
      };
      const detach = attachSink(
        managed.ptyId,
        (chunk) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(chunk);
          }
        },
        undefined,
        closeOnDisplace,
      );
      if (detach === undefined) {
        log.error({ ptyId: managed.ptyId }, "attachSink failed; pty vanished");
        socket.close(CLOSE_INTERNAL_ERROR, "attach_failed");
        return;
      }

      // The shell really exiting (user typed `exit`, kill -9, etc.)
      // is a terminal-state event distinct from a transient WS
      // drop: there's nothing to reattach to. Close the socket so
      // the client doesn't try to reconnect to a dead PTY.
      const exitDisposable = managed.process.onExit(({ exitCode, signal }) => {
        log.info({ ptyId: managed.ptyId, exitCode, signal }, "terminal exited");
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          socket.close(1000, "pty_exited");
        }
      });

      let disposed = false;
      const cleanup = (reason: string): void => {
        if (disposed) return;
        disposed = true;
        detach();
        exitDisposable.dispose();
        // NB: no killPty here. The PTY is intentionally kept alive
        // so a page-refresh / network blip can reattach. The idle
        // reaper inside attachSink will GC it after IDLE_REAP_MS
        // if no reconnect arrives.
        log.info({ ptyId: managed.ptyId, tabId: managed.tabId, reason }, "terminal detached");
      };

      socket.on("message", (raw: WebSocket.RawData) => {
        const msg = parseClientMessage(raw);
        if (msg === undefined) return;
        // Both write() and resize() can throw synchronously if the
        // underlying PTY died (user `exit`, kill -9, idle reaper)
        // between attach and this message. Without the try/catch the
        // throw bubbles up as an unhandled-rejection-style WS error
        // with no diagnostic for the operator. Close the socket with
        // a distinct code so the client surfaces "terminal died"
        // rather than reconnecting indefinitely.
        if (msg.type === "input") {
          try {
            managed.process.write(msg.data);
          } catch (err) {
            log.warn({ err, ptyId: managed.ptyId }, "pty write failed; closing socket");
            if (socket.readyState === socket.OPEN) {
              socket.close(CLOSE_INTERNAL_ERROR, "pty_dead");
            }
          }
        } else {
          try {
            managed.process.resize(msg.cols, msg.rows);
          } catch (err) {
            log.warn({ err }, "pty resize failed");
            if (socket.readyState === socket.OPEN) {
              socket.close(CLOSE_INTERNAL_ERROR, "pty_dead");
            }
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
