import pako from 'pako';
import XLSX from 'xlsx-js-style';

/**
 * Lakesheet → xlsx / csv / markdown / html converter.
 *
 * Flow: content/body JSON string → decompress → normalize → export
 */

// ── Main entry ──

/**
 * Convert lakesheet content to specified format.
 * @param {string|object} docOrContent - content/body JSON string, or doc object with content/body fields
 * @param {string} format - 'xlsx' | 'csv' | 'md' | 'html'
 * @returns {{ blob?: Blob, text?: string, extension: string, mime: string }}
 */
export function convertLakeSheet(docOrContent, format = 'xlsx') {
  const contentStr = typeof docOrContent === 'string'
    ? docOrContent
    : (docOrContent.content || docOrContent.body || '');

  const lakeData = decompress(contentStr);
  const sheets = normalize(lakeData);
  const vessels = lakeData.vessels || {};

  switch (format) {
    case 'xlsx':
      return { blob: toXlsx(sheets), extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    case 'csv':
      return { text: toCsv(sheets), extension: 'csv', mime: 'text/csv' };
    case 'md':
      return { text: toMarkdown(sheets, vessels), extension: 'md', mime: 'text/markdown' };
    case 'html':
      return { text: toHtml(sheets, vessels), extension: 'html', mime: 'text/html' };
    default:
      throw new Error(`Unsupported sheet export format: ${format}`);
  }
}

// ── Decompress ──

function decompress(contentStr) {
  const parsed = JSON.parse(contentStr);
  if (typeof parsed.sheet === 'string') {
    const bytes = new Uint8Array(parsed.sheet.length);
    for (let i = 0; i < parsed.sheet.length; i++) bytes[i] = parsed.sheet.charCodeAt(i);
    parsed.sheet = JSON.parse(pako.inflate(bytes, { to: 'string' }));
  }
  return parsed;
}

// ── Normalize ──

function normalize(lakeData) {
  const raw = Array.isArray(lakeData.sheet) ? lakeData.sheet : [lakeData.sheet];
  return raw.map(sheet => {
    const vStore = sheet.vStore || {};
    const data = sheet.data || {};

    // Find actual content bounds
    let maxRow = 0, maxCol = 0;
    for (const r of Object.keys(data)) {
      for (const [c, cell] of Object.entries(data[r])) {
        if (cell && cell.v !== undefined && cell.v !== '') {
          maxRow = Math.max(maxRow, +r);
          maxCol = Math.max(maxCol, +c);
        }
      }
    }

    return {
      name: sheet.name || 'Sheet1',
      rows: maxRow + 1,
      cols: maxCol + 1,
      data,
      mergeCells: sheet.mergeCells || {},
      rowDefs: sheet.rows || {},
      colDefs: sheet.columns || {},
      styles: vStore.style || [],
      colors: vStore.style_color || [],
      bgColors: vStore.style_backColor || [],
    };
  });
}

// ── Helpers ──

function cellValue(cell) {
  if (!cell || cell.v === undefined) return '';
  const v = cell.v;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'object') {
    if (v.class === 'select') return (v.value || []).join(', ');
    if (v.text) return v.text;
    if (v.url) return v.url;
    return JSON.stringify(v);
  }
  return String(v);
}

function parseStyle(s) {
  const r = {};
  let m;
  if ((m = s.match(/z(\d+)/))) r.sz = +m[1];
  if ((m = s.match(/c(\d+)/))) r.ci = +m[1];
  if ((m = s.match(/w(\d+)/))) r.bold = +m[1] >= 7;
  if ((m = s.match(/h(\d+)/))) r.ha = +m[1];
  if ((m = s.match(/b(\d+)/))) r.bi = +m[1];
  return r;
}

function rgbHex(rgb) {
  if (!rgb) return null;
  if (rgb.startsWith('#')) return rgb.length === 7 ? rgb.slice(1) : null;
  const m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('') : null;
}

// ── XLSX ──

function toXlsx(sheets) {
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const { data, mergeCells, rowDefs, colDefs, styles, colors, bgColors } = sheet;
    const ws = {};

    for (let r = 0; r < sheet.rows; r++) {
      for (let c = 0; c < sheet.cols; c++) {
        const cell = data[r]?.[c];
        const val = cellValue(cell);
        const hasSt = cell?.s !== undefined && styles[cell.s];
        if (val === '' && !hasSt) continue;

        const ref = XLSX.utils.encode_cell({ r, c });
        const wc = { t: typeof val === 'number' ? 'n' : 's', v: val };

        if (hasSt) {
          const p = parseStyle(styles[cell.s]);
          const st = {};
          const font = {};
          if (p.sz) font.sz = p.sz;
          if (p.bold) font.bold = true;
          if (p.ci !== undefined && colors[p.ci]) { const h = rgbHex(colors[p.ci]); if (h) font.color = { rgb: h }; }
          if (Object.keys(font).length) st.font = font;
          if (p.ha !== undefined) st.alignment = { horizontal: ['left', 'center', 'right'][p.ha] || 'left', vertical: 'center' };
          if (p.bi !== undefined && bgColors[p.bi]) { const h = rgbHex(bgColors[p.bi]); if (h) st.fill = { fgColor: { rgb: h }, patternType: 'solid' }; }
          if (Object.keys(st).length) wc.s = st;
        }

        ws[ref] = wc;
      }
    }

    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheet.rows - 1, c: sheet.cols - 1 } });
    ws['!cols'] = Array.from({ length: sheet.cols }, (_, c) => ({ wch: Math.round((colDefs[c]?.size || 72) / 7) }));
    ws['!rows'] = Array.from({ length: sheet.rows }, (_, r) => rowDefs[r]?.size ? { hpt: rowDefs[r].size * 0.75 } : {});

    const merges = [];
    for (const mc of Object.values(mergeCells)) {
      if (mc.row < sheet.rows) {
        merges.push({ s: { r: mc.row, c: mc.col }, e: { r: Math.min(mc.row + mc.rowCount - 1, sheet.rows - 1), c: Math.min(mc.col + mc.colCount - 1, sheet.cols - 1) } });
      }
    }
    if (merges.length) ws['!merges'] = merges;

    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }

  return new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

