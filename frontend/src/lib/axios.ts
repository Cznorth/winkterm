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

// Remote access auth: attach access key on every request (empty key on localhost desktop; backend skips auth by IP)
axiosInstance.interceptors.request.use((config) => {
  const key = getAccessKey();
  if (key) {
    config.headers["X-Access-Key"] = key;
  }
  return config;
});

export default axiosInstance;
