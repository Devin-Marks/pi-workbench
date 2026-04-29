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
  /** Number of consecutive reconnect attempts; reset to 0 on a successful open. */
  reconnectAttempt: number;
  /** Pending reconnect timeout, cleared on success or teardown. */
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the tab is being torn down — prevents the close handler from scheduling a reconnect. */
  disposed: boolean;
}

const live = new Map<string, Live>();

/**
 * Mirrors the SSE backoff in `streamSSE`: 1→2→4→8→16→30s then steady
 * at 30. The cap matches the SSE client so behavior is consistent
 * across the two transport channels.
 */
function reconnectDelayMs(attempt: number): number {
  const seconds = [1, 2, 4, 8, 16, 30];
  return (seconds[Math.min(attempt, seconds.length - 1)] ?? 30) * 1000;
}

/**
 * Close codes the server emits for terminal failures we do NOT want
 * to retry on:
 *   - 4401: auth (token expired/invalid). Reconnect would just fail
 *     the same way; the user needs to log in again.
 *   - 4404: project not found. The project was deleted while the WS
 *     was live; reconnect can't recover it.
 *   - 1000 ("normal closure") issued by us in `teardown()`.
 * Anything else (1006 abnormal close from a network blip, 1011
 * server error, etc.) gets the backoff treatment.
 */
function isTerminalCloseCode(code: number): boolean {
  return code === 1000 || code === 4401 || code === 4404;
}

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

    const initialSize = { cols: term.cols, rows: term.rows };
    const ws = attachWebSocket(tab.id, tab.projectId, term, initialSize, /* isReconnect */ false);

    // Keystrokes → server. xterm.onData fires for every key including
    // Ctrl+C, paste, etc. with the correctly-encoded byte sequence.
    // Reads `live.get(tab.id)?.ws` each call so the listener picks up
    // the LATEST socket after a reconnect — without this, keystrokes
    // would silently dead-letter into the original (closed) WS object.
    const dataDisposable = term.onData((data) => {
      const sock = live.get(tab.id)?.ws;
      if (sock !== undefined && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Container resize → fit + send resize message. ResizeObserver
    // is throttled by the browser so we don't need to debounce
    // ourselves. Reads the current WS each call (post-reconnect-safe).
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // fit can throw if the host is detached momentarily during
        // tab toggles; harmless.
      }
      const cols = term.cols;
      const rows = term.rows;
      const entry = live.get(tab.id);
      if (entry === undefined) return;
      if (cols === entry.lastSize.cols && rows === entry.lastSize.rows) return;
      entry.lastSize = { cols, rows };
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    observer.observe(hostRef.current);

    live.set(tab.id, {
      term,
      fit,
      ws,
      observer,
      lastSize: initialSize,
      reconnectAttempt: 0,
      reconnectTimer: undefined,
      disposed: false,
    });

    // Reference the data listener so its handle survives remounts.
    // The early-return guard above (`if (live.has(tab.id))`) means
    // we don't re-attach on remount — so we MUST NOT dispose here
    // either, or HMR/parent-rerender would leave the WS open with
    // no keystroke listener and typing would silently break.
    // Cleanup is the responsibility of `teardown()` below, which
    // calls `term.dispose()` to remove every listener at once.
    void dataDisposable;
    return undefined;
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

  // Click-to-focus safety net. xterm normally handles its own focus
  // on click via its internal textarea, but the click can land on
  // empty space below the cursor (especially in a freshly-opened
  // shell with little output). Forwarding clicks to `term.focus()`
  // guarantees keystrokes go to the right place.
  const onHostClick = (): void => {
    live.get(tab.id)?.term.focus();
  };

  return (
    <div
      ref={hostRef}
      onClick={onHostClick}
      className="absolute inset-0"
      style={{ display: visible ? "block" : "none" }}
      title={projectPath}
    />
  );
}

/**
 * Open a WebSocket to the terminal route and wire up the message /
 * close handlers. Called both at first attach AND on every reconnect
 * — the second case bumps `reconnectAttempt` and replays the cached
 * cols/rows so the new shell formats correctly out of the gate.
 *
 * The new PTY spawned by the server on reconnect is a FRESH shell —
 * env vars, foreground processes, and any in-progress command from
 * the old shell are gone. xterm's client-side scrollback survives,
 * so the user still sees prior output, but they're effectively at a
 * brand-new prompt.
 */
function attachWebSocket(
  tabId: string,
  projectId: string,
  term: Terminal,
  size: { cols: number; rows: number },
  isReconnect: boolean,
): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const stored = getStoredToken();
  const tokenQs = stored !== undefined ? `&token=${encodeURIComponent(stored.token)}` : "";
  const url = `${proto}://${window.location.host}/api/v1/terminal?projectId=${encodeURIComponent(
    projectId,
  )}${tokenQs}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // Send the cached size so the shell formats correctly out of the
    // gate — both for first connect (pre-resize default of 80x24) and
    // reconnect (the new PTY spawns at server defaults until told).
    ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    if (isReconnect) {
      term.write("\r\n[reconnected — note: this is a new shell, prior state is gone]\r\n");
    }
    const entry = live.get(tabId);
    if (entry !== undefined) entry.reconnectAttempt = 0;
  };

  ws.onmessage = (e) => {
    if (typeof e.data === "string") term.write(e.data);
    else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
  };

  ws.onclose = (e) => {
    const entry = live.get(tabId);
    if (entry === undefined || entry.disposed) return;
    if (isTerminalCloseCode(e.code)) {
      // Custom messages for the specific terminal codes — without
      // these the user sees a bare numeric code with no clear path.
      let msg = `[connection closed: ${String(e.code)}]`;
      if (e.code === 4401) {
        msg =
          "[connection closed (4401): your session expired — refresh the page after logging back in]";
      } else if (e.code === 4404) {
        msg = "[connection closed (4404): project no longer exists]";
      }
      term.write(`\r\n${msg}\r\n`);
      return;
    }
    // Schedule a reconnect with exponential backoff. The keystroke +
    // resize listeners read live.get(tabId).ws each fire, so they'll
    // pick up the new socket transparently.
    const attempt = entry.reconnectAttempt + 1;
    entry.reconnectAttempt = attempt;
    const delay = reconnectDelayMs(attempt);
    term.write(
      `\r\n[connection lost (${String(e.code)}) — reconnecting in ${String(delay / 1000)}s, attempt ${String(attempt)}]\r\n`,
    );
    entry.reconnectTimer = setTimeout(() => {
      const cur = live.get(tabId);
      if (cur === undefined || cur.disposed) return;
      cur.reconnectTimer = undefined;
      cur.ws = attachWebSocket(tabId, projectId, term, cur.lastSize, /* isReconnect */ true);
    }, delay);
  };

  return ws;
}

/**
 * Tear down a tab's WebSocket + xterm + observer. Called on tab
 * close and on project switch (to release shells from the previous
 * project's cwd). Server kills the PTY when the WS closes.
 *
 * Marks the entry `disposed` BEFORE closing the WS so the close
 * handler short-circuits its reconnect schedule.
 */
function teardown(id: string): void {
  const entry = live.get(id);
  if (entry === undefined) return;
  entry.disposed = true;
  if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
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
