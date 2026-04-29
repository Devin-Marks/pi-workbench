import { useEffect, useRef, useState } from "react";
import {
  Check,
  GitBranch,
  GitCommit,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  api,
  ApiError,
  type GitFileStatus,
  type GitLogEntry,
  type GitBranch as GitBranchEntry,
} from "../lib/api-client";
import { useActiveProject } from "../store/project-store";
import { useGitStatus } from "../hooks/useGitStatus";
import { DiffBlock } from "./DiffBlock";
import { ConfirmDialog, PromptDialog } from "./Modal";

/**
 * Right-pane Git tab. Sections, top-to-bottom:
 *
 *   - Header: current branch, refresh button.
 *   - Status: files grouped Staged / Unstaged / Untracked, checkbox
 *     to flip stage state, click row to expand inline diff.
 *   - Commit: message textarea + Commit button. Disabled when nothing
 *     is staged.
 *   - Push: Push button. Surfaces git's stderr verbatim on failure
 *     (no upstream, auth refused, non-fast-forward, etc.).
 *   - Log: collapsible list of recent commits (lazy-loaded on first
 *     expand to keep the initial render cheap).
 *   - Branches: collapsible list (lazy-loaded the same way).
 *
 * Polls `GET /git/status` every 5s via `useGitStatus` (pauses while
 * the active session is streaming).
 */
