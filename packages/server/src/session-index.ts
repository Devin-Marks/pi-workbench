import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { makeDedupe, makeLock } from "./concurrency.js";

/**
 * Persistent, best-effort metadata cache for session discovery. Session JSONLs
 * remain the source of truth: the caller's SDK discovery result is returned
 * directly. This module never enumerates, validates, opens, or stores paths.
 */
const INDEX_VERSION = 5;

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

/** Safe, non-capability metadata derived from an SDK discovery result. */
interface PersistedSession {
  sessionId: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
}

interface PersistedProjectIndex {
  refreshedAt: string;
  sessionCount: number;
  sessions: PersistedSession[];
}

interface PersistedIndex {
  version: number;
  projects: Record<string, PersistedProjectIndex>;
}

const projects = new Map<string, PersistedProjectIndex>();
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
    if (
      typeof project.refreshedAt !== "string" ||
      Number.isNaN(Date.parse(project.refreshedAt)) ||
      typeof project.sessionCount !== "number" ||
      !Number.isSafeInteger(project.sessionCount) ||
      project.sessionCount < 0 ||
      !Array.isArray(project.sessions)
    ) {
      continue;
    }
    const sessions = project.sessions.map(parseSession);
    if (
      sessions.some((session) => session === undefined) ||
      sessions.length !== project.sessionCount
    ) {
      continue;
    }
    projects[projectId] = {
      refreshedAt: project.refreshedAt,
      sessionCount: project.sessionCount,
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
    // Old formats contained path-like data and are intentionally ignored.
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

function rootRelativePath(root: string, candidate: string): string | undefined {
  const relativePath = relative(resolve(root), resolve(candidate));
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

/**
 * Conservatively reject a discovered candidate before caching its metadata when
 * its root-relative path contains a symlink. This does not repair the SDK's
 * path-opening behavior and never affects the current discovery result.
 */
async function isCacheablePath(sessionDir: string, candidate: string): Promise<boolean> {
  const relativePath = rootRelativePath(sessionDir, candidate);
  if (relativePath === undefined) return false;
  let current = resolve(sessionDir);
  for (const segment of relativePath.split(sep)) {
    current = `${current}${sep}${segment}`;
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function toPersisted(session: IndexedSession): PersistedSession {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt.toISOString(),
    modifiedAt: session.modifiedAt.toISOString(),
    messageCount: session.messageCount,
  };
}

async function rebuildProject(
  projectId: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  const generation = projectGeneration(projectId);
  return rebuildInflight(`${projectId}:${generation}`, async () => {
    // The SDK discovery pass is the only path enumeration and security
    // authority. Do not inspect its paths here; return its result unchanged.
    const sessions = await discover();
    if (generation !== projectGeneration(projectId)) return sessions;

    const cacheableSessions = (
      await Promise.all(
        sessions.map(async (session) =>
          (await isCacheablePath(sessionDir, session.path)) ? session : undefined,
        ),
      )
    ).filter((session): session is IndexedSession => session !== undefined);
    const cache: PersistedProjectIndex = {
      refreshedAt: new Date().toISOString(),
      sessionCount: cacheableSessions.length,
      sessions: cacheableSessions.map(toPersisted),
    };
    projects.set(projectId, cache);
    persisted.projects[projectId] = cache;
    await atomicWriteIndex();
    return sessions;
  });
}

/**
 * Discover sessions through the caller's SDK path and update only derived,
 * path-free metadata. Sequential reads intentionally never return cached paths.
 */
export async function getIndexedProjectSessions(
  projectId: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  await ensureLoaded();
  return rebuildProject(projectId, sessionDir, discover);
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
