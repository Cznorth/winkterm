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
        // Do not auto-import core-js — avoids conflict with Next.js
        useBuiltIns: false,
      },
    ],
    ['@babel/preset-react', { runtime: 'automatic' }],
    '@babel/preset-typescript',
  ],
  plugins: [
    // Ensure class properties transpile correctly
    '@babel/plugin-transform-class-properties',
    '@babel/plugin-transform-private-methods',
    '@babel/plugin-transform-private-property-in-object',
  ],
};
