/**
 * Content Script: Floating bubble for quick single-doc export.
 * Injected into yuque.com doc pages. Uses Shadow DOM for style isolation.
 */

(async () => {
  if (!isDocPage()) return;
  const { showBubble } = await chrome.storage.local.get('showBubble');
  if (showBubble === false) return;

  const BUBBLE_SIZE = 46;
  const EDGE_MARGIN = 16;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let startPos = { x: 0, y: 0 };
  let hasMoved = false;
  const DRAG_THRESHOLD = 5; // px — ignore tiny movements as drag

  // ── Create bubble (Shadow DOM) ──

  const host = document.createElement('div');
  host.id = 'yuqueout-bubble-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bubble {
        position: fixed;
        right: ${EDGE_MARGIN}px;
        top: 50%;
        margin-top: -${BUBBLE_SIZE / 2}px;
        width: ${BUBBLE_SIZE}px;
        height: ${BUBBLE_SIZE}px;
        border-radius: 50%;
        background: transparent;
        cursor: grab;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: filter 0.2s, opacity 0.2s;
        user-select: none;
        -webkit-user-select: none;
        opacity: 0.7;
        filter: drop-shadow(0 2px 8px rgba(0,0,0,0.15));
      }
      .bubble:hover { opacity: 1; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.25)); }
      .bubble:active { cursor: grabbing; }
      .bubble.is-dragging { transition: none; opacity: 1; cursor: grabbing; }
      .bubble.is-exporting { pointer-events: none; }
      .bubble.is-exporting .icon { animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:1;transform:scale(1.12)} }
      .icon { width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; pointer-events: none; border-radius: 50%; }
      .spinner { position: absolute; width: ${BUBBLE_SIZE + 6}px; height: ${BUBBLE_SIZE + 6}px; border: 3px solid transparent; border-top-color: #3b82f6; border-radius: 50%; animation: spin .8s linear infinite; display: none; }
      .bubble.is-exporting .spinner { display: block; }
      .overlay { position: absolute; width: ${BUBBLE_SIZE}px; height: ${BUBBLE_SIZE}px; border-radius: 50%; display: none; align-items: center; justify-content: center; }
      .bubble.is-success .overlay { display: flex; background: rgba(16,185,129,0.9); }
      .bubble.is-success .icon { opacity: 0.3; }
      .bubble.is-error .overlay { display: flex; background: rgba(239,68,68,0.9); }
      .bubble.is-error .icon { opacity: 0.3; }
      .overlay svg { width: 24px; height: 24px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .tooltip { position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.8); color: #fff; font-size: 12px; padding: 5px 10px; border-radius: 6px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .15s; font-family: -apple-system,BlinkMacSystemFont,sans-serif; }
      .bubble:hover .tooltip { opacity: 1; }
      .bubble.is-dragging .tooltip { opacity: 0; }
    </style>
    <div class="bubble" id="bubble">
      <img class="icon" src="${chrome.runtime.getURL('icons/icon-round.png')}" alt="YuqueOut">
      <div class="spinner"></div>
      <div class="overlay">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="tooltip">${chrome.i18n.getMessage('bubbleTooltip') || 'Click to export'}</div>
    </div>
  `;

  document.body.appendChild(host);
  const bubble = shadow.getElementById('bubble');

  // ── Drag ──

  bubble.addEventListener('pointerdown', (e) => {
    isDragging = true;
    hasMoved = false;
    startPos.x = e.clientX;
    startPos.y = e.clientY;
    dragOffset.x = e.clientX - bubble.getBoundingClientRect().left;
    dragOffset.y = e.clientY - bubble.getBoundingClientRect().top;
    bubble.classList.add('is-dragging');
    bubble.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  bubble.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startPos.x;
    const dy = e.clientY - startPos.y;
    if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    hasMoved = true;
    const x = e.clientX - dragOffset.x;
    const y = e.clientY - dragOffset.y;
    const maxX = window.innerWidth - BUBBLE_SIZE;
    const maxY = window.innerHeight - BUBBLE_SIZE;
    bubble.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
    bubble.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    bubble.style.right = 'auto';
    bubble.style.marginTop = '0';
  });

  bubble.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    bubble.classList.remove('is-dragging');
    bubble.releasePointerCapture(e.pointerId);

    // Snap to nearest edge
    const rect = bubble.getBoundingClientRect();
    const centerX = rect.left + BUBBLE_SIZE / 2;
    if (centerX < window.innerWidth / 2) {
      bubble.style.left = EDGE_MARGIN + 'px';
      bubble.style.right = 'auto';
    } else {
      bubble.style.left = 'auto';
      bubble.style.right = EDGE_MARGIN + 'px';
    }

    if (!hasMoved) handleExport();
  });

  // ── Export ──

  async function handleExport() {
    if (bubble.classList.contains('is-exporting')) return;
    bubble.classList.remove('is-success', 'is-error');
    bubble.classList.add('is-exporting');

    try {
      // Extract doc info from page runtime via injected script
      const docInfo = await getDocInfoFromPage();
      if (!docInfo?.slug) throw new Error('无法识别当前文档');

      const response = await chrome.runtime.sendMessage({
        action: 'quickExport',
        data: docInfo
      });

      if (response?.success) {
        bubble.classList.remove('is-exporting');
        bubble.classList.add('is-success');
        setTimeout(() => bubble.classList.remove('is-success'), 2000);
      } else {
        throw new Error(response?.error || '导出失败');
      }
    } catch (err) {
      bubble.classList.remove('is-exporting');
      bubble.classList.add('is-error');
      console.error('[YuqueOut]', err.message);
      setTimeout(() => bubble.classList.remove('is-error'), 2000);
    }
  }

  // ── Read doc data via background's chrome.scripting.executeScript (MAIN world) ──

  async function getDocInfoFromPage() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getPageDocInfo' });
      return response?.data || null;
    } catch {
      return null;
    }
  }

  // ── Page detection ──

  function isDocPage() {
    const path = location.pathname;
    if (/^\/(dashboard|settings|explore|notifications|search|login|register|account|new)/i.test(path)) return false;
    if (/^\/(api|r)\//i.test(path)) return false;
    const segments = path.split('/').filter(Boolean);
    return segments.length >= 3;
  }
})();
