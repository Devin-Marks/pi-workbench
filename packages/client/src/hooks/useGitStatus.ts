import { useEffect, useState } from "react";
import { api, ApiError, type GitStatus } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

const POLL_INTERVAL_MS = 5_000;

/**
 * Polls `GET /git/status` every 5s for the given project. Pauses
 * while any active session is streaming (no point thrashing the
 * server while the agent is mid-turn — `git status` would race the
 * agent's writes anyway). Fires once after streaming flips back
 * to false (the agent_end proxy).
 *
 * Returns `undefined` until the first response lands, then the
 * latest status snapshot. Errors are stored separately so a
 * transient network blip doesn't blank the UI.
 */
export function useGitStatus(projectId: string | undefined): {
  status: GitStatus | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<GitStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // We watch the active session's streaming flag. A user with no
  // session selected won't have a streaming flag, so we pass through
  // false (poll runs at the normal cadence).
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isStreaming = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.streamingBySession[activeSessionId] ?? false) : false,
  );

  const refresh = async (): Promise<void> => {
    if (projectId === undefined) return;
    try {
      const next = await api.gitStatus(projectId);
      setStatus(next);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  // Reset between projects so we don't show one project's status
  // briefly when the user switches.
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
  }, [projectId]);

  useEffect(() => {
    if (projectId === undefined) return undefined;
    let cancelled = false;
    void refresh();
    if (isStreaming) return () => undefined;
    const id = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isStreaming]);

  return { status, error, refresh };
}
