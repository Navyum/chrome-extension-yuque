---
description: 项目架构约束和模块规范
globs: src/**/*.js
---

# 架构规范

- 纯 JavaScript + Webpack 构建，不引入 TypeScript、React 或其他框架
- 所有模块使用 ES Module (import/export)，不使用 CommonJS
- Service Worker (background.js) 中没有 DOM 环境，不能使用 document/window，DOM 解析用 @mixmark-io/domino
- 核心转换逻辑放 `src/core/`，UI 逻辑放 `src/ui/`，内容脚本放 `src/content/`
- 语雀 API 相关逻辑集中在 `src/core/yuque.js`，不分散到其他模块
