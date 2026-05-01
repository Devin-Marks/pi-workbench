import { create } from "zustand";

/**
 * Ephemeral client-side UI state shared across components that don't
 * have a direct parent/child relationship. Today this is just the
 * Settings-panel open-and-target-tab signal — the chat input's `/`
 * commands need to ask App.tsx to open Settings to a specific tab,
 * and the McpStatusBadge wants the same opening affordance. A
 * dedicated store keeps the contract narrow: every consumer reads
 * `settingsRequest` and clears it after handling.
 *
 * Distinct from `ui-config-store` (server-driven, MINIMAL_UI etc.)
 * and from `auth-store` (auth/session lifecycle). Future runtime UI
 * state belongs here too.
 */

export type SettingsTab = "providers" | "agent" | "mcp" | "skills" | "appearance";

interface SettingsRequest {
  /** Optional tab to switch to on open. Undefined = leave the
   *  panel's last tab alone. */
  tab?: SettingsTab;
  /** Monotonic counter so the SAME open-to-tab call can fire twice
   *  in a row. Without this, requesting the already-open tab would
   *  produce no state change and the panel listener wouldn't react.
   *  The listener tracks the last seen seq and reacts on any
   *  increment. */
  seq: number;
}

/** Cross-component request to append text into the active chat input.
 *  Today only `Add as @ context` from the file-browser context menu
 *  uses it; future quick-actions (slash commands from elsewhere, etc.)
 *  can ride the same channel. The chat input listens, appends on every
 *  seq increment, and calls `clearChatInsertRequest` to reset. */
interface ChatInsertRequest {
  /** Text to append; `@<path>` for the current consumer. */
  text: string;
  /** Monotonic counter so two consecutive requests with the same text
   *  still fire (matches the SettingsRequest seq pattern). */
  seq: number;
}

interface UiState {
  settingsRequest: SettingsRequest | undefined;
  /** Open the Settings panel; optionally jump to a specific tab. */
  openSettings: (tab?: SettingsTab) => void;
  clearSettingsRequest: () => void;
  chatInsertRequest: ChatInsertRequest | undefined;
  /** Ask the chat input to append text (no leading newline; the input
   *  decides spacing based on its current contents). */
  requestChatInsert: (text: string) => void;
  clearChatInsertRequest: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  settingsRequest: undefined,
  openSettings: (tab) => {
    const prev = get().settingsRequest?.seq ?? 0;
    const req: SettingsRequest = { seq: prev + 1 };
    if (tab !== undefined) req.tab = tab;
    set({ settingsRequest: req });
  },
  clearSettingsRequest: () => {
    set({ settingsRequest: undefined });
  },
  chatInsertRequest: undefined,
  requestChatInsert: (text) => {
    const prev = get().chatInsertRequest?.seq ?? 0;
    set({ chatInsertRequest: { text, seq: prev + 1 } });
  },
  clearChatInsertRequest: () => {
    set({ chatInsertRequest: undefined });
  },
}));
