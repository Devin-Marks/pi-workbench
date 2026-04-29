import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Image as ImageIcon, Paperclip, X } from "lucide-react";
import { api, ApiError, type ProvidersListing } from "../lib/api-client";
import { EMPTY_MESSAGES, useSessionStore, type AgentMessageLike } from "../store/session-store";

/**
 * Pull the user's prior prompts out of the session message history,
 * newest first. Used by the chat input's arrow-key history cycling.
 *
 * Mirrors `extractText` in ChatView (we can't share it without a
 * circular import; the duplication is a few lines and the
 * canonical-shape detection is identical). Drops empty strings and
 * collapses consecutive duplicates so repeatedly pressing Up doesn't
 * cycle through "yes\nyes\nyes" three times.
 *
 * Optimistic-vs-canonical convergence: `sendPrompt` appends an
 * optimistic message with `content: text` (string form) before the
 * SDK confirms; on `agent_end` the canonical refetch replaces it
 * with the array-of-blocks form. Both shapes extract to the SAME
 * trimmed string here, so the consecutive-duplicate dedupe collapses
 * the brief overlap to a single history entry.
 */
function userHistory(messages: ReadonlyArray<AgentMessageLike>): string[] {
  const out: string[] = [];
  let last: string | undefined;
  // Iterate newest-to-oldest so the resulting array is ordered for
  // direct indexing: out[0] = most recent.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        const o = c as { type?: unknown; text?: unknown };
        if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (text.length === 0) continue;
    if (text === last) continue;
    out.push(text);
    last = text;
  }
  return out;
}

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
 * Phase 8 chat input. One Send button + (while streaming) Abort.
 *
 * - Idle: Send → POST /prompt.
 * - Streaming: Send → POST /steer (Pi's SDK picks steer-vs-followUp
 *   natively based on whether the agent is mid-tool-call or
 *   mid-text; we don't try to second-guess it).
 * - Abort is its own button so it can't be hit by accident from a
 *   misclick on Send. Pressing Esc twice inside the textarea (within
 *   600 ms) also fires Abort — keyboard-only path for users who
 *   never leave the input.
 *
 * Enter submits, Shift+Enter inserts a newline. The model selector
 * lives alongside in this same phase; attachments and token/cost
 * display land in later phases.
 */
const DOUBLE_ESC_WINDOW_MS = 600;

export function ChatInput({ sessionId }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const sendSteer = useSessionStore((s) => s.sendSteer);
  const abortSession = useSessionStore((s) => s.abortSession);
  const error = useSessionStore((s) => s.error);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Timestamp of the most recent Esc keystroke; second Esc within
  // DOUBLE_ESC_WINDOW_MS triggers abort. Lives in a ref so it
  // doesn't force a re-render on every Esc.
  const lastEscRef = useRef<number>(0);

  // Attachment state — File objects selected via the picker, queued
  // to ride along with the next prompt. Cleared on submit. Object
  // URLs for image previews are tracked in a ref so we can revoke
  // them on remove/submit (no leak on long sessions).
  const [attachments, setAttachments] = useState<File[]>([]);
  const previewUrlsRef = useRef<Map<File, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Per-file size + count limits mirror the server's. Validating
  // client-side gives instant feedback; the server still re-checks.
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGES = 4;
  // Server's `files: 8` cap is global (image + text combined). Mirror
  // it client-side so the UI rejects the 9th attachment with a clear
  // message instead of letting the server return `too_many_files`.
  const MAX_TOTAL_FILES = 8;
  const [attachmentError, setAttachmentError] = useState<string | undefined>(undefined);

  const addAttachments = (files: FileList | File[]): void => {
    setAttachmentError(undefined);
    const existing = attachments;
    const next: File[] = [...existing];
    let imageCount = existing.filter((f) => f.type.startsWith("image/")).length;
    for (const f of files) {
      if (next.length >= MAX_TOTAL_FILES) {
        setAttachmentError(
          `Up to ${MAX_TOTAL_FILES} attachments per message; "${f.name}" dropped.`,
        );
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        setAttachmentError(`"${f.name}" exceeds the 10 MB per-file limit.`);
        continue;
      }
      if (f.type.startsWith("image/") && imageCount >= MAX_IMAGES) {
        setAttachmentError(`Up to ${MAX_IMAGES} images per message; "${f.name}" dropped.`);
        continue;
      }
      next.push(f);
      if (f.type.startsWith("image/")) {
        imageCount += 1;
        previewUrlsRef.current.set(f, URL.createObjectURL(f));
      }
    }
    setAttachments(next);
  };

  const removeAttachment = (target: File): void => {
    const url = previewUrlsRef.current.get(target);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current.delete(target);
    }
    setAttachments((cur) => cur.filter((f) => f !== target));
  };

  const clearAttachments = (): void => {
    for (const url of previewUrlsRef.current.values()) URL.revokeObjectURL(url);
    previewUrlsRef.current.clear();
    setAttachments([]);
    setAttachmentError(undefined);
  };

  // Revoke any lingering object URLs when the component unmounts.
  // Snapshot the Map at effect-mount so the cleanup uses that stable
  // reference instead of `previewUrlsRef.current` at unmount time
  // (the ref value can change in the meantime).
  useEffect(() => {
    const map = previewUrlsRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // Bash-shell-style prompt history. `historyIdx` is the index into
  // `history` (0 = most recent). `undefined` means "not in history
  // mode" (showing the user's draft). `historyDraft` stashes whatever
  // the user had typed BEFORE pressing Up, so Down past the newest
  // entry restores it instead of leaving the textarea blank.
  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const history = useMemo(() => userHistory(messages), [messages]);
  const [historyIdx, setHistoryIdx] = useState<number | undefined>(undefined);
  const historyDraftRef = useRef<string>("");
  // Reset history navigation when the session changes — each session
  // has its own history stack.
  useEffect(() => {
    setHistoryIdx(undefined);
    historyDraftRef.current = "";
  }, [sessionId]);

  // Reset the double-Esc latch on session change so a stray Esc
  // logged against session A can't combine with a fresh Esc on
  // session B and abort the wrong run.
  useEffect(() => {
    lastEscRef.current = 0;
  }, [sessionId]);

  // Model selector state. We only know the user's chosen model client-side
  // (the SDK doesn't expose "current model" over REST), so persist the
  // last-applied selection in localStorage per session and re-apply when
  // the session changes. Empty string means "leave whatever the agent
  // has now." ChatInput is reused across sessions (no React key on the
  // mount), so we explicitly re-read storage on sessionId change instead
  // of relying on useState's mount-only initializer.
  const storageKey = MODEL_KEY_PREFIX + sessionId;
  const [providers, setProviders] = useState<ProvidersListing | undefined>(undefined);
  const [modelChoice, setModelChoice] = useState<string>(
    () => localStorage.getItem(MODEL_KEY_PREFIX + sessionId) ?? "",
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

  // On session change: re-read the per-session selection from storage and
  // re-apply it to the server-side AgentSession. Without this, the picker
  // would keep showing the previously-active session's model and the new
  // session would silently inherit its default. Skips the setModel call
  // when storage is empty (= "use whatever the session already has").
  useEffect(() => {
    const stored = localStorage.getItem(MODEL_KEY_PREFIX + sessionId) ?? "";
    setModelChoice(stored);
    setModelError(undefined);
    if (stored === "") return;
    const [provider, ...rest] = stored.split(":");
    const modelId = rest.join(":");
    if (provider === undefined || modelId.length === 0) return;
    void api.setModel(sessionId, provider, modelId).catch((err: unknown) => {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setModelError(`set model failed: ${code}`);
    });
  }, [sessionId]);

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
    // Allow empty text only when there's at least one attachment —
    // sending "look at this" with an image but no caption is a
    // common path. Server still rejects entirely-empty prompts.
    if ((value.length === 0 && attachments.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      if (isStreaming) {
        // Steer doesn't accept attachments today — the SDK's steer()
        // takes (text, images?) which we COULD wire, but cleaner to
        // ship steer-with-text-only first. Clear immediately + warn
        // via the inline banner so the chips don't linger between
        // the warning and `sendSteer` resolving.
        if (attachments.length > 0) {
          clearAttachments();
          setAttachmentError("Attachments aren't sent on steer (mid-turn). Cleared.");
        }
        await sendSteer(sessionId, value);
      } else {
        await sendPrompt(sessionId, value, attachments.length > 0 ? attachments : undefined);
      }
      setText("");
      clearAttachments();
      // Submitting clears history mode — the user's prompt is now
      // (or will shortly be) the newest entry, and pressing Up next
      // should land on it from a fresh empty draft.
      setHistoryIdx(undefined);
      historyDraftRef.current = "";
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
      return;
    }
    // Arrow-key history cycling — bash-shell style. Only intercepts
    // when entering history mode from an empty draft (Up) or while
    // already in history mode (either direction). Once the user
    // types after Up, `onChange` clears `historyIdx` and arrows
    // resume normal cursor movement.
    if (e.key === "ArrowUp") {
      const inHistory = historyIdx !== undefined;
      if (inHistory || text.length === 0) {
        if (history.length === 0) return;
        e.preventDefault();
        const nextIdx = inHistory ? Math.min((historyIdx ?? 0) + 1, history.length - 1) : 0;
        if (!inHistory) historyDraftRef.current = text;
        setHistoryIdx(nextIdx);
        const entry = history[nextIdx];
        if (entry !== undefined) setText(entry);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      if (historyIdx === undefined) return;
      e.preventDefault();
      if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        const entry = history[nextIdx];
        if (entry !== undefined) setText(entry);
      } else {
        // Past the newest → restore the user's draft from before
        // they started cycling history.
        setHistoryIdx(undefined);
        setText(historyDraftRef.current);
        historyDraftRef.current = "";
      }
      return;
    }
    if (e.key === "Escape") {
      // Only intercept Esc while the agent is running. When idle, let
      // it bubble — modals or other ancestors might want it. We also
      // skip the timestamp update when idle so a stray Esc logged on
      // an idle session can't combine with a fresh Esc moments later
      // when the session starts streaming.
      if (!isStreaming) return;
      e.preventDefault();
      const now = Date.now();
      const elapsed = now - lastEscRef.current;
      lastEscRef.current = now;
      if (elapsed < DOUBLE_ESC_WINDOW_MS) {
        lastEscRef.current = 0;
        void abortSession(sessionId);
      }
    }
  };

  // Wrap setText so any user-driven edit (typing, paste, programmatic
  // change from outside history) drops history mode. If the user
  // started navigating history and then started typing, subsequent
  // arrows should behave as ordinary cursor movement, not as more
  // history navigation.
  const handleTextChange = (next: string): void => {
    setText(next);
    if (historyIdx !== undefined) {
      setHistoryIdx(undefined);
      historyDraftRef.current = "";
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
        {attachmentError !== undefined && (
          <p className="text-xs text-amber-400">{attachmentError}</p>
        )}
        {attachments.length > 0 && (
          <AttachmentPreview
            attachments={attachments}
            previewUrls={previewUrlsRef.current}
            onRemove={removeAttachment}
          />
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            // Accept everything; the server (and addAttachments above)
            // sort images vs text by MIME type. Restricting `accept`
            // here would block legitimate code-file extensions the
            // browser doesn't have a built-in MIME for.
            onChange={(e) => {
              if (e.target.files !== null) addAttachments(e.target.files);
              // Reset so re-selecting the same file fires onChange.
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting || isStreaming}
            className="self-stretch rounded-md border border-neutral-700 bg-neutral-900 px-2 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              isStreaming
                ? "Attachments aren't sent on steer (mid-turn). Wait for the current run to finish."
                : "Attach files (images go into model context; text files are prepended to the prompt)"
            }
          >
            <Paperclip size={14} />
          </button>
          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
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
            Two buttons: Send (always) + Abort (streaming only). Pi's
            SDK picks steer-vs-followUp natively when we POST /steer
            during a run — we don't try to second-guess it. Abort is
            its own button so it can't be hit by accident from a
            misclick on Send.
          */}
          <div className="flex flex-row gap-1">
            <button
              onClick={() => void submit()}
              disabled={(text.trim().length === 0 && attachments.length === 0) || submitting}
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                isStreaming
                  ? "Send (Pi queues at the next agent break — steer or follow-up depending on agent state)"
                  : "Send (Enter)"
              }
            >
              Send
            </button>
            {isStreaming && (
              <button
                onClick={() => void abortSession(sessionId)}
                className="rounded-md border border-red-700/50 px-3 py-2 text-sm text-red-300 hover:bg-red-900/20"
                title="Stop the agent (or press Esc twice in the textbox)"
              >
                Abort
              </button>
            )}
          </div>
        </div>
        <p className="text-[10px] text-neutral-600">
          {isStreaming
            ? "Send queues at the next agent break — Pi picks steer or follow-up. Abort: stop the agent (or press Esc twice in the textbox)."
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

/**
 * Strip of attached file pills above the textarea. Image attachments
 * render as 48px-square thumbnails (object-fit: cover); non-image
 * files render as a chip with the filename + size. Each pill has an
 * × that calls `onRemove` to drop just that one.
 *
 * The previewUrls Map is owned by the parent — we read from it but
 * never modify it here. Object URLs are revoked in the parent's
 * `removeAttachment` and `clearAttachments`.
 */
function AttachmentPreview({
  attachments,
  previewUrls,
  onRemove,
}: {
  attachments: File[];
  previewUrls: Map<File, string>;
  onRemove: (f: File) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((f, i) => {
        const isImage = f.type.startsWith("image/");
        const url = previewUrls.get(f);
        return (
          <div
            key={`${i}-${f.name}`}
            className="group relative flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 pr-1 text-xs text-neutral-200"
          >
            {isImage && url !== undefined ? (
              <img
                src={url}
                alt={f.name}
                className="h-12 w-12 shrink-0 rounded-l-md object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-l-md bg-neutral-800 text-neutral-400">
                {isImage ? <ImageIcon size={14} /> : <Paperclip size={12} />}
              </span>
            )}
            <span className="flex flex-col py-1 pl-1">
              <span className="max-w-[160px] truncate font-mono text-[11px]" title={f.name}>
                {f.name}
              </span>
              <span className="text-[10px] text-neutral-500">{formatBytes(f.size)}</span>
            </span>
            <button
              onClick={() => onRemove(f)}
              className="ml-1 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-300"
              title={`Remove ${f.name}`}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
