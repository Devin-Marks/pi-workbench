import { extname, join } from "node:path";
import { readFile } from "./file-manager.js";

/**
 * Expand `@<path>` references in user input into inline file content
 * blocks. The chat input's `@`-autocomplete inserts these markers;
 * this helper transforms them server-side before the prompt reaches
 * pi's `session.prompt()` so the LLM sees the expanded content as
 * part of the user message.
 *
 * Behaviour:
 * - Markers must be at start-of-string OR preceded by whitespace
 *   (avoid expanding `email@example.com`).
 * - The path span is greedy non-whitespace, stopping at the next
 *   whitespace character — paths with spaces aren't supported in v1.
 * - Resolved against the project's workspace root via file-manager's
 *   path-traversal-safe `readFile`. A path outside the project, a
 *   missing file, a binary file, or a too-large file leaves the
 *   `@<path>` marker UNTOUCHED in the output (the LLM sees the
 *   literal string the user typed). No error — the user's prompt is
 *   the source of truth; we expand opportunistically.
 * - Each successful expansion REPLACES the marker with a fenced
 *   code block:
 *     ```ts file: src/foo.ts
 *     <content>
 *     ```
 *   The language hint is derived from the file extension so
 *   downstream syntax-highlighting works.
 *
 * Multiple markers in one prompt all expand. Same file referenced
 * twice gets included twice — caller can dedupe upstream if they
 * want to.
 */
export async function expandFileReferences(text: string, workspacePath: string): Promise<string> {
  // Match @ at start-or-after-whitespace, then a path-shaped token
  // (one or more non-whitespace chars). Capture the whole match
  // (including the leading whitespace/anchor) so the replacement
  // preserves what came before the @.
  const re = /(^|\s)@([^\s]+)/g;
  const matches: { start: number; end: number; path: string; lead: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      lead: m[1] ?? "",
      path: m[2] ?? "",
    });
  }
  if (matches.length === 0) return text;

  // Read all referenced files in parallel — most chats reference 1-3
  // files, occasionally more, and the I/O is the bottleneck.
  const expansions = await Promise.all(
    matches.map(async (mm) => {
      try {
        const abs = join(workspacePath, mm.path);
        const result = await readFile(abs, workspacePath);
        if (result.binary) return undefined; // leave marker as-is
        return formatExpansion(mm.path, result.content);
      } catch {
        return undefined; // file missing / too large / outside root → leave marker
      }
    }),
  );

  // Walk the matches in reverse so earlier indices stay valid as we
  // splice the string. Skip null expansions.
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const expansion = expansions[i];
    const mm = matches[i];
    if (expansion === undefined || mm === undefined) continue;
    // Preserve the leading whitespace (or empty lead at start-of-string)
    // and replace ONLY the `@<path>` portion.
    const before = out.slice(0, mm.start) + mm.lead;
    const after = out.slice(mm.end);
    out = `${before}\n${expansion}\n${after}`;
  }
  return out;
}

function formatExpansion(path: string, content: string): string {
  const lang = languageHintForPath(path);
  // Use a fence longer than any backtick run inside the content so
  // the block can't be terminated by source that itself contains
  // ``` (markdown / docs files do this).
  const fence = pickFence(content);
  return `${fence}${lang} file: ${path}\n${content}\n${fence}`;
}

function pickFence(content: string): string {
  // Find the longest backtick run in the content; use one more.
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

function languageHintForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return LANG_BY_EXT[ext] ?? "";
}
