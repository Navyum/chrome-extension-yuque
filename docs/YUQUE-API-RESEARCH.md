# 语雀内部 API 调研报告

> 调研来源：语雀官方开发者文档、GitHub 开源项目（gxr404/yuque-dl、vannvan/yuque-tools、webclipper/web-clipper、x-cold/yuque-hexo）
> 适用场景：Chrome 扩展通过浏览器 Cookie 登录态访问语雀内部 API（非开放 API Token 方式）

---

## 一、认证机制

### 1.1 Cookie 登录态

语雀使用 Cookie 进行身份认证，核心 Cookie 名称：

| Cookie 名称 | 说明 |
|---|---|
| `_yuque_session` | 主要会话 Cookie（必需） |

在 Chrome 扩展中，可通过 `chrome.cookies.get()` 获取该 Cookie：

```javascript
chrome.cookies.get({
  url: 'https://www.yuque.com',
  name: '_yuque_session'
}, (cookie) => {
  const token = cookie.value;
});
```

### 1.2 请求头要求

```http
Cookie: _yuque_session=<token_value>;
Content-Type: application/json
x-requested-with: XMLHttpRequest
User-Agent: <Chrome Desktop UA>
```

关键说明：
- `x-requested-with: XMLHttpRequest` — vannvan/yuque-tools 项目中所有请求都携带此头，表明语雀后端可能用此检测 AJAX 请求
- `User-Agent` — 建议使用真实的 Chrome Desktop UA（gxr404/yuque-dl 使用 rand-user-agent 库生成随机 Chrome UA，并过滤掉 "Chrome-Lighthouse"、"Headless"、"SMTBot" 等机器人标识）
- `Referer` — 下载图片时需要设置 Referer 为文档 URL，否则可能被 CDN 拒绝

### 1.3 CSRF Token 机制

**结论：语雀内部 API 不使用独立的 CSRF Token 机制。**

分析依据：
- gxr404/yuque-dl 的全部 API 调用中没有任何 CSRF Token 相关代码
- vannvan/yuque-tools 的请求模块中也没有 x-csrf-token 头
- 语雀依赖 `_yuque_session` Cookie + `x-requested-with: XMLHttpRequest` 头来进行身份验证和防护
- Chrome 扩展场景下，因为请求是从浏览器发出的，天然携带 Cookie，无需额外 CSRF 处理

### 1.4 开放 API Token 方式（对比参考）

语雀也提供基于 Token 的开放 API（x-cold/yuque-hexo 使用此方式）：
- 请求头：`X-Auth-Token: <personal_access_token>`
- 基础 URL：`https://www.yuque.com/api/v2`
- 此方式功能有限，不适合全量导出场景

---

## 二、API 端点详解

### 2.1 用户信息

**获取当前登录用户信息**

在语雀页面的 HTML 中，用户信息嵌入在页面的 JavaScript 数据中（`appData` 对象）。通过解析页面 HTML 可获得完整用户信息。

此外，可通过以下 API 获取：

```
GET /api/mine
```

- 认证：Cookie（_yuque_session）
- 返回：当前登录用户的基本信息
- 注意：直接访问返回 401 表示未登录

### 2.2 知识库列表

#### 个人知识库列表（含分组）

```
GET /api/mine/book_stacks
```

- 认证：Cookie
- 返回格式：

```json
{
  "data": [
    {
      "name": "分组名称",
      "books": [
        {
          "id": 123456,
          "slug": "knowledge-base-slug",
          "name": "知识库名称",
          "user": {
            "login": "username",
            "name": "显示名"
          },
          "type": "Book",
          "description": "描述",
          "public": 0,
          "enable_toc": true,
          "enable_export": true,
          "enable_comment": true
        }
      ]
    }
  ]
}
```

说明：`book_stacks` 返回的是按"分组（stack）"组织的知识库列表。每个 stack 包含一个 `books` 数组。

#### 协作知识库列表

```
GET /api/mine/raw_collab_books
```

- 认证：Cookie
- 返回格式：

```json
{
  "data": [
    {
      "id": 789012,
      "slug": "collab-book-slug",
      "name": "协作知识库名称",
      "user": {
        "login": "owner_username"
      }
    }
  ]
}
```

#### 团队空间知识库列表

```
GET /api/mine/user_books?user_type=Group
```

