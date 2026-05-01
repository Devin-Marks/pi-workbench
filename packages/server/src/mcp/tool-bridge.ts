import { Type } from "typebox";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/**
 * Translate a single MCP tool advertised by a connected MCP server
 * into a pi `ToolDefinition` the agent can call.
 *
 * The translated tool's name is namespaced as `<server>__<tool>` so
 * multiple MCP servers can advertise the same tool name without
 * colliding (e.g. two servers both exposing `search`). Pi enforces
 * unique tool names at agent-init; the prefix guarantees uniqueness.
 *
 * `parameters` wraps the MCP tool's JSON Schema with `Type.Unsafe<...>`.
 * Pi runs structural validation on tool-call arguments using whatever
 * is in `parameters`, so the JSON Schema flows through directly.
 *
 * Tool execution forwards to `client.callTool({ name, arguments })`
 * and converts the MCP `CallToolResult.content` array into pi's
 * `(TextContent | ImageContent)[]` shape. Resource-link / unknown
 * content blocks are stringified as JSON text rather than dropped, so
 * the agent at least sees them.
 */
export function bridgeMcpTool(opts: {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the latest connected client for this server. Re-resolved
   *  on every call so a reconnect (new client instance) is picked up
   *  without the bridged ToolDefinition being rebuilt. */
  getClient: () => Client | undefined;
}): ToolDefinition {
  const prefixedName = `${opts.serverName}__${opts.toolName}`;
  const description =
    opts.description.length > 0
      ? opts.description
      : `MCP tool '${opts.toolName}' from server '${opts.serverName}'.`;
  return {
    name: prefixedName,
    label: `MCP: ${opts.serverName}/${opts.toolName}`,
    description,
    parameters: Type.Unsafe<Record<string, unknown>>(opts.inputSchema),
    async execute(_toolCallId, params, signal) {
      const client = opts.getClient();
      if (client === undefined) {
        return errorResult(
          `MCP server '${opts.serverName}' is not connected. Re-enable it in Settings → MCP, or check the server logs.`,
        );
      }
      try {
        const res = await client.callTool(
          {
            name: opts.toolName,
            arguments: (params as Record<string, unknown>) ?? {},
          },
          undefined,
          signal !== undefined ? { signal } : undefined,
        );
        return mcpResultToAgentResult(res);
      } catch (err) {
        return errorResult(
          `MCP tool '${prefixedName}' threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  } satisfies ToolDefinition;
}

function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
  };
}

interface McpContentBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: unknown;
}

interface McpCallResult {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

/**
 * Map MCP `CallToolResult.content` to pi's content array shape.
 *  - `text`        → `{ type: "text", text }`
 *  - `image`       → `{ type: "image", data, mimeType }`  (data is base64)
 *  - `resource` /
 *    `resource_link` / unknown → JSON-stringified into a text block.
 *
 * `isError: true` is preserved as a leading "[error]" prefix on the
 * first text block so the agent sees something acted-upon rather
 * than a silent dropped result.
 */
function mcpResultToAgentResult(res: unknown): AgentToolResult<unknown> {
  const r = (res ?? {}) as McpCallResult;
  const isError = r.isError === true;
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  const blocks = Array.isArray(r.content) ? (r.content as McpContentBlock[]) : [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else {
      // Resource links, audio (rare), or unknown future block types.
      // Stringify so the agent at least gets the payload — a silent
      // drop would look like a successful no-op.
      content.push({
        type: "text",
        text: `[${String(block.type ?? "unknown")}] ${JSON.stringify(block)}`,
      });
    }
  }
  if (content.length === 0) {
    // Some MCP servers signal success with an empty content array;
    // include structuredContent if present so the agent has something
    // to work with.
    if (r.structuredContent !== undefined) {
      content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
    } else {
      content.push({ type: "text", text: isError ? "[error] (no detail)" : "(empty result)" });
    }
  }
  if (isError && content[0]?.type === "text") {
    content[0] = { type: "text", text: `[error] ${content[0].text}` };
  }
  return { content, details: r.structuredContent ?? null };
}
