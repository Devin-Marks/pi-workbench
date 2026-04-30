# pi-workbench

A browser-based workbench for the [pi coding agent](https://github.com/badlogic/pi-mono).
Single-tenant, container-native, self-hosted. HTTP server + REST/SSE API + React UI on
top of `@mariozechner/pi-coding-agent`.

> Status: in active development. See [`pi-webui-dev-plan.md`](./pi-webui-dev-plan.md)
> for the phased roadmap and [`CLAUDE.md`](./CLAUDE.md) for architecture and
> conventions.

## What it is

```
┌─────────────┐  HTTPS   ┌─────────────────┐   embeds   ┌──────────────────┐
│   Browser   │─────────▶│ pi-workbench    │───────────▶│ pi-coding-agent  │
│  (React UI  │ /api/v1  │ Fastify server  │            │ SDK (LLM, tools, │
│   or curl)  │◀─────────│ + SSE stream    │            │  session JSONLs) │
└─────────────┘  events  └─────────────────┘            └──────────────────┘
                                  │
                                  ▼
                       Bind-mounted volumes:
                       /workspace (your code)
                       /home/pi/.pi/agent (provider keys)
                       /home/pi/.pi-workbench (project list)
```

A self-hosted UI for running pi against your code. Chat-driven, with file
browser, integrated terminal, git panel, session branching, token cost
inspector. Same REST + SSE surface for scripts and the browser. Ships as
a Docker image; runs anywhere Docker runs.

For deeper docs: [`docs/architecture.md`](./docs/architecture.md) covers
the component map and request lifecycles. [`docs/CONTAINERS.md`](./docs/CONTAINERS.md)
covers the Docker image. [`docs/deployment.md`](./docs/deployment.md)
covers production deploy with TLS + reverse proxy.

## Quick start (Docker)

```bash
git clone https://github.com/Devin-Marks/pi-workbench.git
cd pi-workbench
cp docker/.env.example docker/.env
# edit docker/.env — set UI_PASSWORD + JWT_SECRET, or API_KEY, or leave both
# blank for local-only no-auth use
cd docker && docker compose up -d --build
```

Open <http://localhost:3000>. First-time setup: add your project (point
at a path inside `WORKSPACE_PATH`), add a provider API key in Settings,
start a session, prompt away.

## Layout

```
packages/
  server/   # Fastify HTTP server (Node.js + TypeScript)
  client/   # React + Vite frontend
docker/     # Dockerfile + docker-compose recipe
docs/       # User + contributor documentation
kubernetes/ # k8s + OpenShift manifests (DEPLOY.md walks them)
tests/      # Integration test scripts (npx tsx)
```

## Develop

```bash
npm install
npm run dev          # server on :3000, client on :5173
npm run build        # build both packages
npm run check        # tsc + eslint + prettier --check across the workspace
```

The Vite dev server proxies `/api/*` to the Fastify server (including
WebSocket upgrades for the integrated terminal), so the client calls
`/api/v1/...` directly without configuring a base URL.

### Native module gotcha (node-pty)

The integrated terminal depends on `node-pty`'s native binding. Prebuilt
binaries ship for common Node versions, but if the binding doesn't match
the Node major you're running on (typical symptom: terminals fail to spawn
with `posix_spawnp failed.` and no other detail), rebuild it from source:

```bash
cd node_modules/node-pty && npx node-gyp rebuild
```

