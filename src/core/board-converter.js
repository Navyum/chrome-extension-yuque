import { createBoardMeasurer } from './board-measure.js';
import { renderBoardToECharts } from './board-chart.js';
import { renderBoardToMermaid } from './board-mermaid.js';
import { arrowTextRegion, renderArrowPolygon, renderDocumentPath, renderMultiDocumentPath } from './board-shapes.js';
import {
  escapeAttr,
  escapeXml,
  estimateCharWidth,
  estimateLooseTextSize,
  estimateTextBlockHeight,
  parseHtmlToLines,
  readableFontSize,
  renderTextBlock,
  sanitizeSvgId,
  stripHtml,
} from './board-text.js';

/**
 * Lakeboard → SVG → PNG/JPG converter.
 *
 * Converts Yuque Board (白板/画板) JSON to SVG string.
 * Image export (PNG/JPG) requires offscreen document with Canvas.
 */

const SVG_VIEWBOX_PADDING = 72;
const ORTHOGONAL_SNAP_TOLERANCE = 2;
const MIN_ORTHOGONAL_SNAP_LENGTH = 16;

const boardMeasure = createBoardMeasurer({
  resolveElementSize,
  resolveLinePoints,
  lineLabelPoint,
  isStandardRightMindmap,
  isTimelineListMindmap,
  isVerticalMindmap,
  standardRightMindmapLayout,
  measureTimelineListMindmap,
  measureVerticalMindmap,
  measureMindmap,
});
const {
  normalizeBBox,
  mergeBBoxes,
  unionBBox,
  indexElements,
} = boardMeasure;

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

  // Build element index before measuring so line endpoints can resolve the
  // referenced geometry bounds instead of falling back to center points.
  const elemIndex = {};
  indexElements(diagram.body, elemIndex);

  const apiBBox = normalizeBBox(parsed.graphicsBBox);
  const computedBBox = computeBBox(diagram.body, elemIndex);
  const bbox = mergeBBoxes(apiBBox, computedBBox) || computedBBox;
  // Yuque's own renderer leaves room for arrow markers, soft line caps and
  // rotated/overflowing text. A larger safety padding prevents clipped axes and
  // fishbone arrows without changing the underlying diagram coordinates.
  const padding = SVG_VIEWBOX_PADDING;
  const vx = bbox.x - padding;
  const vy = bbox.y - padding;
  const vw = bbox.width + padding * 2;
  const vh = bbox.height + padding * 2;

  // Pre-fetch all images and convert to base64 data URLs
  const imageCache = await prefetchImages(diagram.body);

  // Sort by zIndex
  const sorted = [...diagram.body].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  const defs = buildDefs();
  const content = sorted.map((el, index) => renderElement(el, elemIndex, imageCache, index)).join('\n');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `  viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}"`,
    `  style="background:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">`,
    defs,
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>`,
    content,
    '</svg>'
  ].join('\n');

  return { svg, width: Math.ceil(vw), height: Math.ceil(vh) };
}

/**
 * Convert structured lakeboard content to Mermaid when possible.
 * This is a semantic reconstruction, not a pixel-perfect rendering.
 * @param {string|object} docOrContent
 * @returns {string} Mermaid code without surrounding fences, or an empty string.
 */
export function convertBoardToMermaid(docOrContent) {
  const contentStr = typeof docOrContent === 'string'
    ? docOrContent
    : (docOrContent.content || docOrContent.body || JSON.stringify(docOrContent || {}));

  let parsed;
  try {
    parsed = typeof contentStr === 'string' ? JSON.parse(contentStr) : contentStr;
  } catch {
    return '';
  }

  const body = parsed?.diagramData?.body;
  if (!Array.isArray(body) || !body.length) return '';

  return renderBoardToMermaid(body, {
    resolveElementSize,
    lineLabelPoint,
    resolveLinePoints,
    isVerticalMindmap,
    isStandardRightMindmap,
    isTimelineListMindmap,
    measureTimelineListMindmap,
    measureMindmap,
    standardRightMindmapLayout,
    measureVerticalMindmap,
    stripHtml,
  });
}

/**
 * Convert chart-like lakeboard content to ECharts option code when Mermaid
 * cannot express the original diagram well.
 * @param {string|object} docOrContent
 * @returns {string} ECharts code such as `option = {...};`, or an empty string.
 */
export function convertBoardToECharts(docOrContent) {
  const contentStr = typeof docOrContent === 'string'
    ? docOrContent
    : (docOrContent.content || docOrContent.body || JSON.stringify(docOrContent || {}));

  let parsed;
  try {
    parsed = typeof contentStr === 'string' ? JSON.parse(contentStr) : contentStr;
  } catch {
    return '';
  }

  const body = parsed?.diagramData?.body;
  if (!Array.isArray(body) || !body.length) return '';
  return renderBoardToECharts(body);
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

// Mermaid semantic conversion is implemented in board-mermaid.js.

// ── BBox ──

function computeBBox(elements, index = {}) {
  // Keep measurement and rendering in sync by delegating to elementBBox. The
  // previous scanner mixed raw element boxes with separate line/mindmap hacks,
  // which made generated content easy to clip after renderer improvements.
  return unionBBox(elements, index);
}

function resolveElementSize(el) {
  if (el.type === 'stack') {
    const layout = stackLayout(el);
    return { width: layout.width, height: layout.height };
  }

  if (Number.isFinite(el.width) && Number.isFinite(el.height)) {
    return { width: el.width, height: el.height };
  }

  // Some early Lake swimlanes omit explicit width/height and only keep split
  // ratios. Use stable defaults so the SVG remains valid instead of emitting
  // `undefined` or `NaN` coordinates.
  if (el.type === 'swimlane') {
    const laneCount = Math.max((el.children || []).length, (el.widths || []).length + 1, 1);
    return {
      width: Number.isFinite(el.width) ? el.width : laneCount * 120,
      height: Number.isFinite(el.height) ? el.height : 240,
    };
  }

  if (el.type === 'text' && el.html) {
    return estimateLooseTextSize(el.html, el.width);
  }

  return {
    width: Number.isFinite(el.width) ? el.width : 0,
    height: Number.isFinite(el.height) ? el.height : 0,
  };
}

// ── Defs ──

function buildDefs() {
  return '<defs></defs>';
}

// ── Render ──

function renderElement(el, index, imageCache, renderIndex = 0) {
  switch (el.type) {
    case 'geometry': return renderGeometry(el);
    case 'text': return renderText(el);
    case 'line': return renderLine(el, index, renderIndex);
    case 'freehand': return renderFreehand(el);
    case 'pen': return renderFreehand(el);
    case 'group': return renderGroup(el, index, imageCache, renderIndex);
    case 'image': return renderImage(el, imageCache);
    case 'stack': return renderStack(el);
    case 'swimlane': return renderSwimlane(el, index, imageCache, renderIndex);
    case 'mindmap': return renderMindmap(el);
    default: return '';
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
    case 'process':
    case 'activation':
    case 'object':
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    case 'state': {
      const rx = Math.min(12, h / 4);
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'simple-class': {
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x}" y1="${y + h / 3}" x2="${x + w}" y2="${y + h / 3}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x}" y1="${y + h * 2 / 3}" x2="${x + w}" y2="${y + h * 2 / 3}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'use-case': {
      const cx = x + w / 2, cy = y + h / 2;
      shapeSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'ellipse':
    case 'circle': {
      const cx = x + w / 2, cy = y + h / 2;
      shapeSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'start': {
      const cx = x + w / 2, cy = y + h / 2;
      shapeSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${fc || sc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'finish': {
      const cx = x + w / 2, cy = y + h / 2;
      const outer = Math.min(w, h) / 2;
      shapeSvg = `<circle cx="${cx}" cy="${cy}" r="${outer}" fill="#fff" stroke="${sc}" stroke-width="${sw}"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${Math.max(outer - sw * 2, 1)}" fill="${sc}" stroke="none"/>`;
      break;
    }
    case 'connector': {
      const cx = x + w / 2, cy = y + h / 2;
      shapeSvg = `<circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) / 2}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'actor':
      return renderActor(el);
    case 'subroutine': {
      const inset = 8;
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x + inset}" y1="${y}" x2="${x + inset}" y2="${y + h}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<line x1="${x + w - inset}" y1="${y}" x2="${x + w - inset}" y2="${y + h}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'document': {
      shapeSvg = renderDocumentPath(x, y, w, h, fc, sc, sw);
      break;
    }
    case 'multi-document': {
      shapeSvg = renderMultiDocumentPath(x, y, w, h, fc, sc, sw);
      break;
    }
    case 'note': {
      const fold = Math.min(18, w * 0.2, h * 0.25);
      shapeSvg = `<path d="M${x},${y} H${x + w - fold} L${x + w},${y + fold} V${y + h} H${x} Z" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<path d="M${x + w - fold},${y} V${y + fold} H${x + w}" fill="none" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'frame': {
      const tabW = Math.min(Math.max(w * 0.16, 56), 110);
      const tabH = Math.min(28, h * 0.18);
      shapeSvg = `<path d="M${x},${y} H${x + tabW} L${x + tabW + tabH * 0.5},${y + tabH} H${x + w} V${y + h} H${x} Z" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<path d="M${x},${y + tabH} H${x + tabW + tabH * 0.5}" fill="none" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'package': {
      const tabW = Math.min(w * 0.42, 110);
      const tabH = Math.min(h * 0.22, 28);
      shapeSvg = `<path d="M${x},${y + tabH} V${y} H${x + tabW} L${x + tabW + 10},${y + tabH} H${x + w} V${y + h} H${x} Z" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'manual-input': {
      const slant = 10;
      shapeSvg = `<polygon points="${x},${y + slant} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'data':
    case 'input-output':
    case 'parallelogram': {
      const slant = Math.min(w * 0.16, 18);
      shapeSvg = `<polygon points="${x + slant},${y} ${x + w},${y} ${x + w - slant},${y + h} ${x},${y + h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'hexagon': {
      const inset = Math.min(w * 0.18, 24);
      shapeSvg = `<polygon points="${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'database':
    case 'cylinder': {
      const ry = Math.min(h * 0.18, 14);
      shapeSvg = `<path d="M${x},${y + ry} C${x},${y - ry / 3} ${x + w},${y - ry / 3} ${x + w},${y + ry} L${x + w},${y + h - ry} C${x + w},${y + h + ry / 3} ${x},${y + h + ry / 3} ${x},${y + h - ry} Z" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="none" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'arrow-1':
    case 'arrow-2':
    case 'process-arrow':
    case 'pentagon-arrow': {
      shapeSvg = renderArrowPolygon(x, y, w, h, fc, sc, sw, shape);
      break;
    }
    case 'weak-entity': {
      // ER weak entities are double rectangles in Yuque. Double diamonds are
      // reserved for weak relationships, so keep the inner shape rectangular.
      const inset = Math.min(5, w * 0.08, h * 0.08);
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>` +
        `<rect x="${x + inset}" y="${y + inset}" width="${Math.max(w - inset * 2, 1)}" height="${Math.max(h - inset * 2, 1)}" rx="1" fill="none" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    case 'rounded-rect': {
      const rx = el.round || 8;
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
      break;
    }
    default:
      shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
  }

  const textSvg = html ? renderGeometryText(el, x, y, w, h, shape) : '';
  return `<g${transform}>${shapeSvg}${textSvg}</g>`;
}

function renderGeometryText(el, x, y, w, h, shape) {
  if (shape === 'connector') {
    return renderConnectorLabel(el, x, y, w, h);
  }
  if (shape === 'package') {
    return renderTextBlock(x, y, w, h, el.html || '', { preserveWords: true, fit: true });
  }
  if (shape === 'process-arrow' || shape === 'pentagon-arrow' || shape === 'arrow-1') {
    const box = arrowTextRegion(x, y, w, h, shape);
    return renderTextBlock(box.x, box.y, box.width, box.height, el.html || '', { vertical: 'center', fit: true });
  }
  if (shape === 'arrow-2') {
    const box = arrowTextRegion(x, y, w, h, shape);
    return renderTextBlock(box.x, box.y, box.width, box.height, el.html || '', { vertical: 'center', fit: true });
  }
  return renderTextBlock(x, y, w, h, el.html || '');
}

function renderConnectorLabel(el, x, y, w, h) {
  const lines = parseHtmlToLines(el.html || '');
  if (!lines.length) return '';

  // UML/component connector labels are rendered outside the small lollipop
  // circle in Yuque. Treating the circle itself as a text box stacks letters.
  const fontSize = readableFontSize(lines[0].style?.fontSize || 13);
  const lineHeight = fontSize * 1.35;
  const cx = x + w / 2;
  const startY = y + h + fontSize + 7;
  let svg = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fs = readableFontSize(line.style?.fontSize || fontSize);
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#333';
    svg += `<text x="${cx}" y="${startY + i * lineHeight}" text-anchor="middle" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(line.text)}</text>`;
  }
  return svg;
}

function renderText(el) {
  const { x, y, html, width, height, rotate } = el;
  if (!html) return '';
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    // Standalone Lake text boxes carry their own layout bounds. Rendering them
    // as a single SVG text node ignores those bounds and lets Chinese text leak
    // out of cards, timelines, and callouts.
    const body = renderTextBlock(x, y, width, height, html, { defaultAlign: 'left', vertical: 'top', fit: true });
    return rotate ? `<g transform="rotate(${rotate} ${x + width / 2} ${y + height / 2})">${body}</g>` : body;
  }

  const lines = parseHtmlToLines(html);
  if (!lines.length) return '';

  if (Number.isFinite(width) && width > 0) {
    const estimatedHeight = estimateTextBlockHeight(html, width);
    const body = renderTextBlock(x, y, width, estimatedHeight, html, { defaultAlign: 'left', vertical: 'top' });
    return rotate ? `<g transform="rotate(${rotate} ${x + width / 2} ${y + estimatedHeight / 2})">${body}</g>` : body;
  }

  let svg = '';
  const fontSize = readableFontSize(lines[0].style?.fontSize || 14);
  const lineHeight = fontSize * 1.4;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ly = y + (i + 1) * lineHeight;
    const fs = readableFontSize(line.style?.fontSize || fontSize);
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#333';
    svg += `<text x="${x}" y="${ly}" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(line.text)}</text>`;
  }
  return rotate ? `<g transform="rotate(${rotate} ${x} ${y})">${svg}</g>` : svg;
}

