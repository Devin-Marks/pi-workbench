import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readEnv(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function readInt(key: string, fallback: number): number {
  const v = readEnv(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`config: ${key} must be a non-negative integer (got ${v})`);
  }
  return n;
}

function readBool(key: string, fallback: boolean): boolean {
  const v = readEnv(key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`config: ${key} must be a boolean-ish value (got ${v})`);
}

/**
 * Workbench-owned root. `~/.pi-workbench` is the single dotdir we own.
 * By default it holds both the project registry and the workspace where
 * user code lives:
 *
 *   ~/.pi-workbench/
 *     ├── projects.json   ← WORKBENCH_DATA_DIR by default
 *     └── workspace/      ← WORKSPACE_PATH by default
 *
 * Either path can be relocated independently via its env var (e.g. point
 * `WORKSPACE_PATH` at an existing `~/Code` dir to use code you already
 * have on disk). Docker compose sets both explicitly so the container
 * layout is unchanged.
 */
const HOME = homedir();
if (HOME === "/" || HOME === "") {
  throw new Error(
    `config: os.homedir() returned ${JSON.stringify(HOME)}. ` +
      "This usually means HOME / USERPROFILE is unset. " +
      "Set WORKSPACE_PATH, PI_CONFIG_DIR, and WORKBENCH_DATA_DIR explicitly, " +
      "or run the server with a real user account.",
  );
}
const WORKBENCH_HOME = join(HOME, ".pi-workbench");
const WORKSPACE_PATH = resolve(readEnv("WORKSPACE_PATH") ?? join(WORKBENCH_HOME, "workspace"));
// Default to the current user's home so local dev on macOS/Linux just works.
// In the documented Docker setup this still resolves to `/root/.pi/agent`
// (root's homedir IS `/root` inside the container), so the production target
// is unchanged. Override explicitly via PI_CONFIG_DIR if needed.
const PI_CONFIG_DIR = resolve(readEnv("PI_CONFIG_DIR") ?? join(HOME, ".pi", "agent"));
const SESSION_DIR = resolve(readEnv("SESSION_DIR") ?? `${WORKSPACE_PATH}/.pi/sessions`);
/**
 * Workbench-owned data dir. Holds `projects.json` (the project registry
 * pi-workbench layers on top of pi) and any other state that's ours, not
 * pi's. Defaults to `WORKBENCH_HOME` (~/.pi-workbench) so projects.json
 * sits next to the workspace folder. Kept SEPARATE from `PI_CONFIG_DIR`
 * (~/.pi/agent), which is owned by the pi SDK — auth.json, models.json,
 * settings.json. Dropping our state into the SDK's dir was the original
 * design and got refactored out.
 */
const WORKBENCH_DATA_DIR = resolve(readEnv("WORKBENCH_DATA_DIR") ?? WORKBENCH_HOME);

/**
 * Path to the built client (Vite output). In production we serve this via
 * `@fastify/static`. The default resolves relative to the compiled server
 * file (`packages/server/dist/config.js` → `../../client/dist`), which
 * works for both the local `npm run build && node dist/index.js` flow and
 * the Docker image (which mirrors the same `packages/server/dist` +
 * `packages/client/dist` layout). Override with `CLIENT_DIST_PATH` if you
 * relocate the built assets.
 */
const CLIENT_DIST_PATH = resolve(
  readEnv("CLIENT_DIST_PATH") ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist"),
);

const UI_PASSWORD = readEnv("UI_PASSWORD");
const API_KEY = readEnv("API_KEY");
const CORS_ORIGIN = readEnv("CORS_ORIGIN");

/**
 * Load a JWT signing key from `${WORKBENCH_DATA_DIR}/jwt-secret`, or
 * generate-and-persist one on first boot. Treated like an SSH host key:
 * created once, persisted to the data dir (which is the PVC / bind-mount
 * in K8s and Docker), reused across restarts so issued tokens stay
 * valid. Setting `JWT_SECRET` env explicitly skips this entirely.
 *
 * Only invoked when `UI_PASSWORD` is set — if browser auth isn't on,
 * we don't need a secret at all.
 */
