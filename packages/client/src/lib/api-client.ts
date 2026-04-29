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

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
  truncated?: boolean;
}

export interface FileReadResponse {
  path: string;
  content: string;
  size: number;
  language: string;
  binary: boolean;
}

export interface TurnDiffEntry {
  file: string;
  tool: "write" | "edit";
  diff: string;
  additions: number;
  deletions: number;
  isPureAddition: boolean;
}

export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown";

export interface GitFileStatus {
  path: string;
  staged: boolean;
  unstaged: boolean;
  kind: GitFileStatusKind;
  code: string;
  originalPath?: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  files: GitFileStatus[];
}

export interface GitDiffResponse {
  isGitRepo: boolean;
  diff: string;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitLogResponse {
  isGitRepo: boolean;
  commits: GitLogEntry[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitBranchesResponse {
  isGitRepo: boolean;
  current?: string;
  branches: GitBranch[];
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

function vFileTreeNode(value: unknown, status: number): FileTreeNode {
  if (!isObject(value)) fail(status, "expected FileTreeNode");
  const type = value.type;
  if (
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    (type !== "file" && type !== "directory")
  ) {
    fail(status, "expected FileTreeNode");
  }
  const out: FileTreeNode = { name: value.name, path: value.path, type };
  if (Array.isArray(value.children)) {
    out.children = value.children.map((c) => vFileTreeNode(c, status));
  }
  if (typeof value.truncated === "boolean") out.truncated = value.truncated;
  return out;
}

function vFileRead(value: unknown, status: number): FileReadResponse {
  if (
    !isObject(value) ||
    typeof value.path !== "string" ||
    typeof value.content !== "string" ||
    typeof value.size !== "number" ||
    typeof value.language !== "string" ||
    typeof value.binary !== "boolean"
  ) {
    fail(status, "expected FileReadResponse");
  }
  return {
    path: value.path,
    content: value.content,
    size: value.size,
    language: value.language,
    binary: value.binary,
  };
}

function vTurnDiff(value: unknown, status: number): { entries: TurnDiffEntry[] } {
  if (!isObject(value) || !Array.isArray(value.entries)) {
    fail(status, "expected { entries: TurnDiffEntry[] }");
  }
  return {
    entries: value.entries.map((e): TurnDiffEntry => {
      if (
        !isObject(e) ||
        typeof e.file !== "string" ||
        (e.tool !== "write" && e.tool !== "edit") ||
        typeof e.diff !== "string" ||
        typeof e.additions !== "number" ||
        typeof e.deletions !== "number" ||
        typeof e.isPureAddition !== "boolean"
      ) {
        fail(status, "expected TurnDiffEntry");
      }
      return {
        file: e.file,
        tool: e.tool,
        diff: e.diff,
        additions: e.additions,
        deletions: e.deletions,
        isPureAddition: e.isPureAddition,
      };
    }),
  };
}

function vGitStatus(value: unknown, status: number): GitStatus {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.files)) {
    fail(status, "expected GitStatus");
  }
  const out: GitStatus = {
    isGitRepo: value.isGitRepo,
    files: value.files.map((f): GitFileStatus => {
      if (
        !isObject(f) ||
        typeof f.path !== "string" ||
        typeof f.staged !== "boolean" ||
        typeof f.unstaged !== "boolean" ||
        typeof f.kind !== "string" ||
        typeof f.code !== "string"
      ) {
        fail(status, "expected GitFileStatus");
      }
      const entry: GitFileStatus = {
        path: f.path,
        staged: f.staged,
        unstaged: f.unstaged,
        kind: f.kind as GitFileStatusKind,
        code: f.code,
      };
      if (typeof f.originalPath === "string") entry.originalPath = f.originalPath;
      return entry;
    }),
  };
  if (typeof value.branch === "string") out.branch = value.branch;
  return out;
}

function vGitDiff(value: unknown, status: number): GitDiffResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || typeof value.diff !== "string") {
    fail(status, "expected GitDiffResponse");
  }
  return { isGitRepo: value.isGitRepo, diff: value.diff };
}

function vGitLog(value: unknown, status: number): GitLogResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.commits)) {
    fail(status, "expected GitLogResponse");
  }
  return {
    isGitRepo: value.isGitRepo,
    commits: value.commits.map((c): GitLogEntry => {
      if (
        !isObject(c) ||
        typeof c.hash !== "string" ||
        typeof c.message !== "string" ||
        typeof c.author !== "string" ||
        typeof c.date !== "string"
      ) {
        fail(status, "expected GitLogEntry");
      }
      return { hash: c.hash, message: c.message, author: c.author, date: c.date };
    }),
  };
}

function vGitBranches(value: unknown, status: number): GitBranchesResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.branches)) {
    fail(status, "expected GitBranchesResponse");
  }
  const out: GitBranchesResponse = {
    isGitRepo: value.isGitRepo,
    branches: value.branches.map((b): GitBranch => {
      if (
        !isObject(b) ||
        typeof b.name !== "string" ||
        typeof b.current !== "boolean" ||
        typeof b.remote !== "boolean"
      ) {
        fail(status, "expected GitBranch");
      }
      return { name: b.name, current: b.current, remote: b.remote };
    }),
  };
  if (typeof value.current === "string") out.current = value.current;
  return out;
}

