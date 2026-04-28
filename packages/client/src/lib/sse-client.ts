import { ApiError } from "./api-client";
import { clearStoredToken, getStoredToken } from "./auth-client";

/**
 * Minimal SSE reader that uses fetch + ReadableStream so we can send the
 * `Authorization` header. The native `EventSource` API does not support
 * custom headers, so we cannot use it for our bearer-auth model.
 *
 * What this DOES handle (Phase 5):
 *   - Connect with bearer token (or skip when auth is disabled).
 *   - Parse `data: <json>\n\n` framed events; ignore comment/keepalive lines.
 *   - Surface ApiError(0, "network_error") on connection failure and
 *     ApiError(status, ...) on non-2xx responses, mirroring api-client.
 *   - Clean teardown when the caller aborts via AbortSignal.
 *
 * What this does NOT yet handle (deferred to Phase 9 UI integration):
 *   - Auto-reconnect with exponential backoff.
 *   - Snapshot replay against a Zustand store.
 * Both are added once a chat surface exists to drive them.
 */
export interface StreamSSEOptions<T> {
  signal?: AbortSignal;
  /** Called once per parsed event. Sync or async — the reader awaits. */
  onEvent: (event: T) => void | Promise<void>;
  /** Called on transport-level error (HTTP non-2xx, network drop). */
  onError?: (err: Error) => void;
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
    const wrapped = new ApiError(0, "network_error", (err as Error).message);
    opts.onError?.(wrapped);
    throw wrapped;
  }

  if (res.status === 401) {
    clearStoredToken();
    window.dispatchEvent(new Event("pi-workbench:unauthorized"));
  }

  if (!res.ok || res.body === null) {
    const err = new ApiError(res.status, "stream_open_failed");
    opts.onError?.(err);
    throw err;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

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
    const wrapped = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(wrapped);
    throw wrapped;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
