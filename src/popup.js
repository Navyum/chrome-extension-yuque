import { START_BUTTON_DEFAULT_TEXT } from './ui/constants.js';
import { cacheDomElements, domRefs } from './ui/dom.js';
import {
  addLog, setStartButtonLabel,
  syncUiWithState, renderBookDropdown, restoreBookSelection
} from './ui/ui.js';
import {
  handleCheckAuth, handleLoginClick, handleGetFileInfo, handlePause,
  handleReset, handleRetryFailed, handleStart, saveSettings
} from './ui/actions.js';
import { initSponsorInteractions } from './ui/sponsor.js';
import { initRuntimeMessaging } from './ui/messaging.js';
import { applyI18n } from './ui/i18n.js';

let selectedExportType = 'smart';

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  cacheDomElements();
  setStartButtonLabel(START_BUTTON_DEFAULT_TEXT());

  const hasRestoredBooks = await restorePersistedState();
  bindEventListeners();
  initExportTypeDropdown();
  initSponsorInteractions();
  initRuntimeMessaging();

  handleCheckAuth(hasRestoredBooks);
});

async function restorePersistedState() {
  let hasBooks = false;
  try {
    const { exportType } = await chrome.storage.local.get(['exportType']);
    selectedExportType = exportType || 'smart';

    const response = await chrome.runtime.sendMessage({ action: 'getUiState' });
    if (response?.success) {
      const stateWithoutLogs = { ...response.data, logs: [] };
      syncUiWithState(stateWithoutLogs);
      if (response.data.bookList && response.data.bookList.length) {
        renderBookDropdown(response.data.bookList);
        await restoreBookSelection();
        hasBooks = true;
      }
    }
  } catch {
    // silent
  }
  return hasBooks;
}

// ── Export Type Dropdown ──

function initExportTypeDropdown() {
  const trigger = document.getElementById('exportTypeTrigger');
  const optionsList = document.getElementById('exportTypeOptions');
  const label = document.getElementById('exportTypeLabel');
  if (!trigger || !optionsList) return;

  updateExportTypeUI(selectedExportType, label, optionsList);

  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dropdown = trigger.closest('.book-dropdown');
    dropdown.classList.toggle('is-open');
  });

  // Option clicks
  optionsList.querySelectorAll('.book-option-button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const value = btn.dataset.value;
      selectedExportType = value;
      chrome.storage.local.set({ exportType: value });
      updateExportTypeUI(value, label, optionsList);
      trigger.closest('.book-dropdown').classList.remove('is-open');
    });
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    const dropdown = trigger.closest('.book-dropdown');
    if (dropdown && !dropdown.contains(e.target)) {
      dropdown.classList.remove('is-open');
    }
  });
}

function updateExportTypeUI(value, label, optionsList) {
  if (!label) return;

  // Find the selected option's icon HTML from the dropdown
  const activeBtn = optionsList.querySelector(`.book-option-button[data-value="${value}"]`);
  const iconEl = activeBtn?.querySelector('.option-icon-svg, .option-icon-img');
  const textEl = activeBtn?.querySelector('span');

  // Build label with icon + text
  label.innerHTML = '';
  if (iconEl) {
    const iconClone = iconEl.cloneNode(true);
    label.appendChild(iconClone);
  }
  const textSpan = document.createElement('span');
  textSpan.textContent = textEl?.textContent || value;
  label.appendChild(textSpan);

  // Update active state
  optionsList.querySelectorAll('.select-option-item').forEach(li => {
    const isActive = li.dataset.value === value;
    li.classList.toggle('is-active', isActive);
    const btn = li.querySelector('.book-option-button');
    if (btn) btn.classList.toggle('is-checked', isActive);
  });
}

export function getSelectedExportType() {
  return selectedExportType;
}

// ── Event Listeners ──

function bindEventListeners() {
  const {
    getInfoBtn, startBtn, pauseBtn,
    resetBtn, settingsBtn, loginBtn, retryFailedBtn,
    selectAllCheckbox
  } = domRefs;

  getInfoBtn?.addEventListener('click', handleGetFileInfo);
  startBtn?.addEventListener('click', handleStart);
  pauseBtn?.addEventListener('click', handlePause);
  resetBtn?.addEventListener('click', handleReset);
  retryFailedBtn?.addEventListener('click', handleRetryFailed);

  loginBtn?.addEventListener('click', handleLoginClick);
  settingsBtn?.addEventListener('click', () => { chrome.runtime.openOptionsPage(); });

  // Select-all is now inside the dropdown, handled by ui.js
}
