import { clearStoredToken, getStoredToken } from "./auth-client";

/**
 * Window event dispatched whenever an authenticated request returns 401
 * (and after the SSE reader sees a 401). The auth store subscribes to this
 * to clear `isAuthenticated` and surface the login screen. Exported so the
 * SSE reader uses the same constant — keeps the wire-name in one place.
 */
export const UNAUTHORIZED_EVENT = "pi-workbench:unauthorized";

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

export interface UnifiedSession {
  sessionId: string;
  projectId: string;
  isLive: boolean;
  name?: string;
  workspacePath: string;
  lastActivityAt: string;
  createdAt: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionSummary {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  createdAt: string;
  lastActivityAt: string;
  isLive: boolean;
  name?: string;
  messageCount: number;
  isStreaming: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: "global" | "project";
  filePath: string;
  enabled: boolean;
  disableModelInvocation: boolean;
}

export interface ProviderModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  hasAuth: boolean;
}

export interface ProvidersListing {
  providers: Array<{ provider: string; models: ProviderModelEntry[] }>;
}

export interface AuthSummary {
  providers: Record<string, { configured: boolean; source?: string; label?: string }>;
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
    !(
      value.parentPath === null ||
      value.parentPath === undefined ||
      typeof value.parentPath === "string"
    ) ||
    !Array.isArray(value.entries)
  ) {
    fail(status, "expected BrowseResponse");
  }
  // Normalize undefined → null so consumers see a single absent shape.
  // The server route already sends `null` (routes/projects.ts), but a
  // future refactor that drops the `?? null` would otherwise produce a
  // confusing "expected BrowseResponse" instead of a useful surface.
  return {
    path: value.path,
    parentPath: typeof value.parentPath === "string" ? value.parentPath : null,
    entries: value.entries.map((e) => vBrowseEntry(e, status)),
  };
}

function vMkdir(value: unknown, status: number): { path: string } {
  if (!isObject(value) || typeof value.path !== "string") {
    fail(status, "expected { path }");
  }
  return { path: value.path };
}

