/**
 * SVG-safe text helpers for Yuque board rendering.
 *
 * Yuque board text is stored as small HTML snippets. The board renderer keeps
 * those snippets out of foreignObject and converts them to SVG <text> nodes for
 * broad Markdown/preview compatibility.
 */

const LOOSE_TEXT_BOLD_WIDTH_FACTOR = 1.08;

export function estimateTextBlockHeight(html, width) {
  const lines = parseHtmlToLines(html);
  if (!lines.length) return 0;
  const defaultFontSize = readableFontSize(lines[0].style?.fontSize || 14);
  const lineHeight = defaultFontSize * 1.4;
  const paddingX = Math.min(10, Math.max(width * 0.05, 4));
  const maxTextWidth = Math.max(width - paddingX * 2, 12);
  const wrapped = lines.flatMap(line => wrapTextLine(
    line,
    maxTextWidth,
    readableFontSize(line.style?.fontSize || defaultFontSize),
  ));
  const textHeight = wrapped.reduce((sum, line) => (
    sum + textLineHeight(readableFontSize(line.style?.fontSize || defaultFontSize))
  ), 0);

  // This mirrors renderTextBlock's padding/line-height model so measurement,
  // SVG viewport, and connector endpoint math agree on text boxes.
  return Math.max(lineHeight + 8, textHeight + 8);
}

export function estimateLooseTextSize(html, width) {
  const lines = parseHtmlToLines(html);
  if (!lines.length) return { width: Number.isFinite(width) ? width : 0, height: 0 };
  if (Number.isFinite(width) && width > 0) {
    return { width, height: estimateTextBlockHeight(html, width) };
  }

  const defaultFontSize = readableFontSize(lines[0].style?.fontSize || 14);
  const lineWidths = lines.map(line => {
    const fs = readableFontSize(line.style?.fontSize || defaultFontSize);
    const weightFactor = line.style?.bold ? LOOSE_TEXT_BOLD_WIDTH_FACTOR : 1;
    return Array.from(line.text).reduce((sum, char) => sum + estimateCharWidth(char, fs), 0) * weightFactor;
  });
  const lineHeight = defaultFontSize * 1.4;
  return {
    width: Math.max(...lineWidths, 0),
    height: lines.length * lineHeight
  };
}

export function renderTextBlock(x, y, w, h, html, options = {}) {
  const lines = parseHtmlToLines(html);
  if (!lines.length) return '';

  const defaultStyle = lines[0].style || {};
  const fontSize = readableFontSize(defaultStyle.fontSize || 14);
  const align = defaultStyle.align || options.defaultAlign || 'center';
  const paddingX = Math.min(10, Math.max(w * 0.05, 4));
  const paddingY = Math.min(10, Math.max(h * 0.08, 4));
  const maxTextWidth = Math.max(w - paddingX * 2, 12);
  let visualLines = lines.flatMap(line => {
    const lineStyle = { ...(line.style || {}) };
    if (!lineStyle.align) lineStyle.align = align;
    return wrapTextLine(
      { ...line, style: lineStyle },
      maxTextWidth,
      readableFontSize(lineStyle.fontSize || fontSize),
      { preserveWords: options.preserveWords },
    );
  });

  if (options.fit) {
    const availableH = Math.max(h - paddingY * 2, fontSize);
    let usedH = 0;
    let maxLines = 0;
    for (const line of visualLines) {
      const fs = readableFontSize(line.style?.fontSize || fontSize);
      const nextH = textLineHeight(fs);
      if (maxLines > 0 && usedH + nextH > availableH) break;
      usedH += nextH;
      maxLines += 1;
    }
    maxLines = Math.max(1, maxLines);
    if (visualLines.length > maxLines) {
      visualLines = visualLines.slice(0, maxLines);
      const last = visualLines[visualLines.length - 1];
      visualLines[visualLines.length - 1] = {
        ...last,
        text: fitTextWithEllipsis(last.text, maxTextWidth, readableFontSize(last.style?.fontSize || fontSize)),
      };
    }
  }

  const lineMetrics = visualLines.map(line => {
    const fs = readableFontSize(line.style?.fontSize || fontSize);
    return { fontSize: fs, lineHeight: textLineHeight(fs) };
  });
  const totalTextH = lineMetrics.reduce((sum, metric) => sum + metric.lineHeight, 0);

  // Yuque card labels with explicit left/right alignment are usually headers
  // pinned near the top edge. Centered labels stay vertically centered.
  const vertical = options.vertical || (align === 'center' ? 'center' : 'top');
  let cursorY = vertical === 'center'
    ? y + (h - totalTextH) / 2
    : y + paddingY;

  let svg = '';
  for (let i = 0; i < visualLines.length; i += 1) {
    const line = visualLines[i];
    const metric = lineMetrics[i];
    const ly = cursorY + metric.fontSize;
    cursorY += metric.lineHeight;
    const lineAlign = line.style?.align || align;
    const tx = lineAlign === 'left' ? x + paddingX : lineAlign === 'right' ? x + w - paddingX : x + w / 2;
    const anchor = lineAlign === 'left' ? 'start' : lineAlign === 'right' ? 'end' : 'middle';
    const fw = line.style?.bold ? 'bold' : 'normal';
    const fc = line.style?.color || '#333';
    const fs = readableFontSize(line.style?.fontSize || fontSize);
    const escaped = escapeXml(line.text);
    svg += `<text x="${tx}" y="${ly}" text-anchor="${anchor}" font-size="${fs}" font-weight="${fw}" fill="${fc}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${escaped}</text>`;
  }
  return svg;
}

