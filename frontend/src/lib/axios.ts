import axios from "axios";
import { getApiBaseUrl } from "./config";
import { getAccessKey } from "./auth";

const axiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// 远程访问鉴权：每个请求附带访问密钥（localhost 桌面端密钥为空，后端按 IP 免鉴权）
axiosInstance.interceptors.request.use((config) => {
  const key = getAccessKey();
  if (key) {
    config.headers["X-Access-Key"] = key;
  }
  return config;
});

export default axiosInstance;
