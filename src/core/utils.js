export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_PATH_COMPONENT_LENGTH = 120;

export function sanitizePathComponent(name) {
  if (!name || typeof name !== 'string') return '';

  let result = name.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/<>:"|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '');

  if (!result) return '';

  if (WINDOWS_RESERVED_NAMES.test(result)) {
    result = `_${result}`;
  }

  if (result.length > MAX_PATH_COMPONENT_LENGTH) {
    result = result.slice(0, MAX_PATH_COMPONENT_LENGTH).replace(/[. ]+$/g, '');
  }

  return result;
}

export function sanitizePathSegments(pathString = '') {
  if (!pathString) return [];
  return pathString
    .split(/[\\/]+/)
    .map(segment => sanitizePathComponent(segment))
    .filter(Boolean);
}

export function formatDate(date) {
  const d = date || new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function guessImageExt(url) {
  if (!url) return 'png';
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  if (match) {
    const ext = match[1].toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      return ext;
    }
  }
  return 'png';
}

export function escapeXml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
