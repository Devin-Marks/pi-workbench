import { useEffect, useState, type KeyboardEvent } from "react";
import { EMPTY_SESSIONS, useSessionStore } from "../store/session-store";
import { useProjectStore } from "../store/project-store";
import { ConfirmDialog } from "./Modal";

interface Props {
  projectId: string;
}

/**
 * Per-project session list. Replaces the "No sessions yet" placeholder that
 * lived under the project rows in Phases 3-7. Loads on mount, click selects,
 * double-click renames. The "new session" affordance lives on the parent
 * project row (a `+` button next to the delete `×`), so this component is
 * read-only for the create path.
 */
export function SessionList({ projectId }: Props) {
  // EMPTY_SESSIONS (stable module-level reference) — see session-store.ts
  // for why we don't write `?? []` directly in Zustand selectors.
  const sessions = useSessionStore((s) => s.byProject[projectId] ?? EMPTY_SESSIONS);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disposeSession = useSessionStore((s) => s.disposeSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setActiveProject = useProjectStore((s) => s.setActive);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  /**
   * Selecting a session also pulls the active-project pointer along
   * to that session's project. Without this, clicking a session
   * under project B while project A was active would set the
   * session pointer (so chat would show that session) but leave
   * the rest of the UI — Files / Changes / Git tabs, project
   * dropdown — pinned to A. The two pointers should always agree.
   */
  const selectSession = (sessionId: string): void => {
    if (activeProjectId !== projectId) setActiveProject(projectId);
    setActiveSession(sessionId);
  };

  // Inline rename state — only one row at a time.
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");

  /**
   * Delete-session dialog state. Live and cold rows hit the same
   * × button but the underlying behavior differs:
   *   - live: dispose-only (preserves the JSONL); session can be
   *     resumed later by clicking it again.
   *   - cold: actually deletes the JSONL from disk; the row goes
   *     away forever. Presented in a danger-toned modal.
   */
  const [deleteDialog, setDeleteDialog] = useState<
    { sessionId: string; label: string; isLive: boolean } | undefined
  >(undefined);

  const submitDelete = async (): Promise<void> => {
    if (deleteDialog === undefined) return;
    const { sessionId } = deleteDialog;
    // Re-read isLive from the store at submit time. The dialog state
    // captures it at click time, but a session can transition live →
    // cold between click and confirm (idle GC, server restart, etc.).
    // If we trusted the captured flag and sent `hard: false` while the
    // session is now cold, the route's "cold + no hard → 404" branch
    // would surface — better than the older behavior where a stale
    // flag could silently delete a file. But we can do one better:
    // consult the freshest state and use the right `hard` flag.
    const fresh = sessions.find((x) => x.sessionId === sessionId);
    const isLiveNow = fresh?.isLive ?? deleteDialog.isLive;
    setDeleteDialog(undefined);
    // Live path: dispose without hard delete. Cold path: hard delete
    // (also removes the on-disk JSONL).
    void disposeSession(sessionId, { hard: !isLiveNow });
  };

  useEffect(() => {
    void loadSessionsForProject(projectId);
  }, [projectId, loadSessionsForProject]);

  const startRename = (sessionId: string, current: string): void => {
    setRenamingId(sessionId);
    setRenameDraft(current);
  };

  const cancelRename = (): void => {
    setRenamingId(undefined);
    setRenameDraft("");
  };

  const commitRename = async (sessionId: string): Promise<void> => {
    const next = renameDraft.trim();
    cancelRename();
    try {
      // Server requires a live session for rename. If the user double-clicks
      // an on-disk-only row we'll surface the 404 via store.error and the
      // App-level banner; no local-only fallback because the SDK is the
      // source of truth for session_info entries.
      await renameSession(sessionId, next);
    } catch {
      // store.error surfaces; nothing else to do here
    }
  };

  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>, sessionId: string): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename(sessionId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    // `mt-1` separates the first session row from the project row
    // above; without it, the active-row highlight backgrounds (both
    // are `bg-neutral-800`) touch and read as one continuous block.
    <div className="ml-6 mt-1 space-y-0.5">
      {/* "New session" lives on the parent project row in
          ProjectSidebar (the + button on hover). Avoids stacking
          a second action button per project. */}
      {sessions.length === 0 && (
        <p className="px-2 py-1 text-xs italic text-neutral-600">No sessions yet.</p>
      )}
      {sessions.map((s) => {
        const isActive = s.sessionId === activeSessionId;
        const label =
          s.name ??
          (s.firstMessage.length > 0
            ? s.firstMessage.slice(0, 40)
            : `session ${s.sessionId.slice(0, 6)}`);
        const isRenaming = renamingId === s.sessionId;
        return (
          <div
            key={s.sessionId}
            className={`group flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
              isActive
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => onRenameKeyDown(e, s.sessionId)}
                onBlur={() => void commitRename(s.sessionId)}
                placeholder={label}
                maxLength={200}
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-neutral-500"
              />
            ) : (
              <button
                onClick={() => selectSession(s.sessionId)}
                onDoubleClick={() => startRename(s.sessionId, s.name ?? "")}
                className="flex-1 truncate text-left"
                title={`${s.sessionId} — double-click to rename`}
              >
                {s.isLive && <span className="mr-1 text-emerald-500">●</span>}
                {label}
              </button>
            )}
            {!isRenaming && (
              <button
                onClick={() => setDeleteDialog({ sessionId: s.sessionId, label, isLive: s.isLive })}
                className="hidden text-neutral-500 hover:text-red-400 group-hover:inline"
                title={
                  s.isLive
                    ? "Dispose live session (file preserved)"
                    : "Delete session JSONL from disk"
                }
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <ConfirmDialog
        open={deleteDialog !== undefined}
        onClose={() => setDeleteDialog(undefined)}
        onConfirm={() => void submitDelete()}
        title={
          deleteDialog?.isLive === false
            ? `Delete session "${deleteDialog.label}"`
            : `Dispose session "${deleteDialog?.label ?? ""}"`
        }
        message={
          deleteDialog?.isLive === false
            ? `Permanently delete the on-disk JSONL for "${deleteDialog.label}"? This cannot be undone — the session is no longer in memory and the file is the only copy.`
            : `Dispose the live session "${deleteDialog?.label ?? ""}"? The on-disk JSONL is preserved; you can resume the session later by clicking it.`
        }
        primaryLabel={deleteDialog?.isLive === false ? "Delete from disk" : "Dispose"}
        tone={deleteDialog?.isLive === false ? "danger" : "default"}
      />
    </div>
  );
}
