import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { makeDedupe, makeLock } from "./concurrency.js";

/**
 * Persistent, best-effort cache for session discovery. JSONL files remain the
 * source of truth: a missing, malformed, stale, or unwritable index simply
 * causes the caller-supplied disk discovery function to run again.
 */
const INDEX_VERSION = 2;
const RECONCILE_INTERVAL_MS = 30_000;

export interface IndexedSession {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt: Date;
  modifiedAt: Date;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  runId?: string;
  isExternalLive?: boolean;
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
}

interface PersistedSession {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  parentSessionId?: string;
  runId?: string;
  isExternalLive?: boolean;
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
}

interface PersistedProjectIndex {
  workspacePath: string;
  sessions: PersistedSession[];
  /** File and directory metadata used to validate a persisted cache on restart. */
  footprint: Record<string, string>;
}

interface PersistedIndex {
  version: number;
  projects: Record<string, PersistedProjectIndex>;
}

interface ProjectCache {
  workspacePath: string;
  sessionDir: string;
  sessions: IndexedSession[];
  dirty: boolean;
  lastReconciledAt: number;
  footprint: Map<string, string>;
  watchers: FSWatcher[];
  /** Persisted records omit previews, so the first sidebar read rebuilds them. */
  needsPreviewHydration: boolean;
}

const projects = new Map<string, ProjectCache>();
let persisted: PersistedIndex = { version: INDEX_VERSION, projects: {} };
let loaded = false;
const writeLock = makeLock();
const rebuildInflight = makeDedupe<string, IndexedSession[]>();

function indexPath(): string {
  return `${config.forgeDataDir}/session-index.json`;
}

function isExternalState(value: unknown): value is NonNullable<IndexedSession["externalState"]> {
  return (
    value === "queued" ||
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "paused"
  );
}

function parseSession(value: unknown): PersistedSession | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const s = value as Record<string, unknown>;
  if (
    typeof s.sessionId !== "string" ||
    typeof s.path !== "string" ||
    typeof s.cwd !== "string" ||
    typeof s.createdAt !== "string" ||
    typeof s.modifiedAt !== "string" ||
    typeof s.messageCount !== "number" ||
    !Number.isFinite(s.messageCount) ||
    Number.isNaN(Date.parse(s.createdAt)) ||
    Number.isNaN(Date.parse(s.modifiedAt))
  ) {
    return undefined;
  }
  if (
    (s.name !== undefined && typeof s.name !== "string") ||
    (s.parentSessionId !== undefined && typeof s.parentSessionId !== "string") ||
    (s.runId !== undefined && typeof s.runId !== "string") ||
    (s.isExternalLive !== undefined && typeof s.isExternalLive !== "boolean") ||
    (s.externalState !== undefined && !isExternalState(s.externalState))
  ) {
    return undefined;
  }
  return s as unknown as PersistedSession;
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
  const validProjects: Record<string, PersistedProjectIndex> = {};
  for (const [projectId, rawProject] of Object.entries(parsed.projects)) {
    if (typeof rawProject !== "object" || rawProject === null) continue;
    const project = rawProject as Record<string, unknown>;
    if (
      typeof project.workspacePath !== "string" ||
      !Array.isArray(project.sessions) ||
      typeof project.footprint !== "object" ||
      project.footprint === null
    ) {
      continue;
    }
    const sessions = project.sessions.map(parseSession);
    const footprint = Object.entries(project.footprint as Record<string, unknown>);
    if (
      sessions.some((session) => session === undefined) ||
      footprint.some(([path, value]) => typeof path !== "string" || typeof value !== "string")
    ) {
      continue;
    }
    validProjects[projectId] = {
      workspacePath: project.workspacePath,
      sessions: sessions as PersistedSession[],
      footprint: Object.fromEntries(footprint) as Record<string, string>,
    };
  }
  return { version: INDEX_VERSION, projects: validProjects };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(indexPath(), "utf8");
    const parsed = parseIndex(JSON.parse(raw));
    // A malformed or old index is deliberately ignored. The next project
    // lookup rebuilds its entry from JSONL and atomically replaces this file.
    if (parsed !== undefined) persisted = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `${JSON.stringify({ level: "warn", msg: "session-index: ignoring unreadable index" })}\n`,
      );
    }
  }
}

function fromPersisted(session: PersistedSession): IndexedSession {
  return {
    ...session,
    // Conversation previews remain exclusively in the source JSONLs, not in
    // this metadata cache. A validated warm cache therefore never persists
    // user/assistant content under FORGE_DATA_DIR.
    firstMessage: "",
    createdAt: new Date(session.createdAt),
    modifiedAt: new Date(session.modifiedAt),
  };
}

function toPersisted(session: IndexedSession): PersistedSession {
  const { firstMessage: _firstMessage, ...safe } = session;
  return {
    ...safe,
    createdAt: session.createdAt.toISOString(),
    modifiedAt: session.modifiedAt.toISOString(),
  };
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
      // The in-memory cache is still usable and JSONLs remain authoritative.
      process.stderr.write(
        `${JSON.stringify({ level: "warn", msg: "session-index: failed to persist index", error: err instanceof Error ? err.message : String(err) })}\n`,
      );
    }
  });
}

