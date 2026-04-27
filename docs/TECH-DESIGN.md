# 语雀导出助手 — 技术方案（实际实现版）

## 一、架构概览

```
┌─────────────────────────────────────────────┐
│                Chrome Extension              │
├──────────────────┬──────────────────────────┤
│      Popup       │     Background           │
│   (原生 JS)      │   Service Worker         │
│                  │                          │
│ 登录状态检测      │  核心导出引擎             │
│ 知识库列表+搜索   │  ├─ 鉴权模块 (yuque.js)  │
│ 知识库多选        │  ├─ API 封装 + 节流       │
│ 导出格式选择      │  ├─ 异步导出 + 轮询       │
│ 进度展示         │  ├─ 图片下载器            │
│ 设置页面         │  ├─ 下载管理器            │
│                  │  └─ 任务流程控制          │
└──────────────────┴──────────────────────────┘
         │                    │
         │   chrome.runtime   │
         │   .sendMessage()   │
         ▼                    ▼
┌─────────────────────────────────────────────┐
│              yuque.com                       │
│  ├─ /api/v2/mine (用户信息)                  │
│  ├─ /api/v2/users/:login/repos (个人知识库)  │
│  ├─ /api/v2/mine/groups (协作团队)           │
│  ├─ /api/v2/repos/:ns/toc (文档目录)         │
│  ├─ POST /api/docs/:id/export (异步导出)     │
│  ├─ GET /api/docs/:id/export (轮询导出结果)  │
│  └─ cdn.nlark.com / cdn.yuque.com (图片CDN)  │
└─────────────────────────────────────────────┘
```

## 二、技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| **Manifest** | Manifest V3 | Chrome 强制要求 |
| **Popup UI** | 原生 JavaScript | 轻量无框架依赖 |
| **UI 样式** | 原生 CSS (暗黑紫色主题) | 轻量，复用已有设计风格 |
| **文档导出** | 语雀异步导出 API | 服务端渲染，格式准确，支持多种格式 |
| **文件保存** | chrome.downloads API | 浏览器原生下载 |
| **状态管理** | chrome.storage.local | 持久化导出状态 |
| **构建工具** | Webpack | 模块打包 |
| **国际化** | chrome.i18n | 中英双语支持 |

## 三、项目结构

```
chrome-extension-yuque/
├── src/
│   ├── background.js          # Service Worker 入口
│   ├── popup.html             # Popup 主界面
│   ├── popup.css              # Popup 样式 (暗黑紫色主题)
│   ├── popup.js               # Popup 入口
│   ├── settings.html          # 设置页面
│   ├── settings.css           # 设置页样式
│   ├── settings.js            # 设置页逻辑
│   ├── core/
│   │   ├── constants.js       # API 端点、格式常量
│   │   ├── yuque.js           # 语雀 API 封装 + 鉴权 + CSRF Token
│   │   ├── exporter.js        # 导出引擎核心（异步导出 + 轮询）
│   │   ├── downloads.js       # 文件下载管理
│   │   ├── state.js           # 导出状态管理
│   │   ├── messaging.js       # popup ↔ background 通信
│   │   ├── throttle.js        # 智能请求节流
│   │   ├── task-controller.js # AbortController 管理
│   │   └── utils.js           # 工具函数
│   └── ui/
│       ├── dom.js             # DOM 引用缓存
│       ├── ui.js              # UI 更新逻辑 + 知识库列表渲染
│       ├── actions.js         # 用户操作处理
│       ├── messaging.js       # 运行时消息监听
│       ├── state.js           # UI 状态
│       ├── constants.js       # UI 常量
│       ├── i18n.js            # 国际化
│       └── sponsor.js         # 赞助交互
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── icons/                     # 扩展图标
├── asserts/                   # UI 资源
├── manifest.json
├── webpack.config.js
└── package.json
```

## 四、核心导出机制

### 4.1 导出方式：异步导出 API

所有文档类型统一使用语雀的异步导出 API，不再进行本地 HTML→MD 转换。

**流程：**

```
1. POST /api/docs/{id}/export
   Body: { type: "markdown" | "word" | "pdf" | "jpeg" | "xlsx" }
   Header: x-csrf-token: <token>
   → 返回 { data: { state: "processing", ... } }

2. GET /api/docs/{id}/export（轮询）
   → 返回 { data: { state: "success", url: "<download-url>" } }
   → 或 { data: { state: "processing" } }（继续轮询）

3. 使用返回的 url 下载文件
```

