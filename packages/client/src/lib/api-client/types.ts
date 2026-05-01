/**
 * API client types — request/response shapes shared by the validators
 * and the `api` object. Kept as a leaf module (no runtime imports
 * beyond ApiError) so consumers can `import type` from here without
 * pulling in the request machinery.
 */

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
  mustChangePassword: boolean;
}

export interface ChangePasswordResponse {
  token: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

// ---------------- MCP ----------------

export type McpTransport = "auto" | "streamable-http" | "sse";
export type McpConnectionState = "idle" | "connecting" | "connected" | "error" | "disabled";

export interface McpServerConfig {
  url: string;
  transport?: McpTransport;
  enabled?: boolean;
  headers?: Record<string, string>;
}

export interface McpServerStatus {
  scope: "global" | "project";
  projectId?: string;
  name: string;
  url: string;
  enabled: boolean;
  state: McpConnectionState;
  toolCount: number;
  lastError?: string;
  transport?: McpTransport;
}

export interface McpServersResponse {
  /** GLOBAL config (project servers are read-only via /servers query). */
  servers: Record<string, McpServerConfig>;
  /** Status across global + (optionally) the queried project's scope. */
  status: McpServerStatus[];
}

export interface McpSettingsResponse {
  /** Master enable/disable. When false, no MCP tools are passed to sessions. */
  enabled: boolean;
  /** Connected count across GLOBAL servers only. */
  connected: number;
  /** Total GLOBAL servers configured. */
  total: number;
}

export interface McpToolSummary {
  name: string;
  description: string;
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

export interface UiConfigResponse {
  /** Frontend "minimal" mode — see server config.minimalUi. */
  minimal: boolean;
  /** Absolute path to the workspace root, used by minimal-mode project create. */
  workspaceRoot: string;
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
  input: ("text" | "image")[];
  hasAuth: boolean;
}

export interface ProvidersListing {
  providers: { provider: string; models: ProviderModelEntry[] }[];
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
  /** Parent commit hashes — empty for the root, two for merges. */
  parents: string[];
  /** git ref decorations (e.g. "HEAD -> main", "tag: v1", "origin/main"). */
  refs: string[];
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

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitRemotesResponse {
  isGitRepo: boolean;
  remotes: GitRemote[];
}

export interface SearchMatch {
  /** Project-relative POSIX path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column where the match starts on that line. */
  column: number;
  /** Number of UTF-16 units the match spans (0 if unavailable). */
  length: number;
  /** Full text of the matching line, with no trailing newline. */
  lineSnippet: string;
}

export interface SearchResponse {
  engine: "ripgrep" | "node";
  matches: SearchMatch[];
  /** True when the result hit the limit and more matches exist. */
  truncated: boolean;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  includeGitignored?: boolean;
  include?: string;
  exclude?: string;
  limit?: number;
}

export interface SessionTreeEntry {
  id: string;
  parentId: string | null;
  /** SDK entry type — "message", "thinking_level_change", "compaction", "branch_summary", etc. */
  type: string;
  timestamp: string;
  /** Set on `type === "message"` entries. */
  role?: string;
  /** Truncated text preview (≤200 chars). Set on text-bearing message entries. */
  preview?: string;
  /** User-supplied bookmark label, if present. */
  label?: string;
}

export interface ContextTurn {
  /** Index into the messages array of this assistant turn. */
  index: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Cost in USD for this turn (sum of per-token costs). */
  cost: number;
  model: string;
  provider: string;
  /** Unix epoch ms. */
  timestamp: number;
  stopReason?: string;
}

export interface ContextUsageStats {
  /** Total context window the model supports (max input tokens). */
  contextWindow: number;
  /** Estimated current context tokens, omitted when SDK reports unknown. */
  tokens?: number;
  /** Usage as fraction of contextWindow (0..1), omitted when unknown. */
  percent?: number;
}

export interface SessionContextResponse {
  /** Full message array as the LLM sees it (post-compaction). */
  messages: Record<string, unknown>[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Sum of input + output + cache reads + cache writes across every turn. */
  totalTokens: number;
  /** Cumulative USD cost across every turn. */
  totalCost: number;
  /** Per-turn breakdown derived from each AssistantMessage.usage. */
  turns: ContextTurn[];
  contextUsage: ContextUsageStats;
}

export interface SessionTreeResponse {
  /** Current leaf id of the session — the active branch tip. */
  leafId: string | null;
  /** Entry ids on the active branch path, root → leaf. Used for highlighting. */
  branchIds: string[];
  /** Every entry across every branch. Build the tree client-side via parentId. */
  entries: SessionTreeEntry[];
}

export interface UploadedFile {
  /** Absolute path the file was written to. */
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the bytes the server actually wrote. */
  sha256: string;
}

export interface UploadResponse {
  files: UploadedFile[];
}

/**
 * Internal request options for the `request()` helper. Not exported
 * via the public api-client surface; lives in types.ts so request.ts
 * doesn't have to redeclare it.
 */
export interface RequestOpts {
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
 */
export type Validator<T> = (value: unknown, status: number) => T;
