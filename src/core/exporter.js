import { exportState, resetExportState, saveState } from './state.js';
import { sendLog, sendProgress, sendComplete, sendError } from './messaging.js';
import { checkAuth, fetchAllBooks, fetchBookDocs, buildDocListFromApiDocs, exportDocAsync, downloadImage, resetThrottle, fetchBookmarks, fetchBookDocsWithPasswordCheck, verifyBookPassword, verifyDocPassword, fetchBookToc } from './yuque.js';
import { lakeToMarkdown, fetchDocContent } from './lake-converter.js';
import { convertLakeSheet } from './sheet-converter.js';
import { convertBoardToSvg } from './board-converter.js';
import { saveBlobToDisk, saveContentToDisk, downloadUrlToDisk } from './downloads.js';
import { delay, sanitizePathComponent, sanitizePathSegments, guessImageExt } from './utils.js';
import { refreshAbortController, abortActiveTasks } from './task-controller.js';
import { EXPORT_FORMATS, DEFAULT_SETTINGS, DOC_TYPES, DOC_TYPE_EXPORT_OPTIONS, SMART_EXPORT_KEY, BOOKMARKS_VIRTUAL_BOOK_ID, BOOKMARKS_VIRTUAL_BOOK_NAME, BOOKMARKS_LOOSE_DOCS_FOLDER, SUPPORTED_DOC_TYPES } from './constants.js';

export function registerRuntimeHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'checkAuth':
        handleCheckAuth(sendResponse);
        return true;
      case 'getBooks':
        handleGetBooks(sendResponse);
        return true;
      case 'getFileInfo':
        handleGetFileInfo(message.data, sendResponse);
        return true;
      case 'startExport':
        handleStartExport(message.data, sendResponse);
        return true;
      case 'togglePause':
        handleTogglePause(message.data);
        return false;
      case 'getUiState':
        sendResponse({ success: true, data: exportState });
        return false;
      case 'retryFailedFiles':
        handleRetryFailedFiles(sendResponse);
        return true;
      case 'resetExport':
        handleResetExport(sendResponse);
        return true;
      case 'verifyPassword':
        handleVerifyPassword(message.data, sendResponse);
        return true;
      case 'skipEncrypted':
        handleSkipEncrypted(message.data, sendResponse);
        return true;
      case 'getPageDocInfo':
        handleGetPageDocInfo(sender, sendResponse);
        return true;
      case 'quickExport':
        handleQuickExport(message.data, sendResponse);
        return true;
      default:
        return false;
    }
  });
}

export async function maybeResumeExport() {
  if (exportState.isExporting && !exportState.isPaused) {
    sendLog('检测到中断的导出任务，正在尝试恢复...');
    exportFiles();
  }
}

