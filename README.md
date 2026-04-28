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

The Vite dev server proxies `/api/*` to the Fastify server, so the client can call
`/api/v1/...` directly without configuring a base URL.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Fastify listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `WORKSPACE_PATH` | `/workspace` | Mounted workspace root. |
| `PI_CONFIG_DIR` | `/root/.pi/agent` | Pi config + projects.json directory. |
| `SESSION_DIR` | `${WORKSPACE_PATH}/.pi/sessions` | JSONL session storage (Phase 4+). |
| `UI_PASSWORD` | (unset) | If set, enables browser JWT auth. Requires `JWT_SECRET`. |
| `JWT_SECRET` | (unset) | HS256 signing key. Generate with `openssl rand -hex 32`. Rotating immediately invalidates all sessions. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_EXPIRES_IN_SECONDS` | `604800` | JWT lifetime (default 7d). |
| `RATE_LIMIT_LOGIN_MAX` | `10` | Max `/auth/login` attempts per window. |
| `RATE_LIMIT_LOGIN_WINDOW_MS` | `60000` | Login rate-limit window (ms). |
| `CORS_ORIGIN` | (reflect request origin) | Pin to a specific origin in production. |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy (nginx, Caddy, Traefik) so `req.ip` reflects the real client IP — required for the login rate limit to work per-user. |

## Phase 1 smoke test

```bash
npm run build
npx tsx tests/test-scaffold.ts
```

Builds both packages, starts the compiled server, and asserts `GET /api/v1/health`
returns `{ status: "ok", activeSessions: 0, activePtys: 0 }`.
