/**
 * Lake HTML → Markdown converter.
 * Handles Yuque's proprietary Lake format (<!doctype lake>...) with <card> elements.
 */
import TurndownService from 'turndown';

// Store card markdown outputs, keyed by index, restored after turndown
let cardOutputs = [];

function storeCardOutput(md) {
  const idx = cardOutputs.length;
  cardOutputs.push(md);
  return idx;
}

/**
 * Decode a card's value attribute.
 * Format: "data:" + URL-encoded JSON string
 */
function decodeCardValue(value) {
  if (!value || !value.startsWith('data:')) return {};
  try {
    const raw = value.slice(5);
    const decoded = decodeURIComponent(raw);
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html = '') {
  return decodeHtmlEntities(String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u200b/g, '')
  ).replace(/[ \t]+\n/g, '\n').trim();
}

function escapeMarkdownTableCell(value = '') {
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, '<br>')
    .trim();
}

function tableToMarkdown(rows) {
  const normalizedRows = rows
    .map(row => row.map(cell => escapeMarkdownTableCell(cell)))
    .filter(row => row.some(Boolean));

  if (!normalizedRows.length) return '';

  const colCount = Math.max(...normalizedRows.map(row => row.length));
  const paddedRows = normalizedRows.map(row => {
    const padded = row.slice();
    while (padded.length < colCount) padded.push('');
    return padded;
  });

  const header = paddedRows[0];
  const separator = Array(colCount).fill('---');
  const body = paddedRows.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`)
  ].join('\n');
}

function nativeTableToMarkdown(tableNode) {
  const rows = Array.from(tableNode.getElementsByTagName('tr') || []).map(row => {
    return Array.from(row.childNodes || [])
      .filter(cell => ['TD', 'TH'].includes(cell.nodeName))
      .map(cell => cell.textContent || '');
  });
  return tableToMarkdown(rows);
}

function getDataTableColumns(content) {
  const sheet = content?.sheet?.[0];
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  if (!columns.length) return [];

  const activeViewId = sheet.activeView || sheet.defaultView;
  const viewColumns = activeViewId ? sheet.views?.[activeViewId]?.columns : null;
  if (!Array.isArray(viewColumns) || !viewColumns.length) return columns;

  const byId = new Map(columns.map(col => [col.id, col]));
  const ordered = viewColumns.map(col => byId.get(col.id)).filter(Boolean);
  const missing = columns.filter(col => !ordered.some(item => item.id === col.id));
  return [...ordered, ...missing];
}

function stringifyDataTableValue(rawValue, column, content) {
  const value = rawValue?.value ?? rawValue;
  if (value === undefined || value === null) return '';

  if (column?.type === 'select') {
    const options = new Map((column.options || []).map(option => [option.id, option.value]));
    if (Array.isArray(value)) return value.map(item => options.get(item) || item).join(', ');
    return options.get(value) || String(value);
  }

  if (column?.type === 'date' && typeof value === 'object') {
    return value.text || value.time || '';
  }

  if (column?.type === 'checkbox') return value ? '[x]' : '[ ]';

  if (column?.type === 'user') {
    const users = new Map((content?.users || []).map(user => [user.id, user.name || user.login || user.id]));
    const ids = Array.isArray(value) ? value : [value];
    return ids.map(id => users.get(id) || String(id)).join(', ');
  }

  if (typeof value === 'object') {
    if (value.text) return value.text;
    if (value.name) return value.name;
    if (value.url && value.title) return `[${value.title}](${value.url})`;
    if (value.url && value.text) return `[${value.text}](${value.url})`;
    return JSON.stringify(value);
  }

  return String(value);
}

function dataTableToMarkdown(data) {
  const content = data.content;
  const columns = getDataTableColumns(content);
  const records = Array.isArray(content?.records) ? content.records : [];

  if (!content || !columns.length) {
    const id = data.tableId || data.sheetId || data.id || '';
    return id ? `\n> 数据表格：${id}\n` : '';
  }

  const rows = [
    columns.map(column => column.name || column.id || '')
  ];

  records.forEach(record => {
    let recordData = {};
    try {
      recordData = typeof record.data === 'string' ? JSON.parse(record.data) : (record.data || {});
    } catch {
      recordData = {};
    }

    rows.push(columns.map(column => stringifyDataTableValue(recordData[column.id], column, content)));
  });

  return `\n${tableToMarkdown(rows)}\n`;
}

function formatDateCard(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function extractBoardItems(diagramData) {
  const items = [];

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object') return;
    const text = htmlToText(node.html || node.text || node.name || '');
    if (text) items.push({ depth, text, type: node.type || node.shape || '' });
    if (Array.isArray(node.children)) node.children.forEach(child => walk(child, depth + 1));
  }

  const body = Array.isArray(diagramData?.body) ? diagramData.body : [];
  body
    .slice()
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
    .forEach(node => walk(node));

  return items.filter(item => item.text && item.text !== '\u200b');
}

function boardToMarkdown(data) {
  const src = data.url || data.src || '';
  if (src) return `![图表](${src})`;

  const items = extractBoardItems(data.diagramData);
  const lines = ['**白板/图形**'];
  if (data.search) lines.push('', htmlToText(data.search));
  if (items.length) {
    lines.push('');
    items.forEach(item => {
      const indent = '  '.repeat(item.depth);
      const label = item.type ? `${item.type}: ` : '';
      lines.push(`${indent}- ${label}${item.text}`);
    });
  }

  if (data.diagramData) {
    lines.push('', '<details>', '<summary>白板原始数据</summary>', '', '```yuque-board');
    lines.push(JSON.stringify(data.diagramData, null, 2));
    lines.push('```', '', '</details>');
  }

  return `\n${lines.join('\n')}\n`;
}