async function handleCheckAuth(sendResponse) {
  try {
    const authInfo = await checkAuth();
    if (authInfo.isLoggedIn) {
      exportState.userInfo = authInfo;
      await saveState();
    }
    sendResponse({ success: true, data: authInfo });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetBooks(sendResponse) {
  try {
    if (!exportState.userInfo || !exportState.userInfo.login) {
      const authInfo = await checkAuth();
      if (!authInfo.isLoggedIn) {
        throw new Error('未登录，请先在浏览器中登录语雀。');
      }
      exportState.userInfo = authInfo;
    }
    sendLog('正在获取知识库列表...');
    const books = await fetchAllBooks();
    exportState.bookList = books;
    await saveState();
    sendLog(`成功获取 ${books.length} 个知识库。`);
    sendResponse({ success: true, data: books });
  } catch (error) {
    sendLog(`获取知识库列表失败: ${error.message}`);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetFileInfo(data, sendResponse) {
  try {
    const selectedBookIds = data?.bookIds || [];
    if (!selectedBookIds.length) {
      throw new Error('请至少选择一个知识库。');
    }

    if (!exportState.userInfo || !exportState.userInfo.login) {
      const authInfo = await checkAuth();
      if (!authInfo.isLoggedIn) throw new Error('未登录语雀');
      exportState.userInfo = authInfo;
    }

    sendLog('开始获取文档列表...');
    const allFiles = [];
    let totalFolders = 0;
    exportState.encryptedItems = [];
    const hasBookmarks = selectedBookIds.includes(BOOKMARKS_VIRTUAL_BOOK_ID);
    const regularBookIds = selectedBookIds.filter(id => id !== BOOKMARKS_VIRTUAL_BOOK_ID);

    // Process regular books
    for (const bookId of regularBookIds) {
      const book = exportState.bookList.find(b => b.id === bookId);
      if (!book) continue;

      sendLog(`获取知识库「${book.name}」的文档列表...`);
      const docs = await fetchBookDocs(book.id);
      const toc = await loadBookToc(book.namespace, book.name);
      const { files, folderCount } = buildDocListFromApiDocs(docs, toc);

      files.forEach(f => {
        f.bookId = book.id;
        f.bookName = book.name;
        f.bookNamespace = book.namespace;
        f.bookType = book.type; // 'personal' or 'collab'
      });

      const typeCounts = {};
      files.forEach(f => { typeCounts[f.docType] = (typeCounts[f.docType] || 0) + 1; });
      const typeStr = Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ');
      sendLog(`  文档类型: ${typeStr}`);

      allFiles.push(...files);
      totalFolders += folderCount;
    }

    // Process bookmarks (收藏)
    if (hasBookmarks) {
      sendLog('获取收藏列表...');
      const bookmarkFiles = await buildBookmarkFileList();
      allFiles.push(...bookmarkFiles.files);
      totalFolders += bookmarkFiles.folderCount;
      exportState.encryptedItems = bookmarkFiles.encryptedItems;

      const encryptedCount = exportState.encryptedItems.length;
      if (encryptedCount > 0) sendLog(`发现 ${encryptedCount} 个加密项，将在未加密内容下载完成后处理。`);
    }

    if (allFiles.length === 0) {
      if (exportState.encryptedItems.length > 0) {
        exportState.fileList = [];
        exportState.totalFiles = 0;
        exportState.folderCount = 0;
        exportState.currentFileIndex = 0;
        await saveState();
        sendLog(`未发现可直接导出的文档，先处理 ${exportState.encryptedItems.length} 个加密项。`);
        sendResponse({ success: true, data: exportState });
        chrome.runtime.sendMessage({
            action: 'showPasswordDialog',
            data: { encryptedItems: exportState.encryptedItems }
          }).catch(() => {});
        return;
      }

      throw new Error('所选知识库中未获取到任何文档。');
    }

    exportState.fileList = allFiles.map(file => ({ ...file, status: 'pending', localPath: '' }));
    exportState.totalFiles = allFiles.length;
    exportState.folderCount = totalFolders;
    exportState.currentFileIndex = 0;

    await saveState();
    sendLog(`成功获取 ${allFiles.length} 个文档，${totalFolders} 个文件夹。`);
    sendResponse({ success: true, data: exportState });
  } catch (error) {
    const message = error.message.includes('登录')
      ? '未检测到登录态，请确认已在 https://www.yuque.com 登录后重试。'
      : error.message;
    sendLog(`获取文件信息失败: ${message}`);
    sendResponse({ success: false, error: message });
  }
}

async function handleStartExport(data, sendResponse) {
  if (!exportState.fileList.length) {
    sendResponse({ success: false, error: '文件列表为空，请先获取文件信息。' });
    return;
  }

  try {
    const authInfo = await checkAuth();
    if (!authInfo.isLoggedIn) throw new Error('登录态已过期');

    const settings = await chrome.storage.local.get([
      'subfolder', 'requestInterval',
      'downloadImages', 'imageConcurrency',
      'docExportFormat', 'sheetExportFormat', 'boardExportFormat', 'tableExportFormat',
      'markdownMode', 'sheetMode'
    ]);

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.exportType = data?.exportType || 'smart';
    exportState.subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.downloadImages = settings.downloadImages !== false;
    exportState.imageConcurrency = settings.imageConcurrency || DEFAULT_SETTINGS.imageConcurrency;
    exportState.docExportFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat;
    exportState.sheetExportFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat;
    exportState.boardExportFormat = settings.boardExportFormat || DEFAULT_SETTINGS.boardExportFormat;
    exportState.tableExportFormat = settings.tableExportFormat || DEFAULT_SETTINGS.tableExportFormat;
    exportState.markdownMode = settings.markdownMode || DEFAULT_SETTINGS.markdownMode;
    exportState.sheetMode = settings.sheetMode || DEFAULT_SETTINGS.sheetMode;
    // Keep existing logs (file info phase logs) instead of clearing
    // exportState.logs = [];

    exportState.fileList.forEach(file => {
      if (file.status !== 'success') {
        file.status = 'pending';
      }
    });

    refreshAbortController();
    resetThrottle();

    await saveState();
    sendResponse({ success: true });
    exportFiles();
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleRetryFailedFiles(sendResponse) {
  if (exportState.isExporting) {
    sendResponse({ success: false, error: '当前有任务正在运行，请先暂停或重置。' });
    return;
  }

  const failedFiles = exportState.fileList.filter(file => file.status === 'failed');
  if (!failedFiles.length) {
    sendResponse({ success: false, error: '没有失败的文件需要重试。' });
    return;
  }

  try {
    const authInfo = await checkAuth();
    if (!authInfo.isLoggedIn) throw new Error('登录态已过期');

    const settings = await chrome.storage.local.get([
      'subfolder', 'exportType', 'downloadImages', 'imageConcurrency',
      'docExportFormat', 'sheetExportFormat', 'boardExportFormat', 'tableExportFormat',
      'markdownMode', 'sheetMode'
    ]);

    exportState.fileList.forEach(file => {
      if (file.status === 'failed') file.status = 'pending';
    });

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.exportType = settings.exportType || 'smart';
    exportState.docExportFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat;
    exportState.sheetExportFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat;
    exportState.boardExportFormat = settings.boardExportFormat || DEFAULT_SETTINGS.boardExportFormat;
    exportState.tableExportFormat = settings.tableExportFormat || DEFAULT_SETTINGS.tableExportFormat;
    exportState.markdownMode = settings.markdownMode || DEFAULT_SETTINGS.markdownMode;
    exportState.sheetMode = settings.sheetMode || DEFAULT_SETTINGS.sheetMode;
    // Keep existing logs for retry context

    refreshAbortController();
    resetThrottle();

    await saveState();
    sendResponse({ success: true });
    exportFiles();
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleResetExport(sendResponse) {
  abortActiveTasks();
  refreshAbortController();
  resetExportState();
  await saveState();
  sendResponse({ success: true, data: exportState });
}

async function handleTogglePause(data) {
  if (!exportState.isExporting) {
    sendLog('没有正在进行的任务，忽略暂停/继续指令。');
    return;
  }
  exportState.isPaused = data?.isPaused ?? false;
  sendLog(exportState.isPaused ? '导出已暂停。' : '导出已继续。');
  await saveState();
}

async function exportFiles() {
  try {
    const filesToProcess = exportState.fileList;
    const totalCount = filesToProcess.length;
    let lastPeriodicSaveAt = 0;
    for (let i = exportState.currentFileIndex; i < totalCount; i++) {
      if (!exportState.isExporting) {
        sendLog('导出流程已被取消。');
        return;
      }

      await waitIfPaused();

      const file = filesToProcess[i];
      exportState.currentFileIndex = i;

      if (file.status !== 'pending') continue;

      file.status = 'in_progress';
      file.startTime = Date.now();
      file.retryCount = 0;
      if (Date.now() - lastPeriodicSaveAt >= 3000) {
        await saveState();
        lastPeriodicSaveAt = Date.now();
      }
      sendLog(`(进度 ${i + 1}/${totalCount}) 处理 ${file.title}...`);

      const MAX_RETRIES = 2;
      let success = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            sendLog(`重试第 ${attempt} 次: ${file.title}`);
            await delay(2000 * attempt);
          }

          file.retryCount = attempt;

          // Determine export format based on doc type
          const docType = file.docType || DOC_TYPES.DOC;
          const perTypeFormat = getPerTypeFormat(docType);
          const format = EXPORT_FORMATS[perTypeFormat];
          if (!format) throw new Error(`未知导出格式: ${perTypeFormat}`);

          sendLog(`  类型: ${docType} → ${format.label}`);

          // Determine conversion path
          const isSheet = docType === DOC_TYPES.SHEET;
          const isBoard = docType === DOC_TYPES.BOARD;
          const noExportPermission = file.isBookmark || file.bookType === 'collab';
          const useLocalSheetConvert = isSheet && (
            exportState.sheetMode === 'local' ||
            perTypeFormat !== 'xlsx' ||
            noExportPermission
          );
          const useLocalDocConvert = !isSheet && !isBoard && perTypeFormat === 'md' &&
            (exportState.markdownMode === 'local' || noExportPermission);

          if (isBoard && file.slug && (file.bookSourceId || file.bookId)) {
            await exportViaBoardContent(file, perTypeFormat);
          } else if (useLocalSheetConvert && file.slug && (file.bookSourceId || file.bookId)) {
            await exportViaSheetContent(file, perTypeFormat);
          } else if (useLocalDocConvert && file.slug && (file.bookSourceId || file.bookId)) {
            await exportViaLakeContent(file, format, perTypeFormat);
          } else {
            // Use async export API — with fallback to local conversion on failure
            try {
              const result = await exportDocAsync(file.id, docType, perTypeFormat);
              const savedPath = buildFilePath(file, format.extension);

              if (result.directUrl) {
                await downloadUrlToDisk(result.url, savedPath);
              } else if (perTypeFormat === 'md' && exportState.downloadImages && result.blob) {
                const mdText = await result.blob.text();
                const { localizedMd, imageCount } = await localizeMarkdownImages(mdText, file);
                await saveContentToDisk(localizedMd, file, format.extension, 'text/markdown');
                if (imageCount > 0) sendLog(`  图片本地化: ${imageCount} 张`);
              } else if (result.blob) {
                await saveBlobToDisk(result.blob, savedPath);
              }
            } catch (apiErr) {
              // Fallback: if export API fails and we have slug, try local conversion
              if (file.slug && (file.bookSourceId || file.bookId)) {
                sendLog(`  官方导出失败，自动切换本地转换: ${apiErr.message}`);
                if (isSheet) {
                  await exportViaSheetContent(file, perTypeFormat);
                } else if (perTypeFormat === 'md') {
                  await exportViaLakeContent(file, format, perTypeFormat);
                } else {
                  throw apiErr;
                }
              } else {
                throw apiErr;
              }
            }
          }

          file.status = 'success';
          file.localPath = buildFilePath(file, format.extension);
          file.endTime = Date.now();
          file.duration = file.endTime - file.startTime;
          sendLog(`导出完成: ${file.title} (耗时 ${(file.duration / 1000).toFixed(2)}s)`);
          sendProgress();

          success = true;
          break;
        } catch (error) {
          if (error.name === 'AbortError') {
            sendLog('检测到中止信号，结束导出流程。');
            return;
          }
          sendLog(`导出失败: ${file.title} -> ${error.message}`);
        }
      }

      if (!success) {
        file.status = 'failed';
        file.endTime = Date.now();
        file.duration = file.endTime - file.startTime;
        sendLog(`已将 ${file.title} 标记为失败。`);
      }

      // Save state every 10 files to reduce IO, always save on failure
      if (!success || i % 10 === 0 || Date.now() - lastPeriodicSaveAt >= 5000) {
        await saveState();
        lastPeriodicSaveAt = Date.now();
      }

      // Throttle between documents
      const interval = exportState.requestInterval || DEFAULT_SETTINGS.requestInterval;
      await delay(interval + Math.random() * 500);
    }

    if (!exportState.isExporting) {
      sendLog('导出被外部中止，跳过收尾。');
      return;
    }

    exportState.isExporting = false;
    await saveState();

    const failedCount = exportState.fileList.filter(f => f.status === 'failed').length;
    const successCount = exportState.fileList.filter(f => f.status === 'success').length;

    sendLog(`导出完成！成功: ${successCount}, 失败: ${failedCount}`);

    // Notify about encrypted items that need password
    const encryptedItems = exportState.encryptedItems || [];
    if (encryptedItems.length > 0) {
      const settings = await chrome.storage.local.get(['skipEncryptedBookmarks']);
      if (settings.skipEncryptedBookmarks) {
        sendLog(`已跳过 ${encryptedItems.length} 个加密项（设置中已开启"跳过加密内容"）。`);
        exportState.encryptedItems = [];
        await saveState();
      } else {
        sendLog(`还有 ${encryptedItems.length} 个加密项需要输入密码后下载。`);
        chrome.runtime.sendMessage({
            action: 'showPasswordDialog',
            data: { encryptedItems }
          }).catch(() => {});
      }
    }

    sendComplete();
  } catch (error) {
    if (error.name === 'AbortError') {
      sendLog('导出流程已被重置。');
      return;
    }
    exportState.isExporting = false;
    await saveState();
    sendLog(`导出流程发生异常: ${error.message}`);
    sendError(error.message);
  }
}

/**
 * Parse Markdown text, download CDN images to local, replace URLs.
 */
async function localizeMarkdownImages(mdText, file, imageBasePath, imageConcurrencyOverride, logFn = sendLog) {
  const cdnHosts = ['cdn.nlark.com', 'cdn.yuque.com', 'cdn-china-mainland.yuque.com'];
  const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const images = [];
  let match;

  while ((match = imgRegex.exec(mdText)) !== null) {
    const url = match[2];
    if (cdnHosts.some(h => url.includes(h))) {
      images.push({ fullMatch: match[0], alt: match[1], url });
    }
  }

  if (!images.length) return { localizedMd: mdText, imageCount: 0 };

  const concurrency = Math.min(
    imageConcurrencyOverride ?? exportState.imageConcurrency ?? DEFAULT_SETTINGS.imageConcurrency,
    3
  );

  // Pre-assign sequential index to each image to avoid race conditions
  const tasks = images.map((img, idx) => ({ ...img, idx: idx + 1 }));
  const results = []; // { fullMatch, alt, localName }

  const queue = [...tasks];
  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      try {
        const ext = guessImageExt(task.url);
        const localName = `assets/${sanitizePathComponent(file.title)}-${task.idx}.${ext}`;
        const downloadPath = imageBasePath !== undefined && imageBasePath !== null
          ? (imageBasePath ? `${imageBasePath}/${localName}` : localName)
          : buildImagePath(file, localName);
        const cleanUrl = task.url.replace(/x-oss-process=image%2Fwatermark%2C[^&]*/, '');
        let blob;
        try {
          blob = await downloadImage(cleanUrl);
        } catch (error) {
          throw new Error(`请求阶段失败: ${error.message}`);
        }

        try {
          await saveBlobToDisk(blob, downloadPath);
        } catch (error) {
          throw new Error(`保存阶段失败: ${error.message}`);
        }

        results.push({ fullMatch: task.fullMatch, alt: task.alt, localName });
      } catch (e) {
        logFn(`  图片下载失败: ${task.url.substring(0, 80)}... ${e.message}`);
      }
    }
  });

  await Promise.all(workers);

  // Apply all replacements sequentially after downloads complete
  let localizedMd = mdText;
  for (const r of results) {
    localizedMd = localizedMd.replace(r.fullMatch, `![${r.alt}](${r.localName})`);
  }

  return { localizedMd, imageCount: results.length };
}

function buildImagePath(file, localName) {
  const segments = [];
  if (exportState.subfolder) segments.push(...sanitizePathSegments(exportState.subfolder));
  if (file.bookName) segments.push(...sanitizePathSegments(file.bookName));
  if (file.folderPath) segments.push(...sanitizePathSegments(file.folderPath));
  segments.push(localName);
  return segments.filter(Boolean).join('/');
}

/**
 * Get the export format for a given doc type.
 * If popup selected "smart", use per-type setting from settings page.
 * If popup selected a specific format (e.g. "pdf"), use it only if the doc type supports it,
 * otherwise fall back to that type's default.
 */
function getPerTypeFormat(docType) {
  const typeOptions = DOC_TYPE_EXPORT_OPTIONS[docType];
  if (!typeOptions) return 'md';

  const globalChoice = exportState.exportType;

  // "smart" mode: use per-type settings
  if (!globalChoice || globalChoice === SMART_EXPORT_KEY) {
    switch (docType) {
      case DOC_TYPES.SHEET: return exportState.sheetExportFormat || typeOptions.defaultFormat;
      case DOC_TYPES.BOARD: return exportState.boardExportFormat || typeOptions.defaultFormat;
      case DOC_TYPES.TABLE: return exportState.tableExportFormat || typeOptions.defaultFormat;
      default: return exportState.docExportFormat || typeOptions.defaultFormat;
    }
  }

  // Specific format chosen in popup: check if this doc type supports it
  if (typeOptions.formats.includes(globalChoice)) {
    return globalChoice;
  }

  // This doc type doesn't support the chosen format — fall back to its default
  return typeOptions.defaultFormat;
}

/**
 * Build the relative download path for a file.
 */
function buildFilePath(file, extension) {
  const segments = [];
  if (exportState.subfolder) segments.push(...sanitizePathSegments(exportState.subfolder));
  if (file.bookName) segments.push(...sanitizePathSegments(file.bookName));
  if (file.folderPath) segments.push(...sanitizePathSegments(file.folderPath));
  segments.push(`${sanitizePathComponent(file.title) || '未命名文档'}.${extension}`);
  return segments.filter(Boolean).join('/');
}

/**
 * Export a doc by fetching Lake HTML content and converting to Markdown locally.
 * Used for: bookmark docs (no export permission) and when markdownMode='local'.
 */
async function exportViaLakeContent(file, format, perTypeFormat) {
  const bookId = file.bookSourceId || file.bookId;
  sendLog(`  使用本地转换模式...`);

  const { content } = await fetchDocContent(file.slug, bookId);

  if (!content) {
    throw new Error('文档内容为空');
  }

  // Convert Lake HTML to Markdown
  const markdown = lakeToMarkdown(content);

  if (exportState.downloadImages) {
    const { localizedMd, imageCount } = await localizeMarkdownImages(markdown, file);
    await saveContentToDisk(localizedMd, file, 'md', 'text/markdown');
    if (imageCount > 0) sendLog(`  图片本地化: ${imageCount} 张`);
  } else {
    await saveContentToDisk(markdown, file, 'md', 'text/markdown');
  }
}

/**
 * Export a Board doc by fetching content, converting to SVG, then to PNG/JPG via offscreen.
 */
async function exportViaBoardContent(file, perTypeFormat) {
  const bookId = file.bookSourceId || file.bookId;
  sendLog(`  使用本地白板转换 (${perTypeFormat})...`);

  const { content, body } = await fetchDocContent(file.slug, bookId);
  const boardContent = content || body;
  if (!boardContent) throw new Error('白板内容为空');

  const { svg, width, height } = await convertBoardToSvg(boardContent);

  if (perTypeFormat === 'svg') {
    // SVG: save directly as text
    await saveContentToDisk(svg, file, 'svg', 'image/svg+xml');
  } else {
    // PNG/JPG: convert via offscreen document
    const dataUrl = await svgToImageViaOffscreen(svg, width, height, perTypeFormat);
    const savedPath = buildFilePath(file, perTypeFormat === 'jpg' ? 'jpg' : 'png');
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    await saveBlobToDisk(blob, savedPath);
  }
}

/**
 * Use Chrome offscreen API to convert SVG → PNG/JPG.
 */
let offscreenTaskQueue = Promise.resolve();

async function svgToImageViaOffscreen(svg, width, height, format) {
  const runTask = async () => {
    // Ensure offscreen document exists. This is serialized because the offscreen
    // document uses a shared canvas and Chrome only allows one instance anyway.
    const offscreenUrl = 'src/offscreen.html';
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(offscreenUrl)]
    });

    if (!existingContexts.length) {
      try {
        await chrome.offscreen.createDocument({
          url: offscreenUrl,
          reasons: ['DOM_PARSER'],
          justification: 'Convert SVG to image via Canvas'
        });
      } catch (error) {
        if (!String(error?.message || '').includes('Only a single offscreen')) {
          throw error;
        }
      }
    }

    const response = await chrome.runtime.sendMessage({
      action: 'svgToImage',
      data: { svg, width, height, format }
    });

    if (response?.error) throw new Error(`图片转换失败: ${response.error}`);
    return response.dataUrl;
  };

  const task = offscreenTaskQueue.then(runTask, runTask);
  offscreenTaskQueue = task.catch(() => {});
  return task;
}

