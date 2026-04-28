import { useEffect, useRef } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalStore, type TerminalTab } from "../store/terminal-store";
import { useActiveProject } from "../store/project-store";
import { getStoredToken } from "../lib/auth-client";

/**
 * Per-tab DOM/WebSocket/xterm bag. Lives OUTSIDE React state because
 * the WebSocket + xterm.Terminal are imperative resources whose
 * lifetimes we want decoupled from React renders. The Map is keyed
 * by tab id; entries are created when a tab first attaches its
 * `<div>` host and torn down when the tab closes.
 */
interface Live {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  /** ResizeObserver watching the host div; fires `fit.fit()` and a server resize. */
  observer: ResizeObserver;
  /** Latest cols/rows we sent to the server, used to elide redundant resize messages. */
  lastSize: { cols: number; rows: number };
}

const live = new Map<string, Live>();

/**
 * Bottom-anchored terminal panel. Toggle from the header; tabs persist
 * across toggles (the WebSocket + PTY keep running on the server). On
 * project switch, every tab tied to the previous project is closed
 * (so we don't leak shells in directories the user can no longer reach
 * via the picker).
 */
export function TerminalPanel() {
  const project = useActiveProject();
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const closeProjectTabs = useTerminalStore((s) => s.closeProjectTabs);
  const projectTabs = tabs.filter((t) => project !== undefined && t.projectId === project.id);
  const activeTab = projectTabs.find((t) => t.id === activeTabId) ?? projectTabs[0];

  // On project change, prune tabs from OTHER projects: their PTYs
  // were spawned in those projects' cwds, and showing them under a
  // different project header would be misleading. We tear down the
  // imperative resources here, then call the store helper for each
  // stale projectId to clear the registry.
  useEffect(() => {
    if (project === undefined) return;
    const stale = new Set<string>();
    for (const t of tabs) {
      if (t.projectId !== project.id) {
        teardown(t.id);
        stale.add(t.projectId);
      }
    }
    for (const pid of stale) closeProjectTabs(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-neutral-500">
        Select a project to open a terminal.
      </div>
    );
  }

  const onNewTab = (): void => {
    openTab(project.id);
  };

  const onCloseTab = (id: string): void => {
    teardown(id);
    closeTab(id);
  };

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-2 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          {projectTabs.length === 0 && (
            <span className="px-2 text-[11px] italic text-neutral-500">No terminals open.</span>
          )}
          {projectTabs.map((t) => {
            const isActive = t.id === activeTab?.id;
            return (
              <div
                key={t.id}
                className={`group flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                  isActive
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <button onClick={() => setActiveTab(t.id)} className="flex items-center gap-1">
                  <TerminalIcon size={11} />
                  {t.label}
                </button>
                <button
                  onClick={() => onCloseTab(t.id)}
                  className="rounded p-0.5 text-neutral-600 opacity-0 hover:bg-neutral-800 hover:text-neutral-200 group-hover:opacity-100"
                  title="Close terminal (kills the PTY)"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
          <button
            onClick={onNewTab}
            className="ml-1 flex items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            title="New terminal"
          >
            <Plus size={11} />
            New
          </button>
        </div>
      </div>

      {/* xterm hosts. We render ALL tabs at once (one host per id) and
          toggle visibility — that way switching tabs doesn't tear down
          the WebSocket or lose scrollback. The host is also where the
          ResizeObserver lives, which calls fit() on container changes. */}
      <div className="relative flex-1 overflow-hidden">
        {projectTabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs italic text-neutral-500">
            Click "New" to open a terminal in {project.path}.
          </div>
        )}
        {projectTabs.map((t) => (
          <TerminalHost
            key={t.id}
            tab={t}
            projectPath={project.path}
            visible={t.id === activeTab?.id}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalHost({
  tab,
  projectPath,
  visible,
}: {
  tab: TerminalTab;
  projectPath: string;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hostRef.current === null) return undefined;
    if (live.has(tab.id)) return undefined; // already attached

    const term = new Terminal({
      // Inherit the app's neutral-950 background; xterm's default
      // black is too contrasty against the rest of the dark theme.
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        black: "#262626",
        brightBlack: "#525252",
        // Default ANSI palette — xterm fills the rest if we don't
        // override.
      },
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      // SCROLLBACK: 5000 lines is enough for `npm install` output;
      // memory cost ~few MB.
      scrollback: 5000,
      // Wrap long lines visually (default true).
      convertEol: false,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(hostRef.current);
    fit.fit();

    // Build the WS URL with the auth token in the query (browsers
    // can't attach Authorization headers to `new WebSocket(url)`).
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const stored = getStoredToken();
    const tokenQs = stored !== undefined ? `&token=${encodeURIComponent(stored.token)}` : "";
    const url = `${proto}://${window.location.host}/api/v1/terminal?projectId=${encodeURIComponent(tab.projectId)}${tokenQs}`;
    const ws = new WebSocket(url);

    ws.binaryType = "arraybuffer";
    const initialSize = { cols: term.cols, rows: term.rows };

    ws.onopen = () => {
      // Send the initial size so the shell formats correctly out of
      // the gate. Without this the shell defaults to 80x24 even when
      // the host is much wider.
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (e) => {
      // The server sends text frames for stdout. xterm's `write`
      // accepts strings or Uint8Array; we hit both branches because
      // some browsers deliver text frames as ArrayBuffer when
      // binaryType is "arraybuffer".
      if (typeof e.data === "string") term.write(e.data);
      else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      term.write(`\r\n[connection closed: ${String(e.code)}]\r\n`);
    };

    // Keystrokes → server. xterm.onData fires for every key including
    // Ctrl+C, paste, etc. with the correctly-encoded byte sequence.
    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Container resize → fit + send resize message. ResizeObserver
    // is throttled by the browser so we don't need to debounce
    // ourselves.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // fit can throw if the host is detached momentarily during
        // tab toggles; harmless.
      }
      const cols = term.cols;
      const rows = term.rows;
      const last = live.get(tab.id)?.lastSize;
      if (
        ws.readyState === WebSocket.OPEN &&
        (last === undefined || cols !== last.cols || rows !== last.rows)
      ) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
        const entry = live.get(tab.id);
        if (entry !== undefined) entry.lastSize = { cols, rows };
      }
    });
    observer.observe(hostRef.current);

    live.set(tab.id, { term, fit, ws, observer, lastSize: initialSize });

    return () => {
      dataDisposable.dispose();
      // We do NOT teardown on unmount-from-render-toggle — the host
      // div re-mounts when the panel re-opens, and we want to keep
      // the WS alive. Teardown is explicit (closeTab) via the
      // module-level `teardown()` helper.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // When the tab becomes visible, force a fit() — the xterm
  // dimensions are stale because the host was display:none.
  useEffect(() => {
    if (!visible) return;
    const entry = live.get(tab.id);
    if (entry === undefined) return;
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        entry.term.focus();
      } catch {
        // see ResizeObserver comment
      }
    });
  }, [visible, tab.id]);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0"
      style={{ display: visible ? "block" : "none" }}
      title={projectPath}
    />
  );
}

/**
 * Tear down a tab's WebSocket + xterm + observer. Called on tab
 * close and on project switch (to release shells from the previous
 * project's cwd). Server kills the PTY when the WS closes.
 */
function teardown(id: string): void {
  const entry = live.get(id);
  if (entry === undefined) return;
  live.delete(id);
  try {
    entry.observer.disconnect();
  } catch {
    // ignore
  }
  try {
    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      entry.ws.close(1000, "tab_closed");
    }
  } catch {
    // ignore
  }
  try {
    entry.term.dispose();
  } catch {
    // ignore
  }
}
