const TOKEN_KEY = "pi-workbench/auth-token";
const EXPIRES_KEY = "pi-workbench/auth-expires-at";
const MUST_CHANGE_KEY = "pi-workbench/auth-must-change-password";

export interface StoredToken {
  token: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

export function getStoredToken(): StoredToken | undefined {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiresAt = localStorage.getItem(EXPIRES_KEY);
  if (!token || !expiresAt) return undefined;
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearStoredToken();
    return undefined;
  }
  // Defaults to false for tokens issued before this flag existed —
  // existing sessions don't get force-rerouted to the change-password
  // screen on the next page load.
  const mustChangePassword = localStorage.getItem(MUST_CHANGE_KEY) === "true";
  return { token, expiresAt, mustChangePassword };
}

export function setStoredToken(t: StoredToken): void {
  localStorage.setItem(TOKEN_KEY, t.token);
  localStorage.setItem(EXPIRES_KEY, t.expiresAt);
  localStorage.setItem(MUST_CHANGE_KEY, t.mustChangePassword ? "true" : "false");
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(MUST_CHANGE_KEY);
}
