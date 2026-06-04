/**
 * Resolve API/WebSocket base URLs dynamically.
 *
 * Dev (Next on :3000): point at backend :8000 via env vars.
 * Desktop/same-origin deploy: same host:port as the page (desktop port assigned by pywebview).
 */

import { getBackendUrl } from "./backend";

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** Convert an http(s) backend base URL to its ws(s) equivalent. */
function toWsBase(httpBase: string): string {
  return httpBase.replace(/^http/, "ws");
}

function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "pywebview" in window &&
    !!(window as Window & { pywebview?: unknown }).pywebview
  );
}

/** Dev mode: Next runs on 3000; API lives on another port from env vars */
function isNextDevServer(): boolean {
  return typeof window !== "undefined" && window.location.port === "3000";
}

/**
 * Page and NEXT_PUBLIC_* share host but differ in port (typical: desktop 127.0.0.1:8001 + build-time :8000)
 */
function bakedApiConflictsWithPageOrigin(baked: string): boolean {
  if (typeof window === "undefined" || isNextDevServer()) {
    return false;
  }
  try {
    const target = new URL(baked.replace(/^wss?:/, "http"));
    const page = window.location;
    const pageHost = page.hostname;
    if (pageHost !== "127.0.0.1" && pageHost !== "localhost") {
      return false;
    }
    const hostsMatch =
      target.hostname === pageHost ||
      (target.hostname === "localhost" && pageHost === "127.0.0.1") ||
      (target.hostname === "127.0.0.1" && pageHost === "localhost");
    const targetPort = target.port || defaultPort(target.protocol);
    const pagePort = page.port || defaultPort(page.protocol);
    return hostsMatch && targetPort !== pagePort;
  } catch {
    return false;
  }
}

function useSameOriginApi(baked: string | undefined): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isDesktopRuntime()) {
    return true;
  }
  if (!baked) {
    return true;
  }
  return bakedApiConflictsWithPageOrigin(baked);
}

/** HTTP API base URL */
export function getApiBaseUrl(): string {
  const override = getBackendUrl();
  if (override) {
    return override;
  }
  const baked = process.env.NEXT_PUBLIC_API_URL;
  if (useSameOriginApi(baked)) {
    return "";
  }
  if (baked) {
    return baked;
  }
  return "";
}

/** VNC WebSocket base URL */
export function getVncWsBaseUrl(): string {
  const override = getBackendUrl();
  if (override) {
    return `${toWsBase(override)}/ws/vnc`;
  }
  const baked = process.env.NEXT_PUBLIC_WS_URL;
  if (useSameOriginApi(baked)) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/vnc`;
  }
  if (baked) {
    return baked.replace(/\/ws\/terminal$/, "/ws/vnc");
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/vnc`;
  }
  return "";
}

/** WebSocket base URL */
export function getWsBaseUrl(): string {
  const override = getBackendUrl();
  if (override) {
    return `${toWsBase(override)}/ws/terminal`;
  }
  const baked = process.env.NEXT_PUBLIC_WS_URL;
  if (useSameOriginApi(baked)) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/terminal`;
  }
  if (baked) {
    return baked;
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/terminal`;
  }
  return "";
}
