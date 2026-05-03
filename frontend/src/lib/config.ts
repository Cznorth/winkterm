/**
 * 动态获取 API/WebSocket 基础 URL
 *
 * 开发环境：通过环境变量配置（跨域请求）
 * 生产环境：基于当前域名构建（前后端同源部署）
 */

/** 获取 HTTP API 基础 URL */
export function getApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // 生产环境：前后端同源，后端路由已有 /api 前缀
  return "";
}

/** 获取 WebSocket 基础 URL */
export function getWsBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  // 生产环境：基于当前域名动态构建
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/terminal`;
  }
  return "";
}
