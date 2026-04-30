# Containers

This document covers everything you need to know about running pi-workbench
in a container — the shipped Docker image, the compose recipe, the volume
layout, the security model, and how to tune resources for your workload.

For Kubernetes / OpenShift deployments, see [`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md).
For non-container reverse-proxy + TLS recipes, see
[`docs/deployment.md`](./deployment.md).

## Why containers

pi-workbench is **single-tenant by design** and the container is the unit of
isolation. The agent's `bash` tool is a real shell, the `write` and `edit`
tools touch the workspace filesystem, and the integrated terminal spawns
a PTY with the workbench process's permissions. Running in a container:

- Bounds what the agent can damage (only the bind-mounted workspace + the
  container's filesystem, which is rebuilt on rebuild)
- Pins the runtime (Node major, native bindings) so terminals don't break
  when you upgrade the host's Node version
- Makes deploys reproducible across hosts
- Gives you a clean reset — `docker compose down && docker compose up -d` =
  fresh container, persisted workspace + config

## Image overview

The Dockerfile (`docker/Dockerfile`) is multi-stage:

| Stage | Base | Purpose |
|---|---|---|
| `builder` | `node:22-alpine` | Installs all deps (incl. devDeps), compiles native bindings (`node-pty`) against the runtime Node, runs `npm run build` for both packages |
| `runtime` | `node:22-alpine` | Copies only the production deps + built artifacts. Adds `git` + `ripgrep` for the agent's tools. Switches to a non-root `pi` user. |

Final image is ~250 MB (Alpine + Node runtime + production deps). No build
toolchain or devDeps in the runtime image.

### What's installed at runtime

- **Node.js 22** (Alpine package)
- **`tini`** — minimal init for proper signal handling and zombie reaping
- **`git`** — required by the agent's bash tool, the file-manager git diffs,
  and the GitPanel routes
- **`ripgrep`** — pi's `grep` tool delegates to `rg` when present; without
  it, code search inside the agent silently degrades

### User and permissions

The image creates a `pi` user (uid/gid configurable via `PUID` / `PGID`
build args; default `1000:1000`) and runs the workbench as that user.

For bind mounts to be writable, the `pi` user inside the container must
match the host user that owns the mounted directory. On Linux:

```bash
PUID=$(id -u) PGID=$(id -g) docker compose -f docker/docker-compose.yml up -d --build
```

On Docker Desktop for macOS, UID translation is automatic — defaults
usually work.

## Volumes

The container expects three bind-mounted volumes:

| Container path | Compose env var | Purpose |
|---|---|---|
| `/workspace` | `WORKSPACE_HOST_PATH` (default `../workspace`) | User's project source code. Projects live as subfolders. |
| `/home/pi/.pi/agent` | `PI_CONFIG_HOST_PATH` (default `~/.pi/agent`) | Pi SDK config — `auth.json`, `models.json`, `settings.json`. Bind-mounting from the host means the container inherits provider auth without copying secrets into the image. |
| `/home/pi/.pi-workbench` | `WORKBENCH_DATA_HOST_PATH` (default `~/.pi-workbench-docker`) | Workbench-owned state — `projects.json`. **Different default** than `PI_CONFIG_HOST_PATH` so the container has its own project list independent of host CLI use. |

### Why three volumes

- **Workspace** is your code; you back it up.
- **`pi` config** is your provider credentials; sharing with the host means
  you don't have to re-enter API keys after rebuild.
- **Workbench data** is the project registry — sharing host vs container
  means coordinating two project lists. Defaulting to a separate host path
  (`~/.pi-workbench-docker`) keeps them isolated. Set both to the same
  path if you want a shared registry.

### Sessions live inside the workspace

Session JSONLs default to `${WORKSPACE_PATH}/.pi/sessions/<projectId>/*.jsonl`
inside the container, which means they live on the workspace bind mount.
Backing up the workspace = backing up your conversation history. Override
with the `SESSION_DIR` env var if you want them elsewhere.

## Environment variables

The compose file forwards every env var pi-workbench reads. See the full
reference in [`README.md`](../README.md#environment-variables); the
container-relevant ones:

| Variable | Container default | Notes |
|---|---|---|
| `PORT` | `3000` | Internal port; map to host via `HOST_PORT`. |
| `WORKSPACE_PATH` | `/workspace` | Fixed inside the container. |
| `PI_CONFIG_DIR` | `/home/pi/.pi/agent` | Fixed inside the container. |
| `WORKBENCH_DATA_DIR` | `/home/pi/.pi-workbench` | Fixed inside the container. |
| `UI_PASSWORD` | (unset) | Browser login password. Requires `JWT_SECRET`. |
| `JWT_SECRET` | (unset) | HS256 signing key. Generate with `openssl rand -hex 32`. |
| `API_KEY` | (unset) | Static bearer token for programmatic clients. |
| `LOG_LEVEL` | `info` | Pino level: `trace` / `debug` / `info` / `warn` / `error`. |
| `TRUST_PROXY` | `false` | Set to `true` when behind a reverse proxy so login rate-limit applies per real client IP. |
| `CORS_ORIGIN` | (reflect) | Pin in production, e.g. `https://pi.example.com`. |
| `MINIMAL_UI` | `false` | Hide terminal / git / last-turn / providers / agent settings. See [`README.md`](../README.md). |

**Auth is opt-in.** With both `UI_PASSWORD` and `API_KEY` unset, the API is
unauthenticated. That's fine for `127.0.0.1`-only deploys; it is **never**
fine when the container is reachable on a routable interface.

## Compose recipe

The shipped compose file (`docker/docker-compose.yml`) covers a typical
single-host deploy. Quickstart:

```bash
cp docker/.env.example docker/.env
# edit docker/.env — at minimum set HOST_PORT and (for any non-loopback
# deploy) UI_PASSWORD + JWT_SECRET, or API_KEY
cd docker && docker compose up -d --build
```

### Operations

```bash
# Logs (follow)
docker compose -f docker/docker-compose.yml logs -f

# Restart after editing .env
docker compose -f docker/docker-compose.yml restart

# Rebuild on code change
docker compose -f docker/docker-compose.yml up -d --build

# Tear down (preserves volumes)
docker compose -f docker/docker-compose.yml down

# Tear down + delete the named volumes (workspace stays — that's a bind mount)
docker compose -f docker/docker-compose.yml down -v
```

### Health check

The container has a baked-in health check that `fetch`s
`http://127.0.0.1:3000/api/v1/health` every 30 s. After the start period,
three failures in a row mark it unhealthy. `docker compose ps` reports the
health state.

## Resource recommendations

Default `docker-compose.yml` doesn't pin CPU / memory limits — pi-workbench
is lightweight at idle and the agent's resource use depends entirely on
what your prompts ask for. Reasonable starting points:

```yaml
services:
  pi-workbench:
    deploy:
      resources:
        limits:
          memory: 2G    # base + room for buffered SSE / one PTY
        reservations:
          memory: 512M
```

Bump if you:

- **Run heavy build commands inside the integrated terminal** (npm builds,
  cargo, etc.) — terminal output is buffered in the agent's session
  history, which lives in memory until the SSE clients drain it
- **Open many terminals** — each PTY is a separate node-pty + child shell,
  ~5-15 MB per shell at rest, more if you `tail -f` something
- **Have very long running sessions** — pi accumulates message history in
  memory; compaction trims it but cycles in and out

CPU is rarely the bottleneck — most workbench CPU is forwarding bytes
between the LLM provider and the browser.

## Networking

The container exposes port 3000 internally. The compose file maps it to
`${HOST_PORT}` on the host (default 3000). Bind to a specific host
interface to limit exposure:

```yaml
ports:
  - "127.0.0.1:${HOST_PORT}:3000"   # loopback only
```

For production behind a reverse proxy on the same host, this is the
recommended posture: only the proxy can reach the workbench, and the
proxy terminates TLS + handles auth headers.

For multi-host deployments, put the workbench on a private network the
proxy can reach. Avoid `0.0.0.0:3000:3000` on a host whose port 3000 is
internet-routable.

### SSE through proxies

Server-Sent Events are long-lived HTTP responses. Most proxies need
explicit configuration to not buffer them:

- **nginx:** `proxy_buffering off; proxy_read_timeout 3600s;`
- **Caddy:** `flush_interval -1` + `read_timeout 30m` (full snippet in
  [`README.md`](../README.md))
- **Traefik:** SSE-friendly out of the box (no buffering by default), but
  set `transport.respondingTimeouts.readTimeout = 3600s` for long agent
  runs

WebSocket support (terminal route) requires the same upgrade-handling on
the proxy side; both nginx and Caddy do this transparently in their
default reverse-proxy directives.

## Security inside the container

- **Non-root user.** The workbench runs as `pi:pi`, never as root. The
  `tini` init handles signal forwarding so the container shuts down
  cleanly on `docker stop`.
- **No new privileges.** The image has no capabilities beyond what the
  base Alpine install provides. The container does not need privileged
  mode, host PID, or `--cap-add`. If you find yourself adding any of
  these, you're working around the threat model — open an issue first.
- **Read-only root filesystem (optional).** You can add
  `read_only: true` to the compose file with appropriate `tmpfs` mounts
  for `/tmp` and `/home/pi/.npm` if you want a hardened deploy. Native
  modules and node_modules live in the image (read-only at runtime by
  default), so this works.

## Updating

The image is **not** auto-updating. To pull a new release:

```bash
git pull origin main
cd docker && docker compose up -d --build
```

The build is incremental — npm dep resolution caches; only changed source
files trigger a rebuild. Cold builds are ~3-5 minutes; warm rebuilds are
~30 seconds.

If you've forked the project, pin to your fork's image tag in the compose
file and update the tag explicitly.

## Troubleshooting

### Container starts but can't write to `/workspace`

UID mismatch. Check the host owner (`ls -ln <host-workspace-path>`) and
either:

- Rebuild with matching `PUID` / `PGID` build args, OR
- `chown -R $(id -u):$(id -g) <host-workspace-path>` to match the
  container's defaults

### Terminal fails to spawn (`posix_spawnp failed`)

The native `node-pty` binding doesn't match the runtime Node version.
This is a host-only issue (the Docker image rebuilds the binding during
its build stage). If you somehow hit it inside the container, your
local image is stale — `docker compose up -d --build` (note `--build`).

### Health check failing on first start

The first request lazy-loads the project registry from disk, which on a
slow filesystem (NFS, network bind mount) can take a few seconds. The
health check has a 10 s start period; tune `start_period` in the compose
file's `healthcheck` block if needed.

### Container can't reach LLM provider

The container needs egress to whatever provider domain you've configured
(`api.anthropic.com`, `api.openai.com`, etc.). On corporate networks behind
an HTTP proxy, set `HTTPS_PROXY` in the environment block.

### `git` commands fail with "fatal: detected dubious ownership"

Recent git versions reject working trees owned by a different UID than
the running process. Either match UIDs (per the bind-mount section
above) or run inside the container:

```bash
docker compose exec pi-workbench git config --global --add safe.directory /workspace/<project>
```

The setting persists across container restarts because it lives in the
`pi` user's git config inside `/home/pi/.gitconfig`, which is on the
container filesystem — not on a bind mount. To persist across rebuilds,
add it to the Dockerfile (or use a config-only bind mount).
