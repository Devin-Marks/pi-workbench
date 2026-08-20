const RAW_BASE = import.meta.env?.BASE_URL ?? "/";

/**
 * Vite exposes the deployment base as import.meta.env.BASE_URL. In the
 * dashboard iframe deployment this is something like `/apps/pi-forge/`; in
 * normal local/dev deployments it is `/`. Keep URL construction centralized so
 * API, SSE, WebSocket, docs, and download URLs all honor the same prefix.
 */
export const appBasePath = RAW_BASE.endsWith("/") ? RAW_BASE.slice(0, -1) : RAW_BASE;

export function appUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${appBasePath}${suffix}`;
}

export function appResourceUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  // Leave absolute and browser-native resource URLs alone. Prefix only
  // origin-root-relative server URLs such as /cache/logos/... so they stay
  // inside a path-proxied deployment like /apps/pi-forge/.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
  if (url.startsWith("/")) return appUrl(url);
  return url;
}
