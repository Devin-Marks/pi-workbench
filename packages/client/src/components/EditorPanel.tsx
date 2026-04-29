import { lazy, Suspense } from "react";
import { useFileStore, type OpenFile } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import { X } from "lucide-react";

/**
 * Lazy-loaded CodeMirror host. The CM bundle (basicSetup + 9 language
 * packs + theme) is ~700 KB minified and irrelevant on the initial
 * render — the user might open the chat, run a command, never look at
 * a file. Splitting it keeps the entry chunk closer to 600 KB and
 * makes the Vite "chunk size" warning go quiet.
 *
 * The lazy boundary lives at the React render layer, NOT inside the
 * panel component, so React identifies it once at module evaluation
 * (not every render).
 */
const CodeMirrorEditor = lazy(() => import("./CodeMirrorEditor"));

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
            <Suspense fallback={<EditorLoading />}>
              <CodeMirrorEditor
                key={active.tabId}
                file={active}
                onChange={(v) => updateDraft(active.path, v)}
                onSaveShortcut={() => {
                  if (project !== undefined) void saveFile(project.id, active.path);
                }}
              />
            </Suspense>
          )}
          <StatusBar file={active} />
        </>
      )}
    </div>
  );
}

function EditorLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-xs italic text-neutral-500">
      Loading editor…
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
            key={f.tabId}
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
