import { domRefs } from './dom.js';
import { toggleSponsorModal } from './ui.js';

const MAX_HOVER_SHOWS_PER_DAY = 3;
let hoverTimeout = null;

export function initSponsorInteractions() {
  const { sponsorBtn, sponsorModal, sponsorModalClose } = domRefs;

  // Click always works
  if (sponsorBtn) {
    sponsorBtn.addEventListener('click', () => toggleSponsorModal(true));

    // Hover: show only if under daily limit
    sponsorBtn.addEventListener('mouseenter', handleSponsorHoverEnter);
    sponsorBtn.addEventListener('mouseleave', handleSponsorHoverLeave);
  }

  if (sponsorModal) {
    sponsorModal.addEventListener('click', event => {
      if (event.target === sponsorModal) toggleSponsorModal(false);
    });
    sponsorModal.addEventListener('mouseenter', clearHoverTimeout);
    sponsorModal.addEventListener('mouseleave', handleSponsorHoverLeave);
  }

  if (sponsorModalClose) {
    sponsorModalClose.addEventListener('click', () => toggleSponsorModal(false));
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sponsorModal?.classList.contains('is-visible')) {
      toggleSponsorModal(false);
    }
  });
}

function handleSponsorHoverEnter() {
  clearHoverTimeout();
  if (!canShowHoverToday()) return;
  hoverTimeout = setTimeout(() => {
    if (!canShowHoverToday()) return;
    incrementHoverCount();
    toggleSponsorModal(true);
  }, 400); // Small delay to avoid accidental triggers
}

function handleSponsorHoverLeave() {
  clearHoverTimeout();
  hoverTimeout = setTimeout(() => {
    toggleSponsorModal(false);
  }, 300);
}

function clearHoverTimeout() {
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
}

// ── Daily hover count tracking ──

function getTodayKey() {
  const d = new Date();
  return `sponsor_hover_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function getHoverCountToday() {
  try {
    const key = getTodayKey();
    const val = localStorage.getItem(key);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

function canShowHoverToday() {
  return getHoverCountToday() < MAX_HOVER_SHOWS_PER_DAY;
}

function incrementHoverCount() {
  try {
    const key = getTodayKey();
    const current = getHoverCountToday();
    localStorage.setItem(key, String(current + 1));

    // Clean up old keys (keep only today)
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sponsor_hover_') && k !== key) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // localStorage not available
  }
}
