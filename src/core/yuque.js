import { YUQUE_API, SUPPORTED_DOC_TYPES, SKIPPED_DOC_TYPES, DOC_TYPES, DOC_TYPE_EXPORT_OPTIONS, EXPORT_OPTIONS, EXPORT_POLL_MAX, EXPORT_POLL_INTERVAL, YUQUE_RSA_PUBLIC_KEY } from './constants.js';
import { getAbortSignal } from './task-controller.js';
import { sanitizePathComponent } from './utils.js';
import { RequestThrottle } from './throttle.js';
import JSEncrypt from 'jsencrypt';

const throttle = new RequestThrottle(500);

/**
 * Check login status and return user info.
 * Uses /api/mine (internal API, cookie-based).
 */
export async function checkAuth() {
  const cookie = await chrome.cookies.get({
    url: YUQUE_API.HOME_PAGE,
    name: '_yuque_session'
  });
  if (!cookie || !cookie.value) {
    return { isLoggedIn: false };
  }

  try {
    const data = await fetchYuqueAPI('/mine');
    const user = data.data || {};
    return {
      isLoggedIn: true,
      userId: user.id,
      login: user.login,
      userName: user.name || user.login,
      avatarUrl: user.avatar_url || user.large_avatar_url,
    };
  } catch {
    return { isLoggedIn: false };
  }
}

/**
 * Get all knowledge bases (personal + collaboration).
 * Uses internal API endpoints discovered from yuque-tools and yuque-dl.
 */
export async function fetchAllBooks() {
  const books = [];

  // Personal books via /api/mine/book_stacks (grouped by stack)
  try {
    const stackData = await fetchYuqueAPI('/mine/book_stacks');
    const stacks = Array.isArray(stackData.data) ? stackData.data : [];
    stacks.forEach(stack => {
      const stackBooks = Array.isArray(stack.books) ? stack.books : [];
      stackBooks.forEach(book => {
        books.push({
          id: book.id,
          slug: book.slug,
          name: book.name,
          docs_count: book.items_count || book.docs_count || 0,
          updated_at: book.updated_at,
          namespace: `${book.user?.login || ''}/${book.slug}`,
          type: 'personal',
          description: book.description || '',
          stackName: stack.name || '',
        });
      });
    });
  } catch (e) {
  }

  // Collaboration books via /api/mine/raw_collab_books
  try {
    const collabData = await fetchYuqueAPI('/mine/raw_collab_books');
    const collabBooks = Array.isArray(collabData.data) ? collabData.data : [];
    collabBooks.forEach(book => {
      // Deduplicate
      if (!books.find(b => b.id === book.id)) {
        books.push({
          id: book.id,
          slug: book.slug,
          name: book.name,
          docs_count: book.items_count || book.docs_count || 0,
          updated_at: book.updated_at,
          namespace: `${book.user?.login || ''}/${book.slug}`,
          type: 'collab',
          description: book.description || '',
          groupName: book.user?.name || '',
        });
      }
    });
  } catch (e) {
  }

  // Group/Team books via /api/mine/user_books?user_type=Group
  try {
    const groupData = await fetchYuqueAPI('/mine/user_books?user_type=Group');
    const groupBooks = Array.isArray(groupData.data) ? groupData.data : [];
    groupBooks.forEach(book => {
      if (!books.find(b => b.id === book.id)) {
        books.push({
          id: book.id,
          slug: book.slug,
          name: book.name,
          docs_count: book.items_count || book.docs_count || 0,
          updated_at: book.updated_at,
          namespace: `${book.user?.login || ''}/${book.slug}`,
          type: 'collab',
          description: book.description || '',
          groupName: book.user?.name || '',
        });
      }
    });
  } catch (e) {
    // Group books may not exist for personal accounts
  }

  return books;
}

/**
 * Get the document list for a knowledge base.
 * Uses /api/docs?book_id={bookId}
 */
