import { Worker } from "node:worker_threads";

/**
 * Office-format → text converter dispatcher.
 *
 * Conversion runs in a `worker_threads` worker (see
 * `conversion-worker.mjs`) because pdfjs-dist and ExcelJS do heavy
 * synchronous JS work that blocks Node's event loop for seconds on
 * real-world files. While the loop is blocked, the SSE bridge's
 * heartbeat can't fire and the underlying TCP socket stalls long
 * enough for Node's HTTP machinery (or any L7 proxy) to drop the
 * stream — producing a "Reconnecting…" banner in chat right after the
 * user submits a prompt with an attachment.
 *
 * One-shot worker per conversion call (no pool). Conversion is rare
 * relative to other server activity; pool startup overhead would
 * outweigh the savings until you're processing many files per minute.
 *
 * Errors (corrupt file, encrypted PDF, unparseable office doc, worker
 * crash) come back as `ConversionError` so the route can surface a
 * clean upload-time message instead of a generic 500.
 */

export class ConversionError extends Error {
  constructor(
    public readonly filename: string,
    public readonly format: "pdf" | "docx" | "xlsx",
    cause: unknown,
  ) {
    super(`failed to convert ${format.toUpperCase()} "${filename}": ${describe(cause)}`);
    this.name = "ConversionError";
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Match the upload to a converter. Dispatch is by lowercased
 * extension first, then MIME — extensions are more reliable in
 * practice because browsers send `application/octet-stream` for these
 * formats more often than the canonical MIME types.
 */
export function pickConverter(filename: string, mime: string): "pdf" | "docx" | "xlsx" | undefined {
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (
    ext === "docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (
    ext === "xlsx" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  return undefined;
}

// Resolve the worker file relative to THIS module. Works in both
// `tsx` dev (this file is TS in src/) and compiled prod (this file is
// JS in dist/) because the build step copies the .mjs alongside.
const WORKER_URL = new URL("./conversion-worker.mjs", import.meta.url);

interface WorkerResponse {
  id: number;
  ok: boolean;
  text?: string;
  error?: string;
}

let nextRequestId = 0;

export async function convertAttachment(
  format: "pdf" | "docx" | "xlsx",
  filename: string,
  buf: Buffer,
): Promise<string> {
  const id = ++nextRequestId;
  // Transfer the buffer's underlying ArrayBuffer to the worker — zero
  // copy. We slice() first because Node Buffers share their pool's
  // ArrayBuffer with other buffers; transferring the whole pool would
  // detach unrelated buffers.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const worker = new Worker(WORKER_URL);
  return new Promise<string>((resolve, reject) => {
    worker.once("message", (msg: WorkerResponse) => {
      if (msg.ok && typeof msg.text === "string") {
        resolve(msg.text);
      } else {
        reject(new ConversionError(filename, format, msg.error ?? "worker returned no text"));
      }
    });
    worker.once("error", (err) => {
      reject(new ConversionError(filename, format, err));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        // `error` will have already rejected; this is a safety net for
        // an exit without a prior error event.
        reject(new ConversionError(filename, format, `worker exited with code ${code}`));
      }
    });
    worker.postMessage({ id, format, buf: ab }, [ab]);
  }).finally(() => {
    // Worker is one-shot — terminate so the thread exits cleanly even
    // if the postMessage handler didn't trigger an organic exit.
    void worker.terminate();
  });
}
