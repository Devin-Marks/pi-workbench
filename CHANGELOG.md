# Changelog

All notable changes to pi-workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pi SDK trio (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`,
`@mariozechner/pi-ai`) is pinned to exact versions; any breaking SDK absorption
is called out in its own release notes section. See the "Versions" section of
the README for the support window policy.

## [Unreleased]

### Changed

- **Markdown + syntax-highlighted code in chat messages.** User
  text bubbles, assistant text blocks, and the streaming preview
  now render through `react-markdown` + `remark-gfm` +
  `remark-breaks` — headings, bold / italic, lists, tables,
  blockquotes, links, fenced code blocks, and chat-style single-
  newline preservation (so the line breaks the user typed survive
  the round-trip; CommonMark default would have folded them into
  whitespace). Fenced code blocks get prism-react-renderer syntax
  highlighting (same library DiffBlock and ContextInspectorPanel
  already use, so the dark surfaces stay visually consistent).
  Inline `` `code` `` gets a styled monospace span. Raw HTML in
  message content is ignored (no `rehype-raw`); links open in a
  new tab with `noopener noreferrer`. Each user / assistant message
  has a small `raw` / `rendered` toggle in the corner so the
  underlying text (literal `**`, backticks, exact whitespace)
  stays one click away. Tool calls, file-reference badges, bash
  exec messages, and image attachments still use their dedicated
  renderers — markdown is for prose only.
- **Tool calls render as one collapsed entry per call.** Previously
  the assistant-side `toolCall` block and its matching `toolResult`
  message rendered as two separate boxes in the chat — one showing
  `→ <tool>` plus a JSON dump of arguments, the other showing the
  tool's output. Now each tool invocation is paired by `toolCallId`
  and rendered as a single entry with three rows: header
  (`→ <tool>` + an error / running badge), collapsible **Input**
  (closed by default), and collapsible **Output** (closed by
  default). The `edit` tool keeps its specialized diff renderer
  inside the Output row so file diffs still display as +/- lines
  once expanded. Mid-stream calls without a result yet show a
  "running…" badge in the header.

### Added

- **Agent gets `grep`, `find`, and `ls` tools.** Pi's SDK ships
  seven built-in coding tools — `read`, `bash`, `edit`, `write`,
  `grep`, `find`, `ls` — but only the first four are activated
  when `tools` is left undefined on `createAgentSession`. We now
  pass the full set on every session so the agent has first-class
  filesystem-read affordances instead of shelling out via `bash`
  for every directory listing or content search. MCP tool names
  are unioned into the same allowlist at each call site so the
  added `tools: [...]` arg doesn't filter custom tools.
- **Per-tool enable / disable, with per-project overrides.** Every
  tool the agent could call is now toggleable individually.
  **Settings → Tools** lists pi's seven built-ins (read, bash, edit,
  write, grep, find, ls). **Settings → MCP** gets a cascade under
  each server: an expand chevron reveals that server's tools (with
  the bridged `<server>__<tool>` name + the unprefixed shortName +
  description). Every row carries a `Global: enabled/disabled`
  toggle plus an `▸ Overrides (N)` expand button that opens an
  inline cascade — each project that already overrides this tool
  shows a tri-state Inherit / Enabled / Disabled picker, and an
  `+ Add override for…` dropdown lets you add or change overrides
  for any other project from the same screen (no need to switch
  active projects). Same UX as the Skills tab. Project overrides
  win over the global default in both directions (project enable
  beats global disable; project disable beats global enable);
  absence inherits global. Allow-by-default; global disables and
  per-project overrides are stored in
  `${WORKBENCH_DATA_DIR}/tool-overrides.json` (atomic write, same
  shape as `skills-overrides.json`). Changes apply on the NEXT
  `createAgentSession` — live sessions keep the tool set they
  booted with. Routes: `GET /api/v1/config/tools[?projectId=]` for
  the unified view (response per row carries `enabled`,
  `globalEnabled`, and the optional `projectOverride`),
  `GET /api/v1/config/tools/overrides` for the cascade across every
  project (mirrors the skills cascade endpoint),
  `PUT /api/v1/config/tools/:family/:name/enabled` toggles either
  scope (`scope: "global"` default, or `scope: "project"` with
  `?projectId=`), and `DELETE` on the same path with `?projectId=`
  clears a per-project override (idempotent). The Tools tab stays
  visible in `MINIMAL_UI` mode so locked-down deployments can still
  disable `bash` / `edit` / `write` without the rest of the
  settings surface.
- **Config export / import as `.tar.gz`.** New `Settings → Backup`
  tab and matching API routes — `GET /api/v1/config/export` streams a
  flat tar with `mcp.json`, `settings.json`, and `models.json`;
  `POST /api/v1/config/import` accepts a multipart upload and writes
  each file atomically (`.tmp` + rename). Import is all-or-nothing:
  every accepted file must parse as JSON before any rename runs, so a
  corrupted entry can't half-restore. **Provider auth is NOT included
  in exports** (`auth.json` — API keys / OAuth tokens) — the UI
  reminds operators to re-authenticate providers after restoring on a
  new install. Installation-bound files (`jwt-secret`, `password-hash`,
  `projects.json`) are also excluded.
- **Terminal venv auto-activation.** When a new terminal tab is opened
  in a project containing a Python virtualenv at `.venv/`, `venv/`, or
  `env/`, the workbench automatically runs `source <dir>/bin/activate`
  in the freshly-spawned shell. Reattach to an existing PTY does not
  re-source so manually-switched venvs are preserved.

### Fixed

- **`@<path>` file references preserved in chat history.** When a
  referenced file was small enough to inline, the server previously
  emitted only the fenced code block — the user's prose lost the
  `@<filename>` they typed (`look at @README.md and explain` rendered
  as `look at and explain`). The server now keeps the literal marker
  for every outcome (inline, defer, error), the client no longer
  strips bare markers from the rendered bubble, and the fence-stripper
  consumes adjacent newlines so the marker flows inline with
  surrounding prose instead of leaving an orphan blank line.
- **Trailing-punctuation file references resolve correctly.**
  `@README.md?`, `@src/foo.ts,`, `@build.js)` etc. used to greedy-match
  the trailing punctuation as part of the filename, so the server
  couldn't resolve the file. The bare-form regex is now lazy + uses a
  lookahead so trailing `?,;:!)]` followed by whitespace or EOS
  isn't pulled into the path. Dot is intentionally not in the strip
  set (filenames have dots); the autocomplete now always inserts the
  quoted form (`@"src/foo.ts"`) so users can type any punctuation
  directly after an autocompleted reference.

### Security

- **Agent secret-hygiene system-prompt rule (opt-in).** When
  `AGENT_SECRET_HYGIENE_RULE=true`, every `createAgentSession` ships
  an `appendSystemPrompt` addendum telling the model to treat env-var
  values as credentials by default and not echo them into responses
  or tool outputs unless explicitly asked. Phrased around *displaying
  values* (not accessing variables) so legitimate skill workflows
  that need `$GITHUB_TOKEN`, `$AWS_*`, etc. continue to work —
  `curl -H "Authorization: Bearer $X"` is fine, `printenv X` to
  reflect the value back to the user is not. Default OFF: kept opt-in
  so the workbench doesn't ship invisible behavioral rules. The flag
  is intentionally absent from `docker-compose.yml` and
  `.env.example` — operators discover it via [SECURITY.md](./SECURITY.md)
  alongside the threat-model caveats (behavioral nudge, not a
  security control).
- **Terminal env-var allowlist.** The integrated terminal and the `!`
  exec route now start from an allowlist of harmless system vars
  (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`/`LC_*`, `TZ`, …)
  instead of inheriting the workbench process's full env minus a
  named denylist. Workbench secrets, provider API keys, cloud
  credentials, and any other host-env var are dropped before spawn,
  so `printenv` / `echo $X` returns nothing for them. Operators who
  need a specific var in-shell opt it back in via the new
  `TERMINAL_PASSTHROUGH_ENV` env (comma- or whitespace-separated).
  Closes the previous fail-open denylist that leaked any
  newly-named secret variable until added to the list. See
  [SECURITY.md](./SECURITY.md) for the full rationale and a note on
  the unrelated terminal-can-read-pi-config-files limitation.

