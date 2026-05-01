import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileCode,
  GitBranch,
  Rows2,
} from "lucide-react";
import {
  EMPTY_MESSAGES,
  EMPTY_STRING,
  useSessionStore,
  type ActiveTool,
  type AgentMessageLike,
} from "../store/session-store";
import { useActiveProject } from "../store/project-store";
import { DiffBlock } from "./DiffBlock";
import { SessionTreePanel } from "./SessionTreePanel";

/**
 * Per-ChatView diff view-type preference. Each diff-rendering surface
 * has its own setting (TurnDiffPanel uses `pi.turnDiff.viewType`,
 * GitPanel uses `pi.gitPanel.viewType`); chat inline edit-tool diffs
 * use `pi.chat.viewType`. Toggling one panel doesn't affect the
 * others — different mental contexts often want different layouts.
 *
 * The hover-revealed toggle on each `<details>` summary updates the
 * chat-wide pref via Context, so one click flips every other chat
 * diff currently rendered without remounting.
 */
type ChatViewType = "unified" | "split";
const ChatDiffViewContext = createContext<{
  viewType: ChatViewType;
  setViewType: (next: ChatViewType) => void;
}>({
  viewType: "unified",
  setViewType: () => undefined,
});

const CHAT_VIEW_TYPE_KEY = "pi.chat.viewType";
function readChatViewType(): ChatViewType {
  try {
    return localStorage.getItem(CHAT_VIEW_TYPE_KEY) === "split" ? "split" : "unified";
  } catch {
    // Private-mode storage — pick the default view type.
    return "unified";
  }
}

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

  const [chatViewType, setChatViewType] = useState<ChatViewType>(readChatViewType);
  const setAndPersistChatViewType = (next: ChatViewType): void => {
    setChatViewType(next);
    try {
      localStorage.setItem(CHAT_VIEW_TYPE_KEY, next);
    } catch {
      // ignore — choice still applies for this session
    }
  };

  // Phase 15 — session tree overlay. The button lives in a tiny
  // toolbar above the scroll container so it's always visible
  // regardless of how far the user has scrolled.
  const project = useActiveProject();
  const [treeOpen, setTreeOpen] = useState(false);

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
    <ChatDiffViewContext.Provider
      value={{ viewType: chatViewType, setViewType: setAndPersistChatViewType }}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Chat-level toolbar. Single button today (session tree); add
            future per-session controls (export, copy session id, etc.)
            here. Pinned above the scroll container so the affordance
            stays reachable from any scroll position. */}
        <div className="flex items-center justify-end gap-1 border-b border-neutral-800 bg-neutral-900/30 px-3 py-1">
          <button
            onClick={() => setTreeOpen(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Open session tree (navigate / fork from any prior point)"
          >
            <GitBranch size={11} />
            Tree
          </button>
        </div>
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
            {isStreaming && streamingText.length === 0 && (
              <ActiveToolPlaceholder tool={activeTool} />
            )}
            {queued !== undefined && <QueuedMessages queued={queued} />}
          </div>
        </div>
      </div>
      {treeOpen && project !== undefined && (
        <SessionTreePanel
          sessionId={sessionId}
          projectId={project.id}
          onClose={() => setTreeOpen(false)}
        />
      )}
    </ChatDiffViewContext.Provider>
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
        {all.map((q) => (
          // Key on (kind, text). Pi clears delivered queue items by
          // emitting a smaller queue_update; index would shift and
          // index-based keys would remount items into different DOM
          // slots. Even with text duplicates the visual is identical
          // — a re-mount is harmless.
          <li
            key={`${q.kind}:${q.text}`}
            className="flex items-baseline gap-2 text-xs text-neutral-300"
          >
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

/**
 * Wrapper for the inline edit-tool diff in chat. Reads the chat-wide
 * view-type pref via Context and renders a hover-revealed toggle on
 * the right side of the `<details>` summary so the user can flip
 * unified ↔ split without leaving the chat surface. Toggle is the
 * same Columns2/Rows2 icon pair the panels use, so muscle memory
 * carries.
 */
function ChatEditDiff({
  diff,
  filename,
  adds,
  dels,
}: {
  diff: string;
  filename: string | undefined;
  adds: number;
  dels: number;
}) {
  const { viewType, setViewType } = useContext(ChatDiffViewContext);
  return (
    <details className="group rounded border border-neutral-800 bg-neutral-950 text-xs">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-neutral-300">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-neutral-500">edit{filename !== undefined ? " " : ""}</span>
          {filename !== undefined && <span className="truncate font-mono">{filename}</span>}
          <span className="ml-2 text-emerald-400">+{adds}</span>
          <span className="ml-1 text-red-400">−{dels}</span>
        </span>
        <button
          onClick={(e) => {
            // The summary's default click toggles the <details>; stop
            // propagation so flipping the view doesn't also collapse
            // the diff the user just opened.
            e.preventDefault();
            e.stopPropagation();
            setViewType(viewType === "split" ? "unified" : "split");
          }}
          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={
            viewType === "split"
              ? "Switch chat diffs to unified view"
              : "Switch chat diffs to side-by-side view"
          }
        >
          {viewType === "split" ? <Rows2 size={11} /> : <Columns2 size={11} />}
        </button>
      </summary>
      <DiffBlock diff={diff} viewType={viewType} />
    </details>
  );
}

/**
 * Extract every file reference embedded in a stored user-message text
 * and strip the underlying tokens from the visible text.
 *
 * Two forms come through, both rendered as badges in the bubble:
 *   - "inlined": fenced ``` `<lang> file: <path>` ```-style blocks
 *     that the server's expandFileReferences (or multipart text-file
 *     composer) emitted. Content is included; the badge expands to
 *     show it.
 *   - "deferred": bare `@<path>` (or `@"path with spaces"`) markers
 *     that the server left for the model to load on demand. No
 *     content; the badge just shows the path with a tooltip.
 *
 * Backreference (`\1`) on the fenced regex matches the closing fence
 * length to the opening, mirroring the longest-run-plus-one logic on
 * the server.
 */
type FileRef =
  | { kind: "inline"; path: string; lang: string; content: string }
  | { kind: "defer"; path: string };

function extractFileRefs(text: string): { stripped: string; refs: FileRef[] } {
  const refs: FileRef[] = [];
  // Step 1: pull out fenced "<lang> file: <path>" blocks.
  const fenceRe = /(`{3,})(\w*)\s+file:\s+([^\n]+)\n([\s\S]*?)\n\1(?=\n|$)/g;
  let stripped = text.replace(
    fenceRe,
    (_match, _fence: string, lang: string, path: string, content: string) => {
      refs.push({ kind: "inline", path: path.trim(), lang, content });
      return "\n";
    },
  );
  // Step 2: pull out bare `@<path>` (or `@"path"`) deferred refs from
  // what's left. Same prefix anchor as the server regex.
  const deferRe = /(^|\s)@(?:"([^"\n]+)"|([^\s]+))/g;
  stripped = stripped.replace(deferRe, (_match, lead: string, quoted: string, bare: string) => {
    const path = (quoted ?? bare ?? "").trim();
    if (path.length > 0) refs.push({ kind: "defer", path });
    // Preserve the leading whitespace/anchor so surrounding text
    // doesn't fuse together.
    return lead;
  });
  // Collapse any 3+ consecutive newlines (from fenced removal) to a
  // single blank line, then trim the whole string.
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return { stripped, refs };
}

function FileRefBadge({ ref: r }: { ref: FileRef }) {
  const [expanded, setExpanded] = useState(false);
  const isInline = r.kind === "inline";
  return (
    <div
      className={`overflow-hidden rounded border bg-neutral-900 ${
        isInline ? "border-neutral-700" : "border-emerald-700/60 bg-emerald-900/15"
      }`}
    >
      <button
        type="button"
        onClick={() => isInline && setExpanded((v) => !v)}
        disabled={!isInline}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] ${
          isInline ? "text-neutral-200 hover:bg-neutral-800" : "cursor-default text-emerald-200"
        }`}
        title={
          isInline
            ? `${r.path} — click to ${expanded ? "collapse" : "expand"}`
            : `${r.path} — model will load this on demand using its read tool (file is larger than the inline threshold)`
        }
      >
        {isInline ? (
          expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : (
          <AtSign size={12} className="text-emerald-300/80" />
        )}
        <FileCode size={12} className={isInline ? "text-neutral-400" : "text-emerald-300/80"} />
        <span className="font-mono">{r.path}</span>
        {isInline && (
          <span className="text-[10px] text-neutral-500">
            {r.content.length < 1024
              ? `${r.content.length} B`
              : `${(r.content.length / 1024).toFixed(1)} KB`}
          </span>
        )}
        {!isInline && <span className="text-[10px] text-emerald-300/70">on demand</span>}
      </button>
      {isInline && expanded && (
        <pre className="max-h-72 overflow-auto border-t border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-300">
          {r.content}
        </pre>
      )}
    </div>
  );
}

function Message({ message }: { message: AgentMessageLike }) {
  // User text messages — may include image + file attachments per
  // Phase 14. Optimistic shape uses a blob URL on the image block;
  // canonical refetched shape uses raw base64 with a mimeType, which
  // we render via a data URL.
  if (message.role === "user") {
    const rawText = extractText(message);
    const { stripped: text, refs: fileRefs } = extractFileRefs(rawText);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const images: { src: string; key: string }[] = [];
    const files: { name: string; size?: number; key: string }[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Record<string, unknown>;
      if (b.type === "image") {
        const data = typeof b.data === "string" ? b.data : "";
        const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
        // Optimistic blocks set `__blobUrl`; treat `data` as a
        // direct blob URL. Canonical blocks store raw base64; build
        // a data URL on the fly.
        const isBlob = b.__blobUrl === true;
        const src = isBlob ? data : `data:${mime};base64,${data}`;
        if (data.length > 0) images.push({ src, key: `img-${i}` });
      } else if (b.type === "file") {
        const name = typeof b.filename === "string" ? b.filename : "attachment";
        const file: { name: string; size?: number; key: string } = { name, key: `file-${i}` };
        if (typeof b.size === "number") file.size = b.size;
        files.push(file);
      }
    }
    return (
      <div className="rounded-lg bg-neutral-800 px-4 py-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-400">you</div>
        {text.length > 0 && (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-neutral-100">
            {text}
          </pre>
        )}
        {fileRefs.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {fileRefs.map((r, i) => (
              <FileRefBadge key={`fileref-${i}-${r.path}`} ref={r} />
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <img
                key={img.key}
                src={img.src}
                alt=""
                className="max-h-48 max-w-full rounded border border-neutral-700"
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <span
                key={f.key}
                className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300"
                title={f.name}
              >
                <span className="font-mono">{f.name}</span>
                {f.size !== undefined && (
                  <span className="text-[10px] text-neutral-500">
                    {f.size < 1024
                      ? `${f.size} B`
                      : f.size < 1024 * 1024
                        ? `${(f.size / 1024).toFixed(1)} KB`
                        : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
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

  // Bash execution messages — surface via either the SDK's native
  // `role: "bashExecution"` BashExecutionMessage (the `!` chat input
  // path appends these via session.sessionManager.appendMessage) or
  // the custom-message-entry shape some flows produce.
  if (
    message.role === "bashExecution" ||
    message.type === "bashExecution" ||
    message.customType === "bashExecution"
  ) {
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
    return <ChatEditDiff diff={diff} filename={fn} adds={adds} dels={dels} />;
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
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
  const truncated = message.truncated === true;
  const cancelled = message.cancelled === true;
  const excluded = message.excludeFromContext === true;
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 text-xs">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-neutral-400">
        <div className="min-w-0 flex-1 truncate">
          <span className="text-neutral-500">$ </span>
          <span className="font-mono text-neutral-200">{command}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {excluded && (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400"
              title="!! prefix — kept out of LLM context on the next turn"
            >
              local-only
            </span>
          )}
          {cancelled && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
              timed out
            </span>
          )}
          {truncated && !cancelled && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
              truncated
            </span>
          )}
          {exitCode !== undefined && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                exitCode === 0 ? "bg-emerald-900/30 text-emerald-300" : "bg-red-900/30 text-red-300"
              }`}
              title={exitCode === 0 ? "exit 0" : `exit ${String(exitCode)}`}
            >
              exit {exitCode}
            </span>
          )}
        </div>
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