function renderActor(el) {
  const { x, y, width: w, height: h, stroke, html } = el;
  const sc = stroke?.color || '#333';
  const sw = stroke?.width || 2;
  const cx = x + w / 2;
  const headR = Math.max(Math.min(w, h) * 0.18, 5);
  const headCy = y + headR + 2;
  const neckY = headCy + headR;
  const bodyBottomY = y + h * 0.62;
  const armY = y + h * 0.33;
  const legBottomY = y + h * 0.9;
  const armSpan = Math.max(w * 0.7, 24);
  const legSpan = Math.max(w * 0.6, 22);

  const figure = [
    `<circle cx="${cx}" cy="${headCy}" r="${headR}" fill="#fff" stroke="${sc}" stroke-width="${sw}"/>`,
    `<line x1="${cx}" y1="${neckY}" x2="${cx}" y2="${bodyBottomY}" stroke="${sc}" stroke-width="${sw}"/>`,
    `<line x1="${cx - armSpan / 2}" y1="${armY}" x2="${cx + armSpan / 2}" y2="${armY}" stroke="${sc}" stroke-width="${sw}"/>`,
    `<line x1="${cx}" y1="${bodyBottomY}" x2="${cx - legSpan / 2}" y2="${legBottomY}" stroke="${sc}" stroke-width="${sw}"/>`,
    `<line x1="${cx}" y1="${bodyBottomY}" x2="${cx + legSpan / 2}" y2="${legBottomY}" stroke="${sc}" stroke-width="${sw}"/>`,
  ].join('');

  const text = stripHtml(html || '').trim();
  const label = text
    ? `<text x="${cx}" y="${y + h + 22}" text-anchor="middle" font-size="14" fill="${sc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`
    : '';

  return `<g>${figure}${label}</g>`;
}

function renderFreehand(el) {
  const points = Array.isArray(el.points) ? el.points : [];
  if (!points.length) return '';

  const coords = points
    .map(point => Array.isArray(point) ? point : [point.x, point.y])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!coords.length) return '';

  const stroke = el.stroke || {};
  const sc = stroke.color || '#585A5A';
  const sw = stroke.width || el.width || 2;
  const opacity = el.opacity ?? stroke.opacity ?? 1;
  const d = coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0]},${point[1]}`).join(' ') + (el.isClosed ? ' Z' : '');
  const fc = el.isClosed ? (el.fill?.color || 'none') : 'none';
  return `<path d="${d}" fill="${fc}" stroke="${sc}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
}