### Build & release

- **Release tooling.** New `scripts/bump-version.sh <new-version>` that
  bumps the root and workspace `package.json` files in lockstep, refreshes
  `package-lock.json`, and rewrites the `## [Unreleased]` section in
  `CHANGELOG.md` to a dated release header. Refuses to run on a dirty
  working tree, on a downward / equal version, or with an empty Unreleased
  body (overridable via `--allow-empty`).
- **Tag/version drift gate.** The release workflow now runs a
  `check-version` job on every `v*` tag push that fails the build if the
  tag doesn't match `package.json#version` in all three workspaces. Catches
  the "tagged but forgot to bump" mistake before any image is pushed.

## [1.0.0] — 2026-05-01

First tagged release. The browser workbench is feature-complete against the
Phase 1–18 development plan: project + session management, full pi SDK bridging
over REST + SSE, file browser and editor, integrated terminal, diff and git
panes, attachments, session tree, context inspector, MCP client, per-project
skill overrides, and a versioned API documented at `/api/docs`.

### Added

- **Sessions & agent bridge.** Live `AgentSession` registry with lazy resume
  from JSONL on disk; SSE event stream with snapshot-on-connect for instant
  hydration; fire-and-forget prompt with multipart attachments (text files
  inlined as fenced blocks, images forwarded as base64).
