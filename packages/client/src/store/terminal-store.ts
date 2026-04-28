import { create } from "zustand";

/**
 * Terminal-tab metadata. The actual `WebSocket` and `xterm.js` `Terminal`
 * instances live OUTSIDE the store — Zustand should track minimal,
 * serialisable state and not own DOM-attached resources. The
 * TerminalPanel component creates the WS + xterm pair when a tab
 * activates, keeps them in a module-level Map keyed by tab id, and
 * tears them down on close.
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

let counter = 0;
const newId = (): string => `term-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: [],
  activeTabId: undefined,

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
      return { tabs: [...s.tabs, tab], activeTabId: id };
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
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  closeProjectTabs: (projectId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.projectId !== projectId);
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id;
      return { tabs, activeTabId };
    });
  },
}));
