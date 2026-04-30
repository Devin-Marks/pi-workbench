# Configuration

pi-workbench's runtime behavior is shaped by **two** layers of configuration:

1. **Workbench env vars** — read by `packages/server/src/config.ts` at
   startup. Controls ports, paths, auth, and the `MINIMAL_UI` frontend
   gate. Reference: [`README.md`](../README.md#environment-variables) and
   [`docs/deployment.md`](./deployment.md).
2. **Pi SDK config files** — JSON files under `${PI_CONFIG_DIR}` (default
   `~/.pi/agent`, container `/home/pi/.pi/agent`). Owned by the pi SDK,
   surfaced by the workbench's Settings panel and the
   `/api/v1/config/*` routes.

This document covers layer 2 — what each pi config file does, how the
workbench reads/writes it, and how to wire up a custom provider.

## File layout

```
${PI_CONFIG_DIR}/
├── auth.json          — provider API keys + OAuth tokens
├── models.json        — custom provider definitions
└── settings.json      — agent defaults (model, thinking level, modes)
```

Skills (per-project Markdown files) live elsewhere — under `.pi/skills/`
inside each project directory and inside `~/.pi/skills/` for global
skills. The workbench surfaces them but doesn't own their storage.

## auth.json — provider API keys

The pi SDK stores provider credentials here. Format is owned by the SDK;
schematically:

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai":    { "apiKey": "sk-..." },
  "google":    { "apiKey": "..." },
  "openrouter":{ "apiKey": "sk-or-..." }
}
```

Some providers use OAuth and store tokens here instead of bare API keys.
Pi handles the format; the workbench doesn't parse it.

### How the workbench surfaces it

The Settings → Providers tab shows every provider that has a key
configured (a green dot) or doesn't (an "Add key" button). It uses
**presence-only** information from `GET /api/v1/config/auth` — the
actual key values **never** leave the server. The route is enforced in
`config-manager.ts`'s `readAuthSummary()`; if you find a code path that
returns key values, that's a security bug — file a private advisory.

Adding a key uses `PUT /api/v1/config/auth/:provider` with `{ apiKey }`.
Removing uses `DELETE /api/v1/config/auth/:provider`. Both write
atomically (`tmp + rename`) so you can't end up with a corrupted file
on a crash mid-write.

In `MINIMAL_UI` mode the Providers tab is hidden; manage credentials
out-of-band (edit `auth.json` directly, then `kubectl rollout restart`
or `docker compose restart`).

## models.json — custom provider definitions

Built-in providers (Anthropic, OpenAI, Google, OpenRouter, Bedrock,
Vertex, etc.) are baked into pi-ai and don't need entries here. Use
`models.json` only for **custom** OpenAI-compatible endpoints — vLLM,
LiteLLM, Ollama, llama.cpp's `--api`, your company's internal proxy.

```json
{
  "providers": {
    "vllm-local": {
      "api": "openai-completions",
      "url": "http://localhost:8000/v1",
      "models": [
        {
          "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
          "name": "Qwen 2.5 Coder 32B (vLLM)",
          "contextWindow": 32000,
          "maxTokens": 8000,
          "input": ["text"],
          "reasoning": false
        }
      ]
    },
    "ollama": {
      "api": "openai-completions",
      "url": "http://localhost:11434/v1",
      "models": [
        {
          "id": "llama3.1:70b",
          "name": "Llama 3.1 70B (Ollama)",
          "contextWindow": 128000,
          "maxTokens": 4000,
          "input": ["text"],
          "reasoning": false
        }
      ]
    }
  }
}
```

### Field reference (per model entry)

| Field | Type | Notes |
|---|---|---|
| `id` | string | The exact `model` value the provider expects in API requests |
| `name` | string | Display name in the model picker |
| `contextWindow` | number | Tokens the model accepts as input. The Context Inspector uses this for the "context window" bar. |
| `maxTokens` | number | Max output tokens per response. Pi clamps `max_tokens` in API calls to this. |
| `input` | `("text" \| "image")[]` | What content types the model accepts. Image-capable models can receive multipart attachments. |
| `reasoning` | boolean | True if the model supports thinking / extended-reasoning blocks (OpenAI o1, Claude Sonnet 4.5 with thinking, etc.). Surfaces the thinking-level selector in Settings → Agent. |

### Provider `api` field

Each provider entry's `api` field tells pi-ai which protocol adapter to use:

- `openai-completions` — `/v1/chat/completions` shape (OpenAI, vLLM,
  LiteLLM, Ollama, llama.cpp)
- `openai-responses` — OpenAI's newer Responses API
- `anthropic-messages` — Anthropic's Messages API
- `google-generative-ai` — Google's Generative Language API
- `bedrock-converse-stream` — AWS Bedrock Converse API (streaming)

For most third-party endpoints you'll use `openai-completions`. Check the
endpoint's docs to confirm wire-format compatibility.

### How the workbench surfaces it

Settings → Providers shows a collapsible "Custom providers (models.json)"
section with a raw-JSON editor. The editor is gated behind a `<details>`
to keep casual users from accidentally clobbering it; a typed form per
provider type is deferred to Phase 18 polish.

Reads via `GET /api/v1/config/models`, writes via
`PUT /api/v1/config/models` (full-document replace; the route validates
`{ providers: {...} }` shape but doesn't validate per-provider schemas
— pi-ai validates on next session creation).

In `MINIMAL_UI` mode this surface is hidden. Edit `models.json` directly
and restart.

## settings.json — agent defaults

Pi-side defaults that apply to new sessions:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "defaultThinkingLevel": "medium",
  "steeringMode": "interrupt",
  "followUpMode": "wait"
}
```

