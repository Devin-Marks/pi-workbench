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

const WORKSPACE_PATH = resolve(readEnv("WORKSPACE_PATH") ?? "/workspace");
// Default to the current user's home so local dev on macOS/Linux just works.
// In the documented Docker setup this still resolves to `/root/.pi/agent`
// (root's homedir IS `/root` inside the container), so the production target
// is unchanged. Override explicitly via PI_CONFIG_DIR if needed.
const PI_CONFIG_DIR = resolve(readEnv("PI_CONFIG_DIR") ?? join(homedir(), ".pi", "agent"));
const SESSION_DIR = resolve(readEnv("SESSION_DIR") ?? `${WORKSPACE_PATH}/.pi/sessions`);
/**
 * Workbench-owned data dir. Holds `projects.json` (the project registry
 * pi-workbench layers on top of pi) and any other state that's ours, not
 * pi's. Kept separate from `PI_CONFIG_DIR` on purpose: the pi config dir
 * is the SDK's territory (auth.json, models.json, settings.json), and
 * dropping our `projects.json` into it would couple our state to pi's
 * directory layout. Default `~/.pi-workbench`; override with
 * `WORKBENCH_DATA_DIR`.
 */
const WORKBENCH_DATA_DIR = resolve(
  readEnv("WORKBENCH_DATA_DIR") ?? join(homedir(), ".pi-workbench"),
);

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
const JWT_SECRET = readEnv("JWT_SECRET");
const API_KEY = readEnv("API_KEY");
const CORS_ORIGIN = readEnv("CORS_ORIGIN");

if (UI_PASSWORD !== undefined && JWT_SECRET === undefined) {
  throw new Error(
    "config: UI_PASSWORD is set but JWT_SECRET is not. " +
      "Generate one with `openssl rand -hex 32` and set JWT_SECRET.",
  );
}

export const config = Object.freeze({
  port: readInt("PORT", 3000),
  host: readEnv("HOST") ?? "0.0.0.0",
  logLevel: readEnv("LOG_LEVEL") ?? "info",
  isTest: (readEnv("NODE_ENV") ?? "") === "test",
  trustProxy: readBool("TRUST_PROXY", false),
  workspacePath: WORKSPACE_PATH,
  piConfigDir: PI_CONFIG_DIR,
  workbenchDataDir: WORKBENCH_DATA_DIR,
  sessionDir: SESSION_DIR,
  clientDistPath: CLIENT_DIST_PATH,
  serveClient: readBool("SERVE_CLIENT", true),
  auth: Object.freeze({
    uiPassword: UI_PASSWORD,
    jwtSecret: JWT_SECRET,
    apiKey: API_KEY,
    jwtExpiresInSeconds: readInt("JWT_EXPIRES_IN_SECONDS", 60 * 60 * 24 * 7),
    loginRateLimitMax: readInt("RATE_LIMIT_LOGIN_MAX", 10),
    loginRateLimitWindowMs: readInt("RATE_LIMIT_LOGIN_WINDOW_MS", 60_000),
  }),
  corsOrigin: CORS_ORIGIN,
} as const);

export function authEnabled(): boolean {
  return config.auth.uiPassword !== undefined || config.auth.apiKey !== undefined;
}
