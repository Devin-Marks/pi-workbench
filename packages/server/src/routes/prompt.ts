import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { formatErrorChain } from "../diagnostics.js";
import { expandFileReferences } from "../file-references.js";
import { getSession, type LiveSession } from "../session-registry.js";
import { errorSchema } from "./_schemas.js";

/**
 * Prompt route. Per CLAUDE.md "Pi SDK Key Facts": session.prompt() is async
 * but only resolves after the entire agent run finishes (including retries
 * and compaction). Routes MUST NOT await it — call without await and return
 * 202 immediately. Output streams over SSE.
 *
 * Phase 14: also accepts multipart/form-data with attachments. The route's
 * declared `body` schema covers ONLY the JSON path; the multipart path is
 * detected by content-type and parsed inline below (Fastify's schema
 * validation is skipped for multipart — there is no JSON body to validate).
 */

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES_PER_PROMPT = 4;
const MAX_TEXT_FILES_PER_PROMPT = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Cap how much a single text attachment can contribute to the prompt
 * after we read it. The 10 MB file-size limit is the upper hard cap;
 * this is the looser "reasonable to embed in chat" cap. Files larger
 * than this still upload but get truncated with a marker. Avoids
 * silently blowing past the model's context window.
 */
const MAX_TEXT_PREPEND_BYTES = 256 * 1024;
/**
 * Hard cap on the assembled prompt text (user input + every prepended
 * text-file body) before it goes to the SDK. 1 MB is well above the
 * largest reasonable single-prompt payload and well below most model
 * context windows; anything beyond it is almost certainly an attempt
 * to burn LLM tokens / context budget.
 */
const MAX_COMPOSED_PROMPT_BYTES = 1024 * 1024;

interface ParsedImage {
  /** Base64-encoded image data (no data URL prefix). */
  base64: string;
  mimeType: string;
}

interface ParsedTextFile {
  filename: string;
  /** Already-truncated UTF-8 string. `truncated` indicates a marker was added. */
  content: string;
  truncated: boolean;
}

interface ParsedMultipart {
  text: string;
  streamingBehavior?: "steer" | "followUp";
  images: ParsedImage[];
  textFiles: ParsedTextFile[];
}

/**
 * Read a multipart upload off the request, validating limits inline.
 * Returns either the parsed shape or the error code+message the caller
 * should send as 400.
 */
