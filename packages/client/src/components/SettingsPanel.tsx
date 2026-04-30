import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type AuthSummary,
  type ProvidersListing,
  type SkillSummary,
} from "../lib/api-client";
import { useActiveProject } from "../store/project-store";
import { useUiConfigStore } from "../store/ui-config-store";
import { THEME_DEFS, useThemeStore, type ThemeId } from "../lib/theme";

type Tab = "providers" | "agent" | "skills" | "appearance";

interface Props {
  onClose: () => void;
}

/**
 * Phase 8 settings UI. A modal-style overlay with three tabs:
 *
 *   - Providers — combined list from `GET /config/providers` (built-in
 *     models + anything in `models.json`). Each row has an "Add key" /
 *     "Replace key" / "Remove key" affordance against `auth.json`. Adding
 *     custom providers (vLLM/LiteLLM/Ollama) drops the user into a raw
 *     JSON editor — typed schema editing is deferred (DEFERRED.md Pol5).
 *
 *   - Agent — `settings.json` knobs: defaultProvider, defaultModel,
 *     defaultThinkingLevel, steeringMode, followUpMode. Sending `null`
 *     clears a key.
 *
 *   - Skills — per-project skill list from `GET /config/skills` with
 *     toggle. Requires an active project; surfaces a hint otherwise.
 *
 * Errors land in a banner at the top of the panel; per-tab spinners
 * reflect inflight loads. The panel is read-fresh on every open — no
 * cross-mount caching, since config is small and rarely changes.
 */
