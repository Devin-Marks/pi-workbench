import { randomUUID } from "node:crypto";
import * as nodePty from "node-pty";

/**
 * Per-project PTY tracking. Each browser terminal tab opens its own
 * WebSocket which spawns its own PTY here — never share PTY instances
 * across clients (single-tenant or not, mixed input streams break the
 * shell's line-edit state in ways users notice immediately).
 *
 * The map key is a generated `ptyId` so the manager doesn't have to
 * trust client-provided IDs. Routes hold the `ptyId` in their closure
 * and use it for cleanup.
 *
 * On graceful shutdown (Fastify `onClose` hook calls `disposeAllPtys`),
 * every spawned process is killed. A safety-net `process.on("exit")`
 * mirror is registered once at module load — guards against the
 * fastify hook missing in pathological exit paths.
 */

export interface SpawnOptions {
  shell?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface ManagedPty {
  ptyId: string;
  process: nodePty.IPty;
  /** Snapshot of the cwd this PTY was spawned in, for diagnostics. */
  cwd: string;
}

const ptys = new Map<string, ManagedPty>();

/**
 * Default shell selection. SHELL is the user-set value (login shell);
 * /bin/sh is the POSIX baseline guaranteed by alpine + every distro
 * we'd plausibly ship under. Don't fall back to bash unconditionally —
 * alpine doesn't ship it.
 */
function defaultShell(): string {
  return process.env.SHELL ?? "/bin/sh";
}

export function spawnPty(opts: SpawnOptions): ManagedPty {
  const shell = opts.shell ?? defaultShell();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  // Pass the parent env by default. Overrides come through opts.env
  // (e.g. tests injecting PS1='$ '). We deliberately preserve PATH so
  // the user's tooling (npm, git, etc.) is reachable from the
  // spawned shell.
  const env = opts.env ?? process.env;
  const proc = nodePty.spawn(shell, [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: opts.cwd,
    // node-pty's TS type wants `Record<string, string>` here; ProcessEnv
    // tolerates undefined values so coerce by stripping them.
    env: filterEnv(env),
  });
  const ptyId = randomUUID();
  const managed: ManagedPty = { ptyId, process: proc, cwd: opts.cwd };
  ptys.set(ptyId, managed);
  // Auto-cleanup on the underlying process exiting (the user typed
  // `exit`, ran `kill -9 $$`, segfaulted a tool, etc.). The route
  // handler also calls killPty on WS close — one of the two paths
  // wins; whichever is second is a no-op.
  proc.onExit(() => {
    ptys.delete(ptyId);
  });
  return managed;
}

export function getPty(ptyId: string): ManagedPty | undefined {
  return ptys.get(ptyId);
}

export function killPty(ptyId: string): boolean {
  const managed = ptys.get(ptyId);
  if (managed === undefined) return false;
  ptys.delete(ptyId);
  try {
    // SIGTERM lets the shell run its trap handlers; the OS reaps the
    // pty fd. node-pty's kill() defaults to SIGHUP which some shells
    // (e.g. bash with `huponexit`) handle differently — SIGTERM is
    // more predictable across shells.
    managed.process.kill("SIGTERM");
  } catch {
    // Process already exited between get + kill. The map delete above
    // is the only state we care about.
  }
  return true;
}

export function ptyCount(): number {
  return ptys.size;
}

/**
 * Kill every tracked PTY. Called from Fastify's `onClose` hook so
 * `docker compose down` and graceful test teardown don't leak shells.
 */
export function disposeAllPtys(): void {
  for (const ptyId of Array.from(ptys.keys())) {
    killPty(ptyId);
  }
}

// Belt-and-suspenders: if the process exits without going through
// Fastify's onClose (uncaught throw, SIGKILL on the parent that we
// somehow caught, etc.), at least try to reap children. `process.exit`
// listeners run synchronously, so we can't await anything — the
// kill call goes out as a best effort.
let exitHandlerInstalled = false;
function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const managed of ptys.values()) {
      try {
        managed.process.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    ptys.clear();
  });
}
installExitHandler();

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
