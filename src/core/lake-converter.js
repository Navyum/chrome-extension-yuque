/**
 * Lake HTML → Markdown 转换器。
 * 处理语雀专有的 Lake 格式（<!doctype lake>...）及 <card> 元素。
 */
import TurndownService from 'turndown';

// 保存卡片转换后的 Markdown，按索引在 Turndown 后恢复。
let cardOutputs = [];

function storeCardOutput(md) {
  const idx = cardOutputs.length;
  cardOutputs.push(md);
  return idx;
}

/**
 * 解码卡片的 value 属性。
 * 格式："data:" + URL 编码后的 JSON 字符串。
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

function escapeMarkdownLinkText(value = '') {
  return String(value).replace(/]/g, '\\]');
}

function escapeMarkdownUrl(value = '') {
  return String(value).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

function escapeMarkdownImageAlt(value = '') {
  return String(value).replace(/]/g, '\\]').replace(/\r?\n+/g, ' ');
}

function markdownLink(label, url) {
  if (!url) return label || '';
  return `[${escapeMarkdownLinkText(label || url)}](${escapeMarkdownUrl(url)})`;
}

function markdownImage(alt, url) {
  if (!url) return '';
  return `![${escapeMarkdownImageAlt(alt || '')}](${escapeMarkdownUrl(url)})`;
}

function escapeMathInline(code = '') {
  return String(code).replace(/\$/g, '\\$').replace(/\r?\n+/g, ' ').trim();
}

function markdownMath(code = '', display = 'inline') {
  const trimmed = String(code || '').trim();
  if (!trimmed) return '';
  // 默认使用行内公式。块级公式会破坏 Markdown 表格和句子流，
  // 因此只有显式标记的独立公式才使用 $$。
  if (display === 'block') return `\n$$\n${trimmed}\n$$\n`;
  return `$${escapeMathInline(trimmed)}$`;
}

// 原生 Lake 表格可能包含富文本内联 HTML，而不只是纯文本。
// 在表格转义前先转换常见内联标签，确保链接和图片能保留下来。
function inlineNodeToMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';

  const tag = node.nodeName;
  const children = () => Array.from(node.childNodes || []).map(inlineNodeToMarkdown).join('');

  switch (tag) {
    case 'BR':
      return '\n';
    case 'A': {
      const text = children() || node.textContent || '';
      const href = node.getAttribute('href') || '';
      return href ? markdownLink(text, href) : text;
    }
    case 'IMG': {
      const cardIdx = node.getAttribute('data-card-idx');
      if (cardIdx !== null) {
        const idx = parseInt(cardIdx, 10);
        // 表格转换会直接遍历 DOM 节点，不经过 Turndown 的 cardCarrier 规则，
        // 所以这里也要恢复卡片对应的 Markdown。
        return (idx >= 0 && idx < cardOutputs.length) ? cardOutputs[idx] : '';
      }
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || node.getAttribute('title') || '';
      return markdownImage(alt, src);
    }
    case 'CODE':
      return `\`${(node.textContent || '').replace(/`/g, '\\`')}\``;
    case 'STRONG':
    case 'B':
      return `**${children()}**`;
    case 'EM':
    case 'I':
      return `*${children()}*`;
    case 'DEL':
    case 'S':
      return `~~${children()}~~`;
    case 'P':
    case 'DIV':
      return `${children()}\n`;
    default:
      return children();
  }
}

function cellToMarkdown(cell) {
  return Array.from(cell.childNodes || [])
    .map(inlineNodeToMarkdown)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
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
  const rows = [];
  const rowspans = [];
  const tableRows = Array.from(tableNode.getElementsByTagName('tr') || []);

  tableRows.forEach((row, rowIndex) => {
    const output = [];
    let colIndex = 0;

    // Markdown 没有 rowspan/colspan，所以被合并单元格占用的位置用空白补齐，
    // 确保后续列仍与源表格对齐。
    while (rowspans[colIndex]?.remaining > 0) {
      output[colIndex] = '';
      rowspans[colIndex].remaining -= 1;
      colIndex += 1;
    }

    Array.from(row.childNodes || [])
      .filter(cell => ['TD', 'TH'].includes(cell.nodeName))
      .forEach(cell => {
        while (rowspans[colIndex]?.remaining > 0) {
          output[colIndex] = '';
          rowspans[colIndex].remaining -= 1;
          colIndex += 1;
        }

        const colspan = Math.max(parseInt(cell.getAttribute('colspan') || '1', 10) || 1, 1);
        const rowspan = Math.max(parseInt(cell.getAttribute('rowspan') || '1', 10) || 1, 1);
        output[colIndex] = cellToMarkdown(cell);
        for (let offset = 1; offset < colspan; offset += 1) output[colIndex + offset] = '';
        if (rowspan > 1) {
          for (let offset = 0; offset < colspan; offset += 1) {
            rowspans[colIndex + offset] = { remaining: rowspan - 1 };
          }
        }
        colIndex += colspan;
      });

    if (rowIndex > 0 || output.some(Boolean)) rows.push(output);
  });

  return tableToMarkdown(rows);
}

function getActiveDataTableView(content) {
  const sheet = content?.sheet?.[0];
  const activeViewId = sheet?.activeView || sheet?.defaultView;
  return activeViewId ? sheet?.views?.[activeViewId] : null;
}

function getDataTableColumns(content, options = {}) {
  const { includeHidden = false, forceIds = [] } = options;
  const sheet = content?.sheet?.[0];
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  if (!columns.length) return [];

  const view = getActiveDataTableView(content);
  const viewColumns = view?.columns;
  if (!Array.isArray(viewColumns) || !viewColumns.length) return columns;

  const byId = new Map(columns.map(col => [col.id, col]));
  const forced = new Set(forceIds.filter(Boolean));
  const ordered = viewColumns
    .filter(col => includeHidden || !col.hidden || forced.has(col.id))
    .map(col => byId.get(col.id))
    .filter(Boolean);
  const missing = columns.filter(col => !ordered.some(item => item.id === col.id));
  return includeHidden ? [...ordered, ...missing] : ordered;
}

function normalizeDecimalString(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function stringifyDataTableValue(rawValue, column, content, record = null) {
  const value = rawValue?.value ?? rawValue;
  if ((value === undefined || value === null) && (column?.type === 'createdAt' || column?.type === 'updatedAt')) {
    return formatIsoDateTime(record?.[column.type === 'createdAt' ? 'created_at' : 'updated_at']);
  }
  if (value === undefined || value === null) return '';

  // 语雀数据表格单元格保存的是选项 ID；这里解析成展示文案，
  // 避免导出的 Markdown 出现内部 key。
  if (column?.type === 'select' || column?.type === 'multiSelect') {
    const options = new Map((column.options || []).map(option => [option.id, option.value]));
    if (Array.isArray(value)) return value.map(item => options.get(item) || item).join(', ');
    return options.get(value) || String(value);
  }

  if (column?.type === 'date' && typeof value === 'object') {
    return value.text || value.time || '';
  }

  if (column?.type === 'checkbox') return value ? '[x]' : '[ ]';

  if (column?.type === 'user' || column?.type === 'member' || column?.type === 'mention') {
    const users = new Map((content?.users || []).map(user => [user.id, user.name || user.login || user.id]));
    const ids = Array.isArray(value) ? value : [value];
    return ids.map(item => {
      const id = typeof item === 'object' ? item.id : item;
      return users.get(id) || item?.name || item?.login || String(id);
    }).join(', ');
  }

  if (column?.type === 'url' || column?.type === 'link') {
    if (typeof value === 'object') return markdownLink(value.title || value.text || value.name || value.url || value.src, value.url || value.src);
    return String(value);
  }

  if (column?.type === 'image') {
    const images = Array.isArray(value) ? value : [value];
    return images.map(image => {
      if (typeof image === 'string') return markdownImage('', image);
      return markdownImage(image.name || image.title || '', image.src || image.url);
    }).filter(Boolean).join('<br>');
  }

  if (column?.type === 'attachment' || column?.type === 'file') {
    const files = Array.isArray(value) ? value : [value];
    return files.map(file => {
      if (typeof file === 'string') return file;
      return markdownLink(file.name || file.title || file.fileName || file.url || '附件', file.url || file.src);
    }).filter(Boolean).join(', ');
  }

  if (column?.type === 'number') return normalizeDecimalString(value);

  if (column?.type === 'progress') return `${normalizeDecimalString(value)}%`;

  if (column?.type === 'rate') {
    const rating = Number(normalizeDecimalString(value));
    if (!Number.isFinite(rating)) return String(value);
    return `${'★'.repeat(Math.max(0, Math.round(rating)))} (${normalizeDecimalString(value)})`;
  }

  if (column?.type === 'phone') return String(value);

  if (Array.isArray(value)) {
    return value.map(item => stringifyDataTableValue({ value: item }, { type: column?.type }, content, record)).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    if (value.text) return value.text;
    if (value.title && value.url) return markdownLink(value.title, value.url);
    if (value.name) return value.name;
    if (value.url && value.text) return markdownLink(value.text, value.url);
    if (value.url) return markdownLink(value.url, value.url);
    if (value.seconds && value.text) return value.text;
    return JSON.stringify(value);
  }

  return String(value);
}

function formatIsoDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDataTableRecords(content) {
  const sheet = content?.sheet?.[0];
  const records = Array.isArray(content?.records) ? content.records
    : Array.isArray(sheet?.records) ? sheet.records : [];
  return records.map(record => {
    let data = {};
    try {
      data = typeof record.data === 'string' ? JSON.parse(record.data) : (record.data || {});
    } catch {
      data = {};
    }
    return { record, data };
  });
}

function orderDataTableRecords(content, parsedRecords) {
  const view = getActiveDataTableView(content);
  const byId = new Map(parsedRecords.map(item => [item.record.uuid, item]));
  const ordered = Array.isArray(view?.rows)
    ? view.rows.map(row => byId.get(row.id)).filter(Boolean)
    : [];
  const used = new Set(ordered.map(item => item.record.uuid));
  return [...ordered, ...parsedRecords.filter(item => !used.has(item.record.uuid))];
}

function dataTableRowsToMarkdown(content, columns, parsedRecords) {
  const rows = [columns.map(column => column.name || column.id || '')];
  parsedRecords.forEach(({ record, data }) => {
    rows.push(columns.map(column => stringifyDataTableValue(data[column.id], column, content, record)));
  });
  return tableToMarkdown(rows);
}

function dataTableRecordTitle(content, item, columns) {
  const view = getActiveDataTableView(content);
  const titleId = view?.date?.titleId || view?.cover?.titleId || columns[0]?.id;
  const titleColumn = columns.find(column => column.id === titleId) || columns[0];
  return stringifyDataTableValue(item.data[titleColumn?.id], titleColumn, content, item.record) || '未命名记录';
}

function renderCardDataTable(content, columns, records) {
  const view = getActiveDataTableView(content);
  const coverId = view?.cover?.id;
  const coverColumn = columns.find(column => column.id === coverId);
  const visibleColumns = columns.filter(column => column.id !== coverId);
  const lines = [];

  records.forEach(item => {
    const title = dataTableRecordTitle(content, item, visibleColumns);
    lines.push(`### ${title}`);
    if (coverColumn) {
      const cover = stringifyDataTableValue(item.data[coverColumn.id], coverColumn, content, item.record);
      if (cover) lines.push('', cover);
    }
    visibleColumns.forEach(column => {
      const value = stringifyDataTableValue(item.data[column.id], column, content, item.record);
      if (value && value !== title) lines.push(`- ${column.name || column.id}: ${value}`);
    });
    lines.push('');
  });

  return lines.join('\n').trim();
}

function renderKanbanDataTable(content, columns, records) {
  const view = getActiveDataTableView(content);
  const byId = new Map(records.map(item => [item.record.uuid, item]));
  const groupFieldId = view?.group?.[0]?.id || view?.groupData?.[0]?.groupBy;
  const groupColumn = columns.find(column => column.id === groupFieldId);
  const titleColumns = columns.filter(column => column.id !== groupFieldId);
  const lines = [];

  // 看板视图已经包含语雀排序后的分组；复用它以保留“进行中”等空列。
  if (Array.isArray(view?.groupData) && view.groupData.length) {
    view.groupData.forEach(group => {
      lines.push(`### ${group.value || '未分组'}`);
      const groupRows = (group.rows || []).map(id => byId.get(id)).filter(Boolean);
      if (!groupRows.length) {
        lines.push('- （空）', '');
        return;
      }
      groupRows.forEach(item => lines.push(`- ${dataTableRecordTitle(content, item, titleColumns)}`));
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  const grouped = new Map();
  records.forEach(item => {
    const key = stringifyDataTableValue(item.data[groupFieldId], groupColumn, content, item.record) || '未分组';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  grouped.forEach((items, key) => {
    lines.push(`### ${key}`);
    items.forEach(item => lines.push(`- ${dataTableRecordTitle(content, item, titleColumns)}`));
    lines.push('');
  });
  return lines.join('\n').trim();
}

function renderChartDataTable(content, columns, records) {
  const view = getActiveDataTableView(content);
  let charts = [];
  try {
    charts = JSON.parse(view?.data?.charts || '[]');
  } catch {
    charts = [];
  }
  const chart = charts[0];
  const mainColumn = columns.find(column => column.id === chart?.config?.mainField) || columns[0];
  const counts = new Map();

  records.forEach(item => {
    const key = stringifyDataTableValue(item.data[mainColumn.id], mainColumn, content, item.record) || '空';
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const rows = [[mainColumn.name || mainColumn.id || '维度', '记录数']];
  [...counts.entries()].forEach(([key, count]) => rows.push([key, String(count)]));
  const title = chart?.type ? `图表类型：${chart.type}` : '图表数据';
  return `${title}\n\n${tableToMarkdown(rows)}`;
}

function renderCalendarDataTable(content, columns, records) {
  const view = getActiveDataTableView(content);
  const dateColumn = columns.find(column => column.id === view?.date?.startId) || columns.find(column => column.type === 'date');
  if (!dateColumn) {
    return dataTableRowsToMarkdown(content, columns, records);
  }

  const grouped = new Map();
  records.forEach(item => {
    const date = stringifyDataTableValue(item.data[dateColumn.id], dateColumn, content, item.record) || '未设置日期';
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(item);
  });

  const titleColumns = columns.filter(column => column.id !== dateColumn.id);
  const lines = [];
  grouped.forEach((items, date) => {
    lines.push(`### ${date}`);
    items.forEach(item => lines.push(`- ${dataTableRecordTitle(content, item, titleColumns)}`));
    lines.push('');
  });
  return lines.join('\n').trim();
}

function dataTableToMarkdown(data) {
  const content = data.content;
  const viewContext = getDataTableViewContext(content);
  const columns = getDataTableColumns(content, {
    includeHidden: data.exportAll || viewContext.includeHidden,
    forceIds: viewContext.forceIds,
  });
  const records = orderDataTableRecords(content, parseDataTableRecords(content));

  if (!content || !columns.length) {
    const id = data.tableId || data.sheetId || data.id || '';
    return id ? `\n> 数据表格：${id}\n` : '';
  }

  const title = viewContext.view?.name ? `**${viewContext.view.name}（${viewContext.type}）**` : '**数据表格**';
  const body = renderDataTableByView(viewContext.type, content, columns, records);

  return `\n${title}\n\n${body}\n\n`;
}

function getDataTableViewContext(content) {
  const view = getActiveDataTableView(content);
  const type = view?.type || 'GRID';
  return {
    view,
    type,
    includeHidden: ['CHART', 'KANBAN'].includes(type),
    forceIds: [
      view?.cover?.id,
      view?.date?.startId,
      view?.date?.endId,
      view?.date?.titleId,
      ...(view?.group || []).map(group => group.id),
    ].filter(Boolean),
  };
}

function renderDataTableByView(viewType, content, columns, records) {
  switch (viewType) {
    case 'CARD':
      return renderCardDataTable(content, columns, records);
    case 'KANBAN':
      return renderKanbanDataTable(content, columns, records);
    case 'CHART':
      return renderChartDataTable(content, columns, records);
    case 'CALENDAR':
      return renderCalendarDataTable(content, columns, records);
    case 'GRID':
    default:
      return dataTableRowsToMarkdown(content, columns, records);
  }
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
  if (src) return markdownImage('图表', src);

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
 * 根据 name 将 <card> 元素转换成 Markdown。
 */
