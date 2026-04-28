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
};
