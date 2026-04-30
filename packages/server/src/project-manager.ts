import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * Project ids are always `randomUUID()` output. Mirrors the same
 * regex used in session-registry's `sessionDirFor()` validator.
 * Codified here too because the cascade rm path builds a
 * filesystem destination from the id and should reject anything
 * that could escape `${SESSION_DIR}`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One-time migration of the legacy `projects.json` location. Up through the
 * Phase-9 wrap-up, pi-workbench wrote its project registry into
 * `${PI_CONFIG_DIR}/projects.json` (mixing our state into the pi SDK's
 * config dir). We now own a dedicated dir; if a user is upgrading and
 * already has the legacy file, move it on first read so they don't lose
 * their projects. Idempotent: only fires when the new path is missing
 * AND the legacy path exists.
 */
let legacyMigrationDone = false;
let migrationInflight: Promise<void> | undefined;
async function migrateLegacyProjectsFile(): Promise<void> {
  if (legacyMigrationDone) return;
  // In-flight dedupe: two concurrent first-reads (e.g. /projects and
  // /sessions firing at boot before either has populated the boolean
  // flag) would otherwise both stat the legacy path, both attempt
  // mkdir + rename, and the second's rename(legacy, target) fails
  // with ENOENT because the legacy file is already gone — bubbling
  // up as a 500 to one of the two requests.
  if (migrationInflight !== undefined) return migrationInflight;
  migrationInflight = (async () => {
    if (config.workbenchDataDir === config.piConfigDir) {
      legacyMigrationDone = true;
      return;
    }
    const legacy = join(config.piConfigDir, "projects.json");
    const target = join(config.workbenchDataDir, "projects.json");
    const [legacyStat, targetStat] = await Promise.all([
      stat(legacy).catch(() => undefined),
      stat(target).catch(() => undefined),
    ]);
    if (legacyStat === undefined || targetStat !== undefined) {
      // Either no legacy file to migrate, or the new path already has
      // one. Mark done so subsequent reads skip the stat pair.
      legacyMigrationDone = true;
      return;
    }
    // Only mark done once the rename actually succeeds — if mkdir or
    // rename throws (cross-filesystem move, permissions), the next
    // readProjects() will retry rather than silently giving up.
    await mkdir(config.workbenchDataDir, { recursive: true });
    try {
      await rename(legacy, target);
    } catch (err) {
      // ENOENT here means a concurrent first-read already migrated
      // and the legacy file is gone — re-stat the target to confirm
      // and treat as success.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const targetNow = await stat(target).catch(() => undefined);
        if (targetNow !== undefined) {
          legacyMigrationDone = true;
          return;
        }
      }
      throw err;
    }
    legacyMigrationDone = true;
  })().finally(() => {
    migrationInflight = undefined;
  });
  return migrationInflight;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export class PathOutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`path outside workspace: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

export class NotADirectoryError extends Error {
  constructor(path: string) {
    super(`not a directory: ${path}`);
    this.name = "NotADirectoryError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class InvalidNameError extends Error {
  constructor(message = "invalid name") {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class InvalidDirectoryNameError extends Error {
  constructor(message = "invalid directory name") {
    super(message);
    this.name = "InvalidDirectoryNameError";
  }
}

export class DuplicatePathError extends Error {
  constructor(path: string) {
    super(`a project already points at: ${path}`);
    this.name = "DuplicatePathError";
  }
}

const PROJECTS_FILE = (): string => join(config.workbenchDataDir, "projects.json");

/** True iff `target` is the same path as `root` or strictly inside it. */
export function isInsideWorkspace(target: string, root: string = config.workspacePath): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

async function ensureConfigDir(): Promise<void> {
  await migrateLegacyProjectsFile();
  await mkdir(config.workbenchDataDir, { recursive: true });
}

/**
 * Run `fn` over each item with at most `limit` in flight at once. Order of
 * results matches the input order, including `undefined` inputs (the fn is
 * still invoked — the helper does not silently skip holes).
 *
 * Errors propagate via `Promise.all`: the first rejecting worker fails the
 * whole call. Wrap `fn` in your own try/catch if you need partial results.
 */
async function mapBounded<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Serialise all read-modify-write sequences over projects.json. Without this,
 * two concurrent POST /projects requests can read the same baseline and race
 * the rename(), losing one write. Single-process / single-tenant only — there
 * is no file lock; we don't need cross-process safety.
 */
let projectsLock: Promise<unknown> = Promise.resolve();
function withProjectsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = projectsLock.then(fn, fn);
  // Keep the chain alive but don't propagate failures into subsequent waiters.
  projectsLock = next.catch(() => undefined);
  return next;
}

export async function readProjects(): Promise<Project[]> {
  await ensureConfigDir();
  try {
    const raw = await readFile(PROJECTS_FILE(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProject);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function isProject(v: unknown): v is Project {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.path === "string" &&
    typeof r.createdAt === "string"
  );
}

async function writeProjects(projects: Project[]): Promise<void> {
  await ensureConfigDir();
  const target = PROJECTS_FILE();
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(projects, null, 2), "utf8");
  await rename(tmp, target);
}

export async function createProject(name: string, path: string): Promise<Project> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new InvalidNameError("project name cannot be empty");
  }
  const resolvedPath = resolve(path);
  if (!isInsideWorkspace(resolvedPath)) {
    throw new PathOutsideWorkspaceError(resolvedPath);
  }
  const st = await stat(resolvedPath).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new NotADirectoryError(resolvedPath);
  }
  return withProjectsLock(async () => {
    const projects = await readProjects();
    if (projects.some((p) => p.path === resolvedPath)) {
      throw new DuplicatePathError(resolvedPath);
    }
    const project: Project = {
      id: randomUUID(),
      name: trimmedName,
      path: resolvedPath,
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    await writeProjects(projects);
    return project;
  });
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new InvalidNameError("project name cannot be empty");
  }
  return withProjectsLock(async () => {
    const projects = await readProjects();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) throw new ProjectNotFoundError(id);
    const existing = projects[idx];
    if (existing === undefined) throw new ProjectNotFoundError(id);
    const updated: Project = { ...existing, name: trimmed };
    projects[idx] = updated;
    await writeProjects(projects);
    return updated;
  });
}

export async function deleteProject(
  id: string,
  opts: { cascadeSessionDir?: boolean } = {},
): Promise<{ cascaded: boolean }> {
  let cascaded = false;
  await withProjectsLock(async () => {
    const projects = await readProjects();
    const next = projects.filter((p) => p.id !== id);
    if (next.length === projects.length) throw new ProjectNotFoundError(id);
    await writeProjects(next);
  });
  if (opts.cascadeSessionDir === true) {
    // Wipe the project's session directory. Best-effort — a missing
    // dir (no sessions ever recorded) is not an error.
    //
    // SAFETY: validate the id is UUID-shaped (the only shape
    // `createProject()` ever produces) BEFORE building the path.
    // `rm({ recursive: true, force: true })` is destructive enough
    // that any path-traversal in `id` would be catastrophic — a
    // hypothetical `id === ".."` would resolve to the parent of
    // `${SESSION_DIR}` and wipe it. Today the only id source is
    // `randomUUID()`, but the validator codifies that invariant
    // against any future code path that imports/restores ids from
    // the wire or a manually-edited projects.json.
    if (!UUID_RE.test(id)) {
      // Should be unreachable — the project record we just deleted
      // had this id, so it passed creation-time validation. Log and
      // skip the cascade rather than rm something dangerous.
      console.warn(`[project-manager] refusing cascade rm for non-UUID id ${JSON.stringify(id)}`);
      return { cascaded };
    }
    const dir = join(config.sessionDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
      cascaded = true;
    } catch (err) {
      // Don't fail the delete itself if cascade cleanup fails — the
      // project record is gone, the session files are just orphaned
      // (the same state that exists when cascade isn't requested).
      // But DO log so a permissions issue isn't silently invisible.
      console.warn(`[project-manager] cascade rm failed for ${dir}:`, err);
    }
  }
  return { cascaded };
}

export async function getProject(id: string): Promise<Project | undefined> {
  const projects = await readProjects();
  return projects.find((p) => p.id === id);
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** Resolved parent path. `undefined` when `path` is the workspace root. */
  parentPath: string | undefined;
  entries: BrowseEntry[];
}

export async function browseDirectory(requested: string | undefined): Promise<BrowseResult> {
  const target = resolve(requested ?? config.workspacePath);
  if (!isInsideWorkspace(target)) {
    throw new PathOutsideWorkspaceError(target);
  }
  const st = await stat(target).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new NotADirectoryError(target);
  }
  const dirents = await readdir(target, { withFileTypes: true });
  const dirEntries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith("."));
  // Stat .git children with a bounded concurrency cap — unbounded Promise.all
  // could exhaust the libuv FD pool on a node_modules-shaped tree (closes the
  // Phase-10 deferred item). 16 concurrent stats is plenty for any realistic
  // workspace and well below the default ulimit on macOS/Linux.
  const entries: BrowseEntry[] = await mapBounded(dirEntries, 16, async (ent) => {
    const childPath = join(target, ent.name);
    const gitStat = await stat(join(childPath, ".git")).catch(() => undefined);
    return { name: ent.name, path: childPath, isGitRepo: gitStat !== undefined };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const resolvedRoot = resolve(config.workspacePath);
  const parentPath = target === resolvedRoot ? undefined : dirname(target);
  return { path: target, parentPath, entries };
}

export async function createDirectory(parentPath: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "..") {
    throw new InvalidDirectoryNameError();
  }
  const parent = resolve(parentPath);
  if (!isInsideWorkspace(parent)) {
    throw new PathOutsideWorkspaceError(parent);
  }
  const target = join(parent, trimmed);
  if (!isInsideWorkspace(target)) {
    throw new PathOutsideWorkspaceError(target);
  }
  await mkdir(target, { recursive: false });
  return target;
}
