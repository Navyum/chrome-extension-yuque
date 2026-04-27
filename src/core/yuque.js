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
    console.warn('获取个人知识库失败:', e);
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
    console.warn('获取协作知识库失败:', e);
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
 * Get the TOC (table of contents) of a knowledge base by fetching the book page.
 * Falls back to /api/v2/repos/:namespace/toc if available.
 */
export async function fetchBookToc(namespace) {
  // Try the v2 API for TOC
  try {
    const data = await fetchYuqueRaw(`${YUQUE_API.HOME_PAGE}/api/v2/repos/${namespace}/toc`);
    if (data && Array.isArray(data.data)) {
      return data.data;
    }
  } catch {
    // fallback below
  }

  // Fallback: fetch book page and extract TOC from embedded data
  try {
    const resp = await fetch(`${YUQUE_API.HOME_PAGE}/${namespace}`, {
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        'Referer': YUQUE_API.HOME_PAGE,
      },
      credentials: 'include',
      signal: getAbortSignal()
    });
    const html = await resp.text();
    const match = /decodeURIComponent\("(.+?)"\)/.exec(html);
    if (match) {
      const jsonStr = decodeURIComponent(match[1]);
      const pageData = JSON.parse(jsonStr);
      if (pageData.book && Array.isArray(pageData.book.toc)) {
        return pageData.book.toc;
      }
    }
  } catch {
    // fallback failed
  }

  return [];
}

/**
 * Resolve the REAL document type from API response fields.
 * The /api/docs endpoint returns type="Doc" for ALL entries.
 * Real type must be inferred from format, sub_type, or slug patterns.
 */
function resolveDocType(doc) {
  const format = (doc.format || '').toLowerCase();
  const subType = (doc.sub_type || '').toLowerCase();
  const type = (doc.type || '').toLowerCase();
  const slug = (doc.slug || '').toLowerCase();

  // Check format field (most reliable)
  if (format === 'lakeboard' || format === 'board') return DOC_TYPES.BOARD;
  if (format === 'lakesheet' || format === 'sheet') return DOC_TYPES.SHEET;
  if (format === 'laketable' || format === 'table') return DOC_TYPES.TABLE;

  // Check sub_type field
  if (subType === 'board' || subType === 'lakeboard') return DOC_TYPES.BOARD;
  if (subType === 'sheet' || subType === 'lakesheet') return DOC_TYPES.SHEET;
  if (subType === 'table' || subType === 'laketable') return DOC_TYPES.TABLE;

  // Check type field (sometimes it's correct)
  if (type === 'sheet') return DOC_TYPES.SHEET;
  if (type === 'board') return DOC_TYPES.BOARD;
  if (type === 'table') return DOC_TYPES.TABLE;

  // Default: standard document
  return DOC_TYPES.DOC;
}

/**
 * Build a flat document list by merging TOC (for folder paths) with /api/docs (for real doc types).
 *
 * CRITICAL: TOC node.type is always "DOC" for all document entries — it does NOT distinguish
 * Sheet/Board/Table. The REAL doc type comes from /api/docs?book_id= response (doc.type field).
 * We MUST use /api/docs to get the actual type, then merge with TOC for folder paths.
 */
export async function buildDocListFromToc(toc, bookName, bookId) {
  const files = [];
  const folderSet = new Set();

  // Step 1: Fetch real doc types from /api/docs
  // CRITICAL: TOC type is always "DOC" — real type (Doc/Sheet/Board/Table) comes from this API
  let realDocTypes = new Map();
  if (bookId) {
    try {
      const docs = await fetchBookDocs(bookId);
      docs.forEach(doc => {
        console.log(`[YuqueOut] doc id=${doc.id}(${typeof doc.id}), type="${doc.type}", format="${doc.format}", title="${doc.title}"`);
        const realType = resolveDocType(doc);
        // Store with both number and string key to handle type mismatch
        realDocTypes.set(doc.id, realType);
        realDocTypes.set(String(doc.id), realType);
      });
      console.log(`[YuqueOut] realDocTypes size: ${realDocTypes.size}`);
    } catch (e) {
      console.warn('[YuqueOut] Failed to fetch doc types:', e);
    }
  }

  // Step 2: Build uuid -> node map for folder path resolution
  const nodeMap = new Map();
  toc.forEach(node => { nodeMap.set(node.uuid, node); });

  const getPath = (node) => {
    const parts = [];
    let current = node;
    while (current && current.parent_uuid && current.parent_uuid !== '') {
      const parent = nodeMap.get(current.parent_uuid);
      if (parent && parent.type === 'TITLE') {
        parts.unshift(sanitizePathComponent(parent.title) || '未命名文件夹');
        folderSet.add(parent.uuid);
      }
      current = parent;
    }
    return parts.join('/');
  };

  // Step 3: Build file list, using REAL type from /api/docs
  toc.forEach(node => {
    // TOC type "DOC" means it's a document entry (not a folder "TITLE")
    if (node.type !== 'DOC' || !(node.url || node.slug)) return;

    const docId = node.doc_id || node.id;
    // Try both number and string lookups
    const realType = realDocTypes.get(docId) || realDocTypes.get(String(docId)) || realDocTypes.get(Number(docId)) || DOC_TYPES.DOC;
    console.log(`[YuqueOut] TOC node: docId=${docId}(${typeof docId}), resolved=${realType}, title="${node.title}"`);

    if (!SUPPORTED_DOC_TYPES.has(realType)) return;

    files.push({
      id: docId,
      slug: node.url || node.slug,
      title: node.title || '未命名文档',
      docType: realType,  // REAL type from API, not TOC
      folderPath: getPath(node),
      status: 'pending',
      localPath: '',
    });
  });

  return { files, folderCount: folderSet.size };
}

