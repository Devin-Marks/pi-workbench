import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { LiveSession, SSEClient } from "./session-registry.js";

/**
 * One-shot snapshot event sent immediately on SSE connect so the browser can
 * hydrate full session state without a separate HTTP round-trip.
 */
export interface SnapshotEvent {
  type: "snapshot";
  sessionId: string;
  projectId: string;
  messages: AgentMessage[];
  isStreaming: boolean;
}

/**
 * Event types we forward to browser clients. Anything else from the SDK is
 * dropped on the floor — keeps the wire stream stable across SDK upgrades and
 * matches the dev-plan catalog.
 */
const ALLOWED_EVENT_TYPES = new Set<string>([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "snapshot",
]);

export function isAllowedEvent(event: { type: string }): boolean {
  return ALLOWED_EVENT_TYPES.has(event.type);
}

/**
 * Serialize an event into the SSE wire format. Returns the full chunk
 * including the trailing blank line that delimits messages.
 */
export function serializeSSE(event: object & { type: string }): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a snapshot from the current LiveSession state. Pulled out so callers
 * (and tests) can assert the same shape the bridge sends on connect.
 */
export function buildSnapshot(live: LiveSession): SnapshotEvent {
  return {
    type: "snapshot",
    sessionId: live.sessionId,
    projectId: live.projectId,
    messages: live.session.messages,
    isStreaming: live.session.isStreaming,
  };
}

/**
 * Hijack the Fastify reply and turn it into a long-lived SSE stream attached
 * to `live.clients`. Sends a snapshot immediately, forwards filtered
 * AgentSessionEvents, and unregisters on socket close.
 *
 * The caller's route handler should NOT call `reply.send()` — `hijack()`
 * tells Fastify the response is being driven manually.
 *
 * Throws if the prelude (writeHead / snapshot write) fails. The caller is a
 * route handler that has already hijacked, so Fastify's reply.send(err)
 * fallback is a no-op; this function destroys the underlying socket on
 * failure so the client doesn't hang waiting for headers.
 */
export function createSSEClient(reply: FastifyReply, live: LiveSession): SSEClient {
  reply.hijack();
  const raw = reply.raw;

  // Closure state — declared up here so the prelude's catch can clean up
  // even if `client` was never finalized.
  let registeredClient: SSEClient | undefined;
  let closed = false;

  // The whole prelude (headers, registration, snapshot) is guarded as one
  // unit. Anything that throws here would otherwise hang the client socket:
  // after hijack() Fastify's wrap-thenable.js catches the throw and calls
  // reply.send(err), which is a no-op because reply.sent === true post-hijack.
  // Net result without this guard: no headers, no body, no end → connection
  // hangs until the OS times out. So on any prelude failure we destroy the
  // raw socket and remove the partially-registered client from the registry.
  try {
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx, Caddy) so events flush immediately.
      "X-Accel-Buffering": "no",
    });

    const id = randomUUID();

    /**
     * Direct raw write that bypasses the event filter. Used for synthetic
     * frames the bridge owns (snapshot today; heartbeats / keepalive in
     * later phases). Filter-bypass cannot leak SDK events because callers
     * supply already-shaped objects.
     */
    const writeRaw = (chunk: string): void => {
      if (closed) return;
      try {
        raw.write(chunk);
      } catch {
        close();
      }
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (registeredClient !== undefined) live.clients.delete(registeredClient);
      try {
        raw.end();
      } catch {
        // socket already torn down — fine
      }
    };

    const send = (event: AgentSessionEvent | { type: string; [k: string]: unknown }): void => {
      if (closed) return;
      if (!isAllowedEvent(event)) return;
      writeRaw(serializeSSE(event));
    };

    const client: SSEClient = { id, send, close };
    registeredClient = client;
    live.clients.add(client);

    // Snapshot bypass — uses writeRaw, the same surface a future heartbeat
    // would use. Server-issued synthetic frames flow through writeRaw;
    // SDK-relayed events flow through send (which applies the filter).
    writeRaw(serializeSSE(buildSnapshot(live)));

    // Wire close listeners AFTER the snapshot write so an immediate socket
    // close can't double-fire close() before the registry is in a coherent
    // state. Node's 'close' event fires next-tick anyway, but explicit
    // ordering is cheap insurance.
    raw.on("close", close);
    raw.on("error", close);

    return client;
  } catch (err) {
    // Prelude failure — clean up partial state and tear the socket down so
    // the client gets a connection drop instead of a hung half-open socket.
    closed = true;
    if (registeredClient !== undefined) live.clients.delete(registeredClient);
    try {
      raw.destroy();
    } catch {
      // already destroyed
    }
    throw err;
  }
}