function vPathOnly(value: unknown, status: number): { path: string } {
  if (!isObject(value) || typeof value.path !== "string") {
    fail(status, "expected { path: string }");
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
  getTurnDiff: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/turn-diff`, vTurnDiff),

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

  // ---------------- files ----------------
  filesTree: (projectId: string, maxDepth?: number) => {
    const qs = new URLSearchParams({ projectId });
    if (maxDepth !== undefined) qs.set("maxDepth", String(maxDepth));
    return request(`/api/v1/files/tree?${qs.toString()}`, vFileTreeNode);
  },
  filesRead: (projectId: string, path: string) => {
    const qs = new URLSearchParams({ projectId, path });
    return request(`/api/v1/files/read?${qs.toString()}`, vFileRead);
  },
  filesWrite: (projectId: string, path: string, content: string) =>
    request("/api/v1/files/write", vPathOnly, {
      method: "PUT",
      body: { projectId, path, content },
    }),
  filesMkdir: (projectId: string, parentPath: string, name: string) =>
    request("/api/v1/files/mkdir", vPathOnly, {
      method: "POST",
      body: { projectId, parentPath, name },
    }),
  filesRename: (projectId: string, path: string, name: string) =>
    request("/api/v1/files/rename", vPathOnly, {
      method: "POST",
      body: { projectId, path, name },
    }),
  filesMove: (projectId: string, src: string, dest: string) =>
    request("/api/v1/files/move", vPathOnly, {
      method: "POST",
      body: { projectId, src, dest },
    }),
  filesDelete: (projectId: string, path: string) => {
    const qs = new URLSearchParams({ projectId, path });
    return request(`/api/v1/files/delete?${qs.toString()}`, vVoid, { method: "DELETE" });
  },

  // ---------------- git ----------------
  gitStatus: (projectId: string) =>
    request(`/api/v1/git/status?projectId=${encodeURIComponent(projectId)}`, vGitStatus),
  gitDiff: (projectId: string) =>
    request(`/api/v1/git/diff?projectId=${encodeURIComponent(projectId)}`, vGitDiff),
  gitDiffStaged: (projectId: string) =>
    request(`/api/v1/git/diff/staged?projectId=${encodeURIComponent(projectId)}`, vGitDiff),
  gitDiffFile: (projectId: string, path: string, staged: boolean) => {
    const qs = new URLSearchParams({ projectId, path });
    if (staged) qs.set("staged", "1");
    return request(`/api/v1/git/diff/file?${qs.toString()}`, vGitDiff);
  },
  gitLog: (projectId: string, limit?: number) => {
    const qs = new URLSearchParams({ projectId });
    if (limit !== undefined) qs.set("limit", String(limit));
    return request(`/api/v1/git/log?${qs.toString()}`, vGitLog);
  },
  gitBranches: (projectId: string) =>
    request(`/api/v1/git/branches?projectId=${encodeURIComponent(projectId)}`, vGitBranches),
  gitCheckout: (projectId: string, branch: string) =>
    request(
      "/api/v1/git/checkout",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, branch } },
    ),
  gitBranchCreate: (
    projectId: string,
    name: string,
    opts?: { startPoint?: string; checkout?: boolean },
  ) => {
    const body: Record<string, unknown> = { projectId, name };
    if (opts?.startPoint !== undefined) body.startPoint = opts.startPoint;
    if (opts?.checkout !== undefined) body.checkout = opts.checkout;
    return request(
      "/api/v1/git/branch/create",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body },
    );
  },
  gitBranchDelete: (projectId: string, name: string, force?: boolean) => {
    const qs = new URLSearchParams({ projectId });
    if (force === true) qs.set("force", "1");
    return request(
      `/api/v1/git/branch/${encodeURIComponent(name)}?${qs.toString()}`,
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "DELETE" },
    );
  },
  gitStage: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/stage",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitUnstage: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/unstage",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitRevert: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/revert",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitCommit: (projectId: string, message: string) =>
    request(
      "/api/v1/git/commit",
      (v, s) => {
        if (!isObject(v) || typeof v.hash !== "string") fail(s, "expected { hash }");
        return { hash: v.hash };
      },
      { method: "POST", body: { projectId, message } },
    ),
  gitFetch: (projectId: string, opts?: { remote?: string; prune?: boolean }) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.prune !== undefined) body.prune = opts.prune;
    return request(
      "/api/v1/git/fetch",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
  gitPull: (projectId: string, opts?: { remote?: string; branch?: string; rebase?: boolean }) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.branch !== undefined) body.branch = opts.branch;
    if (opts?.rebase !== undefined) body.rebase = opts.rebase;
    return request(
      "/api/v1/git/pull",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
  gitPush: (
    projectId: string,
    opts?: { remote?: string; branch?: string; setUpstream?: boolean },
  ) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.branch !== undefined) body.branch = opts.branch;
    if (opts?.setUpstream !== undefined) body.setUpstream = opts.setUpstream;
    return request(
      "/api/v1/git/push",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
};

// Export string validator for routes that return a bare string in future phases.
export { vString };
