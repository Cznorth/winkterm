import axios from "axios";

// 动态获取 API URL：
// 1. 优先使用环境变量（用于开发环境跨域请求）
// 2. 否则使用空字符串（前后端同源部署，后端路由已有 /api 前缀）
const getBaseURL = () => {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // 生产环境：前后端同源，后端路由已有 /api 前缀，这里不需要额外路径
  return "";
};

const axiosInstance = axios.create({
  baseURL: getBaseURL(),
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

export default axiosInstance;