function textLineHeight(fontSize) {
  return fontSize * 1.25;
}

export function readableFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return 14;
  // Some Lakeboard templates encode tiny placeholder font sizes while relying
  // on the editor's text box scaling. In raw SVG that makes labels disappear.
  return size > 0 && size < 8 ? 12 : size;
}

function wrapTextLine(line, maxWidth, fontSize, options = {}) {
  if (!line?.text) return [];
  if (options.preserveWords) {
    const measured = Array.from(line.text).reduce((sum, char) => sum + estimateCharWidth(char, fontSize), 0);
    if (measured <= maxWidth * 1.18) return [line];
  }

  const chunks = [];
  let current = '';
  let width = 0;

  for (const char of Array.from(line.text)) {
    const charWidth = estimateCharWidth(char, fontSize);
    if (current && width + charWidth > maxWidth) {
      chunks.push({ text: current, style: line.style });
      current = char;
      width = charWidth;
    } else {
      current += char;
      width += charWidth;
    }
  }
  if (current) chunks.push({ text: current, style: line.style });
  return chunks.length ? chunks : [line];
}

export function estimateCharWidth(char, fontSize) {
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) return fontSize;
  if (/\s/.test(char)) return fontSize * 0.35;
  return fontSize * 0.52;
}

function fitTextWithEllipsis(text, maxWidth, fontSize) {
  const ellipsis = '...';
  const ellipsisWidth = Array.from(ellipsis).reduce((sum, char) => sum + estimateCharWidth(char, fontSize), 0);
  let width = 0;
  let result = '';
  for (const char of Array.from(text)) {
    const nextWidth = estimateCharWidth(char, fontSize);
    if (result && width + nextWidth + ellipsisWidth > maxWidth) return `${result}${ellipsis}`;
    result += char;
    width += nextWidth;
  }
  return result;
}

/**
 * Parse simple Lake HTML to array of { text, style } lines.
 * Handles <div>, <span style="...">, <br>, and nested divs.
 */
export function parseHtmlToLines(html) {
  if (!html) return [];

  const lines = [];
  const defaultAlign = extractTextAlign(html);
  // Yuque often serializes multiline text as either sibling divs or as text
  // followed by a nested `<div>`. Normalize every div/br boundary to a line
  // break so method lists and UML compartments do not collapse into one line.
  const parts = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>\s*<div[^>]*>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .split(/\n+/);

  for (const part of parts) {
    const text = stripHtml(part).trim();
    if (!text) continue;

    const style = { align: extractTextAlign(part) || defaultAlign };
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

function extractTextAlign(html = '') {
  const match = String(html).match(/text-align\s*:\s*(left|center|right)/i);
  return match ? match[1].toLowerCase() : '';
}

export function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8203;/g, '')
    .replace(/&#x200B;/g, '')
    .replace(/&#\d+;/g, '')
    .replace(/\u200B/g, '');
}

export function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sanitizeSvgId(value) {
  return String(value || 'x')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}
