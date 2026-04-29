/**
 * Lakeboard → SVG → PNG/JPG converter.
 *
 * Converts Yuque Board (白板/画板) JSON to SVG string.
 * Image export (PNG/JPG) requires offscreen document with Canvas.
 */

// ── Main entry ──

/**
 * Convert lakeboard content to SVG string.
 * Async because it fetches images and inlines them as base64.
 * @param {string|object} docOrContent
 * @returns {Promise<{ svg: string, width: number, height: number }>}
 */
export async function convertBoardToSvg(docOrContent) {
  const contentStr = typeof docOrContent === 'string'
    ? docOrContent
    : (docOrContent.content || docOrContent.body || '');

  const parsed = JSON.parse(contentStr);
  const diagram = parsed.diagramData;
  if (!diagram?.body) throw new Error('Invalid lakeboard: missing diagramData.body');

  const bbox = parsed.graphicsBBox || computeBBox(diagram.body);
  const padding = 40;
  const vx = bbox.x - padding;
  const vy = bbox.y - padding;
  const vw = bbox.width + padding * 2;
  const vh = bbox.height + padding * 2;

  // Build element index for line ID references
  const elemIndex = {};
  indexElements(diagram.body, elemIndex);

  // Pre-fetch all images and convert to base64 data URLs
  const imageCache = await prefetchImages(diagram.body);

  // Sort by zIndex
  const sorted = [...diagram.body].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  const defs = buildDefs();
  const content = sorted.map(el => renderElement(el, elemIndex, imageCache)).join('\n');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `  viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}"`,
    `  style="background:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">`,
    defs,
    content,
    '</svg>'
  ].join('\n');

  return { svg, width: Math.ceil(vw), height: Math.ceil(vh) };
}

// ── Image prefetch ──

async function prefetchImages(elements) {
  const urls = new Set();
  collectImageUrls(elements, urls);

  const cache = {};
  await Promise.all([...urls].map(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve) => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      cache[url] = dataUrl;
    } catch { /* skip failed images */ }
  }));

  return cache;
}

function collectImageUrls(elements, urls) {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    if (el.type === 'image' && el.image?.src) urls.add(el.image.src);
    if (el.children) collectImageUrls(el.children, urls);
    if (el.contain) collectImageUrls(el.contain, urls);
  }
}

// ── Index ──

function indexElements(elements, index) {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    if (el.id) index[el.id] = el;
    if (el.children) indexElements(el.children, index);
    if (el.contain) indexElements(el.contain, index);
  }
}

// ── BBox ──

function computeBBox(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function scan(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (el.x !== undefined && el.y !== undefined) {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + (el.width || 0));
        maxY = Math.max(maxY, el.y + (el.height || 0));
      }
      if (el.children) scan(el.children);
      if (el.contain) scan(el.contain);
    }
  }
  scan(elements);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ── Defs ──

function buildDefs() {
  return `<defs>
  <marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto" markerUnits="strokeWidth">
    <polygon points="0 0, 10 3.5, 0 7" fill="#8C8C8C"/>
  </marker>
</defs>`;
}

// ── Render ──

function renderElement(el, index, imageCache) {
  switch (el.type) {
    case 'geometry': return renderGeometry(el);
    case 'text': return renderText(el);
    case 'line': return renderLine(el, index);
    case 'group': return renderGroup(el, index, imageCache);
    case 'image': return renderImage(el, imageCache);
    case 'swimlane': return renderSwimlane(el, index, imageCache);
    default: return `<!-- unknown type: ${el.type} -->`;
  }
}

// ── Geometry shapes ──

