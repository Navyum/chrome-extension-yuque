import { exportState } from './state.js';

export function sendProgress() {
  const exportedCount = exportState.fileList.filter(file => file.status === 'success').length;
  sendMessageToPopup({
    action: 'exportProgress',
    data: {
      exportedFiles: exportedCount,
      totalFiles: exportState.totalFiles
    }
  });
}

export function sendComplete() {
  sendMessageToPopup({ action: 'exportComplete' });
}

export function sendError(error) {
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
