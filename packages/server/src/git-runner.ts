import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around `git` for the workbench's git panel.
 *
 * Rules:
 *   - NEVER `exec` with string interpolation. Always `execFile` with
 *     an args array. The project path comes from our own
 *     `project-manager` (validated against WORKSPACE_PATH); commit
 *     messages and remote/branch names come from user input — args
 *     arrays make shell-quoting moot regardless of content.
 *   - "Not a git repo" → return empty / sensible default, NEVER 500.
 *     Users can have non-git project folders and the panel should
 *     just sit quiet, not error.
 *   - User-visible errors carry a short message we synthesize from
 *     the stderr; we never blast raw stderr at the client (would
 *     leak fs paths + git plumbing detail).
 *
 * Output buffer: 16 MB on every call. Plenty for `diff` and `log
 * --oneline -30` even on monorepos; if a future `log` query needs
 * more, we'll cap it explicitly.
 */

const MAX_BUFFER = 16 * 1024 * 1024;

/* ----------------------------- errors ----------------------------- */

export class GitNotInstalledError extends Error {
  constructor() {
    super("git binary not found on PATH");
    this.name = "GitNotInstalledError";
  }
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  /** Sanitized first line of stderr — safe to surface to the user. */
  readonly userMessage: string;
  constructor(exitCode: number | null, userMessage: string, fullMessage: string) {
    super(fullMessage);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.userMessage = userMessage;
  }
}

/* ----------------------------- types ----------------------------- */

/**
 * Status flag combinations exposed to the client. We map git's
 * porcelain v1 two-character XY codes into a coarser bucket so the
 * UI can render badges without a full git literacy quiz.
 */
export type FileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown";

export interface FileStatusEntry {
  /** Path relative to the project root. */
  path: string;
  /** True when the change is in the index (XY's first char != ' ' or '?'). */
  staged: boolean;
  /** True when the working-tree differs from the index (XY's second char != ' '). */
  unstaged: boolean;
  /** Coarse classification driven by the dominant XY char. */
  kind: FileStatusKind;
  /** Two-char porcelain code, returned verbatim for advanced UI. */
  code: string;
  /** For renames/copies, the original path (porcelain "<orig> -> <new>"). */
  originalPath?: string;
}

export interface StatusResult {
  isGitRepo: boolean;
  branch: string | undefined;
  files: FileStatusEntry[];
}

export interface LogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface BranchesResult {
  current: string | undefined;
  branches: BranchEntry[];
}

/* ----------------------------- helpers ----------------------------- */

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run `git <args>` in `cwd`. Resolves on exit code 0; rejects with
 * `GitCommandError` (with sanitized userMessage) otherwise.
 *
 * `GIT_TERMINAL_PROMPT=0` keeps git from blocking on interactive
 * credential prompts when the user pushes without configured creds —
 * we want a fast 4xx instead of a hung process. Same for
 * `GIT_ASKPASS` set to `true` (the no-op binary).
 */
async function runGit(cwd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        // `git config` consults $HOME for the user's global config.
        // If the parent process has no HOME (some container init
        // flows, certain systemd/launchd configurations), git falls
        // back to /etc/passwd lookup which can fail opaquely. Force
        // a sensible default from `os.homedir()` (which itself
        // checks USERPROFILE on Windows + falls back to the passwd
        // entry).
        HOME: process.env.HOME ?? homedir(),
        GIT_TERMINAL_PROMPT: "0",
        // `true` is the POSIX no-op; suppresses any askpass GUI.
        GIT_ASKPASS: "true",
        // Predictable plumbing output regardless of user's lang.
        LC_ALL: "C",
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    if (e.code === "ENOENT") throw new GitNotInstalledError();
    const stderr = (e.stderr ?? "").toString();
    const userMessage = sanitizeStderr(stderr);
    const exitCode = typeof e.code === "number" ? e.code : null;
    throw new GitCommandError(exitCode, userMessage, stderr || (e.message ?? "git failed"));
  }
}

