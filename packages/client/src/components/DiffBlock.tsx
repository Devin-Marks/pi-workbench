import { Diff, Hunk, parseDiff, type FileData, type RenderGutter } from "react-diff-view";
import "react-diff-view/style/index.css";

/**
 * Single-column gutter renderer. `react-diff-view`'s default
 * unified mode renders TWO gutter columns side-by-side (old +
 * new), which is noisy for our narrow chat / right-pane layouts.
 * We collapse to one column by:
 *   1. Returning `null` for the `side: "old"` slot so the cell is
 *      empty (CSS in `index.css` then hides the column entirely).
 *   2. Rendering ONE line number on the `side: "new"` slot per row.
 *
 * gitdiff-parser's `ChangeData` is a discriminated union with
 * different shapes per type:
 *   - `normal` (context): `oldLineNumber` + `newLineNumber` (both
 *     numbers; we show new since it matches the post-edit file).
 *   - `insert`: just `lineNumber` (the new file's line).
 *   - `delete`: just `lineNumber` (the old file's line).
 *
 * Picking the only number available per row keeps the gutter
 * meaningful for every line type — removed lines still get a
 * number so users can locate them in the original file.
 */
const renderSingleGutter: RenderGutter = ({ change, side }) => {
  if (side === "old") return null;
  const num = change.type === "normal" ? change.newLineNumber : change.lineNumber;
  if (num === undefined) return null;
  return <span>{num}</span>;
};

/**
 * Reusable unified-diff renderer used by both the inline ChatView
 * edit-tool result and the TurnDiffPanel. Wraps `react-diff-view`'s
 * `Diff` + `Hunk` primitives with our dark-theme overrides.
 *
 * Render-path resolution (in order):
 *   1. Pi-format detection — pi's edit tool emits a humanized
 *      line-numbered display (`<marker><line-num> <content>`, no
 *      `@@`/`---` headers). Convert to canonical unified diff and
 *      try `parseDiff` against THAT. This is what we hit in practice.
 *   2. `parseDiff` on the raw input. Real unified diffs land here.
 *   3. Synthesize a `--- /+++` header for inputs that have `@@`
 *      hunks but no file header.
 *   4. Colored `<pre>` fallback — at least the +/- markers stay
 *      visible even if we can't structurally parse.
 *
 * Anything that lands in #4 also logs a console warning with the
 * first 200 chars so we can identify a NEW unhandled format.
 *
 * Syntax highlighting via `prism-react-renderer` is intentionally
 * deferred to a future polish pass — see `Dif1` in DEFERRED.md.
 */