function renderStack(el) {
  const { x, y, stroke, fill, children } = el;
  const layout = stackLayout(el);
  const { width: w, height: h, rowHeights } = layout;
  const sc = stroke?.color || '#585A5A';
  const fc = fill?.color || '#FFFFFF';
  const sw = stroke?.width || 1;

  // UML `stack/interface` cards are compound shapes: Yuque stores the outer
  // frame once and each compartment as a child with an `nth` row index.
  const rx = el.shape === 'interface' ? 8 : 0;
  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fc}" stroke="${sc}" stroke-width="${sw}"/>`;
  for (let i = 1; i < rowHeights.length; i += 1) {
    const ly = y + rowHeights.slice(0, i).reduce((sum, value) => sum + value, 0);
    svg += `<line x1="${x}" y1="${ly}" x2="${x + w}" y2="${ly}" stroke="${sc}" stroke-width="${sw}"/>`;
  }

  for (const child of children || []) {
    const nth = Math.min(Math.max(child.nth || 0, 0), rowHeights.length - 1);
    const rowTop = y + rowHeights.slice(0, nth).reduce((sum, value) => sum + value, 0);
    svg += renderTextBlock(x, rowTop, w, rowHeights[nth], child.html || '');
  }
  return svg;
}

function stackLayout(el) {
  const rows = Math.max(el.row || el.children?.length || 1, 1);
  const width = Number.isFinite(el.width) ? el.width : 140;
  const children = el.children || [];
  const rowHeights = Array.from({ length: rows }, (_, index) => {
    const rowChildren = children.filter(child => (child.nth || 0) === index);
    const html = rowChildren.map(child => child.html || '').filter(Boolean).join('<br>');
    const textHeight = html ? estimateTextBlockHeight(html, width) : 0;
    const isHeader = index === 0;
    const minimum = isHeader ? 58 : 34;

    // Lake UML templates often keep a tall design-time `height:200` even when
    // the rendered class/interface only uses the text compartments. Deriving
    // row height from content keeps boxes and line anchors aligned with Yuque.
    return Math.max(minimum, Math.ceil(textHeight + (isHeader ? 6 : 2)));
  });
  return {
    width,
    height: rowHeights.reduce((sum, value) => sum + value, 0),
    rowHeights,
  };
}

// ── Image ──

function renderImage(el, imageCache = {}) {
  const { x, y, width: w, height: h, image } = el;
  if (!image?.src) return '';
  if (!imageCache[image.src] && image.uploadInfo?.fileName === 'iconfont.svg') {
    return renderFlagIcon(x, y, w, h);
  }
  const href = imageCache[image.src] || image.src;
  return `<image href="${escapeAttr(href)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
}

function renderFlagIcon(x, y, w, h) {
  const poleX = x + w * 0.28;
  const topY = y + h * 0.12;
  const bottomY = y + h * 0.88;
  const flagW = w * 0.52;
  const flagH = h * 0.34;

  // Some Yuque board templates reference internal iconfont assets that cannot
  // be fetched locally. Draw a small milestone flag so semantic timeline marks
  // remain visible instead of showing a broken-image placeholder.
  return [
    `<line x1="${poleX}" y1="${topY}" x2="${poleX}" y2="${bottomY}" stroke="#69B1E4" stroke-width="1.4" stroke-linecap="round"/>`,
    `<path d="M${poleX},${topY} H${poleX + flagW} L${poleX + flagW * 0.74},${topY + flagH * 0.45} L${poleX + flagW},${topY + flagH} H${poleX} Z" fill="#E6B94D" stroke="#D6A23A" stroke-width="0.8"/>`,
  ].join('');
}

// ── Line ──

function renderLine(el, index, renderIndex = 0) {
  const { source, target, stroke, html } = el;
  const sc = stroke?.color || '#8C8C8C';
  const sw = stroke?.width || 1;
  const markerStart = createLineMarker(source?.marker, 'start', sc, sw, el.id || renderIndex);
  const markerEnd = createLineMarker(target?.marker, 'end', sc, sw, el.id || renderIndex);

  const { sp, tp } = resolveLinePoints(el, index);
  if (!sp || !tp) return `<!-- line: unresolved endpoints -->`;

  const markerStartAttr = markerStart.id ? ` marker-start="url(#${markerStart.id})"` : '';
  const markerEndAttr = markerEnd.id ? ` marker-end="url(#${markerEnd.id})"` : '';
  const dashAttr = stroke?.style === 'dash' ? ' stroke-dasharray="6 6"' : '';
  const lineCap = el.shape === 'curve' ? 'round' : 'butt';
  const lineJoin = el.shape === 'elbow' ? 'miter' : 'round';
  let path;

  if (el.shape === 'elbow') {
    path = polylinePath(routedElbowPoints(el, sp, tp));
  } else if (el.controlPoints && el.controlPoints.length) {
    const pts = [sp, ...el.controlPoints.map(cp => [cp.x ?? cp[0], cp.y ?? cp[1]]), tp];
    if (el.shape === 'curve' && pts.length === 3) {
      path = `M${sp[0]},${sp[1]} Q${pts[1][0]},${pts[1][1]} ${tp[0]},${tp[1]}`;
    } else if (el.shape === 'curve' && pts.length >= 4) {
      path = `M${sp[0]},${sp[1]} C${pts[1][0]},${pts[1][1]} ${pts[2][0]},${pts[2][1]} ${tp[0]},${tp[1]}`;
    } else {
      path = polylinePath(cleanPolylinePoints(pts));
    }
  } else if (el.shape === 'curve') {
    // Curve lines without explicit control points still need a smooth route;
    // use a midpoint control point so semantic UML arcs do not degrade to elbows.
    const dx = tp[0] - sp[0];
    const dy = tp[1] - sp[1];
    const controlX = sp[0] + dx / 2;
    const controlY = sp[1] + dy / 2 - Math.min(Math.abs(dx), 120) * 0.25;
    path = `M${sp[0]},${sp[1]} Q${controlX},${controlY} ${tp[0]},${tp[1]}`;
  } else {
    path = straightLinePath(sp, tp);
  }

  let svg = `${markerStart.def}${markerEnd.def}<path d="${path}" fill="none" stroke="${sc}" stroke-width="${sw}" stroke-linecap="${lineCap}" stroke-linejoin="${lineJoin}"${dashAttr}${markerStartAttr}${markerEndAttr}/>`;

  // Render line label at midpoint
  if (html) {
    const [mx, my] = lineLabelPoint(el, sp, tp);
    svg += renderLineLabel(mx, my, html);
  }

  return svg;
}

function straightLinePath(sp, tp) {
  const dx = tp[0] - sp[0];
  const dy = tp[1] - sp[1];

  // Lines anchored to loose text can differ by a pixel or two because the raw
  // Lake data stores text without width. Snap near-orthogonal straight lines so
  // guide lines remain vertical/horizontal like Yuque's DOM-measured renderer.
  if (Math.abs(dx) <= ORTHOGONAL_SNAP_TOLERANCE && Math.abs(dy) >= MIN_ORTHOGONAL_SNAP_LENGTH) {
    return `M${sp[0]},${sp[1]} L${sp[0]},${tp[1]}`;
  }
  if (Math.abs(dy) <= ORTHOGONAL_SNAP_TOLERANCE && Math.abs(dx) >= MIN_ORTHOGONAL_SNAP_LENGTH) {
    return `M${sp[0]},${sp[1]} L${tp[0]},${sp[1]}`;
  }
  return `M${sp[0]},${sp[1]} L${tp[0]},${tp[1]}`;
}

function renderLineLabel(cx, cy, html) {
  const lines = parseHtmlToLines(html);
  if (!lines.length) return '';

  // Line labels in Yuque are free text, not constrained text boxes. Fixed-width
  // wrapping makes state-machine labels like "compressor running" stack letters.
  const baseSize = readableFontSize(lines[0].style?.fontSize || 14);
  const lineHeight = baseSize * 1.25;
  const startY = cy - ((lines.length - 1) * lineHeight) / 2 + baseSize * 0.35;
  let svg = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fs = readableFontSize(line.style?.fontSize || baseSize);
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#8C8C8C';
    svg += `<text x="${cx}" y="${startY + i * lineHeight}" text-anchor="middle" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(line.text)}</text>`;
  }
  return svg;
}

function createLineMarker(marker, position, color, strokeWidth, salt) {
  const type = normalizeMarker(marker);
  if (!type) return { id: '', def: '' };

  const id = `m-${sanitizeSvgId(salt)}-${position}-${type}-${sanitizeSvgId(color)}`;
  const dir = position === 'start' ? -1 : 1;
  const stroke = escapeAttr(color);
  const markerStrokeWidth = Math.max(Math.min(strokeWidth * 0.55, 2), 1.2);
  const common = `id="${id}" orient="auto" markerUnits="userSpaceOnUse"`;

  if (type === 'arrow') {
    const refX = position === 'start' ? 0 : 10;
    const points = position === 'start'
      ? '10 0, 0 5, 10 10'
      : '0 0, 10 5, 0 10';
    return {
      id,
      def: `<defs><marker ${common} markerWidth="10" markerHeight="10" viewBox="0 0 10 10" refX="${refX}" refY="5"><polygon points="${points}" fill="${stroke}"/></marker></defs>`,
    };
  }

  if (type === 'open-triangle') {
    const refX = position === 'start' ? 0 : 12;
    const d = position === 'start' ? 'M11,1 L1,6 L11,11' : 'M1,1 L11,6 L1,11';
    return {
      id,
      def: `<defs><marker ${common} markerWidth="12" markerHeight="12" viewBox="0 0 12 12" refX="${refX}" refY="6"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="${markerStrokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`,
    };
  }

  if (type === 'hollow-triangle') {
    const refX = position === 'start' ? 0 : 12;
    const d = position === 'start' ? 'M11,1 L1,6 L11,11 Z' : 'M1,1 L11,6 L1,11 Z';
    return {
      id,
      def: `<defs><marker ${common} markerWidth="12" markerHeight="12" viewBox="0 0 12 12" refX="${refX}" refY="6"><path d="${d}" fill="#fff" stroke="${stroke}" stroke-width="${markerStrokeWidth}" stroke-linejoin="round"/></marker></defs>`,
    };
  }

  if (type === 'solid-circle') {
    const refX = position === 'start' ? 2 : 6;
    return {
      id,
      def: `<defs><marker ${common} markerWidth="8" markerHeight="8" viewBox="0 0 8 8" refX="${refX}" refY="4"><circle cx="4" cy="4" r="3.2" fill="${stroke}"/></marker></defs>`,
    };
  }

  if (type === 'half-open-circle') {
    const sweep = dir === 1 ? '1' : '0';
    return {
      id,
      def: `<defs><marker ${common} markerWidth="10" markerHeight="10" viewBox="0 0 10 10" refX="5" refY="5"><path d="M5,1 A4,4 0 1 ${sweep} 5,9" fill="none" stroke="${stroke}" stroke-width="${markerStrokeWidth}"/></marker></defs>`,
    };
  }

  return { id: '', def: '' };
}

