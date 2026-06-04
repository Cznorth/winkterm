/**
 * Runtime backend URL for native (Capacitor) builds.
 *
 * In a packaged Android/iOS app the page origin is `https://localhost`, which
 * has no backend. The user picks a remote WinkTerm backend at runtime; its base
 * URL is persisted here and consumed by `config.ts` (HTTP/WS/VNC resolvers).
 *
 * Empty on desktop/web/dev — those keep their existing same-origin / baked-env
 * resolution.
 */

const BACKEND_URL_STORAGE = "winkterm-backend-url";

/** True when running inside a Capacitor native shell. */
export function isNativeApp(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as Window & { Capacitor?: unknown }).Capacitor
  );
}

/** Stored remote backend base URL (e.g. `https://host:8000`); "" if unset. */
export function getBackendUrl(): string {
  if (typeof window === "undefined") return "";
  return (localStorage.getItem(BACKEND_URL_STORAGE) || "").replace(/\/+$/, "");
}

export function setBackendUrl(url: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BACKEND_URL_STORAGE, url.trim().replace(/\/+$/, ""));
}

export function clearBackendUrl(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(BACKEND_URL_STORAGE);
}
