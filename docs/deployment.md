# Deployment

This document covers production deployment of pi-forge: TLS termination,
reverse-proxy configuration, auth setup, and the per-environment-variable
guidance for going from "works on localhost" to "works on a public domain
with no surprises."

For the container itself (image, volumes, resources, troubleshooting) see
[`docs/CONTAINERS.md`](./CONTAINERS.md). For Kubernetes and OpenShift, see
[`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md).

## Before you deploy

A short checklist that catches the common foot-guns:

- [ ] `UI_PASSWORD` set, OR `API_KEY` set, OR both — never run a
      network-exposed deploy with both unset. `JWT_SECRET` is
      auto-generated and persisted to `${FORGE_DATA_DIR}/jwt-secret`
      on first boot (override by setting `JWT_SECRET` env explicitly).
- [ ] `JWT_SECRET` either auto-generated (recommended; the persisted
      file is mode 0600 inside your already-mounted data dir) or, if
      overriding, from `openssl rand -hex 32` — not a memorable string.
      Rotating (delete the file or change the env) invalidates all
      sessions immediately, which is what you want after a key leak.
- [ ] Reverse proxy (Caddy / nginx / Traefik) terminates TLS in front of
      the pi-forge. Plain HTTP is fine on `127.0.0.1`; never on a routable
      interface.
- [ ] `TRUST_PROXY=true` so the login rate-limit applies per real client
      IP rather than per proxy hop.
- [ ] `CORS_ORIGIN` pinned to your actual domain (e.g.
      `https://pi.example.com`) — do not leave it reflecting whatever
      the request claims.
- [ ] Workspace + pi config + pi-forge data on backed-up storage. The
      container is replaceable; your sessions and provider keys are not.
- [ ] LLM provider account has a spending limit set. The pi-forge
      surfaces token + cost telemetry in the Context Inspector but does
      not enforce caps.

## Recommended topology

```
┌──────────────┐       HTTPS        ┌──────────────┐
│   Browser    │  ─────────────────▶│   Caddy /    │
│              │                    │  nginx /     │
└──────────────┘                    │  Traefik     │
                                    │  (TLS, auth  │
                                    │   header     │
                                    │   forwarding) │
                                    └──────┬───────┘
                                           │ HTTP, loopback
                                           │ or private network
                                           ▼
                                    ┌──────────────┐
                                    │ pi-forge │
                                    │  container   │
                                    │   :3000      │
                                    └──────────────┘
                                           │
                                           ▼
                                    Bind-mounted volumes
                                    (workspace, config)
```

The proxy handles TLS, HSTS, and (optionally) request logging. The
pi-forge handles app-level auth. Bind the container's port 3000 to
`127.0.0.1` only on the host so nothing besides the proxy can reach it.

## Reverse-proxy snippets

### Caddy (recommended for simplicity)

```caddy
pi.example.com {
    # SSE needs flush-passthrough + a generous read timeout for long
    # agent runs. The transport block lifts read_timeout from the default
    # 30s to 30 minutes; flush_interval -1 disables Caddy's response
    # buffering so each SSE event reaches the browser immediately.
    reverse_proxy localhost:3000 {
        flush_interval -1
        transport http {
            read_timeout 30m
        }
    }

    # Optional: stricter HSTS than Caddy's default
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        # Tighten if you control all the assets — pi-forge has no
        # external script deps post-build, so a strict CSP is feasible
        # Content-Security-Policy "default-src 'self'; img-src 'self' data:; ..."
    }

    # Optional: log to file
    log {
        output file /var/log/caddy/pi-forge.log
    }
}
```

Then: `caddy reload --config /etc/caddy/Caddyfile`. Caddy auto-provisions
TLS certificates from Let's Encrypt — no manual cert handling.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name pi.example.com;

    ssl_certificate     /etc/letsencrypt/live/pi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pi.example.com/privkey.pem;

    # SSE: disable buffering, allow long-lived connections
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Forwarded headers — TRUST_PROXY=true on the pi-forge reads these
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade (terminal route)
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $http_connection;

        # SSE + long agent runs
        proxy_buffering    off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # File upload cap matches the pi-forge's 50 MB per-file
        client_max_body_size 100M;
    }
}

