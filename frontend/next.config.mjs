/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 静态导出配置（用于桌面应用打包）
  output: 'export',
  transpilePackages: ['@novnc/novnc'],
  experimental: {
    forceSwcTransforms: process.env.NODE_ENV === 'development',
  },
  trailingSlash: true,
  images: { unoptimized: true },
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  webpack: (config) => {
    // @novnc/novnc uses top-level await. Webpack wraps such modules in an
    // async-module runtime, which only needs async-function support — every
    // browser we target (Chrome 70+, Safari 13+, FF 68+, Edge 79+) has it.
    // Webpack infers asyncFunction=false from the older browserslist, so state
    // it explicitly to silence the bogus "may not support async/await" warning.
    config.experiments = { ...config.experiments, topLevelAwait: true };
    config.output.environment = { ...config.output.environment, asyncFunction: true };
    return config;
  },
};

export default nextConfig;
