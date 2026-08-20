/** OpenTelemetry session/message/tool instrumentation and identity tests. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const temp = await mkdtemp(join(tmpdir(), "pi-forge-telemetry-"));
process.env.FORGE_DATA_DIR = temp;
process.env.WORKSPACE_PATH = temp;
process.env.PI_CONFIG_DIR = join(temp, "pi-config");
process.env.OTEL_CAPTURE_CONTENT = "true";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

try {
  const telemetry = (await import(
    resolve("packages/server/dist/telemetry.js")
  )) as typeof import("../packages/server/src/telemetry.js");
  const identities = (await import(
    resolve("packages/server/dist/session-identity.js")
  )) as typeof import("../packages/server/src/session-identity.js");
  const exporter = new InMemorySpanExporter();
  telemetry.initializeTelemetry(exporter);

  assert(
    "OTLP base endpoint gets traces suffix",
    telemetry.telemetryTraceEndpoint("https://cloud.langfuse.com/api/public/otel/") ===
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
  );
  assert(
    "username is included in telemetry session id",
    telemetry.formatTelemetrySessionId("alice@example.com", "session-123") ===
      "alice@example.com:session-123",
  );

  const tracker = telemetry.createSessionTelemetry({
    sessionId: "session-123",
    projectId: "project-456",
    username: "alice@example.com",
    mcpToolNames: new Set(["search__web"]),
    model: () => ({ provider: "anthropic", id: "claude-test" }),
  });
  const emit = (event: unknown): void => tracker.handle(event as AgentSessionEvent);
  emit({ type: "agent_start" });
  emit({
    type: "message_start",
    message: { role: "user", content: "private prompt", timestamp: 1 },
  });
  emit({
    type: "message_end",
    message: { role: "user", content: "private prompt", timestamp: 1 },
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "search__web",
    args: { query: "secret query" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "search__web",
    result: { content: "answer" },
    isError: false,
  });
  emit({
    type: "message_start",
    message: { role: "assistant", content: [], timestamp: 2 },
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "private response" }],
      timestamp: 2,
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 4,
        output: 2,
        cacheRead: 1,
        cacheWrite: 3,
        totalTokens: 10,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.003, total: 0.034 },
      },
      stopReason: "stop",
    },
  });
  emit({ type: "agent_end", messages: [] });
  await telemetry.flushTelemetry();

  const spans = exporter.getFinishedSpans();
  const turn = spans.find((span) => span.name === "pi.session.turn");
  const tool = spans.find((span) => span.name === "pi.tool.search__web");
  const userMessage = spans.find((span) => span.name === "pi.message.user");
  const assistantMessage = spans.find((span) => span.name === "pi.message.assistant");
  assert("turn span exported", turn !== undefined);
  assert("user message span exported", userMessage !== undefined);
  assert("assistant message span exported", assistantMessage !== undefined);
  assert("MCP tool span exported", tool !== undefined);
  assert(
    "all spans include username-bearing Langfuse session id",
    spans.every(
      (span) => span.attributes["langfuse.session.id"] === "alice@example.com:session-123",
    ),
  );
  assert("MCP tool is classified", tool?.attributes["pi.tool.type"] === "mcp");
  assert(
    "generation includes model, usage, and cost attribution",
    assistantMessage?.attributes["langfuse.observation.model"] === "claude-test" &&
      String(assistantMessage?.attributes["langfuse.observation.usage_details"]).includes(
        '"cacheRead":1',
      ) &&
      String(assistantMessage?.attributes["langfuse.observation.cost_details"]).includes(
        '"total":0.034',
      ),
  );
  assert(
    "content capture includes user data when explicitly enabled",
    userMessage?.attributes["langfuse.observation.input"] === '"private prompt"' &&
      assistantMessage?.attributes["langfuse.observation.input"] === '"private prompt"' &&
      String(tool?.attributes["langfuse.observation.input"]).includes("secret query") &&
      String(assistantMessage?.attributes["langfuse.observation.output"]).includes(
        "private response",
      ),
  );
  assert(
    "message and tool spans are children of the turn trace",
    turn !== undefined &&
      tool?.spanContext().traceId === turn.spanContext().traceId &&
      userMessage?.spanContext().traceId === turn.spanContext().traceId,
  );

  await identities.rememberSessionUsername("session-123", "alice@example.com");
  assert(
    "session username survives identity lookup",
    (await identities.usernameForSession("session-123")) === "alice@example.com",
  );
  const persisted = JSON.parse(
    await readFile(resolve(temp, "session-users.json"), "utf8"),
  ) as Record<string, string>;
  assert("session username is persisted", persisted["session-123"] === "alice@example.com");
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} telemetry assertion(s) failed`);
  process.exit(1);
}
console.log("\nTelemetry tests passed");
