import { exportState } from './state.js';
import { sanitizePathComponent, sanitizePathSegments } from './utils.js';

const pendingDownloadUrlMap = new Map();
const downloadFilenameOverrides = new Map();
let hooksInitialized = false;

function handleDownloadCreated(downloadItem) {
  const targetPath = pendingDownloadUrlMap.get(downloadItem.url);
  if (targetPath) {
    pendingDownloadUrlMap.delete(downloadItem.url);
    downloadFilenameOverrides.set(downloadItem.id, targetPath);
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

export function initDownloadHooks() {
  if (hooksInitialized) return;
  hooksInitialized = true;

  if (chrome?.downloads?.onCreated) {
    chrome.downloads.onCreated.addListener(handleDownloadCreated);
  }

  if (chrome?.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener(handleDownloadFilename);
  }
}

export async function saveContentToDisk(content, file, extension, mime) {
  const relativePath = buildRelativeDownloadPath(file, extension);
  const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;

  pendingDownloadUrlMap.set(dataUrl, relativePath);

  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: relativePath,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch (error) {
    pendingDownloadUrlMap.delete(dataUrl);
    throw error;
  } finally {
    if (pendingDownloadUrlMap.get(dataUrl) === relativePath) {
      pendingDownloadUrlMap.delete(dataUrl);
    }
  }

  return relativePath;
}

export async function saveBlobToDisk(blob, relativePath) {
  const dataUrl = await blobToDataUrl(blob);

  pendingDownloadUrlMap.set(dataUrl, relativePath);

  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: relativePath,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch (error) {
    pendingDownloadUrlMap.delete(dataUrl);
    throw error;
  } finally {
    if (pendingDownloadUrlMap.get(dataUrl) === relativePath) {
      pendingDownloadUrlMap.delete(dataUrl);
    }
  }

  return relativePath;
}

/**
 * Download a file from URL directly via chrome.downloads, with filename override.
 * Used for external URLs (OSS etc.) that can't be fetched due to CORS.
 */
export async function downloadUrlToDisk(url, relativePath) {
  pendingDownloadUrlMap.set(url, relativePath);

  try {
    await chrome.downloads.download({
      url,
      filename: relativePath,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch (error) {
    pendingDownloadUrlMap.delete(url);
    throw error;
  } finally {
    if (pendingDownloadUrlMap.get(url) === relativePath) {
      pendingDownloadUrlMap.delete(url);
    }
  }

  return relativePath;
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
    segments.push(sanitizePathComponent(file.bookName));
  }

  if (file?.folderPath) {
    segments.push(...sanitizePathSegments(file.folderPath));
  }

  segments.push(baseName);
  return segments.filter(Boolean).join('/');
}