function renderGeometry(el) {
  const { x, y, width: w, height: h, shape, stroke, fill, rotate, html } = el;
  const sc = stroke?.color || '#333';
  const fc = fill?.color || 'none';
  const sw = stroke?.width || 1;

  let transform = '';
  if (rotate) {
    transform = ` transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})"`;
  }

  let shapeSvg;
  switch (shape) {
    case 'rect':
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    case 'start-end':
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    case 'decision': {
      const cx = x + w / 2, cy = y + h / 2;
      shapeSvg = `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'subroutine': {
      const inset = 8;
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x + inset}" y1="${y}" x2="${x + inset}" y2="${y + h}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x + w - inset}" y1="${y}" x2="${x + w - inset}" y2="${y + h}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'document': {
      const curveH = 8;
      shapeSvg = `<path d="M${x},${y} L${x + w},${y} L${x + w},${y + h - curveH} Q${x + w * 0.75},${y + h + curveH} ${x + w / 2},${y + h - curveH} Q${x + w * 0.25},${y + h - curveH * 3} ${x},${y + h - curveH} Z" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'manual-input': {
      const slant = 10;
      shapeSvg = `<polygon points="${x},${y + slant} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    default:
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
  }

  const textSvg = html ? renderTextBlock(x, y, w, h, html) : '';
  return `<g${transform}>${shapeSvg}${textSvg}</g>`;
}

// ── Text ──

function renderText(el) {
  const { x, y, html } = el;
  if (!html) return '';
  const lines = parseHtmlToLines(html);
  if (!lines.length) return '';

  let svg = '';
  const fontSize = lines[0].style?.fontSize || 14;
  const lineHeight = fontSize * 1.4;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ly = y + (i + 1) * lineHeight;
    const fs = line.style?.fontSize || fontSize;
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#333';
    svg += `<text x="${x}" y="${ly}" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(line.text)}</text>`;
  }
  return svg;
}

// ── Image ──

function renderImage(el, imageCache = {}) {
  const { x, y, width: w, height: h, image } = el;
  if (!image?.src) return '';
  const href = imageCache[image.src] || image.src;
  return `<image href="${escapeAttr(href)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
}

// ── Line ──

function renderLine(el, index) {
  const { source, target, stroke, html } = el;
  const sc = stroke?.color || '#8C8C8C';
  const sw = stroke?.width || 1;
  const hasArrow = target?.marker === 'arrow';

  const sp = resolvePoint(source, index);
  const tp = resolvePoint(target, index);
  if (!sp || !tp) return `<!-- line: unresolved endpoints -->`;

  const markerAttr = hasArrow ? ' marker-end="url(#arrow)"' : '';

  // For elbow lines, draw right-angle path
  // Simple approach: if horizontal diff is significant, go horizontal then vertical
  const dx = tp[0] - sp[0];
  const dy = tp[1] - sp[1];
  let path;

  if (el.controlPoints && el.controlPoints.length) {
    const pts = [sp, ...el.controlPoints.map(cp => [cp.x || cp[0], cp.y || cp[1]]), tp];
    path = `M${pts.map(p => p.join(',')).join(' L')}`;
  } else if (el.shape === 'elbow') {
    // Elbow: horizontal-vertical-horizontal routing
    if (Math.abs(dx) > Math.abs(dy)) {
      const midX = sp[0] + dx / 2;
      path = `M${sp[0]},${sp[1]} L${midX},${sp[1]} L${midX},${tp[1]} L${tp[0]},${tp[1]}`;
    } else {
      const midY = sp[1] + dy / 2;
      path = `M${sp[0]},${sp[1]} L${sp[0]},${midY} L${tp[0]},${midY} L${tp[0]},${tp[1]}`;
    }
  } else {
    path = `M${sp[0]},${sp[1]} L${tp[0]},${tp[1]}`;
  }

  let svg = `<path d="${path}" fill="none" stroke="${sc}" stroke-width="${sw}"${markerAttr}/>`;

  // Render line label at midpoint
  if (html) {
    const mx = (sp[0] + tp[0]) / 2;
    const my = (sp[1] + tp[1]) / 2;
    svg += renderTextBlock(mx - 30, my - 12, 60, 24, html);
  }

  return svg;
}

function resolvePoint(endpoint, index) {
  if (!endpoint) return null;

  // Direct coordinate: { connection: [x, y] }
  if (Array.isArray(endpoint.connection)) {
    return endpoint.connection;
  }

  // ID reference: { id: "xxx", connection: "S"|"N"|"E"|"W" }
  if (endpoint.id && index[endpoint.id]) {
    const el = index[endpoint.id];
    const x = el.x || 0, y = el.y || 0;
    const w = el.width || 0, h = el.height || 0;
    const cx = x + w / 2, cy = y + h / 2;

    switch (endpoint.connection) {
      case 'N': return [cx, y];
      case 'S': return [cx, y + h];
      case 'E': return [x + w, cy];
      case 'W': return [x, cy];
      default: return [cx, cy];
    }
  }

  return null;
}

// ── Group ──

function renderGroup(el, index, imageCache) {
  if (!el.children) return '';
  const children = el.children.map(c => renderElement(c, index, imageCache)).join('\n');
  return `<g>${children}</g>`;
}

// ── Swimlane ──

function renderSwimlane(el, index, imageCache) {
  const { x, y, width: w, height: h, widths, heights, stroke, children } = el;
  const sc = stroke?.color || '#D9D9D9';
  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${sc}" stroke-width="1"/>`;

  // Compute row boundaries from heights ratios: [0, h0, h1, ..., 1]
  const rowBounds = [0, ...(heights || []), 1];

  // Draw horizontal dividers
  if (heights) {
    for (const ratio of heights) {
      const ly = y + h * ratio;
      svg += `<line x1="${x}" y1="${ly}" x2="${x + w}" y2="${ly}" stroke="${sc}" stroke-width="1"/>`;
    }
  }

  // Header column width (from widths[0] ratio)
  const headerWidth = widths?.[0] ? w * widths[0] : 40;

  // Draw vertical dividers
  if (widths) {
    for (const ratio of widths) {
      const lx = x + w * ratio;
      svg += `<line x1="${lx}" y1="${y}" x2="${lx}" y2="${y + h}" stroke="${sc}" stroke-width="1"/>`;
    }
  }

  // Render children (row header labels) — positioned by nth index in row cells
  if (children) {
    for (const child of children) {
      const nth = child.nth || 0;
      const cellTop = y + h * rowBounds[nth];
      const cellBottom = y + h * rowBounds[nth + 1];
      const cellHeight = cellBottom - cellTop;
      const fc = child.fill?.color || '#F5F5F5';

      svg += `<rect x="${x}" y="${cellTop}" width="${headerWidth}" height="${cellHeight}" fill="${fc}" stroke="none"/>`;
      if (child.html) {
        svg += renderTextBlock(x, cellTop, headerWidth, cellHeight, child.html);
      }
    }
  }

  // contain is an array of ID strings — those elements are already rendered at top level

  return svg;
}

// ── SVG Text rendering (replaces foreignObject for compatibility) ──

function renderTextBlock(x, y, w, h, html) {
  const lines = parseHtmlToLines(html);
  if (!lines.length) return '';

  // Extract style from first line for defaults
  const defaultStyle = lines[0].style || {};
  const fontSize = defaultStyle.fontSize || 14;
  const lineHeight = fontSize * 1.4;
  const totalTextH = lines.length * lineHeight;

  // Center vertically
  const startY = y + (h - totalTextH) / 2 + fontSize;

  let svg = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ly = startY + i * lineHeight;
    const cx = x + w / 2;
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#333';
    const fs = line.style?.fontSize || fontSize;
    const escaped = escapeXml(line.text);
    svg += `<text x="${cx}" y="${ly}" text-anchor="middle" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escaped}</text>`;
  }
  return svg;
}

/**
 * Parse simple HTML to array of { text, style } lines.
 * Handles: <div>, <span style="...">, <br>, nested divs.
 */
function parseHtmlToLines(html) {
  if (!html) return [];

  const lines = [];
  // Split by <div> or <br> to get lines
  // First: unwrap outer div if present
  let inner = html.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');

  // Split by </div><div> or <br> or <br/>
  const parts = inner.split(/<\/div>\s*<div[^>]*>|<br\s*\/?>|<\/div>/);

  for (const part of parts) {
    const text = stripHtml(part).trim();
    if (!text) continue;

    // Extract style from span
    const style = {};
    const boldMatch = part.match(/font-weight\s*:\s*(bold|700)/);
    if (boldMatch) style.bold = true;

    const colorMatch = part.match(/color\s*:\s*([^;"]+)/);
    if (colorMatch) style.color = colorMatch[1].trim();

    const sizeMatch = part.match(/font-size\s*:\s*(\d+)px/);
    if (sizeMatch) style.fontSize = parseInt(sizeMatch[1]);

    lines.push({ text, style });
  }

  return lines;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Util ──

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
