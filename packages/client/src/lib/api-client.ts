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

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts.skipAuth) {
    const stored = getStoredToken();
    if (stored) headers.Authorization = `Bearer ${stored.token}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 401 && !opts.skipAuth) {
    clearStoredToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  const text = await res.text();
  const parsed: unknown = text === "" ? undefined : JSON.parse(text);

  if (!res.ok) {
    const code =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : "request_failed";
    throw new ApiError(res.status, code);
  }

  return parsed as T;
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
