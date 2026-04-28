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

## Phase 1 smoke test

```bash
npm run build
npx tsx tests/test-scaffold.ts
```

Builds both packages, starts the compiled server, and asserts `GET /api/v1/health`
returns `{ status: "ok", activeSessions: 0, activePtys: 0 }`.
