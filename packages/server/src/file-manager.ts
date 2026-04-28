import {
  mkdir,
  readFile as fsReadFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  rmdir,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Filesystem operations bounded by a per-call project root.
 *
 * The route layer passes a `rootPath` (the project's absolute path) to each
 * function. Every public function resolves the input path and asserts it is
 * inside that root before touching disk; otherwise it throws
 * `PathOutsideRootError`. Routes catch that and return 403.
 *
 * This is the ONLY module that should call `fs.*` for filesystem
 * operations rooted in a project. Route handlers must not import `node:fs`
 * directly — every disk write/read goes through here so the path-traversal
 * checks can't be skipped.
 */

/* ----------------------------- errors ----------------------------- */

export class PathOutsideRootError extends Error {
  constructor(target: string, root: string) {
    super(`path outside project root: ${target} (root=${root})`);
    this.name = "PathOutsideRootError";
  }
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`not found: ${path}`);
    this.name = "NotFoundError";
  }
}

export class NotAFileError extends Error {
  constructor(path: string) {
    super(`not a file: ${path}`);
    this.name = "NotAFileError";
  }
}

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(path: string, size: number, limit: number) {
    super(`file too large: ${path} (${size} > ${limit})`);
    this.name = "FileTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

export class DirectoryNotEmptyError extends Error {
  constructor(path: string) {
    super(`directory not empty: ${path}`);
    this.name = "DirectoryNotEmptyError";
  }
}

export class InvalidNameError extends Error {
  constructor(message = "invalid file name") {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class TargetExistsError extends Error {
  constructor(path: string) {
    super(`target already exists: ${path}`);
    this.name = "TargetExistsError";
  }
}

/* ----------------------------- limits ----------------------------- */

/**
 * Hard cap on a single read. The editor would not give a useful experience
 * for anything larger, and the JSON encoding of a multi-MB file blows past
 * Fastify's default body limit on the round-trip back. Mirrors the
 * `CLAUDE.md` 5 MB ceiling.
 */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

/**
 * Directory names skipped by `getTree`. Same set as pi's session-discovery
 * + a few editor-specific ones. Hidden dotfiles below the root are NOT
 * skipped (a `.env` should still appear), but `.git` itself is — the
 * editor has no use for the object database, and walking it dwarfs every
 * other dir.
 */
const TREE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".nuxt",
  "coverage",
  ".vite",
  ".turbo",
  ".cache",
]);

const DEFAULT_TREE_DEPTH = 6;

/* ----------------------------- guards ----------------------------- */

/**
 * Resolve `target` and assert it is inside `root` (or equal to it). Returns
 * the resolved absolute path on success; throws PathOutsideRootError on a
 * traversal attempt. Use this on every entry point — never trust route
 * input. `relative()` returning a path that starts with `..` is the
 * canonical post-resolution traversal signal.
 *
 * NOTE: this is a LEXICAL check only (`resolve()` doesn't follow
 * symlinks). For ops that touch disk, prefer `resolveAndCheck` which
 * additionally `realpath`s the target so a symlink-out-of-root can't
 * sneak past.
 *
 * NUL bytes are rejected here too: `fs.*` APIs throw a non-Error.code
 * shape ("string contains null bytes") for paths containing `\0`,
 * which falls through `mapError` to a 500. We turn it into a 403
 * `path_not_allowed` instead so the wire shape matches every other
 * traversal attempt.
 */
export function assertInsideRoot(target: string, root: string): string {
  if (target.includes("\0")) throw new PathOutsideRootError(target, root);
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return resolvedTarget;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.length === 0 || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new PathOutsideRootError(target, root);
  }
  return resolvedTarget;
}

/**
 * Lexical-check + realpath-resolve `target`, ensuring the FINAL
 * (symlink-followed) path is still inside `root`. This is what
 * disk-touching ops should use — `assertInsideRoot` alone misses
 * symlinks (a symlink inside the project pointing OUT escapes the
 * lexical check).
 *
 * Handles both existing and not-yet-existing targets in one pass:
 * walks UP from the target until it finds a path that exists,
 * realpaths that ancestor, and verifies it's inside realpath(root).
 * If any ancestor along the way is a symlink that escapes, we catch
 * it. For non-existent leaf paths (creates), the caller still passes
 * the lexical absolute path to the eventual `fs.*` call — the safety
 * guarantee is on the parent chain, not the target itself.
 *
 * Returns the lexically-resolved absolute path on success, which is
 * what the caller passes to fs ops.
 *
 * TOCTOU: between this check and the eventual `fs.*` call, an attacker
 * could swap a real dir for a symlink. In a single-tenant model where
 * attacker = user, this is acceptable; the SDK ships under the same
 * threat model.
 */
