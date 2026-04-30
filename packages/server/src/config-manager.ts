import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthStorage, ModelRegistry, type Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

const MODELS_FILE = (): string => join(config.piConfigDir, "models.json");
const AUTH_FILE = (): string => join(config.piConfigDir, "auth.json");
const SETTINGS_FILE = (): string => join(config.piConfigDir, "settings.json");

/**
 * `models.json` shape we accept and emit. The SDK validates more deeply at
 * load time; this interface captures only the structure routes need to know
 * about. Treat the inner provider configs as opaque pass-through.
 */
export interface ModelsJson {
  providers: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyCommand?: string | string[];
  api?: "messages" | "responses" | "completions" | string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: Array<{
    id: string;
    name: string;
    api?: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
}

export interface SettingsJson {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  skills?: string[];
  enableSkillCommands?: boolean;
  [k: string]: unknown;
}

export interface AuthEntry {
  configured: boolean;
  /** Where the credential came from — `stored` is auth.json, others come from the SDK. */
  source: string | undefined;
  label: string | undefined;
}

export interface AuthSummary {
  /** Map of provider id → presence info. NEVER includes actual key values. */
  providers: Record<string, AuthEntry>;
}

export interface ProvidersListing {
  providers: Array<{
    provider: string;
    models: Array<{
      id: string;
      name: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      input: Array<"text" | "image">;
      hasAuth: boolean;
    }>;
  }>;
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(config.piConfigDir, { recursive: true });
}

/**
 * Keys we refuse to allow user-supplied input to set on any JSON-shaped
 * config blob. Without filtering, a request body like
 * `{"__proto__": {"polluted": true}}` flows through `JSON.parse` (where
 * Node decodes `__proto__` as an own data property — safe) and then
 * through a property-write somewhere downstream that *does* hit the
 * prototype chain — corrupting `Object.prototype` process-wide.
 *
 * We filter at every JSON-write boundary as defense in depth, not just
 * at the one route the original audit caught.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Recursively strip dangerous keys from a value before persisting. Used
 * by `writeModelsJson` and any other path that round-trips
 * user-supplied JSON to disk.
 */
function stripDangerousKeys<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((v: unknown) => stripDangerousKeys(v)) as unknown as T;
  }
  if (typeof input !== "object" || input === null) return input;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    Object.defineProperty(cleaned, k, {
      value: stripDangerousKeys(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cleaned as T;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await ensureConfigDir();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    // Cross-fs rename, perms, source vanished — clean up the leftover
    // tmp file before rethrowing. Without this, repeated failures would
    // leave `<path>.<uuid>.tmp` files accumulating in the config dir.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// models.json

export async function readModelsJson(): Promise<ModelsJson> {
  const data = await readJsonOr<unknown>(MODELS_FILE(), { providers: {} } as ModelsJson);
  if (typeof data !== "object" || data === null || !("providers" in data)) {
    return { providers: {} };
  }
  const r = data as { providers: unknown };
  if (typeof r.providers !== "object" || r.providers === null) {
    return { providers: {} };
  }
  return { providers: r.providers as Record<string, ProviderConfig> };
}

/**
 * Like readModelsJson but with secret-shaped fields replaced with a literal
 * sentinel. Used by the GET /config/models route so an inline `apiKey` in
 * models.json (the pi SDK accepts both inline keys and `apiKeyCommand`) is
 * never echoed back to a browser or to an operator's log shipper.
 *
 * The persisted file is unchanged — writeModelsJson takes the actual
 * shape; this redaction is purely on the read path.
 */
const SECRET_PLACEHOLDER = "***REDACTED***";
export async function readModelsJsonRedacted(): Promise<ModelsJson> {
  const raw = await readModelsJson();
  const out: Record<string, ProviderConfig> = {};
  for (const [name, provider] of Object.entries(raw.providers)) {
    out[name] = redactProviderConfig(provider);
  }
  return { providers: out };
}

function redactProviderConfig(p: ProviderConfig): ProviderConfig {
  const { apiKey, apiKeyCommand, ...rest } = p;
  const redacted: ProviderConfig = { ...rest };
  if (apiKey !== undefined) redacted.apiKey = SECRET_PLACEHOLDER;
  if (apiKeyCommand !== undefined) redacted.apiKeyCommand = SECRET_PLACEHOLDER;
  return redacted;
}

export async function writeModelsJson(data: ModelsJson): Promise<void> {
  // Filter dangerous keys at every level of the providers tree before
  // persisting — defense in depth against a hostile body that
  // sneaks `__proto__`/`prototype`/`constructor` through.
  // See stripDangerousKeys + DANGEROUS_KEYS at the top of this file.
  const safe: ModelsJson = { providers: {} };
  for (const [name, provider] of Object.entries(data.providers ?? {})) {
    if (DANGEROUS_KEYS.has(name)) continue;
    safe.providers[name] = stripDangerousKeys(provider);
  }
  await atomicWriteJson(MODELS_FILE(), safe);
}

// ---------------------------------------------------------------------------
// auth.json — uses the SDK's AuthStorage for locking + presence semantics.

function authStorage(): AuthStorage {
  return AuthStorage.create(AUTH_FILE());
}

export function readAuthSummary(): AuthSummary {
  const store = authStorage();
  const providers: Record<string, AuthEntry> = {};
  // `list()` enumerates providers stored in auth.json. Augment each with the
  // typed `getAuthStatus` shape so the response surface matches what the UI
  // would render (configured + source + label, no key value).
  for (const provider of store.list()) {
    const status = store.getAuthStatus(provider);
    providers[provider] = {
      configured: status.configured,
      source: status.source,
      label: status.label,
    };
  }
  return { providers };
}

export function writeApiKey(provider: string, apiKey: string): void {
  if (provider.length === 0) throw new Error("provider name cannot be empty");
  if (apiKey.length === 0) throw new Error("api key cannot be empty");
  const store = authStorage();
  store.set(provider, { type: "api_key", key: apiKey });
}

export class AuthProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`auth provider not found: ${provider}`);
    this.name = "AuthProviderNotFoundError";
  }
}

