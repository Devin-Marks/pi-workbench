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
  loginError: string | undefined;
  loginPending: boolean;
  bootstrap: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => {
  onUnauthorized(() => set({ isAuthenticated: false }));
  return {
    ready: false,
    authRequired: false,
    isAuthenticated: false,
    loginError: undefined,
    loginPending: false,
    bootstrap: async () => {
      try {
        const { authEnabled } = await api.authStatus();
        if (!authEnabled) {
          set({ ready: true, authRequired: false, isAuthenticated: true });
          return;
        }
        const stored = getStoredToken();
        set({
          ready: true,
          authRequired: true,
          isAuthenticated: stored !== undefined,
        });
      } catch (err) {
        set({
          ready: true,
          authRequired: true,
          isAuthenticated: false,
          loginError: err instanceof Error ? err.message : "bootstrap_failed",
        });
      }
    },
    login: async (password: string) => {
      if (get().loginPending) return;
      set({ loginPending: true, loginError: undefined });
      try {
        const res = await api.login(password);
        setStoredToken({ token: res.token, expiresAt: res.expiresAt });
        set({ isAuthenticated: true, loginPending: false });
      } catch (err) {
        const code = err instanceof ApiError ? err.code : "login_failed";
        set({ loginPending: false, loginError: code });
      }
    },
    logout: () => {
      clearStoredToken();
      set({ isAuthenticated: false, loginError: undefined });
    },
  };
});
