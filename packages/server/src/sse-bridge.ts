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
 */
export function createSSEClient(reply: FastifyReply, live: LiveSession): SSEClient {
  reply.hijack();

  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx, Caddy) so events flush immediately.
    "X-Accel-Buffering": "no",
  });

  const id = randomUUID();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    live.clients.delete(client);
    try {
      raw.end();
    } catch {
      // socket already torn down — fine
    }
  };

  const send = (event: AgentSessionEvent | { type: string; [k: string]: unknown }): void => {
    if (closed) return;
    if (!isAllowedEvent(event)) return;
    try {
      raw.write(serializeSSE(event));
    } catch {
      // Write failed — socket is dead. Drop the client.
      close();
    }
  };

  const client: SSEClient = { id, send, close };

  // Register before sending the snapshot so any event that fires during the
  // microtask gap also hits this client. Set is in iteration-safe state.
  live.clients.add(client);

  // Snapshot bypass: write directly so we don't have to make `send()`
  // skip the filter for a single special case. `snapshot` IS in the
  // allowlist so this could go through send() too — direct write is just
  // explicit about the unconditionality.
  try {
    raw.write(serializeSSE(buildSnapshot(live)));
  } catch {
    close();
    return client;
  }

  raw.on("close", close);
  raw.on("error", close);

  return client;
}
