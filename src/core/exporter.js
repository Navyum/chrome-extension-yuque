import { exportState, resetExportState, saveState, waitForStateReady } from './state.js';
import { sendLog, sendProgress, sendComplete, sendError } from './messaging.js';
import { checkAuth, fetchAllBooks, fetchBookDocs, buildDocListFromApiDocs, exportDocAsync, resetThrottle, fetchBookmarks, fetchOrgBookmarks, fetchBookDocsWithPasswordCheck, verifyBookPassword, verifyDocPassword, fetchBookToc, fetchDocContent } from './yuque.js';
import { lakeToMarkdown } from './lake-converter.js';
import { convertLakeSheet } from './sheet-converter.js';
import { convertBoardToSvg, convertBoardToMermaid, convertBoardToECharts } from './board-converter.js';
import { saveBlobToDisk, saveContentToDisk, downloadUrlToDisk } from './downloads.js';
import { delay, sanitizePathComponent, sanitizePathSegments, guessImageExt } from './utils.js';
import { refreshAbortController, abortActiveTasks } from './task-controller.js';
import { EXPORT_FORMATS, DEFAULT_SETTINGS, DOC_TYPES, DOC_TYPE_EXPORT_OPTIONS, SMART_EXPORT_KEY, BOOKMARKS_VIRTUAL_BOOK_ID, BOOKMARKS_VIRTUAL_BOOK_NAME, BOOKMARKS_LOOSE_DOCS_FOLDER, BOOKMARK_BOOK_ID_PREFIX, SUPPORTED_DOC_TYPES } from './constants.js';

let activeRunToken = null;
let alarmListenerRegistered = false;
const DEFERRED_RETRY_DELAYS = [45000, 90000, 180000, 300000];
const MAX_DEFER_COUNT = 4;
const MAX_HARD_INTERRUPTS = 3;
const DEFERRED_RETRY_ALARM = 'yuqueout-deferred-retry';

class DeferredExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeferredExportError';
  }
}

async function saveStateSafely() {
  try {
    await saveState();
    return true;
  } catch (error) {
    sendLog(`保存任务状态失败: ${error.message}`);
    return false;
  }
}

function isRunnerActive() {
  return Boolean(activeRunToken);
}

function startExportRunner() {
  if (activeRunToken) return activeRunToken;
  const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRunToken = runToken;
  exportFiles(runToken).finally(() => {
    if (activeRunToken === runToken) activeRunToken = null;
  });
  return runToken;
}

function isCurrentRun(runToken) {
  return Boolean(runToken) && activeRunToken === runToken;
}

export function registerRuntimeHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    dispatchRuntimeMessage(message, sender, sendResponse);
    return true;
  });
  registerAlarmHandler();
}

function registerAlarmHandler() {
  if (alarmListenerRegistered || !chrome?.alarms?.onAlarm) return;
  alarmListenerRegistered = true;
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== DEFERRED_RETRY_ALARM) return;
    await waitForStateReady();
    if (exportState.isExporting && !exportState.isPaused) {
      startExportRunner();
    }
  });
}

