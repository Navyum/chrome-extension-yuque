export const YUQUE_API = {
  BASE: 'https://www.yuque.com/api',
  MINE: 'https://www.yuque.com/api/mine',
  BOOK_STACKS: 'https://www.yuque.com/api/mine/book_stacks',
  COLLAB_BOOKS: 'https://www.yuque.com/api/mine/raw_collab_books',
  GROUP_BOOKS: 'https://www.yuque.com/api/mine/user_books?user_type=Group',
  HOME_PAGE: 'https://www.yuque.com',
  CDN_HOSTS: ['cdn.nlark.com', 'cdn.yuque.com', 'cdn-china-mainland.yuque.com', 'gw.alipayobjects.com'],
};

export const DOC_TYPES = {
  DOC:   'Doc',
  SHEET: 'Sheet',
  BOARD: 'Board',
  TABLE: 'Table',
};

// Types we can export to standard formats
export const SUPPORTED_DOC_TYPES = new Set([DOC_TYPES.DOC, DOC_TYPES.SHEET, DOC_TYPES.TABLE, DOC_TYPES.BOARD]);

// Export format definitions (our internal format keys)
export const EXPORT_FORMATS = {
  md:   { extension: 'md',   label: 'Markdown (.md)' },
  docx: { extension: 'docx', label: 'Word (.docx)' },
  pdf:  { extension: 'pdf',  label: 'PDF (.pdf)' },
  jpg:  { extension: 'jpg',  label: 'JPG (.jpg)' },
  png:  { extension: 'png',  label: 'PNG (.png)' },
  svg:  { extension: 'svg',  label: 'SVG (.svg)' },
  xlsx: { extension: 'xlsx', label: 'Excel (.xlsx)' },
  csv:  { extension: 'csv',  label: 'CSV (.csv)' },
  html: { extension: 'html', label: 'HTML (.html)' },
};

// Per doc-type: available formats, default, and the ACTUAL API "type" param
// CRITICAL: apiType is what the server accepts, NOT our format key
export const DOC_TYPE_EXPORT_OPTIONS = {
  [DOC_TYPES.DOC]: {
    formats: ['md', 'docx', 'pdf', 'jpg'],
    defaultFormat: 'md',
    apiTypeMap: { md: 'markdown', docx: 'word', pdf: 'pdf', jpg: 'jpg' },
  },
  [DOC_TYPES.SHEET]: {
    formats: ['xlsx', 'csv', 'md', 'html'],
    defaultFormat: 'xlsx',
    apiTypeMap: { xlsx: 'excel' },
  },
  [DOC_TYPES.BOARD]: {
    formats: ['png', 'jpg', 'svg'],
    defaultFormat: 'png',
    apiTypeMap: {},
  },
  [DOC_TYPES.TABLE]: {
    formats: ['xlsx'],
    defaultFormat: 'xlsx',
    apiTypeMap: { xlsx: 'excel' },  // Server expects "excel", not "xlsx"
  },
};

// Options passed to the export API per apiType
export const EXPORT_OPTIONS = {
  // latexType:2 = raw editable LaTeX (1 = LaTeX as image)
  // enableAnchor:1 = keep Yuque anchors
  // enableBreak:1 = keep line breaks
  // useMdai:1 = export PlantUML and extra card content
  markdown: '{"latexType":2,"enableAnchor":1,"enableBreak":1,"useMdai":1}',
  pdf:      '{"enableToc":1}',
};

// "Smart export" uses per-type defaults
export const SMART_EXPORT_KEY = 'smart';

export const DEFAULT_SETTINGS = {
  exportType: 'smart',
  requestInterval: 500,
  subfolder: '语雀备份',
  downloadImages: true,       // Download CDN images to local assets/ for Markdown
  imageConcurrency: 3,
  docExportFormat: 'md',
  sheetExportFormat: 'xlsx',
  boardExportFormat: 'png',
  tableExportFormat: 'xlsx',
  skipEncryptedBookmarks: false, // 收藏中跳过加密文档/知识库
  markdownMode: 'local',         // 'local' = Lake HTML本地转换, 'api' = 官方导出API
  sheetMode: 'local',            // 'local' = 本地引擎, 'api' = 官方导出API（仅xlsx，仅有权限的文档）
};

export const EXPORT_POLL_MAX = 60;
export const EXPORT_POLL_INTERVAL = 3000;

// Bookmarks (收藏) virtual book
export const BOOKMARKS_VIRTUAL_BOOK_ID = '__bookmarks__';
export const BOOKMARKS_VIRTUAL_BOOK_NAME = '收藏';
export const BOOKMARKS_LOOSE_DOCS_FOLDER = '单篇收藏';

// RSA public key for Yuque password encryption
export const YUQUE_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCfwyOyncSrUTmkaUPsXT6UUdXx
TQ6a0wgPShvebfwq8XeNj575bUlXxVa/ExIn4nOUwx6iR7vJ2fvz5Ls750D051S7
q70sevcmc8SsBNoaMQtyF/gETPBSsyWv3ccBJFrzZ5hxFdlVUfg6tXARtEI8rbIH
su6TBkVjk+n1Pw/ihQIDAQAB
-----END PUBLIC KEY-----`;