function convertCard(name, value, options = {}) {
  const data = decodeCardValue(value);

  switch (name) {
    case 'hr':
      return '\n---\n';

    case 'image': {
      const src = data.src || '';
      const alt = data.name || data.title || '';
      return markdownImage(alt, src);
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
      return markdownMath(code, options.display);
    }

    case 'bookmarklink':
    case 'bookmarkInline': {
      const src = data.src || '';
      const title = data.detail?.title || data.text || src;
      return markdownLink(title, src);
    }

    case 'yuqueinline': {
      const src = data.src || '';
      const title = data.detail?.title || data.name || src;
      return markdownLink(title, src);
    }

    case 'localdoc': {
      const src = data.src || '';
      const fileName = data.name || '附件';
      return markdownLink(fileName, src);
    }

    case 'diagram':
    case 'flowchart2': {
      const code = data.code || '';
      const src = data.url || data.src || '';
      const converted = convertDiagramCodeToMarkdown(data, name);
      const image = src ? markdownImage('图表', src) : '';
      const parts = [converted, image].filter(Boolean).join('\n\n');
      return parts ? `\n${parts}\n\n` : '';
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
        return markdownImage(alt, src);
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
      // 未知卡片：尽量提取其中有用的文本或链接。
      if (data.src) return markdownLink(data.name || data.title || '链接', data.src);
      if (data.url) return markdownLink(data.name || data.title || '链接', data.url);
      if (data.text) return data.text;
      if (data.search) return htmlToText(data.search);
      return '';
  }
}

function convertDiagramCodeToMarkdown(data, name) {
  const code = data.code || '';
  if (!code) return '';

  const type = normalizeDiagramType(data.type || data.mode || data.name || name);
  if (type === 'plantuml') {
    // 序列图风格的 PlantUML 与 Mermaid 足够接近，可转成 Mermaid 保持可编辑；
    // 无法安全转换时回退为 plantuml 代码块。
    const mermaid = plantUmlToMermaid(code);
    if (mermaid) return `\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`;
    return `\n\`\`\`plantuml\n${code}\n\`\`\`\n`;
  }

  const lang = type === 'mermaid' || name === 'flowchart2' || isMermaidCode(code) ? 'mermaid' : type;
  return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

function normalizeDiagramType(type = '') {
  const clean = String(type || '').toLowerCase();
  if (clean === 'puml' || clean === 'plantuml2') return 'plantuml';
  if (clean === 'flowchart2') return 'mermaid';
  return clean;
}

function isMermaidCode(code = '') {
  const firstMeaningfulLine = String(code)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('%%'));
  if (!firstMeaningfulLine) return false;

  return /^(graph\s+(?:TB|TD|BT|RL|LR)\b|flowchart\s+(?:TB|TD|BT|RL|LR)\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|gantt\b|pie\b|journey\b|gitGraph\b|mindmap\b|timeline\b|quadrantChart\b|requirementDiagram\b|C4(?:Context|Container|Component|Dynamic|Deployment)\b|xychart-beta\b|sankey-beta\b|packet-beta\b|block-beta\b|architecture-beta\b|radar-beta\b)/i.test(firstMeaningfulLine);
}

function plantUmlToMermaid(code) {
  const rawLines = String(code).split(/\r?\n/);
  if (!isPlantUmlSequence(rawLines)) return '';

  const sequenceLines = [];
  const aliases = new Map();
  let sawSequenceArrow = false;

  rawLines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith("'") || line.startsWith('@start') || line.startsWith('@end')) return;

    const participant = line.match(/^(participant|actor|boundary|control|entity|database|collections)\s+(.+?)(?:\s+as\s+([A-Za-z0-9_\u4e00-\u9fa5]+))?(?:\s+#[\w-]+)?$/i);
    if (participant) {
      const label = participant[2].trim().replace(/^"|"$/g, '');
      const id = participant[3] || sanitizeMermaidParticipantId(label, aliases.size + 1);
      aliases.set(label, id);
      aliases.set(id, id);
      sequenceLines.push(`participant ${id} as ${label}`);
      return;
    }

    const arrow = line.match(/^(.+?)\s*(-{1,2}>>|<<-{1,2}|-{1,2}>|<-{1,2})\s*(.+?)(?:\s*:\s*(.*))?$/);
    if (arrow) {
      sawSequenceArrow = true;
      let from = arrow[1].trim().replace(/^"|"$/g, '');
      let to = arrow[3].trim().replace(/^"|"$/g, '');
      const isReverse = arrow[2].startsWith('<');
      if (isReverse) [from, to] = [to, from];
      const label = arrow[4] ? `: ${arrow[4].trim()}` : '';
      const mermaidArrow = arrow[2].includes('>>') ? '->>' : '->>';
      sequenceLines.push(`${resolveMermaidParticipant(from, aliases)}${mermaidArrow}${resolveMermaidParticipant(to, aliases)}${label}`);
      return;
    }

    if (/^(alt|else|opt|loop|par|and|rect|critical|break)\b/i.test(line) || /^end\b/i.test(line)) {
      sequenceLines.push(line);
    }
  });

  return sawSequenceArrow ? ['sequenceDiagram', ...sequenceLines.map(line => `  ${line}`)].join('\n') : '';
}

