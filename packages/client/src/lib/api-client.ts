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

function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
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
    // Aborts surface as DOMException with name "AbortError" — propagate so
    // callers can distinguish from real network failures.
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
      parsed.ok &&
      typeof parsed.value === "object" &&
      parsed.value !== null &&
      "error" in parsed.value
        ? String((parsed.value as { error: unknown }).error)
        : parsed.ok
          ? "request_failed"
          : "invalid_response_body";
    throw new ApiError(res.status, code);
  }

  if (!parsed.ok) {
    // 2xx with malformed JSON is a real server bug — don't paper over it.
    throw new ApiError(res.status, "invalid_response_body", "server returned non-JSON 2xx body");
  }

  return parsed.value as T;
}

export const api = {
  authStatus: () => request<AuthStatusResponse>("/api/v1/auth/status", { skipAuth: true }),
  login: (password: string) =>
    request<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      body: { password },
      skipAuth: true,
    }),
  health: () =>
    request<{ status: "ok"; activeSessions: number; activePtys: number }>("/api/v1/health", {
      skipAuth: true,
    }),
  listProjects: () => request<{ projects: Project[] }>("/api/v1/projects"),
  createProject: (name: string, path: string) =>
    request<Project>("/api/v1/projects", { method: "POST", body: { name, path } }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name },
    }),
  deleteProject: (id: string) =>
    request<undefined>(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  browse: (path?: string) => {
    const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
    return request<BrowseResponse>(`/api/v1/projects/browse${qs}`);
  },
  mkdir: (parentPath: string, name: string) =>
    request<{ path: string }>("/api/v1/projects/browse/mkdir", {
      method: "POST",
      body: { parentPath, name },
    }),
};
