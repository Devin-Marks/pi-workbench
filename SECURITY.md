# Security Policy

## Supported versions

pi-workbench follows a rolling-release model from `main`. The latest
tagged release receives security fixes; older releases do not.

| Version | Supported |
|---|---|
| Latest tag (`main`) | ✅ |
| Older tags | ❌ |

When a security fix lands, it ships in the next tagged release. There is
no LTS branch.

## Threat model

pi-workbench is **single-tenant** by design — one deploy, one user, one
workspace root. The threat model assumes:

- The workbench process trusts its own user. There is no isolation between
  the user and the agent's filesystem / shell access; the agent runs with
  full permissions of the workbench process.
- The container is the unit of isolation. Run pi-workbench in Docker (or
  another container runtime) so the agent's bash tool can't damage the
  host outside the bind-mounted workspace.
- The HTTP surface is **not** safe to expose to the public internet over
  plain HTTP. Always terminate TLS at a reverse proxy (Caddy, nginx,
  Traefik) when network-exposing the workbench, and always set
  `UI_PASSWORD` (or `API_KEY`) for any non-loopback deployment.
  `JWT_SECRET` is auto-generated and persisted to the data-dir PVC /
  bind-mount on first boot — set it explicitly only to override.
- Cross-project / cross-tenant isolation is **out of scope**. The project
  registry trusts every project path the user adds; once added, the agent
  can read and modify anything inside that path.

## What the project tries to defend against

- **Path traversal** in route handlers. Every filesystem operation goes
  through `packages/server/src/file-manager.ts`, which validates the
  resolved absolute path is inside the project root before touching disk
  (symlink-followed via `realpath` walk; rejects with a typed
  `PathOutsideRootError` → 403).
- **Auth bypass** on routes. Every route under `/api/v1/` (except the
  explicitly-public `/health`, `/auth/*`, `/ui-config`, and `/terminal`
  WebSocket handshake) goes through the global JWT/API-key check. New
  routes that should be public must explicitly opt in via
  `config: { public: true }`.
- **Brute-force login** on `/api/v1/auth/login`. Rate-limited per IP
  (defaults: 10 attempts per 60 s, configurable via `RATE_LIMIT_LOGIN_*`).
  When behind a reverse proxy, set `TRUST_PROXY=true` so the limit
  applies per real client IP.
- **JWT token leaks via logs**. The terminal WS upgrade URL contains
  `?token=...` because browsers can't attach `Authorization` headers on
  WebSocket connects. Pino's `req` serializer redacts `token=...` query
  params globally before any log line is emitted.
- **Malicious file uploads** in the file browser. Uploads go through the
  same path validation as everything else, plus a per-file (500 MB) and
  aggregate (2 GB) cap, a 16-files-per-request cap, plus a SHA-256
  round-trip check (client computes, server verifies).
- **Prompt-injection via attached text files**. The chat input's text-file
  attachment path uses fenced-code-block insertion with a fence longer than
  the longest backtick-run in the file contents. A hostile attached file
  can't escape the fence to inject instructions to the LLM.

## What is explicitly out of scope

- **A trusted user running malicious commands.** The agent's `bash` tool
  is a real shell. If your workspace has secrets you don't want the agent
  to read, don't add it as a project.
- **A compromised provider.** The workbench passes user prompts to whichever
  LLM provider you've configured. If that provider is malicious or
  compromised, model output can include arbitrary content.
- **Mass user / cross-tenant attacks.** There IS no multi-user model.

## Reporting a vulnerability

**Do not** open a public issue or PR for security vulnerabilities.

Use GitHub's private vulnerability reporting:

```
Repository → Security → Advisories → Report a vulnerability
```

If GitHub's advisory feature is unavailable, email the maintainer at the
address in `git log --format="%ae" | head -1` for the most recent commit.
Encrypt with the project's PGP key if one is published in the GitHub profile.

### What to include

1. A description of the vulnerability and its impact
2. Steps to reproduce (with a minimal proof-of-concept where possible)
3. The version / commit SHA you tested against
4. Whether the issue is currently public anywhere (Twitter, Stack Overflow,
   another bug tracker, etc.)

### Response window

pi-workbench is maintained on a best-effort basis. The maintainer aims for
the following response targets, but they are guidelines rather than
guarantees — actual timing depends on maintainer availability, severity,
upstream dependencies, and the complexity of the fix:

- **Acknowledge** the report within roughly 5 business days when reasonably
  possible.
- **Triage** (confirm reproducibility, assess severity) on a similar
  best-effort basis, typically within a couple of weeks.
- **Fix and disclose** on a timeline proportional to severity:
  - Critical (e.g. RCE, auth bypass, container escape): prioritized for the
    next patched release, with coordinated public disclosure shortly after
    the patch ships when feasible.
  - High (e.g. path traversal, auth-required RCE, sensitive data exposure):
    aimed for the next reasonable release window, with public disclosure
    alongside the patch.
  - Medium / Low: included in the next regular release and noted in the
    release notes.

A CVE may be requested through GitHub's advisory pipeline for confirmed
Critical or High severity issues, at the maintainer's discretion.

These targets describe intent, not contractual service levels. The project
is provided under MIT and offers no warranty or support obligation — see
the [LICENSE](./LICENSE) and the **Risks & disclaimer** section in
[README.md](./README.md).

## Out of scope

The following are not vulnerabilities and will be closed as such:

- Reports against unpatched dependencies where the dependency is reachable
  only through code paths we don't expose. (Supply-chain reviews welcome via
  PR; we keep `npm audit` clean for direct deps.)
- Self-XSS that requires the user to paste hostile content into a developer
  console.
- Anything that requires bypassing the deploy assumptions in the threat
  model (e.g., "RCE if you point the agent at /etc and tell it to delete
  files" is the agent doing what you told it to do).
- Reports about LLM provider behaviour (prompt-injection of the model
  itself, jailbreaks, etc.). Those belong with the provider.
