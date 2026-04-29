import { exportState } from './state.js';

let lastProgressSentAt = 0;
let lastProgressSnapshot = '';

export function sendProgress() {
  const exportedCount = exportState.fileList.filter(file => file.status === 'success').length;
  const snapshot = `${exportedCount}/${exportState.totalFiles}`;
  const now = Date.now();
  if (snapshot === lastProgressSnapshot && now - lastProgressSentAt < 500) {
    return;
  }
  lastProgressSnapshot = snapshot;
  lastProgressSentAt = now;
  sendMessageToPopup({
    action: 'exportProgress',
    data: {
      exportedFiles: exportedCount,
      totalFiles: exportState.totalFiles
    }
  });
}

export function sendComplete() {
  lastProgressSnapshot = '';
  lastProgressSentAt = 0;
  sendMessageToPopup({ action: 'exportComplete' });
}

export function sendError(error) {
  lastProgressSnapshot = '';
  lastProgressSentAt = 0;
  sendMessageToPopup({
    action: 'exportError',
    data: { error }
  });
}

export function sendLog(message) {
  const timestampedMessage = `[${new Date().toLocaleTimeString()}] ${message}`;
  exportState.logs.push(timestampedMessage);
  if (exportState.logs.length > 300) {
    exportState.logs.shift();
  }
  sendMessageToPopup({
    action: 'exportLog',
    data: { message: timestampedMessage }
  });
}

export async function sendMessageToPopup(payload) {
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (error) {
    if (!error?.message?.includes('Receiving end does not exist')) {
    }
  }
}
