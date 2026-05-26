/**
 * 动态获取 API/WebSocket 基础 URL
 *
 * 开发环境（Next :3000）：通过环境变量指向后端 :8000
 * 桌面/同源部署：与当前页面同 host:port（桌面端口由 pywebview 动态分配）
 */

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "pywebview" in window &&
    !!(window as Window & { pywebview?: unknown }).pywebview
  );
}

/** 开发模式：Next 跑在 3000，API 在环境变量指定的其他端口 */
function isNextDevServer(): boolean {
  return typeof window !== "undefined" && window.location.port === "3000";
}

/**
 * 页面与 NEXT_PUBLIC_* 同机不同端口（典型：桌面 127.0.0.1:8001 + 构建时写死 :8000）
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

/** 获取 HTTP API 基础 URL */
export function getApiBaseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  if (useSameOriginApi(baked)) {
    return "";
  }
  if (baked) {
    return baked;
  }
  return "";
}

/** 获取 WebSocket 基础 URL */
export function getWsBaseUrl(): string {
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
