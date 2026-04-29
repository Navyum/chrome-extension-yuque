import { domRefs } from './dom.js';
import { uiState, updateUiState } from './state.js';
import { START_BUTTON_DEFAULT_TEXT } from './constants.js';
import { i18n } from './i18n.js';
import { BOOKMARKS_VIRTUAL_BOOK_ID, BOOKMARKS_VIRTUAL_BOOK_NAME } from '../core/constants.js';

const STATUS_ICONS = { success: '🎉', error: '⚠️', info: 'ℹ️' };
let statusHideTimer = null;
let customSelectInitialized = false;
let bookDropdownOpen = false;

// ── Login Avatar ──

export function showLoginAvatar(userInfo) {
  const { loginBtn, loginIcon, loginAvatar } = domRefs;
  if (!loginBtn) return;
  if (userInfo && userInfo.avatarUrl) {
    loginIcon.style.display = 'none';
    loginAvatar.src = userInfo.avatarUrl;
    loginAvatar.style.display = 'block';
    loginBtn.classList.add('is-logged-in');
    loginBtn.title = userInfo.userName || userInfo.login || '';
  } else {
    loginIcon.style.display = 'block';
    loginAvatar.style.display = 'none';
    loginBtn.classList.remove('is-logged-in');
  }
}

export function toggleUserInfoPopup() {
  const { userInfoPopup } = domRefs;
  if (!userInfoPopup) return;
  const isVisible = userInfoPopup.style.display !== 'none';
  userInfoPopup.style.display = isVisible ? 'none' : 'flex';
  if (!isVisible) {
    // Auto-hide after 3s
    setTimeout(() => { userInfoPopup.style.display = 'none'; }, 3000);
  }
}

export function updateUserInfoPopup(userInfo) {
  const { userAvatar, userName, userLogin } = domRefs;
  if (userAvatar && userInfo.avatarUrl) userAvatar.src = userInfo.avatarUrl;
  if (userName) userName.textContent = userInfo.userName || '';
  if (userLogin) userLogin.textContent = `@${userInfo.login || ''}`;
}

// ── Book Dropdown ──

let selectedBookIdSet = new Set();

export function renderBookDropdown(books) {
  const { bookSelectTrigger, bookSelectOptions, bookSelectLabel, bookSelectGroup } = domRefs;
  if (!bookSelectOptions) return;

  bookSelectOptions.innerHTML = '';
  selectedBookIdSet.clear();

  const personalBooks = books.filter(b => b.type === 'personal');
  const collabBooks = books.filter(b => b.type === 'collab');

  // "Select All" as the first item in the dropdown
  appendSelectAllOption(bookSelectOptions);

  // Bookmarks virtual entry
  appendGroupHeader(bookSelectOptions, BOOKMARKS_VIRTUAL_BOOK_NAME);
  appendBookOption(bookSelectOptions, {
    id: BOOKMARKS_VIRTUAL_BOOK_ID,
    name: '我的收藏',
    docs_count: null,
    groupName: '',
    _isBookmark: true,
  });

  if (personalBooks.length) {
    appendGroupHeader(bookSelectOptions, '个人知识库');
    personalBooks.forEach(b => appendBookOption(bookSelectOptions, b));
  }
  if (collabBooks.length) {
    appendGroupHeader(bookSelectOptions, '协作知识库');
    collabBooks.forEach(b => appendBookOption(bookSelectOptions, b));
  }

  if (!books.length) {
    const empty = document.createElement('li');
    empty.className = 'book-option-group-header';
    empty.textContent = '暂无知识库';
    bookSelectOptions.appendChild(empty);
  }

  // Default: select all (including bookmarks)
  toggleAllBooks(true);
  updateBookDropdownLabel();
  updateSelectedCount();
  saveBookSelection();

  // Setup trigger click (once)
  if (bookSelectTrigger && !bookSelectTrigger._bound) {
    bookSelectTrigger._bound = true;
    bookSelectTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleBookDropdown();
    });
    document.addEventListener('click', (e) => {
      const dropdown = bookSelectGroup?.querySelector('.book-dropdown');
      if (dropdown && !dropdown.contains(e.target)) {
        closeBookDropdown();
      }
    });
  }
}

function appendGroupHeader(container, label) {
  const li = document.createElement('li');
  li.className = 'book-option-group-header';
  li.textContent = label;
  container.appendChild(li);
}

