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
no base-URL config. Environment variables are in
[`docs/configuration.md`](./docs/configuration.md); the Docker-compose path
is in [`docs/CONTAINERS.md`](./docs/CONTAINERS.md).

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
| Session forking (SDK in-place mutation guard) | `npx tsx tests/test-fork.ts` |
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

## Contribution terms

There is no separate Contributor License Agreement to sign. By opening a
pull request against this repository, you represent and agree to the
following — these are intentionally light, in line with the project's
MIT-only posture:

- **Original work.** The contribution is your own work, or you otherwise
  have the right to submit it under the project's license. You're not
  copying code from a source whose license is incompatible with MIT
  (e.g. GPL/AGPL pasted into a runtime file), and you're not submitting
  someone else's proprietary code.
- **MIT licensing.** You license your contribution to the project and to
  downstream users under the same MIT [LICENSE](./LICENSE) as the rest of
  the codebase. You retain copyright on your contribution.
- **Patent grant.** To the extent you hold any patent claims that read on
  your contribution, you grant a perpetual, worldwide, royalty-free
  license to make, use, sell, and distribute your contribution and works
  incorporating it, on the same terms as the MIT license. (This mirrors
  the patent grant in Apache-2.0 §3 and is included so the project isn't
  exposed if a contributor later asserts a patent against their own code.)
- **No warranty from you.** Like the rest of the project, your
  contribution is provided "as is." You're not on the hook for warranty,
  support, or indemnification.

Trivial fixes (typo corrections, formatting-only changes, comment edits)
don't need to think about any of this — submitting them is the
representation.

If your employer claims rights in code you write, get their sign-off
before opening the PR. The maintainer cannot determine your employment
arrangement and will rely on your representation above.