export function removeApiKey(provider: string): void {
  const store = authStorage();
  if (!store.has(provider)) throw new AuthProviderNotFoundError(provider);
  store.remove(provider);
}

// ---------------------------------------------------------------------------
// settings.json

export async function readSettings(): Promise<SettingsJson> {
  return readJsonOr<SettingsJson>(SETTINGS_FILE(), {});
}

/**
 * Serialise all read-modify-write sequences over settings.json. Without
 * this, two concurrent PUT /config/settings requests can read the same
 * baseline and race the rename(), losing one write. Also covers the
 * snapshot+restore dance in routes/control.ts:setModel — exported so
 * that route can wrap the entire snapshot → setModel → restore sequence
 * as a single critical section. Single-process / single-tenant only.
 */
export const withSettingsLock = makeLock();

/**
 * Atomically replace settings.json with `settings`. Used by the
 * per-session model route to roll back the SDK's side effects on
 * `session.setModel(...)`. The SDK touches more keys than just
 * defaultProvider/defaultModel (defaultThinkingLevel, etc.), so a
 * key-by-key restore was leaking SDK-written values into the file
 * and resetting users' manually-curated settings to whatever the
 * SDK happened to write.
 *
 * Note: this function does NOT take `withSettingsLock`. The Promise-
 * chain lock is non-reentrant, so callers that need to write under an
 * already-held lock (e.g. `routes/control.ts:setModel` doing a
 * snapshot+restore inside its own critical section) would deadlock.
 * `atomicWriteJson` is itself crash-safe; the lock only matters for
 * read-modify-write coherency, which is owned by the caller.
 */
export async function writeSettings(settings: SettingsJson): Promise<void> {
  await atomicWriteJson(SETTINGS_FILE(), settings);
}

/**
 * Partial-merge update: shallow merge of `patch` over the existing settings.
 * Pass `null` for any key in `patch` to delete that key. Atomic write.
 *
 * Refuses prototype-pollution keys (`__proto__`, `prototype`,
 * `constructor`) — `JSON.parse` itself decodes these as own-properties
 * (which is why the simple `next[k] = v` write would actually corrupt
 * `Object.prototype`); we filter them at the boundary.
 */