function appendSelectAllOption(container) {
  const li = document.createElement('li');
  li.className = 'select-option-item select-all-item';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'book-option-button';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'book-option-cb select-all-cb';
  cb.checked = true; // default all selected

  const info = document.createElement('div');
  info.className = 'book-option-info';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'book-option-name';
  nameSpan.style.fontWeight = '600';
  nameSpan.textContent = '全选';
  info.appendChild(nameSpan);

  btn.appendChild(cb);
  btn.appendChild(info);
  li.appendChild(btn);
  container.appendChild(li);

  // Separator after select-all
  const sep = document.createElement('li');
  sep.className = 'book-option-group-header';
  sep.style.borderBottom = '1px solid var(--border-primary)';
  sep.style.padding = '0';
  sep.style.margin = '2px 0';
  container.appendChild(sep);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cb.checked = !cb.checked;
    btn.classList.toggle('is-checked', cb.checked);
    toggleAllBooks(cb.checked);
    updateBookDropdownLabel();
    updateSelectedCount();
    saveBookSelection();
  });
}

/**
 * Toggle all book checkboxes on/off.
 */
function toggleAllBooks(checked) {
  const { bookSelectOptions } = domRefs;
  if (!bookSelectOptions) return;
  bookSelectOptions.querySelectorAll('.book-option-button').forEach(btn => {
    if (!btn._bookId) return; // skip select-all itself
    const cb = btn.querySelector('.book-option-cb');
    if (!cb) return;
    if (cb.checked !== checked) {
      cb.checked = checked;
      btn.classList.toggle('is-checked', checked);
      if (checked) selectedBookIdSet.add(btn._bookId);
      else selectedBookIdSet.delete(btn._bookId);
    }
  });
}

function appendBookOption(container, book) {
  const li = document.createElement('li');
  li.className = 'select-option-item';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'book-option-button';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'book-option-cb';
  cb.checked = false;

  const info = document.createElement('div');
  info.className = 'book-option-info';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'book-option-name';
  nameSpan.textContent = book.name;
  const metaSpan = document.createElement('span');
  metaSpan.className = 'book-option-meta';
  metaSpan.textContent = book._isBookmark
    ? '收藏的文档和知识库'
    : `${book.docs_count || 0} 篇${book.groupName ? ' · ' + book.groupName : ''}`;
  info.appendChild(nameSpan);
  info.appendChild(metaSpan);

  btn.appendChild(cb);
  btn.appendChild(info);
  li.appendChild(btn);
  container.appendChild(li);

  btn._bookId = book.id;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cb.checked = !cb.checked;
    btn.classList.toggle('is-checked', cb.checked);
    if (cb.checked) selectedBookIdSet.add(book.id);
    else selectedBookIdSet.delete(book.id);
    updateBookDropdownLabel();
    updateSelectedCount();
    syncSelectAllCheckbox();
    saveBookSelection();
  });
}

function toggleBookDropdown() {
  const dropdown = domRefs.bookSelectGroup?.querySelector('.book-dropdown');
  if (!dropdown) return;
  if (dropdown.classList.contains('is-open')) closeBookDropdown();
  else openBookDropdown();
}

function openBookDropdown() {
  const dropdown = domRefs.bookSelectGroup?.querySelector('.book-dropdown');
  if (!dropdown) return;
  dropdown.classList.add('is-open');
  domRefs.bookSelectGroup?.classList.add('is-select-open');
  domRefs.bookSelectTrigger?.setAttribute('aria-expanded', 'true');
  bookDropdownOpen = true;
}

function closeBookDropdown() {
  const dropdown = domRefs.bookSelectGroup?.querySelector('.book-dropdown');
  if (!dropdown) return;
  dropdown.classList.remove('is-open');
  domRefs.bookSelectGroup?.classList.remove('is-select-open');
  domRefs.bookSelectTrigger?.setAttribute('aria-expanded', 'false');
  bookDropdownOpen = false;
}

function updateBookDropdownLabel() {
  const { bookSelectLabel, bookSelectOptions } = domRefs;
  if (!bookSelectLabel) return;
  const count = selectedBookIdSet.size;
  const hasBooks = bookSelectOptions && bookSelectOptions.querySelector('.book-option-button');
  const hasBookmark = selectedBookIdSet.has(BOOKMARKS_VIRTUAL_BOOK_ID);
  const bookCount = hasBookmark ? count - 1 : count;
  if (count > 0) {
    const parts = [];
    if (bookCount > 0) parts.push(`${bookCount} 个知识库`);
    if (hasBookmark) parts.push('收藏');
    bookSelectLabel.textContent = `已选 ${parts.join(' + ')}`;
  } else if (hasBooks) {
    bookSelectLabel.textContent = '请选择知识库...';
  } else {
    bookSelectLabel.textContent = i18n('selectBookPlaceholder') || '请先登录语雀...';
  }
}

export function getSelectedBookIds() {
  return Array.from(selectedBookIdSet);
}

// Persist selection to storage
function saveBookSelection() {
  chrome.storage.local.set({ selectedBookIds: Array.from(selectedBookIdSet) });
}