### 4.2 文档类型与导出格式映射

| 文档类型 | type 值 | 支持的导出格式 |
|----------|---------|---------------|
| **Doc** (文档) | `"Doc"` | Markdown (.md), Word (.docx), PDF (.pdf), JPG (.jpg) |
| **Sheet** (表格) | `"Sheet"` | Excel (.xlsx) |
| **Table** (数据表) | `"Table"` | Excel (.xlsx) |
| **Board** (画板) | `"Board"` | 语雀私有格式，暂不支持标准格式导出 |

### 4.3 CSRF Token 获取机制

语雀的 POST API 需要 CSRF Token 进行鉴权，获取方式：

1. 通过浏览器 Cookie 自动读取登录态（`chrome.cookies` API）
2. 请求语雀页面时从响应中提取 CSRF Token
3. 将 Token 附加到 POST 请求的 `x-csrf-token` Header 中

无需用户手动配置 Token，全程自动化。

### 4.4 异步轮询流程

```
┌──────────────┐
│  发起导出请求  │ POST /api/docs/{id}/export
└──────┬───────┘
       ▼
┌──────────────┐
│  检查状态     │ GET /api/docs/{id}/export
└──────┬───────┘
       ▼
   ┌───────┐    state === "processing"
   │ 判断   │ ─────────────────────────┐
   │ state  │                          │
   └───┬───┘                     等待间隔后重试
       │ state === "success"           │
       ▼                               │
┌──────────────┐                       │
│  获取下载 URL │                       │
└──────┬───────┘                       │
       ▼                               │
┌──────────────┐     ┌─────────────┐   │
│  下载文件     │     │  超时 / 失败 │◄──┘ (超过最大重试次数)
└──────────────┘     └─────────────┘
```

- 轮询间隔：逐步递增，避免频繁请求
- 超时机制：超过最大轮询次数后标记为失败，支持手动重试
- 节流控制：并发请求数可配置，避免触发语雀 Rate Limit

### 4.5 Markdown 图片本地化

当导出格式为 Markdown 时，额外执行图片本地化流程：

```
1. 解析 .md 文件中的图片链接（正则匹配 ![...](...) 语法）
2. 筛选语雀 CDN 图片（cdn.nlark.com / cdn.yuque.com）
3. 并发下载图片到 assets/ 子目录
4. 替换 .md 中的图片链接为本地相对路径 (./assets/xxx.png)
5. 保存更新后的 .md 文件
```

CDN 防盗链处理：通过 `chrome.declarativeNetRequest` 修改请求 Header（移除 Referer），绕过语雀 CDN 的防盗链检测。

## 五、已实现功能清单

### P0 (MVP)
- F1: 知识库列表加载（个人 + 协作，搜索/过滤/全选）
- F2: 批量导出（Markdown / Word / PDF / JPG / Excel）
- F3: 图片本地化（CDN 防盗链处理 + 并发下载）
- F4: 实时进度展示（进度条 + 日志 + 暂停/继续）
- F5: 登录态检测（自动检测 Cookie + 用户信息展示）

### P1
- F6: 协作知识库导出（团队组知识库遍历）
- F7: 导出设置（格式/图片/间隔/并发 全可配置）

### 其他
- 多格式导出: Markdown / Word / PDF / JPG / Excel
- 中英双语国际化
- 设置页面（通用设置 + 关于）
- 暗黑紫色主题
- 失败重试机制
- 暂停/继续/重试 流程控制
- 状态持久化（Service Worker 重启恢复）
- CDN 防盗链绕过（declarativeNetRequest）

## 六、通信协议

```
Popup → Background:
  checkAuth      → { isLoggedIn, userName, ... }
  getBooks       → YuqueBook[]
  getFileInfo    → { fileList, totalFiles, folderCount }
  startExport    → { success }
  togglePause    → void
  getUiState     → exportState
  retryFailedFiles → { success }
  resetExport    → { success }

Background → Popup:
  exportProgress → { exportedFiles, totalFiles }
  exportComplete → void
  exportError    → { error }
  exportLog      → { message }
```

## 七、已移除功能

以下功能在架构迭代中被移除：

| 移除项 | 原因 |
|--------|------|
| `converter.js` (HTML→MD 转换) | 改用语雀异步导出 API，服务端直接生成目标格式，无需本地转换 |
| `incremental.js` (增量导出) | 简化架构，专注核心导出能力 |
| 定时备份 (chrome.alarms) | 简化架构，去除后台自动任务 |
| 附件下载器 | 简化架构 |
