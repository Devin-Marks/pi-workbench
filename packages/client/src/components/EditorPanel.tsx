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
import { useFileStore, type OpenFile } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import { X } from "lucide-react";

const AUTOSAVE_DEBOUNCE_MS = 1000;

/**
 * Phase 10 editor: tabs across the top, single CodeMirror instance under
 * them. Switching tabs replaces the editor's `EditorState` rather than
 * teardown-and-rebuild — keeps focus + DOM stable while we hot-swap the
 * document and language extension.
 *
 * Autosave debounces a `PUT /files/write` 1s after the last keystroke;
 * Cmd/Ctrl+S forces an immediate save. Dirty state lives in the store
 * (so the tab labels and "Saved" indicator can render without dragging
 * a ref through every consumer), but the CodeMirror state is the
 * source of truth for the textarea contents until we persist it via
 * `updateDraft`.
 */
export function EditorPanel() {
  const project = useActiveProject();
  const openFiles = useFileStore((s) => s.openFiles);
  const activePath = useFileStore((s) => s.activePath);
  const setActiveFile = useFileStore((s) => s.setActiveFile);
  const closeFile = useFileStore((s) => s.closeFile);
  const updateDraft = useFileStore((s) => s.updateDraft);
  const saveFile = useFileStore((s) => s.saveFile);
  const reloadFile = useFileStore((s) => s.reloadFile);
  const externallyChanged = useFileStore((s) => s.externallyChanged);

  const active = openFiles.find((f) => f.path === activePath);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      <Tabs
        files={openFiles}
        activePath={activePath}
        onActivate={setActiveFile}
        onClose={closeFile}
      />
      {active === undefined ? (
        <div className="flex flex-1 items-center justify-center text-xs italic text-neutral-500">
          No file open. Click a file in the tree to start editing.
        </div>
      ) : (
        <>
          {externallyChanged[active.path] === true && (
            <ExternalChangeBanner
              path={active.path}
              onReload={() => {
                if (project !== undefined) void reloadFile(project.id, active.path);
              }}
              onDiscard={() => useFileStore.getState().dismissExternallyChanged(active.path)}
            />
          )}
          {active.binary ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-neutral-500">
              {active.loadingError ?? "Binary file."}
            </div>
          ) : (
            <Editor
              key={active.path}
              file={active}
              onChange={(v) => updateDraft(active.path, v)}
              onSaveShortcut={() => {
                if (project !== undefined) void saveFile(project.id, active.path);
              }}
            />
          )}
          <StatusBar file={active} />
        </>
      )}
    </div>
  );
}

function Tabs({
  files,
  activePath,
  onActivate,
  onClose,
}: {
  files: OpenFile[];
  activePath: string | undefined;
  onActivate: (path: string | undefined) => void;
  onClose: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex overflow-x-auto border-b border-neutral-800 bg-neutral-900/40">
      {files.map((f) => {
        const name = f.path.split("/").pop() ?? f.path;
        const active = f.path === activePath;
        return (
          <div
            key={f.path}
            className={`group flex items-center gap-1 border-r border-neutral-800 px-3 py-1.5 text-xs ${
              active
                ? "bg-neutral-950 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            <button onClick={() => onActivate(f.path)} className="truncate" title={f.path}>
              {f.dirty && <span className="mr-1 text-amber-400">•</span>}
              {name}
            </button>
            <button
              onClick={() => onClose(f.path)}
              className="rounded p-0.5 text-neutral-600 opacity-0 hover:bg-neutral-800 hover:text-neutral-200 group-hover:opacity-100"
              title="Close (any unsaved changes are lost)"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ExternalChangeBanner({
  path,
  onReload,
  onDiscard,
}: {
  path: string;
  onReload: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-700/40 bg-amber-900/20 px-4 py-1.5 text-xs text-amber-200">
      <span>
        File changed externally — local edits in this tab are stale. Reload from disk?
        <span className="ml-2 font-mono text-[10px] text-amber-400/70">{path}</span>
      </span>
      <div className="flex gap-1">
        <button
          onClick={onReload}
          className="rounded border border-amber-700/50 px-2 py-0.5 hover:bg-amber-900/30"
        >
          Reload
        </button>
        <button
          onClick={onDiscard}
          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}

function StatusBar({ file }: { file: OpenFile }) {
  const dirty = file.dirty;
  const saving = file.saving;
  const savedAt = file.savedAt;
  let label: string;
  let className = "text-neutral-500";
  if (saving) {
    label = "Saving…";
  } else if (dirty) {
    label = "Unsaved changes";
    className = "text-amber-400";
  } else if (savedAt !== undefined) {
    const t = new Date(savedAt);
    label = `Saved ${t.toLocaleTimeString()}`;
    className = "text-emerald-500";
  } else {
    label = "Up to date";
  }
  return (
    <div className="flex items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-900/40 px-3 py-1 text-[11px]">
      <span className="font-mono text-neutral-500">{file.language}</span>
      <span className={className}>{label}</span>
    </div>
  );
}

/**
 * CodeMirror host. Uses a stable `key` (the file path) on the wrapper
 * so React unmounts + remounts when the user switches tabs — that's
 * cheaper to reason about than diffing the EditorState in place, and
 * the editor cost is tiny (single textarea).
 */
function Editor({
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
