import { useEffect, useRef, useState } from "react";
import { FolderTree, Terminal as TerminalIcon } from "lucide-react";
import { useAuthStore } from "./store/auth-store";
import { useActiveProject, useProjectStore } from "./store/project-store";
import { useSessionStore } from "./store/session-store";
import { useFileStore } from "./store/file-store";
import { useUiConfigStore } from "./store/ui-config-store";
import { LoginScreen } from "./components/LoginScreen";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectPicker } from "./components/ProjectPicker";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ChangedFilesBadge } from "./components/ChangedFilesBadge";
import { SettingsPanel } from "./components/SettingsPanel";
import { FileBrowserPanel } from "./components/FileBrowserPanel";
import { EditorPanel } from "./components/EditorPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { TurnDiffPanel } from "./components/TurnDiffPanel";
import { GitPanel } from "./components/GitPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ContextInspectorPanel } from "./components/ContextInspectorPanel";
import { ResizableDivider } from "./components/ResizableDivider";
import { useGitStatus } from "./hooks/useGitStatus";

type RightPaneTab = "files" | "search" | "changes" | "git" | "context";

/* Persisted pane widths. Stored in localStorage so the user-tuned
   layout survives reloads. Defaults err on the side of "the chat is the
   primary surface" — files is narrow, editor is medium. */
const FILES_WIDTH_KEY = "pi-workbench/files-width";
const EDITOR_WIDTH_KEY = "pi-workbench/editor-width";
const TERMINAL_HEIGHT_KEY = "pi-workbench/terminal-height";
const DEFAULT_FILES_WIDTH = 280;
const DEFAULT_EDITOR_WIDTH = 480;
const DEFAULT_TERMINAL_HEIGHT = 280;
const MIN_FILES_WIDTH = 200;
const MIN_EDITOR_WIDTH = 320;
const MIN_CHAT_WIDTH = 320;
const MIN_TERMINAL_HEIGHT = 140;

