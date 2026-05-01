<p align="center">
  <img src="docs/images/icon.png" alt="pi-workbench" width="120" height="120"/>
</p>

# pi-workbench

[![CI](https://github.com/Devin-Marks/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/Devin-Marks/pi-workbench/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Devin-Marks/pi-workbench?sort=semver)](https://github.com/Devin-Marks/pi-workbench/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A self-hosted browser workbench for the [pi coding agent](https://github.com/badlogic/pi-mono).
Chat with the agent against your code, browse files, run a terminal, review
diffs, all from one tab.

> Status: in active development. Things will change between releases.

## Why pi-workbench?

- **Self-hosted, single-tenant.** Your code, your provider keys, your container. No cloud.
  No analytics. No multi-tenant cross-talk. The same machine that runs the agent owns the
  data the agent reads.
- **Container-native.** Ships as a Docker image; deploys to Docker Compose, Kubernetes, or
  OpenShift with the manifests in this repo. Bind-mount your project tree, add an API key,
  go.
- **Same API the UI uses.** Every browser interaction is a REST or SSE call documented at
  `/api/docs`. Scripts, CI pipelines, and the chat UI all hit the same endpoints — no
  shadow surface.

## Quick start

```bash
git clone https://github.com/Devin-Marks/pi-workbench.git
cd pi-workbench
cp docker/.env.example docker/.env       # edit auth + paths if you want
cd docker && docker compose up -d --build
```

Open <http://localhost:3000>. Add a project (point at a folder under
`WORKSPACE_PATH`), drop a provider API key into Settings, and start a
session.

For non-Docker workflows, production deploys, Kubernetes, and configuration
details, follow the links in [Documentation](#documentation) below.

## Features

### Sessions & chat

- **Streaming chat** — token-by-token rendering over SSE. Tool calls and their
  results materialize in the transcript as they happen, not just at the end of a turn.
- **Branchable session tree** — fork at any prior turn, navigate the resulting tree,
  bookmark abandoned branches with a label, summarize-on-navigate to keep context.
- **Per-turn diff panel** — every file the agent touched in the last turn, aggregated
  into one reviewable changeset. Inline-edit results and project-wide diffs use the
  same renderer (unified or side-by-side view, your pick).
- **Context inspector** — token + cost breakdown per turn, lifetime spend, raw
  message inspector with syntax highlighting, and search across long conversations.
- **Image + file attachments** — drop into the prompt; the agent sees images natively
  and gets text-file content as a fenced code block.
- **Auto-retry on provider errors** — exponential backoff with the retry banner +
  countdown surfaced in the UI; full error cause-chain logged to the server's stderr.

### Files, code, and git

- **File browser** — tree view with create / rename / delete / move, scoped to the
  project root with path-traversal protection.
- **Tabbed CodeMirror editor** — autosave, syntax highlighting, per-file-extension
  line-wrap toggle (persisted), reload-on-external-change banner.
- **Workspace search** — ripgrep when available with a Node fallback for substring
  searches; filter by path globs, regex, case sensitivity.
- **Git panel** — status, unified or split diff, stage / unstage per file, commit,
  push, fetch, pull, branch checkout / create / delete, remote management, log with
  ref decorations, branch graph view.
- **Integrated terminal** — `node-pty` over WebSocket, persistent across page
  refresh and project switch (PTY survives 10 minutes of detached idle), per-tab
  scrollback, multi-tab.

### Configuration & extensibility

- **Provider management** — built-in providers (Anthropic / OpenAI / Google /
  OpenRouter) plus custom OpenAI-compatible endpoints (vLLM, LiteLLM, Ollama,
  internal gateways) via `models.json`. Per-provider API keys stored in `auth.json`,
  presence-only in the API surface (key values never sent to the browser).
- **MCP server integration** — connect to remote MCP servers over StreamableHTTP or
  SSE (auto-fallback). Per-project `<project>/.mcp.json` overrides global config on
  the same name. Header status badge in the app header. Master kill-switch toggle.
  See [`docs/mcp.md`](./docs/mcp.md).
- **Skills with per-project overrides** — pi's skills (`.md` files) get a tri-state
  per-project toggle: enabled, disabled, or inherit-from-global. Cascade view in
  Settings shows every project's override at a glance.
- **Five themes** — runtime swap, persisted per browser. Color palettes apply to
  chrome, editor, and the integrated terminal.
- **Minimal-mode UI** — `MINIMAL_UI=true` hides terminal, git pane, last-turn pane,
  providers, and agent settings for locked-down deployments where provider config is
  managed at the deploy level.

### Auth & operations

- **Browser password + JWT** — short-lived tokens with auto-generated HS256 signing
  key persisted to the data dir (no `JWT_SECRET` plumbing needed). On first login
  with the env-supplied password, the user is forced to pick a new one; the new
  password's scrypt hash takes over and the env value is ignored.
- **Static API key** — independent of browser auth. Set `API_KEY` for scripts /
  CI; both can be set together.
- **Programmatic REST + SSE** — auto-generated OpenAPI 3 spec at `/api/docs/json`
  and an interactive Swagger UI at `/api/docs`. Same routes the React UI calls.
- **Installable PWA** — proper manifest with raster + maskable icons, offline page
  served when the server is unreachable, "Add to Home Screen" on desktop and mobile.
- **Operator diagnostics** — error cause-chain walker for the SDK's swallowed
  exceptions (TLS handshake, DNS, ECONNREFUSED), opt-in `DEBUG_FETCH=1` wraps every
  outbound `fetch` for full request-level visibility.

## Documentation

| Topic | File |
|---|---|
| Architecture & data flow | [`docs/architecture.md`](./docs/architecture.md) |
| Configuration & env vars | [`docs/configuration.md`](./docs/configuration.md) |
| MCP servers | [`docs/mcp.md`](./docs/mcp.md) |
| Docker image | [`docs/CONTAINERS.md`](./docs/CONTAINERS.md) |
| Production deployment | [`docs/deployment.md`](./docs/deployment.md) |
| Kubernetes / OpenShift | [`kubernetes/DEPLOY.md`](./kubernetes/DEPLOY.md) |
| Scripting against the API | [`docs/api-examples.md`](./docs/api-examples.md) |
| SSE event catalogue | [`docs/sse-events.md`](./docs/sse-events.md) |
| Security model | [`SECURITY.md`](./SECURITY.md) |
| Privacy | [`PRIVACY.md`](./PRIVACY.md) |
| Contributing | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| Code of Conduct | [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) |

For project conventions and the agent-facing architecture notes, see
[`CLAUDE.md`](./CLAUDE.md).

## Versions

pi-workbench tracks the [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
SDK closely. Each workbench release pins an exact patch version of the
pi SDK trio (`pi-coding-agent`, `pi-agent-core`, `pi-ai`) — no
caret/tilde — so a transparent SDK upgrade can't surprise an existing
workbench install. The pinned versions live in
[`packages/server/package.json`](./packages/server/package.json).

Support window: only the latest workbench tag is supported. When a
new tag ships, the previous one is best-effort — security fixes may
be backported, feature work isn't. Breaking SDK changes that the
workbench had to absorb show up in the release notes' **Changed**
section so operators know what to re-test before upgrading. Per-tag
notes live in [CHANGELOG.md](./CHANGELOG.md).

## Risks & disclaimer

pi-workbench is a self-hosted developer tool, provided **"as is"** under
the MIT [LICENSE](./LICENSE) — no warranty, no support obligation, no
certification (SOC 2, HIPAA, PCI DSS, FedRAMP, etc.). It is not designed
or suitable for safety-critical, life-critical, or regulated-data
contexts. Specific risks worth knowing before you deploy it:

- **LLM hallucinations.** The agent can produce plausible-looking code
  and explanations that are wrong. Review what it writes before running
  or shipping it.
- **Real tool side effects.** The agent's `bash`, `write`, and `edit`
  tools take real action on your filesystem and can run arbitrary
  commands as the workbench user. Treat the agent with the same caution
  you'd apply to any pair-programmer who can run `rm -rf`.
- **Provider data flow.** Your prompts, attached files, and tool
  outputs are sent to whichever LLM provider you configure. The
  provider's terms govern retention, logging, and training — not
  pi-workbench. Read them.
- **Cost overruns.** A misconfigured agent or a stuck loop can burn
  tokens fast. Set provider-side spending limits; pi-workbench surfaces
  per-turn cost in the Context Inspector but enforces no caps of its
  own.
- **Prompt injection.** Content the agent reads (file contents, tool
  output, web pages) can contain instructions that override yours. The
  pi SDK mitigates the worst cases; the residual threat is real.
- **Network exposure.** The container speaks plain HTTP. Exposing it
  to the public internet without TLS at a reverse proxy + auth is
  unsafe — see [`SECURITY.md`](./SECURITY.md) and
  [`docs/deployment.md`](./docs/deployment.md).
- **Jurisdictional regulation.** AI use is regulated differently
  across jurisdictions (EU AI Act, US state AI bills, sector-specific
  rules in finance / health / law). Compliance is on you.

Operating pi-workbench means you accept these risks. To the maximum
extent permitted by law, no party associated with this project is
liable for any damages arising from your use of it — see the LICENSE
for the controlling text.

## Related projects

- [pi-mono](https://github.com/badlogic/pi-mono) — the upstream pi
  agent SDK and reference TUI.

## License

MIT — see [`LICENSE`](./LICENSE).
