import { clearStoredToken, getStoredToken } from "./auth-client";

const UNAUTHORIZED_EVENT = "pi-workbench:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? `${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export interface AuthStatusResponse {
  authEnabled: boolean;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResponse {
  path: string;
  parentPath: string | null;
  entries: BrowseEntry[];
}

export interface HealthResponse {
  status: "ok";
  activeSessions: number;
  activePtys: number;
}

export function onUnauthorized(handler: () => void): () => void {
  const fn = (): void => handler();
  window.addEventListener(UNAUTHORIZED_EVENT, fn);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, fn);
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the auth header even if a token is present (used by login itself). */
  skipAuth?: boolean;
}

/**
 * A typed validator that asserts a runtime shape and produces a typed value
 * (or throws ApiError(status, "invalid_response_body")). Used at the
 * api-client boundary so we never `as T` server responses without checking.
 *
 * Use `vVoid` for routes that intentionally return an empty body.
 */
type Validator<T> = (value: unknown, status: number) => T;

function fail(status: number, hint: string): never {
  throw new ApiError(status, "invalid_response_body", hint);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const vVoid: Validator<undefined> = (value, status) => {
  if (value !== undefined) fail(status, "expected empty body");
  return undefined;
};

const vString =
  (path: string): Validator<string> =>
  (value, status) => {
    if (typeof value !== "string") fail(status, `${path}: expected string`);
    return value;
  };

function vAuthStatus(value: unknown, status: number): AuthStatusResponse {
  if (!isObject(value) || typeof value.authEnabled !== "boolean") {
    fail(status, "expected { authEnabled: boolean }");
  }
  return { authEnabled: value.authEnabled };
}

function vLogin(value: unknown, status: number): LoginResponse {
  if (!isObject(value) || typeof value.token !== "string" || typeof value.expiresAt !== "string") {
    fail(status, "expected { token, expiresAt }");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function vHealth(value: unknown, status: number): HealthResponse {
  if (
    !isObject(value) ||
    value.status !== "ok" ||
    typeof value.activeSessions !== "number" ||
    typeof value.activePtys !== "number"
  ) {
    fail(status, "expected { status: 'ok', activeSessions, activePtys }");
  }
  return {
    status: "ok",
    activeSessions: value.activeSessions,
    activePtys: value.activePtys,
  };
}

function vProject(value: unknown, status: number): Project {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    fail(status, "expected Project");
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    createdAt: value.createdAt,
  };
}

function vProjectList(value: unknown, status: number): { projects: Project[] } {
  if (!isObject(value) || !Array.isArray(value.projects)) {
    fail(status, "expected { projects: Project[] }");
  }
  return { projects: value.projects.map((p) => vProject(p, status)) };
}

function vBrowseEntry(value: unknown, status: number): BrowseEntry {
  if (
    !isObject(value) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.isGitRepo !== "boolean"
  ) {
    fail(status, "expected BrowseEntry");
  }
  return { name: value.name, path: value.path, isGitRepo: value.isGitRepo };
}

function vBrowse(value: unknown, status: number): BrowseResponse {
  if (
    !isObject(value) ||
    typeof value.path !== "string" ||
    !(value.parentPath === null || typeof value.parentPath === "string") ||
    !Array.isArray(value.entries)
  ) {
    fail(status, "expected BrowseResponse");
  }
  return {
    path: value.path,
    parentPath: value.parentPath as string | null,
    entries: value.entries.map((e) => vBrowseEntry(e, status)),
  };
}

function vMkdir(value: unknown, status: number): { path: string } {
  if (!isObject(value) || typeof value.path !== "string") {
    fail(status, "expected { path }");
  }
  return { path: value.path };
}

function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function request<T>(
  path: string,
  validator: Validator<T>,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts.skipAuth) {
    const stored = getStoredToken();
    if (stored) headers.Authorization = `Bearer ${stored.token}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal !== undefined) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", (err as Error).message);
  }

  if (res.status === 401 && !opts.skipAuth) {
    clearStoredToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  const text = await res.text();
  const parsed = safeParseJson(text);

  if (!res.ok) {
    const code =
      parsed.ok && isObject(parsed.value) && "error" in parsed.value
        ? String((parsed.value as { error: unknown }).error)
        : parsed.ok
          ? "request_failed"
          : "invalid_response_body";
    throw new ApiError(res.status, code);
  }

  if (!parsed.ok) {
    throw new ApiError(res.status, "invalid_response_body", "server returned non-JSON 2xx body");
  }

  return validator(parsed.value, res.status);
}

export const api = {
  authStatus: () => request("/api/v1/auth/status", vAuthStatus, { skipAuth: true }),
  login: (password: string) =>
    request("/api/v1/auth/login", vLogin, {
      method: "POST",
      body: { password },
      skipAuth: true,
    }),
  health: () => request("/api/v1/health", vHealth, { skipAuth: true }),
  listProjects: () => request("/api/v1/projects", vProjectList),
  createProject: (name: string, path: string) =>
    request("/api/v1/projects", vProject, { method: "POST", body: { name, path } }),
  renameProject: (id: string, name: string) =>
    request(`/api/v1/projects/${encodeURIComponent(id)}`, vProject, {
      method: "PATCH",
      body: { name },
    }),
  deleteProject: (id: string) =>
    request(`/api/v1/projects/${encodeURIComponent(id)}`, vVoid, { method: "DELETE" }),
  browse: (path?: string) => {
    const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/v1/projects/browse${qs}`, vBrowse);
  },
  mkdir: (parentPath: string, name: string) =>
    request("/api/v1/projects/browse/mkdir", vMkdir, {
      method: "POST",
      body: { parentPath, name },
    }),
};

// Export string validator for routes that return a bare string in future phases.
export { vString };
