import { applyI18n, i18n } from './ui/i18n.js';

const SETTINGS_KEYS = [
  'subfolder', 'requestInterval',
  'downloadImages', 'imageConcurrency',
  'docExportFormat', 'sheetExportFormat', 'tableExportFormat', 'boardExportFormat',
  'showBubble', 'skipEncryptedBookmarks', 'markdownMode', 'sheetMode'
];

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  applyVersion();
  initIconSelects();
  await loadSettings();
  bindDownloadSettingsShortcut();
  bindNavigation();
  bindAutoSave();
  bindPerformanceControls();
  await loadPerformanceData();
});

function applyVersion() {
  const version = chrome.runtime.getManifest().version;
  document.querySelectorAll('[data-version]').forEach(el => {
    el.textContent = `v${version}`;
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEYS);

  setVal('subfolder', data.subfolder ?? '语雀备份');
  setVal('requestInterval', data.requestInterval || 500);
  setChecked('downloadImages', data.downloadImages !== false);
  setVal('imageConcurrency', data.imageConcurrency || 3);
  setVal('docExportFormat', data.docExportFormat || 'md');
  setVal('sheetExportFormat', data.sheetExportFormat || 'xlsx');
  setVal('tableExportFormat', data.tableExportFormat || 'xlsx');
  setVal('boardExportFormat', data.boardExportFormat || 'png');
  setChecked('showBubble', data.showBubble !== false);
  setChecked('skipEncryptedBookmarks', data.skipEncryptedBookmarks === true);
  setVal('markdownMode', data.markdownMode || 'local');
  setVal('sheetMode', data.sheetMode || 'local');
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const section = item.dataset.section;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      item.classList.add('active');
      document.getElementById(section)?.classList.add('active');
      if (section === 'performance') {
        loadPerformanceData();
      }
    });
  });
}

function bindAutoSave() {
  SETTINGS_KEYS.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    const event = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(event, debounce(saveAllSettings, 500));
  });
}

async function saveAllSettings() {
  const settings = {
    subfolder: getVal('subfolder'),
    downloadImages: getChecked('downloadImages'),
    requestInterval: Number(getVal('requestInterval')) || 500,
    imageConcurrency: Number(getVal('imageConcurrency')) || 3,
    docExportFormat: getVal('docExportFormat'),
    sheetExportFormat: getVal('sheetExportFormat'),
    tableExportFormat: getVal('tableExportFormat'),
    boardExportFormat: getVal('boardExportFormat'),
    showBubble: getChecked('showBubble'),
    skipEncryptedBookmarks: getChecked('skipEncryptedBookmarks'),
    markdownMode: getVal('markdownMode') || 'local',
    sheetMode: getVal('sheetMode') || 'local',
  };

  await chrome.storage.local.set(settings);
  showSaveToast();
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  // Sync icon-select display if it's a hidden input inside one
  const wrapper = el.closest('.icon-select');
  if (wrapper) syncIconSelectDisplay(wrapper, value);
}
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function setChecked(id, checked) { const el = document.getElementById(id); if (el) el.checked = checked; }
function getChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; }

// ── Icon Select Component ──

function initIconSelects() {
  document.querySelectorAll('.icon-select').forEach(wrapper => {
    const trigger = wrapper.querySelector('.icon-select-trigger');
    const dropdown = wrapper.querySelector('.icon-select-dropdown');
    const hiddenInput = wrapper.querySelector('input[type="hidden"]');

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllIconSelects();
      wrapper.classList.toggle('is-open');
    });

    // Option click
    dropdown.querySelectorAll('.icon-select-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const value = opt.dataset.value;
        hiddenInput.value = value;
        syncIconSelectDisplay(wrapper, value);
        wrapper.classList.remove('is-open');
        hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  });

  // Close on outside click
  document.addEventListener('click', closeAllIconSelects);
}

function syncIconSelectDisplay(wrapper, value) {
  const display = wrapper.querySelector('.icon-select-display');
  const options = wrapper.querySelectorAll('.icon-select-option');
  options.forEach(opt => {
    opt.classList.toggle('is-selected', opt.dataset.value === value);
    if (opt.dataset.value === value) {
      display.innerHTML = opt.innerHTML;
    }
  });
}

function closeAllIconSelects() {
  document.querySelectorAll('.icon-select.is-open').forEach(s => s.classList.remove('is-open'));
}

