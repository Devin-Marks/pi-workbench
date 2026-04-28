import { useEffect, useState, type KeyboardEvent } from "react";
import { EMPTY_SESSIONS, useSessionStore } from "../store/session-store";

interface Props {
  projectId: string;
}

/**
 * Per-project session list. Replaces the "No sessions yet" placeholder that
 * lived under the project rows in Phases 3-7. Loads on mount, click selects,
 * "+ New" creates and selects a fresh live session, double-click renames.
 */
export function SessionList({ projectId }: Props) {
  // EMPTY_SESSIONS (stable module-level reference) — see session-store.ts
  // for why we don't write `?? []` directly in Zustand selectors.
  const sessions = useSessionStore((s) => s.byProject[projectId] ?? EMPTY_SESSIONS);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);
  const createSession = useSessionStore((s) => s.createSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disposeSession = useSessionStore((s) => s.disposeSession);
  const renameSession = useSessionStore((s) => s.renameSession);

  // Inline rename state — only one row at a time.
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    void loadSessionsForProject(projectId);
  }, [projectId, loadSessionsForProject]);

  const onNew = async (): Promise<void> => {
    try {
      await createSession(projectId);
    } catch {
      // error already in store.error; sidebar surfaces via App banner
    }
  };

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
    <div className="ml-6 space-y-0.5">
      <button
        onClick={() => void onNew()}
        className="w-full rounded px-2 py-0.5 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      >
        + New session
      </button>
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
                onClick={() => setActiveSession(s.sessionId)}
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
                onClick={() => {
                  if (confirm(`Dispose session "${label}"? The on-disk JSONL is preserved.`)) {
                    void disposeSession(s.sessionId);
                  }
                }}
                className="hidden text-neutral-500 hover:text-red-400 group-hover:inline"
                title="Dispose live session"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