- 认证：Cookie
- 适用于企业版 / 团队空间场景

### 2.3 知识库文档列表 / 目录结构

#### 方式一：API 获取文档列表

```
GET /api/docs?book_id={bookId}
```

- 认证：Cookie
- 参数：`book_id`（知识库 ID，从 book_stacks 接口获取）
- 返回格式：

```json
{
  "data": [
    {
      "id": 111222,
      "slug": "doc-slug",
      "title": "文档标题",
      "description": "文档描述",
      "content_updated_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z",
      "published_at": "2024-01-01T00:00:00.000Z",
      "first_published_at": "2024-01-01T00:00:00.000Z",
      "format": "lake",
      "public": 0,
      "status": 1
    }
  ]
}
```

#### 方式二：页面嵌入的 TOC 数据（树形目录结构）

访问知识库页面 HTML，通过正则提取嵌入的 JSON 数据：

```javascript
const knowledgeBaseReg = /decodeURIComponent\("(.+)"\)\);/m;
const html = await fetch(knowledgeBaseUrl).then(r => r.text());
const match = knowledgeBaseReg.exec(html);
const jsonData = JSON.parse(decodeURIComponent(match[1]));
```

提取的 `jsonData` 中包含：

```javascript
{
  book: {
    id: number,
    slug: string,
    name: string,
    description: string,
    toc: [/* TOC 数组 */],
    // ...
  },
  space: {
    host: string,  // 如 "https://www.yuque.com"
  },
  imageServiceDomains: string[],  // 图片服务域名列表
}
```

**TOC（目录）结构**：

```typescript
interface Toc {
  type: string;       // "DOC" | "TITLE" | "LINK"
  title: string;      // 标题
  uuid: string;       // 唯一标识
  url: string;        // 文档 URL（slug）
  prev_uuid: string;  // 前一个兄弟节点
  sibling_uuid: string; // 下一个兄弟节点
  child_uuid: string; // 第一个子节点
  parent_uuid: string; // 父节点
  doc_id: number;     // 文档 ID
  level: number;      // 层级深度
  id: number;
  open_window: number;
  visible: number;
}
```

TOC 是一个扁平数组，通过 `parent_uuid`、`child_uuid`、`sibling_uuid` 构建树形结构。遍历方式：

```javascript
// 构建 uuid -> toc 映射
const uuidMap = new Map(tocList.map(item => [item.uuid, item]));

// 从叶子节点向上遍历获取完整路径
function getFullPath(toc) {
  const path = [];
  let current = toc;
  while (current) {
    path.unshift(current.title);
    current = uuidMap.get(current.parent_uuid);
  }
  return path;
}
```

### 2.4 单篇文档内容获取

#### 方式一：API 获取（推荐）

```
GET /api/docs/{slug}?book_id={bookId}&merge_dynamic_data=false&mode=markdown
```

- 认证：Cookie
- 参数：
  - `slug`：文档 slug（从 TOC 或文档列表获取）
  - `book_id`：知识库 ID
  - `merge_dynamic_data`：`false`（不合并动态数据）
  - `mode`：`markdown`（返回 Markdown 格式内容），不传则返回 HTML
- 返回格式：

```json
{
  "meta": {
    "abilities": {
      "create": false,
      "destroy": false,
      "update": false,
      "read": true,
      "export": true,
      "manage": false,
      "join": false,
      "share": false,
      "force_delete": false,
      "create_collaborator": false,
      "destroy_comment": false
    },
    "latestReviewStatus": null
  },
  "data": {
    "id": 111222,
    "space_id": 0,
    "type": "Doc",
    "sub_type": "",
    "format": "lake",
    "title": "文档标题",
    "slug": "doc-slug",
    "public": 0,
    "status": 1,
    "read_status": 0,
    "sourcecode": "Markdown 源码内容（当 mode=markdown 时）",
    "content": "<p>HTML 内容</p>",
    "created_at": "2024-01-01T00:00:00.000Z",
    "content_updated_at": "2024-01-01T00:00:00.000Z",
    "published_at": "2024-01-01T00:00:00.000Z",
    "first_published_at": "2024-01-01T00:00:00.000Z",
    "last_editor": {},
    "_serializer": "web.doc_detail"
  }
}
```

