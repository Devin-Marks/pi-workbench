import { create } from "zustand";
import { api, ApiError, onUnauthorized } from "../lib/api-client";
import { clearStoredToken, getStoredToken, setStoredToken } from "../lib/auth-client";

interface AuthState {
  /** Has the bootstrap call to /auth/status finished? */
  ready: boolean;
  /** True when the server reports auth is required. */
  authRequired: boolean;
  /** True when we have a valid stored token (or auth is not required). */
  isAuthenticated: boolean;
  /**
   * True when the current token was issued via the env-supplied
   * UI_PASSWORD and the server requires the user to set a new
   * password before any other API call will succeed. The App-level
   * gate routes to the change-password screen when this is true.
   */
  mustChangePassword: boolean;
  loginError: string | undefined;
  loginPending: boolean;
  changePasswordError: string | undefined;
  changePasswordPending: boolean;
  bootstrap: () => Promise<void>;
  login: (password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ready: false,
  authRequired: false,
  isAuthenticated: false,
  mustChangePassword: false,
  loginError: undefined,
  loginPending: false,
  changePasswordError: undefined,
  changePasswordPending: false,
  bootstrap: async () => {
    try {
      const { authEnabled } = await api.authStatus();
      if (!authEnabled) {
        set({
          ready: true,
          authRequired: false,
          isAuthenticated: true,
          mustChangePassword: false,
        });
        return;
      }
      const stored = getStoredToken();
      set({
        ready: true,
        authRequired: true,
        isAuthenticated: stored !== undefined,
        mustChangePassword: stored?.mustChangePassword ?? false,
      });
    } catch (err) {
      set({
        ready: true,
        authRequired: true,
        isAuthenticated: false,
        mustChangePassword: false,
        loginError: err instanceof Error ? err.message : "bootstrap_failed",
      });
    }
  },
  login: async (password: string) => {
    if (get().loginPending) return;
    set({ loginPending: true, loginError: undefined });
    try {
      const res = await api.login(password);
      setStoredToken({
        token: res.token,
        expiresAt: res.expiresAt,
        mustChangePassword: res.mustChangePassword,
      });
      set({
        isAuthenticated: true,
        mustChangePassword: res.mustChangePassword,
        loginPending: false,
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "login_failed";
      set({ loginPending: false, loginError: code });
    }
  },
  changePassword: async (currentPassword: string, newPassword: string) => {
    if (get().changePasswordPending) return;
    set({ changePasswordPending: true, changePasswordError: undefined });
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      setStoredToken({
        token: res.token,
        expiresAt: res.expiresAt,
        mustChangePassword: res.mustChangePassword,
      });
      set({
        isAuthenticated: true,
        mustChangePassword: res.mustChangePassword,
        changePasswordPending: false,
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "change_password_failed";
      set({ changePasswordPending: false, changePasswordError: code });
    }
  },
  logout: () => {
    clearStoredToken();
    set({ isAuthenticated: false, mustChangePassword: false, loginError: undefined });
  },
}));

// Module-level (not per-store-construction) so HMR re-evaluating the store
// factory doesn't accumulate listeners. Vite HMR will replace the entire
// module on edit, so this fires exactly once per module instantiation.
//
// HMR correctness: when this module is hot-reloaded, the previously-registered
// listener still references the orphaned `useAuthStore` from the previous
// evaluation. import.meta.hot.dispose clears the flag and unregisters the old
// listener so the next evaluation registers against the new store.
declare global {
  var __piWorkbenchAuthListenerRegistered: boolean | undefined;
  var __piWorkbenchAuthListenerCleanup: (() => void) | undefined;
}
if (!globalThis.__piWorkbenchAuthListenerRegistered) {
  globalThis.__piWorkbenchAuthListenerCleanup = onUnauthorized(() =>
    useAuthStore.setState({ isAuthenticated: false }),
  );
  globalThis.__piWorkbenchAuthListenerRegistered = true;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (globalThis.__piWorkbenchAuthListenerCleanup) {
      globalThis.__piWorkbenchAuthListenerCleanup();
    }
    globalThis.__piWorkbenchAuthListenerRegistered = false;
    globalThis.__piWorkbenchAuthListenerCleanup = undefined;
  });
}
