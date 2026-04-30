<!-- Thanks for sending a PR! Please fill this in so reviewers can land
it quickly. See CONTRIBUTING.md for the full workflow. -->

## What this changes

<!-- One short paragraph. What does the PR do, and why? Link the issue
it closes if there is one (e.g. "Closes #123"). -->

## Type of change

<!-- Tick what applies — keep one PR to one logical change. If multiple
boxes apply, consider splitting the PR. -->

- [ ] `fix:` bug fix (no API change)
- [ ] `feat:` new feature
- [ ] `refactor:` internal change, no behavior difference
- [ ] `docs:` documentation only
- [ ] `chore:` tooling, deps, build
- [ ] `test:` adding or fixing tests
- [ ] `perf:` performance improvement

## Scope

- [ ] Server (`packages/server/`)
- [ ] Client (`packages/client/`)
- [ ] Docker / deploy (`docker/`, `kubernetes/`)
- [ ] Docs (`docs/`, `README.md`, root markdown)
- [ ] Tests (`tests/`)

## How to verify

<!-- Reproducible steps a reviewer can run locally. Reference the
relevant `tests/test-*.ts` script(s) where applicable — see
CONTRIBUTING.md for the test-script-by-area mapping. -->

```bash
# example
npm install
npm run build
npm run check
npx tsx tests/test-<area>.ts
```

## Screenshots / recordings (UI changes only)

<!-- Drag images in. For interaction changes, a short screen recording
beats a screenshot. -->

## Risk and rollback

<!-- What's the blast radius if this is wrong? Anything that needs a
manual migration step (env var, config file, JSONL session format)?
How would an operator roll this back? -->

## Checklist

- [ ] Atomic commit(s) — one logical change per commit, conventional-commit prefix
- [ ] No `Co-Authored-By` lines or AI-attribution trailers (per [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] `npm run check` passes (`tsc` + `eslint` + `prettier --check`)
- [ ] `npm run build` passes
- [ ] Relevant `tests/test-*.ts` script run and passing
- [ ] New/changed routes have JSON Schema (`schema.body`, `schema.response`, `schema.tags`) so they show up in `/api/docs`
- [ ] No `process.env.*` reads outside `packages/server/src/config.ts`
- [ ] No direct `fs.*` calls in route handlers (goes through `file-manager.ts` / `git-runner.ts`)
- [ ] No raw `fetch()` in components (goes through `lib/api-client.ts`)
- [ ] Default exports — none added (project convention is named exports)
- [ ] If changing config files / env vars, updated [`docs/configuration.md`](../docs/configuration.md) and the env vars table in [`README.md`](../README.md)
- [ ] If changing the SSE event surface, updated [`docs/sse-events.md`](../docs/sse-events.md)
- [ ] If adding a new HTTP route, updated [`docs/api-examples.md`](../docs/api-examples.md) where useful

## Notes for reviewers

<!-- Anything reviewers should look at carefully? Known follow-ups
deliberately deferred to a later PR (link the issue)? -->
