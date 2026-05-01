import { useMcpStore } from "../store/mcp-store";

/**
 * Compact MCP connection-status indicator for the App header. Reads
 * `settings` from `mcp-store` (single 30s ticker shared with the
 * Settings tab — see store doc-comment). Renders nothing when MCP is
 * enabled but no servers are configured, so deployments that don't
 * use MCP get a clean header.
 *
 * Color rules:
 *   - emerald: every configured server is connected
 *   - amber:   some connected, some not
 *   - red:     none connected (and at least one configured)
 *   - neutral: master kill-switch off
 */
export function McpStatusBadge() {
  const data = useMcpStore((s) => s.settings);
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