Requires the system C++ toolchain (Xcode CLT on macOS; `build-essential`
on Linux). The Docker image avoids this — its build stage compiles
node-pty against the runtime Node version automatically.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Fastify listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `WORKSPACE_PATH` | `~/.pi-workbench/workspace` | Where project code lives. Docker image overrides to `/workspace` (mounted from host). Point at an existing dir (e.g. `~/Code`) to reuse code you already have on disk. |
| `PI_CONFIG_DIR` | `~/.pi/agent` | Pi SDK config dir (auth.json, models.json, settings.json — owned by the SDK). The Docker image overrides this to `/home/pi/.pi/agent` (mounted from the host's `~/.pi/agent`). |
| `WORKBENCH_DATA_DIR` | `~/.pi-workbench` | Workbench-owned state (projects.json). Defaults to the same dotdir as the workspace (`projects.json` sits alongside `workspace/`). Kept separate from `PI_CONFIG_DIR` so we don't mix our state into the pi SDK's directory. Docker image points this at `/home/pi/.pi-workbench` (mounted from the host's `~/.pi-workbench-docker` by default — container has its own project list). |
| `CLIENT_DIST_PATH` | `<server-dist>/../../client/dist` | Built Vite output served by Fastify in production. |
| `SERVE_CLIENT` | `true` | Set to `false` to skip static-serving (useful when running the dev Vite server in front of the API). |
| `SESSION_DIR` | `${WORKSPACE_PATH}/.pi/sessions` | JSONL session storage. |
| `UI_PASSWORD` | (unset) | If set, enables browser JWT auth. Requires `JWT_SECRET`. |
| `JWT_SECRET` | (unset) | HS256 signing key. Generate with `openssl rand -hex 32`. Rotating immediately invalidates all sessions. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_EXPIRES_IN_SECONDS` | `604800` | JWT lifetime (default 7 d). |
| `RATE_LIMIT_LOGIN_MAX` | `10` | Max `/auth/login` attempts per window. |
| `RATE_LIMIT_LOGIN_WINDOW_MS` | `60000` | Login rate-limit window (ms). |
| `CORS_ORIGIN` | (reflect request origin) | Pin to a specific origin in production. |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy (nginx, Caddy, Traefik) so `req.ip` reflects the real client IP — required for the login rate limit to work per-user. |
| `MINIMAL_UI` | `false` | Hide terminal / git / last-turn / providers / agent settings. Frontend gate; doesn't disable server routes. |

## Run in Docker

```bash
cp docker/.env.example docker/.env
# edit docker/.env
cd docker && docker compose up -d --build
```

`docker/.env` is gitignored — never commit real secrets. The compose file
reads every variable from there: ports, host paths for the workspace and
pi config bind-mounts, auth, log level, reverse-proxy hint, CORS pin. The
defaults work for a same-host browser session with auth disabled.

```bash
docker compose -f docker/docker-compose.yml logs -f
docker compose -f docker/docker-compose.yml down
```

The container speaks plain HTTP. **Never expose port 3000 directly to
the internet** when `UI_PASSWORD` is set — the password would travel in
cleartext. Terminate TLS at a reverse proxy. Minimal Caddy example
(`Caddyfile`):

```caddy
pi.example.com {
    reverse_proxy localhost:3000 {
        flush_interval -1
        transport http {
            read_timeout 30m
        }
    }
}
```

If running behind any reverse proxy, set `TRUST_PROXY=true` so the login
rate-limit applies per real client IP rather than per proxy hop.

For full deployment recipes (nginx / Caddy / Traefik snippets, multi-user
setups, monitoring), see [`docs/deployment.md`](./docs/deployment.md).
For Kubernetes / OpenShift, see [`kubernetes/DEPLOY.md`](./kubernetes/DEPLOY.md).

## API for scripts and CI/CD

Every route the React UI uses is documented and reachable. Three-line
example:

```bash
BASE=http://localhost:3000
KEY=your-api-key

# Create a session, send a prompt, stream the response
SESSION=$(curl -s -X POST $BASE/api/v1/sessions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>"}' | jq -r '.sessionId')
curl -s -X POST $BASE/api/v1/sessions/$SESSION/prompt \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"Run the test suite and fix the failures."}'
curl -N -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/stream
```

Interactive Swagger UI lives at `/api/docs` in any deploy. The full
event catalogue is at [`docs/sse-events.md`](./docs/sse-events.md);
end-to-end Python / Node examples at
[`docs/api-examples.md`](./docs/api-examples.md).

## PWA

The built UI is a Progressive Web App: install it from the browser address
bar (Chrome/Edge desktop, Android Chrome) or "Add to Home Screen" on iOS
Safari. The service worker caches the shell + hashed assets and updates
silently on the next reload. `/api/v1/*` is always network-only — there's
no offline mode for live agent runs.

## Project links

- **Architecture:** [`docs/architecture.md`](./docs/architecture.md)
- **Containers:** [`docs/CONTAINERS.md`](./docs/CONTAINERS.md)
- **Deployment:** [`docs/deployment.md`](./docs/deployment.md)
- **Configuration:** [`docs/configuration.md`](./docs/configuration.md)
- **API examples:** [`docs/api-examples.md`](./docs/api-examples.md)
- **SSE events:** [`docs/sse-events.md`](./docs/sse-events.md)
- **Kubernetes / OpenShift:** [`kubernetes/DEPLOY.md`](./kubernetes/DEPLOY.md)
- **Security:** [`SECURITY.md`](./SECURITY.md)
- **Privacy:** [`PRIVACY.md`](./PRIVACY.md)
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **License:** [`LICENSE`](./LICENSE) (MIT)

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
- **Provider data flow.** Your prompts, attached files, and tool outputs
  are sent to whichever LLM provider you configure. The provider's terms
  govern retention, logging, and training — not pi-workbench. Read them.
  Don't send data you can't legally share with the provider you've picked.
- **Cost overruns.** A misconfigured agent or a stuck loop can burn
  tokens fast. Set provider-side spending limits; pi-workbench surfaces
  per-turn cost in the Context Inspector but enforces no caps of its own.
- **Prompt injection.** Content the agent reads (file contents, tool
  output, web pages) can contain instructions that override yours. The
  pi SDK mitigates the worst cases; the residual threat is real.
- **Network exposure.** The container speaks plain HTTP. Exposing it to
  the public internet without TLS at a reverse proxy + auth is unsafe —
  see [`SECURITY.md`](./SECURITY.md) and [`docs/deployment.md`](./docs/deployment.md).
- **Jurisdictional regulation.** AI use is regulated differently across
  jurisdictions (EU AI Act, US state AI bills, sector-specific rules in
  finance / health / law). Compliance is on you.

Operating pi-workbench means you accept these risks. To the maximum
extent permitted by law, no party associated with this project is liable
for any damages arising from your use of it — see the LICENSE for the
controlling text.

## Related projects

- [pi-mono](https://github.com/badlogic/pi-mono) — the upstream pi
  agent SDK and reference TUI
