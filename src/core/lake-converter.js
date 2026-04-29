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
    case 'flowchart2':
    case 'board': {
      const src = data.url || data.src || '';
      if (src) return `![图表](${src})`;
      const code = data.code || '';
      if (code) return `\n\`\`\`\n${code}\n\`\`\`\n`;
      return '';
    }

    case 'table': {
      const html = data.html || '';
      return html ? `\n${html}\n` : '';
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
      if (data.text) return data.text;
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
  const url = `https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&merge_dynamic_data=false`;
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
