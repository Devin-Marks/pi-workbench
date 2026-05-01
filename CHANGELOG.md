# Changelog

All notable changes to pi-workbench are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pi SDK trio (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`,
`@mariozechner/pi-ai`) is pinned to exact versions; any breaking SDK absorption
is called out in its own release notes section. See the "Versions" section of
the README for the support window policy.

## [Unreleased]

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
- **Chat input affordances.** `!` / `!!` bash prefixes (pi-tui parity),
  `@<path>` file references with autocomplete, `/` slash-command palette.
- **Cross-tab sync.** Session create/delete/rename mirrored across browser
  tabs via the `BroadcastChannel` API; SSE 404 path retained as a safety net
  for out-of-band deletions.
- **Deployment.** Multi-stage Docker image (`node:22-alpine`) with PUID/PGID
  bind-mount support; Compose and Kubernetes manifests; healthcheck via
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

[Unreleased]: https://github.com/Devin-Marks/pi-workbench/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Devin-Marks/pi-workbench/releases/tag/v1.0.0
