import { exportState } from './state.js';
import { sanitizePathComponent, sanitizePathSegments } from './utils.js';

const pendingDownloadUrlMap = new Map();
const downloadFilenameOverrides = new Map();
const activeDownloadTargets = new Map();
const activeDownloadWaiters = new Map();
let hooksInitialized = false;

function enqueuePendingDownload(url, filename) {
  const queue = pendingDownloadUrlMap.get(url) || [];
  queue.push(filename);
  pendingDownloadUrlMap.set(url, queue);
}

function consumePendingDownload(url) {
  const queue = pendingDownloadUrlMap.get(url);
  if (!queue?.length) return '';

  const targetPath = queue.shift();
  if (!queue.length) {
    pendingDownloadUrlMap.delete(url);
  } else {
    pendingDownloadUrlMap.set(url, queue);
  }
  return targetPath || '';
}

function handleDownloadCreated(downloadItem) {
  const targetPath = consumePendingDownload(downloadItem.url);
  if (targetPath) {
    downloadFilenameOverrides.set(downloadItem.id, targetPath);
    activeDownloadTargets.set(downloadItem.id, {
      expectedFilename: targetPath,
      sourceUrl: summarizeUrl(downloadItem.url)
    });
  }
}

function handleDownloadFilename(downloadItem, suggest) {
  const targetPath = downloadFilenameOverrides.get(downloadItem.id);
  if (targetPath) {
    downloadFilenameOverrides.delete(downloadItem.id);
    suggest({ filename: targetPath, conflictAction: 'uniquify' });
    return;
  }
  suggest();
}

function handleDownloadChanged(delta) {
  const target = activeDownloadTargets.get(delta.id);
  const waiter = activeDownloadWaiters.get(delta.id);
  if (!target && !waiter) return;

  if (delta.error?.current || delta.state?.current === 'interrupted' || delta.state?.current === 'complete') {
    if (waiter) {
      if (delta.error?.current || delta.state?.current === 'interrupted') {
        waiter.reject(new Error(delta.error?.current || '下载被中断'));
      } else {
        waiter.resolve();
      }
      activeDownloadWaiters.delete(delta.id);
    }

    activeDownloadTargets.delete(delta.id);
    downloadFilenameOverrides.delete(delta.id);
  }
}

export function initDownloadHooks() {
  if (hooksInitialized) return;
  hooksInitialized = true;

  if (chrome?.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener(handleDownloadChanged);
  }
  if (chrome?.downloads?.onCreated) {
    chrome.downloads.onCreated.addListener(handleDownloadCreated);
  }
  if (chrome?.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener(handleDownloadFilename);
  }
}

/**
 * Save text content to disk via data URL.
 */
export async function saveContentToDisk(content, file, extension, mime) {
  const relativePath = buildRelativeDownloadPath(file, extension);
  const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  await download(dataUrl, relativePath);
  return relativePath;
}

/**
 * Save a Blob to disk via data URL.
 * MV3 service workers do not reliably support object URLs.
 */
export async function saveBlobToDisk(blob, relativePath) {
  const dataUrl = await blobToDataUrl(blob);
  await download(dataUrl, relativePath);
  return relativePath;
}

/**
 * Download a file from URL directly (CDN images, OSS exports, etc.).
 */
export async function downloadUrlToDisk(url, relativePath) {
  await download(url, relativePath);
  return relativePath;
}

function download(url, filename) {
  const normalizedFilename = normalizeRelativePath(filename);
  enqueuePendingDownload(url, normalizedFilename);

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: normalizedFilename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (id) => {
      if (chrome.runtime.lastError) {
        removeQueuedDownload(url, normalizedFilename);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        activeDownloadWaiters.set(id, { resolve, reject });
      }
    });
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Blob 转 DataURL 失败'));
    reader.readAsDataURL(blob);
  });
}

function buildRelativeDownloadPath(file, extension) {
  const segments = [];
  const baseName = `${sanitizePathComponent(file?.title) || '未命名文档'}.${extension}`;

  if (exportState.subfolder) {
    segments.push(...sanitizePathSegments(exportState.subfolder));
  }
  if (file?.bookName) {
    segments.push(...sanitizePathSegments(file.bookName));
  }
  if (file?.folderPath) {
    segments.push(...sanitizePathSegments(file.folderPath));
  }

  segments.push(baseName);
  return segments.filter(Boolean).join('/');
}

function normalizeRelativePath(path = '') {
  return sanitizePathSegments(path).join('/');
}

function removeQueuedDownload(url, filename) {
  const queue = pendingDownloadUrlMap.get(url);
  if (!queue?.length) return;

  const index = queue.indexOf(filename);
  if (index >= 0) queue.splice(index, 1);

  if (!queue.length) pendingDownloadUrlMap.delete(url);
  else pendingDownloadUrlMap.set(url, queue);
}

function summarizeUrl(url = '') {
  if (url.startsWith('data:')) return 'data:...';
  return url.length > 120 ? `${url.slice(0, 117)}...` : url;
}
