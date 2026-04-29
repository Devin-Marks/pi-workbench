import { tokenize, type HunkData, type HunkTokens } from "react-diff-view";
import { refractor } from "refractor/core";
import bash from "refractor/bash";
import cpp from "refractor/cpp";
import css from "refractor/css";
import go from "refractor/go";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import python from "refractor/python";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import sql from "refractor/sql";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

/**
 * Per-file syntax highlighting for `react-diff-view`. Uses
 * `refractor` (Prism's hast-tree wrapper) which is the highlighter
 * shape `react-diff-view`'s `tokenize` accepts natively.
 *
 * Language list is curated — we register the languages a coding
 * workspace actually sees (~16 of them). The full Prism set is 250+
 * languages and ships ~1 MB; ours adds well under 100 KB.
 *
 * If the inferred language isn't registered, `highlightHunks` returns
 * undefined and the Diff component renders without tokens — same
 * appearance as before this module existed.
 */
refractor.register(bash);
refractor.register(cpp);
refractor.register(css);
refractor.register(go);
refractor.register(java);
refractor.register(javascript);
refractor.register(json);
refractor.register(markdown);
refractor.register(markup); // html / xml / svg
refractor.register(python);
refractor.register(ruby);
refractor.register(rust);
refractor.register(sql);
refractor.register(tsx);
refractor.register(typescript);
refractor.register(yaml);

const REGISTERED = new Set([
  "bash",
  "cpp",
  "css",
  "go",
  "java",
  "javascript",
  "json",
  "markdown",
  "markup",
  "python",
  "ruby",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  // JS/TS — `.tsx` and `.jsx` route through `tsx` because Prism's
  // tsx grammar is the superset that handles JSX in either world.
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  // Systems
  rs: "rust",
  go: "go",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  // Scripting
  py: "python",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  // Data / markup
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "css",
  sql: "sql",
};

/**
 * Pick the refractor language for a filename via its extension.
 * Returns undefined when there's no extension or the extension isn't
 * mapped — caller falls back to no highlighting.
 */
export function languageForFile(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  const lang = EXT_TO_LANGUAGE[ext];
  if (lang === undefined || !REGISTERED.has(lang)) return undefined;
  return lang;
}

/**
 * Tokenize a file's hunks for the `Diff` component's `tokens` prop.
 * Returns `undefined` on any error or unregistered language so the
 * caller can render plain (uncoloured) diff text instead of crashing.
 */
export function highlightHunks(
  hunks: HunkData[],
  language: string | undefined,
): HunkTokens | undefined {
  if (language === undefined) return undefined;
  try {
    return tokenize(hunks, {
      highlight: true,
      refractor,
      language,
    });
  } catch {
    // Unparseable input (malformed tokens, etc.) — degrade silently.
    return undefined;
  }
}
