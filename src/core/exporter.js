import { exportState, resetExportState, saveState } from './state.js';
import { sendLog, sendProgress, sendComplete, sendError } from './messaging.js';
import { checkAuth, fetchAllBooks, fetchBookDocs, buildDocListFromApiDocs, exportDocAsync, downloadImage, resetThrottle } from './yuque.js';
import { saveBlobToDisk, saveContentToDisk, downloadUrlToDisk } from './downloads.js';
import { delay, sanitizePathComponent, sanitizePathSegments, guessImageExt } from './utils.js';
import { refreshAbortController, abortActiveTasks } from './task-controller.js';
import { EXPORT_FORMATS, DEFAULT_SETTINGS, DOC_TYPES, DOC_TYPE_EXPORT_OPTIONS, SMART_EXPORT_KEY } from './constants.js';

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

    for (const bookId of selectedBookIds) {
      const book = exportState.bookList.find(b => b.id === bookId);
      if (!book) continue;

      sendLog(`获取知识库「${book.name}」的文档列表...`);
      const docs = await fetchBookDocs(book.id);
      const { files, folderCount } = buildDocListFromApiDocs(docs);

      files.forEach(f => {
        f.bookId = book.id;
        f.bookName = book.name;
        f.bookNamespace = book.namespace;
      });

      const typeCounts = {};
      files.forEach(f => { typeCounts[f.docType] = (typeCounts[f.docType] || 0) + 1; });
      const typeStr = Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ');
      sendLog(`  文档类型: ${typeStr}`);

      allFiles.push(...files);
      totalFolders += folderCount;
    }

    if (allFiles.length === 0) {
      throw new Error('所选知识库中未获取到任何文档。');
    }

    exportState.fileList = allFiles.map(file => ({ ...file, status: 'pending', localPath: '' }));
    exportState.totalFiles = allFiles.length;
    exportState.folderCount = totalFolders;
    exportState.currentFileIndex = 0;
    exportState.logs = [];

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
      'docExportFormat', 'sheetExportFormat', 'tableExportFormat'
    ]);

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.exportType = data?.exportType || 'smart';
    exportState.subfolder = settings.subfolder || '';
    exportState.downloadImages = settings.downloadImages !== false;
    exportState.imageConcurrency = settings.imageConcurrency || DEFAULT_SETTINGS.imageConcurrency;
    exportState.docExportFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat;
    exportState.sheetExportFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat;
    exportState.tableExportFormat = settings.tableExportFormat || DEFAULT_SETTINGS.tableExportFormat;
    exportState.logs = [];

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
      'docExportFormat', 'sheetExportFormat', 'tableExportFormat'
    ]);

    exportState.fileList.forEach(file => {
      if (file.status === 'failed') file.status = 'pending';
    });

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.subfolder = settings.subfolder || '';
    exportState.exportType = settings.exportType || 'smart';
    exportState.docExportFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat;
    exportState.sheetExportFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat;
    exportState.tableExportFormat = settings.tableExportFormat || DEFAULT_SETTINGS.tableExportFormat;
    exportState.logs = [];

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
      await saveState();
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

          // Use async export API for all types
          const result = await exportDocAsync(file.id, docType, perTypeFormat);
          const savedPath = buildFilePath(file, format.extension);

          if (result.directUrl) {
            // External URL (OSS) — use chrome.downloads directly to bypass CORS
            await downloadUrlToDisk(result.url, savedPath);
          } else if (perTypeFormat === 'md' && exportState.downloadImages && result.blob) {
            // Markdown with image localization
            const mdText = await result.blob.text();
            const { localizedMd, imageCount } = await localizeMarkdownImages(mdText, file);
            await saveContentToDisk(localizedMd, file, format.extension, 'text/markdown');
            if (imageCount > 0) sendLog(`  图片本地化: ${imageCount} 张`);
          } else if (result.blob) {
            // Yuque direct URL — already fetched as blob
            await saveBlobToDisk(result.blob, savedPath);
          }

          file.status = 'success';
          file.localPath = savedPath;
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

      await saveState();

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
async function localizeMarkdownImages(mdText, file) {
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

  let localizedMd = mdText;
  const concurrency = exportState.imageConcurrency || DEFAULT_SETTINGS.imageConcurrency;
  let downloaded = 0;

  const queue = [...images];
  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const img = queue.shift();
      try {
        const blob = await downloadImage(img.url);
        const ext = guessImageExt(img.url);
        downloaded++;
        const localName = `assets/${sanitizePathComponent(file.title)}-${downloaded}.${ext}`;
        const downloadPath = buildImagePath(file, localName);
        await saveBlobToDisk(blob, downloadPath);
        localizedMd = localizedMd.replace(img.fullMatch, `![${img.alt}](${localName})`);
      } catch (e) {
      }
    }
  });

  await Promise.all(workers);
  return { localizedMd, imageCount: downloaded };
}

function buildImagePath(file, localName) {
  const segments = [];
  if (exportState.subfolder) segments.push(...sanitizePathSegments(exportState.subfolder));
  if (file.bookName) segments.push(sanitizePathComponent(file.bookName));
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
  if (file.bookName) segments.push(sanitizePathComponent(file.bookName));
  if (file.folderPath) segments.push(...sanitizePathSegments(file.folderPath));
  segments.push(`${sanitizePathComponent(file.title) || '未命名文档'}.${extension}`);
  return segments.filter(Boolean).join('/');
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
