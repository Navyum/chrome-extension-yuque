export const domRefs = {
  exportTypeSelect: null,
  getInfoBtn: null,
  fileInfoDiv: null,
  totalFilesSpan: null,
  folderCountSpan: null,
  startBtn: null,
  pauseBtn: null,
  retrySection: null,
  retryFailedBtn: null,
  failedList: null,
  progressBar: null,
  progressFill: null,
  progressText: null,
  statusDiv: null,
  logContainer: null,
  resetBtn: null,
  settingsBtn: null,
  loginBtn: null,
  loginIcon: null,
  loginAvatar: null,
  sponsorBtn: null,
  sponsorModal: null,
  sponsorModalClose: null,
  mainContainer: null,
  selectContainer: null,
  selectIcon: null,
  selectTrigger: null,
  selectOptionsList: null,
  selectLabel: null,
  // User popup
  userInfoPopup: null,
  userAvatar: null,
  userName: null,
  userLogin: null,
  // Book dropdown
  bookSelectGroup: null,
  bookSelect: null,
  bookSelectTrigger: null,
  bookSelectOptions: null,
  bookSelectLabel: null,
  // Selection bar
  selectAllCheckbox: null,
  selectedCountSpan: null,
  selectedDocsSpan: null,
  selectionBar: null,
};

export function cacheDomElements() {
  domRefs.exportTypeSelect = document.getElementById('exportType');
  domRefs.getInfoBtn = document.getElementById('getInfo');
  domRefs.fileInfoDiv = document.getElementById('fileInfo');
  domRefs.totalFilesSpan = document.getElementById('totalFiles');
  domRefs.folderCountSpan = document.getElementById('folderCount');
  domRefs.startBtn = document.getElementById('startExport');
  domRefs.pauseBtn = document.getElementById('pauseExport');
  domRefs.retrySection = document.getElementById('retrySection');
  domRefs.retryFailedBtn = document.getElementById('retryFailedBtn');
  domRefs.failedList = document.getElementById('failedList');
  domRefs.progressBar = document.getElementById('progressBar');
  domRefs.progressFill = document.getElementById('progressFill');
  domRefs.progressText = document.getElementById('progressText');
  domRefs.statusDiv = document.getElementById('status');
  domRefs.logContainer = document.getElementById('logContainer');
  domRefs.resetBtn = document.getElementById('reset-btn');
  domRefs.settingsBtn = document.getElementById('settings-btn');
  domRefs.loginBtn = document.getElementById('login-btn');
  domRefs.loginIcon = document.getElementById('loginIcon');
  domRefs.loginAvatar = document.getElementById('loginAvatar');
  domRefs.sponsorBtn = document.getElementById('sponsor-btn');
  domRefs.sponsorModal = document.getElementById('sponsorModal');
  domRefs.sponsorModalClose = document.getElementById('sponsorModalClose');
  domRefs.mainContainer = document.querySelector('.container');
  domRefs.selectContainer = document.querySelector('.select-container');
  domRefs.selectIcon = document.getElementById('exportTypeIcon');
  domRefs.selectTrigger = document.getElementById('exportTypeTrigger');
  domRefs.selectOptionsList = document.getElementById('exportTypeOptions');
  domRefs.selectLabel = document.getElementById('exportTypeLabel');
  // User popup
  domRefs.userInfoPopup = document.getElementById('userInfoPopup');
  domRefs.userAvatar = document.getElementById('userAvatar');
  domRefs.userName = document.getElementById('userName');
  domRefs.userLogin = document.getElementById('userLogin');
  // Book dropdown
  domRefs.bookSelectGroup = document.getElementById('bookSelectGroup');
  // bookSelect removed - now using custom dropdown only
  domRefs.bookSelectTrigger = document.getElementById('bookSelectTrigger');
  domRefs.bookSelectOptions = document.getElementById('bookSelectOptions');
  domRefs.bookSelectLabel = document.getElementById('bookSelectLabel');
  // Selection bar
  domRefs.selectAllCheckbox = document.getElementById('selectAll');
  domRefs.selectedCountSpan = document.getElementById('selectedCount');
  domRefs.selectedDocsSpan = document.getElementById('selectedDocs');
  domRefs.selectionBar = document.getElementById('selectionBar');
}