关键字段说明：
- `data.content` — HTML 格式的文档内容
- `data.sourcecode` — 当请求参数含 `mode=markdown` 时，此字段为 Markdown 源码
- `data.format` — 文档格式，通常为 `"lake"`（语雀的编辑器格式）

#### 方式二：导出 Markdown（带选项）

```
GET /{user}/{repo}/{slug}/markdown?attachment=true&latexcode={boolean}&anchor=false&linebreak={boolean}
```

- 认证：Cookie
- 参数：
  - `attachment`：是否包含附件（`true`）
  - `latexcode`：是否保留 LaTeX 代码（`true`/`false`）
  - `anchor`：是否包含锚点（`false`）
  - `linebreak`：是否使用换行符（`true`/`false`）
- 返回：纯 Markdown 文本

### 2.5 文档评论

```
GET /api/comments/floor?commentable_type=Doc&commentable_id={docId}
```

- 认证：Cookie
- 参数：`commentable_id` 为文档 ID

### 2.6 知识库密码验证

```
POST /api/books/{bookId}/verify
```

- 认证：Cookie
- 用于访问加密知识库

### 2.7 笔记（小记）

```
GET /api/modules/note/notes/NoteController/index?offset={offset}&q=&filter_type=all&status=0&merge_dynamic_data=0&order=content_updated_at&with_pinned_notes=true&limit={limit}
```

- 认证：Cookie
- 支持分页（offset + limit）
- 返回结构含 `notes` 数组和 `has_more` 分页标识

### 2.8 登录 API（参考）

```
POST /api/mobile_app/accounts/login?language=zh-cn
```

请求体：
```json
{
  "login": "用户名",
  "password": "RSA加密后的密码",
  "loginType": "password"
}
```

请求头：
```http
Referer: https://www.yuque.com/login?goto=https%3A%2F%2Fwww.yuque.com%2Fdashboard
Origin: https://www.yuque.com
```

> 注意：Chrome 扩展场景下不需要调用登录 API，直接使用浏览器已有的 Cookie 即可。

---

## 三、图片 CDN 与防盗链

### 3.1 图片 CDN 域名

语雀图片使用阿里云 OSS 存储，常见 CDN 域名包括：

| 域名 | 说明 |
|---|---|
| `cdn.nlark.com` | 语雀主要图片 CDN（已确认返回 403 防盗链）|
| `cdn-china-mainland.yuque.com` | 中国大陆 CDN |
| 其他动态域名 | 通过 `imageServiceDomains` 字段获取 |

`imageServiceDomains` 是知识库页面数据中返回的图片服务域名数组，不同部署环境域名可能不同。

### 3.2 防盗链机制

1. **Referer 检查** — CDN 图片需要正确的 Referer 头（文档页面 URL），否则返回 403
2. **OSS 水印参数** — 图片 URL 可能包含 `x-oss-process=image/watermark,...` 参数（阿里云 OSS 图片处理）
3. **签名代理访问** — 对于受保护的图片，可通过语雀的文件传输代理访问：

```
GET https://www.yuque.com/api/filetransfer/images?url={encodedImageUrl}&sign={sha256Sign}
```