function vUnifiedSession(value: unknown, status: number): UnifiedSession {
  if (
    !isObject(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.isLive !== "boolean" ||
    typeof value.workspacePath !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.messageCount !== "number" ||
    typeof value.firstMessage !== "string"
  ) {
    fail(status, "expected UnifiedSession");
  }
  const out: UnifiedSession = {
    sessionId: value.sessionId,
    projectId: value.projectId,
    isLive: value.isLive,
    workspacePath: value.workspacePath,
    lastActivityAt: value.lastActivityAt,
    createdAt: value.createdAt,
    messageCount: value.messageCount,
    firstMessage: value.firstMessage,
  };
  if (typeof value.name === "string") out.name = value.name;
  return out;
}

function vUnifiedSessionList(value: unknown, status: number): { sessions: UnifiedSession[] } {
  if (!isObject(value) || !Array.isArray(value.sessions)) {
    fail(status, "expected { sessions: UnifiedSession[] }");
  }
  return { sessions: value.sessions.map((s) => vUnifiedSession(s, status)) };
}

function vSessionSummary(value: unknown, status: number): SessionSummary {
  if (
    !isObject(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    typeof value.isLive !== "boolean" ||
    typeof value.messageCount !== "number" ||
    typeof value.isStreaming !== "boolean"
  ) {
    fail(status, "expected SessionSummary");
  }
  const out: SessionSummary = {
    sessionId: value.sessionId,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    isLive: value.isLive,
    messageCount: value.messageCount,
    isStreaming: value.isStreaming,
  };
  if (typeof value.name === "string") out.name = value.name;
  return out;
}

function vAccepted(value: unknown, status: number): { accepted: true } {
  if (!isObject(value) || value.accepted !== true) fail(status, "expected { accepted: true }");
  return { accepted: true };
}

function vSkillsList(value: unknown, status: number): { skills: SkillSummary[] } {
  if (!isObject(value) || !Array.isArray(value.skills)) {
    fail(status, "expected { skills: SkillSummary[] }");
  }
  return {
    skills: value.skills.map((s): SkillSummary => {
      if (
        !isObject(s) ||
        typeof s.name !== "string" ||
        typeof s.description !== "string" ||
        (s.source !== "global" && s.source !== "project") ||
        typeof s.filePath !== "string" ||
        typeof s.enabled !== "boolean" ||
        typeof s.disableModelInvocation !== "boolean"
      ) {
        fail(status, "expected SkillSummary");
      }
      return {
        name: s.name,
        description: s.description,
        source: s.source,
        filePath: s.filePath,
        enabled: s.enabled,
        disableModelInvocation: s.disableModelInvocation,
      };
    }),
  };
}

function vProvidersListing(value: unknown, status: number): ProvidersListing {
  if (!isObject(value) || !Array.isArray(value.providers)) {
    fail(status, "expected { providers: [...] }");
  }
  return { providers: value.providers as ProvidersListing["providers"] };
}

function vAuthSummary(value: unknown, status: number): AuthSummary {
  if (!isObject(value) || !isObject(value.providers)) {
    fail(status, "expected { providers: { ... } }");
  }
  return value as unknown as AuthSummary;
}

function vSettings(value: unknown, status: number): Record<string, unknown> {
  if (!isObject(value)) fail(status, "expected settings object");
  return value;
}

function vModelsJson(value: unknown, status: number): { providers: Record<string, unknown> } {
  if (!isObject(value) || !isObject(value.providers)) {
    fail(status, "expected { providers: {...} }");
  }
  return value as { providers: Record<string, unknown> };
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

  // ---------------- sessions ----------------
  listSessions: (projectId?: string) => {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/v1/sessions${qs}`, vUnifiedSessionList);
  },
  createSession: (projectId: string) =>
    request("/api/v1/sessions", vSessionSummary, {
      method: "POST",
      body: { projectId },
    }),
  getSession: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}`, vSessionSummary),
  getMessages: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, (v, s) => {
      if (!isObject(v) || !Array.isArray(v.messages)) {
        fail(s, "expected { messages: [...] }");
      }
      return { messages: v.messages as Array<Record<string, unknown>> };
    }),
  disposeSession: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}`, vVoid, { method: "DELETE" }),
  renameSession: (id: string, name: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/name`, vSessionSummary, {
      method: "POST",
      body: { name },
    }),

  // ---------------- prompt + control ----------------
  prompt: (id: string, text: string, streamingBehavior?: "steer" | "followUp") => {
    const body: Record<string, unknown> = { text };
    if (streamingBehavior !== undefined) body.streamingBehavior = streamingBehavior;
    return request(`/api/v1/sessions/${encodeURIComponent(id)}/prompt`, vAccepted, {
      method: "POST",
      body,
    });
  },
  steer: (id: string, text: string, mode?: "steer" | "followUp") => {
    const body: Record<string, unknown> = { text };
    if (mode !== undefined) body.mode = mode;
    return request(`/api/v1/sessions/${encodeURIComponent(id)}/steer`, vAccepted, {
      method: "POST",
      body,
    });
  },
  abort: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/abort`, vVoid, { method: "POST" }),
  setModel: (id: string, provider: string, modelId: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/model`,
      (v, s) => {
        if (!isObject(v) || typeof v.provider !== "string" || typeof v.modelId !== "string") {
          fail(s, "expected { provider, modelId }");
        }
        return { provider: v.provider, modelId: v.modelId };
      },
      { method: "POST", body: { provider, modelId } },
    ),

  // ---------------- config ----------------
  getModelsJson: () => request("/api/v1/config/models", vModelsJson),
  setModelsJson: (data: { providers: Record<string, unknown> }) =>
    request("/api/v1/config/models", vModelsJson, { method: "PUT", body: data }),
  getProviders: () => request("/api/v1/config/providers", vProvidersListing),
  getSettings: () => request("/api/v1/config/settings", vSettings),
  updateSettings: (patch: Record<string, unknown>) =>
    request("/api/v1/config/settings", vSettings, { method: "PUT", body: patch }),
  getAuthSummary: () => request("/api/v1/config/auth", vAuthSummary),
  setApiKey: (provider: string, apiKey: string) =>
    request(
      `/api/v1/config/auth/${encodeURIComponent(provider)}`,
      (v, s) => {
        if (!isObject(v) || typeof v.provider !== "string" || v.configured !== true) {
          fail(s, "expected { provider, configured: true }");
        }
        return { provider: v.provider as string, configured: true as const };
      },
      { method: "PUT", body: { apiKey } },
    ),
  removeApiKey: (provider: string) =>
    request(`/api/v1/config/auth/${encodeURIComponent(provider)}`, vVoid, {
      method: "DELETE",
    }),
  listSkills: (projectId: string) =>
    request(`/api/v1/config/skills?projectId=${encodeURIComponent(projectId)}`, vSkillsList),
  setSkillEnabled: (projectId: string, name: string, enabled: boolean) =>
    request(
      `/api/v1/config/skills/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      vSkillsList,
      { method: "PUT", body: { enabled } },
    ),
};

// Export string validator for routes that return a bare string in future phases.
export { vString };
