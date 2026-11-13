// Focused regression checks with mocked Chrome APIs; no account data or downloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindow } = require('@mixmark-io/domino');
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const constants = await import(`data:text/javascript,${encodeURIComponent(read('src/core/constants.js'))}`);

function load(file, globals, names) {
  const source = read(file).replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ ...constants, ...globals });
  vm.runInContext(`${source}\nObject.assign(globalThis, { ${names.join(', ')} });`, context);
  return context;
}

let listener;
let settings = { docExportFormat: 'docx', markdownMode: 'local', downloadImages: false };
let rejectExport = false;
const downloads = [];
const apiCalls = [];
const contentCalls = [];
const state = { bookList: [], fileList: [], exportType: 'smart', isExporting: false };
const noOp = () => {};
const exporter = load('src/core/exporter.js', {
  Blob, URL, setTimeout, console, exportState: state,
  chrome: {
    runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: { get: async () => settings } },
    i18n: { getMessage: () => '' },
    alarms: { clear: noOp },
  },
  waitForStateReady: async () => {}, saveState: async () => {},
  checkAuth: async () => ({ isLoggedIn: true, login: 'fixture' }),
  fetchAllBooks: async () => [{ id: 2, name: 'Fresh list' }],
  fetchDocContent: async (...args) => {
    contentCalls.push(args);
    return { content: '<p>Local fixture</p>' };
  },
  lakeToMarkdown: () => 'Local fixture',
  sendLog: noOp, sendProgress: noOp, sendError: noOp, sendComplete: noOp,
  resetThrottle: noOp, refreshAbortController: noOp, delay: async () => {},
  sanitizePathComponent: s => s, sanitizePathSegments: s => s.split('/'),
  exportDocAsync: async (...args) => {
    apiCalls.push(args);
    if (rejectExport) throw new Error('Export permission denied');
    return { blob: new Blob(['Word fixture']) };
  },
  saveBlobToDisk: async (_, path) => { downloads.push(path); },
}, ['registerRuntimeHandlers']);
exporter.registerRuntimeHandlers();
const message = (action, data) => new Promise(resolve => {
  listener({ action, data }, { tab: { id: 1, url: 'https://team.yuque.com/book/doc' } }, resolve);
});

const quickDoc = { docId: 1, slug: 'doc', bookId: 2, title: 'Document', docType: 'Doc' };
for (const canExport of [true, false, undefined]) {
  const response = await message('quickExport', { ...quickDoc, canExport });
  assert.equal(response.success, true);
  assert.equal(response.format, 'docx');
  assert.equal(downloads.at(-1).endsWith('.docx'), true);
  assert.equal(apiCalls.at(-1)[2], 'docx');
}

for (const bookType of ['personal', 'collab', 'team', 'org-personal', 'wiki']) {
  state.fileList = [{ id: 1, slug: 'doc', bookId: 2, title: 'Document', docType: 'Doc', bookType }];
  assert.equal((await message('reExportFile', { fileIndex: 0 })).success, true);
  assert.equal(downloads.at(-1).endsWith('.docx'), true);
}

rejectExport = true;
const countBefore = downloads.length;
assert.equal((await message('quickExport', quickDoc)).success, false);
// Exercise the batch runner's API failure branch: it must not silently save Markdown.
state.fileList = [{ id: 1, slug: 'doc', bookId: 2, title: 'Document', docType: 'Doc', status: 'pending' }];
assert.equal((await message('startExport', { exportType: 'smart' })).success, true);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(state.isExporting, false);
assert.equal(state.fileList[0].status, 'failed');
assert.equal(downloads.length, countBefore);
assert.equal((await message('getBooks')).data[0].name, 'Fresh list');

settings = { ...settings, docExportFormat: 'md' };
const localResponse = await message('quickExport', { ...quickDoc, canExport: false });
assert.equal(localResponse.success, true);
assert.equal(localResponse.format, 'md');
assert.equal(downloads.at(-1).endsWith('.md'), true);
assert.equal(contentCalls.at(-1)[2], 'https://team.yuque.com');

const window = createWindow('<div id="group"><button id="trigger"></button><span id="label"></span><ul id="options"></ul></div>');
let savedIds = [2];
const ui = load('src/ui/ui.js', {
  window, document: window.document, setTimeout, clearTimeout,
  chrome: { storage: { local: {
    get: async () => ({ selectedBookIds: savedIds }),
    set: data => { savedIds = data.selectedBookIds; },
  } } },
  domRefs: {
    bookSelectGroup: window.document.getElementById('group'),
    bookSelectTrigger: window.document.getElementById('trigger'),
    bookSelectLabel: window.document.getElementById('label'),
    bookSelectOptions: window.document.getElementById('options'),
  },
  i18n: key => key, uiState: { bookList: [], isExporting: false },
  updateUiState: noOp,
}, ['renderBookDropdown', 'restoreBookSelection', 'getSelectedBookIds']);
const books = [{ id: 2, name: 'Kept', type: 'personal' }, { id: 3, name: 'New', type: 'personal' }];
for (const selection of [[2], [], [99, 2]]) {
  savedIds = selection;
  ui.renderBookDropdown(books);
  assert.deepEqual(savedIds, selection, 'render must not overwrite saved selection');
  await ui.restoreBookSelection();
  assert.deepEqual(Array.from(ui.getSelectedBookIds()), selection.filter(id => id === 2));
}

// Check route detection from the actual content script without starting its UI.
const bubbleSource = read('src/content/bubble.js');
const detector = bubbleSource.match(/  function isDocPage\(\) \{[\s\S]*?\n  \}/)[0];
for (const [hostname, pathname, expected] of [
  ['www.yuque.com', '/user/book/doc', true],
  ['team.yuque.com', '/book/doc', true],
  ['www.yuque.com', '/dashboard', false],
  ['team.yuque.com', '/book', false],
  ['www.yuque.com', '/new-team/book/doc', true],
]) {
  assert.equal(vm.runInNewContext(`${detector}\nisDocPage()`, { location: { hostname, pathname } }), expected);
}
console.log('Passed: Word routing, API failure behavior, list refresh, selection persistence, and page detection.');