function bindDownloadSettingsShortcut() {
  const openDownloadsBtn = document.getElementById('openDownloadsBtn');
  const statusEl = document.getElementById('downloadSettingsStatus');
  if (!openDownloadsBtn || !statusEl) return;

  const isEdge = navigator.userAgent.includes('Edg');
  const settingsUrl = isEdge ? 'edge://settings/downloads' : 'chrome://settings/downloads';
  let hideTimer = null;

  const showStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.style.display = 'block';
    statusEl.style.opacity = '1';
    statusEl.style.color = isError ? 'var(--danger)' : 'var(--success)';
    statusEl.style.borderColor = isError ? 'rgba(239,68,68,0.25)' : 'rgba(16,185,129,0.25)';
    statusEl.style.background = isError ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => {
        statusEl.style.display = 'none';
      }, 300);
    }, 4000);
  };

  const fallbackToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(settingsUrl);
      showStatus(`${i18n('downloadPromptCopied')} ${settingsUrl}`);
    } catch (error) {
      showStatus(`${i18n('downloadPromptManual')} ${settingsUrl}`, true);
    }
  };

  openDownloadsBtn.addEventListener('click', async () => {
    try {
      const createdTab = await chrome.tabs.create({ url: settingsUrl });
      if (!createdTab) {
        await fallbackToClipboard();
      }
    } catch (error) {
      await fallbackToClipboard();
    }
  });
}

// ── Utilities ──

let toastEl = null;
function showSaveToast() {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'save-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = chrome.i18n.getMessage('settingsSaved') || '✅ 设置已保存!';
  toastEl.classList.add('show');
  setTimeout(() => { toastEl.classList.remove('show'); }, 2000);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

let currentPerformanceFiles = [];
let currentPerformanceFilter = 'all';

function bindPerformanceControls() {
  document.getElementById('refreshPerformanceBtn')?.addEventListener('click', () => {
    loadPerformanceData();
  });

  document.querySelectorAll('.status-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPerformanceFilter = btn.dataset.status || 'all';
      document.querySelectorAll('.status-filter-btn').forEach(item => {
        item.classList.toggle('active', item === btn);
      });
      renderPerformanceTree(currentPerformanceFiles);
      renderPerformanceFileList(currentPerformanceFiles);
    });
  });
}

async function loadPerformanceData() {
  const result = await chrome.storage.local.get(['exportState', 'fileInfo']);
  const exportState = result.exportState || {};
  const fileInfo = result.fileInfo || {};
  const fileList = Array.isArray(exportState.fileList) && exportState.fileList.length
    ? exportState.fileList
    : (Array.isArray(fileInfo.fileList) ? fileInfo.fileList : []);

  currentPerformanceFiles = fileList;
  renderPerformanceSummary(fileList);
  renderPerformanceTree(fileList);
  renderSlowestFiles(fileList);
  renderPerformanceFileList(fileList);
}

function renderPerformanceSummary(fileList) {
  const container = document.getElementById('performanceSummary');
  if (!container) return;

  if (!fileList.length) {
    container.innerHTML = `<p class="performance-empty">${i18n('performanceEmpty')}</p>`;
    return;
  }

  const successFiles = fileList.filter(file => file.status === 'success');
  const failedFiles = fileList.filter(file => file.status === 'failed');
  const pendingFiles = fileList.filter(file => file.status !== 'success' && file.status !== 'failed');
  const totalDuration = successFiles.reduce((sum, file) => sum + (Number(file.duration) || 0), 0);
  const avgDuration = successFiles.length ? totalDuration / successFiles.length : 0;

  const metrics = [
    { label: i18n('metricTotalFiles'), value: String(fileList.length) },
    { label: i18n('metricSuccessFiles'), value: String(successFiles.length) },
    { label: i18n('metricFailedFiles'), value: String(failedFiles.length) },
    { label: i18n('metricPendingFiles'), value: String(pendingFiles.length) },
    { label: i18n('metricAvgDuration'), value: formatDuration(avgDuration) },
    { label: i18n('metricTotalDuration'), value: formatDuration(totalDuration) }
  ];

  container.innerHTML = metrics.map(metric => `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(metric.label)}</div>
      <div class="metric-value">${escapeHtml(metric.value)}</div>
    </div>
  `).join('');
}

function renderSlowestFiles(fileList) {
  const container = document.getElementById('slowestFilesContainer');
  if (!container) return;

  const slowestFiles = [...fileList]
    .filter(file => file.status === 'success' && Number(file.duration) > 0)
    .sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))
    .slice(0, 10);

  if (!slowestFiles.length) {
    container.innerHTML = `<p class="performance-empty">${i18n('performanceNoSlowFiles')}</p>`;
    return;
  }

  container.innerHTML = slowestFiles.map((file, index) => `
    <div class="slow-item">
      <div class="slow-rank">${index + 1}</div>
      <div class="slow-main">
        <div class="slow-title">${escapeHtml(file.title || i18n('performanceUntitled'))}</div>
        <div class="slow-meta">${escapeHtml(buildDisplayPath(file))}</div>
      </div>
      <div class="slow-duration">${escapeHtml(formatDuration(file.duration))}</div>
    </div>
  `).join('');
}

