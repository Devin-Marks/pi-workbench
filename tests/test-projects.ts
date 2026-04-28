/**
 * Phase 3 project-management integration test.
 *
 * Spawns the server with WORKSPACE_PATH and PI_CONFIG_DIR pointing at fresh
 * temp directories so tests don't interact with anything on the host. Auth is
 * disabled (no UI_PASSWORD, no API_KEY) — auth itself is covered by test-auth.
 *
 * Covers all 7 assertions from the dev plan plus a couple of extras:
 *   - browse with no path defaults to WORKSPACE_PATH
 *   - browse flags `.git` directories
 *   - delete leaves the on-disk folder intact
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(new Error("failed to acquire free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolveFn(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timeout waiting for ${url}`);
}

interface RunningServer {
  base: string;
  child: ChildProcess;
  workspacePath: string;
  configDir: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-workbench-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-workbench-cfg-"));
  const port = await pickFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      WORKSPACE_PATH: workspacePath,
      PI_CONFIG_DIR: configDir,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      API_KEY: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      });
    }
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  };

  try {
    await waitFor(`${base}/api/v1/health`);
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, child, workspacePath, configDir, stop };
}

interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

async function jget(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  const srv = await startServer();
  const { base, workspacePath, configDir } = srv;
  console.log(`[test-projects] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-projects] PI_CONFIG_DIR=${configDir}`);

  try {
    // Seed: a real project folder, a git-repo folder, and a hidden folder
    // (which should be filtered out by the browser).
    const repoFolder = join(workspacePath, "my-repo");
    const otherFolder = join(workspacePath, "other");
    const hiddenFolder = join(workspacePath, ".hidden");
    await mkdir(repoFolder, { recursive: true });
    await mkdir(otherFolder, { recursive: true });
    await mkdir(hiddenFolder, { recursive: true });
    await mkdir(join(repoFolder, ".git"));
    await writeFile(join(repoFolder, ".git", "HEAD"), "ref: refs/heads/main\n");

    // 1. Initially empty list
    {
      const { status, body } = await jget(`${base}/api/v1/projects`);
      assert("GET /projects initial → 200 + empty list", status === 200);
      assert(
        "  body.projects is an empty array",
        Array.isArray((body as { projects: unknown[] }).projects) &&
          (body as { projects: unknown[] }).projects.length === 0,
      );
    }

    // 2. Create with valid path inside WORKSPACE_PATH → 201
    let created: Project;
    {
      const { status, body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "my-repo",
        path: repoFolder,
      });
      assert("POST /projects (valid) → 201", status === 201, `status=${status}`);
      created = body as Project;
      assert(
        "  response includes id, name, path, createdAt",
        typeof created.id === "string" &&
          created.name === "my-repo" &&
          created.path === repoFolder &&
          typeof created.createdAt === "string",
      );
    }

    // 3. Path outside WORKSPACE_PATH → 403
    {
      const { status, body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "bad",
        path: "/etc",
      });
      assert("POST /projects (path outside workspace) → 403", status === 403);
      assert(
        "  error code is path_not_allowed",
        (body as { error: string }).error === "path_not_allowed",
      );
    }

    // 4. Path traversal via ../ → 403
    {
      const { status } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "bad",
        path: join(workspacePath, "..", "..", "etc"),
      });
      assert("POST /projects (../../etc) → 403", status === 403);
    }

    // 5. GET /projects returns the created project
    {
      const { status, body } = await jget(`${base}/api/v1/projects`);
      const projects = (body as { projects: Project[] }).projects;
      assert("GET /projects → 200 with one project", status === 200 && projects.length === 1);
      assert("  returned project matches the created id", projects[0]?.id === created.id);
    }

    // 6. PATCH renames
    {
      const { status, body } = await jsend("PATCH", `${base}/api/v1/projects/${created.id}`, {
        name: "renamed-repo",
      });
      assert("PATCH /projects/:id → 200", status === 200);
      assert("  name updated", (body as Project).name === "renamed-repo");
    }

    // 7. browse defaults to WORKSPACE_PATH and excludes hidden dirs
    {
      const { status, body } = await jget(`${base}/api/v1/projects/browse`);
      assert("GET /projects/browse → 200", status === 200);
      const r = body as { path: string; entries: { name: string; isGitRepo: boolean }[] };
      assert("  browse path is workspace root", r.path === resolve(workspacePath));
      const names = r.entries.map((e) => e.name).sort();
      assert(
        "  entries are [my-repo, other] (hidden filtered out)",
        JSON.stringify(names) === JSON.stringify(["my-repo", "other"]),
        JSON.stringify(names),
      );
      const repo = r.entries.find((e) => e.name === "my-repo");
      const other = r.entries.find((e) => e.name === "other");
      assert("  my-repo is flagged isGitRepo=true", repo?.isGitRepo === true);
      assert("  other is flagged isGitRepo=false", other?.isGitRepo === false);
    }

    // 8. browse outside workspace → 403
    {
      const { status, body } = await jget(
        `${base}/api/v1/projects/browse?path=${encodeURIComponent("/etc")}`,
      );
      assert("GET /projects/browse?path=/etc → 403", status === 403);
      assert(
        "  error code is path_not_allowed",
        (body as { error: string }).error === "path_not_allowed",
      );
    }

    // 9. DELETE removes the record but leaves the folder intact
    {
      const { status } = await jsend("DELETE", `${base}/api/v1/projects/${created.id}`);
      assert("DELETE /projects/:id → 204", status === 204);
      const list = (await jget(`${base}/api/v1/projects`)).body as { projects: Project[] };
      assert("  list is empty after delete", list.projects.length === 0);
      const folderStat = await stat(repoFolder).catch(() => undefined);
      assert(
        "  on-disk folder still exists after delete",
        folderStat !== undefined && folderStat.isDirectory(),
      );
    }

    // 10. PATCH non-existent id → 404
    {
      const { status, body } = await jsend(
        "PATCH",
        `${base}/api/v1/projects/00000000-0000-0000-0000-000000000000`,
        { name: "x" },
      );
      assert("PATCH /projects/:nonexistent → 404", status === 404);
      assert(
        "  error code is project_not_found",
        (body as { error: string }).error === "project_not_found",
      );
    }

    // 11. Persistence: restart the server, list still shows previously created projects.
    // Create a fresh project, restart, verify.
    {
      const { body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "persistent",
        path: otherFolder,
      });
      const persistentId = (body as Project).id;
      // soft-restart by sending SIGTERM and starting a new child against same dirs.
      await new Promise<void>((res) => {
        srv.child.once("exit", () => res());
        srv.child.kill("SIGTERM");
      });
      // re-spawn against same workspace+config dirs
      const port = await pickFreePort();
      const child2 = spawn(process.execPath, [serverEntry], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: String(port),
          LOG_LEVEL: "warn",
          NODE_ENV: "test",
          WORKSPACE_PATH: workspacePath,
          PI_CONFIG_DIR: configDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child2.stderr?.on("data", (b) => process.stderr.write(`[server2 stderr] ${String(b)}`));
      const base2 = `http://127.0.0.1:${port}`;
      try {
        await waitFor(`${base2}/api/v1/health`);
        const { body: list2 } = await jget(`${base2}/api/v1/projects`);
        const projects = (list2 as { projects: Project[] }).projects;
        assert(
          "after restart, persisted project still listed",
          projects.length === 1 && projects[0]?.id === persistentId,
          `count=${projects.length}`,
        );
      } finally {
        await new Promise<void>((res) => {
          if (child2.exitCode !== null) return res();
          child2.once("exit", () => res());
          child2.kill("SIGTERM");
          setTimeout(() => child2.kill("SIGKILL"), 1500).unref();
        });
      }
    }
  } finally {
    await srv.stop();
  }

  if (failures > 0) {
    console.log(`\n[test-projects] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-projects] PASS");
}

main().catch((err) => {
  console.error("[test-projects] uncaught error:", err);
  process.exit(1);
});