function lineLabelPoint(line, sp, tp) {
  if (!sp || !tp) return [0, 0];
  if (Array.isArray(line.textPosition)) return line.textPosition;
  const routePoints = line.shape === 'elbow'
    ? routedElbowPoints(line, sp, tp)
    : [
      sp,
      ...(line.controlPoints || []).map(cp => [cp.x ?? cp[0], cp.y ?? cp[1]]),
      tp,
    ];
  if (Number.isFinite(line.textPosition)) {
    return pointAtPathRatio(routePoints, line.textPosition);
  }
  const points = routePoints
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length <= 2) return [(sp[0] + tp[0]) / 2, (sp[1] + tp[1]) / 2];

  // Use the middle segment of the routed polyline rather than endpoint
  // midpoint; Yuque stores many elbow labels near the middle bend.
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segments.push({ from: points[i - 1], to: points[i], length });
    total += length;
  }
  let cursor = 0;
  for (const segment of segments) {
    if (cursor + segment.length >= total / 2) {
      const ratio = segment.length ? (total / 2 - cursor) / segment.length : 0;
      return [
        segment.from[0] + (segment.to[0] - segment.from[0]) * ratio,
        segment.from[1] + (segment.to[1] - segment.from[1]) * ratio,
      ];
    }
    cursor += segment.length;
  }
  return [(sp[0] + tp[0]) / 2, (sp[1] + tp[1]) / 2];
}

function pointAtPathRatio(points, ratio) {
  const clean = points.filter(point => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]));
  if (!clean.length) return [0, 0];
  if (clean.length === 1) return clean[0];

  const target = Math.max(0, Math.min(1, ratio));
  const segments = [];
  let total = 0;
  for (let i = 1; i < clean.length; i += 1) {
    const length = Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]);
    segments.push({ from: clean[i - 1], to: clean[i], length });
    total += length;
  }
  if (!total) return clean[0];

  let cursor = 0;
  const distance = total * target;
  for (const segment of segments) {
    if (cursor + segment.length >= distance) {
      const local = segment.length ? (distance - cursor) / segment.length : 0;
      return [
        segment.from[0] + (segment.to[0] - segment.from[0]) * local,
        segment.from[1] + (segment.to[1] - segment.from[1]) * local,
      ];
    }
    cursor += segment.length;
  }
  return clean[clean.length - 1];
}

function normalizeMarker(marker) {
  switch (marker) {
    case 'none':
      return '';
    case 'arrow':
    case 'open-triangle':
    case 'hollow-triangle':
    case 'solid-circle':
    case 'half-open-circle':
      return marker;
    default:
      return '';
  }
}

function resolveLinePoints(line, index) {
  let sp = resolvePoint(line.source, index);
  let tp = resolvePoint(line.target, index);
  sp = resolveEndpointPoint(line.source, index, tp || endpointCenter(line.target, index)) || sp;
  tp = resolveEndpointPoint(line.target, index, sp || endpointCenter(line.source, index)) || tp;
  return { sp, tp };
}

function resolveEndpointPoint(endpoint, index, oppositePoint) {
  if (!endpoint) return null;
  if (!endpoint.id || !index[endpoint.id]) return resolvePoint(endpoint, index);

  const el = index[endpoint.id];
  const bbox = elementRect(el);
  if (!bbox) return resolvePoint(endpoint, index);

  if (Array.isArray(endpoint.connection)) {
    return [bbox.x + bbox.width * endpoint.connection[0], bbox.y + bbox.height * endpoint.connection[1]];
  }

  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  switch (endpoint.connection) {
    case 'N': return [cx, bbox.y];
    case 'S': return [cx, bbox.y + bbox.height];
    case 'E': return [bbox.x + bbox.width, cy];
    case 'W': return [bbox.x, cy];
    default:
      return oppositePoint ? boundaryPoint(el, bbox, oppositePoint) : [cx, cy];
  }
}

function endpointCenter(endpoint, index) {
  if (!endpoint) return null;
  if (endpoint.id && index[endpoint.id]) {
    const bbox = elementRect(index[endpoint.id]);
    if (bbox) return [bbox.x + bbox.width / 2, bbox.y + bbox.height / 2];
  }
  if (Array.isArray(endpoint.connection)) return endpoint.connection;
  return null;
}

function elementRect(el) {
  if (!el) return null;
  const size = resolveElementSize(el);
  if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) return null;
  return { x: el.x, y: el.y, width: size.width || 0, height: size.height || 0 };
}

function boundaryPoint(el, bbox, oppositePoint) {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const dx = oppositePoint[0] - cx;
  const dy = oppositePoint[1] - cy;
  if (!dx && !dy) return [cx, cy];

  if (['ellipse', 'circle', 'use-case', 'connector'].includes(el.shape)) {
    const rx = Math.max(bbox.width / 2, 1);
    const ry = Math.max(bbox.height / 2, 1);
    const scale = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return [cx + dx * scale, cy + dy * scale];
  }

  const halfW = Math.max(bbox.width / 2, 1);
  const halfH = Math.max(bbox.height / 2, 1);
  const scale = Math.min(
    dx ? Math.abs(halfW / dx) : Infinity,
    dy ? Math.abs(halfH / dy) : Infinity,
  );
  return [cx + dx * scale, cy + dy * scale];
}

function endpointDirection(endpoint) {
  if (!endpoint) return null;
  if (endpoint.connection === 'N') return [0, -1];
  if (endpoint.connection === 'S') return [0, 1];
  if (endpoint.connection === 'E') return [1, 0];
  if (endpoint.connection === 'W') return [-1, 0];
  if (Array.isArray(endpoint.connection) && endpoint.id) {
    const [rx, ry] = endpoint.connection;
    const eps = 0.001;
    if (rx <= eps) return [-1, 0];
    if (rx >= 1 - eps) return [1, 0];
    if (ry <= eps) return [0, -1];
    if (ry >= 1 - eps) return [0, 1];
  }
  return null;
}

function buildElbowPath(line, sp, tp) {
  return polylinePath(routedElbowPoints(line, sp, tp));
}

