import { Diff, Hunk, parseDiff, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";

/**
 * Reusable unified-diff renderer used by both the inline ChatView
 * edit-tool result and the TurnDiffPanel. Wraps `react-diff-view`'s
 * `Diff` + `Hunk` primitives with our dark-theme overrides.
 *
 * Defensive: if `parseDiff` returns nothing usable (e.g. agent emitted
 * a malformed diff), fall back to a plain `<pre>` so the user still
 * sees the raw text instead of an empty box.
 *
 * Syntax highlighting via `prism-react-renderer` is intentionally
 * deferred to a future polish pass — it costs another ~50KB of
 * bundle and the diff-view + dark-theme combo is already legible
 * without it.
 */
export function DiffBlock({ diff }: { diff: string }) {
  let files: FileData[] = [];
  try {
    files = parseDiff(diff);
  } catch {
    // parseDiff occasionally throws on malformed input; treat as
    // "render raw" rather than crashing the chat surface.
  }
  if (files.length === 0 || files.every((f) => f.hunks.length === 0)) {
    return (
      <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">{diff}</pre>
    );
  }
  return (
    <div className="overflow-auto pi-diff-block px-2 pb-2 text-[11px]">
      {files.map((file) => (
        <Diff
          key={`${file.oldPath ?? ""}:${file.newPath ?? ""}`}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
        >
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  );
}
