// Worker entry for PDF / DOCX / XLSX text extraction.
//
// Lives off the main thread because pdfjs-dist (used by pdf-parse) and
// ExcelJS do heavy synchronous JavaScript work — a 2 MB PDF can block
// the event loop for several seconds. While blocked, the SSE bridge's
// heartbeat can't fire and the underlying TCP socket can stall enough
// for Node's HTTP layer (or any proxy in front) to drop the
// connection. Browsers see the SSE close and the chat shows
// "Reconnecting…" right after the user submits a prompt with an
// attachment.
//
// Pure ESM JS (.mjs) so it runs unmodified under both `tsx` (dev) and
// compiled-prod node — the build script copies it next to the
// compiled .js dispatcher.
import { Buffer } from "node:buffer";
import { parentPort } from "node:worker_threads";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

if (parentPort === null) {
  throw new Error("conversion-worker.mjs must be loaded as a worker_threads worker");
}

async function convertPdf(buf) {
  let parser;
  try {
    parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    if (result.pages.length === 0) {
      return "[PDF contained no extractable text — possibly a scanned/image-only document]";
    }
    return result.pages.map((p) => `--- Page ${p.num} ---\n${p.text.trimEnd()}`).join("\n\n");
  } finally {
    if (parser !== undefined) {
      await parser.destroy().catch(() => undefined);
    }
  }
}

async function convertDocx(buf) {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

async function convertXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(csvEscape(cell.text ?? ""));
      });
      rows.push(cells.join(","));
    });
    sheets.push(`--- Sheet: ${ws.name} ---\n${rows.join("\n")}`);
  });
  if (sheets.length === 0) return "[Workbook contained no readable sheets]";
  return sheets.join("\n\n");
}

function csvEscape(s) {
  if (s.length === 0) return s;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

parentPort.on("message", async (msg) => {
  // msg = { id, format, buf } — buf arrives as ArrayBuffer because
  // that transfers cheaply between threads.
  const { id, format, buf } = msg;
  const buffer = Buffer.from(buf);
  try {
    let text;
    if (format === "pdf") text = await convertPdf(buffer);
    else if (format === "docx") text = await convertDocx(buffer);
    else if (format === "xlsx") text = await convertXlsx(buffer);
    else throw new Error(`unknown format: ${format}`);
    parentPort.postMessage({ id, ok: true, text });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