function routedElbowPoints(line, sp, tp) {
  const controlPoints = (line.controlPoints || [])
    .map(cp => ({ x: cp.x ?? cp[0], y: cp.y ?? cp[1], axis: cp.axis || cp[2] }))
    .filter(cp => Number.isFinite(cp.x) && Number.isFinite(cp.y));

  if (controlPoints.length) {
    // Yuque stores elbow handles with an H/V axis hint. The handle is not a
    // free diagonal waypoint; it describes which orthogonal leg should be used
    // while preserving the handle's x/y guide coordinate.
    const points = [sp];
    let current = sp;
    for (const cp of controlPoints) {
      appendOrthogonalStep(points, current, [cp.x, cp.y], cp.axis);
      current = [cp.x, cp.y];
    }
    appendOrthogonalStep(points, current, tp, finalElbowAxis(line.target));
    return cleanPolylinePoints(points);
  }

  if (Math.abs(sp[0] - tp[0]) < 0.01 || Math.abs(sp[1] - tp[1]) < 0.01) {
    return cleanPolylinePoints([sp, tp]);
  }

  const sd = endpointDirection(line.source);
  const td = endpointDirection(line.target);
  const points = [sp];

  if (sd && td) {
    const sourceHorizontal = Math.abs(sd[0]) > Math.abs(sd[1]);
    const targetHorizontal = Math.abs(td[0]) > Math.abs(td[1]);
    if (sourceHorizontal && targetHorizontal) {
      const midX = (sp[0] + tp[0]) / 2;
      points.push([midX, sp[1]], [midX, tp[1]]);
    } else if (!sourceHorizontal && !targetHorizontal) {
      const midY = (sp[1] + tp[1]) / 2;
      points.push([sp[0], midY], [tp[0], midY]);
    } else if (sourceHorizontal && !targetHorizontal) {
      points.push([tp[0], sp[1]]);
    } else {
      points.push([sp[0], tp[1]]);
    }
  } else {
    const dx = tp[0] - sp[0];
    const dy = tp[1] - sp[1];
    if (Math.abs(dx) > Math.abs(dy)) {
      const midX = sp[0] + dx / 2;
      points.push([midX, sp[1]], [midX, tp[1]]);
    } else {
      const midY = sp[1] + dy / 2;
      points.push([sp[0], midY], [tp[0], midY]);
    }
  }

  points.push(tp);
  return cleanPolylinePoints(points);
}

function appendOrthogonalStep(points, from, to, axis) {
  if (Math.abs(from[0] - to[0]) < 0.01 || Math.abs(from[1] - to[1]) < 0.01) {
    points.push(to);
    return;
  }

  // "V" means the first leg leaving the current point is vertical; "H" means
  // horizontal. This matches Lakeboard's handle flags and keeps org-chart lines
  // as horizontal/vertical routes instead of diagonal shortcuts.
  if (axis === 'V') {
    points.push([from[0], to[1]], to);
  } else {
    points.push([to[0], from[1]], to);
  }
}

function finalElbowAxis(endpoint) {
  const dir = endpointDirection(endpoint);
  if (!dir) return undefined;
  // To enter a north/south port, the last segment must be vertical, so the
  // step starts horizontally. East/west ports use the inverse.
  return Math.abs(dir[1]) > Math.abs(dir[0]) ? 'H' : 'V';
}

function cleanPolylinePoints(points) {
  const clean = [];
  for (const point of points) {
    if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) continue;
    const prev = clean[clean.length - 1];
    if (prev && Math.abs(prev[0] - point[0]) < 0.01 && Math.abs(prev[1] - point[1]) < 0.01) continue;
    clean.push(point);
  }
  return clean;
}

function polylinePath(points) {
  const clean = cleanPolylinePoints(points);
  if (!clean.length) return '';
  return `M${clean.map(point => point.join(',')).join(' L')}`;
}

function resolvePoint(endpoint, index) {
  if (!endpoint) return null;

  // ID reference: { id: "xxx", connection: "S"|"N"|"E"|"W" }
  if (endpoint.id && index[endpoint.id]) {
    const el = index[endpoint.id];
    const x = el.x || 0, y = el.y || 0;
    const w = el.width || 0, h = el.height || 0;
    const cx = x + w / 2, cy = y + h / 2;

    // When a connection array appears together with an id, Yuque uses it as a
    // relative anchor ratio on the referenced element, not an absolute point.
    if (Array.isArray(endpoint.connection)) {
      return [x + w * endpoint.connection[0], y + h * endpoint.connection[1]];
    }

    switch (endpoint.connection) {
      case 'N': return [cx, y];
      case 'S': return [cx, y + h];
      case 'E': return [x + w, cy];
      case 'W': return [x, cy];
      default: return [cx, cy];
    }
  }

  // Direct coordinate: { connection: [x, y] }
  if (Array.isArray(endpoint.connection)) {
    return endpoint.connection;
  }

  return null;
}

// ── Mindmap ──

function stripMindmapText(html) {
  return stripHtml(html || '').trim();
}

function mindmapNodeWidth(node, depth = 1) {
  const text = stripMindmapText(node.html);
  const fontSize = depth === 0 ? 16 : 13;
  const minWidth = depth === 0 ? 100 : 80;
  const padding = depth === 0 ? 40 : 26;
  const textWidth = Array.from(text).reduce((sum, char) => sum + estimateCharWidth(char, fontSize), 0);
  return Math.max(textWidth + padding, minWidth);
}

function isVerticalMindmap(root) {
  return Array.isArray(root.layout?.direction) && root.layout.direction[0] === 0 && root.layout.direction[1] === 1;
}

function isStandardVerticalMindmap(root) {
  return isVerticalMindmap(root) && root.layout?.type === 'standard';
}

function isStandardRightMindmap(root) {
  const children = root.children || [];
  return root.layout?.type === 'standard'
    && !isVerticalMindmap(root)
    && children.length > 0
    && children.every(child => (
      child.layout?.type === 'indent'
      && Array.isArray(child.layout?.direction)
      && child.layout.direction[0] === 1
      && child.layout.direction[1] === 1
    ));
}

function isTimelineListMindmap(root) {
  const text = stripMindmapText(root.html);
  const children = root.children || [];
  return !text
    && root.layout?.type === 'indent'
    && Array.isArray(root.layout?.direction)
    && root.layout.direction[0] === 1
    && root.layout.direction[1] === 1
    && children.length > 0
    && children.every(child => !(child.children || []).length);
}

function measureTimelineListMindmap(root) {
  const anchorX = root.x || 0;
  const startY = (root.y || 0) + 44;
  const gapY = 48;
  const lastY = startY + 34 + Math.max((root.children || []).length - 1, 0) * gapY;
  return {
    bbox: {
      x: anchorX - 6,
      y: startY - 4,
      width: 132,
      height: Math.max(lastY - startY + 18, 24),
    },
  };
}

