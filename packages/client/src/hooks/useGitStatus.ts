import { useEffect, useRef, useState } from "react";
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
 *
 * Project-switch race: an in-flight `refresh()` call retains the
 * old `projectId` in its closure, so if the user switches projects
 * while a poll is on the wire, the old response would otherwise
 * overwrite the freshly-reset state. We track the "current" project
 * in a ref + an epoch counter that bumps on every project change;
 * a refresh discards its result if the epoch shifted while it was
 * in flight. (AbortController would also work but adds API surface
 * the api-client doesn't expose.)
 */
export function useGitStatus(projectId: string | undefined): {
  status: GitStatus | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<GitStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isStreaming = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.streamingBySession[activeSessionId] ?? false) : false,
  );

  // Epoch bumps on every projectId transition. A refresh captures
  // the epoch at call time and bails on land if it no longer
  // matches — guarantees the latest response wins.
  const epochRef = useRef(0);

  const refresh = async (): Promise<void> => {
    if (projectId === undefined) return;
    const myEpoch = epochRef.current;
    const myProjectId = projectId;
    try {
      const next = await api.gitStatus(myProjectId);
      if (epochRef.current !== myEpoch) return; // stale — project switched
      setStatus(next);
      setError(undefined);
    } catch (err) {
      if (epochRef.current !== myEpoch) return;
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  // Reset between projects so we don't show one project's status
  // briefly when the user switches. Bump the epoch FIRST so any
  // in-flight refresh from the old project no-ops on land.
  useEffect(() => {
    epochRef.current += 1;
    setStatus(undefined);
    setError(undefined);
  }, [projectId]);

  useEffect(() => {
    if (projectId === undefined) return undefined;
    void refresh();
    if (isStreaming) return () => undefined;
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isStreaming]);

  return { status, error, refresh };
}
