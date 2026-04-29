import { execFile, spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { SEARCH_SKIP_DIRS } from "./file-manager.js";

const execFileAsync = promisify(execFile);

/**
 * Cross-project text + regex search. Two implementations behind a
 * single entry point:
 *
 *   1. ripgrep (`rg --json`) — preferred. Fast, gitignore-aware,
 *      handles encoding, binary detection, and (by default) skips
 *      .git/node_modules/etc.
 *   2. In-process Node walk — fallback for hosts without rg. Slower
 *      and not gitignore-aware, but always available. Honors the
 *      same static skip list as the file tree (`SEARCH_SKIP_DIRS`),
 *      caps file size, skips binary files via NUL-byte heuristic,
 *      and bounds concurrency.
 *
 * Both return the SAME match shape so the route + UI don't have to
 * branch. The response includes `engine: "ripgrep" | "node"` so the
 * client can render a "fallback mode" badge when relevant.
 */

export interface SearchMatch {
  /** Project-relative path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column where the match starts. */
  column: number;
  /** Length of the matched substring (in UTF-16 code units, JS-native). */
  length: number;
  /** Full source line (trimmed of trailing newline) for snippet rendering. */
  lineSnippet: string;
}

export interface SearchOptions {
  query: string;
  /** When true, `query` is a regex pattern. When false, plain substring. */
  regex: boolean;
  caseSensitive: boolean;
  /**
   * When true (and ripgrep is the engine), skip `.gitignore` rules.
   * The Node fallback ignores this flag — it has no gitignore
   * support, so toggling it changes nothing on that path.
   */
  includeGitignored: boolean;
  /** rg-style include glob (e.g. "*.ts"). Optional. */
  include?: string;
  /** rg-style exclude glob. Optional. */
  exclude?: string;
  /** Hard cap on returned matches. */
  limit: number;
  /** Wall-clock budget. Aborts in-flight work if exceeded. */
  timeoutMs: number;
}

export interface SearchResult {
  engine: "ripgrep" | "node";
  matches: SearchMatch[];
  /** True when we hit `limit` and stopped collecting more results. */
  truncated: boolean;
}

/* ----------------------------- detection ----------------------------- */

let cachedRipgrepAvailable: boolean | undefined;

export async function ripgrepAvailable(): Promise<boolean> {
  if (cachedRipgrepAvailable !== undefined) return cachedRipgrepAvailable;
  try {
    await execFileAsync("rg", ["--version"], { timeout: 2_000 });
    cachedRipgrepAvailable = true;
  } catch {
    // ENOENT (not installed), timeout, non-zero exit — all collapse to
    // "no". A single warn-once log lives at the route layer so the
    // operator notices a busted install.
    cachedRipgrepAvailable = false;
  }
  return cachedRipgrepAvailable;
}

/** Reset the detection cache. Test-only; do not call from app code. */
export function _resetRipgrepCache(): void {
  cachedRipgrepAvailable = undefined;
}

/* ----------------------------- entry point ----------------------------- */

export async function searchFiles(projectPath: string, opts: SearchOptions): Promise<SearchResult> {
  if (await ripgrepAvailable()) {
    return searchWithRipgrep(projectPath, opts);
  }
  return searchInProcess(projectPath, opts);
}

/* ----------------------------- ripgrep path ----------------------------- */

interface RipgrepEvent {
  type: "begin" | "match" | "end" | "summary" | "context";
  data?: Record<string, unknown>;
}

async function searchWithRipgrep(projectPath: string, opts: SearchOptions): Promise<SearchResult> {
  const args: string[] = [
    "--json",
    "--no-heading",
    "--max-filesize",
    "5M",
    // Hard match-count cap as a backstop; we stop reading earlier if we
    // hit our own `limit`, but `--max-count` per file keeps a single
    // pathological file (e.g. `.*` against a 100k-line CSV) from
    // dominating the output.
    "--max-count",
    String(Math.max(1, Math.min(opts.limit, 1000))),
  ];
  if (!opts.regex) args.push("--fixed-strings");
  if (!opts.caseSensitive) args.push("-i");
  if (opts.includeGitignored) {
    // -uu: don't honor .gitignore + show hidden files. We deliberately
    // don't go to -uuu (also includes binary) — the binary-file skip
    // is desired regardless.
    args.push("-uu");
  }
  if (opts.include !== undefined && opts.include.length > 0) {
    args.push("--glob", opts.include);
  }
  if (opts.exclude !== undefined && opts.exclude.length > 0) {
    args.push("--glob", `!${opts.exclude}`);
  }
  args.push("--", opts.query, ".");

  return new Promise<SearchResult>((resolveFn) => {
    const matches: SearchMatch[] = [];
    let truncated = false;
    const child = spawn("rg", args, { cwd: projectPath });
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    let buf = "";
    let currentFile: string | undefined;

    const finish = (): void => {
      clearTimeout(timer);
      resolveFn({ engine: "ripgrep", matches, truncated });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) handleEvent(line);
        nl = buf.indexOf("\n");
      }
    });
    child.on("error", () => finish()); // ENOENT or fork failure → empty result
    child.on("close", () => finish());

    const handleEvent = (jsonLine: string): void => {
      let event: RipgrepEvent;
      try {
        event = JSON.parse(jsonLine) as RipgrepEvent;
      } catch {
        return;
      }
      if (event.type === "begin") {
        const data = event.data as { path?: { text?: string } } | undefined;
        currentFile = data?.path?.text;
      } else if (event.type === "match") {
        if (matches.length >= opts.limit) {
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        const data = event.data as
          | {
              lines?: { text?: string };
              line_number?: number;
              submatches?: Array<{ start?: number; end?: number; match?: { text?: string } }>;
            }
          | undefined;
        if (data === undefined || currentFile === undefined) return;
        const lineText = data.lines?.text ?? "";
        const lineNumber = data.line_number ?? 0;
        const sub = data.submatches?.[0];
        const start = sub?.start ?? 0;
        const matchText = sub?.match?.text ?? "";
        matches.push({
          path: currentFile,
          line: lineNumber,
          column: start + 1,
          length: matchText.length,
          lineSnippet: stripTrailingNewline(lineText),
        });
      }
    };
  });
}