function isPlantUmlSequence(rawLines) {
  // PlantUML 的用例图、状态图、组件图、序列图都使用类似箭头语法。
  // 只有包含序列图特征时才转 Mermaid，否则保留原 PlantUML，依赖 SVG 渲染兜底。
  return rawLines.some(rawLine => {
    const line = rawLine.trim();
    return /^(participant|boundary|control|entity|database|collections)\b/i.test(line)
      || /^(autonumber|activate|deactivate|note\s+(left|right|over)\b)/i.test(line);
  });
}

function resolveMermaidParticipant(name, aliases) {
  const clean = String(name || '').trim().replace(/^"|"$/g, '');
  if (aliases.has(clean)) return aliases.get(clean);
  const id = sanitizeMermaidParticipantId(clean, aliases.size + 1);
  aliases.set(clean, id);
  return id;
}

function sanitizeMermaidParticipantId(name, fallbackIndex) {
  const id = String(name || '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || `p${fallbackIndex}`;
}

/**
 * 将 Lake HTML 内容转换为 Markdown。
 * @param {string} lakeHtml - Lake HTML 字符串（来自 doc.content 字段）。
 * @returns {string} Markdown 文本。
 */
export function lakeToMarkdown(lakeHtml) {
  if (!lakeHtml) return '';

  // Table (数据表) content is JSON, not HTML
  if (typeof lakeHtml === 'string' && lakeHtml.startsWith('{')) {
    try {
      const json = JSON.parse(lakeHtml);
      if (json.format === 'laketable' || json.type === 'Table') {
        return dataTableToMarkdown({ content: json, exportAll: true }).trim();
      }
    } catch (e) {
      // Not valid JSON, proceed as HTML
    }
  }

  cardOutputs = [];

  const html = preprocessLakeHtml(lakeHtml);
  const turndown = createTurndownService();
  const markdown = turndown.turndown(html);

  return cleanupMarkdown(markdown);
}

function preprocessLakeHtml(lakeHtml) {
  const html = String(lakeHtml)
    .replace(/<!doctype lake>/i, '')
    .replace(/<meta[^>]*>/gi, '')
    // 部分保存下来的 Lake 样例会出现 name="\&quot;math\&quot;" 这类属性。
    // 在卡片解析和 Turndown 列表处理前先归一化。
    .replace(/="\\&quot;([^"]*?)\\&quot;"/g, '="$1"');

  return replaceCardElements(markStandaloneMathBlocks(html));
}