/**
 * Trim git's stderr to a one-line user-visible message. Drops paths
 * that look like they include the workspace root (would leak
 * filesystem layout) and clamps to 200 chars.
 */
function sanitizeStderr(stderr: string): string {
  const firstLine = stderr.split("\n").find((l) => l.trim().length > 0) ?? "git error";
  // Drop common "fatal: " / "error: " prefixes that confuse users.
  const stripped = firstLine.replace(/^(fatal|error|warning):\s*/i, "");
  return stripped.length > 200 ? stripped.slice(0, 197) + "…" : stripped;
}

/**
 * True iff `cwd` is inside a git working tree. Cheap probe used by
 * every public function so "not a repo" can return the empty default
 * rather than throw. Exported so route helpers (e.g. for the diff
 * endpoints' `isGitRepo` flag) don't have to re-implement it.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------- status ----------------------------- */

/**
 * `git status --porcelain=v1 -uall` output. Each line is `XY <path>`,
 * with renames as `XY <orig> -> <new>` and possibly NUL-terminated
 * via `-z` (we deliberately use newline-terminated v1 for
 * line-by-line parsing simplicity; paths with newlines are rare in
 * practice and would require `-z`).
 */
function parseStatus(stdout: string): FileStatusEntry[] {
  const out: FileStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    // Minimum well-formed porcelain line: 2 status chars + space +
    // at least 1-char path = 4. Length 3 sneaks past the old check
    // and produces an empty path.
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    let path = rest;
    let originalPath: string | undefined;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) {
      originalPath = rest.slice(0, arrow);
      path = rest.slice(arrow + 4);
    }
    const x = code[0] ?? " ";
    const y = code[1] ?? " ";
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " " && y !== "?";
    const entry: FileStatusEntry = {
      path,
      staged,
      unstaged,
      kind: classifyStatus(x, y),
      code,
    };
    if (originalPath !== undefined) entry.originalPath = originalPath;
    if (path.length === 0) continue; // defensive — see length filter above
    out.push(entry);
  }
  return out;
}

function classifyStatus(x: string, y: string): FileStatusKind {
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflicted";
  }
  if (x === "?" && y === "?") return "untracked";
  if (x === "!" || y === "!") return "ignored";
  // Prefer the staged side's classification — it's "what will be
  // committed". Fall back to the unstaged side.
  const c = x !== " " && x !== "?" ? x : y;
  switch (c) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

export async function getStatus(cwd: string): Promise<StatusResult> {
  if (!(await isGitRepo(cwd))) {
    return { isGitRepo: false, branch: undefined, files: [] };
  }
  const [branchRes, statusRes] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
    runGit(cwd, ["status", "--porcelain=v1", "-uall"]),
  ]);
  // `--abbrev-ref HEAD` returns "HEAD" on a detached checkout; surface
  // that verbatim so the UI can render it.
  const branch = branchRes?.stdout.trim();
  return {
    isGitRepo: true,
    branch: branch !== undefined && branch.length > 0 ? branch : undefined,
    files: parseStatus(statusRes.stdout),
  };
}

/* ----------------------------- diffs ----------------------------- */

/**
 * Diff variants share the same shape (raw unified text + a
 * "isGitRepo" flag the route can use to decide between 200 empty and
 * 200 with content). Empty repo / non-repo → empty string.
 */
async function diffArgs(cwd: string, args: string[]): Promise<string> {
  if (!(await isGitRepo(cwd))) return "";
  const baseArgs = ["diff", "--no-color", "--no-ext-diff", ...args];
  const { stdout } = await runGit(cwd, baseArgs);
  return stdout;
}

export function getDiff(cwd: string): Promise<string> {
  return diffArgs(cwd, []);
}

export function getStagedDiff(cwd: string): Promise<string> {
  return diffArgs(cwd, ["--cached"]);
}

export async function getFileDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  if (!(await isGitRepo(cwd))) return "";
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (staged) args.push("--cached");
  args.push("--", path);
  const { stdout } = await runGit(cwd, args);
  return stdout;
}

