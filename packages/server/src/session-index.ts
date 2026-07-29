import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { makeDedupe, makeLock } from "./concurrency.js";

/**
 * Persistent, best-effort metadata cache for session discovery. Session JSONLs
 * remain the source of truth. In particular, this cache deliberately never
 * retains a usable session pathname: a pathname is a mutable lookup, not a
 * capability. Each caller receives paths only from its current discovery pass.
 */
const INDEX_VERSION = 4;

export interface IndexedSession {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt: Date;
  modifiedAt: Date;
  messageCount: number;
  firstMessage: string;
}

interface PersistedSession {
  sessionId: string;
  /** Relative diagnostic metadata only; it is never resolved or used for I/O. */
  relativePath: string;
  cwd: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
}

interface PersistedProjectIndex {
  workspacePath: string;
  sessions: PersistedSession[];
}

interface PersistedIndex {
  version: number;
  projects: Record<string, PersistedProjectIndex>;
}

interface ProjectCache {
  workspacePath: string;
  /** Metadata only. No cached field is ever used as a filesystem path. */
  sessions: PersistedSession[];
}

const projects = new Map<string, ProjectCache>();
const projectGenerations = new Map<string, number>();
let persisted: PersistedIndex = { version: INDEX_VERSION, projects: {} };
let loaded = false;
const writeLock = makeLock();
const rebuildInflight = makeDedupe<string, IndexedSession[]>();

function projectGeneration(projectId: string): number {
  return projectGenerations.get(projectId) ?? 0;
}

function indexPath(): string {
  return `${config.forgeDataDir}/session-index.json`;
}

function parseSession(value: unknown): PersistedSession | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const session = value as Record<string, unknown>;
  if (
    typeof session.sessionId !== "string" ||
    typeof session.relativePath !== "string" ||
    typeof session.cwd !== "string" ||
    typeof session.createdAt !== "string" ||
    typeof session.modifiedAt !== "string" ||
    typeof session.messageCount !== "number" ||
    !Number.isFinite(session.messageCount) ||
    Number.isNaN(Date.parse(session.createdAt)) ||
    Number.isNaN(Date.parse(session.modifiedAt))
  ) {
    return undefined;
  }
  return session as unknown as PersistedSession;
}

function parseIndex(value: unknown): PersistedIndex | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parsed = value as Record<string, unknown>;
  if (
    parsed.version !== INDEX_VERSION ||
    typeof parsed.projects !== "object" ||
    parsed.projects === null
  ) {
    return undefined;
  }
  const projects: Record<string, PersistedProjectIndex> = {};
  for (const [projectId, rawProject] of Object.entries(parsed.projects)) {
    if (typeof rawProject !== "object" || rawProject === null) continue;
    const project = rawProject as Record<string, unknown>;
    if (typeof project.workspacePath !== "string" || !Array.isArray(project.sessions)) continue;
    const sessions = project.sessions.map(parseSession);
    if (sessions.some((session) => session === undefined)) continue;
    projects[projectId] = {
      workspacePath: project.workspacePath,
      sessions: sessions as PersistedSession[],
    };
  }
  return { version: INDEX_VERSION, projects };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(indexPath(), "utf8");
    const parsed = parseIndex(JSON.parse(raw));
    // Old formats contained absolute session paths and are intentionally ignored.
    if (parsed !== undefined) persisted = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `${JSON.stringify({ level: "warn", msg: "session-index: ignoring unreadable index" })}\n`,
      );
    }
  }
}

async function atomicWriteIndex(): Promise<void> {
  await writeLock(async () => {
    const target = indexPath();
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(config.forgeDataDir, { recursive: true });
      await writeFile(temporary, JSON.stringify(persisted), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } catch (err) {
      await unlink(temporary).catch(() => undefined);
      process.stderr.write(
        `${JSON.stringify({ level: "warn", msg: "session-index: failed to persist index", error: err instanceof Error ? err.message : String(err) })}\n`,
      );
    }
  });
}

function safeRelativePath(sessionDir: string, path: string): string | undefined {
  const relativePath = relative(resolve(sessionDir), resolve(path));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    return undefined;
  }
  return relativePath;
}

function toPersisted(sessionDir: string, session: IndexedSession): PersistedSession | undefined {
  const relativePath = safeRelativePath(sessionDir, session.path);
  if (relativePath === undefined) return undefined;
  return {
    sessionId: session.sessionId,
    relativePath,
    cwd: session.cwd,
    createdAt: session.createdAt.toISOString(),
    modifiedAt: session.modifiedAt.toISOString(),
    messageCount: session.messageCount,
  };
}

async function isCurrentRegularSessionPath(sessionDir: string, path: string): Promise<boolean> {
  if (safeRelativePath(sessionDir, path) === undefined) return false;
  try {
    // This applies only to the current discovery result. The handle is not
    // cached and the pathname is never canonicalized for later reuse.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      return (await handle.stat()).isFile();
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function rebuildProject(
  projectId: string,
  workspacePath: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  const generation = projectGeneration(projectId);
  return rebuildInflight(`${projectId}:${generation}`, async () => {
    // Do not validate, fingerprint, watch, canonicalize, or return a path from
    // a prior cache entry. Discovery owns current path handling; its result is
    // returned directly so a cache cannot turn an earlier pathname validation
    // into a durable capability.
    const discovered = await discover();
    const sessions = (
      await Promise.all(
        discovered.map(async (session) =>
          (await isCurrentRegularSessionPath(sessionDir, session.path)) ? session : undefined,
        ),
      )
    ).filter((session): session is IndexedSession => session !== undefined);
    if (generation !== projectGeneration(projectId)) return sessions;

    const metadata = sessions
      .map((session) => toPersisted(sessionDir, session))
      .filter((session): session is PersistedSession => session !== undefined);
    const cache = { workspacePath, sessions: metadata };
    projects.set(projectId, cache);
    persisted.projects[projectId] = cache;
    await atomicWriteIndex();
    return sessions;
  });
}

/**
 * Discover the current JSONL paths and update metadata opportunistically.
 * Concurrent requests share one scan, but sequential reads intentionally do
 * not serve old pathnames from the cache.
 */
export async function getIndexedProjectSessions(
  projectId: string,
  workspacePath: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  await ensureLoaded();
  return rebuildProject(projectId, workspacePath, sessionDir, discover);
}

/** Mark one project's metadata stale after a known session filesystem mutation. */
export function invalidateSessionIndex(projectId: string): void {
  projectGenerations.set(projectId, projectGeneration(projectId) + 1);
  projects.delete(projectId);
}

/**
 * Remove only one project's derived metadata and force its next lookup to scan
 * source JSONLs again. Session files and project data are never modified.
 */
export async function resetSessionIndex(projectId: string): Promise<void> {
  await ensureLoaded();
  projectGenerations.set(projectId, projectGeneration(projectId) + 1);
  projects.delete(projectId);
  delete persisted.projects[projectId];
  await atomicWriteIndex();
}
