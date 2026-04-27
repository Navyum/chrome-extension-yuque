import { YUQUE_API, SUPPORTED_DOC_TYPES, SKIPPED_DOC_TYPES, DOC_TYPES, DOC_TYPE_EXPORT_OPTIONS, EXPORT_OPTIONS, EXPORT_POLL_MAX, EXPORT_POLL_INTERVAL } from './constants.js';
import { getAbortSignal } from './task-controller.js';
import { sanitizePathComponent } from './utils.js';
import { RequestThrottle } from './throttle.js';

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
 * Build a flat document list from /api/docs?book_id= response.
 * The API returns the real doc type directly (Doc/Sheet/Board/Table).
 */
export function buildDocListFromApiDocs(docs) {
  const files = [];
  docs.forEach(doc => {
    const docType = doc.type || DOC_TYPES.DOC;
    if (!SUPPORTED_DOC_TYPES.has(docType)) return;
    files.push({
      id: doc.id,
      slug: doc.slug,
      title: doc.title || '未命名文档',
      docType,
      folderPath: '',
      status: 'pending',
      localPath: '',
      updatedAt: doc.content_updated_at || doc.updated_at,
    });
  });
  return { files, folderCount: 0 };
}

// ═══════════════════════════════════════════
// Async Export API (POST /api/docs/{docId}/export)
// ═══════════════════════════════════════════

let cachedCsrfToken = null;

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
    const resp = await fetch(`${YUQUE_API.HOME_PAGE}/dashboard`, {
      credentials: 'include',
      signal: getAbortSignal()
    });
    const html = await resp.text();
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

      if (!resp.ok) {
        throw new Error(`API 请求失败: HTTP ${resp.status}`);
      }

      throttle.onSuccess();
      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.message.includes('登录态')) throw e;
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

  const resp = await fetch(cleanUrl, {
    headers: {
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
    signal: getAbortSignal()
  });
  if (!resp.ok) {
    throw new Error(`图片下载失败: HTTP ${resp.status}`);
  }
  return await resp.blob();
}

export function resetThrottle() {
  throttle.reset();
}
