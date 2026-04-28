import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  SessionManager,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { config } from "./config.js";

/**
 * Minimal SSE client contract used by the registry to fan out events.
 * Phase 5 (sse-bridge.ts) provides the concrete implementation; Phase 4
 * only needs the interface so LiveSession.clients typechecks.
 *
 * The send() signature is intentionally `unknown` for `event` so Phase 5 can
 * widen the union with webui-specific types (SnapshotEvent, etc.) without
 * forcing a dependency cycle through this module.
 */
export interface SSEClient {
  readonly id: string;
  send(event: AgentSessionEvent | { type: string; [k: string]: unknown }): void;
  close(): void;
}

export interface LiveSession {
  session: AgentSession;
  sessionId: string;
  projectId: string;
  workspacePath: string;
  clients: Set<SSEClient>;
  createdAt: Date;
  lastActivityAt: Date;
  /** Internal — call to detach the registry's own subscription on dispose. */
  unsubscribe: () => void;
}

export interface DiscoveredSession {
  sessionId: string;
  /** Full path to the .jsonl file on disk. */
  path: string;
  /** Working directory the session was created with. */
  cwd: string;
  /** User-defined session name from the latest session_info entry, if any. */
  name?: string;
  createdAt: Date;
  modifiedAt: Date;
  messageCount: number;
  /** First user message text (truncated by the SDK). */
  firstMessage: string;
}

/**
 * Unified session view that merges the in-memory live registry with the
 * on-disk session list. Sorted by recency (lastActivityAt for live sessions,
 * modifiedAt for disk-only sessions). De-duplicated by sessionId so a live
 * session never appears twice.
 *
 * This is the shape the Phase 6 sidebar list endpoint should return.
 */
export interface UnifiedSession {
  sessionId: string;
  projectId: string;
  /** True when the session is in the in-memory registry (subscribable). */
  isLive: boolean;
  name: string | undefined;
  workspacePath: string;
  /** Last activity timestamp (live: lastActivityAt; disk: modifiedAt). */
  lastActivityAt: Date;
  createdAt: Date;
  messageCount: number;
  firstMessage: string;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

const registry = new Map<string, LiveSession>();

/** Match the project-manager UUID shape; defends against ad-hoc project IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-project session directory: ${SESSION_DIR}/<projectId>/. */
function sessionDirFor(projectId: string): string {
  if (
    projectId.length === 0 ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId === ".." ||
    projectId.startsWith(".")
  ) {
    throw new Error(`session-registry: refusing path-traversal projectId: ${projectId}`);
  }
  // Test rigs use synthetic projectIds (e.g. `proj-<base36>`); accept those too,
  // but ensure the value can't escape the session dir. UUIDs from project-manager
  // satisfy UUID_RE; everything else must be a simple alphanumeric+dash token.
  if (!UUID_RE.test(projectId) && !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`session-registry: invalid projectId shape: ${projectId}`);
  }
  return join(config.sessionDir, projectId);
}

async function ensureSessionDir(projectId: string): Promise<string> {
  const dir = sessionDirFor(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Wire a registry-owned subscription onto a live session. Updates
 * lastActivityAt on every event and fans out to all currently connected
 * clients. Each client's send() is wrapped so a misbehaving client cannot
 * kill the whole fan-out — it gets dropped from the set instead.
 *
 * Note on Set mutation during iteration: ECMAScript explicitly defines
 * `for...of` over a Set as safe under deletes (the iterator advances past
 * removed entries without revisiting them). No copy needed.
 */
function makeSubscribeHandler(live: LiveSession): () => void {
  return live.session.subscribe((event: AgentSessionEvent) => {
    live.lastActivityAt = new Date();
    for (const client of live.clients) {
      try {
        client.send(event);
      } catch {
        // Drop the client on send failure — Phase 5's SSE adapter will
        // also call disposeClient on its socket close hook.
        live.clients.delete(client);
      }
    }
  });
}

export async function createSession(
  projectId: string,
  workspacePath: string,
): Promise<LiveSession> {
  const dir = await ensureSessionDir(projectId);
  const sessionManager = SessionManager.create(workspacePath, dir);
  // No model is passed — validation happens at prompt() time. This means a
  // session can be created without any LLM credentials configured, which is
  // important for the Phase 4 test to run in CI without secrets.
  //
  // agentDir IS passed: without it, the SDK falls back to ~/.pi/agent and
  // ignores PI_CONFIG_DIR entirely, breaking auth.json/models.json wiring
  // for Phase 6's prompt route.
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager,
    agentDir: config.piConfigDir,
  });

  const now = new Date();
  // Build the LiveSession in two passes so unsubscribe is the real handle by
  // the time the object is observable elsewhere — kills the M3 race window
  // (where a synchronous concurrent dispose could see the no-op unsubscribe).
  const live: LiveSession = {
    session,
    sessionId: session.sessionId,
    projectId,
    workspacePath,
    clients: new Set(),
    createdAt: now,
    lastActivityAt: now,
    unsubscribe: () => undefined,
  };
  live.unsubscribe = makeSubscribeHandler(live);
  registry.set(live.sessionId, live);
  return live;
}

export function getSession(sessionId: string): LiveSession | undefined {
  return registry.get(sessionId);
}

/**
 * Return the live sessions, optionally filtered by project. Order is the
 * registry's Map insertion order — caller is responsible for sorting if a
 * particular order is wanted. Use `listSessionsForProject` if you want a
 * recency-sorted unified view across live and disk.
 */
