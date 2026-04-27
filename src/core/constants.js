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
// Board only supports lakeboard/lake (proprietary) — skip it
export const SUPPORTED_DOC_TYPES = new Set([DOC_TYPES.DOC, DOC_TYPES.SHEET, DOC_TYPES.TABLE]);
export const SKIPPED_DOC_TYPES = new Set([DOC_TYPES.BOARD]);

// Export format definitions (our internal format keys)
export const EXPORT_FORMATS = {
  md:   { extension: 'md',   label: 'Markdown (.md)' },
  docx: { extension: 'docx', label: 'Word (.docx)' },
  pdf:  { extension: 'pdf',  label: 'PDF (.pdf)' },
  jpg:  { extension: 'jpg',  label: 'JPG (.jpg)' },
  xlsx: { extension: 'xlsx', label: 'Excel (.xlsx)' },
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
    formats: ['xlsx'],
    defaultFormat: 'xlsx',
    apiTypeMap: { xlsx: 'excel' },
  },
  // Board: only supports lakeboard/lake (proprietary) — not exportable to standard formats
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
  subfolder: '',
  downloadImages: true,       // Download CDN images to local assets/ for Markdown
  imageConcurrency: 3,
  docExportFormat: 'md',
  sheetExportFormat: 'xlsx',
  tableExportFormat: 'xlsx',
};

export const EXPORT_POLL_MAX = 60;
export const EXPORT_POLL_INTERVAL = 3000;