async function verifyPathSafe(target: string, root: string): Promise<string> {
  // Lexical pre-check (cheap, fails fast — also handles NUL byte
  // rejection so fs.* doesn't throw a non-Error.code shape that
  // mapError would surface as a 500).
  assertInsideRoot(target, root);
  const realRoot = await realpath(root);
  const lexicalTarget = resolve(target);
  let cursor = lexicalTarget;
  while (true) {
    try {
      const real = await realpath(cursor);
      assertInsideRoot(real, realRoot);
      return lexicalTarget;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Walked up to filesystem root and every ancestor ENOENT'd.
        // Shouldn't happen in practice (root itself exists at startup
        // — index.ts mkdir's it).
        throw new PathOutsideRootError(target, root);
      }
      cursor = parent;
    }
  }
}

/**
 * File-name validation for create / rename targets. Rejects empty strings,
 * path separators (a "name" must be a single segment), and the `.` / `..`
 * special entries. Trailing whitespace is stripped, but interior spaces and
 * dots are allowed (e.g. ".env", "tsconfig.json", "my file.txt").
 */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new InvalidNameError();
  }
  return trimmed;
}

/* ----------------------------- tree ----------------------------- */

export interface TreeNode {
  name: string;
  /** Path RELATIVE to the project root (no leading slash). */
  path: string;
  type: "file" | "directory";
  /** Present on `directory` nodes only. */
  children?: TreeNode[];
  /** True when the node is a directory we declined to recurse into (depth cap or skip set). */
  truncated?: boolean;
}

export interface GetTreeOptions {
  maxDepth?: number;
}

export async function getTree(rootPath: string, opts: GetTreeOptions = {}): Promise<TreeNode> {
  const root = resolve(rootPath);
  // Verify root exists + is a directory; the caller already filtered by
  // project, so this is a sanity check, not a security check.
  const st = await stat(root).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new NotFoundError(root);
  }
  const maxDepth = opts.maxDepth ?? DEFAULT_TREE_DEPTH;
  return walk(root, root, "", 0, maxDepth);
}

async function walk(
  dir: string,
  root: string,
  relPath: string,
  depth: number,
  maxDepth: number,
): Promise<TreeNode> {
  const name = relPath === "" ? "" : (relPath.split(sep).pop() ?? "");
  const node: TreeNode = {
    name,
    path: relPath,
    type: "directory",
    children: [],
  };
  if (depth >= maxDepth) {
    node.truncated = true;
    delete node.children;
    return node;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // unreadable subtree — surface as truncated rather than throwing the
    // whole tree request away. The route still gets a useful response.
    node.truncated = true;
    delete node.children;
    return node;
  }
  // Sort: directories first, then files; within each, case-insensitive.
  entries.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const ent of entries) {
    if (ent.isDirectory() && TREE_SKIP_DIRS.has(ent.name)) continue;
    const childRel = relPath === "" ? ent.name : `${relPath}${sep}${ent.name}`;
    const childAbs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walk(childAbs, root, childRel, depth + 1, maxDepth);
      node.children?.push(sub);
    } else if (ent.isFile()) {
      node.children?.push({
        name: ent.name,
        path: childRel,
        type: "file",
      });
    }
    // Symlinks, sockets, fifos: skip silently. We don't follow symlinks —
    // that's how a malicious project would escape its own root via a
    // symlink to /etc.
  }
  return node;
}

/* ----------------------------- read ----------------------------- */

export interface ReadResult {
  path: string;
  /** Decoded UTF-8 content. */
  content: string;
  size: number;
  language: string;
  /** True when the file was read but identified as binary (content blank). */
  binary: boolean;
}