function markStandaloneMathBlocks(html) {
  // 即便语雀把公式显示为居中的独立公式，math 卡片通常仍是 type="inline"。
  // 因此这里按结构判断：只包含一个 math 卡片的段落才视为块级公式。
  // 表格区域跳过处理，因为 Markdown 表格单元格里对块级公式支持很差。
  const tablePattern = /<table\b[\s\S]*?<\/table>/gi;
  let output = '';
  let lastIndex = 0;
  let match;

  while ((match = tablePattern.exec(html))) {
    output += markStandaloneMathBlocksInSegment(html.slice(lastIndex, match.index));
    output += match[0];
    lastIndex = match.index + match[0].length;
  }

  output += markStandaloneMathBlocksInSegment(html.slice(lastIndex));
  return output;
}

function markStandaloneMathBlocksInSegment(segment) {
  return String(segment).replace(/<p\b([^>]*)>\s*<card\s+([^>]*)><\/card>\s*<\/p>/gi, (match, pAttrs, cardAttrs) => {
    if (getHtmlAttr(cardAttrs, 'name') !== 'math') return match;
    // 保留原始卡片 value，并添加仅内部使用的标记给 processCardAttrs 消费。
    // 这个标记不会出现在最终 Markdown 中。
    return `<p${pAttrs}><card ${cardAttrs} data-md-display="block"></card></p>`;
  });
}

