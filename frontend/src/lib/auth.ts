/**
 * Web 远程访问密钥的本地存储。
 *
 * 桌面客户端来自 localhost，后端免鉴权，此处密钥为空也无妨。
 * 远程浏览器访问时，密钥随 HTTP 头 / WebSocket 查询参数发送。
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
