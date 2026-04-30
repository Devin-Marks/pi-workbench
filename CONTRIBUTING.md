# Contributing to pi-workbench

Thanks for the interest. This document covers everything you need to send a
pull request that has a good chance of landing quickly.

## Quick start

```bash
git clone https://github.com/<your-fork>/pi-workbench.git
cd pi-workbench
npm install
npm run dev          # server on :3000, client on :5173
```

The Vite dev server proxies `/api/*` to Fastify (including WebSocket upgrades
for the integrated terminal), so the client calls `/api/v1/...` directly with
no base-URL config. See [`README.md`](./README.md) for environment variables
and the Docker-compose path.

## Before you open a PR

Run the local checks **and** the integration scripts that touch the area you
changed.

### Required for every PR

```bash
npm run check        # tsc + eslint + prettier --check across the workspace
npm run build        # full client + server build (catches Vite-only failures)
```

Any TypeScript error, lint error, or formatting drift will block the PR.

### Run the test scripts that match your change

There's no Jest. Each phase has a hand-rolled integration script under
`tests/`. Run the ones that touch the surface you modified:

| If you changed… | Run |
|---|---|
| Auth flow | `npx tsx tests/test-auth.ts` |
| Project routes / CRUD | `npx tsx tests/test-projects.ts` |
| Session lifecycle | `npx tsx tests/test-session.ts` |
| SSE event stream | `npx tsx tests/test-sse.ts` |
| Generic API smoke | `npx tsx tests/test-api.ts` |
| Pi config (auth/models/settings/skills) | `npx tsx tests/test-config.ts` |
| Docker image | `npx tsx tests/test-docker.ts` |
| File browser / editor / search | `npx tsx tests/test-files.ts` |
| Terminal / PTY | `npx tsx tests/test-terminal.ts` |
| Diff routes | `npx tsx tests/test-diff.ts` |
| Git routes | `npx tsx tests/test-git.ts` |
| Multipart attachments | `npx tsx tests/test-attachments.ts` |

Each script spawns its own Fastify server (no shared global state), prints
PASS/FAIL per assertion, and exits 0 or 1. They're safe to run in parallel
on different ports.

If you added new behaviour that isn't covered, add it to the appropriate
script — or create `tests/test-<feature>.ts` if it's a new surface.

## Branch + commit conventions

- Branch off `main`. Name your branch with intent (`fix/session-fork-hijack`,
  `feat/context-inspector-search`).
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`. The
  history is full of examples — match the prevailing style.
- **Atomic commits** — one logical change per commit. The commit message
  explains the *why*, not just the *what*. Bug fixes should describe the
  root cause and the symptom users saw.
- No `Co-Authored-By` or AI-attribution lines. The repo's commit history is
  unsigned and human-attributed.

## Pull request checklist

The PR template walks you through this; the short version:

- [ ] `npm run check` and `npm run build` pass locally
- [ ] Relevant test script(s) pass (list which ones in the PR description)
- [ ] If the change affects the dev plan, `pi-webui-dev-plan.md` is updated
- [ ] If it touches a Phase X polish item, `notes/DEFERRED.md` row is
      either resolved (struck through with `**Resolved YYYY-MM-DD**:` +
      a one-paragraph summary) or has a re-defer rationale
- [ ] If it's a phase milestone, a code-review pass was run (see
      [`notes/REVIEWS.md`](./notes/REVIEWS.md) for cadence)
- [ ] Public route changes ship with `schema.description` + JSON-Schema
      `body` / `response` so the OpenAPI spec at `/api/docs` stays accurate

## Architecture and conventions

[`CLAUDE.md`](./CLAUDE.md) is the canonical reference for:

- The single-tenant threat model
- "All filesystem ops go through `file-manager.ts`; all session interactions
  go through `session-registry.ts`" rule
- Atomic-write pattern (`tmp + rename`) for every config file write
- Path validation in `file-manager.ts` (every method validates against the
  project root before touching disk)
- No default exports; named exports everywhere
- React state lives in Zustand stores, not component state
- All HTTP from the client goes through `lib/api-client.ts`

Read it once before sending a non-trivial PR — many recurring review
comments are addressed there already.

## Reporting issues

- **Security vulnerabilities:** see [`SECURITY.md`](./SECURITY.md). Do NOT
  open a public issue.
- **Bugs:** GitHub Issues. Use the bug-report template; include the
  reproduction steps, expected behaviour, observed behaviour, and the
  output of `GET /api/v1/health` if relevant.
- **Feature requests:** GitHub Issues with the feature-request template.
  Linking to a real use-case helps prioritise.

## Code of conduct

By participating you agree to abide by the
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Contributor License Agreement

Non-trivial contributions require sign-off on the project CLA — see
[`CLA.md`](./CLA.md). The PR template links to a one-click acknowledgement;
typo fixes and one-line changes are exempt.