function readPersistedWidth(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Best-effort extraction of the affected file path from a write/edit
 * tool_result message. The SDK's exact field name varies across
 * versions and tool flavours; we try the common ones (same heuristic
 * the chat renderer uses for the tool-call summary).
 */
function extractToolFilePath(message: Record<string, unknown>): string | undefined {
  const details = message.details as
    | { path?: unknown; filePath?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  const input = message.input as
    | { path?: unknown; filePath?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  for (const src of [details, input]) {
    if (src === undefined) continue;
    if (typeof src.path === "string") return src.path;
    if (typeof src.filePath === "string") return src.filePath;
    if (typeof src.file === "string") return src.file;
    if (typeof src.file_path === "string") return src.file_path;
  }
  return undefined;
}

const noop = (): void => undefined;

export function App() {
  const ready = useAuthStore((s) => s.ready);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const logout = useAuthStore((s) => s.logout);

  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => !s.loading);
  const loadProjects = useProjectStore((s) => s.load);
  const active = useActiveProject();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Files pane visibility persists across reloads — opening it once is
  // a strong signal the user wants it. localStorage > a session-scoped
  // boolean so a refresh doesn't snap back to "hidden".
  const [filesOpen, setFilesOpen] = useState<boolean>(
    () => localStorage.getItem("pi-workbench/files-open") === "true",
  );
  const setFilesOpenPersisted = (v: boolean): void => {
    setFilesOpen(v);
    localStorage.setItem("pi-workbench/files-open", v ? "true" : "false");
  };

  const [rightTab, setRightTab] = useState<RightPaneTab>(() => {
    const raw = localStorage.getItem("pi-workbench/right-tab");
    return raw === "files" ||
      raw === "search" ||
      raw === "changes" ||
      raw === "git" ||
      raw === "context"
      ? raw
      : "files";
  });
  const setRightTabPersisted = (next: RightPaneTab): void => {
    setRightTab(next);
    localStorage.setItem("pi-workbench/right-tab", next);
  };

  const [terminalOpen, setTerminalOpen] = useState<boolean>(
    () => localStorage.getItem("pi-workbench/terminal-open") === "true",
  );
  const setTerminalOpenPersisted = (v: boolean): void => {
    setTerminalOpen(v);
    localStorage.setItem("pi-workbench/terminal-open", v ? "true" : "false");
  };
  const [terminalHeight, setTerminalHeight] = useState<number>(() =>
    readPersistedWidth(TERMINAL_HEIGHT_KEY, DEFAULT_TERMINAL_HEIGHT),
  );
  const terminalHeightRef = useRef(terminalHeight);
  useEffect(() => {
    terminalHeightRef.current = terminalHeight;
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
  }, [terminalHeight]);

  // Pane widths (px). Persisted on every drag-end via the ref; we keep
  // the live value in state so drags re-render the layout, and mirror
  // it through the ref so the divider can read the start width without
  // a stale-closure bug across drags.
  const [filesWidth, setFilesWidth] = useState<number>(() =>
    readPersistedWidth(FILES_WIDTH_KEY, DEFAULT_FILES_WIDTH),
  );
  const [editorWidth, setEditorWidth] = useState<number>(() =>
    readPersistedWidth(EDITOR_WIDTH_KEY, DEFAULT_EDITOR_WIDTH),
  );
  const filesWidthRef = useRef(filesWidth);
  const editorWidthRef = useRef(editorWidth);
  useEffect(() => {
    filesWidthRef.current = filesWidth;
    localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth));
  }, [filesWidth]);
  useEffect(() => {
    editorWidthRef.current = editorWidth;
    localStorage.setItem(EDITOR_WIDTH_KEY, String(editorWidth));
  }, [editorWidth]);

  const openFilesCount = useFileStore((s) => s.openFiles.length);
  const editorVisible = filesOpen && openFilesCount > 0;

  // Drives the modified-file count badge on the Git tab. Polls every
  // 5s via the hook regardless of which tab is currently visible —
  // we want the badge to update even when the user is on Files.
  const gitStatus = useGitStatus(active?.id);
  const gitChangedCount = gitStatus.status?.files.length ?? 0;

  // Refresh the file tree on every agent_end the active project hears,
  // since the agent commonly writes/edits files mid-turn. The session
  // store bumps `agentEndCountBySession[id]` exactly once per agent_end,
  // so this effect fires once per turn — no false positives from
  // benign array-replacement refetches that would trip a length proxy.
  const agentEndCount = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.agentEndCountBySession[activeSessionId] ?? 0) : 0,
  );
  const isStreaming = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.streamingBySession[activeSessionId] ?? false) : false,
  );
  const loadFileTree = useFileStore((s) => s.loadTree);
  useEffect(() => {
    if (active === undefined || isStreaming) return;
    void loadFileTree(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, isStreaming, agentEndCount]);

  // Agent file-change awareness for open editor tabs. Walks NEW
  // tool_result messages since we last looked, finds write/edit
  // results, and either silently reloads the file (clean tab) or
  // surfaces an "external change" banner (dirty tab). The
  // last-processed pointer is keyed by sessionId — switching sessions
  // restarts the cursor from the end of that session's history so we
  // don't re-fire reloads for messages already on screen.
  const lastProcessedRef = useRef<Record<string, number>>({});
  const sessionMessages = useSessionStore((s) =>
    activeSessionId !== undefined ? s.messagesBySession[activeSessionId] : undefined,
  );
  useEffect(() => {
    if (active === undefined || activeSessionId === undefined || sessionMessages === undefined) {
      return;
    }
    const lastSeen = lastProcessedRef.current[activeSessionId] ?? sessionMessages.length;
    // First time we see this session: skip the existing history,
    // start watching from the next change forward.
    if (lastProcessedRef.current[activeSessionId] === undefined) {
      lastProcessedRef.current[activeSessionId] = sessionMessages.length;
      return;
    }
    if (sessionMessages.length <= lastSeen) {
      lastProcessedRef.current[activeSessionId] = sessionMessages.length;
      return;
    }
    const fileStore = useFileStore.getState();
    const openByPath = new Map(fileStore.openFiles.map((f) => [f.path, f]));
    for (let i = lastSeen; i < sessionMessages.length; i++) {
      const m = sessionMessages[i];
      if (m === undefined) continue;
      if (m.role !== "toolResult") continue;
      const toolName = String(m.toolName ?? "");
      if (toolName !== "write" && toolName !== "edit") continue;
      const path = extractToolFilePath(m);
      if (path === undefined) continue;
      const open = openByPath.get(path);
      if (open === undefined) continue;
      if (open.dirty) {
        fileStore.markExternallyChanged(path);
      } else {
        void fileStore.reloadFile(active.id, path);
      }
    }
    lastProcessedRef.current[activeSessionId] = sessionMessages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeSessionId, sessionMessages]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // ui-config has no auth requirement and gates which surfaces
  // we render — load it in parallel with auth bootstrap so the
  // first render after login already knows whether we're in
  // minimal mode (avoids a flash of full-UI elements that then
  // disappear).
  const loadUiConfig = useUiConfigStore((s) => s.load);
  const minimal = useUiConfigStore((s) => s.minimal);
  useEffect(() => {
    void loadUiConfig();
  }, [loadUiConfig]);

  useEffect(() => {
    if (isAuthenticated) void loadProjects();
  }, [isAuthenticated, loadProjects]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-neutral-400">
        Loading…
      </main>
    );
  }

  if (!isAuthenticated) return <LoginScreen />;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-3">
          {/* Header brand: same SVG as the favicon / PWA icon, served
              from /icons/icon.svg via the public dir. The inner gap-1.5
              keeps the logo + wordmark visually paired (tighter than
              the parent gap-3 used between brand and project picker). */}
          <div className="flex items-center gap-1.5">
            <img src="/icons/icon.svg" alt="" className="h-8 w-8" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-tight">pi-workbench</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilesOpenPersisted(!filesOpen)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
              filesOpen
                ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
            }`}
            title="Toggle the file browser + editor pane"
          >
            <FolderTree size={13} />
            Files
          </button>
          {!minimal && (
            <button
              onClick={() => setTerminalOpenPersisted(!terminalOpen)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                terminalOpen
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
              title="Toggle the integrated terminal"
            >
              <TerminalIcon size={13} />
              Terminal
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
            title="Settings (providers, agent defaults, skills)"
          >
            Settings
          </button>
          <button
            onClick={logout}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
          >
            Sign out
          </button>
        </div>
      </header>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <ProjectSidebar />
          <main className="flex flex-1 overflow-hidden">
            {/* Layout when files pane is open:
                  chat (flex) | divider | editor (when ≥1 tab) | divider | files
              The file browser is pinned to the far right; the editor
              materialises between chat and files only when at least
              one file is open. Both right-side panes are user-resizable
              via their dividers; widths persist in localStorage. */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {projectsLoaded && projects.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <ProjectPicker required onClose={noop} />
                </div>
              ) : activeSessionId !== undefined ? (
                <>
                  <ChatView sessionId={activeSessionId} />
                  {!minimal && (
                    <ChangedFilesBadge
                      sessionId={activeSessionId}
                      alreadyOnChangesTab={filesOpen && rightTab === "changes"}
                      onOpen={() => {
                        if (!filesOpen) setFilesOpenPersisted(true);
                        setRightTabPersisted("changes");
                      }}
                    />
                  )}
                  <ChatInput sessionId={activeSessionId} />
                </>
              ) : active ? (
                <div className="flex flex-1 items-center justify-center px-6 text-center">
                  <div className="space-y-2 text-sm text-neutral-400">
                    <h2 className="text-xl font-semibold text-neutral-100">{active.name}</h2>
                    <p className="font-mono text-xs">{active.path}</p>
                    <p>Pick a session from the sidebar — or click "+ New session" to start one.</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-sm text-neutral-400">Select a project from the sidebar.</p>
                </div>
              )}
            </div>

            {filesOpen && editorVisible && (
              <>
                <ResizableDivider
                  getStartSize={() => editorWidthRef.current}
                  onResize={(next) => setEditorWidth(next)}
                  /* Pane is to the RIGHT of the divider, so drag-right
                   shrinks the editor. direction: -1 → grow as user drags left. */
                  direction={-1}
                  minSize={MIN_EDITOR_WIDTH}
                  maxSize={Math.max(
                    MIN_EDITOR_WIDTH,
                    window.innerWidth - filesWidth - MIN_CHAT_WIDTH - 240, // 240 ≈ ProjectSidebar
                  )}
                />
                <div
                  className="flex shrink-0 flex-col border-l border-neutral-800"
                  style={{ width: `${editorWidth}px` }}
                >
                  <EditorPanel />
                </div>
              </>
            )}

            {filesOpen && (
              <>
                <ResizableDivider
                  getStartSize={() => filesWidthRef.current}
                  onResize={(next) => setFilesWidth(next)}
                  direction={-1}
                  minSize={MIN_FILES_WIDTH}
                  maxSize={Math.max(
                    MIN_FILES_WIDTH,
                    window.innerWidth -
                      MIN_CHAT_WIDTH -
                      240 -
                      (editorVisible ? MIN_EDITOR_WIDTH : 0),
                  )}
                />
                <div
                  className="flex shrink-0 flex-col border-l border-neutral-800"
                  style={{ width: `${filesWidth}px` }}
                >
                  {/* Right-pane tabs: file browser vs the turn-diff
                      "Changes" view. Both share width + position so
                      they don't compete for screen real estate. */}
                  <div className="flex border-b border-neutral-800 bg-neutral-900/40">
                    {(minimal
                      ? (["files", "search"] as const)
                      : (["files", "search", "changes", "git", "context"] as const)
                    ).map((t) => (
                      <button
                        key={t}
                        onClick={() => setRightTabPersisted(t)}
                        className={`flex items-center gap-1 px-3 py-1.5 text-[11px] uppercase tracking-wider ${
                          rightTab === t
                            ? "border-b border-neutral-100 text-neutral-100"
                            : "text-neutral-500 hover:text-neutral-300"
                        }`}
                      >
                        {/* Internal key stays "changes" for backwards-compat with
                            persisted localStorage; user-visible label is "Last turn"
                            so it's distinct from the Git tab's working-tree changes. */}
                        {t === "files"
                          ? "Files"
                          : t === "search"
                            ? "Search"
                            : t === "changes"
                              ? "Last turn"
                              : t === "git"
                                ? "Git"
                                : "Context"}
                        {t === "git" && gitChangedCount > 0 && (
                          <span className="rounded bg-amber-900/40 px-1 py-0.5 text-[9px] text-amber-300">
                            {gitChangedCount}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {rightTab === "files" ? (
                      <FileBrowserPanel />
                    ) : rightTab === "search" ? (
                      <SearchPanel />
                    ) : !minimal && rightTab === "changes" ? (
                      <TurnDiffPanel />
                    ) : !minimal && rightTab === "git" ? (
                      <GitPanel />
                    ) : !minimal && rightTab === "context" ? (
                      <ContextInspectorPanel />
                    ) : (
                      // minimal mode: stale persisted "changes"/"git"/"context"
                      // falls back to the file browser rather than rendering
                      // a tab the user can't even see.
                      <FileBrowserPanel />
                    )}
                  </div>
                </div>
              </>
            )}
          </main>
        </div>

        {!minimal && terminalOpen && (
          <>
            <ResizableDivider
              orientation="horizontal"
              getStartSize={() => terminalHeightRef.current}
              onResize={(next) => setTerminalHeight(next)}
              direction={-1}
              minSize={MIN_TERMINAL_HEIGHT}
              maxSize={Math.max(MIN_TERMINAL_HEIGHT, Math.floor(window.innerHeight * 0.7))}
            />
            <div
              className="shrink-0 border-t border-neutral-800"
              style={{ height: `${terminalHeight}px` }}
            >
              <TerminalPanel />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
