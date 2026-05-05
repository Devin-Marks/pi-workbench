import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Workbench-owned MCP server registry. Lives at
 * `${FORGE_DATA_DIR}/mcp.json` (mode 0600). The pi SDK has no
 * native MCP support — this file is read by `mcp/manager.ts`, the
 * configured servers are connected to via @modelcontextprotocol/sdk,
 * and the resulting tools are passed into every `createAgentSession`
 * call as `customTools`.
 *
 * v1 supports remote servers only (no stdio subprocesses). Auth is
 * static headers — set `Authorization: Bearer <token>` (or any other
 * header your server expects) and they're forwarded on every request.
 * OAuth and stdio are deferred.
 */

export type McpTransport = "auto" | "streamable-http" | "sse";

export interface McpServerConfig {
  /** Required. The MCP endpoint URL. */
  url: string;
  /**
   * Transport hint. `auto` (default) tries StreamableHTTP first and
   * falls back to SSE — covers fastmcp servers regardless of which
   * transport they expose. Pin to `streamable-http` or `sse`
   * explicitly to skip the fallback round-trip.
   */
  transport?: McpTransport;
  /**
   * Per-request headers (e.g. `{ "Authorization": "Bearer ..." }`).
   * Forwarded on every MCP RPC. Treated as secret on the read path —
   * `readMcpJsonRedacted` replaces every value with the sentinel.
   */
  headers?: Record<string, string>;
  /** Default true. Disabled servers don't connect or contribute tools. */
  enabled?: boolean;
}

export interface McpJson {
  /**
   * Master kill-switch surfaced as a toggle in Settings → MCP. When
   * true, NO MCP tools are passed into createAgentSession (regardless
   * of per-server enabled flags). Connections still happen so the
   * status display stays honest; only the tool-injection step is
   * skipped. Defaults to false (MCP tools available).
   */
  disabled?: boolean;
  servers: Record<string, McpServerConfig>;
}

const SECRET_PLACEHOLDER = "***REDACTED***";

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.mcpConfigFile), { recursive: true });
}

async function atomicWriteJson(data: unknown): Promise<void> {
  await ensureDir();
  const path = config.mcpConfigFile;
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Some kernels honour the umask on the initial create; reapply 0600
  // explicitly so the persisted file always matches what we promised
  // in the docstring.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort — if chmod fails (e.g. read-only fs in tests), the
    // umask-applied perms are still likely fine.
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readMcpJson(): Promise<McpJson> {
  try {
    const raw = await readFile(config.mcpConfigFile, "utf8");
    if (raw.trim().length === 0) return { servers: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
      return { servers: {} };
    }
    const servers = (parsed as { servers?: unknown }).servers;
    const disabled = (parsed as { disabled?: unknown }).disabled === true;
    if (typeof servers !== "object" || servers === null) {
      return { disabled, servers: {} };
    }
    return { disabled, servers: servers as Record<string, McpServerConfig> };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw err;
  }
}

/**
 * Same as readMcpJson but with every header VALUE replaced with the
 * redaction sentinel. Used by the read-path API route so an inline
 * bearer token is never echoed back to the browser.
 */
export async function readMcpJsonRedacted(): Promise<McpJson> {
  const raw = await readMcpJson();
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(raw.servers)) {
    const cleaned: McpServerConfig = { url: server.url };
    if (server.transport !== undefined) cleaned.transport = server.transport;
    if (server.enabled !== undefined) cleaned.enabled = server.enabled;
    if (server.headers !== undefined) {
      cleaned.headers = {};
      for (const k of Object.keys(server.headers)) {
        cleaned.headers[k] = SECRET_PLACEHOLDER;
      }
    }
    out[name] = cleaned;
  }
  return { disabled: raw.disabled === true, servers: out };
}

/**
 * Write `mcp.json`, merging the secret-placeholder for header values
 * back to the prior persisted value. Mirrors the round-trip safety
 * config-manager.writeModelsJson uses for `apiKey` — without this, an
 * "edit and save" round-trip from the UI would write the literal
 * sentinel back to disk and lock the user out of their MCP server.
 */
export async function writeMcpJson(next: McpJson): Promise<void> {
  const existing: McpJson = await readMcpJson().catch(() => ({ servers: {} }));
  const safe: McpJson = { servers: {} };
  if (next.disabled === true) safe.disabled = true;
  for (const [name, server] of Object.entries(next.servers ?? {})) {
    const merged: McpServerConfig = { url: server.url };
    if (server.transport !== undefined) merged.transport = server.transport;
    if (server.enabled !== undefined) merged.enabled = server.enabled;
    if (server.headers !== undefined) {
      merged.headers = {};
      const prior = existing.servers[name]?.headers ?? {};
      for (const [hk, hv] of Object.entries(server.headers)) {
        // Sentinel ↦ keep prior value (or drop the key if no prior).
        if (hv === SECRET_PLACEHOLDER) {
          if (prior[hk] !== undefined) merged.headers[hk] = prior[hk];
        } else {
          merged.headers[hk] = hv;
        }
      }
    }
    safe.servers[name] = merged;
  }
  await atomicWriteJson(safe);
}

export async function upsertMcpServer(name: string, server: McpServerConfig): Promise<void> {
  const cur = await readMcpJson();
  cur.servers[name] = server;
  await writeMcpJson(cur);
}

export async function setMcpDisabled(disabled: boolean): Promise<void> {
  const cur = await readMcpJson();
  cur.disabled = disabled;
  await writeMcpJson(cur);
}

export async function deleteMcpServer(name: string): Promise<boolean> {
  const cur = await readMcpJson();
  if (cur.servers[name] === undefined) return false;
  delete cur.servers[name];
  await writeMcpJson(cur);
  return true;
}
