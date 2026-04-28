import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type ProvidersListing } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

interface Props {
  sessionId: string;
}

const MODEL_KEY_PREFIX = "pi-workbench/model/";

interface ModelOption {
  value: string; // "<provider>:<modelId>"
  provider: string;
  modelId: string;
  name: string;
  /** Lowercased haystack used for substring/word search. */
  haystack: string;
}

function flattenModels(providers: ProvidersListing | undefined): ModelOption[] {
  if (providers === undefined) return [];
  const out: ModelOption[] = [];
  for (const p of providers.providers) {
    for (const m of p.models) {
      if (!m.hasAuth) continue;
      out.push({
        value: `${p.provider}:${m.id}`,
        provider: p.provider,
        modelId: m.id,
        name: m.name,
        haystack: `${p.provider} ${m.name} ${m.id}`.toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * Score a model option against a search query. Returns `undefined` when
 * any token isn't found in the haystack; otherwise a number where
 * LOWER is better. Prefix and provider-equals matches get a strong
 * negative boost so popular models float to the top of OpenRouter's
 * 200+ list — those negative scores ARE matches and must not be
 * filtered out as "no match."
 */
function scoreOption(opt: ModelOption, query: string): number | undefined {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  let score = 0;
  for (const t of tokens) {
    const idx = opt.haystack.indexOf(t);
    if (idx === -1) return undefined;
    score += idx;
  }
  if (opt.modelId.toLowerCase().startsWith(q)) score -= 50;
  if (opt.name.toLowerCase().startsWith(q)) score -= 30;
  if (opt.provider.toLowerCase() === q) score -= 20;
  return score;
}

/**
 * Phase 8 chat input. Two modes:
 *   - idle  → textarea + Send button → POST /prompt
 *   - streaming → steer textarea + Steer / Abort buttons → POST /steer or /abort
 *
 * Enter submits, Shift+Enter inserts a newline. The model selector,
 * attachment button, and token/cost display land alongside the
 * SettingsPanel in this same phase but are visually placeholdered
 * for now to keep the surface focused.
 */
export function ChatInput({ sessionId }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const sendSteer = useSessionStore((s) => s.sendSteer);
  const abortSession = useSessionStore((s) => s.abortSession);
  const error = useSessionStore((s) => s.error);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Model selector state. We only know the user's chosen model client-side
  // (the SDK doesn't expose "current model" over REST), so persist the
  // last-applied selection in localStorage per session and re-apply on
  // mount. Empty string means "leave whatever the agent has now."
  const storageKey = MODEL_KEY_PREFIX + sessionId;
  const [providers, setProviders] = useState<ProvidersListing | undefined>(undefined);
  const [modelChoice, setModelChoice] = useState<string>(
    () => localStorage.getItem(storageKey) ?? "",
  );
  const [modelError, setModelError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void api
      .getProviders()
      .then(setProviders)
      .catch((err: unknown) => {
        // Surface as a non-fatal hint; chat still works with the default model.
        const code = err instanceof ApiError ? err.code : (err as Error).message;
        setModelError(`models unavailable (${code})`);
      });
  }, []);

  const onModelChange = async (value: string): Promise<void> => {
    setModelChoice(value);
    if (value === "") {
      localStorage.removeItem(storageKey);
      return;
    }
    const [provider, ...rest] = value.split(":");
    const modelId = rest.join(":"); // model ids may contain ':'
    if (provider === undefined || modelId.length === 0) return;
    try {
      await api.setModel(sessionId, provider, modelId);
      localStorage.setItem(storageKey, value);
      setModelError(undefined);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setModelError(`set model failed: ${code}`);
    }
  };

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      if (isStreaming) {
        await sendSteer(sessionId, value);
      } else {
        await sendPrompt(sessionId, value);
      }
      setText("");
    } catch {
      // store.error renders below
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * "Interrupt and replace": abort the current run, then send the textarea
   * contents as a fresh prompt. This is what users usually mean by "steer"
   * when the agent is mid-text-generation — the SDK's real `steer` only
   * interrupts at a tool-call boundary, which during plain text output is
   * effectively a follow-up. Two distinct buttons let users pick.
   */
  const interruptAndReplace = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await abortSession(sessionId);
      await sendPrompt(sessionId, value);
      setText("");
    } catch {
      // store.error renders below
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-6 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="flex items-center justify-between gap-2">
          <ModelPicker
            providers={providers}
            value={modelChoice}
            onChange={(v) => void onModelChange(v)}
          />
          {modelError !== undefined && (
            <span className="text-[11px] text-red-400">{modelError}</span>
          )}
        </div>
        {error !== undefined && <p className="text-xs text-red-400">Error: {error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isStreaming
                ? "Steer the agent (Enter to send, Shift+Enter for newline)…"
                : "Ask pi (Enter to send, Shift+Enter for newline)…"
            }
            rows={3}
            className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
          />
          {/*
            Buttons sit in a horizontal row, not a vertical stack. Stacking
            three buttons (Queue / Interrupt / Abort) during streaming made
            the whole input bar taller than it was idle, which shifted the
            chat view up and cut off the bottom messages. A row keeps the
            input bar at constant height regardless of streaming state.
          */}
          <div className="flex flex-row gap-1">
            <button
              onClick={() => void submit()}
              disabled={text.trim().length === 0 || submitting}
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStreaming ? "Queue" : "Send"}
            </button>
            {isStreaming && (
              <>
                <button
                  onClick={() => void interruptAndReplace()}
                  disabled={text.trim().length === 0 || submitting}
                  className="rounded-md border border-amber-700/50 px-3 py-2 text-sm text-amber-300 hover:bg-amber-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Abort the current run and send this as a fresh prompt"
                >
                  Interrupt
                </button>
                <button
                  onClick={() => void abortSession(sessionId)}
                  className="rounded-md border border-red-700/50 px-3 py-2 text-sm text-red-300 hover:bg-red-900/20"
                  title="Stop the agent without queuing a new message"
                >
                  Abort
                </button>
              </>
            )}
          </div>
        </div>
        <p className="text-[10px] text-neutral-600">
          {isStreaming
            ? "Queue: SDK delivers your message at the next agent break (often after the current text finishes streaming, so it reads as a follow-up). Interrupt: abort and resend as a fresh prompt. Abort: stop without queuing."
            : "Attachments and token/cost display land in later phases."}
        </p>
      </div>
    </div>
  );
}

/**
 * Searchable model picker. A flat <select> works for a dozen models but
 * collapses under OpenRouter's 200+ list; this is a typeahead combobox
 * with arrow-key navigation. Click the trigger to open, type to filter,
 * Enter or click to commit, Esc to close.
 */
function ModelPicker({
  providers,
  value,
  onChange,
}: {
  providers: ProvidersListing | undefined;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = useMemo(() => flattenModels(providers), [providers]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (query.trim().length === 0) {
      // No query: keep insertion order (provider-grouped).
      return options;
    }
    const scored: { opt: ModelOption; score: number }[] = [];
    for (const opt of options) {
      const score = scoreOption(opt, query);
      if (score !== undefined) scored.push({ opt, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.opt);
  }, [options, query]);

  const selected = options.find((o) => o.value === value);
  const triggerLabel =
    selected !== undefined ? `${selected.provider} / ${selected.name}` : "default model";

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapperRef.current === null) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Focus the input after the dropdown mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || listRef.current === null) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const commit = (idx: number): void => {
    if (idx === -1) {
      // "Use default" row.
      onChange("");
    } else {
      const opt = filtered[idx];
      if (opt === undefined) return;
      onChange(opt.value);
    }
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(activeIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={providers === undefined}
        className="flex max-w-[260px] items-center gap-1 truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-[11px] text-neutral-200 disabled:opacity-50"
        title="Override the model for this session (click to search)"
      >
        <span className="text-neutral-500">model:</span>
        <span className="truncate">{triggerLabel}</span>
        <span className="ml-1 text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[360px] rounded border border-neutral-700 bg-neutral-950 shadow-xl">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search provider or model…"
            className="w-full border-b border-neutral-800 bg-transparent px-3 py-2 text-xs text-neutral-100 outline-none"
          />
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            <button
              data-idx={-1}
              onMouseEnter={() => setActiveIdx(-1)}
              onClick={() => commit(-1)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                activeIdx === -1 ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
              }`}
            >
              <span>Use agent default</span>
              {value === "" && <span className="text-emerald-400">●</span>}
            </button>
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-neutral-500">
                No models match. Add an API key in Settings → Providers.
              </p>
            ) : (
              filtered.map((opt, i) => (
                <button
                  key={opt.value}
                  data-idx={i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => commit(i)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                    i === activeIdx ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
                  }`}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-neutral-500">{opt.provider}</span>
                    <span className="truncate font-mono">{opt.name}</span>
                  </span>
                  {opt.value === value && <span className="text-emerald-400">●</span>}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
            {filtered.length} of {options.length} models — ↑↓ to move, Enter to pick, Esc to close
          </div>
        </div>
      )}
    </div>
  );
}
