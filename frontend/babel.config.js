module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          safari: '13',
          chrome: '70',
          firefox: '68',
          edge: '79',
        },
        // 不自动导入 core-js，避免与 Next.js 冲突
        useBuiltIns: false,
      },
    ],
    ['@babel/preset-react', { runtime: 'automatic' }],
    '@babel/preset-typescript',
  ],
  plugins: [
    // 确保类属性正确转译
    '@babel/plugin-transform-class-properties',
    '@babel/plugin-transform-private-methods',
    '@babel/plugin-transform-private-property-in-object',
  ],
};