export function GitPanel() {
  const project = useActiveProject();
  const { status, error: statusError, refresh } = useGitStatus(project?.id);

  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | undefined>(undefined);
  const [opResult, setOpResult] = useState<string | undefined>(undefined);

  // Lazily-loaded log + branches.
  const [log, setLog] = useState<GitLogEntry[] | undefined>(undefined);
  const [branches, setBranches] = useState<GitBranchEntry[] | undefined>(undefined);
  const [showLog, setShowLog] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  // Pending-branch-op state. `branchBusy` blocks duplicate clicks on
  // the per-row buttons; `branchDialog` drives the create / delete
  // confirmation modals.
  const [branchBusy, setBranchBusy] = useState<string | undefined>(undefined);
  const [branchDialog, setBranchDialog] = useState<
    { kind: "create" } | { kind: "delete"; name: string } | undefined
  >(undefined);

  const reloadBranches = async (): Promise<void> => {
    if (project === undefined) return;
    try {
      const r = await api.gitBranches(project.id);
      setBranches(r.branches);
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  const handleCheckout = async (branch: string): Promise<void> => {
    if (project === undefined) return;
    setBranchBusy(branch);
    setOpError(undefined);
    try {
      await api.gitCheckout(project.id, branch);
      await reloadBranches();
      refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  const handleCreateBranch = async (name: string): Promise<void> => {
    if (project === undefined) return;
    setBranchDialog(undefined);
    setBranchBusy(name);
    setOpError(undefined);
    try {
      // Create + checkout in one step — matches what most UIs do
      // when the user clicks "New branch" while looking at the
      // branches panel.
      await api.gitBranchCreate(project.id, name, { checkout: true });
      await reloadBranches();
      refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  const handleDeleteBranch = async (force: boolean): Promise<void> => {
    if (project === undefined || branchDialog?.kind !== "delete") return;
    const { name } = branchDialog;
    setBranchDialog(undefined);
    setBranchBusy(name);
    setOpError(undefined);
    try {
      await api.gitBranchDelete(project.id, name, force);
      await reloadBranches();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  // Per-file diff cache. Keyed by `<path>|<staged>` so toggling
  // staged status swaps the rendered diff cleanly.
  const [openDiffs, setOpenDiffs] = useState<Record<string, string | "loading" | "error">>({});

  // Prune diff cache entries whose file is no longer in the latest
  // status (e.g. user ran `git checkout -- file` from the integrated
  // terminal). Without this, the diff card stayed open with stale
  // content. We compare path-only because either staged side counts
  // as "still around".
  useEffect(() => {
    if (status === undefined) return;
    const livePaths = new Set(status.files.map((f) => f.path));
    setOpenDiffs((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, value] of Object.entries(prev)) {
        const path = key.split("|")[0] ?? "";
        if (livePaths.has(path)) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  // Load lazily on first expand. Refresh on subsequent project
  // switches if the user happens to leave the section open.
  useEffect(() => {
    if (showLog && project !== undefined) {
      void api
        .gitLog(project.id, 30)
        .then((r) => setLog(r.commits))
        .catch((err: unknown) =>
          setOpError(err instanceof ApiError ? err.code : (err as Error).message),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLog, project?.id]);

  useEffect(() => {
    if (showBranches && project !== undefined) {
      void api
        .gitBranches(project.id)
        .then((r) => setBranches(r.branches))
        .catch((err: unknown) =>
          setOpError(err instanceof ApiError ? err.code : (err as Error).message),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBranches, project?.id]);

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs italic text-neutral-500">
        Pick a project to see its git status.
      </div>
    );
  }

  if (status?.isGitRepo === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs italic text-neutral-500">
        <p>{project.name} isn't a git repository.</p>
        <p className="text-[10px] text-neutral-600">
          Run <code className="font-mono text-neutral-400">git init</code> in the project dir to
          enable git features.
        </p>
      </div>
    );
  }

  const stagedFiles = status?.files.filter((f) => f.staged) ?? [];
  const unstagedFiles = status?.files.filter((f) => f.unstaged && !f.staged) ?? [];
  const untrackedFiles = status?.files.filter((f) => f.kind === "untracked") ?? [];

  const toggleDiff = async (file: GitFileStatus, staged: boolean): Promise<void> => {
    const key = `${file.path}|${staged ? "staged" : "unstaged"}`;
    if (openDiffs[key] !== undefined) {
      setOpenDiffs((s) => {
        const next = { ...s };
        delete next[key];
        return next;
      });
      return;
    }
    setOpenDiffs((s) => ({ ...s, [key]: "loading" }));
    try {
      const r = await api.gitDiffFile(project.id, file.path, staged);
      setOpenDiffs((s) => ({ ...s, [key]: r.diff }));
    } catch {
      setOpenDiffs((s) => ({ ...s, [key]: "error" }));
    }
  };

  const stage = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    try {
      await api.gitStage(project.id, paths);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Revert (discard local changes). Wired through to
  // `git restore --staged --worktree --source=HEAD` server-side.
  // Untracked files are filtered out client-side because git
  // refuses them; the panel doesn't render the button for them
  // (see FileGroup below).
  const revert = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      await api.gitRevert(project.id, paths);
      setOpResult(paths.length === 1 ? `Reverted ${paths[0]}` : `Reverted ${paths.length} files`);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unstage = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    try {
      await api.gitUnstage(project.id, paths);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    const msg = commitMessage.trim();
    if (msg.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const { hash } = await api.gitCommit(project.id, msg);
      setCommitMessage("");
      setOpResult(`Committed ${hash.slice(0, 7)}`);
      await refresh();
      // Refresh log if the section is open so the new commit shows up.
      if (showLog) {
        const r = await api.gitLog(project.id, 30);
        setLog(r.commits);
      }
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pushUpstream = async (): Promise<void> => {
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const { output } = await api.gitPush(project.id);
      setOpResult(
        output.trim().length > 0 ? (output.trim().split("\n").pop() ?? "Pushed") : "Pushed",
      );
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col text-xs text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2 font-medium text-neutral-200">
          <GitBranch size={13} />
          {status?.branch ?? "—"}
          {status !== undefined && status.files.length > 0 && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
              {status.files.length}
            </span>
          )}
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          title="Refresh"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        </button>
      </div>

      {(statusError !== undefined || opError !== undefined) && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300">
          {opError ?? statusError}
        </div>
      )}
      {opResult !== undefined && (
        <div className="border-b border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-[11px] text-emerald-300">
          {opResult}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {status === undefined && <p className="px-3 py-3 italic text-neutral-500">Loading…</p>}

        {status !== undefined && status.files.length === 0 && (
          <p className="px-3 py-3 italic text-neutral-500">Working tree clean.</p>
        )}

        {stagedFiles.length > 0 && (
          <FileGroup
            label="Staged"
            files={stagedFiles}
            actionLabel="Unstage all"
            onGroupAction={() => void unstage(stagedFiles.map((f) => f.path))}
            onFileAction={(f) => void unstage([f.path])}
            fileActionLabel="Unstage"
            onRevert={(f) => void revert([f.path])}
            onClickFile={(f) => void toggleDiff(f, true)}
            openDiffs={openDiffs}
            staged
          />
        )}
        {unstagedFiles.length > 0 && (
          <FileGroup
            label="Unstaged"
            files={unstagedFiles}
            actionLabel="Stage all"
            onGroupAction={() => void stage(unstagedFiles.map((f) => f.path))}
            onFileAction={(f) => void stage([f.path])}
            fileActionLabel="Stage"
            onRevert={(f) => void revert([f.path])}
            onClickFile={(f) => void toggleDiff(f, false)}
            openDiffs={openDiffs}
            staged={false}
          />
        )}
        {untrackedFiles.length > 0 && (
          <FileGroup
            label="Untracked"
            files={untrackedFiles}
            actionLabel="Stage all"
            onGroupAction={() => void stage(untrackedFiles.map((f) => f.path))}
            onFileAction={(f) => void stage([f.path])}
            fileActionLabel="Stage"
            // Untracked files can't be reverted (git refuses; they
            // weren't in HEAD). Pass undefined so the row hides
            // the revert button — user should delete via the file
            // browser instead.
            onRevert={undefined}
            onClickFile={(f) => void toggleDiff(f, false)}
            openDiffs={openDiffs}
            staged={false}
          />
        )}

        {/* Commit section — disabled while nothing's staged. */}
        <div className="border-t border-neutral-800/60 px-3 py-3">
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
            <GitCommit size={10} /> Commit
          </div>
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message…"
            rows={3}
            className="w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[10px] text-neutral-500">{stagedFiles.length} staged</span>
            <button
              onClick={() => void commit()}
              disabled={busy || stagedFiles.length === 0 || commitMessage.trim().length === 0}
              className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Commit
            </button>
          </div>
        </div>

        {/* Push section. */}
        <div className="border-t border-neutral-800/60 px-3 py-3">
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
            <Upload size={10} /> Push
          </div>
          <button
            onClick={() => void pushUpstream()}
            disabled={busy}
            className="w-full rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
          >
            Push to upstream
          </button>
        </div>

        {/* Log section. */}
        <div className="border-t border-neutral-800/60">
          <button
            onClick={() => setShowLog((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900"
          >
            <span>Log</span>
            <span>{showLog ? "−" : "+"}</span>
          </button>
          {showLog && (
            <div className="px-3 pb-3 text-[11px]">
              {log === undefined ? (
                <p className="italic text-neutral-500">Loading…</p>
              ) : log.length === 0 ? (
                <p className="italic text-neutral-500">No commits yet.</p>
              ) : (
                <ul className="space-y-1">
                  {log.map((c) => (
                    <li key={c.hash} className="flex flex-col gap-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-neutral-500">{c.hash.slice(0, 7)}</span>
                        <span className="truncate text-neutral-200" title={c.message}>
                          {c.message}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-neutral-600">
                        {c.author} · {new Date(c.date).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Branches section. */}
        <div className="border-t border-neutral-800/60">
          <button
            onClick={() => setShowBranches((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900"
          >
            <span>Branches</span>
            <span>{showBranches ? "−" : "+"}</span>
          </button>
          {showBranches && (
            <div className="px-3 pb-3 text-[11px]">
              {branches === undefined ? (
                <p className="italic text-neutral-500">Loading…</p>
              ) : (
                <>
                  <ul className="space-y-0.5">
                    {branches.map((b) => {
                      const busy = branchBusy === b.name;
                      return (
                        <li
                          key={b.name}
                          className={`group flex items-center gap-1 rounded px-1 py-0.5 font-mono hover:bg-neutral-900 ${
                            b.current ? "text-emerald-400" : "text-neutral-300"
                          }`}
                        >
                          <span className="w-3 shrink-0">
                            {b.current ? <Check size={10} /> : null}
                          </span>
                          <span className="flex-1 truncate" title={b.name}>
                            {b.name}
                          </span>
                          {b.remote && (
                            <span className="ml-1 text-[10px] text-neutral-600">remote</span>
                          )}
                          {/* Per-row actions only show on hover. Current
                              local branch shows neither — checkout-self
                              is a no-op and -d on current is rejected. */}
                          {!b.current && (
                            <div className="hidden gap-0.5 group-hover:flex">
                              <button
                                onClick={() => void handleCheckout(b.name)}
                                disabled={busy}
                                className="rounded px-1 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                                title={
                                  b.remote
                                    ? `Checkout (creates a tracking branch from ${b.name})`
                                    : `Checkout ${b.name}`
                                }
                              >
                                checkout
                              </button>
                              {!b.remote && (
                                <button
                                  onClick={() => setBranchDialog({ kind: "delete", name: b.name })}
                                  disabled={busy}
                                  className="rounded p-0.5 text-neutral-500 hover:bg-red-900/30 hover:text-red-300 disabled:opacity-40"
                                  title="Delete branch"
                                >
                                  <Trash2 size={10} />
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    onClick={() => setBranchDialog({ kind: "create" })}
                    className="mt-2 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                  >
                    <Plus size={10} /> New branch
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <PromptDialog
        open={branchDialog?.kind === "create"}
        onClose={() => setBranchDialog(undefined)}
        onSubmit={(name) => void handleCreateBranch(name)}
        title="New branch"
        label="Branch name"
        placeholder="feature/my-change"
        primaryLabel="Create + checkout"
      />
      <ConfirmDialog
        open={branchDialog?.kind === "delete"}
        onClose={() => setBranchDialog(undefined)}
        onConfirm={() => void handleDeleteBranch(false)}
        title="Delete branch"
        message={
          branchDialog?.kind === "delete"
            ? `Delete branch "${branchDialog.name}"? Refused if not merged into HEAD; force-delete from the terminal if you really mean it.`
            : ""
        }
        primaryLabel="Delete"
        tone="danger"
      />
    </div>
  );
}

interface FileGroupProps {
  label: string;
  files: GitFileStatus[];
  actionLabel: string;
  onGroupAction: () => void;
  onFileAction: (f: GitFileStatus) => void;
  fileActionLabel: string;
  /** Called when the user double-clicks (confirms) Revert. Pass
   *  `undefined` to hide the revert button entirely (e.g. for
   *  untracked files where git can't restore from HEAD). */
  onRevert: ((f: GitFileStatus) => void) | undefined;
  onClickFile: (f: GitFileStatus) => void;
  openDiffs: Record<string, string | "loading" | "error">;
  staged: boolean;
}

const REVERT_CONFIRM_TIMEOUT_MS = 3000;

function FileGroup(props: FileGroupProps) {
  // Click-twice-to-confirm state for the destructive Revert action.
  // First click on a file's revert button puts THAT file's path
  // into `pending`, swaps the icon for "Confirm?" copy, and sets
  // a 3s timeout to auto-clear. Second click within the window
  // executes the revert. Clicking a different file's revert
  // moves the pending state to that file (so two-step destructive
  // actions can't accidentally hit the wrong row). The ref tracks
  // the timeout so we can clear it on unmount or state transition.
  const [pendingRevert, setPendingRevert] = useState<string | undefined>(undefined);
  const revertTimerRef = useRef<number | undefined>(undefined);

  const clearPending = (): void => {
    if (revertTimerRef.current !== undefined) {
      window.clearTimeout(revertTimerRef.current);
      revertTimerRef.current = undefined;
    }
    setPendingRevert(undefined);
  };

  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== undefined) {
        window.clearTimeout(revertTimerRef.current);
      }
    };
  }, []);

  const handleRevertClick = (f: GitFileStatus): void => {
    if (props.onRevert === undefined) return;
    if (pendingRevert === f.path) {
      // Second click within the window — commit.
      clearPending();
      props.onRevert(f);
      return;
    }
    // First click (or click on a different file).
    if (revertTimerRef.current !== undefined) {
      window.clearTimeout(revertTimerRef.current);
    }
    setPendingRevert(f.path);
    revertTimerRef.current = window.setTimeout(() => {
      setPendingRevert(undefined);
      revertTimerRef.current = undefined;
    }, REVERT_CONFIRM_TIMEOUT_MS);
  };

  return (
    <div className="border-t border-neutral-800/60">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          {props.label} ({props.files.length})
        </span>
        <button
          onClick={props.onGroupAction}
          className="text-[10px] text-neutral-400 hover:text-neutral-200"
        >
          {props.actionLabel}
        </button>
      </div>
      <ul>
        {props.files.map((f) => {
          const key = `${f.path}|${props.staged ? "staged" : "unstaged"}`;
          const diffState = props.openDiffs[key];
          const revertPending = pendingRevert === f.path;
          return (
            <li key={f.path} className="border-t border-neutral-900">
              <div className="group flex items-center gap-2 px-3 py-1 hover:bg-neutral-900">
                <span
                  className="inline-block w-5 shrink-0 text-center font-mono text-[10px] text-neutral-500"
                  title={`porcelain code: ${f.code}`}
                >
                  {kindBadge(f.kind)}
                </span>
                <button
                  onClick={() => props.onClickFile(f)}
                  className="flex-1 truncate text-left font-mono"
                  title={f.path}
                >
                  {f.path}
                </button>
                {props.onRevert !== undefined && (
                  <button
                    onClick={() => handleRevertClick(f)}
                    // `inline-flex` (NOT plain `inline`) is what
                    // keeps the icon on the same baseline as the
                    // text. `inline` alone would override our
                    // `flex` display and stack the icon below the
                    // label whenever the text wrapped or got too
                    // wide. `group-hover:inline-flex` handles the
                    // visible state on hover.
                    className={
                      revertPending
                        ? "inline-flex items-center gap-1 rounded bg-red-900/40 px-1 py-0.5 text-[10px] text-red-200"
                        : "hidden items-center gap-1 text-[10px] text-neutral-500 hover:text-red-300 group-hover:inline-flex"
                    }
                    title={
                      revertPending
                        ? "Click again to discard local changes (this cannot be undone)"
                        : "Revert: discard local changes for this file"
                    }
                  >
                    <Undo2 size={10} />
                    {revertPending ? "Confirm?" : "Revert"}
                  </button>
                )}
                <button
                  onClick={() => props.onFileAction(f)}
                  // Same `inline-flex` trick as the revert button —
                  // plain `inline` would override the implicit
                  // flex-row layout and let the icon wrap.
                  className="ml-3 hidden items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-200 group-hover:inline-flex"
                >
                  {props.fileActionLabel === "Stage" ? (
                    <Plus size={10} />
                  ) : props.fileActionLabel === "Unstage" ? (
                    <Minus size={10} />
                  ) : null}
                  {props.fileActionLabel}
                </button>
              </div>
              {diffState !== undefined && (
                <div className="border-t border-neutral-900 bg-neutral-950">
                  {diffState === "loading" ? (
                    <p className="px-3 py-2 italic text-neutral-500">Loading…</p>
                  ) : diffState === "error" ? (
                    <p className="px-3 py-2 text-red-400">Failed to load diff.</p>
                  ) : diffState.length === 0 ? (
                    <p className="px-3 py-2 italic text-neutral-500">
                      (no diff — file is binary or unchanged)
                    </p>
                  ) : (
                    <DiffBlock diff={diffState} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function kindBadge(kind: GitFileStatus["kind"]): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "?";
    case "ignored":
      return "!";
    case "conflicted":
      return "U";
    default:
      return "·";
  }
}