// Restore selection from storage after rendering dropdown
export async function restoreBookSelection() {
  const data = await chrome.storage.local.get('selectedBookIds');
  const savedIds = data.selectedBookIds;
  if (!Array.isArray(savedIds) || !savedIds.length) return;

  const { bookSelectOptions } = domRefs;
  if (!bookSelectOptions) return;

  const savedSet = new Set(savedIds);
  bookSelectOptions.querySelectorAll('.book-option-button').forEach(btn => {
    if (btn._bookId && savedSet.has(btn._bookId) && !selectedBookIdSet.has(btn._bookId)) {
      btn.click(); // Triggers the handler which adds to selectedBookIdSet
    }
  });
}

export function getSelectedDocsCount() {
  let total = 0;
  selectedBookIdSet.forEach(id => {
    const book = uiState.bookList.find(b => b.id === id);
    if (book) total += (book.docs_count || 0);
  });
  return total;
}

function updateSelectedCount() {
  const { selectedCountSpan, selectedDocsSpan, getInfoBtn } = domRefs;
  const selectedIds = getSelectedBookIds();
  const docsCount = getSelectedDocsCount();

  if (selectedCountSpan) selectedCountSpan.textContent = selectedIds.length;
  if (selectedDocsSpan) selectedDocsSpan.textContent = docsCount;

  if (getInfoBtn && !uiState.isExporting) {
    getInfoBtn.disabled = selectedIds.length === 0;
  }
}

/**
 * Sync the "select all" checkbox in dropdown based on individual selections.
 */
function syncSelectAllCheckbox() {
  const { bookSelectOptions } = domRefs;
  if (!bookSelectOptions) return;
  const selectAllCb = bookSelectOptions.querySelector('.select-all-cb');
  if (!selectAllCb) return;
  // Check only book checkboxes (not the select-all itself)
  const bookCbs = Array.from(bookSelectOptions.querySelectorAll('.book-option-cb:not(.select-all-cb)'));
  if (!bookCbs.length) return;
  const allChecked = bookCbs.every(cb => cb.checked);
  selectAllCb.checked = allChecked;
  const selectAllBtn = selectAllCb.closest('.book-option-button');
  if (selectAllBtn) selectAllBtn.classList.toggle('is-checked', allChecked);
}

// ── Sync UI ──

export function syncUiWithState(state) {
  if (!state) return;

  const hasFileList = Array.isArray(state.fileList) && state.fileList.length > 0;
  const nextFileInfo = hasFileList ? {
    totalFiles: state.totalFiles,
    fileList: state.fileList,
    folderCount: state.folderCount || 0
  } : null;

  updateUiState({
    isExporting: Boolean(state.isExporting),
    isPaused: Boolean(state.isPaused),
    totalFiles: state.totalFiles || 0,
    fileInfo: nextFileInfo,
    bookList: state.bookList || uiState.bookList,
    userInfo: state.userInfo || uiState.userInfo,
  });

  const {
    getInfoBtn, fileInfoDiv, totalFilesSpan, folderCountSpan,
    startBtn, pauseBtn, progressBar, logContainer, retrySection, failedList,
    progressFill, progressText
  } = domRefs;

  if (state.userInfo && state.userInfo.isLoggedIn !== false) {
    showLoginAvatar(state.userInfo);
    updateUserInfoPopup(state.userInfo);
  }

  if (nextFileInfo) {
    if (totalFilesSpan) totalFilesSpan.textContent = nextFileInfo.totalFiles;
    if (folderCountSpan) folderCountSpan.textContent = nextFileInfo.folderCount || 0;
    if (fileInfoDiv) fileInfoDiv.style.display = 'flex';
  } else {
    if (totalFilesSpan) totalFilesSpan.textContent = '0';
    if (folderCountSpan) folderCountSpan.textContent = '0';
  }

  if (getInfoBtn) getInfoBtn.disabled = uiState.isExporting || selectedBookIdSet.size === 0;

  if (uiState.isExporting) {
    if (startBtn) startBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'inline-block';
    if (progressBar) progressBar.style.display = 'block';
    if (retrySection) retrySection.style.display = 'none';
    if (uiState.isPaused) setButtonState(pauseBtn, i18n('resumeExport'), 'btn-continue');
    else setButtonState(pauseBtn, i18n('pauseExport'), 'btn-pause');
    const exportedCount = hasFileList ? state.fileList.filter(f => f.status === 'success').length : 0;
    if (progressFill && progressText) updateProgress(exportedCount, state.totalFiles);
  } else {
    if (startBtn) { startBtn.style.display = 'inline-block'; startBtn.disabled = !nextFileInfo; }
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (state.failedFiles && state.failedFiles.length > 0 && retrySection && failedList) {
      retrySection.style.display = 'block';
    } else if (retrySection) { retrySection.style.display = 'none'; }
    if (!nextFileInfo && progressBar) progressBar.style.display = 'none';
  }

  if (logContainer && state.logs && state.logs.length > 0) {
    renderLogs(mergeLogs(state.logs));
  }
}