function renderPerformanceFileList(fileList) {
  const container = document.getElementById('performanceFileList');
  if (!container) return;

  const filteredFiles = fileList.filter(file => {
    if (currentPerformanceFilter === 'all') return true;
    if (currentPerformanceFilter === 'pending') {
      return file.status !== 'success' && file.status !== 'failed';
    }
    return file.status === currentPerformanceFilter;
  });

  if (!filteredFiles.length) {
    container.innerHTML = `<p class="performance-empty">${i18n('performanceNoMatchingFiles')}</p>`;
    return;
  }

  const rows = filteredFiles.map(file => `
    <tr>
      <td>${escapeHtml(file.title || i18n('performanceUntitled'))}</td>
      <td>${escapeHtml(file.bookName || '-')}</td>
      <td>${escapeHtml(statusLabel(file.status))}</td>
      <td>${escapeHtml(file.localPath || buildDisplayPath(file))}</td>
      <td>${escapeHtml(formatDuration(file.duration))}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="performance-table">
      <thead>
        <tr>
          <th>${escapeHtml(i18n('performanceColTitle'))}</th>
          <th>${escapeHtml(i18n('performanceColBook'))}</th>
          <th>${escapeHtml(i18n('performanceColStatus'))}</th>
          <th>${escapeHtml(i18n('performanceColPath'))}</th>
          <th>${escapeHtml(i18n('performanceColDuration'))}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderPerformanceTree(fileList) {
  const container = document.getElementById('performanceTree');
  if (!container) return;

  const filteredFiles = fileList.filter(file => {
    if (currentPerformanceFilter === 'all') return true;
    if (currentPerformanceFilter === 'pending') {
      return file.status !== 'success' && file.status !== 'failed';
    }
    return file.status === currentPerformanceFilter;
  });

  if (!filteredFiles.length) {
    container.innerHTML = `<p class="performance-empty">${i18n('performanceNoMatchingFiles')}</p>`;
    return;
  }

  const tree = {};
  filteredFiles.forEach(file => {
    const parts = [];
    if (file.bookName) parts.push(file.bookName);
    if (file.folderPath) {
      parts.push(...String(file.folderPath).split('/').filter(Boolean));
    }

    let current = tree;
    parts.forEach(part => {
      current[part] = current[part] || {};
      current = current[part];
    });
    current._files = current._files || [];
    current._files.push(file);
  });

  container.innerHTML = '';
  container.appendChild(createTreeElement(tree));

  container.querySelectorAll('.performance-tree-folder-label').forEach(label => {
    label.addEventListener('click', () => {
      label.parentElement.classList.toggle('collapsed');
    });
  });
}

function createTreeElement(node) {
  const ul = document.createElement('ul');
  Object.keys(node).sort((a, b) => {
    if (a === '_files') return 1;
    if (b === '_files') return -1;
    return a.localeCompare(b, 'zh-CN');
  }).forEach(key => {
    if (key === '_files') {
      node._files
        .slice()
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'))
        .forEach(file => {
          const li = document.createElement('li');
          li.className = 'performance-tree-file';
          li.innerHTML = `
            <div class="performance-tree-file-main">
              <span class="performance-tree-status performance-tree-status-${escapeHtml(file.status || 'pending')}">${escapeHtml(statusLabel(file.status))}</span>
              <span class="performance-tree-file-name">${escapeHtml(file.title || i18n('performanceUntitled'))}</span>
            </div>
            <div class="performance-tree-file-meta">
              <span>${escapeHtml(formatDuration(file.duration))}</span>
              <span>${escapeHtml(file.localPath || '-')}</span>
            </div>
          `;
          ul.appendChild(li);
        });
      return;
    }

    const li = document.createElement('li');
    li.className = 'performance-tree-folder collapsed';
    li.innerHTML = `<span class="performance-tree-folder-label">${escapeHtml(key)}</span>`;
    li.appendChild(createTreeElement(node[key]));
    ul.appendChild(li);
  });

  return ul;
}

function buildDisplayPath(file) {
  const segments = [];
  if (file.bookName) segments.push(file.bookName);
  if (file.folderPath) segments.push(file.folderPath);
  if (file.title) segments.push(file.title);
  return segments.filter(Boolean).join('/') || '-';
}

function formatDuration(durationMs) {
  const duration = Number(durationMs);
  if (!duration || duration <= 0) return '-';
  if (duration < 1000) return `${duration} ms`;
  return `${(duration / 1000).toFixed(2)} s`;
}

function statusLabel(status) {
  switch (status) {
    case 'success':
      return i18n('filterSuccess');
    case 'failed':
      return i18n('filterFailed');
    case 'pending':
    case 'in_progress':
      return i18n('filterPending');
    default:
      return status || '-';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
