/**
 * Local storage for the web remote access key.
 *
 * Desktop clients come from localhost; the backend skips auth, so an empty key is fine.
 * For remote browser access, the key is sent via HTTP headers / WebSocket query params.
 */

const ACCESS_KEY_STORAGE = "winkterm-access-key";

export function getAccessKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(ACCESS_KEY_STORAGE) || "";
}

export function setAccessKey(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACCESS_KEY_STORAGE, key);
}

export function clearAccessKey(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACCESS_KEY_STORAGE);
}