export function resetUiToIdle() {
  const { startBtn, pauseBtn, progressBar } = domRefs;
  updateUiState({ isExporting: false, isPaused: false });
  if (startBtn) { startBtn.style.display = 'inline-block'; startBtn.disabled = !(uiState.fileInfo); }
  if (pauseBtn) pauseBtn.style.display = 'none';
  if (progressBar) progressBar.style.display = 'none';
}

export function setButtonState(button, text, className) {
  if (!button) return;
  button.textContent = text;
  button.className = 'btn';
  if (className) button.classList.add(className);
}

export function setStartButtonLabel(text) {
  if (!text) text = START_BUTTON_DEFAULT_TEXT();
  const { startBtn } = domRefs;
  if (!startBtn) return;
  const labelSpan = startBtn.querySelector('span');
  if (labelSpan) labelSpan.textContent = text;
}

export function showStatus(message, type = 'info') {
  const { statusDiv } = domRefs;
  if (!statusDiv) return;
  const icon = STATUS_ICONS[type] || STATUS_ICONS.info;
  statusDiv.textContent = `${icon} ${message}`;
  statusDiv.className = `status status-toast ${type}`;
  statusDiv.style.display = 'block';
  requestAnimationFrame(() => { statusDiv.classList.add('is-visible'); });
  if (statusHideTimer) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => {
    statusDiv.classList.remove('is-visible');
    setTimeout(() => { statusDiv.style.display = 'none'; }, 300);
  }, 3000);
}

export function addLog(message) {
  const { logContainer } = domRefs;
  if (!logContainer) return;
  const content = message.startsWith('[') ? message : `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLogs(mergeLogs([content]));
}

export function updateProgress(exported, total) {
  const { progressFill, progressText } = domRefs;
  if (!progressFill || !progressText) return;
  const percentage = total > 0 ? Math.round((exported / total) * 100) : 0;
  progressFill.style.width = `${percentage}%`;
  progressText.textContent = `${exported}/${total} (${percentage}%)`;
}

function readRenderedLogs(logContainer) {
  return Array.from(logContainer.querySelectorAll('.log-entry'))
    .map(entry => entry.textContent)
    .filter(Boolean);
}

function mergeLogs(incomingLogs = []) {
  const { logContainer } = domRefs;
  const existingLogs = logContainer ? readRenderedLogs(logContainer) : [];
  const mergedLogs = [...existingLogs];
  const seen = new Set(existingLogs);

  incomingLogs.forEach(log => {
    if (!log || seen.has(log)) return;
    seen.add(log);
    mergedLogs.push(log);
  });

  return mergedLogs;
}

function renderLogs(logs = []) {
  const { logContainer } = domRefs;
  if (!logContainer) return;

  const placeholder = logContainer.querySelector('.log-placeholder');
  if (placeholder) logContainer.innerHTML = '';
  if (!logs.length) return;

  logContainer.innerHTML = '';
  logs.forEach(log => {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.textContent = log;
    logContainer.appendChild(logEntry);
  });
  logContainer.scrollTop = logContainer.scrollHeight;
}

export function toggleSponsorModal(shouldShow) {
  const { sponsorModal, mainContainer, sponsorModalClose, sponsorBtn } = domRefs;
  if (!sponsorModal) return;
  if (shouldShow) {
    sponsorModal.removeAttribute('inert');
    sponsorModal.classList.add('is-visible');
    document.body.classList.add('modal-open');
    if (mainContainer) mainContainer.setAttribute('inert', '');
  } else {
    sponsorModalClose?.blur();
    if (sponsorBtn) sponsorBtn.focus();
    else if (mainContainer) mainContainer.focus();
    if (mainContainer) mainContainer.removeAttribute('inert');
    document.body.classList.remove('modal-open');
    sponsorModal.classList.remove('is-visible');
    setTimeout(() => { sponsorModal.setAttribute('inert', ''); }, 300);
  }
}

// Export type dropdown is now managed by popup.js directly
export function enhanceSelectInteraction() { /* no-op, kept for import compatibility */ }

export function showConfetti() {
  const colors = ['#8b5cf6', '#a78bfa', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.width = `${6 + Math.random() * 6}px`;
    piece.style.height = `${6 + Math.random() * 6}px`;
    piece.style.animationDelay = `${Math.random() * 1.5}s`;
    piece.style.animationDuration = `${2 + Math.random() * 2}s`;
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 5000);
}
