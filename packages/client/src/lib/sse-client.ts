import { ApiError, UNAUTHORIZED_EVENT } from "./api-client";
import { clearStoredToken, getStoredToken } from "./auth-client";

/**
 * Minimal SSE reader that uses fetch + ReadableStream so we can send the
 * `Authorization` header. The native `EventSource` API does not support
 * custom headers, so we cannot use it for our bearer-auth model.
 *
 * What this DOES handle (Phase 5):
 *   - Connect with bearer token (or skip when auth is disabled).
 *   - Parse `data: <json>\n\n` framed events; ignore comment/keepalive
 *     lines; accept `\r\n\r\n` separators per the W3C SSE spec.
 *   - Surface ApiError(0, "network_error") on connection failure and
 *     ApiError(status, ...) on non-2xx responses, mirroring api-client.
 *   - Clean teardown when the caller aborts via AbortSignal.
 *
 * What this does NOT yet handle (deferred to Phase 9 UI integration):
 *   - Auto-reconnect with exponential backoff.
 *   - Snapshot replay against a Zustand store.
 *   - skipAuth flag for unauthenticated probe streams.
 * All three land once a chat surface exists to drive them.
 *
 * Error contract: errors are delivered via the resolved promise rejecting
 * with an `ApiError` (network or non-2xx) or the underlying error (parse,
 * stream). Callers register handling via `try/catch` or `.catch()` — the
 * helper does NOT also call an `onError` callback, so consumers don't
 * have to deduplicate. AbortSignal-driven cancellation resolves the
 * promise normally rather than rejecting.
 */
export interface StreamSSEOptions<T> {
  signal?: AbortSignal;
  /** Called once per parsed event. Sync or async — the reader awaits. */
  onEvent: (event: T) => void | Promise<void>;
  /** Called once when the stream ends cleanly (server EOF). */
  onClose?: () => void;
}

export async function streamSSE<T extends { type: string }>(
  path: string,
  opts: StreamSSEOptions<T>,
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const stored = getStoredToken();
  if (stored) headers.Authorization = `Bearer ${stored.token}`;

  const init: RequestInit = { method: "GET", headers };
  if (opts.signal !== undefined) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw new ApiError(0, "network_error", (err as Error).message);
  }

  if (res.status === 401) {
    clearStoredToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  if (!res.ok || res.body === null) {
    throw new ApiError(res.status, "stream_open_failed");
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalize CRLF → LF on append so the `\n\n` parser also catches
      // the spec-mandated `\r\n\r\n` form a reverse proxy may inject.
      buffer += value.replace(/\r\n/g, "\n");

      // SSE messages are delimited by a blank line (\n\n). Pull complete
      // messages off the front of the buffer; leave any partial trailing
      // chunk for the next read.
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const message = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of message.split("\n")) {
          if (line.startsWith(":")) continue; // SSE comment / keepalive
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          // Other SSE field types (event:, id:, retry:) are ignored — we
          // only emit data-only frames from the bridge.
        }
        if (dataLines.length > 0) {
          const payload = dataLines.join("\n");
          try {
            const parsed = JSON.parse(payload) as T;
            await opts.onEvent(parsed);
          } catch {
            // Malformed frame — drop it. Per dev plan: unknown event types
            // and bad payloads must not crash the client.
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
    opts.onClose?.();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