/**
 * Export a Sheet doc by fetching its content/body and converting locally.
 * Supports xlsx, csv, md, html formats.
 */
async function exportViaSheetContent(file, perTypeFormat) {
  const bookId = file.bookSourceId || file.bookId;
  sendLog(`  使用本地表格转换 (${perTypeFormat})...`);

  const { content, body } = await fetchDocContent(file.slug, bookId);
  const sheetContent = content || body;
  if (!sheetContent) throw new Error('表格内容为空');

  const result = convertLakeSheet(sheetContent, perTypeFormat);
  const savedPath = buildFilePath(file, result.extension);

  if (result.blob) {
    await saveBlobToDisk(result.blob, savedPath);
  } else {
    await saveContentToDisk(result.text, file, result.extension, result.mime);
  }
}

async function waitIfPaused() {
  if (!exportState.isPaused) return;
  sendLog('导出已暂停，等待继续...');
  while (exportState.isPaused) {
    await delay(1000);
    if (!exportState.isExporting) {
      throw new Error('导出已被取消');
    }
  }
  sendLog('检测到继续指令，恢复导出。');
}

// ═══════════════════════════════════════════
// Bookmarks (收藏) handling
// ═══════════════════════════════════════════

/**
 * Build file list from user's bookmarks.
 * - mark_doc → individual doc, grouped by its book name
 * - mark_book → fetch all docs in that book
 * Encrypted items are tracked separately.
 */
