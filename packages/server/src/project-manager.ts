import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

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

const PROJECTS_FILE = () => join(config.piConfigDir, "projects.json");

/** True iff `target` is the same path as `root` or strictly inside it. */
export function isInsideWorkspace(target: string, root: string = config.workspacePath): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(config.piConfigDir, { recursive: true });
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
    throw new Error("project name cannot be empty");
  }
  const resolvedPath = resolve(path);
  if (!isInsideWorkspace(resolvedPath)) {
    throw new PathOutsideWorkspaceError(resolvedPath);
  }
  const st = await stat(resolvedPath).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new NotADirectoryError(resolvedPath);
  }
  const projects = await readProjects();
  const project: Project = {
    id: randomUUID(),
    name: trimmedName,
    path: resolvedPath,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  await writeProjects(projects);
  return project;
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("project name cannot be empty");
  }
  const projects = await readProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new ProjectNotFoundError(id);
  const existing = projects[idx];
  if (existing === undefined) throw new ProjectNotFoundError(id);
  const updated: Project = { ...existing, name: trimmed };
  projects[idx] = updated;
  await writeProjects(projects);
  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  const projects = await readProjects();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) throw new ProjectNotFoundError(id);
  await writeProjects(next);
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

export async function browseDirectory(requested: string | undefined): Promise<{
  path: string;
  entries: BrowseEntry[];
}> {
  const target = resolve(requested ?? config.workspacePath);
  if (!isInsideWorkspace(target)) {
    throw new PathOutsideWorkspaceError(target);
  }
  const st = await stat(target).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new NotADirectoryError(target);
  }
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const childPath = join(target, ent.name);
    const gitStat = await stat(join(childPath, ".git")).catch(() => undefined);
    entries.push({
      name: ent.name,
      path: childPath,
      isGitRepo: gitStat !== undefined,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, entries };
}

export async function createDirectory(parentPath: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "..") {
    throw new Error("invalid directory name");
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
