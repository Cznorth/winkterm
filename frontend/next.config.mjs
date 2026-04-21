/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 静态导出配置（用于桌面应用打包）
  output: 'export',
  experimental: {
    forceSwcTransforms: process.env.NODE_ENV === 'development',
  },
  trailingSlash: true,
  images: { unoptimized: true },
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
};

export default nextConfig;