/**
 * Convert a <card> element to Markdown based on its name.
 */
function convertCard(name, value) {
  const data = decodeCardValue(value);

  switch (name) {
    case 'hr':
      return '\n---\n';

    case 'image': {
      const src = data.src || '';
      const alt = data.name || data.title || '';
      return src ? `![${alt}](${src})` : '';
    }

    case 'codeblock': {
      const lang = data.mode || '';
      const code = data.code || '';
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    case 'markdown': {
      return data.markdown ? `\n${data.markdown}\n` : '';
    }

    case 'math': {
      const code = data.code || '';
      return code ? `\n$$\n${code}\n$$\n` : '';
    }

    case 'bookmarklink':
    case 'bookmarkInline': {
      const src = data.src || '';
      const title = data.detail?.title || data.text || src;
      return src ? `[${title}](${src})` : '';
    }

    case 'yuqueinline': {
      const src = data.src || '';
      const title = data.detail?.title || data.name || src;
      return src ? `[${title}](${src})` : '';
    }

    case 'localdoc': {
      const src = data.src || '';
      const fileName = data.name || '附件';
      return src ? `[${fileName}](${src})` : '';
    }

    case 'diagram':
    case 'flowchart2': {
      const code = data.code || '';
      const lang = data.type === 'mermaid' || name === 'flowchart2' ? 'mermaid' : '';
      if (code) return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
      const src = data.url || data.src || '';
      if (src) return `![图表](${src})`;
      return '';
    }

    case 'board':
      return boardToMarkdown(data);

    case 'table': {
      const html = data.html || '';
      return html ? `\n${html}\n` : '';
    }

    case 'dataTable':
      return dataTableToMarkdown(data);

    case 'dateCard': {
      const text = formatDateCard(data.date);
      return text ? `\n${text}\n` : '';
    }

    case 'imageGallery': {
      const images = data.imageList || [];
      return images.map(img => {
        const src = img.src || '';
        const alt = img.title || '';
        return src ? `![${alt}](${src})` : '';
      }).filter(Boolean).join('\n');
    }

    case 'mention': {
      const name = data.name || data.login || '';
      return name ? `@${name}` : '';
    }

    case 'label': {
      const text = data.text || data.label || '';
      return text ? `\`${text}\`` : '';
    }

    case 'checkIn':
      return '';

    default:
      // Unknown card — try to extract any useful text
      if (data.src) return `[${data.name || data.title || '链接'}](${data.src})`;
      if (data.url) return `[${data.name || data.title || '链接'}](${data.url})`;
      if (data.text) return data.text;
      if (data.search) return htmlToText(data.search);
      return '';
  }
}

/**
 * Convert Lake HTML content to Markdown.
 * @param {string} lakeHtml - The Lake HTML string (from doc.content field)
 * @returns {string} Markdown text
 */
export function lakeToMarkdown(lakeHtml) {
  if (!lakeHtml) return '';

  // Reset card output store
  cardOutputs = [];

  // Strip Lake doctype and meta tags
  let html = lakeHtml
    .replace(/<!doctype lake>/i, '')
    .replace(/<meta[^>]*>/gi, '');

  // Pre-process: replace <card> elements with placeholders
  // The actual markdown is stored in placeholderMap and restored AFTER turndown
  // This prevents turndown from escaping [ ] ( ) ! etc. in card output
  html = html.replace(/<card\s+([^>]*)><\/card>/gi, (match, attrs) => {
    return processCardAttrs(attrs);
  });
  html = html.replace(/<card\s+([^>]*)\/?>/gi, (match, attrs) => {
    return processCardAttrs(attrs);
  });

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  // Add custom rules
  turndown.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => `~~${content}~~`,
  });

  // Handle Lake alert/blockquote with class
  turndown.addRule('lakeAlert', {
    filter: (node) => node.nodeName === 'BLOCKQUOTE' && node.classList?.contains('lake-alert'),
    replacement: (content) => {
      const lines = content.trim().split('\n');
      return '\n' + lines.map(l => `> ${l}`).join('\n') + '\n';
    },
  });

  // Clean link handling
  turndown.addRule('cleanLinks', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      if (!href || href === '#') return content;
      return `[${content}](${href})`;
    },
  });

  // Turndown's default table handling flattens Lake tables into paragraphs.
  turndown.addRule('lakeTable', {
    filter: 'table',
    replacement: (content, node) => {
      const table = nativeTableToMarkdown(node);
      return table ? `\n\n${table}\n\n` : content;
    },
  });

  // Handle card-carrier <img data-card-idx="N"> — output stored markdown verbatim
  turndown.addRule('cardCarrier', {
    filter: (node) => node.nodeName === 'IMG' && node.getAttribute('data-card-idx') !== null,
    replacement: (content, node) => {
      const idx = parseInt(node.getAttribute('data-card-idx'), 10);
      return (idx >= 0 && idx < cardOutputs.length) ? cardOutputs[idx] : '';
    },
  });

  let markdown = turndown.turndown(html);

  // Post-process cleanup
  markdown = markdown
    // Remove turndown's escaping of standalone brackets (not part of links/images)
    // \[text\] where there's no following (url) → [text]
    .replace(/\\\[([^\]]*)\\\](?!\()/g, '[$1]')
    // Remove excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return markdown;
}

