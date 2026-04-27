export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sanitizePathComponent(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\\/<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
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
