# Privacy

pi-workbench is open-source software you self-host. **The project itself
runs no servers, collects no telemetry, and has no access to your data.**
This document describes what data the software you operate stores, where
it stores it, and what flows out of it to third parties.

If you operate a pi-workbench deploy that other people use, this document
is a starting point for your own privacy notice — but it is not a substitute
for one.

## What the project does NOT do

- **No upstream telemetry.** The codebase contains zero analytics SDKs, zero
  call-home, zero usage reporting. Audit it yourself: there are no network
  requests to maintainer-controlled endpoints anywhere.
- **No anonymous metrics.** Even crash data stays local. The client logs
  errors to your browser console; the server logs to its own pino stream.
- **No remote configuration.** The project does not pull configuration,
  feature flags, or A/B tests from anywhere. Everything is in your `.env`,
  your `models.json`, and your `settings.json`.
- **No update server.** The Docker image you pull is the Docker image you
  run. There is no auto-update; you decide when to rebuild.

## What the software you operate stores locally

When you run pi-workbench, the following data lands on disk:

| Where | What | Lifetime |
|---|---|---|
| `${WORKSPACE_PATH}` (default `~/.pi-workbench/workspace`) | Your project source code, anything the agent writes | Until you delete it |
| `${SESSION_DIR}` (default `${WORKSPACE_PATH}/.pi/sessions`) | JSONL transcripts of every session: prompts, responses, tool calls + results, model + provider + timestamps + token usage per turn | Until you delete it |
| `${WORKBENCH_DATA_DIR}/projects.json` (default `~/.pi-workbench/projects.json`) | Project registry: id, name, absolute path, createdAt | Until you delete it |
| `${PI_CONFIG_DIR}/auth.json` (default `~/.pi/agent/auth.json`) | LLM provider API keys (Anthropic, OpenAI, etc.) | Until you remove the key |
| `${PI_CONFIG_DIR}/models.json` | Custom provider definitions (OpenAI-compatible endpoints) | Until you delete it |
| `${PI_CONFIG_DIR}/settings.json` | Default model, default thinking level, steering / followUp mode | Until you delete it |
| Browser localStorage | Per-session model selection (`pi-workbench/model/*`), terminal tab list, theme choice (`pi.theme`), right-pane tab, panel widths, view-mode preferences | Until you clear browser storage |
| Browser localStorage (auth) | JWT session token (when `UI_PASSWORD` is set) | Until expiry (default 7 days) or logout |
| In-memory only | Active session message arrays, SSE client connections, live PTY processes | Until container restart |

Session JSONLs include the full text of every prompt you send and every
response the LLM returns, plus arguments and outputs of every tool call
the agent made. **Treat them as sensitive.** They will contain whatever
the agent saw — file contents from `read`, command output from `bash`,
search hits from `grep`, etc.

## What flows out to third parties

When you use pi-workbench, the following network requests leave your deploy:

### LLM provider API requests

Every chat turn sends to your configured provider:

- The system prompt (pi's agent prompt + tool definitions)
- All prior conversation messages on the active branch
- Your new user message + any attached files (image attachments base64-encoded)
- Tool call results (file contents the agent has `read`, command output
  from `bash`, etc.)

The provider's response (assistant text, thinking blocks if enabled, tool
call requests, usage metadata) flows back. Provider terms govern what they
do with this data — pi-workbench has no influence over provider retention,
logging, or training. Read the policy of the provider you've configured:

- **Anthropic:** <https://www.anthropic.com/legal/privacy>
- **OpenAI:** <https://openai.com/policies/privacy-policy/>
- **Google:** <https://policies.google.com/privacy>
- **OpenRouter:** <https://openrouter.ai/privacy>
- **Other providers / self-hosted endpoints:** governed by their own terms or
  by your infrastructure (vLLM / Ollama running on your own hardware sends
  no data out)

### MCP server requests

If you've installed the optional MCP adapter (Phase 17, when shipped),
configured MCP servers will receive the agent's tool calls and return tool
results. The same provider-trust analysis applies to each MCP server you
add.

### Container image pull (one-time)

Pulling the pi-workbench Docker image fetches it from your container
registry of choice (Docker Hub, GHCR, your own). The registry sees your
public IP and the image tag. This is out of pi-workbench's control.

### What does NOT flow out

- **Local file contents** that the agent never sees stay local. The agent
  only sees what its tools fetch (read, grep, etc.) and what you paste.
- **Browser-side data** (theme choice, panel widths, draft text) lives in
  localStorage. It never leaves the browser.
- **Auth credentials** (`UI_PASSWORD`, `JWT_SECRET`, `API_KEY`) stay on
  the server. The browser only stores the JWT token issued after login.

## What an operator sees

If you operate a deploy that other people use, you see the same data the
software stores: workspace files, session JSONLs, browser-side state if
they're using your machine. There is **no isolation between operator and
user** — pi-workbench is single-tenant by design. Run separate deploys per
user if user-level privacy matters.

## Your responsibilities as an operator

If you process other people's data through your pi-workbench deploy, you
become the data controller (GDPR), business (CCPA), or equivalent under
your jurisdiction's law. You are responsible for:

- **Lawful basis** for processing (consent, contract, legitimate interest,
  etc.)
- **Notice** to your users about what you collect, store, and share
- **Subject rights** (access, deletion, rectification, portability)
- **Breach notification** if session JSONLs or workspace data are exposed
- **Cross-border transfer** compliance when your LLM provider is in a
  different jurisdiction than your users
- **Sector-specific rules** (HIPAA, PCI DSS, GLBA, FERPA, etc.) if applicable

The project ships no tooling for any of these. Build them yourself or
deploy pi-workbench only for personal use.

## Children

pi-workbench is not directed at users under 13 (or 16, in jurisdictions
where the GDPR applies). Operators are responsible for not deploying it
in contexts where children would interact with it without appropriate
parental / guardian arrangement.

## Reporting privacy concerns

- **About the software itself** (e.g., you found a code path that exfiltrates
  data without the operator's consent): treat as a security vulnerability
  and report per [SECURITY.md](./SECURITY.md). Do not file a public issue.
- **About a specific deploy** (e.g., an operator handling your data
  improperly): contact that operator directly. The project maintainer
  cannot intervene in third-party deploys.

## Changes

This document evolves with the software. Material changes will be noted in
the release notes for the version that introduces them.
