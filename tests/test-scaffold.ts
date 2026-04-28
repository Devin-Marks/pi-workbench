/**
 * Phase 1 scaffold smoke test.
 *
 * - Runs `npm run build` and asserts exit code 0.
 * - Spawns the compiled server (`node packages/server/dist/index.js`) on a free port.
 * - Polls `GET /api/v1/health` until it responds (or times out).
 * - Asserts the response shape matches `{ status: "ok", activeSessions, activePtys }`.
 * - Tears the server down and exits 0 on PASS, 1 on any FAIL.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function pickFreePort(): Promise<number> {
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

async function waitForHealth(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`server did not respond on ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}

function killServer(child: ChildProcess): Promise<void> {
  return new Promise((resolveFn) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveFn();
      return;
    }
    child.once("exit", () => resolveFn());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2000).unref();
  });
}

async function main(): Promise<void> {
  console.log("[test-scaffold] building workspace…");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  assert("npm run build exits 0", build.status === 0, `exit=${build.status}`);
  if (build.status !== 0) {
    process.exit(1);
  }

  const port = await pickFreePort();
  const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");
  console.log(`[test-scaffold] starting server on :${port}`);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "warn" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exitedEarly = false;
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      exitedEarly = true;
      console.log(`[test-scaffold] server exited unexpectedly with code=${code}`);
    }
  });

  try {
    const res = await waitForHealth(`http://127.0.0.1:${port}/api/v1/health`, 15_000);
    assert("GET /api/v1/health returns 200", res.status === 200, `status=${res.status}`);

    const body = (await res.json()) as Record<string, unknown>;
    assert("response.status === 'ok'", body.status === "ok", JSON.stringify(body));
    assert(
      "response.activeSessions is a non-negative integer",
      typeof body.activeSessions === "number" &&
        Number.isInteger(body.activeSessions) &&
        body.activeSessions >= 0,
      `value=${String(body.activeSessions)}`,
    );
    assert(
      "response.activePtys is a non-negative integer",
      typeof body.activePtys === "number" &&
        Number.isInteger(body.activePtys) &&
        body.activePtys >= 0,
      `value=${String(body.activePtys)}`,
    );
    assert("server did not exit during test", !exitedEarly);
  } finally {
    await killServer(child);
  }

  if (failures > 0) {
    console.log(`\n[test-scaffold] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-scaffold] PASS");
}

main().catch((err) => {
  console.error("[test-scaffold] uncaught error:", err);
  process.exit(1);
});
