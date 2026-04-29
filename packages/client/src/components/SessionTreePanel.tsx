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
  /** Role-based indent step (user=0, assistant=1, tool=2). */
  depth: number;
  /**
   * Branch nesting level — 0 for the original conversation, 1 for
   * its first divergence, 2 for a divergence within that, etc. Adds
   * a small base offset to the visual indent so re-asks at the same
   * role-depth (e.g. two `user` messages from the same parent) sit
   * at visibly different x-positions instead of collapsing into the
   * same column.
   */
  branchLevel: number;
  /** True when this entry sits on the path from root → leaf. */
  onActivePath: boolean;
  /** True when this entry IS the leaf. */
  isLeaf: boolean;
  /** Number of sibling branches at this point (for the divider hint). */
  siblings: number;
  /**
   * True when this row is the FIRST entry of a branch with
   * branchLevel > 0 — used to render a "branch N" badge so the
   * divergence is explicit, not just inferred from the offset.
   */
  isBranchHead: boolean;
}

const MODEL_KEY_PREFIX = "pi-workbench/model/";

export function SessionTreePanel({ sessionId, projectId, onClose }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);
  const reloadMessages = useSessionStore((s) => s.reloadMessages);
  const setPendingDraft = useSessionStore((s) => s.setPendingDraft);

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
      // Two refetches needed:
      //   1. Tree panel — leafId / branchIds change, repaint highlight
      //   2. Chat surface — messagesBySession is keyed by sessionId
      //      and there's no SSE event for navigate, so without this
      //      the chat stays stuck on the pre-navigate message list
      //      and the user thinks the button did nothing.
      await refresh();
      reloadMessages(sessionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fork from the given entry. Two semantics depending on which kind
   * of row it's called from:
   *
   *   - "branch from here" (assistant + non-message rows): server
   *     forks AT entryId; the new session contains everything up to
   *     and including this entry. Useful for "let me try something
   *     different from this point in the assistant's reply."
   *
   *   - "edit & resubmit" (user-message rows, the common case):
   *     server forks at the user message's PARENT, so the user
   *     message is NOT in the new session's history. We then prefill
   *     the chat input with the user message text via
   *     setPendingDraft, so the user lands in an editable textarea
   *     pre-populated with what they originally said. This matches
   *     the ChatGPT-style "edit my message" flow most users expect.
   *
   * Either way we copy the source session's per-session model
   * preference into the new session's localStorage key so the fork
   * inherits the model the user picked on the source.
   */
  const fork = async (
    entryId: string,
    opts: { editDraft?: string; parentId?: string | null } = {},
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // For the edit-and-resubmit flow, fork from the parent so the
      // user message is excluded. parentId === null means "no parent"
      // (root user message) — fall back to forking AT the message;
      // empty session is the next-best landing.
      const forkAt =
        opts.parentId !== undefined && opts.parentId !== null ? opts.parentId : entryId;
      const forked = await api.forkSession(sessionId, forkAt);
      // Carry the per-session model choice across the fork. ChatInput
      // re-applies whatever's in localStorage on session change, so
      // copying the value before setActiveSession means the new
      // session inherits the model without an extra API call.
      try {
        const sourceModel = localStorage.getItem(MODEL_KEY_PREFIX + sessionId);
        if (sourceModel !== null && sourceModel.length > 0) {
          localStorage.setItem(MODEL_KEY_PREFIX + forked.sessionId, sourceModel);
        }
      } catch {
        // private-mode storage failure — non-fatal, user can pick
        // the model again on the new session.
      }
      if (opts.editDraft !== undefined && opts.editDraft.length > 0) {
        setPendingDraft(forked.sessionId, opts.editDraft);
      }
      // Refresh the sidebar's session list before switching so the
      // new id is known by the time the active-id flip happens —
      // otherwise the sidebar briefly shows "no such session."
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
                onFork={() =>
                  void fork(n.id, {
                    // User-message rows: fork BEFORE the message and
                    // prefill the input with its text. Other rows
                    // fork AT the entry — pass nothing.
                    ...(n.type === "message" && n.role === "user"
                      ? { editDraft: n.preview ?? "", parentId: n.parentId }
                      : {}),
                  })
                }
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

// Role-based indent (depthForEntry): user=0, assistant=1, tool=2.
// 18 px per step is room enough for 3 levels without crowding.
const MAX_INDENT_DEPTH = 4;
const INDENT_PX = 18;
// Per-branch base offset added on top of the role indent so two
// re-asks at the same role level (both depth 0) sit at different
// x-positions when they belong to different branches. 10 px is
// small enough not to consume the modal width even with 6+
// branches, but visible at a glance. Capped to keep the deepest
// branches from running off the right edge.
const BRANCH_OFFSET_PX = 10;
const MAX_BRANCH_LEVEL = 8;

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
  const indent =
    Math.min(node.depth, MAX_INDENT_DEPTH) * INDENT_PX +
    Math.min(node.branchLevel, MAX_BRANCH_LEVEL) * BRANCH_OFFSET_PX;
  const isUserMessage = node.type === "message" && node.role === "user";
  const dim = !node.onActivePath;
  const labelText = entryTypeLabel(node);
  return (
    // min-w-0 on the wrapper so flex children inside (the row's
    // content column with `truncate`) actually shrink below their
    // content width instead of overflowing the modal.
    <li className="group min-w-0" style={{ paddingLeft: `${indent}px` }}>
      <div
        className={`flex min-w-0 items-start gap-1.5 rounded border px-2 py-1.5 ${
          node.isLeaf
            ? "border-emerald-700/60 bg-emerald-900/10"
            : node.onActivePath
              ? "border-neutral-700 bg-neutral-900/40"
              : "border-neutral-800/50 bg-transparent"
        } ${dim ? "opacity-60" : ""}`}
        // Coloured left-border for non-original branches so the
        // divergence is visible even when scrolled past the branch
        // head. `branchLevel` cycles through a small palette so
        // sibling branches at the same level are distinguishable
        // at a glance.
        style={
          node.branchLevel > 0
            ? { boxShadow: `inset 3px 0 0 ${branchAccent(node.branchLevel)}` }
            : undefined
        }
      >
        {/* Action buttons on the LEFT so they're predictably reachable
            regardless of preview length, and so deeply-nested rows
            don't shove them off the right edge. Always visible —
            previously hidden behind group-hover, which made
            discoverability rough on touch + small screens. */}
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          {!node.isLeaf ? (
            <button
              onClick={onNavigate}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
              title="Navigate the session leaf to this entry"
            >
              <Navigation size={11} />
            </button>
          ) : (
            // Placeholder keeps row heights consistent when the leaf
            // hides its navigate button.
            <span className="inline-block w-[22px]" aria-hidden="true" />
          )}
          {isUserMessage ? (
            <button
              onClick={onFork}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40"
              title="Fork BEFORE this message — opens a new session with the message text loaded into the input for editing."
            >
              <GitBranch size={11} />
            </button>
          ) : (
            <span className="inline-block w-[22px]" aria-hidden="true" />
          )}
        </div>
        <button
          onClick={onNavigate}
          disabled={disabled || node.isLeaf}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-default"
          title={node.isLeaf ? "Current leaf" : "Navigate the session leaf to this entry"}
        >
          <div className="flex flex-wrap items-center gap-1.5">
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
            {node.isBranchHead && (
              <span
                className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                style={{
                  background: `${branchAccent(node.branchLevel)}33`,
                  color: branchAccent(node.branchLevel),
                }}
                title="First entry of a divergent branch"
              >
                branch {node.branchLevel}
              </span>
            )}
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
            // w-full + min-w-0 on the parent button is what lets
            // `truncate` actually clip — without min-w-0 the flex
            // child stretches to its content width and pushes the
            // row past the modal edge.
            <p className="w-full truncate text-[11px] text-neutral-300">{node.preview}</p>
          )}
        </button>
      </div>
    </li>
  );
}