export async function fetchBookDocs(bookId) {
  const data = await fetchYuqueAPI(`/docs?book_id=${bookId}`);
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Fetch embedded TOC data from a knowledge base page.
 * The page includes a URL-encoded JSON payload containing book.toc.
 */
export async function fetchBookToc(bookNamespace) {
  if (!bookNamespace) return [];

  const resp = await fetch(`${YUQUE_API.HOME_PAGE}/${bookNamespace}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
    signal: getAbortSignal()
  });

  if (!resp.ok) {
    throw new Error(`获取目录结构失败: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const toc = extractTocFromBookHtml(html);
  return Array.isArray(toc) ? toc : [];
}

/**
 * Build a flat document list from /api/docs?book_id= response.
 * The API returns the real doc type directly (Doc/Sheet/Board/Table).
 */
export function buildDocListFromApiDocs(docs, toc = []) {
  const files = [];
  const folderPathByDocId = buildFolderPathMapFromToc(toc);
  docs.forEach(doc => {
    const docType = doc.type || DOC_TYPES.DOC;
    if (!SUPPORTED_DOC_TYPES.has(docType)) return;
    files.push({
      id: doc.id,
      slug: doc.slug,
      title: doc.title || '未命名文档',
      docType,
      folderPath: folderPathByDocId.get(doc.id) || '',
      status: 'pending',
      localPath: '',
      updatedAt: doc.content_updated_at || doc.updated_at,
    });
  });
  const folderCount = new Set(files.map(file => file.folderPath).filter(Boolean)).size;
  return { files, folderCount };
}

function extractTocFromBookHtml(html) {
  if (!html) return [];

  const decodeMatches = html.matchAll(/decodeURIComponent\("([^"]+)"\)/g);
  for (const match of decodeMatches) {
    const payload = safeParseEmbeddedPayload(match[1]);
    const toc = payload?.book?.toc;
    if (Array.isArray(toc)) return toc;
  }

  const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (initialStateMatch) {
    try {
      const payload = JSON.parse(initialStateMatch[1]);
      const toc = payload?.book?.toc || payload?.repository?.toc;
      if (Array.isArray(toc)) return toc;
    } catch {}
  }

  return [];
}

function safeParseEmbeddedPayload(encodedPayload) {
  if (!encodedPayload) return null;
  try {
    return JSON.parse(decodeURIComponent(encodedPayload));
  } catch {
    return null;
  }
}

function buildFolderPathMapFromToc(toc = []) {
  const byUuid = new Map();
  toc.forEach(item => {
    if (item?.uuid) byUuid.set(item.uuid, item);
  });

  const pathCache = new Map();

  function resolveFolderPath(item) {
    if (!item?.uuid) return '';
    if (pathCache.has(item.uuid)) return pathCache.get(item.uuid);

    const segments = [];
    let current = item;

    while (current?.parent_uuid) {
      current = byUuid.get(current.parent_uuid);
      if (!current) break;

      const title = sanitizePathComponent(current.title || '');
      if (!title) continue;

      // Both TITLE and DOC nodes can represent folders for descendants.
      if (current.type === 'TITLE' || current.type === 'DOC') {
        segments.unshift(title);
      }
    }

    const path = segments.join('/');
    pathCache.set(item.uuid, path);
    return path;
  }

  const result = new Map();
  toc.forEach(item => {
    if (!item || item.type !== 'DOC' || !item.doc_id) return;
    result.set(item.doc_id, resolveFolderPath(item));
  });

  return result;
}

// ═══════════════════════════════════════════
// Async Export API (POST /api/docs/{docId}/export)
// ═══════════════════════════════════════════

let cachedCsrfToken = null;
let cachedServerTimeOffset = null;

async function fetchDashboardPage() {
  const resp = await fetch(`${YUQUE_API.HOME_PAGE}/dashboard`, {
    credentials: 'include',
    signal: getAbortSignal()
  });
  const html = await resp.text();
  return { html, headers: resp.headers };
}

function extractServerTimestampFromHtml(html) {
  if (!html) return;
  const match = html.match(/window\.appData\s*=\s*JSON\.parse\(decodeURIComponent\("([^"]+)"\)\)/) ||
                html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match) return null;

  try {
    const payload = match[1].startsWith('{')
      ? JSON.parse(match[1])
      : JSON.parse(decodeURIComponent(match[1]));
    const serverTimestamp = Number(payload?.timestamp);
    return Number.isFinite(serverTimestamp) && serverTimestamp > 0 ? serverTimestamp : null;
  } catch {
    return null;
  }
}

function cacheServerTimeOffset(serverTimestamp, source) {
  if (Number.isFinite(serverTimestamp) && serverTimestamp > 0) {
    cachedServerTimeOffset = Date.now() - serverTimestamp;
    console.info('[yuque] server time offset cached', {
      source,
      serverTimestamp,
      offset: cachedServerTimeOffset
    });
    return true;
  }
  return false;
}

function cacheServerTimeOffsetFromDateHeader(headers) {
  const dateHeader = headers?.get?.('date');
  if (!dateHeader) return false;
  const serverTimestamp = Date.parse(dateHeader);
  return cacheServerTimeOffset(serverTimestamp, 'date-header');
}

async function ensureServerTimeOffset() {
  if (cachedServerTimeOffset !== null) return;
  try {
    const { html, headers } = await fetchDashboardPage();
    const htmlTimestamp = extractServerTimestampFromHtml(html);
    if (cacheServerTimeOffset(htmlTimestamp, 'appData.timestamp')) return;
    cacheServerTimeOffsetFromDateHeader(headers);
  } catch {}
}

/**
 * Get CSRF token from yuque.com page.
 * Tries: 1) cached value  2) cookie named 'yuque_ctoken'  3) fetch page and extract from meta tag
 */
async function getCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;

  // Try cookie first
  try {
    const cookie = await chrome.cookies.get({ url: YUQUE_API.HOME_PAGE, name: 'yuque_ctoken' });
    if (cookie?.value) { cachedCsrfToken = cookie.value; return cachedCsrfToken; }
  } catch {}

  // Fallback: fetch dashboard page and extract token from HTML
  try {
    const { html, headers } = await fetchDashboardPage();
    const htmlTimestamp = extractServerTimestampFromHtml(html);
    if (!cacheServerTimeOffset(htmlTimestamp, 'appData.timestamp')) {
      cacheServerTimeOffsetFromDateHeader(headers);
    }
    // Look for ctoken in various places
    const match = html.match(/ctoken['"]\s*(?:content|value)\s*=\s*['"]([^'"]+)['"]/) ||
                  html.match(/csrfToken\s*[:=]\s*['"]([^'"]+)['"]/) ||
                  html.match(/window\.__CSRF_TOKEN__\s*=\s*['"]([^'"]+)['"]/);
    if (match) { cachedCsrfToken = match[1]; return cachedCsrfToken; }
  } catch {}

  // Last resort: try empty string (some endpoints may not strictly require it)
  return '';
}

/**
 * Export a document via the async export API.
 * POST /api/docs/{docId}/export with {"type":"...", "force":0, "options":"..."}
 * Returns the download URL after polling for completion.
 *
 * @param {number} docId - The document ID
 * @param {string} docType - DOC_TYPES value (Doc, Sheet, Board, Table)
 * @param {string} exportFormat - Our format key (md, docx, pdf, jpg, png, xlsx)
 * @returns {Promise<{url: string, blob: Blob}>} Download URL and content blob
 */
/**
 * Parse 422 error response to extract accepted type values.
 * Example error: {"detail":[{"message":"要求是 lakeboard, lake 其中的一个","field":"type"}]}
 */
function parseAcceptedTypes(errJson) {
  if (!errJson?.detail) return [];
  for (const d of errJson.detail) {
    if (d.field === 'type' && d.message) {
      // Extract types from "要求是 X, Y 其中的一个" pattern
      const match = d.message.match(/要求是\s*(.+?)\s*其中/);
      if (match) {
        return match[1].split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
      }
    }
  }
  return [];
}

function toAbsoluteUrl(url) {
  if (!url) return url;
  if (url.startsWith('http')) return url;
  return `${YUQUE_API.HOME_PAGE}${url.startsWith('/') ? '' : '/'}${url}`;
}

export async function exportDocAsync(docId, docType, exportFormat) {
  const typeOptions = DOC_TYPE_EXPORT_OPTIONS[docType];
  if (!typeOptions) throw new Error(`不支持的文档类型: ${docType}`);

  const apiType = typeOptions.apiTypeMap[exportFormat];
  if (!apiType) throw new Error(`${docType} 不支持 ${exportFormat} 格式导出`);

  const csrfToken = await getCsrfToken();
  await throttle.wait();

  const body = { type: apiType, force: 0 };
  if (EXPORT_OPTIONS[apiType]) {
    body.options = EXPORT_OPTIONS[apiType];
  }

  const exportUrl = `${YUQUE_API.BASE}/docs/${docId}/export`;

  let resp;
  try {
    resp = await fetch(exportUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': csrfToken || '',
        'Origin': 'https://www.yuque.com',
        'Referer': 'https://www.yuque.com/',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    throw new Error(`导出请求网络错误: ${fetchErr.message}`);
  }


  if (resp.status === 401 || resp.status === 403) {
    cachedCsrfToken = null;
    throw new Error('登录态或 CSRF Token 已过期，请刷新语雀页面后重试。');
  }
  if (resp.status === 422) {
    // 422 means our type param is wrong for this doc type.
    // Parse error to find accepted types and auto-retry with first valid one.
    const errJson = await resp.json().catch(() => null);

    const acceptedTypes = parseAcceptedTypes(errJson);
    if (acceptedTypes.length > 0) {

      const retryBody = { ...body, type: acceptedTypes[0] };
      if (EXPORT_OPTIONS[acceptedTypes[0]]) retryBody.options = EXPORT_OPTIONS[acceptedTypes[0]];
      else delete retryBody.options;

      const retryResp = await fetch(exportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8', 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': csrfToken || '', 'Referer': 'https://www.yuque.com/' },
        credentials: 'include',
        body: JSON.stringify(retryBody),
      });
      if (retryResp.ok) {
        const retryResult = await retryResp.json();
        if (retryResult.data?.state === 'success' && retryResult.data?.url) {
          return await downloadExportedFile(toAbsoluteUrl(retryResult.data.url));
        }
        // Pending — update body for polling and fall through
        body.type = retryBody.type;
        if (retryBody.options) body.options = retryBody.options;
        else delete body.options;
        // Fall through to polling below
      } else {
        const retryErr = await retryResp.text().catch(() => '');
        throw new Error(`导出失败 (422 retry): HTTP ${retryResp.status} ${retryErr}`);
      }
    } else {
      throw new Error(`导出失败: 该文档类型不支持此格式 (HTTP 422)`);
    }
    // 422 retry with pending result — skip to polling
  } else if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`导出请求失败: HTTP ${resp.status}`);
  } else {
    // Normal 200 response
    const result = await resp.json();
    throttle.onSuccess();

    if (result.data?.state === 'success' && result.data?.url) {
      return await downloadExportedFile(toAbsoluteUrl(result.data.url));
    }
    // state is 'pending' — fall through to polling
  }

  // Step 3: Poll for completion
  for (let i = 0; i < EXPORT_POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, EXPORT_POLL_INTERVAL));

    let pollResp;
    try {
      pollResp = await fetch(exportUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'x-requested-with': 'XMLHttpRequest',
          'x-csrf-token': csrfToken || '',
          'Referer': 'https://www.yuque.com/',
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
    } catch { continue; }

    if (!pollResp.ok) continue;
    const pollResult = await pollResp.json();

    if (pollResult.data?.state === 'success' && pollResult.data?.url) {
      return await downloadExportedFile(toAbsoluteUrl(pollResult.data.url));
    }
    if (pollResult.data?.state === 'failed') {
      throw new Error('导出失败: 语雀服务端返回错误');
    }
    // state might be 'processing' — continue polling
  }

  throw new Error('导出超时: 轮询次数已达上限');
}

