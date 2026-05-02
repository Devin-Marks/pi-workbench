/**
 * Per-tool overrides integration test.
 *
 * Boots the server in-process with a temp PI_CONFIG_DIR /
 * WORKBENCH_DATA_DIR, exercises the GET /config/tools and
 * PUT /config/tools/:family/:name/enabled routes, and verifies the
 * on-disk override file mutates correctly.
 *
 * Coverage:
 *   - GET /config/tools on a fresh install — returns the seven
 *     builtins with `enabled: true` (allow-by-default), empty mcp
 *     list (no servers configured).
 *   - PUT /config/tools/builtin/bash/enabled false → 200, GET
 *     reflects bash disabled.
 *   - PUT toggle round-trip (true → false → true) leaves the
 *     override file in a clean state (no stale entry).
 *   - PUT with an invalid family → 400 (Fastify schema validation).
 *   - PUT with malformed body → 400.
 *   - On-disk file shape — the override file at
 *     ${WORKBENCH_DATA_DIR}/tool-overrides.json contains the
 *     disabled name and nothing else.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(base: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  base: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-tools-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-tools-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-tools-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.WORKBENCH_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  const overridesPath = join(dataDir, "tool-overrides.json");

  try {
    // ---- 1. Fresh listing — all builtins enabled, no MCP ----
    {
      const r = await jget(base, "/api/v1/config/tools");
      assert("GET /config/tools (fresh) → 200", r.status === 200);
      const body = r.body as {
        builtin: { name: string; enabled: boolean }[];
        mcp: unknown[];
      };
      assert(
        "  seven builtins listed",
        body.builtin.length === 7,
        `got ${body.builtin.length}: ${body.builtin.map((b) => b.name).join(",")}`,
      );
      const names = new Set(body.builtin.map((b) => b.name));
      for (const expected of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        assert(
          `  builtin "${expected}" present and enabled`,
          names.has(expected) && body.builtin.find((b) => b.name === expected)?.enabled === true,
        );
      }
      assert("  mcp list empty (no servers configured)", body.mcp.length === 0);
    }

    // ---- 2. Disable bash via PUT — verify GET reflects, file written ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        enabled: false,
      });
      assert("PUT bash disabled → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as { family: string; name: string; enabled: boolean };
      assert(
        "  response echoes the new state",
        body.family === "builtin" && body.name === "bash" && body.enabled === false,
        JSON.stringify(body),
      );

      const list = await jget(base, "/api/v1/config/tools");
      const bash = (list.body as { builtin: { name: string; enabled: boolean }[] }).builtin.find(
        (b) => b.name === "bash",
      );
      assert("  GET reflects bash disabled", bash?.enabled === false);

      // On-disk file should contain bash in builtin disabled list.
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json contains 'bash' in builtin",
        onDisk.builtin.includes("bash") && onDisk.mcp.length === 0,
        JSON.stringify(onDisk),
      );
    }

    // ---- 3. Re-enable bash — file returns to clean state ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        enabled: true,
      });
      assert("PUT bash re-enabled → 200", r.status === 200);

      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json no longer contains 'bash'",
        !onDisk.builtin.includes("bash"),
        JSON.stringify(onDisk),
      );

      const list = await jget(base, "/api/v1/config/tools");
      const bash = (list.body as { builtin: { name: string; enabled: boolean }[] }).builtin.find(
        (b) => b.name === "bash",
      );
      assert("  GET reflects bash re-enabled", bash?.enabled === true);
    }

    // ---- 4. Idempotent toggles — double-disable, double-enable ----
    {
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: false });
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: false });
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
      };
      const grepCount = onDisk.builtin.filter((n) => n === "grep").length;
      assert("double-disable doesn't duplicate the entry", grepCount === 1, `count=${grepCount}`);

      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: true });
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: true });
      const onDisk2 = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
      };
      assert(
        "double-enable removes and stays clean",
        !onDisk2.builtin.includes("grep"),
        JSON.stringify(onDisk2),
      );
    }

    // ---- 5. Invalid family → 400 (schema validation) ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/garbage/something/enabled", {
        enabled: false,
      });
      assert("invalid family → 400", r.status === 400, `status=${r.status}`);
    }

    // ---- 6. Malformed body → 400 ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        notTheRightField: true,
      });
      assert("malformed body → 400", r.status === 400, `status=${r.status}`);
    }

    // ---- 7. MCP namespace — disable + verify on disk in mcp section ----
    // No actual MCP server is connected here; we exercise the toggle
    // route + storage independently to prove the mcp family path works.
    // The bridged-name format `<server>__<tool>` is the contract; the
    // route doesn't validate that the server exists (overrides can
    // pre-exist before a server connects).
    {
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/tools/mcp/${encodeURIComponent("myserver__add")}/enabled`,
        { enabled: false },
      );
      assert("PUT mcp tool disabled → 200", r.status === 200, JSON.stringify(r.body));
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json contains 'myserver__add' in mcp",
        onDisk.mcp.includes("myserver__add"),
        JSON.stringify(onDisk),
      );
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-tool-overrides] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-tool-overrides] all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.log(`[test-tool-overrides] uncaught: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