/**
 * Parse card attributes string, convert to markdown, store it, and return
 * a custom HTML element that turndown will handle via a custom rule.
 */
function processCardAttrs(attrsStr) {
  const nameMatch = attrsStr.match(/name="([^"]*)"/);
  const valueMatch = attrsStr.match(/value="([^"]*)"/);
  const name = nameMatch ? nameMatch[1] : '';
  const value = valueMatch ? valueMatch[1] : '';
  const md = convertCard(name, value);
  if (!md) return '';
  const idx = storeCardOutput(md);
  // Use an <img> tag as carrier — turndown recognizes img and we can hook it via addRule
  return `<img data-card-idx="${idx}" src="" alt="">`;
}

/**
 * Fetch a single doc's content via the detail API.
 * GET /api/docs/{slug}?book_id={bookId}
 * Returns the raw Lake HTML content.
 */
export async function fetchDocContent(slug, bookId) {
  const url = `https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&merge_dynamic_data=true`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'Origin': 'https://www.yuque.com',
      'Referer': 'https://www.yuque.com/',
    },
    credentials: 'include',
  });

  if (!resp.ok) {
    throw new Error(`获取文档内容失败: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  return {
    content: data.data?.content || data.data?.body_asl || '',
    body: data.data?.body || '',
    title: data.data?.title || '',
    canExport: data.data?.abilities?.export === true,
  };
}
