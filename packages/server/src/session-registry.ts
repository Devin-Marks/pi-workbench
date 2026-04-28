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
 */
export interface SSEClient {
  readonly id: string;
  send(event: AgentSessionEvent): void;
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
  /** First user message text (truncated by the SDK), useful for sidebar previews. */
  firstMessage: string;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

const registry = new Map<string, LiveSession>();

/** Per-project session directory: ${SESSION_DIR}/<projectId>/. */
function sessionDirFor(projectId: string): string {
  return join(config.sessionDir, projectId);
}

async function ensureSessionDir(projectId: string): Promise<string> {
  const dir = sessionDirFor(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function attachToLiveSession(live: LiveSession): void {
  // Single registry-owned subscription. Updates lastActivityAt on every event
  // and fans out to all currently connected clients. Each client's send() is
  // wrapped so a misbehaving client cannot kill the whole fan-out.
  live.unsubscribe = live.session.subscribe((event: AgentSessionEvent) => {
    live.lastActivityAt = new Date();
    for (const client of live.clients) {
      try {
        client.send(event);
      } catch {
        // Drop the client on send failure — Phase 5's SSE adapter will
        // call disposeClient on its socket close hook, but a thrown send
        // here means the socket already died.
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
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager,
  });

  const now = new Date();
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
  attachToLiveSession(live);
  registry.set(live.sessionId, live);
  return live;
}

export function getSession(sessionId: string): LiveSession | undefined {
  return registry.get(sessionId);
}

export function listSessions(projectId?: string): LiveSession[] {
  const all = Array.from(registry.values());
  return projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
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
  attachToLiveSession(live);
  registry.set(live.sessionId, live);
  return live;
}

export function disposeSession(sessionId: string): boolean {
  const live = registry.get(sessionId);
  if (live === undefined) return false;
  try {
    live.unsubscribe();
  } catch {
    // ignore — disposing should be best-effort
  }
  for (const client of live.clients) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  live.clients.clear();
  live.session.dispose();
  registry.delete(sessionId);
  return true;
}

/**
 * Scan the project's session dir on disk WITHOUT loading sessions into the
 * registry. Used by the sidebar list. Backed by the SDK's SessionManager.list
 * which parses each file's first-line header and a few message previews.
 */
export async function discoverSessionsOnDisk(
  projectId: string,
  workspacePath: string,
): Promise<DiscoveredSession[]> {
  const dir = sessionDirFor(projectId);
  let infos: SessionInfo[];
  try {
    infos = await SessionManager.list(workspacePath, dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
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