function replaceCardElements(html) {
  // 卡片 Markdown 会通过承载元素在 Turndown 后恢复，
  // 避免 Markdown 语法被 Turndown 的普通 HTML 转换转义。
  return html
    .replace(/<card\s+([^>]*)><\/card>/gi, (match, attrs) => processCardAttrs(attrs))
    .replace(/<card\s+([^>]*)\/?>/gi, (match, attrs) => processCardAttrs(attrs));
}

function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  registerTurndownRules(turndown);
  return turndown;
}

function registerTurndownRules(turndown) {
  turndown.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => `~~${content}~~`,
  });

  // 处理带 class 的 Lake 提示/引用块。
  turndown.addRule('lakeAlert', {
    filter: (node) => node.nodeName === 'BLOCKQUOTE' && node.classList?.contains('lake-alert'),
    replacement: (content) => {
      const lines = content.trim().split('\n');
      return '\n' + lines.map(l => `> ${l}`).join('\n') + '\n';
    },
  });

  // 清理链接处理。
  turndown.addRule('cleanLinks', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      if (!href || href === '#') return content;
      return `[${content}](${href})`;
    },
  });

  // Turndown 默认会把 Lake 表格拍平成段落，这里改为 Markdown 表格。
  turndown.addRule('lakeTable', {
    filter: 'table',
    replacement: (content, node) => {
      const table = nativeTableToMarkdown(node);
      return table ? `\n\n${table}\n\n` : content;
    },
  });

  // Lake 折叠块是真实的 <details>/<summary> 节点。
  // 保留为 Markdown 兼容的 HTML，让折叠区域仍可交互。
  turndown.addRule('lakeCollapse', {
    filter: 'details',
    replacement: (content, node) => {
      const summary = htmlToText(node.querySelector?.('summary')?.innerHTML || '详情') || '详情';
      const clone = node.cloneNode(true);
      clone.querySelector?.('summary')?.remove();
      const body = turndown.turndown(clone.innerHTML || '').trim();
      const openAttr = node.hasAttribute?.('open') ? ' open' : '';
      return `\n<details${openAttr}>\n<summary>${escapeHtml(summary)}</summary>\n\n${body}\n\n</details>\n`;
    },
  });

  // Lake 分栏布局使用嵌套 <article> 标签。Markdown 无法原生表达分栏，
  // 因此映射为表格单元格来尽量保留布局。
  turndown.addRule('lakeColumns', {
    filter: (node) => node.nodeName === 'ARTICLE' && node.classList?.contains('lake-columns'),
    replacement: (content, node) => {
      const columns = Array.from(node.children || [])
        .filter(child => child.nodeName === 'ARTICLE' && child.classList?.contains('lake-column-item'))
        .map(child => markdownTableCellFromBlock(turndown.turndown(child.innerHTML || '')));
      if (!columns.length) return content;
      const headers = columns.map((_, index) => `列 ${index + 1}`);
      return `\n\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${columns.join(' | ')} |\n\n`;
    },
  });

  // 处理卡片承载元素 <img data-card-idx="N">，原样输出已保存的 Markdown。
  turndown.addRule('cardCarrier', {
    filter: (node) => node.nodeName === 'IMG' && node.getAttribute('data-card-idx') !== null,
    replacement: (content, node) => {
      const idx = parseInt(node.getAttribute('data-card-idx'), 10);
      return (idx >= 0 && idx < cardOutputs.length) ? cardOutputs[idx] : '';
    },
  });
}