async function buildBookmarkFileList() {
  const actions = await fetchBookmarks();
  const files = [];
  const encryptedItems = [];
  let folderCount = 0;

  // Separate mark_doc and mark_book
  const markDocs = actions.filter(a => a.action_name === 'mark_doc' && a.target);
  const markBooks = actions.filter(a => a.action_name === 'mark_book' && a.target);

  sendLog(`收藏列表: ${markDocs.length} 篇文档, ${markBooks.length} 个知识库`);

  // Process mark_doc items
  for (const action of markDocs) {
    const doc = action.target;
    if (!doc) continue;

    // Check if doc is encrypted
    if (doc.isEncrypted) {
      encryptedItems.push({
        type: 'doc',
        id: doc.id,
        title: doc.title || '未命名文档',
        bookId: action.target_book_id,
        bookName: action.target_book?.name || doc.book?.name || BOOKMARKS_LOOSE_DOCS_FOLDER,
        bookSourceId: doc.book_id || action.target_book_id,
        slug: doc.slug || '',
        docType: doc.type || DOC_TYPES.DOC,
        updatedAt: doc.content_updated_at || doc.updated_at,
        isBookmark: true,
      });
      sendLog(`  跳过加密文档: ${doc.title}`);
      continue;
    }

    const docType = doc.type || DOC_TYPES.DOC;
    if (!SUPPORTED_DOC_TYPES.has(docType)) continue;

    const bookName = action.target_book?.name || doc.book?.name || BOOKMARKS_LOOSE_DOCS_FOLDER;
    files.push({
      id: doc.id,
      slug: doc.slug,
      title: doc.title || '未命名文档',
      docType,
      folderPath: '',
      status: 'pending',
      localPath: '',
      updatedAt: doc.content_updated_at || doc.updated_at,
      bookId: action.target_book_id || doc.book_id,
      bookSourceId: doc.book_id || action.target_book_id,
      bookName: `${BOOKMARKS_VIRTUAL_BOOK_NAME}/${sanitizePathComponent(bookName)}`,
      bookNamespace: '',
      isBookmark: true,
    });
  }

  // Process mark_book items
  for (const action of markBooks) {
    const book = action.target;
    if (!book) continue;

    sendLog(`获取收藏知识库「${book.name}」的文档列表...`);

    const { docs, needsPassword } = await fetchBookDocsWithPasswordCheck(book.id);

    if (needsPassword) {
      encryptedItems.push({
        type: 'book',
        id: book.id,
        title: book.name || '未命名知识库',
        bookName: book.name,
        bookNamespace: getBookNamespace(book),
      });
      sendLog(`  知识库「${book.name}」需要密码验证，稍后处理。`);
      continue;
    }

    const bookNamespace = getBookNamespace(book);
    const toc = await loadBookToc(bookNamespace, book.name);
    const { files: bookFiles, folderCount: bookmarkFolderCount } = buildDocListFromApiDocs(docs, toc);
    bookFiles.forEach(f => {
      f.bookId = book.id;
      f.bookName = `${BOOKMARKS_VIRTUAL_BOOK_NAME}/${sanitizePathComponent(book.name)}`;
      f.bookNamespace = '';
    });

    if (bookmarkFolderCount > 0) {
      folderCount += bookmarkFolderCount;
    } else if (bookFiles.length > 0) {
      folderCount++;
      sendLog(`  获取到 ${bookFiles.length} 篇文档。`);
    }

    files.push(...bookFiles);
  }

  return { files, folderCount, encryptedItems };
}

