/**
 * Phase 4/15 fork integration test.
 *
 * Pins the SDK in-place mutation behavior + the workbench's per-source
 * lock + source-restore dance. These are the bits with the longest
 * "this is subtle, here's why" comment block in `session-registry.ts`,
 * and the most likely to silently corrupt sessions on an SDK upgrade.
 *
 * What we verify:
 *   1. forkSession() returns a NEW LiveSession with a different
 *      sessionId from the source.
 *   2. The fork's sessionFile is a NEW path on disk (not the source's).
 *   3. The source's sessionManager.sessionFile is unchanged AFTER the
 *      fork (the SDK's destructive in-place mutation is undone by the
 *      source-restore dance).
 *   4. Two concurrent forks from the same source serialize through
 *      forkLocks — the source ends up pointing at its original
 *      sessionFile after both forks complete (without the per-source
 *      lock, the second fork would capture the first fork's
 *      sessionFile as `originalSourceFile` and "restore" the source
 *      to the wrong path).
 *
 * This test does NOT exercise the SDK's createBranchedSession beyond
 * what's needed to verify the workbench's wrapper. It uses the
 * setSessionName + appendMessage trick from test-session.ts to get the
 * source session's JSONL into a non-empty state so the SDK has
 * something to fork from.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function setupEnv(): Promise<{
  workspacePath: string;
  configDir: string;
  sessionDir: string;
}> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-workbench-fork-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-workbench-fork-cfg-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.SESSION_DIR = sessionDir;
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  return { workspacePath, configDir, sessionDir };
}

interface TestSession {
  sessionId: string;
  sessionManager: {
    appendMessage: (msg: unknown) => string;
    getSessionFile: () => string | undefined;
    getEntries: () => Array<{ id: string }>;
  };
  setSessionName: (name: string) => void;
}
interface TestLive {
  session: TestSession;
  sessionId: string;
  projectId: string;
}
interface TestRegistry {
  createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
  getSession: (id: string) => TestLive | undefined;
  forkSession: (sessionId: string, entryId: string) => Promise<TestLive>;
  disposeAllSessions: () => Promise<void>;
}

async function main(): Promise<void> {
  const { workspacePath, configDir } = await setupEnv();
  console.log(`[test-fork] WORKSPACE_PATH=${workspacePath}`);

  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;

  try {
    const projectId = "proj-fork-" + Date.now().toString(36);

    // Create a source session and seed it with two assistant messages
    // so we have two distinct entry ids to fork from. setSessionName
    // first so the JSONL flushes; appendMessage twice for the entries.
    const source = await registry.createSession(projectId, workspacePath);
    source.session.setSessionName("source");
    const entryId1 = source.session.sessionManager.appendMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "first turn" }],
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const entryId2 = source.session.sessionManager.appendMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "second turn" }],
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    assert(
      "two distinct entryIds were assigned by appendMessage",
      typeof entryId1 === "string" &&
        typeof entryId2 === "string" &&
        entryId1.length > 0 &&
        entryId2.length > 0 &&
        entryId1 !== entryId2,
      `${entryId1} vs ${entryId2}`,
    );

    const sourceFile = source.session.sessionManager.getSessionFile();
    assert(
      "source session has a sessionFile after appendMessage",
      typeof sourceFile === "string" && sourceFile.length > 0,
      String(sourceFile),
    );

    // 1. Single fork — verify the new session has a different id and a
    //    different sessionFile.
    const fork1 = await registry.forkSession(source.sessionId, entryId1);
    assert(
      "fork returns a LiveSession with a different sessionId",
      fork1.sessionId !== source.sessionId,
      `source=${source.sessionId} fork=${fork1.sessionId}`,
    );
    const fork1File = fork1.session.sessionManager.getSessionFile();
    assert(
      "fork's sessionFile is a different path than source's",
      typeof fork1File === "string" && fork1File.length > 0 && fork1File !== sourceFile,
      `source=${sourceFile} fork=${fork1File}`,
    );

    // 2. CRITICAL: source's sessionFile is unchanged after fork. This
    //    pins the source-restore dance — without it, the SDK's
    //    in-place mutation would have hijacked the source's manager
    //    to point at the fork.
    const sourceAfterFork = registry.getSession(source.sessionId);
    assert(
      "source still in registry after fork",
      sourceAfterFork !== undefined,
      `source.sessionId=${source.sessionId}`,
    );
    if (sourceAfterFork === undefined) throw new Error("source vanished");
    const sourceFileAfterFork = sourceAfterFork.session.sessionManager.getSessionFile();
    assert(
      "source's sessionFile is restored to original after fork",
      sourceFileAfterFork === sourceFile,
      `before=${sourceFile} after=${sourceFileAfterFork}`,
    );

    // 3. Concurrent forks from the SAME source. Without forkLocks, the
    //    second fork captures the FIRST fork's sessionFile as
    //    `originalSourceFile` and "restores" the source to that path.
    //    With the lock, both forks serialize and the source ends up
    //    pointing at its original sessionFile.
    const [forkA, forkB] = await Promise.all([
      registry.forkSession(source.sessionId, entryId1),
      registry.forkSession(source.sessionId, entryId2),
    ]);
    assert(
      "two concurrent forks each get distinct sessionIds",
      forkA.sessionId !== forkB.sessionId &&
        forkA.sessionId !== source.sessionId &&
        forkB.sessionId !== source.sessionId,
      `A=${forkA.sessionId} B=${forkB.sessionId} src=${source.sessionId}`,
    );
    const sourceAfterConcurrent = registry.getSession(source.sessionId);
    if (sourceAfterConcurrent === undefined) throw new Error("source vanished after concurrent");
    const sourceFileAfterConcurrent = sourceAfterConcurrent.session.sessionManager.getSessionFile();
    assert(
      "source's sessionFile is STILL restored to original after two concurrent forks",
      sourceFileAfterConcurrent === sourceFile,
      `before=${sourceFile} after=${sourceFileAfterConcurrent}`,
    );

    // 4. The two concurrent forks must NOT share a sessionFile (would
    //    indicate the lock was a no-op and they raced through the SDK
    //    in-place mutation).
    const aFile = forkA.session.sessionManager.getSessionFile();
    const bFile = forkB.session.sessionManager.getSessionFile();
    assert(
      "concurrent forks have distinct sessionFiles",
      typeof aFile === "string" &&
        typeof bFile === "string" &&
        aFile !== bFile &&
        aFile !== sourceFile &&
        bFile !== sourceFile,
      `A=${aFile} B=${bFile} src=${sourceFile}`,
    );

    await registry.disposeAllSessions();
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error("[test-fork] uncaught:", err);
  process.exit(1);
});