function cleanupMarkdown(markdown) {
  return String(markdown)
    .replace(/\\\[([^\]]*)\\\](?!\()/g, '[$1]')
    .replace(/<\/details>\n(?=```)/g, '</details>\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析卡片属性字符串，转换并保存 Markdown，
 * 返回一个由 Turndown 自定义规则处理的 HTML 承载元素。
 */
function processCardAttrs(attrsStr) {
  const name = getHtmlAttr(attrsStr, 'name');
  const value = getHtmlAttr(attrsStr, 'value');
  // 默认按行内公式处理；只有真正独立的公式段落才会由
  // markStandaloneMathBlocks 添加这个标记。
  const display = getHtmlAttr(attrsStr, 'data-md-display') || 'inline';
  const md = convertCard(name, value, { display });
  if (!md) return '';
  const idx = storeCardOutput(md);
  // 使用 <img> 作为承载元素，Turndown 能识别 img，且可通过 addRule 接管输出。
  return `<img data-card-idx="${idx}" src="" alt="">`;
}

function getHtmlAttr(attrsStr, name) {
  const match = String(attrsStr || '').match(new RegExp(`${name}="([^"]*)"`));
  return match ? normalizeHtmlAttrValue(match[1]) : '';
}

function normalizeHtmlAttrValue(value = '') {
  const decoded = decodeHtmlEntities(value).trim();
  return decoded
    .replace(/\\"/g, '"')
    .replace(/^"|"$/g, '');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownTableCellFromBlock(markdown = '') {
  return String(markdown)
    .replace(/\u200b/g, '')
    .replace(/\|/g, '\\|')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('<br><br>');
}

/**
 * 通过详情 API 获取单篇文档内容。
 * GET /api/docs/{slug}?book_id={bookId}
 * 返回原始 Lake HTML 内容。
 */
