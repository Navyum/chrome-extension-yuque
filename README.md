# YuqueOut - 语雀导出助手

> 一键批量导出语雀知识库的 Chrome 扩展

官网: [https://yuque.toolab.top](https://yuque.toolab.top)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **智能导出** | 自动识别文档类型，匹配最佳导出格式 |
| **文档 (Doc)** | 支持 Markdown / Word / PDF / JPG |
| **表格 (Sheet)** | 支持 Excel (.xlsx) |
| **数据表 (Table)** | 支持 Excel (.xlsx) |
| **画板 (Board)** | 语雀私有格式，暂不支持标准格式导出 |
| **Markdown 图片本地化** | 自动下载 CDN 图片到本地 `assets/` 目录 |
| **知识库管理** | 个人 + 协作知识库，下拉多选 |
| **零配置鉴权** | 自动读取浏览器 Cookie，无需 Token |
| **暂停 / 继续 / 重试** | 完整的导出流程控制 |
| **中英双语 i18n** | 支持中文 / English 界面切换 |

## 安装

### Chrome Web Store

链接待定。

### 本地加载

1. 克隆仓库并构建：
   ```bash
   git clone <repo-url>
   cd chrome-extension-yuque
   npm install
   npm run build
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `dist/` 目录

## 使用方法

三步完成导出：

1. **登录语雀** — 在浏览器中登录 [yuque.com](https://www.yuque.com)，确保已登录状态
2. **选择知识库** — 点击扩展图标，在下拉列表中选择要导出的知识库（支持多选）
3. **点击导出** — 选择导出格式，点击「开始导出」，等待完成即可

## 开发

```bash
# 安装依赖
npm install

# 构建（生产模式）
npm run build

# 监听模式（开发）
npm run build:watch

# 打包为 zip
npm run pack
```

## 技术栈

- **Manifest V3** — Chrome 扩展标准
- **原生 JavaScript** — 轻量无框架依赖
- **Webpack** — 模块打包与构建
- **chrome.i18n** — 国际化方案
- **chrome.downloads API** — 文件下载管理

## 隐私

YuqueOut 纯本地处理，**零数据上传**。

- 所有导出操作在本地完成
- 不收集任何用户数据
- 不连接任何第三方服务器
- Cookie 仅用于访问语雀 API，不做任何存储或转发

## License

[ISC](https://opensource.org/licenses/ISC)