export function DiffBlock({ diff }: { diff: string }) {
  let files: FileData[] = [];
  let strategy: "pi" | "raw" | "synthetic" | "fallback" = "fallback";

  // Path 1: pi humanized format. Tried first because once we know
  // the SDK is using it, every subsequent edit will hit this path
  // and we want the table renderer, not the colored fallback.
  const pi = convertPiFormat(diff);
  if (pi !== undefined) {
    const candidate = safeParse(pi);
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "pi";
    }
  }

  // Path 2: real unified diff as-is.
  if (strategy === "fallback") {
    const candidate = safeParse(diff);
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "raw";
    }
  }

  // Path 3: synthesize a file header for hunks-only inputs.
  if (strategy === "fallback" && needsSyntheticHeader(diff)) {
    const candidate = safeParse(SYNTHETIC_HEADER + diff.replace(/^\n+/, ""));
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "synthetic";
    }
  }

  if (strategy === "fallback") {
    if (typeof console !== "undefined") {
      console.warn(
        "[DiffBlock] parseDiff produced no hunks; rendering colored fallback. Diff prefix:",
        diff.slice(0, 200),
      );
    }
    return <FallbackDiff diff={diff} />;
  }

  return (
    <div className="pi-diff-block overflow-auto px-2 pb-2 text-[11px]">
      {files.map((file) => (
        <Diff
          key={`${file.oldPath ?? ""}:${file.newPath ?? ""}`}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          renderGutter={renderSingleGutter}
        >
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  );
}

/**
 * Synthetic file header used when the input has hunks but no
 * `--- /+++` header. The path is a placeholder — `react-diff-view`
 * uses it as a key but doesn't render it (we never show file
 * headers in our chat / panel layouts; the parent component shows
 * the filename next to the +/- counts already).
 */
const SYNTHETIC_HEADER = "--- a/file\n+++ b/file\n";

/**
 * Convert pi's humanized edit display into a canonical unified
 * diff. Pi's format (defined in `pi-coding-agent`'s
 * `edit-diff.ts#generateDiffString`):
 *
 *   ` 1 # comment`        ← context (space marker, padded line-num, content)
 *   ` 2 def main():`
 *   `- 3     print('old')` ← removal (line-num is space-padded to file width)
 *   `+ 3     print('new')` ← addition
 *   ` 4`                   ← blank-line context (no content after num)
 *   `   ...`               ← skipped-context separator (≥3 spaces + literal "...")
 *   ` 30 # later in file`  ← context resumes at a higher line number
 *
 * The line number is space-padded to the width needed to display
 * the largest line number in the file, so e.g. 1000-line files
 * emit `- 999 ...` not `-999 ...`. The `...` marker appears between
 * two changes more than 8 context lines apart (default 4-around);
 * we treat each `...` as a HUNK BOUNDARY so the resulting unified
 * diff has accurate per-hunk line numbers.
 *
 * Returns `undefined` if any non-empty, non-skip-marker input line
 * doesn't match the pattern — the signal "this isn't pi format,
 * try something else." Returns a multi-hunk unified diff on success.
 *
 * Each hunk's `oldStart` / `newStart` come from the FIRST line of
 * that hunk. Pi always emits at least one context line at the start
 * of each rendered region (4-line default), so the first line is
 * almost always context where old==new. Edge-case hunks that begin
 * with a change immediately would have one of the starts off by
 * one — acceptable for review purposes.
 */
function convertPiFormat(diff: string): string | undefined {
  const lines = diff.split("\n");
  // Marker, optional space-padding, digits, optional " content".
  const lineRe = /^([+\- ]) *(\d+)(?: (.*))?$/;
  // Skipped-context marker: leading spaces (the empty padded
  // line-num column + the separator), then literal "...". Pi emits
  // at least 3 leading spaces (1 marker space + ≥1 padded space + 1
  // separator); we accept ≥1 to be lenient.
  const skipRe = /^ +\.\.\.$/;

  interface Hunk {
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
    body: string[];
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let matched = 0;

  const flush = (): void => {
    if (cur !== undefined && cur.body.length > 0) hunks.push(cur);
    cur = undefined;
  };

  for (const line of lines) {
    if (line.length === 0) continue;
    if (skipRe.test(line)) {
      // Hunk boundary — close the current hunk so the next
      // displayed region gets its own header with the correct
      // line numbers.
      flush();
      continue;
    }
    const m = lineRe.exec(line);
    if (m === null) return undefined;
    matched += 1;
    const marker = m[1] as "+" | "-" | " ";
    const num = Number.parseInt(m[2] ?? "", 10);
    const content = m[3] ?? "";
    if (cur === undefined) {
      // First line of a new hunk: use the displayed line number for
      // both starts. Pi's leading-context-then-change pattern means
      // this is virtually always a context line where old==new.
      cur = { oldStart: num, newStart: num, oldCount: 0, newCount: 0, body: [] };
    }
    if (marker === " ") {
      cur.body.push(" " + content);
      cur.oldCount += 1;
      cur.newCount += 1;
    } else if (marker === "-") {
      cur.body.push("-" + content);
      cur.oldCount += 1;
    } else {
      cur.body.push("+" + content);
      cur.newCount += 1;
    }
  }
  flush();

  if (matched === 0 || hunks.length === 0) return undefined;
  return (
    SYNTHETIC_HEADER +
    hunks
      .map(
        (h) =>
          `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n` + h.body.join("\n"),
      )
      .join("\n") +
    "\n"
  );
}

function safeParse(diff: string): FileData[] {
  try {
    return parseDiff(diff);
  } catch {
    return [];
  }
}

function hasHunks(files: FileData[]): boolean {
  return files.length > 0 && files.some((f) => f.hunks.length > 0);
}

/**
 * True when the diff body contains at least one hunk header but no
 * file header. We require BOTH a `@@` line (so we don't synthesize
 * a header for plain text the user passed in by mistake) AND the
 * absence of `--- ` / `+++ ` lines. Lines starting with `---` or
 * `+++` in unified diffs are always the file headers — content
 * removal/addition lines start with a single `-` / `+`.
 */
function needsSyntheticHeader(diff: string): boolean {
  const hasHunk = /^@@ /m.test(diff);
  const hasHeader = /^--- /m.test(diff) && /^\+\+\+ /m.test(diff);
  return hasHunk && !hasHeader;
}

/**
 * Plain-text fallback that paints diff lines manually. Catches:
 *   - SDK edit results that omit the `--- /+++` headers (parseDiff
 *     skips them but the user still has a clearly-marked unified diff
 *     they want to read)
 *   - Empty or partial diffs
 *   - Anything else parseDiff couldn't make sense of
 *
 * Without this, the chat's edit results rendered as monochrome neutral
 * text — no red for removals, no green for additions. The CSS variables
 * scoped to `.pi-diff-block` only apply when react-diff-view rendered
 * the table; the fallback path needs explicit class colors.
 */
function FallbackDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] leading-tight">
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line.length === 0 ? " " : line}
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  // Order matters: check `+++` / `---` BEFORE `+` / `-`.
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-neutral-500";
  }
  if (line.startsWith("@@")) {
    return "bg-neutral-900 text-cyan-400";
  }
  if (line.startsWith("+")) {
    return "bg-emerald-950/60 text-emerald-200";
  }
  if (line.startsWith("-")) {
    return "bg-red-950/60 text-red-200";
  }
  return "text-neutral-400";
}