- **Projects.** Folder-pointer model rooted at `WORKSPACE_PATH`; project
  registry persisted to `WORKBENCH_DATA_DIR/projects.json`; one-time migration
  from the legacy `PI_CONFIG_DIR` location.
- **Authentication.** Browser JWT auth via `UI_PASSWORD`; programmatic access
  via `API_KEY` static bearer; auto-generated `JWT_SECRET` persisted to the
  data dir; scrypt-hashed password store; `REQUIRE_PASSWORD_CHANGE` first-login
  flow with a documented reset path.
- **Configuration.** Pi `auth.json` / `models.json` / `settings.json` editing
  through a presence-only API (key values never returned over the wire);
  `HIDE_BUILTIN_PROVIDERS` env var for locked-down deployments;
  per-project skill enable/disable overrides at
  `WORKBENCH_DATA_DIR/skills-overrides.json` applied at every
  `createAgentSession` site.
- **MCP client.** Direct `@modelcontextprotocol/sdk` integration with
  StreamableHTTP and SSE transports; per-project + global server scopes;
  master enable/disable; status badge in the header.
- **Files.** Workspace browser with tree view, file editor (CodeMirror 6 +
  one-dark), ripgrep-backed file search, multipart upload with SHA-256
  verification, and tar.gz download — all routed through `file-manager.ts`
  with strict path-traversal guards.
- **Terminal.** Per-project `node-pty` shells over WebSocket with
  reattach-by-tabId across reconnects, idle reaping, and per-tab persistence
  via `sessionStorage` so two browser tabs don't fight over the same PTY.
- **Diff + git.** Unified diff renderer for both pi `edit` tool results and
  `git diff`; per-turn aggregated diff; git pane with branch, modified-file
  count badge, and file-level staging.
- **Session tree + context inspector.** Indented depth-first session tree
  with fork/leaf badges; per-message inspector for token-level debugging.
- **Chat input affordances.** `!` / `!!` bash prefixes (pi-tui parity) with a
  colored border + corner pill (emerald = output goes to LLM context, amber =
  local-only) so the mode is unmissable while typing; `@<path>` file
  references with autocomplete; `/` slash-command palette.
- **Cross-tab sync.** Session create/delete/rename mirrored across browser
  tabs via the `BroadcastChannel` API; SSE 404 path retained as a safety net
  for out-of-band deletions.
- **Deployment.** Multi-stage Docker image (`node:22-bookworm-slim` — glibc
  base for friction-free native-module installs and a richer interactive
  shell) with PUID/PGID bind-mount support; Compose and Kubernetes
  manifests; healthcheck via
  `/api/v1/health`; pino structured logging with configurable level.
- **PWA.** Manifest, raster icons, branded offline page, service worker
  precaching the application shell.
- **Documentation.** README front-door with quickstart, architecture diagram,
  env var table, and "Versions" SDK-pinning policy; full reference set under
  `docs/` (architecture, deployment, configuration, containers, SSE events,
  API examples, MCP); governance files (LICENSE, CONTRIBUTING, SECURITY,
  PRIVACY, CODE_OF_CONDUCT) and `.github/` issue + PR templates.

### Security

- Path-traversal guards on every `file-manager.ts` operation (lexical +
  realpath verification).
- Provider auth values are never returned by the read API — only a presence
  map and the SDK-reported source.
- Container hardening in the shipped Compose: `no-new-privileges`,
  `cap_drop: ALL`, pids/mem/cpu limits, localhost-only port bind by default.
- Login rate limiting via `@fastify/rate-limit`.

### Reliability

- **SSE keepalives.** The SSE bridge sends a comment-line heartbeat every
  20 s on every open stream so any L7 proxy with the typical 30 s idle
  timeout (notably OpenShift's HAProxy router) doesn't drop the connection
  during quiet stretches between agent turns.
- **MCP route shape fixes.** Master toggle (`PUT /mcp/settings`) returns the
  full `{ enabled, connected, total }` shape so the header badge updates in
  one round trip; the upsert route's response schema explicitly declares
  `{ ok }` so Fastify's response serializer doesn't strip it; both
  unblocked the Settings → MCP page from `invalid_response_body` errors on
  every action.

[Unreleased]: https://github.com/Devin-Marks/pi-workbench/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Devin-Marks/pi-workbench/releases/tag/v1.0.0
