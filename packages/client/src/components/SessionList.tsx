import { useEffect, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
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
   * Delete-session dialog state. The × button always means "delete
   * forever" — same behavior for live and cold rows. Earlier we did
   * dispose-only on live rows (preserving the JSONL) which forced a
   * second click to actually remove the file: live → dispose →
   * reappears as cold → hard delete → row vanishes. That two-step
   * was confusing ("the row didn't go away") and inconsistent with
   * how the project-delete flow already works. Single click +
   * confirm = gone, end of story.
   */
  const [deleteDialog, setDeleteDialog] = useState<
    { sessionId: string; label: string; isLive: boolean } | undefined
  >(undefined);

  const submitDelete = async (): Promise<void> => {
    if (deleteDialog === undefined) return;
    const { sessionId } = deleteDialog;
    setDeleteDialog(undefined);
    // hard:true unconditionally — server's DELETE route handles the
    // live + hard case by disposing the in-memory entry AND
    // removing the on-disk JSONL atomically. The route's docs spell
    // out the full matrix; we always pick the "actually delete" leg.
    void disposeSession(sessionId, { hard: true });
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
                className="invisible inline-flex items-center p-1 text-neutral-500 hover:text-red-400 group-hover:visible"
                title={
                  s.isLive
                    ? "Delete session — also kills the live shell"
                    : "Delete session JSONL from disk"
                }
              >
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
      <ConfirmDialog
        open={deleteDialog !== undefined}
        onClose={() => setDeleteDialog(undefined)}
        onConfirm={() => void submitDelete()}
        title={`Delete session "${deleteDialog?.label ?? ""}"`}
        message={
          deleteDialog?.isLive === true
            ? `Delete "${deleteDialog.label}"? This kills the live shell AND removes the on-disk JSONL. Cannot be undone.`
            : `Delete the on-disk JSONL for "${deleteDialog?.label ?? ""}"? Cannot be undone — the file is the only copy.`
        }
        primaryLabel="Delete"
        tone="danger"
      />
    </div>
  );
}
