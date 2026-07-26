/**
 * Session index persistence/cache contract:
 * - malformed persisted index is ignored and rebuilt from the supplied JSONL scan
 * - a clean project is served from the in-memory/persistent index
 * - explicit invalidation forces the next lookup to rebuild
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    path: join(projectSessionDir, "parent", "run-1", "session.jsonl"),
    cwd: sessionDir,
    name: "Child session",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    modifiedAt: new Date("2026-01-02T03:05:06.000Z"),
    messageCount: 7,
    firstMessage: "hello",
    parentSessionId: "parent-session",
    runId: "run-1",
    isExternalLive: true,
    externalState: "running" as const,
  };

  await mkdir(dirname(record.path), { recursive: true });

  const index = (await import(
    resolve(repoRoot, "packages/server/dist/session-index.js")
  )) as typeof import("../packages/server/src/session-index.js");
  const discover = async () => {
    scans += 1;
    return [record];
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
    assert("clean project lookup avoids repeated discovery", scans === 1 && second.length === 1);

    const persisted = JSON.parse(await readFile(join(dataDir, "session-index.json"), "utf8")) as {
      version?: number;
      projects?: Record<string, { sessions?: Record<string, unknown>[] }>;
    };
    const stored = persisted.projects?.[projectId]?.sessions?.[0];
    assert(
      "versioned index persists sidebar and location fields",
      persisted.version === 2 &&
        stored?.parentSessionId === record.parentSessionId &&
        stored?.runId === record.runId &&
        stored?.externalState === record.externalState &&
        stored?.path === record.path,
    );

    index.invalidateSessionIndex(projectId);
    await index.getIndexedProjectSessions(projectId, sessionDir, projectSessionDir, discover);
    assert("explicit invalidation rebuilds on next lookup", scans === 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
}

void main();
