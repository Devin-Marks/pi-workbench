/**
 * Phase 9 Docker integration test.
 *
 * - Verifies `docker` is available; skips with a clear message if not.
 * - Builds the image via `docker compose build` (long: ~2-5 min on a cold cache).
 * - Brings the stack up on a unique container name + port to avoid clashing
 *   with whatever the developer might already have running.
 * - Polls `GET /api/v1/health` until 200, then asserts:
 *     - `/manifest.webmanifest` returns 200 with `display: "standalone"`
 *     - `/sw.js` returns 200 (service worker present)
 *     - `/icons/icon.svg` returns 200
 *     - `/api/docs` returns 200 (Swagger UI)
 *     - `/` returns 200 with `text/html` (SPA shell)
 *     - `/api/v1/missing` returns 404 JSON (API misses don't fall through)
 *     - `/assets/missing.css` returns 404 (missing assets don't fall through)
 * - Always tears the stack down on exit (PASS or FAIL).
 *
 * Runs to a temp `docker-compose.test.yml` derived from the canonical one
 * so the developer's actual workspace and API keys aren't touched. Port is
 * randomized to allow concurrent runs and avoid stomping a running stack.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "ignore",
  });
  return r.status === 0;
}

interface ComposeOpts {
  composeFile: string;
  projectName: string;
}

function compose(args: string[], opts: ComposeOpts, capture = false) {
  const fullArgs = ["compose", "-f", opts.composeFile, "-p", opts.projectName, ...args];
  return spawnSync("docker", fullArgs, {
    cwd: repoRoot,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = `status=${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not respond on ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}

async function main(): Promise<void> {
  if (!dockerAvailable()) {
    console.log("[test-docker] SKIP — `docker` not available in PATH or daemon not reachable.");
    process.exit(0);
  }

  const tmp = mkdtempSync(join(tmpdir(), "pi-docker-test-"));
  const projectName = `pi-workbench-test-${Date.now()}`;
  const composeFile = join(tmp, "docker-compose.test.yml");
  const port = await pickFreePort();
  const workspaceDir = join(tmp, "workspace");
  const piConfigDir = join(tmp, "pi-config");
  spawnSync("mkdir", ["-p", workspaceDir, piConfigDir]);

  // Compose file derived from the canonical one but with isolated paths
  // and a random port so the dev's normal stack isn't disturbed.
  const composeYaml = `
services:
  pi-workbench:
    build:
      context: ${repoRoot}
      dockerfile: docker/Dockerfile
    container_name: ${projectName}
    ports:
      - "${port}:3000"
    volumes:
      - ${workspaceDir}:/workspace
      - ${piConfigDir}:/home/pi/.pi/agent
    environment:
      - WORKSPACE_PATH=/workspace
      - PI_CONFIG_DIR=/home/pi/.pi/agent
      - PORT=3000
      - LOG_LEVEL=warn
`;
  writeFileSync(composeFile, composeYaml);

  let upStarted = false;
  try {
    console.log("[test-docker] building image (this can take a few minutes on cold cache)…");
    const build = compose(["build"], { composeFile, projectName });
    assert("docker compose build exits 0", build.status === 0, `exit=${build.status}`);
    if (build.status !== 0) {
      throw new Error("build failed");
    }

    console.log("[test-docker] starting stack…");
    const up = compose(["up", "-d"], { composeFile, projectName });
    assert("docker compose up exits 0", up.status === 0, `exit=${up.status}`);
    if (up.status !== 0) {
      throw new Error("up failed");
    }
    upStarted = true;

    const base = `http://127.0.0.1:${port}`;
    console.log(`[test-docker] polling ${base}/api/v1/health …`);
    const health = await waitForHealth(`${base}/api/v1/health`, 90_000);
    assert("GET /api/v1/health returns 200", health.status === 200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    assert("health body.status === 'ok'", healthBody.status === "ok");

    // ---- PWA assets ----
    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assert("GET /manifest.webmanifest returns 200", manifestRes.status === 200);
    const manifest = (await manifestRes.json()) as Record<string, unknown>;
    assert(
      "manifest.display === 'standalone'",
      manifest.display === "standalone",
      `display=${String(manifest.display)}`,
    );
    assert("manifest.start_url === '/'", manifest.start_url === "/");
    assert(
      "manifest.icons is a non-empty array",
      Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length > 0,
    );

    const swRes = await fetch(`${base}/sw.js`);
    assert("GET /sw.js returns 200 (service worker)", swRes.status === 200);

    const iconRes = await fetch(`${base}/icons/icon.svg`);
    assert("GET /icons/icon.svg returns 200", iconRes.status === 200);

    // ---- Swagger UI ----
    const docsRes = await fetch(`${base}/api/docs`, { redirect: "follow" });
    assert("GET /api/docs returns 200 (Swagger UI)", docsRes.status === 200);

    // ---- Static + SPA fallback ----
    const rootRes = await fetch(`${base}/`);
    assert("GET / returns 200", rootRes.status === 200);
    assert(
      "GET / Content-Type is text/html",
      (rootRes.headers.get("content-type") ?? "").startsWith("text/html"),
    );
    const deepRes = await fetch(`${base}/projects/somebogusid`);
    assert("SPA deep link returns 200 html", deepRes.status === 200);

    // ---- 404 hygiene ----
    const apiMiss = await fetch(`${base}/api/v1/missing-route-xyz`);
    assert("GET /api/v1/missing returns 404", apiMiss.status === 404);
    const assetMiss = await fetch(`${base}/assets/missing-bogus.css`);
    assert(
      "GET /assets/missing.css returns 404 (no SPA fallback for assets)",
      assetMiss.status === 404,
    );

    // ---- Terminal WebSocket smoke test ----
    // Catches: missing native node-pty binding in the runtime image,
    // missing /bin/sh, WebSocket plugin not registered. Auth is
    // disabled in this test stack (no UI_PASSWORD / API_KEY set), so
    // the upgrade goes through without a token.
    spawnSync("mkdir", ["-p", join(workspaceDir, "term-test")]);
    const projectRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "term-test", path: "/workspace/term-test" }),
    });
    assert("POST /api/v1/projects (for terminal test) returns 201", projectRes.status === 201);
    if (projectRes.status === 201) {
      const project = (await projectRes.json()) as { id: string };
      const wsUrl = `ws://127.0.0.1:${port}/api/v1/terminal?projectId=${encodeURIComponent(
        project.id,
      )}`;
      // Node 22 has WebSocket as a global. Treat it as `unknown` so
      // older Node versions running this script fail loudly rather
      // than spuriously passing.
      const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      assert("WebSocket constructor available", WS !== undefined);
      if (WS !== undefined) {
        const ws = new WS(wsUrl);
        const collected: string[] = [];
        const result = await new Promise<{ ok: boolean; reason: string }>((resolveFn) => {
          const timer = setTimeout(() => {
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolveFn({ ok: false, reason: "timeout waiting for echo output" });
          }, 8_000);
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
            ws.send(JSON.stringify({ type: "input", data: "echo HELLO_FROM_DOCKER_TEST\n" }));
          });
          ws.addEventListener("message", (e) => {
            const data =
              typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
            collected.push(data);
            if (collected.join("").includes("HELLO_FROM_DOCKER_TEST")) {
              clearTimeout(timer);
              try {
                ws.close();
              } catch {
                // ignore
              }
              resolveFn({ ok: true, reason: "saw echo output" });
            }
          });
          ws.addEventListener("error", (e) => {
            clearTimeout(timer);
            const msg = (e as { message?: string }).message ?? "unknown";
            resolveFn({ ok: false, reason: `websocket error: ${msg}` });
          });
          ws.addEventListener("close", (e) => {
            // Only resolves if no echo arrived before close — otherwise
            // the message handler beat us to it.
            clearTimeout(timer);
            const code = (e as { code?: number }).code ?? -1;
            resolveFn({ ok: false, reason: `websocket closed before echo (code=${code})` });
          });
        });
        assert(`terminal echo round-trip — ${result.reason}`, result.ok);
      }
    }
  } catch (err) {
    failures += 1;
    console.log(`[test-docker] uncaught error: ${(err as Error).message}`);
  } finally {
    if (upStarted) {
      console.log("[test-docker] tearing down stack…");
      compose(["down", "-v", "--remove-orphans"], { composeFile, projectName });
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures > 0) {
    console.log(`\n[test-docker] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-docker] PASS");
}

// Tail logs on Ctrl-C so the user can debug a hanging container before
// teardown completes.
process.on("SIGINT", () => {
  console.log("\n[test-docker] interrupted — leaving cleanup to finally{}");
});

void (async () => {
  await main().catch((err: unknown) => {
    console.error("[test-docker] uncaught:", err);
    process.exit(1);
  });
})();

// Used only to satisfy the `spawn` import in case future helpers grow.
void spawn;
