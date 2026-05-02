/**
 * Workbench-private per-tool overrides at
 * `${WORKBENCH_DATA_DIR}/tool-overrides.json`.
 *
 * Two flat sets — `builtin` and `mcp` — both allow-by-default. A tool
 * is disabled iff its name appears in the relevant set. Absence means
 * "enabled" (the operator hasn't expressed an opinion yet).
 *
 * Naming convention matches the names pi sees on the wire:
 *   - builtin:  bare tool name (`bash`, `read`, `grep`, …)
 *   - mcp:      bridged tool name `<server>__<tool>` (the same format
 *               `mcp/manager.bridgeMcpTool` produces; pi never sees
 *               the un-prefixed inner name from the MCP server)
 *
 * Single namespace per family means the toggle endpoint takes one
 * fully-qualified name and looks it up in O(1).
 *
 * Lives outside `${PI_CONFIG_DIR}` because pi's SDK has no native
 * concept of per-tool toggles — this is purely a workbench filter
 * applied to the `tools` allowlist passed to `createAgentSession`.
 *
 * Same atomic-write shape as `skill-overrides.ts` and the other
 * config-file writers (tmp + rename, mode 0600). Empty-set families
 * are pruned so the file doesn't grow with stale sections after a
 * series of disable/enable toggles.
 */
import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type ToolFamily = "builtin" | "mcp";

export interface ToolOverrides {
  /** Builtin tool names the user has explicitly disabled. */
  builtin: string[];
  /** Bridged MCP tool names (`<server>__<tool>`) the user has explicitly disabled. */
  mcp: string[];
}

const EMPTY: ToolOverrides = { builtin: [], mcp: [] };

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.toolOverridesFile), { recursive: true });
}

async function atomicWrite(data: ToolOverrides): Promise<void> {
  await ensureDir();
  const path = config.toolOverridesFile;
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Read the current overrides from disk. Returns an empty object if
 * the file is missing, malformed, or has unexpected shape — same
 * "errors don't bubble" posture skill-overrides uses, so a corrupt
 * overrides file at boot doesn't block session creation.
 */
export async function readToolOverrides(): Promise<ToolOverrides> {
  try {
    const raw = await readFile(config.toolOverridesFile, "utf8");
    if (raw.trim().length === 0) return { builtin: [], mcp: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { builtin: [], mcp: [] };
    }
    const obj = parsed as { builtin?: unknown; mcp?: unknown };
    const builtin = Array.isArray(obj.builtin)
      ? obj.builtin.filter((n): n is string => typeof n === "string")
      : [];
    const mcp = Array.isArray(obj.mcp)
      ? obj.mcp.filter((n): n is string => typeof n === "string")
      : [];
    return { builtin, mcp };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { builtin: [], mcp: [] };
    }
    throw err;
  }
}

/**
 * Toggle a single tool. `enabled: false` adds the name to the
 * disabled set; `enabled: true` removes it (returning to the
 * implicit-enabled default). Idempotent — calling enable on an
 * already-enabled tool, or disable on an already-disabled tool, is
 * a no-op.
 */
export async function setToolEnabled(
  family: ToolFamily,
  name: string,
  enabled: boolean,
): Promise<ToolOverrides> {
  const cur = await readToolOverrides();
  const list = family === "builtin" ? cur.builtin : cur.mcp;
  const idx = list.indexOf(name);
  if (enabled) {
    if (idx === -1) return cur; // already enabled (not in disabled set)
    list.splice(idx, 1);
  } else {
    if (idx !== -1) return cur; // already disabled
    list.push(name);
  }
  await atomicWrite(cur);
  return cur;
}

/**
 * Apply the overrides as a filter over a candidate tool list.
 * Returns the names that should remain ACTIVE — i.e. not in the
 * disabled set for their family.
 *
 * Used at every `createAgentSession` call site to filter the
 * allowlist passed as `tools: [...]`. Builds the family-set once
 * per call so the filter is O(1) per tool.
 */
export function filterEnabledTools(
  overrides: ToolOverrides,
  candidates: { family: ToolFamily; name: string }[],
): string[] {
  const builtinDisabled = new Set(overrides.builtin);
  const mcpDisabled = new Set(overrides.mcp);
  return candidates
    .filter(({ family, name }) =>
      family === "builtin" ? !builtinDisabled.has(name) : !mcpDisabled.has(name),
    )
    .map(({ name }) => name);
}

/** Suppress unused-export warning for tests that import EMPTY. */
export const _EMPTY_FOR_TESTS = EMPTY;