map $http_upgrade $http_connection {
    default upgrade;
    ""      "";
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name pi.example.com;
    return 301 https://$host$request_uri;
}
```

Reload: `nginx -t && nginx -s reload`. Use `certbot --nginx` for cert
auto-provisioning.

### Traefik (Docker labels)

```yaml
# docker/docker-compose.yml additions for Traefik
services:
  pi-forge:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.pi-forge.rule=Host(`pi.example.com`)"
      - "traefik.http.routers.pi-forge.entrypoints=websecure"
      - "traefik.http.routers.pi-forge.tls.certresolver=letsencrypt"
      - "traefik.http.services.pi-forge.loadbalancer.server.port=3000"

      # SSE / long-running response support
      - "traefik.http.middlewares.long-timeout.forwardauth.responseheaders=Cache-Control,X-Accel-Buffering"
```

In your Traefik static config, set
`entryPoints.websecure.transport.respondingTimeouts.readTimeout = 3600s`
so SSE streams don't terminate after the default 60 s. Traefik handles
WebSocket upgrades transparently.

## Production environment variables

The full reference is in [`configuration.md`](./configuration.md#environment-variables).
Production-relevant guidance:

| Variable | Production value | Why |
|---|---|---|
| `UI_PASSWORD` | A strong shared secret if multiple humans share the deploy, OR a personal password for solo use | Required for browser login. |
| `JWT_SECRET` | (leave empty for auto-generation) or `$(openssl rand -hex 32)` to override | Signing key for browser session JWTs. When `UI_PASSWORD` is set and `JWT_SECRET` is empty, the server generates one and persists it to `${FORGE_DATA_DIR}/jwt-secret` (mode 0600); the data dir is already a PVC / bind-mount so tokens survive restarts. Rotate by deleting the file (or rotating the env value). |
| `API_KEY` | `$(openssl rand -hex 32)` | Static bearer token for scripts / CI. Different secret than the browser login. |
| `JWT_EXPIRES_IN_SECONDS` | `86400` (24 h) for higher-trust environments, or leave at default `604800` (7 d) | Shorter = re-login more often = smaller blast radius if a token leaks. |
| `RATE_LIMIT_LOGIN_MAX` | `5` if you're paranoid; default `10` is fine for most | Per-IP login attempts per minute. |
| `RATE_LIMIT_LOGIN_WINDOW_MS` | Default `60000` | Rate-limit window. |
| `TRUST_PROXY` | `true` | Required when behind any reverse proxy so the rate-limit sees real client IPs. |
| `CORS_ORIGIN` | Your exact domain, e.g. `https://pi.example.com` | Pinning prevents same-network attackers from making cross-origin requests using the user's credentials. |
| `LOG_LEVEL` | `info` (default) or `warn` if logs are noisy | `debug` / `trace` are useful during incidents but produce a lot. |
| `MINIMAL_UI` | `true` if your users shouldn't have terminal / git / settings access | Frontend-only gate; doesn't change server route exposure. |

### Setting auth correctly

Either browser auth, API key, or both. Never neither for a network-
exposed deploy.

```bash
# .env example for browser-only auth
UI_PASSWORD=your-strong-password-here
JWT_SECRET=                          # blank — auto-generated and persisted
API_KEY=                             # blank — disabled

# .env example for API-only auth (e.g., headless deploys)
UI_PASSWORD=
JWT_SECRET=
API_KEY=<openssl rand -hex 32 output>

# .env example for both — most common for "humans + scripts share the deploy"
UI_PASSWORD=your-strong-password-here
JWT_SECRET=                          # blank — auto-generated and persisted
API_KEY=<openssl rand -hex 32 output>
```

When `UI_PASSWORD` is set and `JWT_SECRET` is empty, the server
generates a 48-byte random secret on first boot and persists it to
`${FORGE_DATA_DIR}/jwt-secret` (mode 0600). Because `FORGE_DATA_DIR`
is already a PVC / bind-mount in K8s and Docker, the secret survives
restarts and tokens issued before a restart keep working. Set
`JWT_SECRET` explicitly only if you want to manage rotation out-of-band
(e.g. centrally rotated K8s `Secret`). Delete the file to rotate
in-place.

## Backup recommendations

Three things worth backing up:

1. **`${WORKSPACE_HOST_PATH}`** — your code. The agent's writes live here.
   Use whatever you'd use for any code repo: rsync, restic, borg, S3 sync,
   etc. Snapshot via filesystem (ZFS / Btrfs) or storage layer (EBS
   snapshots) if available.
2. **`${WORKSPACE_HOST_PATH}/.pi/sessions/`** — session JSONLs (default
   `${SESSION_DIR}` lives inside the workspace mount). These are the
   complete record of every prompt / response / tool call. Treat as
   sensitive — they contain everything the agent saw.
