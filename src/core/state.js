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
    downloadImages: true,
    logs: [],
    // User info
    userInfo: null,     // { id, login, name, avatar_url }
  };
}

const exportState = createInitialState();

function overwriteState(nextState) {
  Object.keys(exportState).forEach(key => { delete exportState[key]; });
  Object.assign(exportState, nextState);
}

export function resetExportState() {
  overwriteState(createInitialState());
  return exportState;
}

export { exportState };

export async function saveState() {
  await chrome.storage.local.set({ exportState });
  if (exportState.fileList && exportState.fileList.length > 0) {
    await chrome.storage.local.set({
      fileInfo: {
        totalFiles: exportState.totalFiles,
        folderCount: exportState.folderCount || 0,
        fileList: exportState.fileList,
        bookList: exportState.bookList || []
      },
      totalFiles: exportState.totalFiles,
      folderCount: exportState.folderCount || 0
    });
  }
}

export async function loadState() {
  try {
    const result = await chrome.storage.local.get(['exportState', 'fileInfo']);
    if (result.exportState) {
      overwriteState({ ...createInitialState(), ...result.exportState });
      if ((!exportState.fileList || !exportState.fileList.length) && result.fileInfo) {
        exportState.fileList = result.fileInfo.fileList || [];
        exportState.totalFiles = result.fileInfo.totalFiles || 0;
        exportState.folderCount = result.fileInfo.folderCount || 0;
        exportState.bookList = result.fileInfo.bookList || [];
      }
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