function measureMindmap(root) {
  const rootX = root.x || 0;
  const rootY = root.y || 0;
  const nodeH = 30;
  const rootH = 36;
  const nodeGapY = 10;
  const levelGapX = 180;
  const rootW = mindmapNodeWidth(root, 0);
  const boxes = [{ x: rootX - rootW / 2, y: rootY - rootH / 2, width: rootW, height: rootH }];

  function countLeaves(node) {
    if (!node.children || !node.children.length) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  function addBranch(node, depth, yCenter, direction) {
    const w = mindmapNodeWidth(node, depth);
    const x = direction === 1 ? rootX + depth * levelGapX : rootX - depth * levelGapX - w;
    boxes.push({ x, y: yCenter - nodeH / 2, width: w, height: nodeH });

    if (!node.children || !node.children.length) return;
    const leaves = node.children.map(c => countLeaves(c));
    const totalLeaves = leaves.reduce((a, b) => a + b, 0);
    const totalH = totalLeaves * (nodeH + nodeGapY) - nodeGapY;
    let cy = yCenter - totalH / 2 + (leaves[0] * (nodeH + nodeGapY) - nodeGapY) / 2;
    node.children.forEach((child, i) => {
      addBranch(child, depth + 1, cy, direction);
      if (i < node.children.length - 1) cy += (leaves[i] + leaves[i + 1]) * (nodeH + nodeGapY) / 2;
    });
  }

  const rightChildren = (root.children || []).filter(c => (c.layout?.quadrant || 1) === 1);
  const leftChildren = (root.children || []).filter(c => c.layout?.quadrant === 2);

  function addSide(children, direction) {
    if (!children.length) return;
    const leaves = children.map(c => countLeaves(c));
    const totalLeaves = leaves.reduce((a, b) => a + b, 0);
    const totalH = totalLeaves * (nodeH + nodeGapY) - nodeGapY;
    let cy = rootY - totalH / 2 + (leaves[0] * (nodeH + nodeGapY) - nodeGapY) / 2;
    children.forEach((child, i) => {
      addBranch(child, 1, cy, direction);
      if (i < children.length - 1) cy += (leaves[i] + leaves[i + 1]) * (nodeH + nodeGapY) / 2;
    });
  }

  addSide(rightChildren, 1);
  addSide(leftChildren, -1);
  return { bbox: mergeBBoxes(...boxes), boxes };
}

function standardRightMindmapLayout(root) {
  const rootX = root.x || 0;
  const rootY = root.y || 0;
  const rootW = Math.max(mindmapNodeWidth(root, 0), 108);
  const rootH = 48;
  const rootBox = {
    node: root,
    depth: 0,
    x: rootX,
    y: rootY,
    width: rootW,
    height: rootH,
    centerX: rootX + rootW / 2,
    centerY: rootY + rootH / 2,
  };

  const branches = root.children || [];
  const branchX = rootX + rootW + 112;
  const krXOffset = 148;
  const topY = rootY - 138;
  const branchGapY = 158;
  const krGapY = 48;
  const boxes = [rootBox];
  const branchBoxes = branches.map((branch, index) => {
    const text = stripMindmapText(branch.html);
    const width = Math.max(mindmapNodeWidth(branch, 1), 180);
    const y = topY + index * branchGapY;
    const box = {
      node: branch,
      depth: 1,
      x: branchX,
      y,
      width,
      height: 28,
      centerX: branchX + width / 2,
      centerY: y + 14,
    };
    if (!text) box.width = 80;
    boxes.push(box);

    const childBoxes = (branch.children || []).map((child, childIndex) => {
      const childW = Math.max(mindmapNodeWidth(child, 2), 100);
      const childY = y + 42 + childIndex * krGapY;
      const childBox = {
        node: child,
        depth: 2,
        x: branchX + krXOffset,
        y: childY,
        width: childW,
        height: 24,
        centerX: branchX + krXOffset + childW / 2,
        centerY: childY + 12,
      };
      boxes.push(childBox);
      return childBox;
    });
    return { box, children: childBoxes };
  });

  return { rootBox, branchBoxes, boxes, bbox: mergeBBoxes(...boxes) };
}

function renderStandardRightMindmap(root) {
  const { rootBox, branchBoxes } = standardRightMindmapLayout(root);
  let svg = '';

  function nodeTextStyle(node, fallbackSize, fallbackWeight = 'normal') {
    const line = parseHtmlToLines(node.html || '')[0] || {};
    return {
      size: readableFontSize(line.style?.fontSize || fallbackSize),
      weight: line.style?.bold ? 'bold' : fallbackWeight,
      color: line.style?.color || node.defaultContentStyle?.color || '#595959',
    };
  }

  function drawPlainText(box, fallbackSize, fallbackWeight = 'normal') {
    const text = stripMindmapText(box.node.html);
    if (!text) return;
    const style = nodeTextStyle(box.node, fallbackSize, fallbackWeight);
    svg += `<text x="${box.x}" y="${box.centerY + style.size * 0.35}" text-anchor="start" font-size="${style.size}" font-weight="${style.weight}" fill="${style.color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`;
  }

  const rootFill = root.border?.fill || '#F5F5F5';
  const rootRx = root.border?.shape === 'capsule' ? rootBox.height / 2 : 8;
  const rootStyle = nodeTextStyle(root, 18, 'bold');
  svg += `<rect x="${rootBox.x}" y="${rootBox.y}" width="${rootBox.width}" height="${rootBox.height}" rx="${rootRx}" fill="${rootFill}" stroke="none"/>`;
  svg += `<text x="${rootBox.centerX}" y="${rootBox.centerY + rootStyle.size * 0.35}" text-anchor="middle" font-size="${rootStyle.size}" font-weight="${rootStyle.weight}" fill="${rootStyle.color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(stripMindmapText(root.html))}</text>`;

  for (const branch of branchBoxes) {
    const color = branch.box.node.treeEdge?.stroke || '#BFBFBF';
    const strokeWidth = branch.box.node.treeEdge?.['stroke-width'] || 3;
    const branchStartX = branch.box.x - 18;
    const rootExitX = rootBox.x + rootBox.width;
    const rootExitY = rootBox.centerY;
    const branchY = branch.box.centerY;

    // Standard right-facing mindmaps store no absolute child coordinates. Yuque
    // lays them out from a left root with broad bezier branches and transparent
    // text nodes, so we reconstruct those visual anchors rather than drawing
    // compact boxed nodes.
    const dx = Math.max(branchStartX - rootExitX, 1);
    const rootPath = Math.abs(branchY - rootExitY) < 36
      ? `M${rootExitX},${rootExitY} H${branchStartX}`
      : `M${rootExitX},${rootExitY} H${rootExitX + dx * 0.16} C${rootExitX + dx * 0.62},${rootExitY} ${rootExitX + dx * 0.48},${branchY} ${branchStartX},${branchY}`;
    svg += `<path d="${rootPath}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    drawPlainText(branch.box, 16, 'bold');

    if (branch.children.length) {
      const braceX = branch.box.x + 132;
      const first = branch.children[0];
      const last = branch.children[branch.children.length - 1];
      const top = first.centerY - 26;
      const bottom = last.centerY + 18;
      const hook = 22;
      const midTop = first.centerY - 4;
      const midBottom = last.centerY + 4;
      svg += `<path d="M${braceX},${top} C${braceX},${midTop} ${braceX + 2},${first.centerY} ${braceX + hook},${first.centerY} M${braceX},${top} V${bottom} M${braceX},${bottom} C${braceX},${midBottom} ${braceX + 2},${last.centerY} ${braceX + hook},${last.centerY}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
      for (const child of branch.children) {
        drawPlainText(child, 14);
      }
    }
  }

  return svg;
}

function measureVerticalMindmap(root) {
  if (isStandardVerticalMindmap(root)) return measureStandardVerticalMindmap(root);

  const rootW = mindmapNodeWidth(root, 0);
  const rootX = (root.x || 0) + rootW / 2;
  const rootY = root.y || 0;
  const nodeH = 30;
  const rootH = 36;
  const levelGapY = 78;
  const listGapY = 18;
  const siblingGapX = 42;
  const boxes = [];

  function subtreeWidth(node, depth) {
    const own = mindmapNodeWidth(node, depth);
    if (!node.children || !node.children.length) return own;
    if (depth > 0) return Math.max(own, ...node.children.map(child => subtreeWidth(child, depth + 1)));
    const childWidth = node.children.reduce((sum, child, index) => (
      sum + subtreeWidth(child, depth + 1) + (index ? siblingGapX : 0)
    ), 0);
    return Math.max(own, childWidth);
  }

  function subtreeHeight(node, depth) {
    const ownH = depth === 0 ? rootH : nodeH;
    if (!node.children || !node.children.length) return ownH;
    if (depth === 0) return ownH + levelGapY + Math.max(...node.children.map(child => subtreeHeight(child, depth + 1)));
    return ownH + levelGapY + node.children.reduce((sum, child, index) => (
      sum + subtreeHeight(child, depth + 1) + (index ? listGapY : 0)
    ), 0);
  }

  function addNode(node, centerX, y, depth) {
    const w = mindmapNodeWidth(node, depth);
    const h = depth === 0 ? rootH : nodeH;
    boxes.push({ x: centerX - w / 2, y, width: w, height: h });
    if (!node.children || !node.children.length) return;

    const childY = y + h + levelGapY;
    if (depth === 0) {
      const total = node.children.reduce((sum, child, index) => (
        sum + subtreeWidth(child, depth + 1) + (index ? siblingGapX : 0)
      ), 0);
      let cursor = centerX - total / 2;
      for (const child of node.children) {
        const childWidth = subtreeWidth(child, depth + 1);
        addNode(child, cursor + childWidth / 2, childY, depth + 1);
        cursor += childWidth + siblingGapX;
      }
      return;
    }

    let cursorY = childY;
    for (const child of node.children) {
      addNode(child, centerX, cursorY, depth + 1);
      cursorY += subtreeHeight(child, depth + 1) + listGapY;
    }
  }

  addNode(root, rootX, rootY, 0);
  return { bbox: mergeBBoxes(...boxes), boxes };
}

function standardVerticalMindmapLayout(root) {
  const rootW = mindmapNodeWidth(root, 0);
  const rootH = 40;
  const nodeH = 28;
  const rootX = root.x || 0;
  const rootY = root.y || 0;
  const rootBox = {
    node: root,
    depth: 0,
    x: rootX,
    y: rootY,
    width: rootW,
    height: rootH,
    centerX: rootX + rootW / 2,
    centerY: rootY + rootH / 2,
  };
  const branches = root.children || [];
  const branchGap = 120;
  const firstY = rootY + rootH + 78;
  const childIndentX = 28;
  const childGapY = 18;
  const boxes = [rootBox];
  const branchBoxes = [];

  const branchWidths = branches.map(child => mindmapNodeWidth(child, 1));
  const totalW = branchWidths.reduce((sum, width) => sum + width, 0) + Math.max(branches.length - 1, 0) * branchGap;
  let cursor = rootBox.centerX - totalW / 2;

  branches.forEach((branch, index) => {
    const width = branchWidths[index];
    const branchBox = {
      node: branch,
      depth: 1,
      x: cursor,
      y: firstY,
      width,
      height: nodeH,
      centerX: cursor + width / 2,
      centerY: firstY + nodeH / 2,
    };
    boxes.push(branchBox);
    const childBoxes = [];
    let childY = firstY + nodeH + 36;
    for (const child of branch.children || []) {
      const childW = mindmapNodeWidth(child, 2);
      const childBox = {
        node: child,
        depth: 2,
        x: branchBox.centerX + childIndentX,
        y: childY,
        width: childW,
        height: nodeH,
        centerX: branchBox.centerX + childIndentX + childW / 2,
        centerY: childY + nodeH / 2,
      };
      childBoxes.push(childBox);
      boxes.push(childBox);
      childY += nodeH + childGapY;
    }
    branchBoxes.push({ box: branchBox, children: childBoxes });
    cursor += width + branchGap;
  });

  return { rootBox, branchBoxes, boxes, bbox: mergeBBoxes(...boxes) };
}