async function parseMultipart(
  req: FastifyRequest,
): Promise<ParsedMultipart | { error: string; message: string }> {
  let text: string | undefined;
  let streamingBehavior: "steer" | "followUp" | undefined;
  const images: ParsedImage[] = [];
  const textFiles: ParsedTextFile[] = [];

  // Drain helper for early-return paths. Without this, when an early
  // file-cap triggers a 400, the remaining MBs of the request body
  // keep flowing in and Fastify buffers them before GC. For a
  // pathological 8 × 10 MB upload that's ~70 MB of useless transit.
  // Destroying the raw socket stream signals the client to stop and
  // releases any in-flight buffers.
  const drain = (): void => {
    try {
      req.raw.destroy();
    } catch {
      // already destroyed / closed
    }
  };

  for await (const part of req.parts()) {
    if (part.type === "field") {
      if (part.fieldname === "text") {
        text = typeof part.value === "string" ? part.value : "";
      } else if (part.fieldname === "streamingBehavior") {
        if (part.value === "steer" || part.value === "followUp") {
          streamingBehavior = part.value;
        }
      }
      // Unknown fields are ignored (forwards-compatible).
      continue;
    }
    // File part. Reading the buffer counts against the multipart
    // size limit; @fastify/multipart's `truncated` flag flips when
    // the file exceeded `limits.fileSize`.
    const file = part;
    const buf = await file.toBuffer();
    if (file.file.truncated) {
      drain();
      return {
        error: "attachment_too_large",
        message: `Attachment "${file.filename}" exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit.`,
      };
    }
    const mime = (file.mimetype ?? "application/octet-stream").toLowerCase();
    if (IMAGE_MIME_TYPES.has(mime)) {
      if (images.length >= MAX_IMAGES_PER_PROMPT) {
        drain();
        return {
          error: "too_many_images",
          message: `Up to ${MAX_IMAGES_PER_PROMPT} images per prompt; got more.`,
        };
      }
      images.push({ base64: buf.toString("base64"), mimeType: mime });
      continue;
    }
    // Anything else: try to interpret as text. We don't reject binary
    // non-image attachments outright because users sometimes attach
    // unrecognized text MIME types (e.g. `.tsx` arriving as
    // application/octet-stream from some browsers). The
    // best-effort UTF-8 decode below converts garbled binary to
    // U+FFFD replacement chars and the model gets noise — better
    // than silently dropping the attachment.
    if (textFiles.length >= MAX_TEXT_FILES_PER_PROMPT) {
      drain();
      return {
        error: "too_many_text_files",
        message: `Up to ${MAX_TEXT_FILES_PER_PROMPT} text attachments per prompt; got more.`,
      };
    }
    let content = buf.toString("utf8");
    let truncated = false;
    if (content.length > MAX_TEXT_PREPEND_BYTES) {
      content =
        content.slice(0, MAX_TEXT_PREPEND_BYTES) +
        `\n... [truncated; original was ${buf.byteLength} bytes]`;
      truncated = true;
    }
    textFiles.push({
      filename: file.filename ?? "attachment",
      content,
      truncated,
    });
  }

  if (text === undefined || text.length === 0) {
    return { error: "missing_text", message: "Prompt text is required." };
  }
  const result: ParsedMultipart = { text, images, textFiles };
  if (streamingBehavior !== undefined) result.streamingBehavior = streamingBehavior;
  return result;
}

/**
 * Compose the final prompt text by prepending each text-file
 * attachment as a fenced code block. Mirrors what most agent UIs
 * produce when a file is dragged in: the LLM sees the filename as
 * the language hint and the content directly below.
 *
 * Fence-break safety: a file whose content contains ``` would
 * terminate a 3-backtick fence early and let its bytes leak out as
 * "user prompt", which a hostile shared file could exploit to inject
 * arbitrary instructions to the LLM. The CommonMark fenced-block
 * rule says the closing fence must be at least as long as the
 * opener, so we pick a fence one backtick longer than the longest
 * run inside the content. Filename is also sanitized — any
 * backtick/newline in it is collapsed so the opening fence line
 * itself can't be hijacked.
 */