function loadOrGenerateJwtSecret(dataDir: string): string {
  const path = join(dataDir, "jwt-secret");
  if (existsSync(path)) {
    const v = readFileSync(path, "utf8").trim();
    // 32 bytes = 256 bits ≈ 43 base64url chars. Anything shorter is
    // either truncated or hand-edited; regenerate rather than trust it.
    if (v.length >= 32) return v;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  console.log(
    `[config] auto-generated JWT secret persisted at ${path}. ` +
      "Delete this file to rotate (logs out all browser sessions).",
  );
  return secret;
}

const JWT_SECRET =
  readEnv("JWT_SECRET") ??
  (UI_PASSWORD !== undefined ? loadOrGenerateJwtSecret(WORKBENCH_DATA_DIR) : undefined);

export const config = Object.freeze({
  port: readInt("PORT", 3000),
  // HOST default depends on NODE_ENV. Production binds 0.0.0.0 (Docker
  // image's normal mode); dev binds 127.0.0.1 so a `npm run dev` on a
  // laptop doesn't silently expose the agent's shell + filesystem to
  // anyone on the same WiFi/VLAN. Operators who want LAN access in dev
  // can set HOST=0.0.0.0 explicitly.
  host: readEnv("HOST") ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  logLevel: readEnv("LOG_LEVEL") ?? "info",
  isTest: (readEnv("NODE_ENV") ?? "") === "test",
  trustProxy: readBool("TRUST_PROXY", false),
  workspacePath: WORKSPACE_PATH,
  piConfigDir: PI_CONFIG_DIR,
  workbenchDataDir: WORKBENCH_DATA_DIR,
  sessionDir: SESSION_DIR,
  clientDistPath: CLIENT_DIST_PATH,
  serveClient: readBool("SERVE_CLIENT", true),
  /**
   * Frontend "minimal" mode. When true, the client UI hides the
   * terminal, git pane, last-turn pane, and the providers/agent
   * settings sections, and replaces the project folder picker with
   * a name-only form that creates `<workspacePath>/<name>`. Server
   * routes are unchanged — this is purely a frontend gate exposed
   * via `GET /api/v1/ui-config`. Use case: locked-down deployments
   * where provider config is managed at the deploy level.
   */
  minimalUi: readBool("MINIMAL_UI", false),
  /**
   * Whether `/api/docs` (Swagger UI + OpenAPI JSON spec) is reachable.
   * Defaults to true so Docker / production deploys keep working without
   * extra config (the README quickstart documents `/api/docs`). When
   * auth is enabled, the existing token check still gates the docs;
   * when auth is disabled, the docs are an info-leak surface (route
   * catalogue, body schemas), so security-conscious operators in
   * unauthenticated public-internet deployments should set
   * `EXPOSE_DOCS=false` — though that combo is itself discouraged
   * (see SECURITY.md: never network-expose without auth + TLS).
   */
  exposeDocs: readBool("EXPOSE_DOCS", true),
  auth: Object.freeze({
    uiPassword: UI_PASSWORD,
    jwtSecret: JWT_SECRET,
    apiKey: API_KEY,
    jwtExpiresInSeconds: readInt("JWT_EXPIRES_IN_SECONDS", 60 * 60 * 24 * 7),
    loginRateLimitMax: readInt("RATE_LIMIT_LOGIN_MAX", 10),
    loginRateLimitWindowMs: readInt("RATE_LIMIT_LOGIN_WINDOW_MS", 60_000),
    /**
     * When true and the only credential is the env-provided UI_PASSWORD
     * (no on-disk hash yet), the login response carries
     * `mustChangePassword: true` and the issued JWT is restricted —
     * the user can only call `POST /auth/change-password` until they
     * pick a new password. After the user changes it, the new password
     * is hashed and persisted to `${WORKBENCH_DATA_DIR}/password-hash`,
     * and subsequent logins ignore the env value.
     *
     * Defaults to true so deployments that bake an initial password
     * into env (helm secret, docker-compose .env) don't accidentally
     * leave that credential as the long-lived one.
     */
    requirePasswordChange: readBool("REQUIRE_PASSWORD_CHANGE", true),
    /** Where the persisted scrypt hash lives — see auth.ts. */
    passwordHashFile: join(WORKBENCH_DATA_DIR, "password-hash"),
  }),
  /**
   * Per-route rate limits applied to the cost-heavy / disk-heavy / CPU-heavy
   * routes. Defaults are conservative — enough headroom for an interactive
   * user, low enough that a leaked-token spam loop hits the cap fast.
   * Operators with higher legitimate volume can raise via env.
   */
  rateLimits: Object.freeze({
    // /sessions/:id/{prompt,steer,compact,navigate} — per-user prompt
    // floor. 60 / minute = 1 / second sustained, far above interactive
    // typing speed; a runaway script gets capped in roughly 1 minute.
    promptMax: readInt("RATE_LIMIT_PROMPT_MAX", 60),
    promptWindowMs: readInt("RATE_LIMIT_PROMPT_WINDOW_MS", 60_000),
    // /files/upload — disk fill. 30 / minute keeps an attentive user
    // unblocked while capping a fill-the-disk loop.
    uploadMax: readInt("RATE_LIMIT_UPLOAD_MAX", 30),
    uploadWindowMs: readInt("RATE_LIMIT_UPLOAD_WINDOW_MS", 60_000),
    // /files/search — CPU. ripgrep walks the workspace; each search is
    // bounded by ripgrep but a tight loop still spins a CPU core.
    searchMax: readInt("RATE_LIMIT_SEARCH_MAX", 60),
    searchWindowMs: readInt("RATE_LIMIT_SEARCH_WINDOW_MS", 60_000),
    // /git/push — network amplification + rate-limited by the git remote.
    // Conservative — pushing 10x in a minute is almost always a mistake.
    pushMax: readInt("RATE_LIMIT_PUSH_MAX", 10),
    pushWindowMs: readInt("RATE_LIMIT_PUSH_WINDOW_MS", 60_000),
  }),
  corsOrigin: CORS_ORIGIN,
} as const);

export function authEnabled(): boolean {
  return (
    config.auth.uiPassword !== undefined ||
    config.auth.apiKey !== undefined ||
    existsSync(config.auth.passwordHashFile)
  );
}
