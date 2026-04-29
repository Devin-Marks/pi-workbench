import { create } from "zustand";

/**
 * Terminal-tab metadata. The actual `WebSocket` and `xterm.js` `Terminal`
 * instances live OUTSIDE the store — Zustand should track minimal,
 * serialisable state and not own DOM-attached resources. The
 * TerminalPanel component creates the WS + xterm pair when a tab
 * activates, keeps them in a module-level Map keyed by tab id, and
 * tears them down on close.
 *
 * The tab list IS persisted to localStorage so a page reload doesn't
 * silently lose every open terminal. On reload, TerminalPanel
 * re-attaches a fresh PTY for each persisted tab — the server-side
 * shell from the prior session is gone (the WS close from page
 * unload reaped it), so the user sees a clean prompt under the same
 * tab label. Scrollback / in-progress shell state DOES NOT survive
 * (same constraint as Trm1's reconnect path).
 */
export interface TerminalTab {
  id: string;
  /** Project this tab spawned its PTY in. */
  projectId: string;
  /** User-visible tab label; defaults to "Terminal N". */
  label: string;
  /** Wall-clock open time, used to render a relative "opened 5s ago" label later. */
  createdAt: number;
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | undefined;

  openTab: (projectId: string) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | undefined) => void;
  /** Drop every tab tied to the given project — used on project switch. */
  closeProjectTabs: (projectId: string) => void;
}

export const EMPTY_TABS: TerminalTab[] = [];

const STORAGE_KEY = "pi.terminal.tabs.v1";

interface PersistedShape {
  tabs: TerminalTab[];
  activeTabId: string | undefined;
}

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { tabs: [], activeTabId: undefined };
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { tabs?: unknown }).tabs)
    ) {
      return { tabs: [], activeTabId: undefined };
    }
    const tabs: TerminalTab[] = [];
    for (const t of (parsed as { tabs: unknown[] }).tabs) {
      if (
        typeof t === "object" &&
        t !== null &&
        typeof (t as TerminalTab).id === "string" &&
        typeof (t as TerminalTab).projectId === "string" &&
        typeof (t as TerminalTab).label === "string" &&
        typeof (t as TerminalTab).createdAt === "number"
      ) {
        tabs.push(t as TerminalTab);
      }
    }
    const activeRaw = (parsed as { activeTabId?: unknown }).activeTabId;
    const activeTabId = typeof activeRaw === "string" ? activeRaw : undefined;
    return {
      tabs,
      // Drop a stale activeTabId pointing at a tab that didn't pass
      // validation above.
      activeTabId: tabs.some((t) => t.id === activeTabId) ? activeTabId : tabs[0]?.id,
    };
  } catch {
    // private-mode storage failure or malformed JSON — start clean
    return { tabs: [], activeTabId: undefined };
  }
}

function writePersisted(state: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore — choice still applies for this tab session
  }
}

let counter = 0;
const newId = (): string => `term-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const initial = readPersisted();

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,

  openTab: (projectId) => {
    const id = newId();
    set((s) => {
      // Number the new tab sequentially within the project.
      const projectTabs = s.tabs.filter((t) => t.projectId === projectId);
      const tab: TerminalTab = {
        id,
        projectId,
        label: `Terminal ${projectTabs.length + 1}`,
        createdAt: Date.now(),
      };
      const next = { tabs: [...s.tabs, tab], activeTabId: id };
      writePersisted(next);
      return next;
    });
    return id;
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.tabs.slice(0, idx).concat(s.tabs.slice(idx + 1));
      // If we closed the active tab, prefer the tab that took its
      // place (the next one to the right); fall back to the new last.
      const activeTabId =
        s.activeTabId === id ? (tabs[idx] ?? tabs[idx - 1] ?? tabs[0])?.id : s.activeTabId;
      const next = { tabs, activeTabId };
      writePersisted(next);
      return next;
    });
  },

  setActiveTab: (id) =>
    set((s) => {
      const next = { ...s, activeTabId: id };
      writePersisted({ tabs: next.tabs, activeTabId: id });
      return { activeTabId: id };
    }),

  closeProjectTabs: (projectId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.projectId !== projectId);
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id;
      const next = { tabs, activeTabId };
      writePersisted(next);
      return next;
    });
  },
}));