async function dispatchRuntimeMessage(message, sender, sendResponse) {
  try {
    await waitForStateReady();
    switch (message.action) {
      case 'checkAuth':
        await handleCheckAuth(sendResponse);
        return;
      case 'getBooks':
        await handleGetBooks(sendResponse);
        return;
      case 'getFileInfo':
        await handleGetFileInfo(message.data, sendResponse);
        return;
      case 'startExport':
        await handleStartExport(message.data, sendResponse);
        return;
      case 'togglePause':
        await handleTogglePause(message.data, sendResponse);
        return;
      case 'getUiState':
        sendResponse({ success: true, data: exportState });
        return;
      case 'retryFailedFiles':
        await handleRetryFailedFiles(sendResponse);
        return;
      case 'resetExport':
        await handleResetExport(sendResponse);
        return;
      case 'testDownloadLocation':
        await handleTestDownloadLocation(message.data, sendResponse);
        return;
      case 'reExportFile':
        await handleReExportFile(message.data, sendResponse);
        return;
      case 'verifyPassword':
        await handleVerifyPassword(message.data, sendResponse);
        return;
      case 'skipEncrypted':
        await handleSkipEncrypted(message.data, sendResponse);
        return;
      case 'getPageDocInfo':
        await handleGetPageDocInfo(sender, sendResponse);
        return;
      case 'quickExport':
        await handleQuickExport(message.data, sendResponse);
        return;
      default:
        sendResponse({ success: false, error: '未知操作' });
    }
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function maybeResumeExport() {
  if (exportState.isExporting && !exportState.isPaused) {
    sendLog('检测到中断的导出任务，正在尝试恢复...');
    prepareInterruptedFilesForResume();
    await saveStateSafely();
    startExportRunner();
  }
}

function prepareInterruptedFilesForResume() {
  const now = Date.now();
  let interruptedCount = 0;
  (exportState.fileList || []).forEach(file => {
    if (file.status !== 'in_progress') return;
    interruptedCount += 1;
    markInterruptedFile(file, now);
  });
  if (interruptedCount > 0) {
    sendLog(`检测到 ${interruptedCount} 个中断文件，已加入恢复队列。`);
  }
}

function markInterruptedFile(file, now = Date.now()) {
  const hardInterruptCount = Number(file.hardInterruptCount || 0) + 1;
  file.hardInterruptCount = hardInterruptCount;
  file.endTime = now;
  file.duration = file.startTime ? now - file.startTime : 0;
  if (hardInterruptCount >= MAX_HARD_INTERRUPTS) {
    file.status = 'failed';
    file.error = `连续中断 ${hardInterruptCount} 次，已跳过`;
  } else {
    file.status = 'deferred';
    file.nextRetryAt = now;
    file.error = `后台中断，准备第 ${hardInterruptCount + 1} 次恢复`;
  }
}

function normalizeDeferredFiles(now = Date.now()) {
  for (const file of exportState.fileList || []) {
    if (file.status === 'in_progress') {
      markInterruptedFile(file, now);
    }
    if (file.status === 'deferred' && (!file.nextRetryAt || file.nextRetryAt <= now)) {
      file.status = 'pending';
      file.nextRetryAt = 0;
    }
  }
}

function getNextDeferredRetryAt(now = Date.now()) {
  const retryTimes = (exportState.fileList || [])
    .filter(file => file.status === 'deferred' && Number(file.nextRetryAt) > now)
    .map(file => Number(file.nextRetryAt));
  return retryTimes.length ? Math.min(...retryTimes) : 0;
}

function scheduleDeferredRetry(nextRetryAt) {
  if (!chrome?.alarms) return;
  if (!nextRetryAt) {
    chrome.alarms.clear?.(DEFERRED_RETRY_ALARM);
    return;
  }
  const when = Math.max(Date.now() + 1000, nextRetryAt);
  chrome.alarms.create(DEFERRED_RETRY_ALARM, { when });
}

function deferFile(file, reason) {
  const deferCount = Number(file.deferCount || 0) + 1;
  file.deferCount = deferCount;
  file.endTime = Date.now();
  file.duration = file.startTime ? file.endTime - file.startTime : 0;
  if (deferCount > MAX_DEFER_COUNT) {
    file.status = 'failed';
    file.error = `${reason}; 已超过延后重试上限`;
    file.nextRetryAt = 0;
    return false;
  }
  const delayMs = DEFERRED_RETRY_DELAYS[Math.min(deferCount - 1, DEFERRED_RETRY_DELAYS.length - 1)];
  file.status = 'deferred';
  file.nextRetryAt = Date.now() + delayMs;
  file.error = reason;
  sendLog(`  ${file.title} 仍在生成中，${Math.round(delayMs / 1000)} 秒后重试，继续处理后续文件。`);
  return true;
}

function resetRetryMetadata(file) {
  delete file.nextRetryAt;
  delete file.error;
  file.deferCount = 0;
  file.hardInterruptCount = 0;
}

function findNextRunnableIndex(startIndex = 0, now = Date.now()) {
  normalizeDeferredFiles(now);
  const files = exportState.fileList || [];
  const safeStart = Math.max(0, Math.min(Number(startIndex) || 0, files.length));
  const nextFromCursor = files.findIndex((file, index) => index >= safeStart && file.status === 'pending');
  if (nextFromCursor >= 0) return nextFromCursor;
  return files.findIndex(file => file.status === 'pending');
}

async function handleCheckAuth(sendResponse) {
  try {
    const authInfo = await checkAuth();
    if (authInfo.isLoggedIn) {
      exportState.userInfo = authInfo;
      await saveStateSafely();
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
    await saveStateSafely();
    const bookmarkCount = books.filter(b => b._isBookmark && b.type !== 'bookmark-book').length;
    const repoCount = books.length - bookmarkCount;
    const parts = [];
    if (repoCount > 0) parts.push(`${repoCount} 个知识库`);
    if (bookmarkCount > 0) parts.push(`${bookmarkCount} 个收藏`);
    sendLog(`成功获取 ${parts.join(' + ')}。`);
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
    const isBookmarkId = (id) => id === BOOKMARKS_VIRTUAL_BOOK_ID || (typeof id === 'string' && id.startsWith('__bookmarks_'));
    const isBookmarkBookId = (id) => typeof id === 'string' && id.startsWith(BOOKMARK_BOOK_ID_PREFIX);
    const regularBookIds = selectedBookIds.filter(id => !isBookmarkId(id) && !isBookmarkBookId(id));
    const orgBookmarkIds = selectedBookIds.filter(id => typeof id === 'string' && id.startsWith('__bookmarks_') && id !== BOOKMARKS_VIRTUAL_BOOK_ID);
    const bookmarkBookIds = selectedBookIds.filter(isBookmarkBookId);

    // Process regular books
    for (const bookId of regularBookIds) {
      const book = exportState.bookList.find(b => b.id === bookId);
      if (!book) continue;

      sendLog(`获取知识库「${book.name}」的文档列表...`);
      const docs = await fetchBookDocs(book.id, book.host || null);
      const toc = await loadBookToc(book.namespace, book.name, book.host || null);
      const { files, folderCount } = buildDocListFromApiDocs(docs, toc);

      files.forEach(f => {
        f.bookId = book.id;
        f.bookName = buildBookFolderPath(book);
        f.bookNamespace = book.namespace;
        f.bookType = book.type;
        f.bookHost = book.host || null;
      });

      const typeCounts = {};
      files.forEach(f => { typeCounts[f.docType] = (typeCounts[f.docType] || 0) + 1; });
      const typeStr = Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ');
      sendLog(`  文档类型: ${typeStr}`);

      allFiles.push(...files);
      totalFolders += folderCount;
    }

    // Process personal bookmarks
    if (hasBookmarks) {
      sendLog('获取收藏列表...');
      const bookmarkFiles = await buildBookmarkFileList(null, `${msg('personalSpace', '个人空间')}/${BOOKMARKS_VIRTUAL_BOOK_NAME}`);
      allFiles.push(...bookmarkFiles.files);
      totalFolders += bookmarkFiles.folderCount;
      exportState.encryptedItems = bookmarkFiles.encryptedItems;

      const encryptedCount = exportState.encryptedItems.length;
      if (encryptedCount > 0) sendLog(`发现 ${encryptedCount} 个加密项，将在未加密内容下载完成后处理。`);
    }

    // Process org bookmarks
    for (const bmId of orgBookmarkIds) {
      const bmBook = exportState.bookList.find(b => b.id === bmId);
      if (!bmBook) continue;
      sendLog(`获取「${bmBook.orgName}」空间收藏列表...`);
      const folderPrefix = `${sanitizePathComponent(bmBook.orgName || '空间')}/${BOOKMARKS_VIRTUAL_BOOK_NAME}`;
      const bookmarkFiles = await buildBookmarkFileList(bmBook.host, folderPrefix);
      allFiles.push(...bookmarkFiles.files);
      totalFolders += bookmarkFiles.folderCount;
      if (bookmarkFiles.encryptedItems.length) {
        exportState.encryptedItems.push(...bookmarkFiles.encryptedItems);
      }
    }

    // Process individually selected favorited knowledge bases (收藏中的单个知识库)
    for (const bmBookId of bookmarkBookIds) {
      const bmBook = exportState.bookList.find(b => b.id === bmBookId);
      if (!bmBook) continue;

      // Skip when the corresponding master 收藏 selection already covers this book
      const masterSelected = bmBook.orgId
        ? selectedBookIds.includes(`__bookmarks_${bmBook.orgId}__`)
        : hasBookmarks;
      if (masterSelected) continue;

      sendLog(`获取收藏知识库「${bmBook.name}」的文档列表...`);
      const folderPrefix = bmBook.orgId
        ? `${sanitizePathComponent(bmBook.orgName || '空间')}/${BOOKMARKS_VIRTUAL_BOOK_NAME}`
        : `${msg('personalSpace', '个人空间')}/${BOOKMARKS_VIRTUAL_BOOK_NAME}`;
      const bookmarkFiles = await buildBookmarkBookFileList(bmBook, folderPrefix);
      allFiles.push(...bookmarkFiles.files);
      totalFolders += bookmarkFiles.folderCount;
      if (bookmarkFiles.encryptedItems.length) {
        exportState.encryptedItems.push(...bookmarkFiles.encryptedItems);
      }
    }

    if (allFiles.length === 0) {
      if (exportState.encryptedItems.length > 0) {
        exportState.fileList = [];
        exportState.totalFiles = 0;
        exportState.folderCount = 0;
        exportState.currentFileIndex = 0;
        await saveStateSafely();
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

    await saveStateSafely();
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
    if (exportState.isExporting || isRunnerActive()) {
      if (!isRunnerActive() && !exportState.isPaused) {
        startExportRunner();
      }
      sendResponse({ success: true, alreadyRunning: true, data: exportState });
      return;
    }

    const authInfo = await checkAuth();
    if (!authInfo.isLoggedIn) throw new Error('登录态已过期');

    const settings = await chrome.storage.local.get([
      'subfolder', 'requestInterval',
      'downloadImages', 'imageConcurrency',
      'docExportFormat', 'sheetExportFormat', 'boardExportFormat', 'tableExportFormat',
      'markdownMode', 'sheetMode', 'downloadLocation'
    ]);

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.exportType = data?.exportType || 'smart';
    exportState.subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.downloadLocation = settings.downloadLocation ?? DEFAULT_SETTINGS.downloadLocation;
    exportState.requestInterval = Number(settings.requestInterval) || DEFAULT_SETTINGS.requestInterval;
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
        resetRetryMetadata(file);
      }
    });

    refreshAbortController();
    resetThrottle();

    await saveStateSafely();
    sendResponse({ success: true, data: exportState });
    startExportRunner();
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleRetryFailedFiles(sendResponse) {
  if (exportState.isExporting || isRunnerActive()) {
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
      'subfolder', 'exportType', 'requestInterval', 'downloadImages', 'imageConcurrency',
      'docExportFormat', 'sheetExportFormat', 'boardExportFormat', 'tableExportFormat',
      'markdownMode', 'sheetMode', 'downloadLocation'
    ]);

    exportState.fileList.forEach(file => {
      if (file.status === 'failed') {
        file.status = 'pending';
        resetRetryMetadata(file);
      }
    });

    exportState.isExporting = true;
    exportState.isPaused = false;
    exportState.currentFileIndex = 0;
    exportState.subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.downloadLocation = settings.downloadLocation ?? DEFAULT_SETTINGS.downloadLocation;
    exportState.requestInterval = Number(settings.requestInterval) || DEFAULT_SETTINGS.requestInterval;
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

    await saveStateSafely();
    sendResponse({ success: true, data: exportState });
    startExportRunner();
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleResetExport(sendResponse) {
  abortActiveTasks();
  refreshAbortController();
  activeRunToken = null;
  scheduleDeferredRetry(0);
  resetExportState();
  await saveStateSafely();
  sendResponse({ success: true, data: exportState });
}

/**
 * Download a small test file to the given custom location so the user can
 * verify the download directory works before starting a batch export.
 */
async function handleTestDownloadLocation(data, sendResponse) {
  const location = String(data?.location || '').trim();
  const previous = exportState.downloadLocation;
  exportState.downloadLocation = location;
  try {
    const relative = 'yuqueout-下载位置测试.txt';
    await downloadUrlToDisk(
      `data:text/plain;charset=utf-8,YuqueOut 下载位置测试 ${new Date().toLocaleString()}`,
      relative
    );
    let finalPath = '';
    try {
      const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
      const item = items?.[0];
      if (item && item.filename && item.filename.includes('yuqueout-下载位置测试')) {
        finalPath = item.filename;
      }
    } catch {}

    const locationNorm = location.replace(/\\/g, '/').replace(/\/+$/, '');
    const pathNorm = finalPath ? finalPath.replace(/\\/g, '/') : '';
    const fallback = Boolean(locationNorm) && !(pathNorm.startsWith(`${locationNorm}/`) || pathNorm === locationNorm);
    sendResponse({ success: true, path: finalPath || relative, fallback });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  } finally {
    exportState.downloadLocation = previous;
  }
}

async function handleReExportFile(data, sendResponse) {
  if (exportState.isExporting || isRunnerActive()) {
    sendResponse({ success: false, error: '当前有任务正在运行，请先暂停或重置。' });
    return;
  }

  const { fileIndex } = data;
  const file = exportState.fileList?.[fileIndex];
  if (!file) {
    sendResponse({ success: false, error: '文件不存在' });
    return;
  }

  try {
    const authInfo = await checkAuth();
    if (!authInfo.isLoggedIn) throw new Error('登录态已过期');

    const settings = await chrome.storage.local.get([
      'subfolder', 'requestInterval', 'downloadImages', 'imageConcurrency',
      'docExportFormat', 'sheetExportFormat', 'boardExportFormat', 'tableExportFormat',
      'markdownMode', 'sheetMode', 'downloadLocation'
    ]);

    exportState.subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.downloadLocation = settings.downloadLocation ?? DEFAULT_SETTINGS.downloadLocation;
    exportState.requestInterval = Number(settings.requestInterval) || DEFAULT_SETTINGS.requestInterval;
    exportState.downloadImages = settings.downloadImages !== false;
    exportState.imageConcurrency = settings.imageConcurrency || DEFAULT_SETTINGS.imageConcurrency;
    exportState.docExportFormat = settings.docExportFormat || DEFAULT_SETTINGS.docExportFormat;
    exportState.sheetExportFormat = settings.sheetExportFormat || DEFAULT_SETTINGS.sheetExportFormat;
    exportState.boardExportFormat = settings.boardExportFormat || DEFAULT_SETTINGS.boardExportFormat;
    exportState.tableExportFormat = settings.tableExportFormat || DEFAULT_SETTINGS.tableExportFormat;
    exportState.markdownMode = settings.markdownMode || DEFAULT_SETTINGS.markdownMode;
    exportState.sheetMode = settings.sheetMode || DEFAULT_SETTINGS.sheetMode;

    refreshAbortController();
    resetThrottle();

    file.status = 'in_progress';
    file.startTime = Date.now();
    resetRetryMetadata(file);
    await saveStateSafely();

    const docType = file.docType || DOC_TYPES.DOC;
    const perTypeFormat = getPerTypeFormat(docType);
    const format = EXPORT_FORMATS[perTypeFormat];
    if (!format) throw new Error(`未知导出格式: ${perTypeFormat}`);

    const isSheet = docType === DOC_TYPES.SHEET;
    const isTable = docType === DOC_TYPES.TABLE;
    const isBoard = docType === DOC_TYPES.BOARD;
    const noExportPermission = file.isBookmark || file.bookType === 'collab' || file.bookType === 'team' || file.bookType === 'org-personal' || file.bookType === 'wiki';
    const useLocalSheetConvert = (isSheet && (
      exportState.sheetMode === 'local' || perTypeFormat !== 'xlsx' || noExportPermission
    )) || (isTable && (perTypeFormat === 'xlsx' || perTypeFormat === 'csv'));
    const useLocalDocConvert = (!isSheet && !isTable && !isBoard &&
      (perTypeFormat === 'md' || noExportPermission) &&
      (exportState.markdownMode === 'local' || noExportPermission)) ||
      (isTable && perTypeFormat === 'md');

    if (isBoard && file.slug && (file.bookSourceId || file.bookId)) {
      await exportViaBoardContent(file, perTypeFormat);
    } else if (useLocalSheetConvert && file.slug && (file.bookSourceId || file.bookId)) {
      await exportViaSheetContent(file, perTypeFormat);
    } else if (useLocalDocConvert && file.slug && (file.bookSourceId || file.bookId)) {
      await exportViaLakeContent(file, format, perTypeFormat);
    } else {
      const result = await exportDocAsync(file.id, docType, perTypeFormat);
      if (result.deferred) {
        throw new Error('导出仍在生成中，请稍后重试。');
      }
      const savedPath = buildFilePath(file, format.extension);
      if (result.directUrl) {
        await downloadUrlToDisk(result.url, savedPath);
      } else if (perTypeFormat === 'md' && exportState.downloadImages && result.blob) {
        const mdText = await result.blob.text();
        const { localizedMd } = await localizeMarkdownImages(mdText, file);
        await saveContentToDisk(localizedMd, file, format.extension, 'text/markdown');
      } else if (result.blob) {
        await saveBlobToDisk(result.blob, savedPath);
      }
    }

    file.status = 'success';
    file.localPath = buildFilePath(file, format.extension);
    file.endTime = Date.now();
    file.duration = file.endTime - file.startTime;
    await saveStateSafely();
    sendResponse({ success: true, title: file.title });
  } catch (error) {
    file.status = 'failed';
    file.endTime = Date.now();
    file.duration = file.endTime - file.startTime;
    await saveStateSafely();
    sendResponse({ success: false, error: error.message });
  }
}

async function handleTogglePause(data, sendResponse) {
  if (!exportState.isExporting) {
    sendLog('没有正在进行的任务，忽略暂停/继续指令。');
    sendResponse({ success: true, data: exportState });
    return;
  }
  exportState.isPaused = data?.isPaused ?? false;
  sendLog(exportState.isPaused ? '导出已暂停。' : '导出已继续。');
  await saveStateSafely();
  if (!exportState.isPaused) {
    startExportRunner();
  }
  sendResponse({ success: true, data: exportState });
}

async function exportFiles(runToken) {
  try {
    const filesToProcess = exportState.fileList;
    const totalCount = filesToProcess.length;
    normalizeDeferredFiles();

    let i = findNextRunnableIndex(exportState.currentFileIndex);
    while (i >= 0) {
      if (!isCurrentRun(runToken)) return;
      if (!exportState.isExporting) {
        sendLog('导出流程已被取消。');
        return;
      }

      await waitIfPaused();
      if (!isCurrentRun(runToken)) return;

      const file = filesToProcess[i];
      exportState.currentFileIndex = i;

      if (file.status !== 'pending') {
        exportState.currentFileIndex = Math.min(i + 1, totalCount);
        i = findNextRunnableIndex(exportState.currentFileIndex);
        continue;
      }

      file.status = 'in_progress';
      file.startTime = Date.now();
      file.retryCount = 0;
      await saveStateSafely();
      sendLog('(进度 ' + (i + 1) + '/' + totalCount + ') 处理 ' + file.title + '...');

      const MAX_RETRIES = 2;
      let success = false;
      let deferred = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (!isCurrentRun(runToken)) return;
          if (attempt > 0) {
            sendLog('重试第 ' + attempt + ' 次: ' + file.title);
            await delay(2000 * attempt);
          }

          file.retryCount = attempt;

          // Determine export format based on doc type
          const docType = file.docType || DOC_TYPES.DOC;
          const perTypeFormat = getPerTypeFormat(docType);
          const format = EXPORT_FORMATS[perTypeFormat];
          if (!format) throw new Error('未知导出格式: ' + perTypeFormat);

          sendLog('  类型: ' + docType + ' → ' + format.label);

          // Determine conversion path
          const isSheet = docType === DOC_TYPES.SHEET;
          const isTable = docType === DOC_TYPES.TABLE;
          const isBoard = docType === DOC_TYPES.BOARD;
          const noExportPermission = file.isBookmark || file.bookType === 'collab' || file.bookType === 'team' || file.bookType === 'org-personal' || file.bookType === 'wiki';
          // Table always uses local engine (sheet-converter for xlsx/csv, lake-converter for md)
          const useLocalSheetConvert = (isSheet && (
            exportState.sheetMode === 'local' ||
            perTypeFormat !== 'xlsx' ||
            noExportPermission
          )) || (isTable && (perTypeFormat === 'xlsx' || perTypeFormat === 'csv'));
          const useLocalDocConvert = (!isSheet && !isTable && !isBoard &&
            (perTypeFormat === 'md' || noExportPermission) &&
            (exportState.markdownMode === 'local' || noExportPermission)) ||
            (isTable && perTypeFormat === 'md');


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
              if (result.deferred) {
                throw new DeferredExportError(result.message || '导出仍在生成中');
              }
              const savedPath = buildFilePath(file, format.extension);

              if (result.directUrl) {
                await downloadUrlToDisk(result.url, savedPath);
              } else if (perTypeFormat === 'md' && exportState.downloadImages && result.blob) {
                const mdText = await result.blob.text();
                const { localizedMd, imageCount } = await localizeMarkdownImages(mdText, file);
                await saveContentToDisk(localizedMd, file, format.extension, 'text/markdown');
                if (imageCount > 0) sendLog('  图片本地化: ' + imageCount + ' 张');
              } else if (result.blob) {
                await saveBlobToDisk(result.blob, savedPath);
              }
            } catch (apiErr) {
              if (apiErr instanceof DeferredExportError) {
                throw apiErr;
              }
              // Fallback: if export API fails and we have slug, try local conversion
              if (file.slug && (file.bookSourceId || file.bookId)) {
                sendLog('  官方导出失败，自动切换本地转换: ' + apiErr.message);
                if (isSheet) {
                  await exportViaSheetContent(file, perTypeFormat);
                } else {
                  const mdFormat = EXPORT_FORMATS['md'];
                  await exportViaLakeContent(file, mdFormat, 'md');
                }
              } else {
                throw apiErr;
              }
            }
          }

          if (!isCurrentRun(runToken)) return;
          resetRetryMetadata(file);
          file.status = 'success';
          file.localPath = buildFilePath(file, format.extension);
          file.endTime = Date.now();
          file.duration = file.endTime - file.startTime;
          sendLog('导出完成: ' + file.title + ' (耗时 ' + (file.duration / 1000).toFixed(2) + 's)');
          sendProgress();

          success = true;
          break;
        } catch (error) {
          if (error.name === 'AbortError') {
            sendLog('检测到中止信号，结束导出流程。');
            return;
          }
          if (error instanceof DeferredExportError) {
            deferred = deferFile(file, error.message);
            if (!deferred) {
              sendLog('已将 ' + file.title + ' 标记为失败。');
            }
            break;
          }
          sendLog('导出失败: ' + file.title + ' -> ' + error.message);
        }
      }

      if (!success && !deferred && file.status !== 'failed') {
        file.status = 'failed';
        file.endTime = Date.now();
        file.duration = file.endTime - file.startTime;
        sendLog('已将 ' + file.title + ' 标记为失败。');
      }

      exportState.currentFileIndex = Math.min(i + 1, totalCount);
      await saveStateSafely();

      // Throttle between documents
      const interval = exportState.requestInterval || DEFAULT_SETTINGS.requestInterval;
      await delay(interval + Math.random() * 500);
      i = findNextRunnableIndex(exportState.currentFileIndex);
    }

    if (!exportState.isExporting) {
      sendLog('导出被外部中止，跳过收尾。');
      return;
    }

    const nextRetryAt = getNextDeferredRetryAt();
    if (nextRetryAt) {
      exportState.currentFileIndex = totalCount;
      scheduleDeferredRetry(nextRetryAt);
      await saveStateSafely();
      const waitSeconds = Math.max(1, Math.ceil((nextRetryAt - Date.now()) / 1000));
      sendLog('当前没有可立即处理的文件，等待 ' + waitSeconds + ' 秒后重试延后文件。');
      return;
    }

    exportState.isExporting = false;
    exportState.currentFileIndex = totalCount;
    scheduleDeferredRetry(0);
    await saveStateSafely();

    const failedCount = exportState.fileList.filter(f => f.status === 'failed').length;
    const successCount = exportState.fileList.filter(f => f.status === 'success').length;

    sendLog('导出完成！成功: ' + successCount + ', 失败: ' + failedCount);

    // Notify about encrypted items that need password
    const encryptedItems = exportState.encryptedItems || [];
    if (encryptedItems.length > 0) {
      const settings = await chrome.storage.local.get(['skipEncryptedBookmarks']);
      if (settings.skipEncryptedBookmarks) {
        sendLog('已跳过 ' + encryptedItems.length + ' 个加密项（设置中已开启"跳过加密内容"）。');
        exportState.encryptedItems = [];
        await saveStateSafely();
      } else {
        sendLog('还有 ' + encryptedItems.length + ' 个加密项需要输入密码后下载。');
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
    await saveStateSafely();
    sendLog('导出流程发生异常: ' + error.message);
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
        await downloadUrlToDisk(cleanUrl, downloadPath);

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

async function renderEmbeddedBoardsToAssets(lakeHtml, file, imageBasePath, logFn = sendLog) {
  if (!lakeHtml || !lakeHtml.includes('name="board"')) {
    return { content: lakeHtml, boardCount: 0 };
  }

  let boardIndex = 0;
  let renderedCount = 0;
  // Lake may serialize cards as either `<card></card>` or self-closing
  // `<card />`; both forms must be replaced before the Markdown pass.
  const cardRegex = /<card\s+([^>]*?)(?:>\s*<\/card>|\/>)/gi;
  const replacements = [];

  for (const match of lakeHtml.matchAll(cardRegex)) {
    const attrs = match[1] || '';
    const name = (attrs.match(/name="([^"]*)"/) || [])[1] || '';
    if (name !== 'board') continue;

    const value = (attrs.match(/value="([^"]*)"/) || [])[1] || '';
    if (!value.startsWith('data:')) continue;

    let data;
    try {
      data = JSON.parse(decodeURIComponent(value.slice(5)));
    } catch {
      continue;
    }

    if (!data.diagramData?.body) continue;

    boardIndex += 1;
    try {
      const { svg } = await convertBoardToSvg(JSON.stringify(data));
      const localName = `assets/${sanitizePathComponent(file.title) || '未命名文档'}-白板-${boardIndex}.svg`;
      const downloadPath = imageBasePath !== undefined && imageBasePath !== null
        ? (imageBasePath ? `${imageBasePath}/${localName}` : localName)
        : buildImagePath(file, localName);
      await saveBlobToDisk(new Blob([svg], { type: 'image/svg+xml' }), downloadPath);

      const mermaid = convertBoardToMermaid(data);
      const echarts = mermaid ? '' : convertBoardToECharts(data);
      const markdown = [
        mermaid ? `\`\`\`mermaid\n${mermaid}\n\`\`\`` : '',
        echarts ? `\`\`\`echarts\n${echarts}\n\`\`\`` : '',
        `![白板 ${boardIndex}](${localName})`
      ].filter(Boolean).join('\n\n');
      const markdownCardData = { markdown };
      const markdownCard = `<card type="inline" name="markdown" value="data:${encodeURIComponent(JSON.stringify(markdownCardData))}"></card>`;
      replacements.push({ from: match[0], to: markdownCard });
      renderedCount += 1;
    } catch (error) {
      logFn(`  内嵌白板渲染失败: ${error.message}`);
    }
  }

  let content = lakeHtml;
  for (const item of replacements) {
    content = content.replace(item.from, item.to);
  }

  return { content, boardCount: renderedCount };
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
      case DOC_TYPES.TABLE: {
        const fmt = exportState.sheetExportFormat || exportState.tableExportFormat || typeOptions.defaultFormat;
        return typeOptions.formats.includes(fmt) ? fmt : typeOptions.defaultFormat;
      }
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

function msg(key, fallback) {
  return chrome.i18n.getMessage(key) || fallback;
}

function buildBookFolderPath(book) {
  const name = sanitizePathComponent(book.name);
  const personal = msg('personalSpace', '个人空间');
  const myOwn = msg('myOwn', '我个人的');
  const collab = msg('invitedCollab', '邀请协作的');
  const wiki = msg('publicArea', '公共区');
  const teamFallback = msg('teamSpace', '团队空间');

  switch (book.type) {
    case 'personal':
      return `${personal}/${myOwn}/${name}`;
    case 'collab':
      return `${personal}/${collab}/${name}`;
    case 'team': {
      const org = sanitizePathComponent(book.orgName || teamFallback);
      const group = sanitizePathComponent(book.groupName || msg('unnamedTeam', '团队'));
      return `${org}/${group}/${name}`;
    }
    case 'wiki': {
      const org = sanitizePathComponent(book.orgName || teamFallback);
      return `${org}/${wiki}/${name}`;
    }
    case 'org-personal': {
      const org = sanitizePathComponent(book.orgName || teamFallback);
      return `${org}/${myOwn}/${name}`;
    }
    default:
      return name;
  }
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

  let { content } = await fetchDocContent(file.slug, bookId, file.bookHost || null);

  if (!content) {
    throw new Error('文档内容为空');
  }

  // For Table type, records are stored separately — fetch and inject them
  if (file.docType === DOC_TYPES.TABLE) {
    content = await injectTableRecords(content, file);
  }


  // Convert Lake HTML to Markdown
  const { content: contentWithBoards, boardCount } = await renderEmbeddedBoardsToAssets(content, file);
  if (boardCount > 0) sendLog(`  内嵌白板渲染: ${boardCount} 个`);
  const markdown = lakeToMarkdown(contentWithBoards);


  if (exportState.downloadImages) {
    const { localizedMd, imageCount } = await localizeMarkdownImages(markdown, file);
    await saveContentToDisk(localizedMd, file, 'md', 'text/markdown');
    if (imageCount > 0) sendLog(`  图片本地化: ${imageCount} 张`);
  } else {
    await saveContentToDisk(markdown, file, 'md', 'text/markdown');
  }
}

/**
 * Fetch Table records from TableRecordController and inject into content JSON.
 * Table content from /api/docs/ doesn't include records — they're in a separate API.
 */
async function injectTableRecords(contentStr, file) {
  try {
    const json = JSON.parse(contentStr);
    const sheet = json.sheet?.[0];
    if (!sheet || !sheet.id) return contentStr;

    const host = file.bookHost || null;
    const baseUrl = host ? `${host}/api` : 'https://www.yuque.com/api';
    const url = `${baseUrl}/modules/table/doc/TableRecordController/show?docId=${file.id}&docType=Doc&limit=5000&offset=0&sheetId=${sheet.id}`;

    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'Origin': host || 'https://www.yuque.com',
        'Referer': `${host || 'https://www.yuque.com'}/`,
      },
      credentials: 'include',
    });

    if (!resp.ok) return contentStr;
    const data = await resp.json();
    const records = Array.isArray(data.records) ? data.records : [];

    if (records.length > 0) {
      sheet.records = records;
      sendLog(`  数据表记录: ${records.length} 条`);
      return JSON.stringify(json);
    }
  } catch (e) {
    // Fall through with original content
  }
  return contentStr;
}

/**
 * Export a Board doc by fetching content, converting to SVG, then to PNG/JPG via offscreen.
 */
async function exportViaBoardContent(file, perTypeFormat) {
  const bookId = file.bookSourceId || file.bookId;
  sendLog(`  使用本地白板转换 (${perTypeFormat})...`);

  const { content, body } = await fetchDocContent(file.slug, bookId, file.bookHost || null);
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

  const { content, body } = await fetchDocContent(file.slug, bookId, file.bookHost || null);
  let sheetContent = content || body;
  if (!sheetContent) throw new Error('表格内容为空');

  // For Table type, inject records from separate API
  if (file.docType === DOC_TYPES.TABLE) {
    sheetContent = await injectTableRecords(sheetContent, file);
  }


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
async function buildBookmarkFileList(host = null, folderPrefix = BOOKMARKS_VIRTUAL_BOOK_NAME) {
  const actions = host
    ? await fetchOrgBookmarks(host)
    : await fetchBookmarks();
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
      bookName: `${folderPrefix}/${sanitizePathComponent(bookName)}`,
      bookNamespace: '',
      bookHost: host,
      isBookmark: true,
    });
  }

  // Process mark_book items
  for (const action of markBooks) {
    const book = action.target;
    if (!book) continue;

    sendLog(`获取收藏知识库「${book.name}」的文档列表...`);

    const { docs, needsPassword } = await fetchBookDocsWithPasswordCheck(book.id, host);

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
    const toc = await loadBookToc(bookNamespace, book.name, host);
    const { files: bookFiles, folderCount: bookmarkFolderCount } = buildDocListFromApiDocs(docs, toc);
    bookFiles.forEach(f => {
      f.bookId = book.id;
      f.bookName = `${folderPrefix}/${sanitizePathComponent(book.name)}`;
      f.bookNamespace = '';
      f.bookHost = host;
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
 * Build file list for a single favorited knowledge base (individual 收藏 selection).
 * Mirrors the mark_book handling in buildBookmarkFileList, but only for one book.
 */
async function buildBookmarkBookFileList(bmBook, folderPrefix) {
  const files = [];
  const encryptedItems = [];
  let folderCount = 0;
  const bookId = bmBook._bookmarkBookId || bmBook.bookId;
  const bookName = bmBook._bookmarkBookName || bmBook.name || '未命名知识库';

  const { docs, needsPassword } = await fetchBookDocsWithPasswordCheck(bookId, bmBook.host || null);

  if (needsPassword) {
    encryptedItems.push({
      type: 'book',
      id: bookId,
      title: bookName,
      bookName,
      bookNamespace: bmBook.namespace || '',
    });
    sendLog(`  知识库「${bookName}」需要密码验证，稍后处理。`);
    return { files, folderCount, encryptedItems };
  }

  const toc = await loadBookToc(bmBook.namespace, bookName, bmBook.host || null);
  const { files: bookFiles, folderCount: bookmarkFolderCount } = buildDocListFromApiDocs(docs, toc);
  bookFiles.forEach(f => {
    f.bookId = bookId;
    f.bookName = `${folderPrefix}/${sanitizePathComponent(bookName)}`;
    f.bookNamespace = '';
    f.bookHost = bmBook.host || null;
  });

  if (bookmarkFolderCount > 0) {
    folderCount += bookmarkFolderCount;
  } else if (bookFiles.length > 0) {
    folderCount++;
    sendLog(`  获取到 ${bookFiles.length} 篇文档。`);
  }

  files.push(...bookFiles);
  return { files, folderCount, encryptedItems };
}
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

      await saveStateSafely();
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
      await saveStateSafely();

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
    await saveStateSafely();
  }
  sendResponse({ success: true, remaining: exportState.encryptedItems?.length || 0 });
}

async function loadBookToc(bookNamespace, bookName, host = null) {
  if (!bookNamespace) return [];
  try {
    return await fetchBookToc(bookNamespace, host);
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
      'markdownMode', 'sheetMode', 'downloadImages', 'imageConcurrency', 'downloadLocation'
    ]);

    const subfolder = settings.subfolder ?? DEFAULT_SETTINGS.subfolder;
    exportState.downloadLocation = settings.downloadLocation ?? DEFAULT_SETTINGS.downloadLocation;
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
      const imgBase = segments.slice(0, -1).filter(Boolean).join('/'); // subfolder path without filename
      const { content: contentWithBoards } = await renderEmbeddedBoardsToAssets(content, file, imgBase, () => {});
      const markdown = lakeToMarkdown(contentWithBoards);
      if (downloadImages) {
        const { localizedMd } = await localizeMarkdownImages(markdown, file, imgBase, imageConcurrency, () => {});
        await saveText(localizedMd, 'text/markdown');
      } else {
        await saveText(markdown, 'text/markdown');
      }
	    } else {
	      const result = await exportDocAsync(docInfo.id, docType, perTypeFormat);
	      if (result.deferred) throw new Error('导出仍在生成中，请稍后重试。');
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
  const resp = await fetch(`https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&merge_dynamic_data=true`, {
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
