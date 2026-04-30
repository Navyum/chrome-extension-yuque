# YuqueOut - 语雀导出助手

> 一键批量导出语雀知识库的 Chrome 扩展，支持收藏、协作库、加密文档导出

官网: [https://yuque.toolab.top](https://yuque.toolab.top)

---

## 功能特性

### 导出范围

| 范围 | 说明 |
|------|------|
| **个人知识库** | 自动获取所有个人知识库 |
| **协作知识库** | 支持你参与的所有协作库 |
| **收藏内容** | 批量导出收藏的文档和知识库（官方不支持） |
| **加密文档** | 输入密码后导出加密内容（支持跳过） |

### 文档类型与格式

| 文档类型 | 支持格式 | 转换引擎 |
|----------|----------|----------|
| **文档 (Doc)** | Markdown / Word / PDF / JPG | 本地 Lake→MD 引擎 或 官方 API |
| **表格 (Sheet)** | Excel / CSV / Markdown / HTML | 本地 Lakesheet 解压引擎 或 官方 API |
| **画板 (Board)** | PNG / JPG / SVG | 本地 SVG 渲染引擎（官方 API 不支持） |
| **数据表 (Table)** | Excel | 官方 API |

### 独有能力（官方 / 其他工具不支持）

- **所见即所得** — 只要你能打开文档，就能导出。无需导出权限，不依赖官方导出功能
- **浮动气泡一键导出** — 文档页面右侧浮动气泡，点击即导出当前正在浏览的文档
- **收藏批量导出** — 语雀官方无此功能，支持收藏的单篇文档和整个知识库
- **表格本地转换** — 直接解压 Lakesheet 压缩数据，支持 4 种导出格式（官方仅 xlsx）
- **画板本地渲染** — Lakeboard JSON → SVG → PNG/JPG，官方 API 完全不支持画板导出为图片
- **协作库无权限文档** — 对无导出权限的文档自动切换本地转换引擎
- **加密内容导出** — RSA 加密验证后导出，支持批量处理
- **Markdown 图片本地化** — 自动下载 CDN 图片到本地 `assets/` 目录，替换为相对路径
- **不依赖页面 UI** — 直接调用 API + 本地引擎，语雀改版不影响使用

### 其他特性

| 功能 | 说明 |
|------|------|
| **智能格式匹配** | 自动识别文档类型，按设置匹配最佳导出格式 |
| **目录层级保留** | 按原始 TOC 结构创建文件夹 |
| **暂停/继续/重试** | 完整的导出流程控制 |
| **零配置鉴权** | 自动读取浏览器 Cookie，无需 Token |
| **中英双语** | 支持中文 / English 界面 |

## 安装

### Chrome Web Store

链接待定。

### 本地加载

```bash
git clone <repo-url>
cd chrome-extension-yuque
npm install
npm run build
```

1. 打开 Chrome → `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `dist/` 目录

## 使用方法

1. **登录语雀** — 在浏览器中登录 [yuque.com](https://www.yuque.com)
2. **选择知识库** — 点击扩展图标，勾选知识库（含收藏）
3. **获取文件信息** — 点击按钮扫描文档列表
4. **开始导出** — 等待完成，文件保存到浏览器下载目录

## 设置说明

打开扩展设置页可配置：

| 设置 | 说明 | 默认值 |
|------|------|--------|
| 下载子文件夹 | 所有文件保存到此子目录 | `语雀备份` |
| 文档导出格式 | Doc 类型的默认格式 | Markdown |
| 表格导出格式 | Sheet 类型的默认格式 | Excel |
| 画板导出格式 | Board 类型的默认格式 | PNG |
| Markdown 转换引擎 | 本地转换 / 官方 API | 本地转换 |
| 表格转换引擎 | 本地引擎 / 官方 API | 本地引擎 |
| 白板转换引擎 | 固定本地引擎 | 本地引擎 |
| 图片本地化 | Markdown 导出时下载 CDN 图片 | 开启 |
| 跳过加密内容 | 收藏中跳过需密码的内容 | 关闭 |

## 技术架构

```
Service Worker (background.js)
├── yuque.js          — 语雀 API 封装（含 RSA 加密验证）
├── exporter.js       — 导出引擎（调度本地/API 两种路径）
├── lake-converter.js — Lake HTML → Markdown（Turndown + domino）
├── sheet-converter.js — Lakesheet → xlsx/csv/md/html（pako + xlsx-js-style）
├── board-converter.js — Lakeboard → SVG（纯字符串拼接，无 DOM 依赖）
├── downloads.js      — chrome.downloads 文件保存
└── offscreen.js      — SVG → Canvas → PNG/JPG（Chrome Offscreen API）

Popup (popup.html)
├── 知识库多选（含收藏虚拟知识库 + 全选）
├── 密码输入弹窗（RSA 加密 + 自动提交）
└── 实时日志 + 进度条

Settings (settings.html)
└── 自定义下拉组件（Iconify SVG 图标）
```

### 关键依赖

| 包 | 用途 | 打包体积 |
|----|------|----------|
| `turndown` + `@mixmark-io/domino` | Lake HTML → Markdown | ~200KB |
| `pako` | Lakesheet zlib 解压 | ~45KB |
| `xlsx-js-style` | Excel 生成（含样式） | ~900KB |
| `jsencrypt` | RSA 密码加密 | ~30KB |

## 开发

```bash
npm install         # 安装依赖
npm run build       # 生产构建
npm run build:watch # 监听开发
npm run pack        # 打包为 zip
```

## 隐私

YuqueOut 纯本地处理，**零数据上传**。

- 所有导出操作在本地完成
- 不收集任何用户数据
- 不连接任何第三方服务器
- Cookie 仅用于访问语雀 API，不做任何存储或转发

## License

[ISC](https://opensource.org/licenses/ISC)