| Field | Values | Notes |
|---|---|---|
| `defaultProvider` | A provider key (`anthropic`, `openai`, `google`, custom from `models.json`, etc.) | Picked by new sessions when no per-session model is set. |
| `defaultModel` | A model id from the chosen provider | Same. |
| `defaultThinkingLevel` | `minimal` / `low` / `medium` / `high` / `xhigh` | For reasoning-capable models. Lower = faster + cheaper; higher = better at hard problems. |
| `steeringMode` | `interrupt` / `wait` | What `POST /steer` does. `interrupt` stops the agent at the next tool-call boundary; `wait` queues the message for after the current run. |
| `followUpMode` | `interrupt` / `wait` | What `POST /followUp` does. `wait` is the conventional choice. |

Other SDK keys (less commonly tuned) are accepted by the
`PUT /api/v1/config/settings` route and persist in this file.

### How the workbench surfaces it

Settings → Agent is a typed form for the common fields plus an
"Edit as JSON" toggle for the long tail of SDK keys. Form changes
fire `PUT /api/v1/config/settings` with a partial patch (Fastify
shallow-merges into the existing file).

The route preserves unknown fields the SDK might add in future
versions — you won't lose data by editing through the form.

### Per-session model override

The Settings → Agent default is the **fallback**. The chat input has a
model picker that overrides per-session. The override persists in
browser localStorage (`pi-workbench/model/<sessionId>`) and re-applies
on session switch. It does NOT modify `settings.json`.

(See [`pi-webui-dev-plan.md`](../pi-webui-dev-plan.md) and the commit
history around `routes/control.ts:setModel` for the gory details — the
SDK's `setModel` writes the global default as a side effect, which
the workbench undoes by snapshot-and-restore around the call so
per-session selection doesn't mutate the global default.)

## Per-project skills

Pi supports project-scoped skill files (Markdown files with YAML
frontmatter the agent loads as additional instructions). They live
under:

- **Project-local:** `<project-path>/.pi/skills/*.md`
- **Global:** `~/.pi/skills/*.md` — available across all projects

The workbench's Settings → Skills tab shows the merged list (global +
project-local) for the active project, with a toggle per skill to
enable/disable for THIS project. Disable state writes to the project's
`settings.json`; the skill files themselves are untouched.

## Container ergonomics

Inside Docker, the bind mounts are:

| Container path | Default host path | What lives here |
|---|---|---|
| `/home/pi/.pi/agent` | `~/.pi/agent` | `auth.json`, `models.json`, `settings.json` (shared with host pi CLI by default) |
| `/home/pi/.pi-workbench` | `~/.pi-workbench-docker` | `projects.json` (separate from host's `~/.pi-workbench`) |
| `/workspace` | `../workspace` (relative to compose file) | User code; sessions under `.pi/sessions/` here |

Sharing `~/.pi/agent` with the host means the host CLI and the container
see the same provider keys + custom providers + agent defaults. Set
`PI_CONFIG_HOST_PATH` to a different host directory if you want
container-isolated config.

`projects.json` defaults to a SEPARATE host directory because mixing the
host CLI's project list with the container's would mean the container
can see projects whose paths point inside the host's home directory —
they'd resolve to invalid paths inside the container's filesystem.
Setting both to the same host path requires also using the same
workspace path semantics.

## MCP servers (Phase 17 — when shipped)

When the optional MCP adapter lands, MCP server definitions will live in
their own config file (likely `${PI_CONFIG_DIR}/mcp.json`). The Settings
panel will gain an MCP tab with the same install/list/remove pattern the
Providers tab uses.

Until then, MCP support is provided by community packages
(e.g. `@nicobailon/pi-mcp-adapter`) that add a generic `mcp` tool to the
agent. Configure those out-of-band via the package's own setup.

## See also

- [`README.md`](../README.md) — workbench env vars + Docker quickstart
- [`docs/deployment.md`](./deployment.md) — production deploy with TLS +
  reverse proxy + auth
- [`docs/CONTAINERS.md`](./CONTAINERS.md) — container internals + bind
  mounts + UID/GID handling
- [`docs/architecture.md`](./architecture.md) — what config-manager.ts
  does + how the routes wire it
- [`SECURITY.md`](../SECURITY.md) — auth.json key safety + threat model
