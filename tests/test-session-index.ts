/**
 * Session index persistence/cache contract:
 * - malformed persisted index is ignored and rebuilt from the supplied JSONL scan
 * - a clean project is served from the in-memory/persistent index
 * - explicit invalidation and manual reset force the next lookup to rebuild
 * - reset does not mutate source JSONLs or allow a stale in-flight scan to win
 * - persisted records contain generic metadata only; names/previews rehydrate from JSONL
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-session-index-data-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-forge-session-index-sessions-"));
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = sessionDir;
  process.env.WORKSPACE_PATH = sessionDir;
  process.env.PI_CONFIG_DIR = await mkdtemp(join(tmpdir(), "pi-forge-session-index-config-"));
  await writeFile(join(dataDir, "session-index.json"), "{ malformed", "utf8");

  const projectId = "session-index-test";
  const projectSessionDir = join(sessionDir, projectId);
  await mkdir(projectSessionDir);
  let scans = 0;
  const record = {
    sessionId: "child-session",
    path: join(projectSessionDir, "session-index-test.jsonl"),
    cwd: sessionDir,
    name: "Child session",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    modifiedAt: new Date("2026-01-02T03:05:06.000Z"),
    messageCount: 7,
    firstMessage: "hello",
  };

  await mkdir(dirname(record.path), { recursive: true });
  await writeFile(record.path, '{"type":"session"}\n', "utf8");

  const index = (await import(
    resolve(repoRoot, "packages/server/src/session-index.ts")
  )) as typeof import("../packages/server/src/session-index.js");
  let records = [record];
  let delayedScan: Promise<void> | undefined;
  const discover = async () => {
    scans += 1;
    await delayedScan;
    return records;
  };

  try {
    const first = await index.getIndexedProjectSessions(
      projectId,
      sessionDir,
      projectSessionDir,
      discover,
    );
    assert(
      "malformed index rebuilds from source",
      scans === 1 && first[0]?.sessionId === record.sessionId,
    );

    const second = await index.getIndexedProjectSessions(
      projectId,
      sessionDir,
      projectSessionDir,
      discover,
    );
    assert(
      "clean project lookup preserves the source-derived session name",
      scans === 1 && second.length === 1 && second[0]?.name === record.name,
    );

    const persisted = JSON.parse(await readFile(join(dataDir, "session-index.json"), "utf8")) as {
      version?: number;
      projects?: Record<string, { sessions?: Record<string, unknown>[] }>;
    };
    const stored = persisted.projects?.[projectId]?.sessions?.[0];
    assert(
      "versioned index persists generic metadata only, never names or preview content",
      persisted.version === 3 &&
        stored?.path === record.path &&
        JSON.stringify(Object.keys(stored ?? {}).sort()) ===
          JSON.stringify(["createdAt", "cwd", "messageCount", "modifiedAt", "path", "sessionId"]) &&
        !JSON.stringify(stored).includes(record.name) &&
        !JSON.stringify(stored).includes(record.firstMessage),
    );

    index.invalidateSessionIndex(projectId);
    await index.getIndexedProjectSessions(projectId, sessionDir, projectSessionDir, discover);
    assert("explicit invalidation rebuilds on next lookup", scans === 2);

    const outsideDir = await mkdtemp(join(tmpdir(), "pi-forge-session-index-outside-"));
    const outsidePath = join(outsideDir, "foreign.jsonl");
    const escapedPath = join(projectSessionDir, "escaped.jsonl");
    await writeFile(outsidePath, '{"type":"session"}\n', "utf8");
    await symlink(outsidePath, escapedPath);
    records = [{ ...record, sessionId: "escaped-session", path: escapedPath }];
    index.invalidateSessionIndex(projectId);
    const escaped = await index.getIndexedProjectSessions(
      projectId,
      sessionDir,
      projectSessionDir,
      discover,
    );
    assert(
      "discovery rejects symlink paths outside the project session root",
      escaped.length === 0,
    );
    await rm(outsideDir, { recursive: true, force: true });
    records = [record];

    const sourceBeforeReset = await readFile(record.path, "utf8");
    await index.resetSessionIndex(projectId);
    const afterReset = JSON.parse(await readFile(join(dataDir, "session-index.json"), "utf8")) as {
      projects?: Record<string, unknown>;
    };
    assert(
      "reset removes only the persisted project cache entry",
      afterReset.projects?.[projectId] === undefined,
    );
    assert(
      "reset does not alter session source files",
      (await readFile(record.path, "utf8")) === sourceBeforeReset,
    );
    await index.getIndexedProjectSessions(projectId, sessionDir, projectSessionDir, discover);
    assert("reset forces the next lookup to rebuild", scans === 4);

    let releaseDelayedScan!: () => void;
    index.invalidateSessionIndex(projectId);
    delayedScan = new Promise<void>((resolveDelay) => {
      releaseDelayedScan = resolveDelay;
    });
    const staleRebuild = index.getIndexedProjectSessions(
      projectId,
      sessionDir,
      projectSessionDir,
      discover,
    );
    while (scans !== 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    index.invalidateSessionIndex(projectId);
    records = [{ ...record, sessionId: "fresh-session" }];
    releaseDelayedScan();
    await staleRebuild;
    delayedScan = undefined;
    const refreshed = await index.getIndexedProjectSessions(
      projectId,
      sessionDir,
      projectSessionDir,
      discover,
    );
    assert(
      "delayed stale rebuild cannot overwrite an invalidated generation",
      scans === 6 && refreshed[0]?.sessionId === "fresh-session",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
}

void main();
