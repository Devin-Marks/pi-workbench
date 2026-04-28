# pi-workbench

A browser-based workbench for the [pi coding agent](https://github.com/badlogic/pi-mono).
Single-tenant, container-native, self-hosted. HTTP server + REST/SSE API + React UI on
top of `@mariozechner/pi-coding-agent`.

> Status: in active development. See [`pi-webui-dev-plan.md`](./pi-webui-dev-plan.md)
> for the phased roadmap and [`CLAUDE.md`](./CLAUDE.md) for architecture and
> conventions.

## Layout

```
packages/
  server/   # Fastify HTTP server (Node.js + TypeScript)
  client/   # React + Vite frontend
tests/      # Integration test scripts (npx tsx)
```

## Develop

```bash
npm install
npm run dev          # server on :3000, client on :5173
npm run build        # build both packages
npm run check        # tsc + eslint + prettier --check across the workspace
```

The Vite dev server proxies `/api/*` to the Fastify server (including WebSocket
upgrades for the integrated terminal), so the client can call `/api/v1/...`
directly without configuring a base URL.

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
| `SESSION_DIR` | `${WORKSPACE_PATH}/.pi/sessions` | JSONL session storage (Phase 4+). |
| `UI_PASSWORD` | (unset) | If set, enables browser JWT auth. Requires `JWT_SECRET`. |
| `JWT_SECRET` | (unset) | HS256 signing key. Generate with `openssl rand -hex 32`. Rotating immediately invalidates all sessions. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_EXPIRES_IN_SECONDS` | `604800` | JWT lifetime (default 7d). |
| `RATE_LIMIT_LOGIN_MAX` | `10` | Max `/auth/login` attempts per window. |
| `RATE_LIMIT_LOGIN_WINDOW_MS` | `60000` | Login rate-limit window (ms). |
| `CORS_ORIGIN` | (reflect request origin) | Pin to a specific origin in production. |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy (nginx, Caddy, Traefik) so `req.ip` reflects the real client IP — required for the login rate limit to work per-user. |

## Run in Docker

```bash
cp docker/.env.example docker/.env
# edit docker/.env — set UI_PASSWORD + JWT_SECRET, or API_KEY, or leave both blank for no auth
cd docker && docker compose up -d --build
```

`docker/.env` is gitignored — never commit real secrets. The compose file
reads every variable from there: ports, host paths for the workspace and pi
config bind-mounts, auth, log level, reverse-proxy hint, CORS pin. The
defaults work for a same-host browser session with auth disabled.

The compose file mounts `../workspace` into the container (project code
lives there) and bind-mounts the host's `~/.pi/agent` into
`/home/pi/.pi/agent` so the container inherits provider auth and
`models.json` automatically. Override `WORKSPACE_HOST_PATH` /
`PI_CONFIG_HOST_PATH` in `.env` to point elsewhere.

```bash
# tail logs
docker compose -f docker/docker-compose.yml logs -f
# stop
docker compose -f docker/docker-compose.yml down
```

The container speaks plain HTTP. **Never expose port 3000 directly to the
internet** when `UI_PASSWORD` is set — the password would travel in cleartext.
Terminate TLS at a reverse proxy. Minimal Caddy example (`Caddyfile`):

```caddy
pi.example.com {
    reverse_proxy localhost:3000 {
        # SSE needs flush + a generous read timeout
        flush_interval -1
        transport http {
            read_timeout 30m
        }
    }
}
```

If running behind any reverse proxy, set `TRUST_PROXY=true` so the login
rate-limit applies per real client IP rather than per proxy hop.

## PWA

The built UI is a Progressive Web App: install it from the browser address
bar (Chrome/Edge desktop, Android Chrome) or "Add to Home Screen" on iOS
Safari. The service worker caches the shell + hashed assets and updates
silently on the next reload. `/api/v1/*` is always network-only — there's
no offline mode for live agent runs.

## Phase 1 smoke test

```bash
npm run build
npx tsx tests/test-scaffold.ts
```

Builds both packages, starts the compiled server, and asserts `GET /api/v1/health`
returns `{ status: "ok", activeSessions: 0, activePtys: 0 }`.