/* ----------------------------- in-process path ----------------------------- */

async function searchInProcess(projectPath: string, opts: SearchOptions): Promise<SearchResult> {
  const matches: SearchMatch[] = [];
  let truncated = false;
  const deadline = Date.now() + opts.timeoutMs;

  // Build the matcher up front so we don't reconstruct the regex per
  // line. Plain substring uses indexOf for speed.
  const re = opts.regex ? safeRegex(opts.query, opts.caseSensitive) : undefined;
  if (opts.regex && re === undefined) {
    // Bad pattern → empty result (treat like "no matches"). Caller
    // can validate ahead of time if it wants a 400.
    return { engine: "node", matches: [], truncated: false };
  }

  // Pre-compile glob predicates. Very simple — matches `*.ts` /
  // `**/*.test.*` style patterns. Anything fancier than that we
  // skip and rely on the user installing ripgrep.
  const includeMatch = opts.include !== undefined ? globToRegExp(opts.include) : undefined;
  const excludeMatch = opts.exclude !== undefined ? globToRegExp(opts.exclude) : undefined;

  const root = resolve(projectPath);
  const stack: string[] = [root];
  const filesToScan: string[] = [];

  // First pass: discover files under depth 6 honoring SEARCH_SKIP_DIRS.
  while (stack.length > 0 && Date.now() < deadline) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const depth = relative(root, dir)
      .split(/[\\/]/)
      .filter((p) => p.length > 0).length;
    if (depth > 6) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith(".") && ent.name !== ".") continue;
        stack.push(full);
      } else if (ent.isFile()) {
        const rel = relative(root, full);
        if (includeMatch !== undefined && !includeMatch.test(rel)) continue;
        if (excludeMatch !== undefined && excludeMatch.test(rel)) continue;
        filesToScan.push(rel);
      }
    }
  }
  if (Date.now() >= deadline) truncated = true;

  // Second pass: bounded-concurrency match scan. 16-wide is a
  // reasonable default for SSDs; HDD-bound users will see the same
  // throughput regardless because seek time dominates.
  const CONCURRENCY = 16;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < filesToScan.length) {
      if (Date.now() >= deadline) {
        truncated = true;
        return;
      }
      if (matches.length >= opts.limit) {
        truncated = true;
        return;
      }
      const i = cursor++;
      const rel = filesToScan[i];
      if (rel === undefined) continue;
      const full = join(root, rel);
      // Size + binary skip. The 5 MB cap mirrors file-manager's
      // readFile cap so search and editor agree on what's a "text
      // file." Binary detection is a NUL-byte test on the first
      // 4 KB — same heuristic git itself uses.
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      let content: string;
      try {
        const buf = await readFile(full);
        if (looksBinary(buf)) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }
      scanText(content, rel, opts, re, matches, opts.limit);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(CONCURRENCY, filesToScan.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (matches.length >= opts.limit) truncated = true;

  return { engine: "node", matches, truncated };
}

function scanText(
  content: string,
  rel: string,
  opts: SearchOptions,
  re: RegExp | undefined,
  out: SearchMatch[],
  limit: number,
): void {
  const lines = content.split("\n");
  const cmpQuery = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= limit) return;
    const line = lines[i] ?? "";
    if (re !== undefined) {
      // Use a fresh exec loop so we capture all matches per line.
      // A lastIndex-bumping while-loop avoids /g flag fragility.
      const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = local.exec(line)) !== null) {
        out.push({
          path: rel,
          line: i + 1,
          column: m.index + 1,
          length: m[0].length,
          lineSnippet: line,
        });
        if (out.length >= limit) return;
        // Avoid zero-length match infinite loop.
        if (m.index === local.lastIndex) local.lastIndex += 1;
      }
    } else {
      const haystack = opts.caseSensitive ? line : line.toLowerCase();
      let from = 0;
      while (from <= haystack.length) {
        const idx = haystack.indexOf(cmpQuery, from);
        if (idx === -1) break;
        out.push({
          path: rel,
          line: i + 1,
          column: idx + 1,
          length: opts.query.length,
          lineSnippet: line,
        });
        if (out.length >= limit) return;
        from = idx + Math.max(1, opts.query.length);
      }
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  // Sniff at most the first 4 KB. A NUL byte in a text file is
  // virtually unheard of — git, ripgrep, and most editors use the
  // same heuristic.
  const probe = buf.subarray(0, Math.min(4096, buf.length));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

function safeRegex(pattern: string, caseSensitive: boolean): RegExp | undefined {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    return undefined;
  }
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

/**
 * Translate a simple glob pattern to a RegExp anchored to the full
 * path. Supports `*` (any chars except `/`), `**` (any chars
 * including `/`), and `?` (single char). Anything fancier — char
 * classes, brace expansion — is unsupported on this fallback path.
 */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^$()[]{}|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}
