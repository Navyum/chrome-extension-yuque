import { applyI18n } from './ui/i18n.js';

const SETTINGS_KEYS = [
  'subfolder', 'requestInterval',
  'downloadImages', 'imageConcurrency',
  'docExportFormat', 'sheetExportFormat', 'tableExportFormat'
];

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  applyVersion();
  await loadSettings();
  bindNavigation();
  bindAutoSave();
});

function applyVersion() {
  const version = chrome.runtime.getManifest().version;
  document.querySelectorAll('[data-version]').forEach(el => {
    el.textContent = `v${version}`;
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEYS);

  setVal('subfolder', data.subfolder || '');
  setVal('requestInterval', data.requestInterval || 500);
  setChecked('downloadImages', data.downloadImages !== false);
  setVal('imageConcurrency', data.imageConcurrency || 3);
  setVal('docExportFormat', data.docExportFormat || 'md');
  setVal('sheetExportFormat', data.sheetExportFormat || 'xlsx');
  setVal('tableExportFormat', data.tableExportFormat || 'xlsx');
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
  };

  await chrome.storage.local.set(settings);

  showSaveToast();
}

function setVal(id, value) { const el = document.getElementById(id); if (el) el.value = value; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function setChecked(id, checked) { const el = document.getElementById(id); if (el) el.checked = checked; }
function getChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; }

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