3. **`${PI_CONFIG_HOST_PATH}`** — provider API keys + custom provider
   definitions. Encrypted at rest if your backup tooling supports it
   (most do).

`projects.json` (under `${FORGE_DATA_HOST_PATH}`) is recoverable
from disk by re-adding projects manually, so it's lower priority — but
also tiny, so back it up anyway.

## Update / rollback

```bash
# Update
git pull origin main
cd docker && docker compose up -d --build

# Rollback (assumes you tagged the deployed version locally)
git checkout v0.X.Y
cd docker && docker compose up -d --build
```

Workspace, sessions, and pi config are on bind mounts — they survive
container rebuilds. The only state lost during update is in-memory
(active SSE connections, live PTY processes). SSE clients reconnect
automatically with backoff; PTYs from before the restart are reaped
(see `pty-manager.ts` IDLE_REAP_MS) and replaced with fresh shells on
reconnect.

## Multi-deploy patterns

pi-forge is single-tenant. To support multiple users, run multiple
deploys:

```yaml
# docker-compose.yml — one service per user
services:
  pi-forge-alice:
    container_name: pi-forge-alice
    image: pi-forge:latest
    ports: ["127.0.0.1:3001:3000"]
    volumes:
      - /srv/alice/workspace:/workspace
      - /srv/alice/.pi/agent:/home/pi/.pi/agent
      - /srv/alice/.pi-forge:/home/pi/.pi-forge
    environment:
      - UI_PASSWORD=${ALICE_PASSWORD}
      - JWT_SECRET=${ALICE_JWT_SECRET}
      - TRUST_PROXY=true

  pi-forge-bob:
    container_name: pi-forge-bob
    image: pi-forge:latest
    ports: ["127.0.0.1:3002:3000"]
    volumes:
      - /srv/bob/workspace:/workspace
      - /srv/bob/.pi/agent:/home/pi/.pi/agent
      - /srv/bob/.pi-forge:/home/pi/.pi-forge
    environment:
      - UI_PASSWORD=${BOB_PASSWORD}
      - JWT_SECRET=${BOB_JWT_SECRET}
      - TRUST_PROXY=true
```

Then route each via the proxy:

```caddy
alice.pi.example.com {
    reverse_proxy localhost:3001 { flush_interval -1; transport http { read_timeout 30m } }
}
bob.pi.example.com {
    reverse_proxy localhost:3002 { flush_interval -1; transport http { read_timeout 30m } }
}
```

Each deploy has its own JWT secret, its own provider keys, its own
projects, its own session history. Zero shared state.

## Monitoring

The shipped health endpoint is enough for liveness probes:

```bash
curl -s http://localhost:3000/api/v1/health
# { "status": "ok", "activeSessions": 0, "activePtys": 0 }
```

The container's `HEALTHCHECK` directive uses this (see
[`docs/CONTAINERS.md`](./CONTAINERS.md#health-check)).

For deeper observability, the pi-forge logs to stdout in pino's JSON
format. Pipe through your log aggregator of choice:

```bash
# Promtail / Loki
docker compose logs -f pi-forge | promtail-pipe

# Vector
docker logs -f pi-forge | vector-pipe

# Just file rotation
docker compose logs -f pi-forge >> /var/log/pi-forge.log
```

Useful log fields to alert on:

- Repeated `terminal exited` with non-zero `exitCode` — agent's bash
  failing or shell crashing
- `pty spawn failed` — node-pty native binding broken (rare in container,
  common on host installs)
- `set model failed` — provider API rejecting requests (auth, quota)
- `unmapped file-manager error` — defensive log; investigate as a
  potential undocumented error path

There is no built-in metrics endpoint (no Prometheus exporter). The
session count and active PTY count from `/api/v1/health` are the only
exported numbers; scrape them with a 30 s job and alert on stuck values
if you care.

## See also

- [`docs/CONTAINERS.md`](./CONTAINERS.md) — Docker image internals,
  resources, troubleshooting
- [`docs/configuration.md`](./configuration.md) — pi config files
  (auth, models, settings) + custom providers
- [`docs/architecture.md`](./architecture.md) — component map, request
  lifecycles
- [`SECURITY.md`](../SECURITY.md) — full threat model + vulnerability
  reporting
- [`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md) — Kubernetes /
  OpenShift recipes