function isInsideSessionDir(sessionDir: string, path: string): boolean {
  const root = resolve(sessionDir);
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function pathsToWatch(sessionDir: string, sessions: readonly IndexedSession[]): string[] {
  const root = resolve(sessionDir);
  const paths = new Set<string>([root]);
  for (const session of sessions) {
    let current = resolve(dirname(session.path));
    while (
      current === root ||
      (relative(root, current) !== "" && !relative(root, current).startsWith(".."))
    ) {
      paths.add(current);
      if (current === root) break;
      current = dirname(current);
    }
  }
  return [...paths];
}

async function fingerprint(paths: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        result.set(path, `${info.isDirectory() ? "d" : "f"}:${info.size}:${info.mtimeMs}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") result.set(path, "missing");
        else result.set(path, "unreadable");
      }
    }),
  );
  return result;
}

function installWatchers(cache: ProjectCache): void {
  for (const watcher of cache.watchers) watcher.close();
  cache.watchers = [];
  for (const path of pathsToWatch(cache.sessionDir, cache.sessions)) {
    try {
      const watcher = watch(path, { persistent: false }, () => {
        cache.dirty = true;
      });
      watcher.on("error", () => {
        cache.dirty = true;
      });
      cache.watchers.push(watcher);
    } catch {
      // A missing or inaccessible directory is reconciled conservatively.
      cache.dirty = true;
    }
  }
}

async function reconcile(cache: ProjectCache): Promise<void> {
  if (Date.now() - cache.lastReconciledAt < RECONCILE_INTERVAL_MS) return;
  cache.lastReconciledAt = Date.now();
  const next = await fingerprint([...cache.footprint.keys()]);
  if (next.size !== cache.footprint.size) {
    cache.dirty = true;
    return;
  }
  for (const [path, value] of cache.footprint) {
    if (next.get(path) !== value) {
      cache.dirty = true;
      return;
    }
  }
}

async function cacheProject(
  projectId: string,
  workspacePath: string,
  sessionDir: string,
): Promise<ProjectCache | undefined> {
  await ensureLoaded();
  const current = projects.get(projectId);
  if (
    current !== undefined &&
    current.workspacePath === workspacePath &&
    current.sessionDir === sessionDir
  ) {
    return current;
  }
  if (current !== undefined) {
    for (const watcher of current.watchers) watcher.close();
    projects.delete(projectId);
  }
  const stored = persisted.projects[projectId];
  if (stored === undefined || stored.workspacePath !== workspacePath) return undefined;
  // Do not trust a manually edited/corrupted cache to make us stat or return
  // paths outside this project's session root. The rebuild scanner remains the
  // sole authority for paths that enter the cache.
  if (stored.sessions.some((session) => !isInsideSessionDir(sessionDir, session.path))) {
    delete persisted.projects[projectId];
    return undefined;
  }
  const sessions = stored.sessions.map(fromPersisted);
  const storedFootprint = new Map(Object.entries(stored.footprint));
  const currentFootprint = await fingerprint([...storedFootprint.keys()]);
  if (
    currentFootprint.size !== storedFootprint.size ||
    [...storedFootprint].some(([path, value]) => currentFootprint.get(path) !== value)
  ) {
    // The disk changed while this process was stopped. Rebuild before serving
    // so deleted or externally-created child sessions are never ghosted.
    return undefined;
  }
  const cache: ProjectCache = {
    workspacePath,
    sessionDir,
    sessions,
    dirty: false,
    lastReconciledAt: Date.now(),
    footprint: currentFootprint,
    watchers: [],
    needsPreviewHydration: true,
  };
  installWatchers(cache);
  projects.set(projectId, cache);
  return cache;
}

async function rebuildProject(
  projectId: string,
  workspacePath: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  return rebuildInflight(projectId, async () => {
    const sessions = await discover();
    const cache: ProjectCache = {
      workspacePath,
      sessionDir,
      sessions,
      dirty: false,
      lastReconciledAt: Date.now(),
      footprint: await fingerprint([
        ...pathsToWatch(sessionDir, sessions),
        ...sessions.map((session) => session.path),
      ]),
      watchers: [],
      needsPreviewHydration: false,
    };
    const previous = projects.get(projectId);
    if (previous !== undefined) {
      for (const watcher of previous.watchers) watcher.close();
    }
    projects.set(projectId, cache);
    installWatchers(cache);
    persisted.projects[projectId] = {
      workspacePath,
      sessions: sessions.map(toPersisted),
      footprint: Object.fromEntries(cache.footprint),
    };
    await atomicWriteIndex();
    return sessions;
  });
}

/** Return the cached project list or rebuild it from the caller's JSONL scanner. */
export async function getIndexedProjectSessions(
  projectId: string,
  workspacePath: string,
  sessionDir: string,
  discover: () => Promise<IndexedSession[]>,
): Promise<IndexedSession[]> {
  const cache = await cacheProject(projectId, workspacePath, sessionDir);
  if (cache !== undefined) {
    await reconcile(cache);
    if (!cache.dirty && !cache.needsPreviewHydration) return cache.sessions;
  }
  return rebuildProject(projectId, workspacePath, sessionDir, discover);
}

/** Mark one project's entry stale after a known session filesystem mutation. */
export function invalidateSessionIndex(projectId: string): void {
  const cache = projects.get(projectId);
  if (cache !== undefined) cache.dirty = true;
}
