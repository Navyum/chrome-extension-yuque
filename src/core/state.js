function createInitialState() {
  return {
    isExporting: false,
    isPaused: false,
    totalFiles: 0,
    folderCount: 0,
    currentFileIndex: 0,
    bookList: [],      // { id, slug, name, docs_count, updated_at, namespace, type:'personal'|'collab' }
    fileList: [],       // { id, slug, title, bookId, bookName, folderPath, status, localPath, ... }
    exportType: 'md',
    subfolder: '',
    downloadLocation: '',  // 自定义下载保存位置（绝对路径），留空则使用浏览器默认下载目录
    requestInterval: 500,
    downloadImages: true,
    logs: [],
    // User info
    userInfo: null,     // { id, login, name, avatar_url }
    // Encrypted bookmark items pending password
    encryptedItems: [], // { type:'book'|'doc', id, title, bookId?, bookName }
  };
}

const exportState = createInitialState();
let stateReadyPromise = null;

function overwriteState(nextState) {
  Object.keys(exportState).forEach(key => { delete exportState[key]; });
  Object.assign(exportState, nextState);
}

export function resetExportState() {
  overwriteState(createInitialState());
  return exportState;
}

export { exportState };

function buildSerializableExportState() {
  const { fileList, bookList, ...rest } = exportState;
  return { ...rest };
}

export async function saveState() {
  const payload = {
    exportState: buildSerializableExportState(),
    fileInfo: {
      totalFiles: exportState.totalFiles,
      folderCount: exportState.folderCount || 0,
      fileList: exportState.fileList || [],
      bookList: exportState.bookList || []
    }
  };
  await chrome.storage.local.set(payload);
}

export async function loadState() {
  try {
    const result = await chrome.storage.local.get(['exportState', 'fileInfo']);
    if (result.exportState) {
      const fileInfo = result.fileInfo || {};
      const fileList = Array.isArray(fileInfo.fileList)
        ? fileInfo.fileList
        : (Array.isArray(result.exportState.fileList) ? result.exportState.fileList : []);
      const bookList = Array.isArray(fileInfo.bookList)
        ? fileInfo.bookList
        : (Array.isArray(result.exportState.bookList) ? result.exportState.bookList : []);
      overwriteState({
        ...createInitialState(),
        ...result.exportState,
        fileList,
        bookList,
        totalFiles: fileInfo.totalFiles ?? result.exportState.totalFiles ?? fileList.length,
        folderCount: fileInfo.folderCount ?? result.exportState.folderCount ?? 0
      });
      return { restored: true };
    }
    if (result.fileInfo) {
      exportState.fileList = result.fileInfo.fileList || [];
      exportState.totalFiles = result.fileInfo.totalFiles || 0;
      exportState.folderCount = result.fileInfo.folderCount || 0;
      exportState.bookList = result.fileInfo.bookList || [];
    }
    return { restored: false };
  } catch (error) {
    return { restored: false, error };
  }
}

export function initState() {
  if (!stateReadyPromise) {
    stateReadyPromise = loadState();
  }
  return stateReadyPromise;
}

export function waitForStateReady() {
  return stateReadyPromise || initState();
}