/**
 * Flatten the SDK's parentId-linked entry list into a depth-first
 * order suitable for a flat indented list. Tracks which entries are
 * on the active branch path (for highlighting) and how many siblings
 * each branchpoint has (so we can hint at divergences).
 *
 * Indent depth is **role-based, not parent-chain-based**. The
 * conversation flow we want users to see is:
 *
 *   user (0) ────────── flush left
 *     assistant (1) ── one step in
 *       tool (2) ──── two steps in
 *
 * Using the literal parentId chain depth would push every later
 * message progressively further right (depth grows monotonically
 * with conversation length) which is meaningless visually. Branches
 * are still visible via the `⑂ N` siblings badge on the diverging
 * parent — repeated user messages at depth 0 read as "different
 * attempts at the same turn", which is exactly what they are.
 *
 * Non-message entries (compaction, branch_summary, model_change,
 * etc.) are pinned at depth 0 — they're meta events, not part of
 * the user/assistant exchange.
 */
function depthForEntry(entry: SessionTreeEntry): number {
  if (entry.type !== "message") return 0;
  if (entry.role === "user") return 0;
  if (entry.role === "tool") return 2;
  // assistant + system + anything else the SDK might add later
  return 1;
}

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
  // DFS traversal: each subtree carries the branchLevel from its
  // entry point. Within a parent's children, the FIRST child
  // continues the parent's branch (same level); each subsequent
  // child starts a new divergence (level + 1) and propagates that
  // through its descendants.
  const visit = (parentId: string | null, branchLevel: number): void => {
    const list = childrenByParent.get(parentId);
    if (list === undefined) return;
    const siblings = list.length;
    list.forEach((e, idx) => {
      const childLevel = idx === 0 ? branchLevel : branchLevel + 1;
      const isBranchHead = idx > 0 && childLevel > 0;
      out.push({
        ...e,
        depth: depthForEntry(e),
        branchLevel: childLevel,
        onActivePath: onPath.has(e.id),
        isLeaf: tree.leafId === e.id,
        siblings,
        isBranchHead,
      });
      visit(e.id, childLevel);
    });
  };
  visit(null, 0);
  return out;
}

/**
 * Stable per-branch accent color. Used for the left-border stripe
 * and the "branch N" badge so sibling branches are colour-coded.
 * Cycles through a small palette so the same level always renders
 * the same color across re-fetches; reads on dark backgrounds.
 * `branchLevel === 0` (the original conversation) doesn't get an
 * accent — the row's normal border serves as its baseline.
 */
const BRANCH_PALETTE = [
  "#f59e0b", // amber-500
  "#0ea5e9", // sky-500
  "#ec4899", // pink-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#f97316", // orange-500
];
function branchAccent(level: number): string {
  if (level <= 0) return "transparent";
  return BRANCH_PALETTE[(level - 1) % BRANCH_PALETTE.length]!;
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
