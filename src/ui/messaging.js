import { START_BUTTON_DONE_TEXT } from './constants.js';
import { updateUiState } from './state.js';
import {
  addLog, resetUiToIdle, setStartButtonLabel,
  showStatus, showConfetti, syncUiWithState, updateProgress
} from './ui.js';
import { showPasswordModal } from './password.js';
import { i18n } from './i18n.js';

let listenerRegistered = false;

export function initRuntimeMessaging() {
  if (listenerRegistered) return;
  listenerRegistered = true;

  chrome.runtime.onMessage.addListener(message => {
    switch (message.action) {
      case 'exportProgress': {
        const { exportedFiles, totalFiles } = message.data;
        updateUiState({ totalFiles });
        updateProgress(exportedFiles, totalFiles);
        break;
      }
      case 'exportComplete': {
        addLog(i18n('exportCompleteLog'));
        showStatus(i18n('exportCompleteStatus'), 'success');
        showConfetti();
        setStartButtonLabel(START_BUTTON_DONE_TEXT());
        updateUiState({ isExporting: false });
        chrome.runtime.sendMessage({ action: 'getUiState' }).then(response => {
          if (response?.success) syncUiWithState(response.data);
        });
        break;
      }
      case 'exportError': {
        const error = message.data.error;
        addLog(i18n('exportErrorLog', [error]));
        showStatus(i18n('exportErrorStatus', [error]), 'error');
        resetUiToIdle();
        break;
      }
      case 'exportLog': {
        addLog(message.data.message);
        break;
      }
      case 'showPasswordDialog': {
        const items = message.data?.encryptedItems || [];
        if (items.length > 0) {
          showPasswordModal(items);
        }
        break;
      }
      default:
        break;
    }
  });
}