/**
 * Handle password verification request from popup.
 */
async function handleVerifyPassword(data, sendResponse) {
  const { bookId, password, itemType } = data;
  try {
    if (itemType === 'book') {
      await verifyBookPassword(bookId, password);
      // After verification, fetch docs
      const docs = await fetchBookDocs(bookId);
      const toc = await loadBookToc(data.bookNamespace, data.bookName || '已解密知识库');
      const { files } = buildDocListFromApiDocs(docs, toc);
      files.forEach(f => {
        f.bookId = bookId;
        f.bookName = `${BOOKMARKS_VIRTUAL_BOOK_NAME}/${sanitizePathComponent(data.bookName || '已解密知识库')}`;
        f.bookNamespace = '';
        f.status = 'pending';
      });

      // Add to fileList and update state
      exportState.fileList.push(...files);
      exportState.totalFiles = exportState.fileList.length;

      // Remove from encryptedItems
      if (exportState.encryptedItems) {
        exportState.encryptedItems = exportState.encryptedItems.filter(
          item => !(item.type === 'book' && item.id === bookId)
        );
      }

      await saveState();
      sendLog(`知识库「${data.bookName}」密码验证成功，新增 ${files.length} 篇文档。`);
      sendResponse({ success: true, newFiles: files.length, remaining: exportState.encryptedItems?.length || 0 });
    } else {
      if (!data.docId) {
        throw new Error('缺少文档信息，无法验证加密文档');
      }

      await verifyDocPassword(data.docId, password);

      // Remove from encryptedItems
      if (exportState.encryptedItems) {
        exportState.encryptedItems = exportState.encryptedItems.filter(
          item => !(item.type === 'doc' && item.id === data.docId)
        );
      }

      // Add the doc to fileList
      const docType = data.docType || DOC_TYPES.DOC;
      exportState.fileList.push({
        id: data.docId,
        slug: data.slug || '',
        title: data.title || '未命名文档',
        docType,
        folderPath: '',
        status: 'pending',
        localPath: '',
        bookId: data.bookId,
        bookSourceId: data.bookSourceId || data.bookId,
        bookName: `${BOOKMARKS_VIRTUAL_BOOK_NAME}/${sanitizePathComponent(data.bookName || BOOKMARKS_LOOSE_DOCS_FOLDER)}`,
        bookNamespace: '',
        updatedAt: data.updatedAt,
        isBookmark: data.isBookmark !== false,
      });
      exportState.totalFiles = exportState.fileList.length;
      await saveState();

      sendLog(`文档「${data.title}」密码验证成功。`);
      sendResponse({ success: true, newFiles: 1, remaining: exportState.encryptedItems?.length || 0 });
    }
  } catch (error) {
    sendLog(`密码验证失败: ${error.message}`);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Skip an encrypted item.
 */
async function handleSkipEncrypted(data, sendResponse) {
  if (exportState.encryptedItems) {
    exportState.encryptedItems = exportState.encryptedItems.filter(
      item => !(item.id === data.id && item.type === data.type)
    );
    await saveState();
  }
  sendResponse({ success: true, remaining: exportState.encryptedItems?.length || 0 });
}

async function loadBookToc(bookNamespace, bookName) {
  if (!bookNamespace) return [];
  try {
    return await fetchBookToc(bookNamespace);
  } catch (error) {
    sendLog(`  获取目录结构失败，继续按平铺方式导出「${bookName || bookNamespace}」: ${error.message}`);
    return [];
  }
}

function getBookNamespace(book) {
  if (!book) return '';
  if (book.namespace) return book.namespace;
  const login = book.user?.login || book.creator?.login || book.owner?.login || '';
  const slug = book.slug || '';
  return login && slug ? `${login}/${slug}` : '';
}

// ═══════════════════════════════════════════
// Page Doc Info (read from dva store via MAIN world)
// ═══════════════════════════════════════════

async function handleGetPageDocInfo(sender, sendResponse) {
  try {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ data: null }); return; }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          const state = window.g_app?._store?.getState();
          const doc = state?.doc;
          const book = state?.book;
          if (!doc?.id) return null;
          return {
            docId: doc.id,
            slug: doc.slug || '',
            title: doc.title || '',
            docType: doc.type || 'Doc',
            bookId: doc.book_id || book?.id || null,
            content: doc.content || doc.body || null,
            namespace: (book?.user?.login || '') + '/' + (book?.slug || ''),
            canExport: doc.abilities?.export === true,
          };
        } catch { return null; }
      },
    });

    sendResponse({ data: results?.[0]?.result || null });
  } catch (err) {
    sendResponse({ data: null, error: err.message });
  }
}

