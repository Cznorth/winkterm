/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 静态导出配置（用于桌面应用打包）
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
