# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YuqueOut — 语雀导出助手。Chrome Manifest V3 扩展，批量导出语雀知识库为 Markdown/Word/PDF/Excel 等格式。纯本地处理，零数据上传。

## Build Commands

```bash
npm install           # 安装依赖
npm run build         # 生产构建 (webpack, output → dist/)
npm run build:watch   # 监听模式开发
npm run pack          # 构建 + 打包为 build/chrome-extension-yuque-export.zip
```

构建产物输出到 `dist/`，加载扩展时选择该目录。

## Architecture

### Manifest V3 入口

- **Service Worker**: `src/background.js` — 扩展后台入口，协调所有核心模块
- **Popup**: `src/popup.html` + `src/popup.js` — 用户主界面（知识库选择、导出控制）
- **Settings**: `src/settings.html` + `src/settings.js` — 配置页
- **Content Script**: `src/content/bubble.js` — 语雀页面浮动气泡，一键导出当前文档
- **Offscreen**: `src/offscreen.js` — Chrome Offscreen API，用于 SVG→Canvas→PNG/JPG 转换

### Core 模块 (`src/core/`)

| 模块 | 职责 |
|------|------|
| `yuque.js` | 语雀 API 封装（含 RSA 加密验证、Cookie 鉴权） |
| `exporter.js` | 导出调度引擎（本地转换 / API 两条路径） |
| `lake-converter.js` | Lake HTML → Markdown（Turndown + domino，Service Worker 无 DOM） |
| `sheet-converter.js` | Lakesheet → xlsx/csv/md/html（pako 解压 + xlsx-js-style） |
| `board-converter.js` | Lakeboard JSON → SVG（纯字符串拼接，无 DOM 依赖） |
| `downloads.js` | chrome.downloads 文件保存封装 |
| `task-controller.js` | 导出任务流程控制（暂停/继续/重试） |
| `messaging.js` | background ↔ popup 消息通信 |
| `state.js` | 后台状态管理 |
| `constants.js` | 常量定义 |

### UI 模块 (`src/ui/`)

Popup 界面逻辑拆分：`dom.js`（DOM 操作）、`state.js`（UI 状态）、`actions.js`（用户操作）、`messaging.js`（与 background 通信）、`password.js`（加密文档密码弹窗）、`i18n.js`（国际化）。

### 关键设计决策

- **Service Worker 无 DOM**：`lake-converter.js` 使用 `@mixmark-io/domino` 提供 DOM 解析，webpack 配置中 `aliasFields: []` 禁用 browser field 确保 turndown 走 Node 构建路径
- **双转换引擎**：文档和表格支持「本地转换」和「官方 API」两条路径，本地引擎不依赖导出权限
- **Offscreen 架构**：画板 PNG/JPG 导出需要 Canvas，通过 Chrome Offscreen API 在独立文档中完成渲染
- **国际化**：`_locales/zh_CN/` 和 `_locales/en/`，manifest 用 `__MSG_*__` 占位符

## Webpack

单配置文件 `webpack.config.js`，5 个入口（background、popup、settings、offscreen、content/bubble）。`CopyWebpackPlugin` 复制静态资源（manifest、locales、icons、HTML/CSS）到 dist。
