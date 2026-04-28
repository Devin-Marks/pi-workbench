import { resolve } from "node:path";

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

const WORKSPACE_PATH = resolve(readEnv("WORKSPACE_PATH") ?? "/workspace");
const PI_CONFIG_DIR = resolve(readEnv("PI_CONFIG_DIR") ?? "/root/.pi/agent");
const SESSION_DIR = resolve(readEnv("SESSION_DIR") ?? `${WORKSPACE_PATH}/.pi/sessions`);

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
  workspacePath: WORKSPACE_PATH,
  piConfigDir: PI_CONFIG_DIR,
  sessionDir: SESSION_DIR,
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
