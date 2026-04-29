import { domRefs } from './dom.js';
import { uiState, updateUiState } from './state.js';
import {
  addLog, resetUiToIdle, setButtonState, setStartButtonLabel,
  showStatus, syncUiWithState, renderBookDropdown, restoreBookSelection, getSelectedBookIds,
  showLoginAvatar, updateUserInfoPopup, toggleUserInfoPopup
} from './ui.js';
import { START_BUTTON_DEFAULT_TEXT } from './constants.js';
import { i18n } from './i18n.js';

export async function handleCheckAuth(skipFetchBooks = false) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkAuth' });
    if (response?.success && response.data?.isLoggedIn) {
      updateUiState({ userInfo: response.data });
      showLoginAvatar(response.data);
      updateUserInfoPopup(response.data);
      restoreGetInfoButton();
      if (!skipFetchBooks) {
        handleGetBooks();
      }
    } else {
      showLoginAvatar(null);
      setGetInfoButtonToLogin();
    }
  } catch {
    showLoginAvatar(null);
    setGetInfoButtonToLogin();
  }
}

export function handleLoginClick() {
  const userInfo = uiState.userInfo;
  if (userInfo && userInfo.isLoggedIn !== false && userInfo.login) {
    // Already logged in — toggle user info popup
    toggleUserInfoPopup();
  } else {
    // Not logged in — go to login page
    chrome.tabs.create({ url: 'https://www.yuque.com/login' });
  }
}

export async function handleGetBooks() {
  try {
    // Don't addLog here — background sendLog will push logs to avoid duplicates
    const response = await chrome.runtime.sendMessage({ action: 'getBooks' });
    if (response?.success) {
      const books = response.data || [];
      updateUiState({ bookList: books });
      renderBookDropdown(books);
      await restoreBookSelection();
    } else {
      throw new Error(response?.error || i18n('unknownError'));
    }
  } catch (error) {
    addLog(i18n('errorPrefix', [error.message]));
  }
}

export async function handleGetFileInfo() {
  const { getInfoBtn } = domRefs;
  if (!getInfoBtn) return;

  const selectedBookIds = getSelectedBookIds();
  if (!selectedBookIds.length) {
    showStatus(i18n('pleaseSelectBooks'), 'error');
    return;
  }

  getInfoBtn.disabled = true;
  getInfoBtn.textContent = i18n('gettingInfo');
  showStatus(i18n('gettingFileInfo'), 'info');
  addLog(i18n('startGettingInfo'));

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getFileInfo',
      data: { bookIds: selectedBookIds }
    });
    if (response?.success) {
      showStatus(i18n('fileInfoSuccess'), 'success');
      syncUiWithState({ ...response.data, isExporting: false, isPaused: false });
      setStartButtonLabel(START_BUTTON_DEFAULT_TEXT());
      restoreGetInfoButton();
    } else {
      throw new Error(response?.error || i18n('unknownError'));
    }
  } catch (error) {
    showStatus(i18n('getInfoFailed', [error.message]), 'error');
    addLog(i18n('errorPrefix', [error.message]));
    if (isLoginError(error.message)) {
      setGetInfoButtonToLogin();
    } else {
      restoreGetInfoButton();
    }
  }
}

export async function handleStart() {
  if (!uiState.fileInfo || !uiState.fileInfo.fileList || uiState.fileInfo.fileList.length === 0) {
    showStatus(i18n('pleaseGetInfoFirst'), 'error');
    return;
  }

  // Get export type from storage (set by popup's export type dropdown)
  const stored = await chrome.storage.local.get(['exportType']);
  const exportType = stored.exportType || 'smart';

  showStatus(i18n('startingExport'), 'info');
  addLog(i18n('startExportLog'));

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'startExport',
      data: { exportType }
    });
    if (!response?.success) throw new Error(response?.error || i18n('unknownError'));
    const uiStateResponse = await chrome.runtime.sendMessage({ action: 'getUiState' });
    if (uiStateResponse?.success) syncUiWithState(uiStateResponse.data);
  } catch (error) {
    showStatus(i18n('startExportFailed', [error.message]), 'error');
    resetUiToIdle();
  }
}

export function handlePause() {
  if (!uiState.isExporting) return;
  const { pauseBtn } = domRefs;
  const nextPaused = !uiState.isPaused;
  updateUiState({ isPaused: nextPaused });
  addLog(nextPaused ? i18n('exportPaused') : i18n('exportResumed'));
  setButtonState(pauseBtn, nextPaused ? i18n('resumeExport') : i18n('pauseExport'), nextPaused ? 'btn-continue' : 'btn-pause');
  chrome.runtime.sendMessage({ action: 'togglePause', data: { isPaused: nextPaused } });
}

export async function handleReset() {
  addLog(i18n('requestingReset'));
  try {
    const response = await chrome.runtime.sendMessage({ action: 'resetExport' });
    if (response?.success) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      window.close();
      return;
    }
  } catch (error) {
    showStatus(i18n('resetFailed', [error.message]), 'error');
  }
}

export async function handleRetryFailed() {
  const { retryFailedBtn } = domRefs;
  if (!retryFailedBtn) return;
  retryFailedBtn.disabled = true;
  retryFailedBtn.textContent = i18n('retrying');
  try {
    const response = await chrome.runtime.sendMessage({ action: 'retryFailedFiles' });
    if (response?.success) {
      addLog(i18n('retryingFailed'));
      const newState = await chrome.runtime.sendMessage({ action: 'getUiState' });
      if (newState?.success) syncUiWithState(newState.data);
    } else {
      throw new Error(response?.error || i18n('unknownError'));
    }
  } catch (error) {
    showStatus(i18n('retryFailed2', [error.message]), 'error');
  } finally {
    retryFailedBtn.disabled = false;
    retryFailedBtn.textContent = i18n('retryFailedFiles');
  }
}

export function saveSettings() {
  const { exportTypeSelect } = domRefs;
  if (!exportTypeSelect) return;
  chrome.storage.local.set({ exportType: exportTypeSelect.value });
}

function restoreGetInfoButton() {
  const { getInfoBtn } = domRefs;
  if (!getInfoBtn) return;
  const span = getInfoBtn.querySelector('span');
  if (span) {
    span.textContent = i18n('getFileInfoBtn') || '🔍 获取文件信息';
  } else {
    getInfoBtn.textContent = i18n('getFileInfo');
  }
  getInfoBtn.disabled = false;
  getInfoBtn.onclick = null;
  getInfoBtn.removeAttribute('data-login');
  getInfoBtn.classList.remove('btn-login-prompt');
}

function setGetInfoButtonToLogin() {
  const { getInfoBtn } = domRefs;
  if (!getInfoBtn) return;
  const span = getInfoBtn.querySelector('span');
  if (span) {
    span.textContent = i18n('clickToLoginYuque') || '点击跳转登录语雀';
  } else {
    getInfoBtn.textContent = i18n('clickToLoginYuque') || '点击跳转登录语雀';
  }
  getInfoBtn.disabled = false;
  getInfoBtn.classList.add('btn-login-prompt');
  getInfoBtn.setAttribute('data-login', 'true');
  getInfoBtn.onclick = () => {
    chrome.tabs.create({ url: 'https://www.yuque.com/login' });
  };
}

function isLoginError(message) {
  if (!message) return false;
  return message.includes('登录') || message.includes('login') || message.includes('语雀') || message.includes('401') || message.includes('403');
}