export async function updateSettings(patch: Record<string, unknown>): Promise<SettingsJson> {
  return withSettingsLock(async () => {
    const current = await readSettings();
    const next: SettingsJson = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      if (v === null) {
        delete (next as Record<string, unknown>)[k];
      } else {
        // defineProperty avoids a setter-trap if the prototype chain
        // somehow contains an accessor for this key.
        Object.defineProperty(next, k, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    await atomicWriteJson(SETTINGS_FILE(), next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// providers — live from ModelRegistry. Builds a fresh registry per call so a
// PUT /config/models is reflected on the next GET /config/providers without
// needing a restart.

export function liveProvidersListing(): ProvidersListing {
  const store = authStorage();
  const registry = ModelRegistry.create(store, MODELS_FILE());
  const all: Model<Api>[] = registry.getAll();
  const grouped = new Map<string, ProvidersListing["providers"][number]>();
  for (const m of all) {
    let entry = grouped.get(m.provider);
    if (entry === undefined) {
      entry = { provider: m.provider, models: [] };
      grouped.set(m.provider, entry);
    }
    entry.models.push({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      input: m.input,
      hasAuth: registry.hasConfiguredAuth(m),
    });
  }
  return { providers: Array.from(grouped.values()) };
}

// ---------------------------------------------------------------------------
// skills — discovered via the SDK; enabled-state mirrored into settings.skills.

export interface SkillSummary {
  name: string;
  description: string;
  source: "global" | "project";
  filePath: string;
  enabled: boolean;
  /** When true, this skill is invokable only via /skill:name (not auto-injected). */
  disableModelInvocation: boolean;
}

export async function listSkills(workspacePath: string): Promise<SkillSummary[]> {
  const result = loadSkills({
    cwd: workspacePath,
    agentDir: config.piConfigDir,
    skillPaths: [],
    includeDefaults: true,
  });
  const settings = await readSettings();
  const enabled = new Set(settings.skills ?? []);
  return result.skills.map((s) => skillSummary(s, workspacePath, enabled));
}

function skillSummary(s: Skill, workspacePath: string, enabled: Set<string>): SkillSummary {
  // The SDK's loadSkills puts global ones under agentDir and project ones
  // under workspacePath/.pi/skills. Use baseDir prefix as the source
  // discriminator since paths can be normalized differently on macOS/Linux.
  const isProject = s.baseDir.startsWith(workspacePath);
  return {
    name: s.name,
    description: s.description,
    source: isProject ? "project" : "global",
    filePath: s.filePath,
    enabled: enabled.has(s.name),
    disableModelInvocation: s.disableModelInvocation,
  };
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill not found: ${name}`);
    this.name = "SkillNotFoundError";
  }
}

/**
 * Toggle a skill's enabled state. Mutates `settings.skills` (the canonical
 * enable/disable list). The skill must be discoverable in the
 * `loadSkills` result — passing a name that doesn't exist throws
 * SkillNotFoundError so route handlers can return a clean 404.
 */
export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  workspacePath: string,
): Promise<SkillSummary[]> {
  const all = await listSkills(workspacePath);
  if (!all.some((s) => s.name === name)) throw new SkillNotFoundError(name);
  // The skills array is read-modify-write against settings.skills, so
  // serialise the whole sequence under withSettingsLock — without this,
  // toggling two skills in rapid succession (the UI lets the user
  // click as fast as they want) can lose one toggle. We inline the
  // read+merge+write here rather than calling updateSettings (which
  // would deadlock — the lock is non-reentrant) and use atomicWriteJson
  // directly for the write.
  await withSettingsLock(async () => {
    const settings = await readSettings();
    const list = new Set(settings.skills ?? []);
    if (enabled) list.add(name);
    else list.delete(name);
    const next: SettingsJson = { ...settings, skills: Array.from(list) };
    await atomicWriteJson(SETTINGS_FILE(), next);
  });
  return listSkills(workspacePath);
}