// ═══════════════════════════════════════════
// Quick Export (floating bubble, single doc)
// ═══════════════════════════════════════════

async function handleQuickExport(data, sendResponse) {
  try {
    const { slug, namespace, title, bookId, docId, docType: pageDocType, content: pageContent, canExport } = data;
    if (!slug) throw new Error('缺少文档 slug');

    // Step 1: Load user settings early so we can determine whether we need full content
    const settings = await chrome.storage.local.get([
      'subfolder', 'docExportFormat', 'sheetExportFormat', 'boardExportFormat',
      'markdownMode', 'sheetMode', 'downloadImages', 'imageConcurrency'
    ]);

    const subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    const downloadImages = settings.downloadImages !== false;
    const markdownMode = settings.markdownMode || DEFAULT_SETTINGS.markdownMode;
    const sheetMode = settings.sheetMode || DEFAULT_SETTINGS.sheetMode;
    const imageConcurrency = settings.imageConcurrency || DEFAULT_SETTINGS.imageConcurrency;

    const docType = pageDocType || DOC_TYPES.DOC;

    // Step 3: Determine export format based on doc type
    const typeOptions = DOC_TYPE_EXPORT_OPTIONS[docType];
    const noPermission = canExport !== true;
    let perTypeFormat;
    if (noPermission && docType === DOC_TYPES.DOC) {
      perTypeFormat = 'md';
    } else {
      switch (docType) {
        case DOC_TYPES.SHEET: perTypeFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat; break;
        case DOC_TYPES.BOARD: perTypeFormat = settings.boardExportFormat || DEFAULT_SETTINGS.boardExportFormat; break;
        default: perTypeFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat; break;
      }
      if (typeOptions && !typeOptions.formats.includes(perTypeFormat)) {
        perTypeFormat = typeOptions.defaultFormat;
      }
    }

    const needsLocalContent =
      docType === DOC_TYPES.BOARD ||
      (docType === DOC_TYPES.SHEET && (sheetMode === 'local' || perTypeFormat !== 'xlsx' || noPermission)) ||
      (docType === DOC_TYPES.DOC && perTypeFormat === 'md' && (markdownMode === 'local' || noPermission));

    // Step 2: Resolve doc info from page store data or API
    let resolvedBookId = bookId;
    if ((!docId || needsLocalContent) && !resolvedBookId) {
      resolvedBookId = await resolveBookId(namespace);
    }

    let docInfo;
    if (!docId) {
      if (!resolvedBookId) throw new Error('无法获取知识库信息');
      docInfo = await resolveFullDocInfo(slug, resolvedBookId);
    } else {
      docInfo = {
        id: docId,
        title: title || slug,
        type: docType,
        content: pageContent || '',
        body: pageContent || '',
      };
      if (needsLocalContent && !pageContent) {
        if (!resolvedBookId) throw new Error('无法获取知识库信息');
        const full = await fetchDocContent(slug, resolvedBookId);
        docInfo.content = full.content || '';
        docInfo.body = full.body || '';
        if (full.title) docInfo.title = full.title;
      }
    }

    const format = EXPORT_FORMATS[perTypeFormat];
    if (!format) throw new Error(`不支持的格式: ${perTypeFormat}`);
    const actualTitle = docInfo.title || title || slug;

    // Build file object + save path
    const file = {
      id: docInfo.id, slug, title: actualTitle, docType,
      bookId: resolvedBookId, bookSourceId: resolvedBookId,
      bookName: '', folderPath: '',
    };
    const segments = [];
    if (subfolder) segments.push(...sanitizePathSegments(subfolder));
    segments.push(`${sanitizePathComponent(actualTitle) || '未命名文档'}.${format.extension}`);
    const savedPath = segments.filter(Boolean).join('/');

    // Step 5: Execute export
    const isSheet = docType === DOC_TYPES.SHEET;
    const isBoard = docType === DOC_TYPES.BOARD;
    const content = docInfo.content || docInfo.body || '';

    const saveText = (text, mime) => {
      const blob = new Blob([text], { type: mime });
      return saveBlobToDisk(blob, savedPath);
    };

    if (isBoard) {
      const { svg, width, height } = await convertBoardToSvg(content);
      if (perTypeFormat === 'svg') {
        await saveText(svg, 'image/svg+xml');
      } else {
        const dataUrl = await svgToImageViaOffscreen(svg, width, height, perTypeFormat);
        const resp = await fetch(dataUrl);
        await saveBlobToDisk(await resp.blob(), savedPath);
      }
    } else if (isSheet && (sheetMode === 'local' || perTypeFormat !== 'xlsx' || noPermission)) {
      const result = convertLakeSheet(content, perTypeFormat);
      if (result.blob) await saveBlobToDisk(result.blob, savedPath);
      else await saveText(result.text, result.mime);
    } else if (perTypeFormat === 'md' && (markdownMode === 'local' || noPermission) && content) {
      const markdown = lakeToMarkdown(content);
      if (downloadImages) {
        const imgBase = segments.slice(0, -1).filter(Boolean).join('/'); // subfolder path without filename
        const { localizedMd } = await localizeMarkdownImages(markdown, file, imgBase, imageConcurrency, () => {});
        await saveText(localizedMd, 'text/markdown');
      } else {
        await saveText(markdown, 'text/markdown');
      }
    } else {
      const result = await exportDocAsync(docInfo.id, docType, perTypeFormat);
      if (result.directUrl) await downloadUrlToDisk(result.url, savedPath);
      else if (result.blob) await saveBlobToDisk(result.blob, savedPath);
    }

    sendResponse({ success: true, title: actualTitle, format: perTypeFormat });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function resolveBookId(namespace) {
  if (!namespace) return null;
  try {
    const resp = await fetch(`https://www.yuque.com/api/v2/repos/${namespace}`, {
      headers: {
        'Accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'Origin': 'https://www.yuque.com',
        'Referer': 'https://www.yuque.com/',
      },
      credentials: 'include',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data?.id || null;
  } catch { return null; }
}

async function resolveFullDocInfo(slug, bookId) {
  const resp = await fetch(`https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&merge_dynamic_data=false`, {
    headers: {
      'Accept': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'Origin': 'https://www.yuque.com',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`获取文档信息失败: HTTP ${resp.status}`);
  const json = await resp.json();
  const d = json.data;
  return {
    id: d?.id,
    title: d?.title,
    type: d?.type || 'Doc',
    format: d?.format,
    content: d?.content || '',
    body: d?.body || '',
  };
}
