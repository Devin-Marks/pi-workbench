const TOKEN_KEY = "pi-workbench/auth-token";
const EXPIRES_KEY = "pi-workbench/auth-expires-at";

export interface StoredToken {
  token: string;
  expiresAt: string;
}

export function getStoredToken(): StoredToken | undefined {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiresAt = localStorage.getItem(EXPIRES_KEY);
  if (!token || !expiresAt) return undefined;
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearStoredToken();
    return undefined;
  }
  return { token, expiresAt };
}

export function setStoredToken(t: StoredToken): void {
  localStorage.setItem(TOKEN_KEY, t.token);
  localStorage.setItem(EXPIRES_KEY, t.expiresAt);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}
