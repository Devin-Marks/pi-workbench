import { useEffect, useState } from "react";
import { api, ApiError, type McpSettingsResponse } from "../lib/api-client";

const POLL_INTERVAL_MS = 30_000;

/**
 * Compact MCP connection-status indicator for the App header. Polls
 * `GET /mcp/settings` every 30s (the value rarely changes — MCP
 * servers connect at boot and only flip on config changes / probe
 * actions). Renders nothing when MCP is disabled AND no servers are
 * configured, so deployments that don't use MCP get a clean header.
 *
 * Color rules:
 *   - emerald: every configured server is connected
 *   - amber:   some connected, some not
 *   - red:     none connected (and at least one configured)
 *   - neutral: master kill-switch off
 */
export function McpStatusBadge() {
  const [data, setData] = useState<McpSettingsResponse | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await api.getMcpSettings();
        if (!cancelled) setData(r);
      } catch (err) {
        // 401 / network blips: silently keep last known state. We
        // don't want a transient error to flicker a misleading red
        // dot in the header.
        if (!(err instanceof ApiError)) return;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (data === undefined) return null;
  if (data.total === 0 && data.enabled) return null;

  const { enabled, connected, total } = data;
  let dotClass = "bg-neutral-600";
  if (!enabled) {
    dotClass = "bg-neutral-600";
  } else if (connected === total) {
    dotClass = "bg-emerald-500";
  } else if (connected === 0) {
    dotClass = "bg-red-500";
  } else {
    dotClass = "bg-amber-400";
  }

  const label = !enabled ? "MCP off" : `MCP ${connected}/${total}`;
  const title = !enabled
    ? "MCP tools disabled. Enable in Settings → MCP."
    : `${connected} of ${total} MCP server(s) connected. Open Settings → MCP for details.`;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
      title={title}
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}
