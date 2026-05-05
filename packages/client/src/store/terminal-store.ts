import { create } from "zustand";

/**
 * Terminal-tab metadata. The actual `WebSocket` and `xterm.js` `Terminal`
 * instances live OUTSIDE the store — Zustand should track minimal,
 * serialisable state and not own DOM-attached resources. The
 * TerminalPanel component creates the WS + xterm pair when a tab
 * activates, keeps them in a module-level Map keyed by tab id, and
 * tears them down on close.
 *
 * The tab list IS persisted to **sessionStorage** (per browser tab).
 * Combined with the server's reattach-by-tabId path (see
 * pty-manager.ts), a page reload reattaches each tab to its existing
 * PTY and replays a rolling output buffer — the user is back in the
 * SAME shell, not a fresh one. After IDLE_REAP_MS (10 min) of no
 * attached socket the server kills the PTY, at which point the next
 * reconnect silently spawns a fresh shell under the same tab label.
 *
 * sessionStorage (NOT localStorage) is intentional. The server's
 * pty-manager allows ONE active socket per tabId at a time — a
 * second connect with the same tabId boots the first. Sharing the
 * tab list across browser tabs (the localStorage behavior we used
 * to have) meant tabs A and B reused the same tabIds, fought over
 * the same PTY, and flap-disconnected each other in a loop just by
 * being open. sessionStorage scopes the list per browser tab:
 * survives in-tab reload, doesn't bleed into a sibling tab. Closing
 * the browser tab loses the list — fine, the PTYs themselves get
 * idle-reaped on the server within 10 min.
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

const STORAGE_KEY = "forge.terminal.tabs.v1";

interface PersistedShape {
  tabs: TerminalTab[];
  activeTabId: string | undefined;
}

function readPersisted(): PersistedShape {
  try {
    // Migrate any leftover localStorage entry from versions of the
    // app that used it. One-shot copy + delete on first read so a
    // user with terminals open at update time doesn't lose them on
    // the first reload after the upgrade. Only happens once per
    // browser tab (after copy, sessionStorage owns the value).
    const sessionRaw = sessionStorage.getItem(STORAGE_KEY);
    if (sessionRaw === null) {
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy !== null) {
        sessionStorage.setItem(STORAGE_KEY, legacy);
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    const raw = sessionStorage.getItem(STORAGE_KEY);
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
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