export async function readFile(absPath: string, root: string): Promise<ReadResult> {
  const resolved = await verifyPathSafe(absPath, root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (!st.isFile()) throw new NotAFileError(resolved);
  if (st.size > MAX_READ_BYTES) throw new FileTooLargeError(resolved, st.size, MAX_READ_BYTES);
  const buf = await fsReadFile(resolved);
  const binary = looksBinary(buf);
  return {
    path: resolved,
    content: binary ? "" : buf.toString("utf8"),
    size: st.size,
    language: detectLanguage(resolved),
    binary,
  };
}

/**
 * NUL-byte heuristic for binary detection — same approach git uses. Avoids
 * trying to UTF-8-decode (and corrupt) images, archives, and compiled
 * binaries that the editor can't render anyway.
 */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/* ----------------------------- write ----------------------------- */

export async function writeFile(absPath: string, root: string, content: string): Promise<void> {
  const resolved = await verifyPathSafe(absPath, root);
  // Recursively mkdir the parent so writes to a brand-new nested path
  // succeed (`/foo/bar/baz.ts` works even if `/foo/bar` doesn't exist).
  // Safe AFTER verifyPathSafe: the deepest existing ancestor was
  // proven inside `root`, so any dirs we create are under it.
  await mkdir(dirname(resolved), { recursive: true });
  // Atomic-ish write. tmp + rename keeps a partially-written file from
  // ever existing under the target name; same pattern config-manager and
  // project-manager use.
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  await fsWriteFile(tmp, content, "utf8");
  await fsRename(tmp, resolved);
}

/* ----------------------------- mkdir ----------------------------- */

export async function makeDirectory(
  parentAbsPath: string,
  root: string,
  name: string,
): Promise<string> {
  const trimmed = validateName(name);
  const parent = await verifyPathSafe(parentAbsPath, root);
  const target = await verifyPathSafe(join(parent, trimmed), root);
  // recursive:false — surface "already exists" as a real conflict so the
  // UI can prompt the user instead of silently no-op'ing.
  const exists = await stat(target).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(target);
  await mkdir(target, { recursive: false });
  return target;
}

/* ----------------------------- rename / move ----------------------------- */

export async function renameEntry(absPath: string, root: string, newName: string): Promise<string> {
  const resolved = await verifyPathSafe(absPath, root);
  const trimmed = validateName(newName);
  const target = await verifyPathSafe(join(dirname(resolved), trimmed), root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (resolved === target) return target;
  const exists = await stat(target).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(target);
  await fsRename(resolved, target);
  return target;
}

export async function moveEntry(
  srcAbsPath: string,
  destAbsPath: string,
  root: string,
): Promise<string> {
  const src = await verifyPathSafe(srcAbsPath, root);
  const dest = await verifyPathSafe(destAbsPath, root);
  const st = await stat(src).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(src);
  // Forbid moving a directory under itself — a classic foot-gun.
  if (st.isDirectory()) {
    const rel = relative(src, dest);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`))) {
      throw new InvalidNameError("cannot move a directory into itself");
    }
  }
  const exists = await stat(dest).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(dest);
  await mkdir(dirname(dest), { recursive: true });
  await fsRename(src, dest);
  return dest;
}

/* ----------------------------- delete ----------------------------- */

export async function deleteEntry(absPath: string, root: string): Promise<void> {
  const resolved = await verifyPathSafe(absPath, root);
  // Defense in depth: never let a delete reach the project root itself
  // even if it slips past assertInsideRoot's "equal-to-root" allowance.
  if (resolved === resolve(root)) {
    throw new PathOutsideRootError(absPath, root);
  }
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (st.isDirectory()) {
    // We don't recursively force-delete. Empty-dir delete is fine; non-empty
    // surfaces a clear error so the UI can ask the user to clean up first.
    // The dev plan explicitly calls this out as a deliberate non-feature.
    try {
      await rmdir(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        throw new DirectoryNotEmptyError(resolved);
      }
      throw err;
    }
  } else {
    await rm(resolved, { force: false });
  }
}

/* ----------------------------- language detection ----------------------------- */

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".go": "go",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".swift": "swift",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".dockerfile": "dockerfile",
};

function detectLanguage(absPath: string): string {
  const base = absPath.split(sep).pop() ?? absPath;
  if (base === "Dockerfile" || base.endsWith(".Dockerfile")) return "dockerfile";
  if (base === "Makefile") return "makefile";
  const ext = extname(base).toLowerCase();
  return LANG_BY_EXT[ext] ?? "plaintext";
}
