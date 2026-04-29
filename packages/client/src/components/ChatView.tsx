import { useEffect, useRef } from "react";
import {
  EMPTY_MESSAGES,
  EMPTY_STRING,
  useSessionStore,
  type ActiveTool,
  type AgentMessageLike,
} from "../store/session-store";
import { DiffBlock } from "./DiffBlock";

interface Props {
  sessionId: string;
}

/**
 * Phase 8 chat surface. Renders the SDK's AgentMessage union heuristically —
 * matches on `role` and `type` to pick a renderer per message kind. The shape
 * detection lives at the renderer boundary rather than in the store so we
 * don't couple the bundle to SDK type internals.
 *
 * Markdown rendering is deliberately rough (paragraphs only). `react-markdown`
 * + `remark-gfm` are installed; wiring full markdown is a polish step that
 * can land alongside the diff viewer (Phase 12).
 */
export function ChatView({ sessionId }: Props) {
  // EMPTY_* fallbacks are stable module-level constants — using `?? []` here
  // would return a new ref each render and trip React 18's
  // useSyncExternalStore infinite-loop guard. See session-store.ts.
  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const streamingText = useSessionStore((s) => s.streamingTextBySession[sessionId] ?? EMPTY_STRING);
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const activeTool = useSessionStore((s) => s.activeToolBySession[sessionId]);
  const banner = useSessionStore((s) => s.bannerBySession[sessionId]);
  const queued = useSessionStore((s) => s.queuedBySession[sessionId]);
  const openStream = useSessionStore((s) => s.openStream);
  const closeStream = useSessionStore((s) => s.closeStream);

  // Open SSE on mount, close on unmount/session change. The store ensures
  // openStream is idempotent for the same id.
  useEffect(() => {
    openStream(sessionId);
    return () => {
      closeStream(sessionId);
    };
  }, [sessionId, openStream, closeStream]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // "Sticky bottom" scroll: track the user's INTENT in a ref via the
  // onScroll handler, then auto-scroll only when intent says "follow."
  //
  // Why a ref and not a re-measure inside the effect: by the time the
  // effect fires, the new streaming text has already inflated scrollHeight,
  // so `scrollHeight - scrollTop - clientHeight` is artificially large —
  // the check would always say "user scrolled away" during streaming and
  // auto-scroll would never fire. Reading the ref reflects the user's
  // last actual scroll position before the content grew.
  const NEAR_BOTTOM_PX = 96;
  const isFollowingBottomRef = useRef(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isFollowingBottomRef.current = distance <= NEAR_BOTTOM_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (isFollowingBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, isStreaming]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Banner sits ABOVE the scroll container so it stays pinned to the top
          of the chat view regardless of how far the user has scrolled into a
          long session. Earlier we rendered it inside the scroll container,
          which meant a long-running streaming session pushed the
          "Reconnecting…" / compaction banners off-screen. */}
      {banner !== undefined && (
        <div className="border-b border-amber-700/40 bg-amber-900/20 px-6 py-2 text-xs text-amber-200">
          {banner}
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && streamingText.length === 0 && !isStreaming && (
          <p className="mt-12 text-center text-sm text-neutral-500">
            No messages yet. Send a prompt to get started.
          </p>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m, i) => (
            <Message key={i} message={m} />
          ))}
          {streamingText.length > 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                assistant (streaming)
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm text-neutral-100">
                {streamingText}
                <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-neutral-300" />
              </pre>
            </div>
          )}
          {isStreaming && streamingText.length === 0 && <ActiveToolPlaceholder tool={activeTool} />}
          {queued !== undefined && <QueuedMessages queued={queued} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline badge listing messages the user has queued during the
 * current run. Pi delivers `steering` at the next agent decision
 * point (mid-tool boundary) and `followUp` once the agent goes idle.
 * The SDK clears these on delivery, which fires another queue_update
 * with the new (smaller) arrays — no need to pop locally.
 */
function QueuedMessages({ queued }: { queued: { steering: string[]; followUp: string[] } }) {
  const all: { kind: "steer" | "followUp"; text: string }[] = [];
  for (const text of queued.steering) all.push({ kind: "steer", text });
  for (const text of queued.followUp) all.push({ kind: "followUp", text });
  if (all.length === 0) return null;
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        queued ({all.length})
      </div>
      <ul className="space-y-1">
        {all.map((q, i) => (
          <li key={i} className="flex items-baseline gap-2 text-xs text-neutral-300">
            <span
              className={
                q.kind === "steer"
                  ? "shrink-0 rounded bg-amber-900/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300"
                  : "shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400"
              }
              title={
                q.kind === "steer"
                  ? "Delivered at the agent's next decision point (often mid-tool)"
                  : "Delivered after the agent goes fully idle"
              }
            >
              {q.kind === "steer" ? "steer" : "follow-up"}
            </span>
            <span className="truncate">{q.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Pre-text placeholder while the agent is busy. If a tool is currently
 * executing we render its name + a one-line summary ("running `bash`:
 * `ls`") so the user sees what the agent is doing instead of an opaque
 * spinner. Outside tool execution we fall back to "Thinking…".
 */
function ActiveToolPlaceholder({ tool }: { tool: ActiveTool | undefined }) {
  if (tool === undefined) {
    return <div className="text-xs italic text-neutral-500">Thinking…</div>;
  }
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400" />
      <span className="text-neutral-500">running</span>
      <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200">
        {tool.name}
      </code>
      {tool.summary !== undefined && (
        <code
          className="truncate rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
          title={tool.summary}
        >
          {tool.summary}
        </code>
      )}
    </div>
  );
}

function Message({ message }: { message: AgentMessageLike }) {
  // User text messages
  if (message.role === "user") {
    const text = extractText(message);
    return (
      <div className="rounded-lg bg-neutral-800 px-4 py-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-400">you</div>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-neutral-100">
          {text}
        </pre>
      </div>
    );
  }

  // Assistant messages — content is an array of TextContent / ThinkingContent / ToolCall.
  if (message.role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">assistant</div>
        <div className="space-y-2 text-sm text-neutral-100">
          {content.map((block, i) => (
            <AssistantBlock key={i} block={block as Record<string, unknown>} />
          ))}
        </div>
      </div>
    );
  }

  // Tool result messages — render based on toolName.
  if (message.role === "toolResult") {
    return <ToolResult message={message} />;
  }

  // Bash execution messages (custom type).
  if (message.type === "bashExecution" || message.customType === "bashExecution") {
    return <BashExecution message={message} />;
  }

  // Fallback: stringify so we can see what we missed.
  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400">
      <summary className="cursor-pointer">
        unknown message ({String(message.role ?? message.type ?? "?")})
      </summary>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-500">
        {JSON.stringify(message, null, 2)}
      </pre>
    </details>
  );
}

function AssistantBlock({ block }: { block: Record<string, unknown> }) {
  const type = block.type;

  if (type === "text" && typeof block.text === "string") {
    return <pre className="whitespace-pre-wrap break-words font-sans">{block.text}</pre>;
  }

  if (type === "thinking" && typeof block.thinking === "string") {
    return (
      <details className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400">
        <summary className="cursor-pointer">Thinking…</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[12px]">
          {block.thinking}
        </pre>
      </details>
    );
  }

  if (type === "toolCall") {
    const name = String(block.name ?? "tool");
    const args = block.input ?? block.arguments ?? {};
    return (
      <div className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs">
        <div className="mb-1 text-neutral-300">
          <span className="text-neutral-500">→ </span>
          <span className="font-mono">{name}</span>
        </div>
        <pre className="overflow-auto text-[11px] text-neutral-400">
          {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">block ({String(type ?? "?")})</summary>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[10px]">
        {JSON.stringify(block, null, 2)}
      </pre>
    </details>
  );
}

function ToolResult({ message }: { message: AgentMessageLike }) {
  const toolName = String(message.toolName ?? "tool");
  const isError = message.isError === true;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => {
      const o = c as { type?: unknown; text?: unknown };
      return o.type === "text" && typeof o.text === "string";
    })
    .map((c) => c.text)
    .join("\n");

  // Special-case the few known tools the dev plan calls out.
  if (toolName === "edit") {
    const details = message.details as { diff?: string } | undefined;
    const diff = typeof details?.diff === "string" ? details.diff : text;
    const fn = extractFilename(message);
    const { adds, dels } = countDiffLines(diff);
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950 text-xs">
        <summary className="cursor-pointer px-3 py-2 text-neutral-300">
          <span className="text-neutral-500">edit{fn !== undefined ? " " : ""}</span>
          {fn !== undefined && <span className="font-mono">{fn}</span>}
          <span className="ml-2 text-emerald-400">+{adds}</span>
          <span className="ml-1 text-red-400">−{dels}</span>
        </summary>
        <DiffBlock diff={diff} />
      </details>
    );
  }

  if (toolName === "read") {
    const fn = extractFilename(message);
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950 text-xs">
        <summary className="cursor-pointer px-3 py-2 text-neutral-300">
          <span className="text-neutral-500">read{fn !== undefined ? " " : ""}</span>
          {fn !== undefined && <span className="font-mono">{fn}</span>}
        </summary>
        <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
      </details>
    );
  }

  if (toolName === "bash") {
    const cmd = extractCommand(message);
    return (
      <div
        className={`rounded border ${isError ? "border-red-700/40" : "border-neutral-800"} bg-neutral-950 text-xs`}
      >
        <div className="px-3 py-2 text-neutral-400">
          <span className="text-neutral-500">bash{cmd !== undefined ? " → " : " output"}</span>
          {cmd !== undefined && <span className="font-mono">{cmd}</span>}
        </div>
        <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">
          {text}
        </pre>
      </div>
    );
  }

  if (toolName === "write") {
    const fn = extractFilename(message);
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950 text-xs">
        <summary className="cursor-pointer px-3 py-2 text-neutral-300">
          <span className="text-neutral-500">write{fn !== undefined ? " " : ""}</span>
          {fn !== undefined && <span className="font-mono">{fn}</span>}
          <span className="ml-2 text-neutral-500">({text.split("\n").length} lines)</span>
        </summary>
        <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
      </details>
    );
  }

  // Generic tool result fallback.
  return (
    <details
      className={`rounded border ${isError ? "border-red-700/40" : "border-neutral-800"} bg-neutral-950 text-xs`}
    >
      <summary className="cursor-pointer px-3 py-2 text-neutral-300">
        <span className="text-neutral-500">{toolName}</span>
        {isError && <span className="ml-2 text-red-400">error</span>}
      </summary>
      <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
    </details>
  );
}

function BashExecution({ message }: { message: AgentMessageLike }) {
  const command = String(message.command ?? "");
  const output = String(message.output ?? "");
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 text-xs">
      <div className="px-3 py-2 text-neutral-400">
        <span className="text-neutral-500">$ </span>
        <span className="font-mono">{command}</span>
      </div>
      {output.length > 0 && (
        <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">
          {output}
        </pre>
      )}
    </div>
  );
}

function extractText(message: AgentMessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => {
        const o = c as { type?: unknown; text?: unknown };
        return o.type === "text" && typeof o.text === "string";
      })
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function extractFilename(message: AgentMessageLike): string | undefined {
  // The shape of `details` varies per tool and per SDK version. Try the
  // common paths; return undefined (and let the caller drop the label)
  // rather than show "(unknown file)" — the toolCall block on the
  // preceding assistant message already names the target.
  const details = message.details as
    | { path?: unknown; filename?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  const input = message.input as
    | { path?: unknown; filename?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  for (const src of [details, input]) {
    if (src === undefined) continue;
    if (typeof src.path === "string") return src.path;
    if (typeof src.filename === "string") return src.filename;
    if (typeof src.file === "string") return src.file;
    if (typeof src.file_path === "string") return src.file_path;
  }
  return undefined;
}

/**
 * Cheap +/- counter for the chat tool-result summary. The full diff
 * renderer (`DiffBlock` → `react-diff-view`) parses the same text
 * structurally; we only need scalar counts for the collapsed summary.
 */
function countDiffLines(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) dels += 1;
  }
  return { adds, dels };
}

function extractCommand(message: AgentMessageLike): string | undefined {
  // Same story as extractFilename — bash details may carry the command in
  // a few places depending on SDK version. Drop the label if absent.
  const details = message.details as { command?: unknown } | undefined;
  const input = message.input as { command?: unknown } | undefined;
  if (typeof details?.command === "string") return details.command;
  if (typeof input?.command === "string") return input.command;
  return undefined;
}