export function SettingsPanel({ onClose }: Props) {
  const minimal = useUiConfigStore((s) => s.minimal);
  // Minimal mode hides Providers + Agent (those are configured at
  // the deploy level when MINIMAL_UI is set), so the default tab
  // shifts to Skills. Build the visible tab list from a single
  // source of truth so the buttons + the body branch can't drift.
  const visibleTabs = useMemo<readonly Tab[]>(
    () =>
      minimal
        ? (["skills", "appearance"] as const)
        : (["providers", "agent", "skills", "appearance"] as const),
    [minimal],
  );
  const [tab, setTab] = useState<Tab>(minimal ? "skills" : "providers");
  // If the config flips after mount (rare but possible during hot-
  // reload in dev), pull the active tab back into the visible set.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab(visibleTabs[0]!);
  }, [visibleTabs, tab]);
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-1">
            {visibleTabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1 text-xs ${
                  tab === t
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                {t === "providers"
                  ? "Providers"
                  : t === "agent"
                    ? "Agent"
                    : t === "skills"
                      ? "Skills"
                      : "Appearance"}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
            title="Close (Esc)"
          >
            Close
          </button>
        </header>

        {error !== undefined && (
          <div className="border-b border-red-700/40 bg-red-900/20 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-neutral-200">
          {tab === "providers" && <ProvidersTab onError={setError} />}
          {tab === "agent" && <AgentTab onError={setError} />}
          {tab === "skills" && <SkillsTab onError={setError} />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </div>
  );
}

function errorCode(err: unknown): string {
  return err instanceof ApiError ? err.code : (err as Error).message;
}

// ---------------- Providers tab ----------------

function ProvidersTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [providers, setProviders] = useState<ProvidersListing | undefined>(undefined);
  const [auth, setAuth] = useState<AuthSummary | undefined>(undefined);
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      const [p, a] = await Promise.all([api.getProviders(), api.getAuthSummary()]);
      setProviders(p);
      setAuth(a);
    } catch (err) {
      onError(`Failed to load providers: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async (provider: string): Promise<void> => {
    if (keyDraft.trim().length === 0) return;
    setBusy(true);
    try {
      await api.setApiKey(provider, keyDraft.trim());
      setEditingProvider(undefined);
      setKeyDraft("");
      await refresh();
    } catch (err) {
      onError(`Save key failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (provider: string): Promise<void> => {
    if (!confirm(`Remove the stored key for "${provider}"?`)) return;
    setBusy(true);
    try {
      await api.removeApiKey(provider);
      await refresh();
    } catch (err) {
      onError(`Remove key failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (providers === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading providers…</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Built-in providers and anything in <code className="font-mono">models.json</code>. Stored
        API keys are presence-only — actual values are never sent to the browser.
      </p>
      {providers.providers.length === 0 && (
        <p className="text-xs italic text-neutral-500">No providers configured.</p>
      )}
      {providers.providers.map((p) => {
        const presence = auth?.providers[p.provider];
        const configured = presence?.configured === true;
        const editing = editingProvider === p.provider;
        return (
          <div key={p.provider} className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-neutral-100">{p.provider}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                    configured
                      ? "bg-emerald-900/40 text-emerald-300"
                      : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {configured ? "key set" : "no key"}
                </span>
                {presence?.source !== undefined && (
                  <span className="text-[10px] text-neutral-500">via {presence.source}</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs">
                {!editing && (
                  <button
                    onClick={() => {
                      setEditingProvider(p.provider);
                      setKeyDraft("");
                    }}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
                  >
                    {configured ? "Replace key" : "Add key"}
                  </button>
                )}
                {configured && !editing && (
                  <button
                    onClick={() => void removeKey(p.provider)}
                    disabled={busy}
                    className="rounded border border-red-700/50 px-2 py-0.5 text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {editing && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Paste API key"
                  autoFocus
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
                />
                <button
                  onClick={() => void saveKey(p.provider)}
                  disabled={busy || keyDraft.trim().length === 0}
                  className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingProvider(undefined);
                    setKeyDraft("");
                  }}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
                >
                  Cancel
                </button>
              </div>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-neutral-500">
                {p.models.length} model{p.models.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {p.models.map((m) => (
                  <li key={m.id} className="flex justify-between font-mono">
                    <span className={m.hasAuth ? "text-neutral-300" : "text-neutral-600"}>
                      {m.name}
                    </span>
                    <span className="text-neutral-600">
                      ctx {Math.round(m.contextWindow / 1000)}k
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
      <CustomProvidersJson onError={onError} />
    </div>
  );
}

function CustomProvidersJson({ onError }: { onError: (msg: string | undefined) => void }) {
  // Raw-JSON editor for `models.json`. The dev plan calls for typed
  // forms per provider type (vLLM, LiteLLM, Ollama, OpenAI-compatible);
  // that's deferred to a follow-up. The raw editor is deliberately
  // gated behind a details dropdown so casual users don't see it.
  const [text, setText] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Transient post-save signal — clears after SAVE_FLASH_MS so the
  // banner doesn't linger as a stale "saved" claim once the user
  // edits again. Cleared synchronously on every new save attempt.
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  useSavedFlash(savedAt, () => setSavedAt(undefined));
  const load = async (): Promise<void> => {
    try {
      const m = await api.getModelsJson();
      setText(JSON.stringify(m, null, 2));
    } catch (err) {
      onError(`Load models.json failed: ${errorCode(err)}`);
    }
  };
  const save = async (): Promise<void> => {
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Surface as a typed error so the user sees what went wrong;
      // the JSON parser's exact message isn't useful for the operator.
      onError("models.json: invalid JSON");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { providers?: unknown }).providers !== "object" ||
      (parsed as { providers?: unknown }).providers === null
    ) {
      onError('models.json: top-level must be { "providers": { ... } }');
      return;
    }
    setBusy(true);
    setSavedAt(undefined);
    try {
      await api.setModelsJson(parsed as { providers: Record<string, unknown> });
      onError(undefined);
      setSavedAt(Date.now());
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <summary
        className="cursor-pointer text-xs text-neutral-300"
        onClick={() => {
          if (text === undefined) void load();
        }}
      >
        Custom providers (models.json)
      </summary>
      <p className="mt-1 text-[11px] text-neutral-500">
        Raw JSON editor. Add vLLM / LiteLLM / Ollama / OpenAI-compatible endpoints here. The SDK
        validates on next session creation.
      </p>
      {text === undefined ? (
        <p className="mt-2 text-xs italic text-neutral-500">Loading…</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={10}
            className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
          />
          <div className="mt-2 flex items-center justify-end gap-2 text-xs">
            {savedAt !== undefined && (
              <span className="text-emerald-400" aria-live="polite">
                Saved
              </span>
            )}
            <button
              onClick={() => void load()}
              disabled={busy}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300"
            >
              Reload
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded bg-neutral-100 px-3 py-1 font-medium text-neutral-900 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

// ---------------- Agent tab ----------------

function AgentTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [settings, setSettings] = useState<Record<string, unknown> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"form" | "json">("form");

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      const s = await api.getSettings();
      setSettings(s);
    } catch (err) {
      onError(`Failed to load settings: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const get = (key: string): string => {
    if (settings === undefined) return "";
    const v = settings[key];
    return typeof v === "string" ? v : "";
  };

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const next = await api.updateSettings(patch);
      setSettings(next);
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (settings === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading settings…</p>;
  }

  if (mode === "json") {
    return (
      <SettingsJsonEditor
        initial={settings}
        onSave={async (next) => {
          // Build a delta against the current settings so unset keys
          // become explicit `null` (delete) per the route's contract.
          const patch: Record<string, unknown> = { ...next };
          for (const key of Object.keys(settings)) {
            if (!(key in next)) patch[key] = null;
          }
          setBusy(true);
          try {
            const fresh = await api.updateSettings(patch);
            setSettings(fresh);
            onError(undefined);
          } catch (err) {
            onError(`Save failed: ${errorCode(err)}`);
            throw err;
          } finally {
            setBusy(false);
          }
        }}
        onSwitchToForm={() => setMode("form")}
        busy={busy}
        onError={onError}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          Defaults for new sessions. The form covers common keys; switch to JSON to edit anything
          the SDK accepts.
        </p>
        <button
          onClick={() => setMode("json")}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          Edit as JSON
        </button>
      </div>

      <Field label="Default provider" hint="e.g. anthropic, openai, google, custom">
        <TextSetting
          value={get("defaultProvider")}
          onSave={(v) => update({ defaultProvider: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Default model" hint="model id from the chosen provider">
        <TextSetting
          value={get("defaultModel")}
          onSave={(v) => update({ defaultModel: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Thinking level" hint="off, low, medium, high (provider-dependent)">
        <SelectSetting
          value={get("defaultThinkingLevel")}
          options={["", "off", "low", "medium", "high"]}
          onSave={(v) => update({ defaultThinkingLevel: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Steering mode" hint="how interruptions during streaming are queued">
        <SelectSetting
          value={get("steeringMode")}
          options={["", "steer", "followUp"]}
          onSave={(v) => update({ steeringMode: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Follow-up mode" hint="how queued messages are delivered after agent_end">
        <SelectSetting
          value={get("followUpMode")}
          options={["", "steer", "followUp"]}
          onSave={(v) => update({ followUpMode: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>
    </div>
  );
}

function SettingsJsonEditor({
  initial,
  onSave,
  onSwitchToForm,
  busy,
  onError,
}: {
  initial: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => Promise<void>;
  onSwitchToForm: () => void;
  busy: boolean;
  onError: (msg: string | undefined) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  useSavedFlash(savedAt, () => setSavedAt(undefined));

  const save = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Surface as a typed error; raw parser message isn't actionable.
      onError("settings.json: invalid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      onError("settings.json: top-level must be an object");
      return;
    }
    setSavedAt(undefined);
    try {
      await onSave(parsed as Record<string, unknown>);
      setSavedAt(Date.now());
    } catch {
      // onSave already routed the error to the panel banner
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-neutral-500">
          Raw <code className="font-mono">settings.json</code>. Keys removed here are deleted on
          save (mapped to <code className="font-mono">null</code> in the merge patch). The SDK
          validates on next session creation.
        </p>
        <button
          onClick={onSwitchToForm}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          Back to form
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={18}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
      />
      <div className="flex items-center justify-end gap-2 text-xs">
        {savedAt !== undefined && (
          <span className="text-emerald-400" aria-live="polite">
            Saved
          </span>
        )}
        <button
          onClick={() => setText(JSON.stringify(initial, null, 2))}
          disabled={busy}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300"
        >
          Reset
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1 font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Auto-clear a transient post-save indicator. The caller stores a
 * `Date.now()` timestamp on success; this hook clears it after a
 * fixed window so the "Saved" pill doesn't claim freshness on a
 * stale save the user has since edited away from.
 */
const SAVE_FLASH_MS = 2500;
function useSavedFlash(savedAt: number | undefined, clear: () => void): void {
  useEffect(() => {
    if (savedAt === undefined) return undefined;
    const id = window.setTimeout(clear, SAVE_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [savedAt, clear]);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-neutral-200">{label}</label>
      {hint !== undefined && <p className="text-[11px] text-neutral-500">{hint}</p>}
      {children}
    </div>
  );
}

function TextSetting({
  value,
  onSave,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void | Promise<void>;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <div className="flex items-center gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
      />
      <button
        onClick={() => void onSave(draft)}
        disabled={disabled || !dirty}
        className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function SelectSetting({
  value,
  options,
  onSave,
  disabled,
}: {
  value: string;
  options: string[];
  onSave: (v: string) => void | Promise<void>;
  disabled: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => void onSave(e.target.value)}
      className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o.length === 0 ? "(unset)" : o}
        </option>
      ))}
    </select>
  );
}

// ---------------- Skills tab ----------------

function SkillsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const project = useActiveProject();
  const [skills, setSkills] = useState<SkillSummary[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    if (project === undefined) return;
    onError(undefined);
    try {
      const { skills: list } = await api.listSkills(project.id);
      setSkills(list);
    } catch (err) {
      onError(`Failed to load skills: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (project === undefined) {
    return (
      <p className="text-xs italic text-neutral-500">
        Pick a project from the header to manage its skills.
      </p>
    );
  }

  if (skills === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading skills for {project.name}…</p>;
  }

  const toggle = async (name: string, next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const { skills: updated } = await api.setSkillEnabled(project.id, name, next);
      setSkills(updated);
    } catch (err) {
      onError(`Toggle failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        Skills discovered in <code className="font-mono">~/.pi/agent/skills/</code> and{" "}
        <code className="font-mono">{project.path}/.pi/skills/</code>. Toggling writes to{" "}
        <code className="font-mono">settings.skills</code>.
      </p>
      {skills.length === 0 && (
        <p className="text-xs italic text-neutral-500">No skills found for this project.</p>
      )}
      {skills.map((s) => (
        <div
          key={`${s.source}:${s.name}`}
          className="flex items-start gap-3 rounded border border-neutral-800 bg-neutral-900/40 p-3"
        >
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => void toggle(s.name, e.target.checked)}
            className="mt-1"
          />
          <div className="flex-1 space-y-0.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-neutral-100">{s.name}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                {s.source}
              </span>
            </div>
            <p className="text-xs text-neutral-400">{s.description || "(no description)"}</p>
            <p className="font-mono text-[10px] text-neutral-600">{s.filePath}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Appearance tab ----------------

function AppearanceTab() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-100">Theme</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Sets the color palette for the chrome, editor, and terminal. Persisted in this browser
          only — open in another browser to use a different theme there.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {THEME_DEFS.map((def) => {
          const active = def.id === theme;
          return (
            <button
              key={def.id}
              onClick={() => setTheme(def.id as ThemeId)}
              className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-left ${
                active
                  ? "border-neutral-400 bg-neutral-800"
                  : "border-neutral-700 hover:border-neutral-500"
              }`}
            >
              <div>
                <div className="text-sm text-neutral-100">{def.label}</div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                  {def.mode}
                </div>
              </div>
              <ThemeSwatch id={def.id} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Live swatch for a theme — applies that theme's `data-theme` to a
 * scoped wrapper so the four neutral steps below render in the
 * theme's actual palette without affecting the rest of the app.
 */
function ThemeSwatch({ id }: { id: ThemeId }) {
  return (
    <div data-theme={id} className="flex h-6 overflow-hidden rounded border border-neutral-700">
      <div className="w-4 bg-neutral-950" />
      <div className="w-4 bg-neutral-800" />
      <div className="w-4 bg-neutral-500" />
      <div className="w-4 bg-neutral-200" />
    </div>
  );
}
