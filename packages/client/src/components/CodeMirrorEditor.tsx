import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import type { OpenFile } from "../store/file-store";

const AUTOSAVE_DEBOUNCE_MS = 1000;

/**
 * CodeMirror host. Lives in its own module so EditorPanel can pull it
 * in via `React.lazy()` — the CM bundle is ~700 KB minified and the
 * user might never open a file in a given session, so it shouldn't
 * weigh down the initial app load.
 *
 * Keyed on the tab's stable `tabId` (assigned at open time) — switching
 * tabs unmounts + remounts, but RENAMING the file keeps the same
 * tabId so cursor / scroll / undo / selection survive.
 */
export default function CodeMirrorEditor({
  file,
  onChange,
  onSaveShortcut,
}: {
  file: OpenFile;
  onChange: (next: string) => void;
  onSaveShortcut: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Latest `onChange` / `onSaveShortcut` in refs so the EditorView
  // listener doesn't capture stale closures across renders.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSaveShortcut;
  }, [onSaveShortcut]);

  // Build the EditorView once per mount (per file, thanks to the React
  // `key`). Tearing down on unmount avoids the classic CodeMirror leak
  // where the DOM node gets reattached without the view's listeners
  // wired up.
  useEffect(() => {
    if (containerRef.current === null) return undefined;
    const langExt = languageExtension(file.language);
    const exts: Extension[] = [
      basicSetup,
      oneDark,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const value = update.state.doc.toString();
        onChangeRef.current(value);
      }),
    ];
    if (langExt !== undefined) exts.push(langExt);
    const state = EditorState.create({ doc: file.draft, extensions: exts });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External draft change (e.g. reloadFile bringing fresh disk content)
  // — sync into the editor without firing onChange.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.doc.toString() === file.draft) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: file.draft },
    });
  }, [file.draft]);

  // Debounced autosave: schedule a save 1s after the last `dirty`
  // transition. Cleared on tab switch (component unmounts via key).
  useEffect(() => {
    if (!file.dirty || file.binary) return undefined;
    const timer = window.setTimeout(() => {
      onSaveRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [file.dirty, file.draft, file.binary]);

  return <div ref={containerRef} className="flex-1 overflow-auto" />;
}

function languageExtension(language: string): Extension | undefined {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "python":
      return python();
    case "rust":
      return rust();
    case "cpp":
    case "c":
      return cpp();
    case "java":
      return java();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "css":
    case "scss":
      return css();
    default:
      return undefined;
  }
}