/**
 * Download the exported file from the URL returned by the export API.
 */
async function downloadExportedFile(url) {
  const isYuqueDirectUrl = url.includes('yuque.com/') && !url.includes('/attachments/__temp/');

  if (isYuqueDirectUrl) {
    // Yuque direct URLs (e.g. markdown export) need cookie auth → fetch as blob
    const resp = await fetch(url, {
      headers: { 'Referer': 'https://www.yuque.com/' },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`下载导出文件失败: HTTP ${resp.status}`);
    const blob = await resp.blob();
    return { url, blob };
  }

  // External URLs (OSS etc.) have CORS restrictions → use directUrl mode
  // Return url only, let exporter use chrome.downloads.download() directly
  return { url, blob: null, directUrl: true };
}

/**
 * Core API request function with throttle and retry.
 * Uses internal /api/ endpoints (not /api/v2/).
 */
async function fetchYuqueAPI(path, retries = 3) {
  await throttle.wait();

  for (let i = 0; i < retries; i++) {
    try {
      const url = path.startsWith('http') ? path : `${YUQUE_API.BASE}${path}`;
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
          'Origin': 'https://www.yuque.com',
          'Referer': 'https://www.yuque.com/',
        },
        credentials: 'include',
        signal: getAbortSignal()
      });

      if (resp.status === 429) {
        throttle.onRateLimit();
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        throw new Error('登录态已过期，请重新登录语雀后重试。');
      }

      if (resp.status === 404) {
        throw new Error(`API 请求失败: HTTP 404`);
      }

      if (!resp.ok) {
        throw new Error(`API 请求失败: HTTP ${resp.status}`);
      }

      throttle.onSuccess();
      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.message.includes('登录态')) throw e;
      if (e.message.includes('404')) throw e;
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