签名算法：
```javascript
const crypto = require('crypto');

const IMAGE_SIGN_KEY = 'UXO91eVnUveQn8suOJaYMvBcWs9Kpt8S8N5HoP8ezSeU4vqApZpy1CkPaTpkpQEx2W2mlhxL8zwS8UePwBgksUM0CTtAODbTTDFD';

function genSign(url) {
  const hash = crypto.createHash('sha256');
  hash.update(`${IMAGE_SIGN_KEY}${url}`);
  return hash.digest('hex');
}

function getProxiedImageUrl(originalUrl) {
  return `https://www.yuque.com/api/filetransfer/images?url=${encodeURIComponent(originalUrl)}&sign=${genSign(originalUrl)}`;
}
```

### 3.3 Chrome 扩展中的图片下载策略

在 Chrome 扩展中下载图片有两种方式：

**方式 A：直接下载（利用浏览器 Cookie + Referer）**
```javascript
// Content Script 中 fetch，自动携带 Cookie
fetch(imageUrl, {
  headers: { 'Referer': documentPageUrl }
});
```

**方式 B：通过签名代理 API**
```javascript
// Background Service Worker 中
const proxyUrl = `https://www.yuque.com/api/filetransfer/images?url=${encodeURIComponent(imageUrl)}&sign=${genSign(imageUrl)}`;
fetch(proxyUrl, { credentials: 'include' });
```

### 3.4 去除水印参数

下载图片后可能需要清理 OSS 水印参数：
```javascript
url = url.replace(/x-oss-process=image%2Fwatermark%2C[^&]*/, '');
```

---

## 四、限流策略

### 4.1 官方说明

语雀开放 API 文档声明所有 API 需要 Token 认证，但未公开内部 API 的限流细节。

### 4.2 开源项目中的观察

| 项目 | 限流处理 |
|---|---|
| gxr404/yuque-dl | 无显式限流处理，顺序请求，无延迟 |
| vannvan/yuque-tools | `requestDuration: 500`（配置中有 500ms 请求间隔常量），但实际请求代码中未显式使用 |
| x-cold/yuque-hexo | 支持 `concurrency` 并发控制参数 |

### 4.3 推荐策略

根据经验和开源项目实践：

1. **请求间隔**：建议每次 API 请求间隔 300-500ms
2. **并发控制**：同时进行的 API 请求不超过 2-3 个
3. **图片下载**：单张图片设置 3 分钟超时（yuque-dl 的做法）
4. **错误重试**：遇到网络错误（ECONNRESET 等）时进行重试
5. **指数退避**：如遇到 429 Too Many Requests，使用指数退避策略

---

## 五、企业版 / 空间版差异

| 特性 | 标准版 | 企业版/空间版 |
|---|---|---|
| Host | `https://www.yuque.com` | 自定义域名（如 `https://xxx.yuque.com`）|
| 知识库列表 API | `/api/mine/book_stacks` | `/api/mine/user_books?user_type=Group` |
| Cookie 域 | `.yuque.com` | 对应的企业域名 |
| 图片 CDN | `cdn.nlark.com` 等 | 可能有独立域名 |

---

## 六、API 端点汇总表

| 功能 | 方法 | 端点 | 认证 |
|---|---|---|---|
| 当前用户信息 | GET | `/api/mine` | Cookie |
| 个人知识库列表（分组） | GET | `/api/mine/book_stacks` | Cookie |
| 协作知识库列表 | GET | `/api/mine/raw_collab_books` | Cookie |
| 团队空间知识库 | GET | `/api/mine/user_books?user_type=Group` | Cookie |
| 知识库文档列表 | GET | `/api/docs?book_id={bookId}` | Cookie |
| 文档内容（HTML） | GET | `/api/docs/{slug}?book_id={bookId}&merge_dynamic_data=false` | Cookie |
| 文档内容（Markdown） | GET | `/api/docs/{slug}?book_id={bookId}&merge_dynamic_data=false&mode=markdown` | Cookie |
| 文档导出 Markdown | GET | `/{user}/{repo}/{slug}/markdown?attachment=true&linebreak=true` | Cookie |
| 文档评论 | GET | `/api/comments/floor?commentable_type=Doc&commentable_id={docId}` | Cookie |
| 知识库密码验证 | POST | `/api/books/{bookId}/verify` | Cookie |
| 笔记列表 | GET | `/api/modules/note/notes/NoteController/index?offset=0&limit=20&...` | Cookie |
| 图片代理（签名） | GET | `/api/filetransfer/images?url={url}&sign={sign}` | Cookie |
| 登录（参考） | POST | `/api/mobile_app/accounts/login?language=zh-cn` | 无 |
| 登录（参考） | POST | `/api/accounts/login` | 无 |

---

## 七、Chrome 扩展特别注意事项

1. **Cookie 获取**：使用 `chrome.cookies.get({ url: 'https://www.yuque.com', name: '_yuque_session' })` 获取登录态
2. **跨域请求**：在 `manifest.json` 中声明 `host_permissions: ["https://*.yuque.com/*", "https://cdn.nlark.com/*"]`
3. **不需要 CSRF Token**：语雀对 GET 请求没有 CSRF 保护，Chrome 扩展发出的请求自带 Cookie
4. **Referer 设置**：可通过 `chrome.declarativeNetRequest` 修改图片请求的 Referer 头
5. **页面数据提取**：Content Script 可以直接从当前页面 DOM 中提取 `appData`（语雀将大量元数据通过 `decodeURIComponent()` 注入页面 script 标签）
6. **请求超时**：建议 API 请求超时 10 秒，图片下载超时 3 分钟