export function listSessions(projectId?: string): LiveSession[] {
  const all = Array.from(registry.values());
  return projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
}

/**
 * Update lastActivityAt on a live session. Routes should call this when a
 * user "views" a session (opens the panel) so the sidebar's recency ordering
 * reflects view activity, not just events from the agent loop. No-op if the
 * session isn't live.
 */
export function touchSession(sessionId: string): void {
  const live = registry.get(sessionId);
  if (live !== undefined) live.lastActivityAt = new Date();
}

/**
 * Resume a session from disk into the registry. If `sessionId` is already
 * live, returns the existing LiveSession unchanged. Otherwise locates the
 * .jsonl file via SessionManager.list, opens it, and wires it into the
 * registry. Throws SessionNotFoundError if the file isn't on disk.
 */
export async function resumeSession(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<LiveSession> {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const dir = sessionDirFor(projectId);
  const sessions = await SessionManager.list(workspacePath, dir);
  const match = sessions.find((s) => s.id === sessionId);
  if (match === undefined) throw new SessionNotFoundError(sessionId);

  const sessionManager = SessionManager.open(match.path, dir, workspacePath);
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager,
    agentDir: config.piConfigDir,
  });

  const now = new Date();
  const live: LiveSession = {
    session,
    sessionId: session.sessionId,
    projectId,
    workspacePath,
    clients: new Set(),
    createdAt: match.created,
    lastActivityAt: now,
    unsubscribe: () => undefined,
  };
  live.unsubscribe = makeSubscribeHandler(live);
  registry.set(live.sessionId, live);
  return live;
}

export function disposeSession(sessionId: string): boolean {
  const live = registry.get(sessionId);
  if (live === undefined) return false;
  // Always delete from the registry regardless of whether teardown throws,
  // so a misbehaving SDK update can't leak entries.
  try {
    try {
      // session.dispose() also clears all listeners internally (verified at
      // agent-session.js); calling unsubscribe first is defensive in case a
      // future SDK rev decouples the two.
      live.unsubscribe();
    } catch {
      // ignore
    }
    for (const client of live.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    live.clients.clear();
    try {
      live.session.dispose();
    } catch {
      // ignore — SDK doesn't currently throw, but H2-defensive
    }
  } finally {
    registry.delete(sessionId);
  }
  return true;
}

/**
 * Scan the project's session dir on disk WITHOUT loading sessions into the
 * registry. Used by the sidebar list. Backed by the SDK's SessionManager.list
 * which parses each file's first-line header and a few message previews.
 *
 * Returns an empty array (not throws) when the per-project dir doesn't exist
 * yet — e.g. a project that has never had a session.
 */
export async function discoverSessionsOnDisk(
  projectId: string,
  workspacePath: string,
): Promise<DiscoveredSession[]> {
  const dir = sessionDirFor(projectId);
  // SDK's list() guards `existsSync(dir)` and returns [] for missing dirs,
  // so we don't need an outer ENOENT catch.
  const infos: SessionInfo[] = await SessionManager.list(workspacePath, dir);
  return infos.map((info) => {
    const out: DiscoveredSession = {
      sessionId: info.id,
      path: info.path,
      cwd: info.cwd,
      createdAt: info.created,
      modifiedAt: info.modified,
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
    };
    if (info.name !== undefined) out.name = info.name;
    return out;
  });
}

/**
 * Unified, recency-sorted view of sessions for a project: merges live
 * registry entries with on-disk discovery, dedupes by sessionId so a session
 * that is currently live doesn't also appear from disk. Live sessions take
 * precedence (carry the freshest `lastActivityAt`).
 *
 * This is the canonical surface for the Phase 6 sidebar list — call sites
 * should not implement their own merge.
 */
export async function listSessionsForProject(
  projectId: string,
  workspacePath: string,
): Promise<UnifiedSession[]> {
  const live = listSessions(projectId);
  const liveById = new Map<string, UnifiedSession>(
    live.map((l) => [
      l.sessionId,
      {
        sessionId: l.sessionId,
        projectId: l.projectId,
        isLive: true,
        name: l.session.sessionName,
        workspacePath: l.workspacePath,
        lastActivityAt: l.lastActivityAt,
        createdAt: l.createdAt,
        messageCount: l.session.messages.length,
        firstMessage: "",
      },
    ]),
  );

  const disk = await discoverSessionsOnDisk(projectId, workspacePath);
  for (const d of disk) {
    if (liveById.has(d.sessionId)) {
      // Backfill firstMessage from disk on a live entry (live AgentSession
      // doesn't expose a cheap firstMessage preview).
      const merged = liveById.get(d.sessionId);
      if (merged !== undefined) merged.firstMessage = d.firstMessage;
      continue;
    }
    liveById.set(d.sessionId, {
      sessionId: d.sessionId,
      projectId,
      isLive: false,
      name: d.name,
      workspacePath,
      lastActivityAt: d.modifiedAt,
      createdAt: d.createdAt,
      messageCount: d.messageCount,
      firstMessage: d.firstMessage,
    });
  }
  return Array.from(liveById.values()).sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );
}

/** Number of currently-live sessions across all projects. Used by /health. */
export function sessionCount(): number {
  return registry.size;
}

/** Test/teardown helper — disposes every live session. */
export function disposeAllSessions(): void {
  for (const id of Array.from(registry.keys())) {
    disposeSession(id);
  }
}
