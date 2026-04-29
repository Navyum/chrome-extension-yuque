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
│   ├── settings.html          # 设置页面（自定义 icon-select 组件）
│   ├── settings.css           # 设置页样式
│   ├── settings.js            # 设置页逻辑
│   ├── offscreen.html         # Offscreen document（SVG→Canvas→PNG/JPG）
│   ├── offscreen.js           # Offscreen 渲染逻辑
│   ├── core/
│   │   ├── constants.js       # API 端点、格式常量、默认设置
│   │   ├── yuque.js           # 语雀 API 封装 + 鉴权 + RSA 加密
│   │   ├── exporter.js        # 导出引擎（调度本地/API 双引擎）
│   │   ├── lake-converter.js  # Lake HTML → Markdown（Turndown + domino）
│   │   ├── sheet-converter.js # Lakesheet → xlsx/csv/md/html（pako + xlsx-js-style）
│   │   ├── board-converter.js # Lakeboard → SVG（纯字符串拼接，无 DOM）
│   │   ├── downloads.js       # chrome.downloads 文件保存
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
│       ├── password.js        # 密码输入弹窗（RSA 加密）
│       ├── state.js           # UI 状态
│       ├── constants.js       # UI 常量
│       ├── i18n.js            # 国际化
│       └── sponsor.js         # 赞助交互
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── icons/                     # 扩展图标
├── asserts/                   # UI 资源（含 Iconify SVG 图标）
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

| 文档类型 | type 值 | 官方 API 格式 | 本地引擎格式 |
|----------|---------|--------------|-------------|
| **Doc** (文档) | `"Doc"` | Markdown, Word, PDF, JPG | Markdown（Lake HTML→MD） |
| **Sheet** (表格) | `"Sheet"` | Excel | Excel, CSV, Markdown, HTML |
| **Board** (画板) | `"Board"` | 不支持 | PNG, JPG, SVG |
| **Table** (数据表) | `"Table"` | Excel | — |

### 4.2.1 双引擎架构

导出引擎分为 **官方 API** 和 **本地转换** 两条路径：

```
文件 → getPerTypeFormat(docType) → 确定目标格式
  │
  ├─ Doc + md + (本地模式 / 无权限) → lake-converter.js (Lake HTML → Markdown)
  ├─ Sheet + (本地模式 / 非xlsx / 无权限) → sheet-converter.js (Lakesheet → xlsx/csv/md/html)
  ├─ Board (始终本地) → board-converter.js (Lakeboard → SVG → PNG/JPG)
  └─ 其他 → 官方异步导出 API + 轮询
```

**本地转换引擎详情：**

| 引擎 | 输入 | 处理方式 | 依赖 |
|------|------|----------|------|
| lake-converter | Lake HTML (content 字段) | Turndown + 自定义 card 规则 | turndown, domino |
| sheet-converter | Lakesheet JSON (content/body 字段) | latin-1→pako.inflate→JSON→格式化 | pako, xlsx-js-style |
| board-converter | Lakeboard JSON (content 字段) | 解析元素→SVG 字符串→offscreen Canvas | Chrome offscreen API |

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

### P2 — 收藏 & 本地转换引擎
- F8: 收藏批量导出（mark_doc 单篇 + mark_book 整库）
- F9: 加密内容处理（RSA 加密验证 + 密码弹窗 + 跳过选项）
- F10: Lake HTML → Markdown 本地转换（Turndown + domino，Service Worker 兼容）
- F11: Lakesheet → 多格式（pako 解压 + xlsx-js-style 生成 Excel，含样式/合并/列宽）
- F12: Lakeboard → SVG → PNG/JPG（纯 SVG 字符串渲染 + Chrome Offscreen API）
- F13: 设置页自定义下拉组件（Iconify SVG 图标 + icon-select 组件）
- F14: 双引擎架构（本地转换 / 官方 API 可切换，按文档类型独立配置）

### 其他
- 多格式导出: Markdown / Word / PDF / JPG / Excel / CSV / HTML / PNG / SVG
- 中英双语国际化
- 设置页面（导出配置 + 转换引擎 + 收藏设置 + 性能调优 + 关于）
- 暗黑紫色主题
- 失败重试机制 + API 失败自动 fallback 到本地引擎
- 暂停/继续/重试 流程控制
- 状态持久化（Service Worker 重启恢复）
- CDN 防盗链绕过（declarativeNetRequest）
- `aria-hidden` → `inert` 无障碍优化

## 六、通信协议

```
Popup → Background:
  checkAuth        → { isLoggedIn, userName, ... }
  getBooks         → YuqueBook[]
  getFileInfo      → { fileList, totalFiles, folderCount }
  startExport      → { success }
  togglePause      → void
  getUiState       → exportState
  retryFailedFiles → { success }
  resetExport      → { success }
  verifyPassword   → { success, newFiles, remaining }
  skipEncrypted    → { success, remaining }

Background → Popup:
  exportProgress      → { exportedFiles, totalFiles }
  exportComplete      → void
  exportError         → { error }
  exportLog           → { message }
  showPasswordDialog  → { encryptedItems }

Background → Offscreen:
  svgToImage → { svg, width, height, format } → { dataUrl }
```

## 七、架构演进

| 阶段 | 变更 | 原因 |
|------|------|------|
| V1 | 移除 `converter.js` | 改用语雀异步导出 API |
| V1 | 移除 `incremental.js` / 定时备份 / 附件下载 | 简化 MVP |
| V2 | 新增 `lake-converter.js` | 收藏/协作文档无导出权限，需本地 Lake→MD |
| V2 | 新增 `sheet-converter.js` | 表格支持 CSV/MD/HTML，官方 API 仅 xlsx |
| V2 | 新增 `board-converter.js` + offscreen | 画板导出为图片，官方 API 完全不支持 |
| V2 | 新增 `password.js` | RSA 加密验证 + 批量密码输入 |
| V2 | `aria-hidden` → `inert` | 修复 focused element hidden 无障碍警告 |
| V2 | `downloads.js` 重写 | 移除 onDeterminingFilename hooks，仅用 filename 参数 |