function pickFence(content: string): string {
  // Longest run of consecutive backticks in `content` — we need to
  // open with one MORE than that.
  let max = 0;
  let cur = 0;
  for (const ch of content) {
    if (ch === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}

function sanitizeFilename(name: string): string {
  // Strip backticks and newlines so neither breaks the opener line.
  // Leave the rest intact — the LLM uses this as a language hint /
  // identifier, so extension + path readability matter.
  return name.replace(/[`\r\n]/g, "_");
}

function composePromptText(parsed: ParsedMultipart): string {
  if (parsed.textFiles.length === 0) return parsed.text;
  const blocks = parsed.textFiles.map((f) => {
    const fence = pickFence(f.content);
    const safeName = sanitizeFilename(f.filename);
    return `${fence}${safeName}\n${f.content}\n${fence}`;
  });
  return blocks.join("\n\n") + "\n\n" + parsed.text;
}

/**
 * Pre-flight checks shared by the JSON + multipart paths. On a check
 * failure, sends the 4xx via `reply` AND returns undefined — caller
 * MUST `return reply;` immediately to avoid double-send. The reply
 * sends are awaited for clean ordering of any onSend hooks (security
 * headers etc.) before the route handler proceeds.
 */
async function preflight(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<LiveSession | undefined> {
  const live = getSession((req.params as { id: string }).id);
  if (live === undefined) {
    await reply
      .code(404)
      .send({ error: "session_not_found", message: "no live session with that id" });
    return undefined;
  }
  const model = live.session.model;
  if (model === undefined) {
    await reply.code(400).send({
      error: "no_model_configured",
      message: "no model is configured for this session",
    });
    return undefined;
  }
  if (!live.session.modelRegistry.hasConfiguredAuth(model)) {
    await reply.code(400).send({
      error: "no_api_key",
      message: `No API key configured for provider "${model.provider}". Add one via PUT /api/v1/config/auth/${model.provider}.`,
    });
    return undefined;
  }
  return live;
}

export const promptRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; streamingBehavior?: "steer" | "followUp" };
  }>(
    "/sessions/:id/prompt",
    {
      config: {
        // Cost cap: each prompt costs LLM tokens. The default of 60/min is
        // far above interactive use; a leaked-token loop hits the cap fast.
        // Tune via RATE_LIMIT_PROMPT_*.
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          "Send a prompt to the session. Returns 202 immediately; the agent " +
          "response streams over GET /sessions/:id/stream.\n\n" +
          "Two body shapes:\n" +
          "  - application/json: { text, streamingBehavior? }\n" +
          "  - multipart/form-data: `text` field, optional `streamingBehavior` field, " +
          "    `attachments[]` files. Image attachments (PNG/JPEG/GIF/WEBP, max 4) " +
          "    pass into model context; non-image text files are prepended to the " +
          "    prompt as fenced code blocks. 10 MB per-file cap. Text files larger " +
          "    than ~256 KB are truncated with an inline marker.",
        tags: ["sessions"],
        consumes: ["application/json", "multipart/form-data"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted"],
            properties: { accepted: { type: "boolean", const: true } },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
      // The framework's body parser bypasses fastify schema validation
      // when the request is multipart, so this is purely informational
      // for OpenAPI consumers. Multipart parsing happens inside the
      // handler via `req.parts()`.
      attachValidation: true,
    },
    async (req, reply) => {
      const isMultipart = req.isMultipart();
      // Plain JSON path: validation already ran via schema.body.
      // Surface validation errors as 400 with the standard shape.
      if (!isMultipart && req.validationError !== undefined) {
        return reply.code(400).send({
          error: "invalid_body",
          message: req.validationError.message,
        });
      }

      const live = await preflight(req, reply);
      if (live === undefined) return reply;

      let promptText: string;
      let streamingBehavior: "steer" | "followUp" | undefined;
      let images: ParsedImage[] = [];

      if (isMultipart) {
        let parsed: ParsedMultipart | { error: string; message: string };
        try {
          parsed = await parseMultipart(req);
        } catch (err) {
          // @fastify/multipart throws typed errors when the multipart
          // limits we registered are exceeded (FilesLimitError,
          // FieldsLimitError, PartsLimitError, RequestFileTooLargeError
          // when throwFileSizeLimit:true). Map them to 400 with a
          // typed code instead of letting Fastify render generic
          // 500/413 responses.
          const errCode = (err as { code?: string }).code ?? "";
          if (errCode === "FST_FILES_LIMIT") {
            return reply.code(400).send({
              error: "too_many_files",
              message: "Too many attachments in one request.",
            });
          }
          if (errCode === "FST_REQ_FILE_TOO_LARGE") {
            return reply.code(400).send({
              error: "attachment_too_large",
              message: `Attachment exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit.`,
            });
          }
          if (errCode === "FST_FIELDS_LIMIT" || errCode === "FST_PARTS_LIMIT") {
            return reply.code(400).send({
              error: "too_many_parts",
              message: "Too many fields or parts in the multipart request.",
            });
          }
          throw err;
        }
        if ("error" in parsed) {
          return reply.code(400).send(parsed);
        }
        promptText = composePromptText(parsed);
        streamingBehavior = parsed.streamingBehavior;
        images = parsed.images;
      } else {
        promptText = req.body.text;
        streamingBehavior = req.body.streamingBehavior;
      }

      // Expand `@<path>` file references inline (the chat input's
      // `@`-autocomplete inserts these markers; server-side
      // expansion keeps the LLM context as the source of truth and
      // matches how attachments work). A path that doesn't resolve
      // to a real file inside the workspace passes through untouched
      // — see file-references.ts for the rules.
      promptText = await expandFileReferences(promptText, live.workspacePath);

      // Hard cap on the assembled prompt text. Per-file caps already
      // exist (10 MB upload, ~256 KB text-prepend per file, max 4 text
      // files) but a 4-attachment prompt with a long pasted user text
      // could still cumulatively exceed what's reasonable to send to
      // an LLM. 1 MB is well above any realistic single prompt.
      const promptBytes = Buffer.byteLength(promptText, "utf8");
      if (promptBytes > MAX_COMPOSED_PROMPT_BYTES) {
        return reply.code(413).send({
          error: "prompt_too_large",
          message: `Composed prompt is ${promptBytes} bytes; limit is ${MAX_COMPOSED_PROMPT_BYTES}.`,
        });
      }

      const opts: Parameters<typeof live.session.prompt>[1] = {};
      if (streamingBehavior !== undefined) opts.streamingBehavior = streamingBehavior;
      if (images.length > 0) {
        // The SDK's ImageContent.data is RAW base64 (no `data:` prefix);
        // each provider builds its own data URL via
        // `data:${mimeType};base64,${data}` when needed. Don't pre-
        // build the URL or providers double-prefix and break.
        opts.images = images.map((img) => ({
          type: "image" as const,
          data: img.base64,
          mimeType: img.mimeType,
        }));
      }

      // Fire-and-forget. Pre-flight already covered the common synchronous
      // failure modes; remaining rejections are LLM/network errors that
      // surface to the client as agent_end with errorMessage over SSE.
      //
      // The SDK's normal flow emits `agent_end` itself when a turn
      // completes (success or SDK-tracked error). But certain failure
      // modes — e.g. provider rejected the request synchronously,
      // network down, malformed prompt — reject session.prompt() WITHOUT
      // ever firing agent_start / agent_end. Connected SSE clients then
      // sit on a "thinking…" spinner forever and the chat input stays
      // disabled. To recover, we synthesize a terminal `agent_end`
      // (with errorMessage) into the live session's fan-out so the
      // browser releases the spinner and surfaces the error in chat.
      const synthesizeFailureEvent = (err: unknown): void => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        for (const client of live.clients) {
          try {
            client.send({
              type: "agent_end",
              sessionId: req.params.id,
              errorMessage,
            });
          } catch {
            // a single client send-failure shouldn't stop fan-out
          }
        }
      };

      // Operator-visible breadcrumb. Without this, a hung prompt
      // (where the SDK is silently retrying or the LLM provider is
      // not responding) is invisible to operators reading
      // `docker logs`. Pino redacts the prompt body itself; the byte
      // count is the safe diagnostic to emit.
      process.stderr.write(
        `${JSON.stringify({
          level: "info",
          time: new Date().toISOString(),
          msg: "session.prompt invoked",
          sessionId: req.params.id,
          promptBytes,
          imageCount: images.length,
          streamingBehavior,
        })}\n`,
      );

      try {
        live.session.prompt(promptText, opts).catch((err: unknown) => {
          const f = formatErrorChain(err);
          process.stderr.write(
            `${JSON.stringify({
              level: "warn",
              time: new Date().toISOString(),
              msg: "session.prompt rejected",
              sessionId: req.params.id,
              error: f.message,
              chain: f.chain,
              stack: f.stack,
            })}\n`,
          );
          synthesizeFailureEvent(err);
        });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id },
          "session.prompt threw synchronously",
        );
        synthesizeFailureEvent(err);
      }
      return reply.code(202).send({ accepted: true });
    },
  );
};
