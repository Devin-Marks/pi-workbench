import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight, Code2, Loader2, RefreshCw, X } from "lucide-react";
import { api, ApiError, type ContextTurn, type SessionContextResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

/**
 * Phase 16 — Context & Token Inspector.
 *
 * Right-pane tab showing the messages the agent will send to the
 * LLM (post-compaction view), aggregate token + cost totals, a
 * per-turn breakdown derived from each AssistantMessage.usage, and
 * the SDK's context-window utilization stat.
 *
 * Auto-refreshes once per `agent_end` via the session-store's
 * counter (same trigger pattern the file tree + TurnDiffPanel use).
 * Manual refresh button on the toolbar covers the gap when the SDK
 * mutates messages outside an agent run (compactions emit a
 * dedicated event the store handles, but this panel just refetches
 * defensively).
 *
 * Raw-JSON view is a portal-style full-modal overlay so the message
 * inspector itself can stay compact in the right pane.
 */
export function ContextInspectorPanel() {
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const agentEndCount = useSessionStore((s) =>
    sessionId !== undefined ? (s.agentEndCountBySession[sessionId] ?? 0) : 0,
  );

  const [data, setData] = useState<SessionContextResponse | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [turnsExpanded, setTurnsExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [rawView, setRawView] = useState<{ index: number; payload: unknown } | undefined>(
    undefined,
  );

  const refresh = async (): Promise<void> => {
    if (sessionId === undefined) {
      setData(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const r = await api.getSessionContext(sessionId);
      setData(r);
    } catch (err) {
      // 404 just means the session isn't loaded yet — clear state
      // rather than scaring the user with a red banner.
      if (err instanceof ApiError && err.status === 404) {
        setData(undefined);
        setError(undefined);
      } else {
        setError(err instanceof ApiError ? err.code : (err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  // Initial load + agent_end refresh. Skip the dep on `refresh`
  // because it's a fresh closure each render and would self-loop.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentEndCount]);

  if (sessionId === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-xs italic text-neutral-500">
        Select a session to inspect its context.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-xs text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">
          Context inspector
        </span>
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={11} className="animate-spin text-neutral-500" />}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error !== undefined && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {data === undefined ? (
          <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
            {loading ? "Loading…" : "No data — try refresh."}
          </div>
        ) : (
          <>
            <TokenSummary
              data={data}
              turnsExpanded={turnsExpanded}
              onToggleTurns={() => setTurnsExpanded((v) => !v)}
            />
            <MessageList
              messages={data.messages}
              showThinking={showThinking}
              onToggleThinking={() => setShowThinking((v) => !v)}
              onViewRaw={(index, payload) => setRawView({ index, payload })}
            />
          </>
        )}
      </div>

      {rawView !== undefined && (
        <RawJsonModal
          title={`Message ${rawView.index} — raw AgentMessage JSON`}
          payload={rawView.payload}
          onClose={() => setRawView(undefined)}
        />
      )}
    </div>
  );
}

/* ------------------------------ token summary ------------------------------ */

function TokenSummary({
  data,
  turnsExpanded,
  onToggleTurns,
}: {
  data: SessionContextResponse;
  turnsExpanded: boolean;
  onToggleTurns: () => void;
}) {
  const cu = data.contextUsage;
  // Always derive the bar percent from tokens / contextWindow rather
  // than honoring the SDK's `percent` field. The SDK reports percent
  // as 0..100 (e.g. 1.19 = 1.19%); my earlier code multiplied that
  // by 100 again and produced "119%" for a session that was actually
  // 1% full. Deriving locally avoids the unit ambiguity entirely.
  //
  // `cu.tokens` is the *current* context-window state — what counts
  // toward the next request's input limit. NOT the lifetime token
  // sum (which inflates with cache reads + every prior turn). When
  // the SDK doesn't have a fresh number (right after compaction),
  // we use the per-message breakdown total below as the estimate.
  const breakdown = useMemo(() => categorizeContext(data.messages), [data.messages]);
  const usageTokens = cu.tokens ?? breakdown.total;
  const usagePct = cu.contextWindow > 0 ? Math.min(1, usageTokens / cu.contextWindow) : 0;
  const usageLabel = cu.tokens === undefined ? "estimate" : "current";
  return (
    <div className="space-y-2 border-b border-neutral-800 px-3 py-2">
      {/* Context-window bar */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] text-neutral-400">
          <span>Context window ({usageLabel})</span>
          <span>
            {formatTokens(usageTokens)} /{" "}
            {cu.contextWindow > 0 ? formatTokens(cu.contextWindow) : "unknown"}
            {cu.contextWindow > 0 && (
              <span className="ml-1 text-neutral-600">({(usagePct * 100).toFixed(1)}%)</span>
            )}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full ${usagePct > 0.9 ? "bg-red-500" : usagePct > 0.7 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.max(2, Math.min(100, usagePct * 100))}%` }}
          />
        </div>
      </div>

      {/* Per-category breakdown — what's *actually* taking up the
          window, derived client-side from the current message array.
          Estimates are ~chars/4 (same heuristic as estimateTokens).
          The SDK doesn't ship a categorized breakdown, so this is
          best-effort and may differ from the provider's true count. */}
      <ContextBreakdown breakdown={breakdown} contextWindow={cu.contextWindow} />

      {/* Lifetime cost + token totals (per-turn sum, NOT current
          context). Cache reads/writes are billing categories — they
          don't represent context occupancy and live here so users
          can reason about cost separately from context fill. */}
      <div className="border-t border-neutral-800 pt-1.5">
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
          Lifetime (per-turn sum)
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
          <div className="flex justify-between">
            <span className="text-neutral-500">Input</span>
            <span className="font-mono text-neutral-200">
              {formatTokens(data.totalInputTokens)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-500">Output</span>
            <span className="font-mono text-neutral-200">
              {formatTokens(data.totalOutputTokens)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-500">Cache read</span>
            <span className="font-mono text-neutral-200">
              {formatTokens(data.totalCacheReadTokens)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-500">Cache write</span>
            <span className="font-mono text-neutral-200">
              {formatTokens(data.totalCacheWriteTokens)}
            </span>
          </div>
          <div className="col-span-2 flex justify-between border-t border-neutral-800 pt-0.5 font-medium">
            <span className="text-neutral-300">Cost</span>
            <span className="font-mono text-emerald-400">{formatUsd(data.totalCost)}</span>
          </div>
        </div>
      </div>

      {/* Per-turn breakdown */}
      {data.turns.length > 0 && (
        <div>
          <button
            onClick={onToggleTurns}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-400 hover:text-neutral-200"
          >
            {turnsExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Per-turn ({data.turns.length})
          </button>
          {turnsExpanded && <TurnsTable turns={data.turns} />}
        </div>
      )}
    </div>
  );
}

/* ------------------------- context category breakdown ------------------------- */

interface ContextBreakdownData {
  userPrompts: number;
  assistantText: number;
  thinking: number;
  toolCalls: number;
  toolResults: number;
  images: number;
  total: number;
}

const BREAKDOWN_PALETTE: {
  key: keyof Omit<ContextBreakdownData, "total">;
  label: string;
  color: string;
}[] = [
  { key: "userPrompts", label: "User prompts", color: "#0ea5e9" },
  { key: "assistantText", label: "Assistant text", color: "#a78bfa" },
  { key: "thinking", label: "Thinking", color: "#71717a" },
  { key: "toolCalls", label: "Tool calls", color: "#f59e0b" },
  { key: "toolResults", label: "Tool results", color: "#10b981" },
  { key: "images", label: "Images", color: "#ec4899" },
];

function ContextBreakdown({
  breakdown,
  contextWindow,
}: {
  breakdown: ContextBreakdownData;
  contextWindow: number;
}) {
  const total = breakdown.total;
  if (total === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-neutral-400">
        <span>What&rsquo;s in the context</span>
        <span className="text-neutral-600" title="Sum of category estimates (~chars/4)">
          ~{formatTokens(total)} tok
          {contextWindow > 0 && (
            <span className="ml-1">({((total / contextWindow) * 100).toFixed(1)}%)</span>
          )}
        </span>
      </div>
      {/* Stacked horizontal bar — one segment per category, widths
          proportional to its share of `total` (not contextWindow,
          so a small session still fills the bar and the relative
          mix is readable). */}
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-neutral-800">
        {BREAKDOWN_PALETTE.map((c) => {
          const v = breakdown[c.key];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <div
              key={c.key}
              style={{ width: `${pct}%`, background: c.color }}
              title={`${c.label}: ${formatTokens(v)} tok (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        {BREAKDOWN_PALETTE.map((c) => {
          const v = breakdown[c.key];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <li key={c.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: c.color }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-neutral-400">{c.label}</span>
              <span className="font-mono text-neutral-300">{formatTokens(v)}</span>
              <span className="w-10 text-right text-neutral-600">{pct.toFixed(0)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Walk the messages array and bucket text into context categories.
 * Token estimate is the same ~chars/4 heuristic estimateTokens
 * uses — provider-specific tokenizers would be more accurate, but
 * the per-turn `usage` data above carries the authoritative numbers.
 * This breakdown answers "where did the tokens go?", which is a
 * relative question that survives the heuristic.
 *
 * Image content is counted as a per-attachment placeholder rather
 * than being measured byte-wise — provider image tokens scale with
 * resolution, not file size. (See Ctx3 in DEFERRED.md for the
 * proper fix.)
 */
function categorizeContext(messages: Array<Record<string, unknown>>): ContextBreakdownData {
  let userChars = 0;
  let asstTextChars = 0;
  let thinkingChars = 0;
  let toolCallChars = 0;
  let toolResultChars = 0;
  let imageCount = 0;
  for (const m of messages) {
    const role = typeof m.role === "string" ? m.role : "";
    const content = m.content;
    if (role === "user") {
      if (typeof content === "string") {
        userChars += content.length;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const o = c as { type?: unknown; text?: unknown };
          if (o.type === "text" && typeof o.text === "string") userChars += o.text.length;
          else if (o.type === "image") imageCount += 1;
        }
      }
    } else if (role === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        const o = c as { type?: unknown; text?: unknown; input?: unknown };
        if (o.type === "text" && typeof o.text === "string") {
          asstTextChars += o.text.length;
        } else if (o.type === "thinking" && typeof o.text === "string") {
          thinkingChars += o.text.length;
        } else if (o.type === "toolUse") {
          // Tool args go through the LLM as a JSON-encoded string;
          // measuring the JSON length is closer to the truth than
          // measuring raw character counts of object values.
          try {
            toolCallChars += JSON.stringify(o.input ?? {}).length;
          } catch {
            // circular ref → estimate via toString
            toolCallChars += String(o.input ?? "").length;
          }
        }
      }
    } else if (role === "toolResult") {
      if (typeof content === "string") {
        toolResultChars += content.length;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const o = c as { type?: unknown; text?: unknown };
          if (o.type === "text" && typeof o.text === "string") {
            toolResultChars += o.text.length;
          } else if (o.type === "image") {
            imageCount += 1;
          }
        }
      }
    }
  }
  // 4 chars / token is the conventional rule of thumb. Image rough
  // estimate at 1500 tok/image — between Anthropic's ~1200 (1024px
  // square) and OpenAI's ~1700 (high-detail). Same number used in
  // estimateTokens for consistency; both undercount large images.
  const tokens = (chars: number): number => Math.ceil(chars / 4);
  const userPrompts = tokens(userChars);
  const assistantText = tokens(asstTextChars);
  const thinking = tokens(thinkingChars);
  const toolCalls = tokens(toolCallChars);
  const toolResults = tokens(toolResultChars);
  const images = imageCount * 1500;
  return {
    userPrompts,
    assistantText,
    thinking,
    toolCalls,
    toolResults,
    images,
    total: userPrompts + assistantText + thinking + toolCalls + toolResults + images,
  };
}

function TurnsTable({ turns }: { turns: ContextTurn[] }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full font-mono text-[10px]">
        <thead className="text-neutral-500">
          <tr>
            <th className="pr-2 text-left font-normal">#</th>
            <th className="pr-2 text-left font-normal">Model</th>
            <th className="pr-2 text-right font-normal">In</th>
            <th className="pr-2 text-right font-normal">Out</th>
            <th className="pr-2 text-right font-normal" title="Cache read">
              CR
            </th>
            <th className="pr-2 text-right font-normal" title="Cache write">
              CW
            </th>
            <th className="text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody className="text-neutral-300">
          {turns.map((t, i) => (
            <tr key={`${t.index}-${t.timestamp}`} className="border-t border-neutral-800/60">
              <td className="pr-2 text-neutral-600">{i + 1}</td>
              <td className="max-w-[120px] truncate pr-2" title={`${t.provider}/${t.model}`}>
                {t.model}
              </td>
              <td className="pr-2 text-right">{formatTokens(t.inputTokens)}</td>
              <td className="pr-2 text-right">{formatTokens(t.outputTokens)}</td>
              <td className="pr-2 text-right">{formatTokens(t.cacheReadTokens)}</td>
              <td className="pr-2 text-right">{formatTokens(t.cacheWriteTokens)}</td>
              <td className="text-right text-emerald-400">{formatUsd(t.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ message list ------------------------------ */

function MessageList({
  messages,
  showThinking,
  onToggleThinking,
  onViewRaw,
}: {
  messages: Array<Record<string, unknown>>;
  showThinking: boolean;
  onToggleThinking: () => void;
  onViewRaw: (index: number, payload: unknown) => void;
}) {
  return (
    <div className="px-2 py-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">
          Messages ({messages.length})
        </span>
        <label className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300">
          <input
            type="checkbox"
            checked={showThinking}
            onChange={onToggleThinking}
            className="h-3 w-3"
          />
          Show thinking blocks
        </label>
      </div>
      <ul className="space-y-1">
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            index={i}
            message={m}
            showThinking={showThinking}
            onViewRaw={() => onViewRaw(i, m)}
          />
        ))}
      </ul>
    </div>
  );
}

function MessageRow({
  index,
  message,
  showThinking,
  onViewRaw,
}: {
  index: number;
  message: Record<string, unknown>;
  showThinking: boolean;
  onViewRaw: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const role = typeof message.role === "string" ? message.role : "unknown";
  const isCompacted = role === "system" && typeof message.compacted === "boolean";
  // Synthesize a compact preview from the message — the full content
  // (and JSON) is one click away via the raw-view button.
  const preview = useMemo(() => extractPreview(message, showThinking), [message, showThinking]);
  const tokenEstimate = estimateTokens(message);
  const ts = typeof message.timestamp === "number" ? message.timestamp : 0;
  return (
    <li className="rounded border border-neutral-800/70 bg-neutral-900/30">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-neutral-900/60"
      >
        <span className="pt-0.5 text-neutral-600">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${roleClass(role)}`}
            >
              {role}
            </span>
            {isCompacted && (
              <span className="rounded bg-fuchsia-900/40 px-1.5 py-0.5 text-[9px] text-fuchsia-300">
                compacted
              </span>
            )}
            <span className="text-[10px] text-neutral-600">~{formatTokens(tokenEstimate)} tok</span>
            {ts > 0 && (
              <span className="text-[10px] text-neutral-600">
                {new Date(ts).toLocaleTimeString()}
              </span>
            )}
          </div>
          {!expanded && preview.length > 0 && (
            <p className="line-clamp-2 text-[11px] text-neutral-400">{preview}</p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onViewRaw();
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
          title="View raw AgentMessage JSON"
        >
          <Code2 size={11} />
        </button>
      </button>
      {expanded && (
        <div className="space-y-1 border-t border-neutral-800/70 px-3 py-2">
          {renderExpanded(message, showThinking, index)}
        </div>
      )}
    </li>
  );
}

/* ------------------------------ raw json modal ------------------------------ */

function RawJsonModal({
  title,
  payload,
  onClose,
}: {
  title: string;
  payload: unknown;
  onClose: () => void;
}) {
  const json = useMemo(() => {
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      // Circular ref or non-serializable — fall back to a safe string.
      return String(payload);
    }
  }, [payload]);
  // Esc-to-close + click-outside-to-close. The keydown listener
  // re-binds each open so we don't leak it after unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <span className="text-xs text-neutral-200">{title}</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>
        <pre className="flex-1 overflow-auto whitespace-pre p-3 font-mono text-[11px] text-neutral-200">
          {json}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------ helpers ------------------------------ */

function roleClass(role: string): string {
  if (role === "user") return "bg-sky-900/40 text-sky-300";
  if (role === "assistant") return "bg-violet-900/40 text-violet-300";
  if (role === "tool" || role === "toolResult") return "bg-amber-900/40 text-amber-300";
  if (role === "system") return "bg-neutral-800 text-neutral-400";
  return "bg-neutral-800 text-neutral-400";
}

/**
 * Heuristic preview for the collapsed row. Pulls text from the
 * message's content field — string, array of blocks, or
 * tool-result payload — and trims to a one-liner. Filters out
 * thinking blocks unless the user opted into showing them.
 */
function extractPreview(message: Record<string, unknown>, showThinking: boolean): string {
  const content = message.content;
  if (typeof content === "string") return content.slice(0, 200);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    const o = c as { type?: unknown; text?: unknown; name?: unknown };
    if (o.type === "thinking" && !showThinking) continue;
    if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    else if (o.type === "thinking" && typeof o.text === "string")
      parts.push(`[thinking] ${o.text}`);
    else if (o.type === "toolUse" && typeof o.name === "string") parts.push(`[tool: ${o.name}]`);
  }
  return parts.join(" ").slice(0, 200);
}

/**
 * Rough token estimate: ~4 chars per token. Used in the row badge
 * as an at-a-glance signal; the real per-turn counts come from
 * the SDK's usage field rendered in TurnsTable. Image constant
 * matches `categorizeContext` for consistency (1500 tok/image:
 * between Anthropic's ~1200 and OpenAI's ~1700 high-detail).
 */
function estimateTokens(message: Record<string, unknown>): number {
  // Prefer the SDK's actual usage when present (assistant messages).
  const u = message.usage as { totalTokens?: unknown } | undefined;
  if (u !== undefined && typeof u.totalTokens === "number") return u.totalTokens;
  const content = message.content;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  let images = 0;
  for (const c of content) {
    const o = c as { text?: unknown; type?: unknown };
    if (typeof o.text === "string") chars += o.text.length;
    if (o.type === "image") images += 1;
  }
  return Math.ceil(chars / 4) + images * 1500;
}

function renderExpanded(
  message: Record<string, unknown>,
  showThinking: boolean,
  index: number,
): ReactElement {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const content = message.content;
  if (role === "toolResult") {
    return (
      <div>
        <p className="mb-1 text-[10px] text-neutral-500">
          tool: <span className="font-mono">{String(message.toolName ?? "unknown")}</span>{" "}
          {message.isError === true && <span className="text-red-400">(error)</span>}
        </p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950 p-2 font-mono text-[10px] text-neutral-300">
          {jsonish(content)}
        </pre>
      </div>
    );
  }
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((c, i) => {
          const o = c as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
          if (o.type === "thinking" && !showThinking) return null;
          if (o.type === "text" || o.type === "thinking") {
            return (
              <pre
                key={`${index}-${i}`}
                className={`whitespace-pre-wrap break-words font-sans text-[11px] ${
                  o.type === "thinking" ? "italic text-neutral-500" : "text-neutral-200"
                }`}
              >
                {String(o.text ?? "")}
              </pre>
            );
          }
          if (o.type === "toolUse") {
            return (
              <div key={`${index}-${i}`} className="rounded border border-neutral-800 p-2">
                <p className="mb-1 text-[10px] text-neutral-500">
                  tool call: <span className="font-mono">{String(o.name ?? "unknown")}</span>
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-300">
                  {jsonish(o.input)}
                </pre>
              </div>
            );
          }
          if (o.type === "image") {
            return (
              <p key={`${index}-${i}`} className="text-[11px] italic text-neutral-500">
                [image attachment]
              </p>
            );
          }
          return (
            <pre
              key={`${index}-${i}`}
              className="whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-500"
            >
              {jsonish(o)}
            </pre>
          );
        })}
      </>
    );
  }
  if (typeof content === "string") {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-[11px] text-neutral-200">
        {content}
      </pre>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-500">
      {jsonish(message)}
    </pre>
  );
}

function jsonish(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