function measureStandardVerticalMindmap(root) {
  return standardVerticalMindmapLayout(root);
}

function renderVerticalMindmap(root) {
  if (isStandardVerticalMindmap(root)) return renderStandardVerticalMindmap(root);

  const rootW = mindmapNodeWidth(root, 0);
  const rootX = (root.x || 0) + rootW / 2;
  const rootY = root.y || 0;
  const nodeH = 30;
  const rootH = 36;
  const levelGapY = 78;
  const listGapY = 18;
  const siblingGapX = 42;
  let svg = '';

  function subtreeWidth(node, depth) {
    const own = mindmapNodeWidth(node, depth);
    if (!node.children || !node.children.length) return own;
    if (depth > 0) return Math.max(own, ...node.children.map(child => subtreeWidth(child, depth + 1)));
    const childWidth = node.children.reduce((sum, child, index) => (
      sum + subtreeWidth(child, depth + 1) + (index ? siblingGapX : 0)
    ), 0);
    return Math.max(own, childWidth);
  }

  function subtreeHeight(node, depth) {
    const ownH = depth === 0 ? rootH : nodeH;
    if (!node.children || !node.children.length) return ownH;
    if (depth === 0) return ownH + levelGapY + Math.max(...node.children.map(child => subtreeHeight(child, depth + 1)));
    return ownH + levelGapY + node.children.reduce((sum, child, index) => (
      sum + subtreeHeight(child, depth + 1) + (index ? listGapY : 0)
    ), 0);
  }

  function nodeStyle(node, depth) {
    const h = depth === 0 ? rootH : nodeH;
    return {
      width: mindmapNodeWidth(node, depth),
      height: h,
      fill: node.border?.fill || (depth === 0 ? '#6F81DB' : depth === 1 ? '#A287E1' : '#F5F5F5'),
      stroke: node.border?.stroke || 'none',
      rx: node.border?.shape === 'capsule' ? h / 2 : 6,
      fontSize: depth === 0 ? 16 : 13,
      fontWeight: depth === 0 ? 'bold' : 'normal',
      color: node.defaultContentStyle?.color || '#333',
    };
  }

  function drawNode(node, centerX, y, depth) {
    const text = stripMindmapText(node.html);
    const style = nodeStyle(node, depth);
    const x = centerX - style.width / 2;
    const cy = y + style.height / 2;
    svg += `<rect x="${x}" y="${y}" width="${style.width}" height="${style.height}" rx="${style.rx}" fill="${style.fill}" stroke="${style.stroke}"/>`;
    svg += `<text x="${centerX}" y="${cy + style.fontSize * 0.35}" text-anchor="middle" font-size="${style.fontSize}" font-weight="${style.fontWeight}" fill="${style.color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`;
    return { x, y, centerX, centerY: cy, bottomY: y + style.height, width: style.width, height: style.height };
  }

  function drawSubtree(node, centerX, y, depth, parentBox = null, edgeColor = '#BFBFBF') {
    const style = nodeStyle(node, depth);
    const box = {
      x: centerX - style.width / 2,
      y,
      centerX,
      centerY: y + style.height / 2,
      bottomY: y + style.height,
      width: style.width,
      height: style.height,
    };
    if (parentBox) {
      const color = node.treeEdge?.stroke || edgeColor;
      const midY = parentBox.bottomY + (box.y - parentBox.bottomY) / 2;
      // Vertical mindmaps in Yuque are closer to organization charts: a
      // short stem from parent, one horizontal bus, then stems into children.
      svg += `<path d="M${parentBox.centerX},${parentBox.bottomY} V${midY} H${box.centerX} V${box.y}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      edgeColor = color;
    }
    drawNode(node, centerX, y, depth);

    if (!node.children || !node.children.length) return box;
    const childY = y + box.height + levelGapY;
    if (depth === 0) {
      const total = node.children.reduce((sum, child, index) => (
        sum + subtreeWidth(child, depth + 1) + (index ? siblingGapX : 0)
      ), 0);
      let cursor = centerX - total / 2;
      for (const child of node.children) {
        const childWidth = subtreeWidth(child, depth + 1);
        drawSubtree(child, cursor + childWidth / 2, childY, depth + 1, box, child.treeEdge?.stroke || edgeColor);
        cursor += childWidth + siblingGapX;
      }
      return box;
    }

    let cursorY = childY;
    for (const child of node.children) {
      drawSubtree(child, centerX, cursorY, depth + 1, box, child.treeEdge?.stroke || edgeColor);
      cursorY += subtreeHeight(child, depth + 1) + listGapY;
    }
    return box;
  }

  drawSubtree(root, rootX, rootY, 0);
  return svg;
}

function renderStandardVerticalMindmap(root) {
  const { rootBox, branchBoxes } = standardVerticalMindmapLayout(root);
  let svg = '';

  function styleFor(node, depth, edgeColor) {
    const h = depth === 0 ? rootBox.height : 28;
    const border = node.border || {};
    const transparentFill = border.fill === 'transparent';
    const fill = transparentFill ? '#FFFFFF' : (border.fill || '#FFFFFF');
    const stroke = border.stroke || (border.shape === 'capsule' ? edgeColor : 'none');
    return {
      fill,
      stroke,
      strokeWidth: border['stroke-width'] || 1,
      rx: border.shape === 'capsule' ? h / 2 : 6,
      fontSize: depth === 0 ? 16 : 13,
      fontWeight: depth === 0 ? 'bold' : 'normal',
      color: node.defaultContentStyle?.color || '#333',
    };
  }

  function drawCapsule(box, edgeColor) {
    const style = styleFor(box.node, box.depth, edgeColor);
    const text = stripMindmapText(box.node.html);
    svg += `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${style.rx}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"/>`;
    svg += `<text x="${box.centerX}" y="${box.centerY + style.fontSize * 0.35}" text-anchor="middle" font-size="${style.fontSize}" font-weight="${style.fontWeight}" fill="${style.color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`;
  }

  drawCapsule(rootBox, root.border?.stroke || '#C2CDF0');
  for (const branch of branchBoxes) {
    const color = branch.box.node.treeEdge?.stroke || '#BFBFBF';
    const strokeWidth = branch.box.node.treeEdge?.['stroke-width'] || 1;
    const rootBottomY = rootBox.y + rootBox.height;
    // Standard vertical mindmaps fan out from the root with soft branches.
    svg += `<path d="M${rootBox.centerX},${rootBottomY} C${rootBox.centerX},${rootBottomY + 28} ${branch.box.centerX},${branch.box.y - 44} ${branch.box.centerX},${branch.box.y}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    drawCapsule(branch.box, color);

    if (branch.children.length) {
      const stemX = branch.box.centerX;
      const stemTop = branch.box.y + branch.box.height;
      const stemBottom = branch.children[branch.children.length - 1].centerY;
      svg += `<path d="M${stemX},${stemTop} V${stemBottom}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
      for (const child of branch.children) {
        svg += `<path d="M${stemX},${child.centerY} C${stemX},${child.centerY} ${child.x - 18},${child.centerY} ${child.x},${child.centerY}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
        drawCapsule(child, color);
      }
    }
  }

  return svg;
}

function renderMindmap(el) {
  if (isStandardRightMindmap(el)) return renderStandardRightMindmap(el);
  if (isTimelineListMindmap(el)) return renderTimelineListMindmap(el);
  if (isVerticalMindmap(el)) return renderVerticalMindmap(el);

  const rootX = el.x || 0;
  const rootY = el.y || 0;
  const nodeH = 30;
  const nodeGapY = 10;
  const levelGapX = 180;

  let svg = '';

  function countLeaves(node) {
    if (!node.children || !node.children.length) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  function layoutBranch(node, depth, yCenter, direction, edgeColor) {
    const text = stripMindmapText(node.html);
    const w = mindmapNodeWidth(node, depth);
    const dir = direction; // 1 = right, -1 = left
    const x = dir === 1 ? rootX + depth * levelGapX : rootX - depth * levelGapX - w;
    const y = yCenter - nodeH / 2;

    const fill = node.border?.fill || (depth === 0 ? '#e6f4ff' : '#fafafa');
    const stroke = node.border?.stroke || 'transparent';
    const rx = node.border?.shape === 'capsule' ? nodeH / 2 : 6;
    const color = node.treeEdge?.stroke || edgeColor || '#bfbfbf';

    svg += `<rect x="${x}" y="${y}" width="${w}" height="${nodeH}" rx="${rx}" fill="${fill}" stroke="${stroke === 'transparent' ? 'none' : stroke}"/>`;
    svg += `<text x="${x + w / 2}" y="${yCenter + 5}" text-anchor="middle" font-size="13" fill="#333" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`;

    if (node.children && node.children.length) {
      const leaves = node.children.map(c => countLeaves(c));
      const totalLeaves = leaves.reduce((a, b) => a + b, 0);
      const totalH = totalLeaves * (nodeH + nodeGapY) - nodeGapY;
      let cy = yCenter - totalH / 2 + (leaves[0] * (nodeH + nodeGapY) - nodeGapY) / 2;

      const parentEdge = dir === 1 ? x + w : x;

      node.children.forEach((child, i) => {
        const childLeafH = leaves[i] * (nodeH + nodeGapY) - nodeGapY;
        const childW = mindmapNodeWidth(child, depth + 1);
        const childX = dir === 1 ? rootX + (depth + 1) * levelGapX : rootX - (depth + 1) * levelGapX - childW;
        const childEdge = dir === 1 ? childX : childX + childW;
        const midX = parentEdge + (childEdge - parentEdge) / 2;

        svg += `<path d="M${parentEdge},${yCenter} C${midX},${yCenter} ${midX},${cy} ${childEdge},${cy}" fill="none" stroke="${color}" stroke-width="2"/>`;
        layoutBranch(child, depth + 1, cy, direction, color);

        if (i < node.children.length - 1) {
          cy += (leaves[i] + leaves[i + 1]) * (nodeH + nodeGapY) / 2;
        }
      });
    }
  }

  // Separate children into left (quadrant 2) and right (quadrant 1)
  const rightChildren = (el.children || []).filter(c => (c.layout?.quadrant || 1) === 1);
  const leftChildren = (el.children || []).filter(c => c.layout?.quadrant === 2);

  // Draw root node
  const rootText = stripMindmapText(el.html);
  const rootW = mindmapNodeWidth(el, 0);
  const rootH = 36;
  const rx = el.border?.shape === 'capsule' ? rootH / 2 : 8;
  const rootFill = el.border?.fill || '#F5F5F5';
  svg += `<rect x="${rootX - rootW / 2}" y="${rootY - rootH / 2}" width="${rootW}" height="${rootH}" rx="${rx}" fill="${rootFill}" stroke="none"/>`;
  svg += `<text x="${rootX}" y="${rootY + 6}" text-anchor="middle" font-size="16" font-weight="bold" fill="#333" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(rootText)}</text>`;

  // Layout right branches
  if (rightChildren.length) {
    const rightLeaves = rightChildren.map(c => countLeaves(c));
    const totalR = rightLeaves.reduce((a, b) => a + b, 0);
    const totalRH = totalR * (nodeH + nodeGapY) - nodeGapY;
    let cy = rootY - totalRH / 2 + (rightLeaves[0] * (nodeH + nodeGapY) - nodeGapY) / 2;

    rightChildren.forEach((child, i) => {
      const color = child.treeEdge?.stroke || '#bfbfbf';
      const childX = rootX + rootW / 2 + levelGapX;
      const midX = rootX + rootW / 2 + (childX - rootX - rootW / 2) / 2;
      svg += `<path d="M${rootX + rootW / 2},${rootY} C${midX},${rootY} ${midX},${cy} ${childX},${cy}" fill="none" stroke="${color}" stroke-width="2"/>`;
      layoutBranch(child, 1, cy, 1, color);
      if (i < rightChildren.length - 1) cy += (rightLeaves[i] + rightLeaves[i + 1]) * (nodeH + nodeGapY) / 2;
    });
  }

  // Layout left branches
  if (leftChildren.length) {
    const leftLeaves = leftChildren.map(c => countLeaves(c));
    const totalL = leftLeaves.reduce((a, b) => a + b, 0);
    const totalLH = totalL * (nodeH + nodeGapY) - nodeGapY;
    let cy = rootY - totalLH / 2 + (leftLeaves[0] * (nodeH + nodeGapY) - nodeGapY) / 2;

    leftChildren.forEach((child, i) => {
      const color = child.treeEdge?.stroke || '#bfbfbf';
      const childW = mindmapNodeWidth(child, 1);
      const childX = rootX - rootW / 2 - levelGapX - childW;
      const childEdge = childX + childW;
      const midX = rootX - rootW / 2 + (childEdge - rootX + rootW / 2) / 2;
      svg += `<path d="M${rootX - rootW / 2},${rootY} C${midX},${rootY} ${midX},${cy} ${childEdge},${cy}" fill="none" stroke="${color}" stroke-width="2"/>`;
      layoutBranch(child, 1, cy, -1, color);
      if (i < leftChildren.length - 1) cy += (leftLeaves[i] + leftLeaves[i + 1]) * (nodeH + nodeGapY) / 2;
    });
  }

  return svg;
}

function renderTimelineListMindmap(el) {
  const anchorX = el.x || 0;
  const startY = (el.y || 0) + 44;
  const children = el.children || [];
  const gapY = 48;
  let svg = '';

  children.forEach((child, index) => {
    const y = startY + 34 + index * gapY;
    const color = child.treeEdge?.stroke || '#BFBFBF';
    const text = stripMindmapText(child.html);
    // Empty-root indent mindmaps are used by Yuque timeline templates as
    // hanging item lists. Render them as a vertical stem with curved hooks,
    // not as normal right-growing mindmap nodes.
    const fromY = index === 0 ? startY : y - gapY + 14;
    svg += `<path d="M${anchorX},${fromY} V${y - 16} C${anchorX},${y - 6} ${anchorX + 8},${y} ${anchorX + 22},${y}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    svg += `<text x="${anchorX + 34}" y="${y + 5}" font-size="16" font-weight="600" fill="${child.defaultContentStyle?.color || '#595959'}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escapeXml(text)}</text>`;
  });

  return svg;
}

// ── Group ──

function renderGroup(el, index, imageCache, renderIndex = 0) {
  if (!el.children) return '';
  const children = el.children.map((c, childIndex) => renderElement(c, index, imageCache, `${renderIndex}-g-${childIndex}`)).join('\n');
  return `<g>${children}</g>`;
}

// ── Swimlane ──

function renderSwimlane(el, index, imageCache, renderIndex = 0) {
  const { x, y, widths, heights, stroke, children } = el;
  const { width: w, height: h } = resolveElementSize(el);
  const sc = stroke?.color || '#D9D9D9';
  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${sc}" stroke-width="1"/>`;

  const colBounds = [0, ...(widths || []), 1];
  const rowBounds = [0, ...(heights || []), 1];

  // Yuque vertical swimlanes store column split ratios in `widths` and the
  // header-row split in `heights`. Render the lane titles across the top row.
  if (heights) {
    for (const ratio of heights) {
      const ly = y + h * ratio;
      svg += `<line x1="${x}" y1="${ly}" x2="${x + w}" y2="${ly}" stroke="${sc}" stroke-width="1"/>`;
    }
  }

  if (widths) {
    for (const ratio of widths) {
      const lx = x + w * ratio;
      svg += `<line x1="${lx}" y1="${y}" x2="${lx}" y2="${y + h}" stroke="${sc}" stroke-width="1"/>`;
    }
  }

  if (children) {
    for (const child of children) {
      const nth = child.nth || 0;
      const cellLeftRatio = colBounds[nth] ?? 0;
      const cellRightRatio = colBounds[nth + 1] ?? 1;
      const cellLeft = x + w * cellLeftRatio;
      const cellWidth = w * (cellRightRatio - cellLeftRatio);
      const cellTop = y;
      const cellHeight = h * (rowBounds[1] ?? 0.12);
      const fc = child.fill?.color || '#F5F5F5';

      svg += `<rect x="${cellLeft}" y="${cellTop}" width="${cellWidth}" height="${cellHeight}" fill="${fc}" stroke="none"/>`;
      if (child.html) {
        svg += renderTextBlock(cellLeft, cellTop, cellWidth, cellHeight, child.html);
      }
    }
  }

  // contain is an array of ID strings — those elements are already rendered at top level

  const contained = (el.contain || [])
    .filter(item => item && typeof item === 'object')
    .map((item, childIndex) => renderElement(item, index, imageCache, `${renderIndex}-s-${childIndex}`))
    .join('\n');

  return svg + contained;
}
