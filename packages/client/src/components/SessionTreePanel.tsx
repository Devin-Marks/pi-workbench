import { useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Navigation, RefreshCw, X } from "lucide-react";
import { api, ApiError, type SessionTreeEntry, type SessionTreeResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

/**
 * Phase 15 — Session tree viewer.
 *
 * Loads `/api/v1/sessions/:id/tree` and renders the branching history
 * as an indented list with connecting guides. The active branch path
 * (the entries between the root and the current leaf) is bright; off-
 * path siblings are dimmed but still clickable so the user can
 * navigate to a different branch tip.
 *
 * Two actions per node:
 *   - Click the row → POST /sessions/:id/navigate (in-place leaf
 *     change, no new session file)
 *   - Fork icon on user-message rows → POST /sessions/:id/fork → switch
 *     the active session to the new fork
 *
 * Streaming-aware: navigation while the agent is mid-run prompts for
 * confirmation (the SDK aborts the in-flight turn on navigate).
 */
interface Props {
  sessionId: string;
  projectId: string;
  onClose: () => void;
}

interface NodeView extends SessionTreeEntry {
  depth: number;
  /** True when this entry sits on the path from root → leaf. */
  onActivePath: boolean;
  /** True when this entry IS the leaf. */
  isLeaf: boolean;
  /** Number of sibling branches at this point (for the divider hint). */
  siblings: number;
}

export function SessionTreePanel({ sessionId, projectId, onClose }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);

  const [tree, setTree] = useState<SessionTreeResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const t = await api.getSessionTree(sessionId);
      setTree(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const nodes = useMemo<NodeView[]>(() => {
    if (tree === undefined) return [];
    return flattenTree(tree);
  }, [tree]);

  /**
   * Navigate the active session's leaf. Idempotent on the current
   * leaf (we early-return). When streaming, confirm — the SDK
   * aborts the current turn on navigate, which the user might not
   * want.
   */
  const navigate = async (entryId: string): Promise<void> => {
    if (busy) return;
    if (tree?.leafId === entryId) return;
    if (isStreaming) {
      const ok = window.confirm(
        "The agent is currently running. Navigating will abort the in-progress turn. Continue?",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.navigateSession(sessionId, entryId);
      // SSE will replay the new branch as messages, but the tree
      // panel needs a fresh fetch to update leafId / branchIds.
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fork from the given entry: server writes a new .jsonl containing
   * everything from the root to this entry, registers it as a fresh
   * live session, and returns its summary. Switch the workbench to
   * the new session and close the panel — the user then continues
   * the conversation from the forked branch.
   */
  const fork = async (entryId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const forked = await api.forkSession(sessionId, entryId);
      // Refresh the project's session list so the new fork shows up
      // in the sidebar before we set it active. Without this the
      // active id points at a session the sidebar doesn't yet know
      // about, which causes a flash of "no such session" until the
      // next list poll.
      await loadSessionsForProject(projectId);
      setActiveSession(forked.sessionId);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-neutral-400" />
            <h2 className="text-sm font-semibold text-neutral-100">Session tree</h2>
            {busy && <Loader2 size={11} className="animate-spin text-neutral-500" />}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refresh()}
              disabled={loading || busy}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
              title="Refresh tree"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Close (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {error !== undefined && (
          <div className="border-b border-red-700/40 bg-red-900/20 px-4 py-1.5 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && tree === undefined && (
            <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
              Loading tree…
            </div>
          )}
          {!loading && nodes.length === 0 && (
            <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
              No entries yet.
            </div>
          )}
          <ul className="space-y-0.5">
            {nodes.map((n) => (
              <TreeRow
                key={n.id}
                node={n}
                disabled={busy}
                onNavigate={() => void navigate(n.id)}
                onFork={() => void fork(n.id)}
              />
            ))}
          </ul>
        </div>

        <footer className="flex items-center justify-between border-t border-neutral-800 bg-neutral-900/40 px-4 py-2 text-[10px] text-neutral-500">
          <span>
            Click a row to navigate · fork icon on user messages to branch from that point
          </span>
          {tree !== undefined && (
            <span>
              {tree.entries.length} {tree.entries.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

function TreeRow({
  node,
  disabled,
  onNavigate,
  onFork,
}: {
  node: NodeView;
  disabled: boolean;
  onNavigate: () => void;
  onFork: () => void;
}) {
  const indent = node.depth * 16;
  const isUserMessage = node.type === "message" && node.role === "user";
  const dim = !node.onActivePath;
  const labelText = entryTypeLabel(node);
  return (
    <li className="group" style={{ paddingLeft: `${indent}px` }}>
      <div
        className={`flex items-start gap-2 rounded border px-2 py-1.5 ${
          node.isLeaf
            ? "border-emerald-700/60 bg-emerald-900/10"
            : node.onActivePath
              ? "border-neutral-700 bg-neutral-900/40"
              : "border-neutral-800/50 bg-transparent"
        } ${dim ? "opacity-60" : ""}`}
      >
        <button
          onClick={onNavigate}
          disabled={disabled || node.isLeaf}
          className="flex flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-default"
          title={node.isLeaf ? "Current leaf" : "Navigate the session leaf to this entry"}
        >
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                node.role === "user"
                  ? "bg-sky-900/40 text-sky-300"
                  : node.role === "assistant"
                    ? "bg-violet-900/40 text-violet-300"
                    : node.type === "branch_summary"
                      ? "bg-amber-900/40 text-amber-300"
                      : node.type === "compaction"
                        ? "bg-fuchsia-900/40 text-fuchsia-300"
                        : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {labelText}
            </span>
            {node.label !== undefined && node.label.length > 0 && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-300">
                ★ {node.label}
              </span>
            )}
            {node.isLeaf && (
              <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] text-emerald-300">
                leaf
              </span>
            )}
            {node.siblings > 1 && (
              <span
                className="text-[9px] text-amber-400"
                title={`${node.siblings} branches diverge from this point`}
              >
                ⑂ {node.siblings}
              </span>
            )}
            <span className="text-[9px] text-neutral-600">
              {new Date(node.timestamp).toLocaleString()}
            </span>
          </div>
          {node.preview !== undefined && (
            <p className="truncate text-[11px] text-neutral-300">{node.preview}</p>
          )}
        </button>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          {!node.isLeaf && (
            <button
              onClick={onNavigate}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
              title="Navigate to this entry"
            >
              <Navigation size={11} />
            </button>
          )}
          {isUserMessage && (
            <button
              onClick={onFork}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40"
              title="Fork from this user message into a new session"
            >
              <GitBranch size={11} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Flatten the SDK's parentId-linked entry list into a depth-first
 * order suitable for a flat indented list. Tracks which entries are
 * on the active branch path (for highlighting) and how many siblings
 * each branchpoint has (so we can hint at divergences).
 */
function flattenTree(tree: SessionTreeResponse): NodeView[] {
  const childrenByParent = new Map<string | null, SessionTreeEntry[]>();
  for (const e of tree.entries) {
    const list = childrenByParent.get(e.parentId);
    if (list === undefined) childrenByParent.set(e.parentId, [e]);
    else list.push(e);
  }
  // Sort children by timestamp so the original branch is on top and
  // alternative branches sort below — matches how a user mentally
  // reads "the original conversation, plus what I tried instead."
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  const onPath = new Set(tree.branchIds);
  const out: NodeView[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    const list = childrenByParent.get(parentId);
    if (list === undefined) return;
    const siblings = list.length;
    for (const e of list) {
      out.push({
        ...e,
        depth,
        onActivePath: onPath.has(e.id),
        isLeaf: tree.leafId === e.id,
        siblings,
      });
      visit(e.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

function entryTypeLabel(node: SessionTreeEntry): string {
  if (node.type === "message") return node.role ?? "message";
  if (node.type === "thinking_level_change") return "thinking";
  if (node.type === "model_change") return "model";
  if (node.type === "compaction") return "compact";
  if (node.type === "branch_summary") return "branch";
  if (node.type === "label") return "label";
  if (node.type === "session_info") return "info";
  if (node.type === "custom") return "custom";
  if (node.type === "custom_message") return "extension";
  return node.type;
}
