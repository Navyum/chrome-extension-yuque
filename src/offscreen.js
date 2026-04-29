/**
 * Offscreen document: SVG → PNG/JPG via Canvas.
 * Receives SVG string via chrome.runtime message, returns base64 data URL.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'svgToImage') return false;
  convertSvgToImage(msg.data).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

async function convertSvgToImage({ svg, width, height, format }) {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpg' ? 0.92 : undefined;
  const scale = 2; // 2x for retina quality

  const canvas = document.getElementById('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // SVG → Blob → Image → Canvas
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.width = width;
    img.height = height;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG image load failed'));
      img.src = url;
    });

    // White background for JPG
    if (format === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(mime, quality);
    return { dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}
