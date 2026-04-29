import { useEffect, useState } from "react";
import { FileDiff } from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

/**
 * Inline button under ChatView showing "N changed file(s)" whenever
 * the latest turn touched files. Clicking opens the right pane on
 * the Changes tab. The badge unmounts when:
 *   - the count is 0 (nothing to review), OR
 *   - the user is already viewing the Changes pane (no point nudging
 *     to open what they're already on).
 *
 * Refreshes once per `agent_end` via the session-store's counter,
 * matching how TurnDiffPanel and useGitStatus react to the same
 * signal.
 */
export function ChangedFilesBadge({
  sessionId,
  alreadyOnChangesTab,
  onOpen,
}: {
  sessionId: string;
  alreadyOnChangesTab: boolean;
  onOpen: () => void;
}) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const agentEndCount = useSessionStore((s) => s.agentEndCountBySession[sessionId] ?? 0);

  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    // Reset on session switch so the previous session's count doesn't
    // leak briefly into the new one.
    setCount(0);
  }, [sessionId]);

  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    api
      .getTurnDiff(sessionId)
      .then((r) => {
        if (!cancelled) setCount(r.entries.length);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 404 → cold session with no live turn-diff; treat as 0
        // silently. Other errors (500, network drops) shouldn't be
        // mistaken for "no changes" — log so a server regression
        // doesn't silently hide the badge.
        if (err instanceof ApiError && err.status === 404) {
          setCount(0);
        } else {
          if (typeof console !== "undefined") {
            console.warn("[ChangedFilesBadge] turn-diff fetch failed:", err);
          }
          setCount(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, agentEndCount, isStreaming]);

  if (count === 0 || alreadyOnChangesTab) return null;

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-6 pt-2">
      <div className="mx-auto max-w-3xl">
        <button
          onClick={onOpen}
          className="flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800"
          title="Open the Changes pane to review what the agent just wrote"
        >
          <FileDiff size={12} />
          {count === 1 ? "1 changed file" : `${count} changed files`}
          <span className="text-[10px] text-neutral-500">— review</span>
        </button>
      </div>
    </div>
  );
}
