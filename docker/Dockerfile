# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for pi-workbench.
#
#   builder  → install deps, compile server TS, build Vite client
#   runtime  → minimal node:22-alpine with the compiled output and
#              hoisted node_modules; runs as a non-root user.
#
# node-pty has a native binding compiled at install time; the build
# stage installs python3 + make + g++ so the .node file lands. Both
# stages are alpine (musl), so the compiled artifact is portable across
# them.

# ---------- builder ----------
FROM node:22-alpine AS builder

# Native deps for node-pty (Phase 11 will use it; the dep is already in
# server/package.json, so install needs the toolchain regardless).
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy lockfiles + workspace manifests first so dependency installs are
# cached on source-only changes.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# `npm ci --workspaces` honours the root lockfile across all packages.
RUN npm ci --workspaces --include-workspace-root

# Now bring in the source and build.
COPY . .

RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# `tini` for proper PID-1 signal handling (Ctrl-C → SIGTERM → graceful
# shutdown of pi-workbench's onClose hook). Without it, dropped SIGTERMs
# leave SSE clients hanging on `docker compose down`.
#
# PUID/PGID build args let the user match the container's `pi` user to
# their host UID/GID. Default 1000 is the common Linux interactive UID.
# Without this, alpine's `adduser -S` allocates a system-range UID
# (typically 100) that won't match the host owner of the bind-mounted
# /workspace + ~/.pi-workbench dirs, and the container can't write to
# them. Override at build time:
#   docker compose build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g)
ARG PUID=1000
ARG PGID=1000

RUN apk add --no-cache tini && \
    addgroup -g $PGID pi && \
    adduser -D -u $PUID -G pi pi

WORKDIR /app

# Copy from the builder: hoisted node_modules + all built workspaces.
# npm workspaces hoists deps to the root /app/node_modules — there is
# no per-package node_modules directory to copy. Bringing the package
# manifests + built artifacts is enough; module resolution walks up
# from packages/server/dist into /app/node_modules.
COPY --from=builder --chown=pi:pi /app/node_modules ./node_modules
COPY --from=builder --chown=pi:pi /app/package.json ./package.json
COPY --from=builder --chown=pi:pi /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder --chown=pi:pi /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=pi:pi /app/packages/client/package.json ./packages/client/package.json
COPY --from=builder --chown=pi:pi /app/packages/client/dist ./packages/client/dist

# Workspace + pi config + workbench data dirs are mounted at runtime;
# create them so non-root `pi` can read them on first start even if the
# host bind is currently empty.
RUN mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-workbench && \
    chown -R pi:pi /workspace /home/pi/.pi /home/pi/.pi-workbench

USER pi

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WORKSPACE_PATH=/workspace \
    PI_CONFIG_DIR=/home/pi/.pi/agent \
    WORKBENCH_DATA_DIR=/home/pi/.pi-workbench

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
