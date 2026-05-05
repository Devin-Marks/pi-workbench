# MCP (Model Context Protocol)

pi-forge can connect to MCP servers and surface their tools to the
agent. Configure servers from **Settings → MCP** in the browser, or by
editing config files directly.

> Pi itself has no native MCP support. The integration is workbench-
> internal — see [`packages/server/src/mcp/manager.ts`](../packages/server/src/mcp/manager.ts)
> for the contract.

## Scope of v1

- **Remote servers only.** Transports: `streamable-http` (newer MCP
  spec) and `sse` (legacy). The default `auto` transport tries
  `streamable-http` first and falls back to `sse` — covers
  [fastmcp](https://github.com/jlowin/fastmcp) servers regardless of
  which transport you exposed.
- **stdio is not supported.** The workbench is container-native and
  arbitrary subprocess spawning has different security trade-offs.
  Run stdio MCP servers as a separate process and expose them over
  HTTP/SSE if you need them in the workbench.
- **Static-header auth only.** Bearer tokens, custom auth headers —
  whatever your MCP server expects. OAuth (per-server consent flow,
  callback handling) is deferred.

## Where servers live

Two layers, merged at session create time:

| Scope | File | Editable from UI? |
|---|---|---|
| Global | `${FORGE_DATA_DIR}/mcp.json` | Yes (Settings → MCP) |
| Project | `<projectPath>/.mcp.json` | No — edit in your repo |

Project entries **override** global entries when the server names
collide. The override is per-server (not per-tool); add a project
entry with the same `name` to swap a global server for a project-
specific one inside that project's sessions.

## File format

`mcp.json` (workbench-native shape, written by the UI):

```json
{
  "disabled": false,
  "servers": {
    "my-server": {
      "url": "https://mcp.example.com/sse",
      "transport": "auto",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer sk-..."
      }
    }
  }
}
```

Project `.mcp.json` accepts both shapes — workbench-native and the
Claude Desktop / pi-mcp-adapter standard:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

This way an existing project that already had a `.mcp.json` for other
MCP clients works without rewriting.

### Field reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | string | (required) | The MCP endpoint URL. |
| `transport` | `"auto"` \| `"streamable-http"` \| `"sse"` | `"auto"` | Connection probe order. `auto` tries StreamableHTTP first. |
| `enabled` | boolean | `true` | Disabled servers don't connect or contribute tools. |
| `headers` | `Record<string, string>` | (none) | Forwarded on every MCP RPC. Treated as secret on read — `GET /mcp/servers` returns `***REDACTED***` for every value. |
| `disabled` | boolean (top-level) | `false` | Master kill-switch. When `true`, NO MCP tools reach the agent regardless of per-server `enabled`. Surfaced as the toggle at the top of Settings → MCP. |

## How the agent sees the tools

Each MCP tool advertised by a connected, enabled server becomes a pi
`ToolDefinition` namespaced as **`<server>__<tool>`**. The prefix
guarantees uniqueness so two servers can both advertise `search`
without colliding.

The agent calls them like any other tool. `client.callTool()` forwards
the call; the MCP `CallToolResult.content` array is mapped into pi's
content shape:

- `text` → text content
- `image` (with `mimeType`) → image content (data is base64)
- `resource_link` / `resource` / unknown blocks → JSON-stringified
  into a text block (so the agent at least sees them rather than
  silently dropping)

`isError: true` on the MCP response prefixes the first text block with
`[error]` so the agent has something actionable in its tool result.

## Lifecycle

- **Boot.** The server eagerly loads `${FORGE_DATA_DIR}/mcp.json`
  and connects every enabled global server. Connection failures are
  non-fatal — the server stays in `error` state and the workbench
  comes up regardless.
- **Project sessions.** `<projectPath>/.mcp.json` is read lazily on
  the first `createAgentSession` for that project, then cached. A
  config change to that file requires either restarting the workbench
  or hitting the project's "Probe" button to pick up changes.
- **Save.** A `PUT` from the Settings UI rewrites `mcp.json`
  atomically (`.tmp` + `rename`, mode 0600), then re-syncs the pool
  (disconnect + reconnect entries whose URL / transport / headers
  changed).
- **Master toggle.** Flipping the toggle off in Settings doesn't
  disconnect anything — it just causes future `createAgentSession`
  calls to skip the `customTools` injection. Existing live sessions
  keep the tools they booted with.

## Header status badge

The header next to **Settings** shows a colored dot + `MCP X/Y`:

- **emerald** — every configured global server is connected
- **amber** — some connected, some not (check Settings → MCP for the
  per-server `lastError`)
- **red** — none connected (and at least one configured)
- **neutral** — master toggle off

Hidden when no servers are configured (keeps the header clean on
deployments that don't use MCP) and in `MINIMAL_UI` mode.

## Troubleshooting

**Status stuck in `error`** — open Settings → MCP, expand the server's
row, and read `lastError`. Common causes: wrong URL, missing
`Authorization` header, server returning 4xx on `tools/list`. The
**Probe** button forces a reconnect + tool re-list; the result lands
in the same row.

**Both transports fail** — pin `transport` explicitly. `auto` tries
`streamable-http` and falls back to `sse`; if the server is misconfigured
to advertise both but only one works, the auto-probe round-trip wastes
a few hundred milliseconds on every reconnect. Pinning skips that.

**Headers reset to `***REDACTED***`** — that's the read-path sentinel,
not real data. The persisted file still has the real value. When you
edit the form and save, leaving a sentinel value blank keeps the prior
on-disk secret; supplying a new value overwrites it (same
write-merge pattern as `models.json`).

**Tools don't show up after editing project `.mcp.json`** — the file
is read once per project per server lifetime. Hit Probe on the row,
or restart the workbench, to pick up edits.

## API surface

For automation. All routes are under `/api/v1/mcp/`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp/settings` | Master enable + connected/total count (header badge) |
| `PUT` | `/mcp/settings` | Toggle the master flag |
| `GET` | `/mcp/servers[?projectId=…]` | Global config (redacted) + status (global ∪ project) |
| `PUT` | `/mcp/servers/:name` | Upsert a global server |
| `DELETE` | `/mcp/servers/:name` | Remove a global server |
| `POST` | `/mcp/servers/:name/probe[?projectId=…]` | Force reconnect + re-list, returns new status |
| `GET` | `/mcp/tools?projectId=…` | Flat tool list available to sessions in the project |

The Swagger UI at `/api/docs` has the request/response schemas.

## See also

- [`docs/configuration.md`](./configuration.md) — workbench env vars
  including `FORGE_DATA_DIR`
- [`docs/architecture.md`](./architecture.md) — where the manager
  sits in the request flow
- [`packages/server/src/mcp/manager.ts`](../packages/server/src/mcp/manager.ts)
  — integration contract