// ── CSV ──

function toCsv(sheets) {
  const parts = sheets.map(sheet => {
    const lines = [];
    for (let r = 0; r < sheet.rows; r++) {
      const cols = [];
      for (let c = 0; c < sheet.cols; c++) {
        let v = String(cellValue(sheet.data[r]?.[c]) ?? '');
        if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"';
        cols.push(v);
      }
      lines.push(cols.join(','));
    }
    return { name: sheet.name, text: lines.join('\n') };
  });
  if (parts.length === 1) return parts[0].text;
  return parts.map(p => `--- ${p.name} ---\n${p.text}`).join('\n\n');
}

// ── Markdown ──

function toMarkdown(sheets, vessels) {
  const parts = sheets.map(sheet => {
    const lines = [];
    for (let r = 0; r < sheet.rows; r++) {
      const cols = [];
      for (let c = 0; c < sheet.cols; c++) {
        let v = String(cellValue(sheet.data[r]?.[c]) ?? '');
        v = v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        cols.push(v);
      }
      lines.push('| ' + cols.join(' | ') + ' |');
      if (r === 0) lines.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    }
    return { name: sheet.name, text: lines.join('\n') };
  });

  let md = parts.length === 1
    ? parts[0].text
    : parts.map(p => `## ${p.name}\n\n${p.text}`).join('\n\n');

  // Append chart metadata
  const charts = Object.values(vessels).filter(v => v.type === 'chart');
  if (charts.length) {
    md += '\n\n---\n\n> **图表信息** (数据已包含在上方表格中)\n';
    for (const ch of charts) {
      const t = ch.chartConfigs?.titles?.title || '未命名图表';
      const s = ch.selections || {};
      md += `> - **${t}**: ${ch.chartConfigs?.chartType || 'chart'} 类型，数据范围 Row ${s.row}~${s.row + s.rowCount - 1}, Col ${s.col}~${s.col + s.colCount - 1}\n`;
    }
  }

  return md;
}

// ── HTML ──

function toHtml(sheets, vessels) {
  const parts = sheets.map(sheet => {
    const { data, mergeCells, colDefs, styles, colors, bgColors } = sheet;
    const skip = new Set();
    const mmap = {};
    for (const mc of Object.values(mergeCells)) {
      if (mc.row >= sheet.rows) continue;
      mmap[`${mc.row},${mc.col}`] = mc;
      for (let r = mc.row; r < mc.row + mc.rowCount; r++)
        for (let c = mc.col; c < mc.col + mc.colCount; c++)
          if (r !== mc.row || c !== mc.col) skip.add(`${r},${c}`);
    }

    let h = '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;">\n';
    h += '<colgroup>' + Array.from({ length: sheet.cols }, (_, c) => {
      const w = colDefs[c]?.size;
      return w ? `<col style="width:${w}px">` : '<col>';
    }).join('') + '</colgroup>\n';

    for (let r = 0; r < sheet.rows; r++) {
      h += '<tr>';
      for (let c = 0; c < sheet.cols; c++) {
        if (skip.has(`${r},${c}`)) continue;
        const cell = data[r]?.[c];
        const val = cellValue(cell);
        let attrs = '', css = '';

        const mc = mmap[`${r},${c}`];
        if (mc) {
          if (mc.colCount > 1) attrs += ` colspan="${mc.colCount}"`;
          if (mc.rowCount > 1) attrs += ` rowspan="${mc.rowCount}"`;
        }

        if (cell?.s !== undefined && styles[cell.s]) {
          const p = parseStyle(styles[cell.s]);
          if (p.sz) css += `font-size:${p.sz}px;`;
          if (p.bold) css += 'font-weight:bold;';
          if (p.ci !== undefined && colors[p.ci]) css += `color:${colors[p.ci]};`;
          if (p.bi !== undefined && bgColors[p.bi]) css += `background:${bgColors[p.bi]};`;
          if (p.ha !== undefined) css += `text-align:${['left', 'center', 'right'][p.ha]};`;
        }

        if (css) attrs += ` style="${css}"`;
        const esc = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        h += `<td${attrs}>${esc}</td>`;
      }
      h += '</tr>\n';
    }
    h += '</table>';
    return { name: sheet.name, text: h };
  });

  let html = parts.length === 1
    ? parts[0].text
    : parts.map(p => `<h2>${p.name}</h2>\n${p.text}`).join('\n');

  // Chart info
  const charts = Object.values(vessels).filter(v => v.type === 'chart');
  if (charts.length) {
    html += '\n<hr><p><strong>图表信息</strong> (数据已包含在上方表格中)</p><ul>';
    for (const ch of charts) {
      const t = ch.chartConfigs?.titles?.title || '未命名图表';
      const s = ch.selections || {};
      html += `<li><strong>${t}</strong>: ${ch.chartConfigs?.chartType || 'chart'}，Row ${s.row}~${s.row + s.rowCount - 1}, Col ${s.col}~${s.col + s.colCount - 1}</li>`;
    }
    html += '</ul>';
  }

  return html;
}