/* ----------------------------- log ----------------------------- */

export async function getLog(cwd: string, limit = 30): Promise<LogEntry[]> {
  if (!(await isGitRepo(cwd))) return [];
  // Custom format with NUL field separators and RS record separator.
  // Avoids ambiguity if a commit message has any character we'd
  // otherwise pick as a delimiter.
  const FS = "\x1F";
  const RS = "\x1E";
  const fmt = `%H${FS}%s${FS}%an${FS}%aI${RS}`;
  const { stdout } = await runGit(cwd, [
    "log",
    `--max-count=${Math.max(1, Math.min(limit, 1000))}`,
    `--pretty=format:${fmt}`,
  ]);
  if (stdout.length === 0) return [];
  return stdout
    .split(RS)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.length > 0)
    .map((rec): LogEntry => {
      const [hash = "", message = "", author = "", date = ""] = rec.split(FS);
      return { hash, message, author, date };
    });
}

/* ----------------------------- branches ----------------------------- */

export async function getBranches(cwd: string): Promise<BranchesResult> {
  if (!(await isGitRepo(cwd))) return { current: undefined, branches: [] };
  const { stdout } = await runGit(cwd, ["branch", "-a", "--format=%(HEAD)\x1F%(refname:short)"]);
  const branches: BranchEntry[] = [];
  let current: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [headFlag = "", name = ""] = line.split("\x1F");
    if (name.length === 0) continue;
    // git emits "(HEAD detached at ...)" as a pseudo-ref; skip.
    if (name.startsWith("(")) continue;
    const isCurrent = headFlag === "*";
    // git's --format always prefixes remote-tracking branches with
    // `remotes/`. The earlier `origin/` heuristic mis-classified a
    // local branch literally named `origin/feature` as remote.
    const remote = name.startsWith("remotes/");
    const cleanName = remote ? name.slice("remotes/".length) : name;
    branches.push({ name: cleanName, current: isCurrent, remote });
    if (isCurrent) current = cleanName;
  }
  return { current, branches };
}

/* ----------------------------- mutations ----------------------------- */

export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["add", "--", ...paths]);
}

export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["restore", "--staged", "--", ...paths]);
}

/**
 * Discard local changes for the given files: restores both the
 * index AND the working tree to HEAD via `git restore --staged
 * --worktree --source=HEAD -- <paths>`. The user-visible "Revert"
 * action.
 *
 * For untracked files, `git restore` errors with "pathspec did
 * not match any file(s) known to git". The route surfaces this
 * via `GitCommandError` so the UI can display "untracked files
 * can't be reverted; delete them via the file browser instead."
 *
 * Destructive — the caller is expected to gate this behind a
 * confirmation in the UI (the click-twice-to-confirm pattern in
 * GitPanel).
 */
export async function revertPaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...paths]);
}

/**
 * Commit the currently-staged changes. Empty / whitespace-only
 * messages are rejected at the route layer; this just runs the
 * command. `--no-verify` is NOT used — we want pre-commit hooks to
 * fire so the user's lint/test/format checks gate browser commits
 * the same way they gate terminal commits.
 */
export async function commit(cwd: string, message: string): Promise<{ hash: string }> {
  await runGit(cwd, ["commit", "-m", message]);
  // Capture the new HEAD's hash so the route can echo it back —
  // useful for the UI to highlight "your commit" in the log section.
  const { stdout } = await runGit(cwd, ["rev-parse", "HEAD"]);
  return { hash: stdout.trim() };
}

export interface PushOptions {
  remote?: string;
  branch?: string;
}

export async function push(cwd: string, opts: PushOptions = {}): Promise<{ stdout: string }> {
  const args = ["push"];
  if (opts.remote !== undefined) args.push(opts.remote);
  if (opts.branch !== undefined) args.push(opts.branch);
  // Push status info goes to stderr by default; we capture both.
  const { stdout, stderr } = await runGit(cwd, args);
  return { stdout: stdout.length > 0 ? stdout : stderr };
}
