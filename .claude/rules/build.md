---
description: 构建和打包规范
globs: webpack.config.js,package.json
---

# 构建

- 构建命令：`npm run build`（生产）、`npm run build:watch`（开发）、`npm run pack`（打包 zip）
- 构建产物输出到 `dist/`，Chrome 加载该目录测试
- 新增 webpack 入口时，同步更新 `webpack.config.js` 的 entry 配置
- 新增静态资源目录时，同步更新 CopyWebpackPlugin 的 patterns
- webpack resolve 配置中 `aliasFields: []` 是刻意为之，确保 turndown 在 Service Worker 中使用 domino 而非浏览器 DOM
