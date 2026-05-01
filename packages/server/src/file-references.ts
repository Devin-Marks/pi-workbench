import { extname, join } from "node:path";
import { checkFileReference, readFile } from "./file-manager.js";

/**
 * Process `@<path>` references in user input. The chat input's
 * `@`-autocomplete inserts these markers; this helper transforms them
 * server-side before the prompt reaches pi's `session.prompt()`.
 *
 * Threshold-based design: small files get inlined as fenced code blocks
 * (the model has the content immediately, no tool round-trip); large
 * files stay as the literal `@<path>` reference (the model loads what
 * it needs via its read/grep/find tools, no context-burn on a 50 MB
 * log we'd otherwise inhale wholesale).
 *
 * The chat UI renders BOTH forms as collapsed file badges in the user
 * message bubble, so visually the user sees a chip either way; the
 * difference is purely whether the LLM has the content in-prompt or
 * has to fetch it.
 *
 * Behaviour:
 * - Markers must be at start-of-string OR preceded by whitespace
 *   (avoid expanding `email@example.com`).
 * - Two path forms accepted:
 *     `@<path>`               — greedy non-whitespace; common case.
 *     `@"<path with spaces>"` — anything that isn't a `"` or newline.
 * - Resolved against the project's workspace root via file-manager's
 *   path-traversal-safe `checkFileReference`. Three outcomes:
 *     inline  → file ≤ INLINE_THRESHOLD; replace marker with a fenced
 *                code block. Language hint derived from extension.
 *     defer   → file > INLINE_THRESHOLD; leave the literal `@<path>`
 *                reference for the model to load on demand.
 *     error   → missing / outside root / directory / binary. Replace
 *                marker with `[@<path> not included: <reason>]` so
 *                neither user nor model is left guessing.
 *
 * Multiple markers in one prompt all process independently.
 */

/**
 * Inlining cutoff. Files at or under this byte count are inlined as
 * fenced blocks; larger files are left as `@<path>` for the model to
 * fetch. 128 KB is roughly 32K tokens — small enough to be safe in a
 * 200K-token context window and large enough to cover most real
 * source files (a 1k-line TS file is typically ~50 KB).
 */
const INLINE_THRESHOLD_BYTES = 128 * 1024;

/**
 * Regex shared by `findRefs` and `parseFileReferences`. Match `@` at
 * start-or-after-whitespace then either a `"path with spaces"` quoted
 * form or a bare non-whitespace token.
 */
const REF_RE = /(^|\s)@(?:"([^"\n]+)"|([^\s]+))/g;

interface RefMatch {
  start: number;
  end: number;
  path: string;
  lead: string;
}

function findRefs(text: string): RefMatch[] {
  const matches: RefMatch[] = [];
  let m: RegExpExecArray | null;
  // Reset the regex state between calls — REF_RE is module-level with
  // the `g` flag, so it carries `lastIndex` across invocations.
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      lead: m[1] ?? "",
      path: m[2] ?? m[3] ?? "",
    });
  }
  return matches;
}

/**
 * Parse `@<path>` references out of a text without touching it. Used
 * by the chat input to surface badges of what's about to be sent.
 */
export function parseFileReferences(text: string): string[] {
  return findRefs(text).map((m) => m.path);
}

export async function expandFileReferences(text: string, workspacePath: string): Promise<string> {
  const matches = findRefs(text);
  if (matches.length === 0) return text;

  type Outcome =
    | { kind: "inline"; text: string }
    | { kind: "defer" }
    | { kind: "error"; reason: string };

  const outcomes: Outcome[] = await Promise.all(
    matches.map(async (mm): Promise<Outcome> => {
      try {
        const abs = join(workspacePath, mm.path);
        // Cheap up-front check (path safety + stat + 8 KB sniff) so we
        // can decide inline-vs-defer without reading large files.
        const check = await checkFileReference(abs, workspacePath);
        if (check.binary) return { kind: "error", reason: "binary file" };
        if (check.size > INLINE_THRESHOLD_BYTES) return { kind: "defer" };
        // Small enough to inline — read the whole file and emit a
        // fenced block.
        const result = await readFile(abs, workspacePath);
        if (result.binary) return { kind: "error", reason: "binary file" };
        return { kind: "inline", text: formatExpansion(mm.path, result.content) };
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.name === "FileTooLargeError") {
          // readFile's own 5 MB cap fired — defer to model tool use.
          // Shouldn't normally hit this since the size-check above
          // catches anything bigger than INLINE_THRESHOLD_BYTES, but
          // belt-and-suspenders for cases where the file grew between
          // check and read.
          return { kind: "defer" };
        }
        if (e.name === "NotFoundError" || e.code === "ENOENT") {
          return { kind: "error", reason: "file not found" };
        }
        if (e.name === "PathOutsideRootError") {
          return { kind: "error", reason: "path is outside the project root" };
        }
        if (e.name === "NotAFileError") {
          return { kind: "error", reason: "path is a directory, not a file" };
        }
        return { kind: "error", reason: "unreadable" };
      }
    }),
  );

  // Walk in reverse so earlier indices stay valid as we splice.
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const outcome = outcomes[i];
    const mm = matches[i];
    if (outcome === undefined || mm === undefined) continue;
    const before = out.slice(0, mm.start) + mm.lead;
    const after = out.slice(mm.end);
    if (outcome.kind === "inline") {
      out = `${before}\n${outcome.text}\n${after}`;
    } else if (outcome.kind === "defer") {
      // Re-emit the marker (preserve quoting if path has whitespace).
      const marker = /\s/.test(mm.path) ? `@"${mm.path}"` : `@${mm.path}`;
      out = `${before}${marker}${after}`;
    } else {
      out = `${before}[@${mm.path} not included: ${outcome.reason}]${after}`;
    }
  }
  return out;
}

function formatExpansion(path: string, content: string): string {
  const lang = languageHintForPath(path);
  // Pick a fence longer than any backtick run inside the content so
  // the block can't be terminated by source that itself contains
  // ``` (markdown / docs files do this).
  const fence = pickFence(content);
  return `${fence}${lang} file: ${path}\n${content}\n${fence}`;
}

function pickFence(content: string): string {
  let max = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === "`") {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".xml": "xml",
};

export function languageHintForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return LANG_BY_EXT[ext] ?? "";
}