/**
 * Build a flat document list from /api/docs response (no folder structure).
 * Fallback when TOC is unavailable.
 */
export function buildDocListFromApiDocs(docs) {
  const files = [];
  docs.forEach(doc => {
    const docType = resolveDocType(doc);
    if (!SUPPORTED_DOC_TYPES.has(docType)) return;
    files.push({
      id: doc.id,
      slug: doc.slug,
      title: doc.title || '未命名文档',
      docType: docType,
      folderPath: '',
      status: 'pending',
      localPath: '',
      updatedAt: doc.content_updated_at || doc.updated_at,
    });
  });
  return { files, folderCount: 0 };
}

/**
 * Get a single document's detail.
 * Uses /api/docs/{slug}?book_id={bookId}&mode=markdown for Markdown source.
 * Uses /api/docs/{slug}?book_id={bookId}&merge_dynamic_data=false for HTML.
 */
export async function fetchDocDetail(bookId, docSlug, options = {}) {
  const mode = options.markdown ? '&mode=markdown' : '';
  const data = await fetchYuqueAPI(`/docs/${docSlug}?book_id=${bookId}&merge_dynamic_data=false${mode}`);
  return data.data || {};
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
  console.log(`[YuqueOut] POST ${exportUrl}`, JSON.stringify(body), `csrf="${csrfToken}"`);

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
    console.error(`[YuqueOut] fetch error:`, fetchErr);
    throw new Error(`导出请求网络错误: ${fetchErr.message}`);
  }

  console.log(`[YuqueOut] POST response: ${resp.status}`);

  if (resp.status === 401 || resp.status === 403) {
    cachedCsrfToken = null;
    throw new Error('登录态或 CSRF Token 已过期，请刷新语雀页面后重试。');
  }
  if (resp.status === 422) {
    // 422 means our type param is wrong for this doc type.
    // Parse error to find accepted types and auto-retry with first valid one.
    const errJson = await resp.json().catch(() => null);
    console.error(`[YuqueOut] Export 422:`, JSON.stringify(errJson));

    const acceptedTypes = parseAcceptedTypes(errJson);
    if (acceptedTypes.length > 0) {
      console.log(`[YuqueOut] 422 auto-retry with accepted type: "${acceptedTypes[0]}"`);
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
    console.error(`[YuqueOut] Export API error: ${resp.status}`, errText);
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
  console.log(`[YuqueOut] Downloading exported file: ${url}`);
  // For yuque.com URLs: use credentials (may need cookie for auth)
  // For non-yuque URLs or /attachments/ paths that redirect to OSS: no credentials
  // because OSS returns Access-Control-Allow-Origin:* which conflicts with credentials:include
  const isYuqueDirectUrl = url.includes('yuque.com/') && !url.includes('/attachments/__temp/');
  const fetchOpts = { headers: { 'Referer': 'https://www.yuque.com/' } };
  if (isYuqueDirectUrl) fetchOpts.credentials = 'include';

  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) throw new Error(`下载导出文件失败: HTTP ${resp.status}`);
  const blob = await resp.blob();
  return { url, blob };
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
 * Raw fetch for specific URLs (e.g., v2 API).
 */
async function fetchYuqueRaw(url) {
  await throttle.wait();
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
    signal: getAbortSignal()
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  throttle.onSuccess();
  return await resp.json();
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