/**
 * Download an image from Yuque CDN with proper Referer.
 */
export async function downloadImage(url) {
  // Clean watermark params
  const cleanUrl = url.replace(/x-oss-process=image%2Fwatermark%2C[^&]*/, '');

  let resp;
  try {
    resp = await fetch(cleanUrl, {
      headers: {
        'Referer': 'https://www.yuque.com/',
      },
      credentials: 'include',
      signal: getAbortSignal()
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`图片请求失败，可能是跨域/防盗链拦截或网络异常: ${error?.message || 'fetch failed'}`);
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`图片请求被拒绝（HTTP ${resp.status}），可能是防盗链或登录态限制`);
    }
    if (resp.status === 404) {
      throw new Error('图片资源不存在（HTTP 404）');
    }
    if (resp.status === 429) {
      throw new Error('图片请求过于频繁（HTTP 429）');
    }
    throw new Error(`图片下载失败: HTTP ${resp.status}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`图片响应类型异常: ${contentType}`);
  }

  try {
    return await resp.blob();
  } catch (error) {
    throw new Error(`图片响应读取失败: ${error?.message || 'blob failed'}`);
  }
}

export function resetThrottle() {
  throttle.reset();
}

// ═══════════════════════════════════════════
// Bookmarks (收藏) API
// ═══════════════════════════════════════════

/**
 * Fetch user's bookmarked items (收藏列表).
 * GET /api/mine/marks?offset=0&limit=100&type=all
 * Handles pagination automatically.
 */
export async function fetchBookmarks() {
  const allActions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await fetchYuqueAPI(`/mine/marks?offset=${offset}&limit=${limit}&type=all`);
    const actions = data.data?.actions || [];
    if (!actions.length) break;
    allActions.push(...actions);
    if (actions.length < limit) break;
    offset += limit;
  }

  return allActions;
}

/**
 * Try to fetch docs for a book. Returns { docs, needsPassword }.
 * If the book requires password verification, returns needsPassword: true.
 */
export async function fetchBookDocsWithPasswordCheck(bookId) {
  try {
    const data = await fetchYuqueAPI(`/docs?book_id=${bookId}`);
    return { docs: Array.isArray(data.data) ? data.data : [], needsPassword: false };
  } catch (e) {
    // 404 with "custom-error" means password required (for books we know exist)
    if (e.message.includes('404')) {
      return { docs: [], needsPassword: true };
    }
    throw e;
  }
}

/**
 * Encrypt password using RSA for Yuque's verify API.
 * Matches Yuque web app behavior:
 * 1. align timestamp using appData.timestamp
 * 2. encrypt `${timestamp}:${password}` with RSA
 * 3. split by 100 chars before encryption if needed, join with ':'
 */
export function encryptPassword(password) {
  const encryptor = new JSEncrypt();
  encryptor.setPublicKey(YUQUE_RSA_PUBLIC_KEY);
  const alignedTimestamp = cachedServerTimeOffset === null
    ? Date.now()
    : Date.now() - cachedServerTimeOffset;
  const plaintext = `${alignedTimestamp}:${password}`;
  const chunks = [];
  let remaining = plaintext;

  while (remaining.length > 100) {
    chunks.push(remaining.slice(0, 100));
    remaining = remaining.slice(100);
  }
  if (remaining.length > 0) chunks.push(remaining);

  const encrypted = chunks.map(chunk => encryptor.encrypt(chunk, 'base64')).filter(Boolean);
  if (encrypted.length !== chunks.length) {
    throw new Error('密码加密失败');
  }
  return encrypted.join(':');
}

/**
 * Verify a book password.
 * PUT /api/books/{bookId}/verify
 * Returns true on success, throws on failure.
 */
export async function verifyBookPassword(bookId, password) {
  const csrfToken = await getCsrfToken();
  await ensureServerTimeOffset();
  const encryptedPassword = encryptPassword(password);

  const resp = await fetch(`${YUQUE_API.BASE}/books/${bookId}/verify`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': csrfToken || '',
      'Origin': 'https://www.yuque.com',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
    body: JSON.stringify({ password: encryptedPassword }),
  });

  if (resp.status === 400) {
    let detail = '密码错误';
    try {
      const err = await resp.json();
      if (err?.message) detail = `${detail}: ${err.message}`;
      if (err?.key) detail = `${detail} (${err.key})`;
    } catch {}
    throw new Error(detail);
  }
  if (resp.status === 429) {
    throw new Error('密码错误次数超限，请稍后再试');
  }
  if (!resp.ok) {
    throw new Error(`验证失败: HTTP ${resp.status}`);
  }

  return true;
}

/**
 * Verify a doc password.
 * PUT /api/docs/{docId}/verify
 * Returns true on success, throws on failure.
 */
export async function verifyDocPassword(docId, password) {
  const csrfToken = await getCsrfToken();
  await ensureServerTimeOffset();
  const encryptedPassword = encryptPassword(password);

  const resp = await fetch(`${YUQUE_API.BASE}/docs/${docId}/verify`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': csrfToken || '',
      'Origin': 'https://www.yuque.com',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
    body: JSON.stringify({ password: encryptedPassword }),
  });

  if (resp.status === 400) {
    let detail = '密码错误';
    try {
      const err = await resp.json();
      if (err?.message) detail = `${detail}: ${err.message}`;
      if (err?.key) detail = `${detail} (${err.key})`;
    } catch {}
    throw new Error(detail);
  }
  if (resp.status === 429) {
    throw new Error('密码错误次数超限，请稍后再试');
  }
  if (!resp.ok) {
    throw new Error(`验证失败: HTTP ${resp.status}`);
  }

  return true;
}
