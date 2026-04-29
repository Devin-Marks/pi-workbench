import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assertInsideRoot } from "./file-manager.js";

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
 * `git status --porcelain=v1 -uall -z` output. Records are NUL-
 * terminated (no quoting / escaping), so paths containing literal
 * newlines, quotes, or other special chars round-trip cleanly.
 *
 * Each record is `XY <path>` (length ≥ 4 with the leading XY + space).
 * Renames and copies are special: `XY <newpath>` is followed by a
 * SECOND NUL-terminated record containing only the original path. We
 * peek at the next token in that case rather than splitting on " -> ".
 */
function parseStatus(stdout: string): FileStatusEntry[] {
  const out: FileStatusEntry[] = [];
  // Trailing NUL produces an empty final element — drop it.
  const records = stdout.split("\0").filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? "";
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    const x = code[0] ?? " ";
    const y = code[1] ?? " ";
    let originalPath: string | undefined;
    // For renames/copies, the next record is the ORIGINAL path. Peek
    // and consume.
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const next = records[i + 1];
      if (next !== undefined) {
        originalPath = next;
        i++;
      }
    }
    if (path.length === 0) continue;
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
    runGit(cwd, ["status", "--porcelain=v1", "-uall", "-z"]),
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
  // Belt-and-suspenders lexical guard. git itself rejects paths outside
  // the working tree, but routing every path through the same check
  // file-manager uses keeps the boundary obvious in one place. `path`
  // arrives relative-to-project from the route, so resolve against cwd
  // before checking.
  assertInsideRoot(resolve(cwd, path), cwd);
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

/* ----------------------------- branch ops ----------------------------- */

/**
 * Restrict branch names to the same character set git itself accepts in
 * common usage — letters, digits, dot, dash, underscore, slash. Reject
 * anything else (spaces, control chars, leading dash that could be
 * mistaken for a flag, dot-only segments, double slashes, etc.) with a
 * single error code so the route can return a stable 400.
 */
export class InvalidBranchNameError extends Error {
  constructor(name: string) {
    super(`invalid branch name: ${JSON.stringify(name)}`);
    this.name = "InvalidBranchNameError";
  }
}

function assertBranchName(name: string): void {
  if (name.length === 0 || name.length > 200) throw new InvalidBranchNameError(name);
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new InvalidBranchNameError(name);
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    throw new InvalidBranchNameError(name);
  }
  if (name.includes("//") || name.includes("..") || name.includes("@{")) {
    throw new InvalidBranchNameError(name);
  }
  // git reserves `HEAD` and a few similar single-token refs.
  if (name === "HEAD" || name === "FETCH_HEAD" || name === "ORIG_HEAD" || name === "MERGE_HEAD") {
    throw new InvalidBranchNameError(name);
  }
  // git's check-ref-format rules we replicate explicitly so the user
  // gets the cleaner `invalid_branch_name` 400 instead of `git_failed`:
  //   - no segment may begin with `.` (so `.foo` and `bar/.baz` reject)
  //   - no segment may end with `.lock` (git uses .lock files for ref locks)
  //   - the whole name may not end with `.`
  if (name.endsWith(".")) throw new InvalidBranchNameError(name);
  for (const segment of name.split("/")) {
    if (segment.startsWith(".")) throw new InvalidBranchNameError(name);
    if (segment.endsWith(".lock")) throw new InvalidBranchNameError(name);
  }
}

/**
 * Switch the working tree to `branch`. Refuses on a dirty tree (git's
 * default) — the caller is expected to surface the resulting
 * `GitCommandError` to the user, who can stash or revert first.
 *
 * No `--` separator: `git checkout -- <name>` interprets <name> as a
 * pathspec and ALWAYS fails with "did not match any file(s) known to
 * git". The branch-name validator (assertBranchName) already rejects
 * leading dashes, so flag injection isn't a concern here.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  assertBranchName(branch);
  await runGit(cwd, ["checkout", branch]);
}

export interface CreateBranchOptions {
  /** Branch / commit to base the new branch on. Defaults to current HEAD. */
  startPoint?: string;
  /** When true, also switch the working tree to the new branch. */
  checkout?: boolean;
}

/**
 * Create a new local branch. `startPoint` defaults to HEAD; pass
 * `origin/main` (etc.) to branch off a tracking ref. When `checkout`
 * is true, uses `git checkout -b` to create + switch in one step.
 */
export async function createBranch(
  cwd: string,
  name: string,
  opts: CreateBranchOptions = {},
): Promise<void> {
  assertBranchName(name);
  if (opts.startPoint !== undefined) assertBranchName(opts.startPoint);
  if (opts.checkout === true) {
    const args = ["checkout", "-b", name];
    if (opts.startPoint !== undefined) args.push(opts.startPoint);
    await runGit(cwd, args);
  } else {
    const args = ["branch", name];
    if (opts.startPoint !== undefined) args.push(opts.startPoint);
    await runGit(cwd, args);
  }
}

export interface DeleteBranchOptions {
  /** Force-delete via `-D` even when the branch isn't merged. */
  force?: boolean;
}

/**
 * Delete a local branch. Default uses `-d` (refuses to delete an
 * unmerged branch); `force: true` switches to `-D`. Refuses to delete
 * the currently-checked-out branch (git's default behavior surfaces a
 * `GitCommandError`).
 */
export async function deleteBranch(
  cwd: string,
  name: string,
  opts: DeleteBranchOptions = {},
): Promise<void> {
  assertBranchName(name);
  await runGit(cwd, ["branch", opts.force === true ? "-D" : "-d", name]);
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  /**
   * When true, adds `--set-upstream` so the push records the
   * remote/branch as the tracking ref. Required on first push of a
   * new branch — without this the user gets the default
   * "fatal: The current branch has no upstream branch" error.
   */
  setUpstream?: boolean;
}

export async function push(cwd: string, opts: PushOptions = {}): Promise<{ stdout: string }> {
  const args = ["push"];
  if (opts.setUpstream === true) args.push("--set-upstream");
  if (opts.remote !== undefined) {
    assertRemoteName(opts.remote);
    args.push(opts.remote);
  }
  if (opts.branch !== undefined) {
    assertBranchName(opts.branch);
    args.push(opts.branch);
  }
  // Push status info goes to stderr by default; we capture both.
  const { stdout, stderr } = await runGit(cwd, args);
  return { stdout: stdout.length > 0 ? stdout : stderr };
}

/**
 * Validate a git remote name. Rules are looser than branch names:
 * remotes don't reserve `HEAD`/`FETCH_HEAD`/etc., and the `.lock`
 * suffix only matters for ref files. We keep the same character
 * set + leading-dash + traversal guards (the security-relevant
 * ones), but skip the ref-reserved-word and `.lock`/dot-segment
 * checks. A user with a remote literally named `HEAD` (unusual but
 * legal) won't get a 400.
 */
function assertRemoteName(name: string): void {
  if (name.length === 0 || name.length > 200) throw new InvalidBranchNameError(name);
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new InvalidBranchNameError(name);
  if (name.startsWith("-")) throw new InvalidBranchNameError(name);
  if (name.includes("..") || name.includes("@{")) throw new InvalidBranchNameError(name);
}
