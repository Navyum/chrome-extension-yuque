export const uiState = {
  isExporting: false,
  isPaused: false,
  fileInfo: null,
  totalFiles: 0,
  bookList: [],
  selectedBookIds: [],
  userInfo: null,
};

export function updateUiState(partial = {}) {
  Object.assign(uiState, partial);
}
