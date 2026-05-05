# Privacy

pi-forge is open-source software you self-host. The project does not
operate any servers on your behalf and is designed not to send usage data
back to the maintainer. This document describes, to the best of the
maintainer's knowledge as of the current release, what data the software
stores locally and what flows out of it to third parties.

This document is informational. It is not a privacy notice, not legal
advice, and not a warranty about the software's behavior. If you operate
a pi-forge deploy that other people use, treat it as a starting point
for your own privacy notice rather than a substitute for one. Audit the
source for your release before relying on any specific behavior described
here — see the project commit history for what has actually changed.

## Design intent

The project is intentionally designed to minimize outbound data flow to
parties other than the LLM provider you configure. As of the current
release, the maintainer is not aware of:

- Analytics SDKs, usage reporting, or call-home logic in the codebase.
  Errors generally surface in the browser console (client) or the local
  pino stream (server) rather than going to a remote endpoint.
- Remote configuration, feature flags, or A/B test fetches. Configuration
  is intended to live in your `.env`, `models.json`, and `settings.json`.
- An auto-update mechanism. The Docker image you pull is what runs; you
  choose when to rebuild.

These statements describe intent and current state, not a guarantee. New
dependencies, future features (e.g. an opt-in update check), or operator
configuration could change what flows out. Verify with a network monitor
in your environment if any of this is load-bearing for your use case.

## What the software you operate stores locally

When you run pi-forge, the following data lands on disk:

| Where | What | Lifetime |
|---|---|---|
| `${WORKSPACE_PATH}` (default `~/.pi-forge/workspace`) | Your project source code, anything the agent writes | Until you delete it |
| `${SESSION_DIR}` (default `${WORKSPACE_PATH}/.pi/sessions`) | JSONL transcripts of every session: prompts, responses, tool calls + results, model + provider + timestamps + token usage per turn | Until you delete it |
| `${FORGE_DATA_DIR}/projects.json` (default `~/.pi-forge/projects.json`) | Project registry: id, name, absolute path, createdAt | Until you delete it |
| `${PI_CONFIG_DIR}/auth.json` (default `~/.pi/agent/auth.json`) | LLM provider API keys (Anthropic, OpenAI, etc.) | Until you remove the key |
| `${PI_CONFIG_DIR}/models.json` | Custom provider definitions (OpenAI-compatible endpoints) | Until you delete it |
| `${PI_CONFIG_DIR}/settings.json` | Default model, default thinking level, steering / followUp mode | Until you delete it |
| Browser localStorage | Per-session model selection (`pi-forge/model/*`), terminal tab list, theme choice (`pi.theme`), right-pane tab, panel widths, view-mode preferences | Until you clear browser storage |
| Browser localStorage (auth) | JWT session token (when `UI_PASSWORD` is set) | Until expiry (default 7 days) or logout |
| In-memory only | Active session message arrays, SSE client connections, live PTY processes | Until container restart |

Session JSONLs include the full text of every prompt you send and every
response the LLM returns, plus arguments and outputs of every tool call
the agent made. **Treat them as sensitive.** They will contain whatever
the agent saw — file contents from `read`, command output from `bash`,
search hits from `grep`, etc.

## What flows out to third parties

When you use pi-forge, the following network requests leave your deploy:

### LLM provider API requests

Every chat turn sends to your configured provider:

- The system prompt (pi's agent prompt + tool definitions)
- All prior conversation messages on the active branch
- Your new user message + any attached files (image attachments base64-encoded)
- Tool call results (file contents the agent has `read`, command output
  from `bash`, etc.)

The provider's response (assistant text, thinking blocks if enabled, tool
call requests, usage metadata) flows back. Provider terms govern what they
do with this data — pi-forge has no influence over provider retention,
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

Pulling the pi-forge Docker image fetches it from your container
registry of choice (Docker Hub, GHCR, your own). The registry sees your
public IP and the image tag. This is out of pi-forge's control.

### What is intended to stay local

The following are designed to remain on your machine and are not, to the
maintainer's knowledge, transmitted by the project's own code paths:

- **Local file contents** that the agent never reads. The agent typically
  only sees what its tools fetch (`read`, `grep`, etc.) or what you paste —
  but anything those tools fetch is then sent to the LLM provider as part
  of the conversation context.
- **Browser-side preferences** (theme choice, panel widths, draft text)
  held in localStorage.
- **Auth credentials** (`UI_PASSWORD`, `JWT_SECRET`, `API_KEY`) held on
  the server. The browser stores the JWT token issued after login.

Operator configuration, third-party browser extensions, network middleboxes,
and reverse-proxy logging are outside the project's control and may
capture or forward any of this.

## What an operator sees

If you operate a deploy that other people use, you see the same data the
software stores: workspace files, session JSONLs, browser-side state if
they're using your machine. There is **no isolation between operator and
user** — pi-forge is single-tenant by design. Run separate deploys per
user if user-level privacy matters.

## Your responsibilities as an operator

If you process other people's data through your pi-forge deploy, you
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
deploy pi-forge only for personal use.

## Children

pi-forge is not directed at users under 13 (or 16, in jurisdictions
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

This document evolves with the software. The maintainer aims to call out
material changes in release notes when reasonably practical, but the
authoritative source is always the code at the version you're running.

## No warranty

This document is provided for informational purposes only. Like the
software itself, it is provided "as is" without warranty of any kind. See
the [LICENSE](./LICENSE) and the **Risks & disclaimer** section in
[README.md](./README.md). Nothing here creates a contractual obligation,
an SLA, or a representation that the software's data-flow behavior
matches this description in any specific release or deployment.
