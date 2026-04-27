// --- DOT GRID PHYSICS ANIMATION ---
const canvas = document.getElementById('dotCanvas');
const ctx = canvas.getContext('2d');
let width, height, dots = [];
const gap = 32;
const mouse = { x: -1000, y: -1000 };

function initDots() {
    if (!canvas) return;
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    dots = [];
    for (let x = 0; x < width; x += gap) {
        for (let y = 0; y < height; y += gap) {
            dots.push({
                x, y,
                originX: x,
                originY: y,
                vx: 0,
                vy: 0,
                size: 1.5,
                opacity: 0.15 + Math.random() * 0.1
            });
        }
    }
}

function animate() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    
    dots.forEach(dot => {
        const dx = mouse.x - dot.x;
        const dy = mouse.y - dot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const proximity = 220;

        if (dist < proximity) {
            const angle = Math.atan2(dy, dx);
            const force = (proximity - dist) / proximity;
            // Stronger, smoother repulsion
            dot.vx -= Math.cos(angle) * force * 1.8;
            dot.vy -= Math.sin(angle) * force * 1.8;
            dot.opacity = Math.min(0.9, dot.opacity + 0.1);
        }

        // Elastic return force
        const rx = (dot.originX - dot.x) * 0.12;
        const ry = (dot.originY - dot.y) * 0.12;
        dot.vx += rx;
        dot.vy += ry;
        
        // Friction
        dot.vx *= 0.88;
        dot.vy *= 0.88;

        dot.x += dot.vx;
        dot.y += dot.vy;
        
        // Fade back to base opacity
        dot.opacity += (0.15 - dot.opacity) * 0.05;

        ctx.fillStyle = `rgba(255, 255, 255, ${dot.opacity})`;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
        ctx.fill();
    });
    requestAnimationFrame(animate);
}

window.addEventListener('resize', initDots);
window.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
});

// --- BENTO CARD GLOW EFFECT ---
function initBentoGlow() {
    document.querySelectorAll('.magic-bento-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty('--glow-x', `${x}px`);
            card.style.setProperty('--glow-y', `${y}px`);
        });
    });
}

// --- BUTTON GLOW EFFECT ---
function initButtonGlow() {
    const buttonSelectors = [
        '.nav-cta-button',
        '.hero-primary-button',
        '.hero-secondary-button',
        '.cta-button',
        '.update-notification-bento-button',
        '.update-notification-bento-close'
    ];
    
    buttonSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(button => {
            button.addEventListener('mousemove', e => {
                const rect = button.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                button.style.setProperty('--glow-x', `${x}px`);
                button.style.setProperty('--glow-y', `${y}px`);
            });
        });
    });
}

// --- AUTHENTIC CARD SWAP LOGIC ---
const cardData = [
    { 
        title: '批量导出', 
        img: './images/feat1.png', 
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' 
    },
    { 
        title: '目录保留', 
        img: './images/feat2.png', 
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>' 
    },
    { 
        title: '图片本地化', 
        img: './images/feat3.png', 
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>' 
    },
    { 
        title: '隐私安全', 
        img: './images/feat4.png', 
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>' 
    }
];

const cardStack = document.getElementById('cardStack');
let currentIdx = 0;
let isTransitioning = false;
let cardElements = [];
const UPDATE_BENTO_KEY = 'yuque_export_update_bento_v2025_01';

function initCards() {
    if (!cardStack) return;
    cardStack.innerHTML = '';
    cardElements = [];
    
    cardData.forEach((data, i) => {
        const card = document.createElement('div');
        card.className = 'CardSwap_card__HvzWu';
        card.dataset.id = i;
        card.innerHTML = `
            <div class="CardSwap_windowHeader__pAaBr">
                <div class="CardSwap_windowIcon__mOIYe">${data.icon}</div>
                <div class="CardSwap_windowTitle__Q1Asa"><span>${data.title}</span></div>
            </div>
            <div class="CardSwap_cardContent__OWUTy">
                <div class="CardSwap_cardImage__HhGOd">
                    <img src="${data.img}" alt="${data.title}" draggable="false">
                </div>
            </div>
        `;
        cardStack.appendChild(card);
        cardElements.push(card);
    });
    renderCards();
}

function renderCards() {
    const isMobile = window.innerWidth <= 640;
    const isTablet = window.innerWidth <= 1024 && window.innerWidth > 640;

    cardElements.forEach((card, i) => {
        // Calculate logical offset
        const offset = (i - currentIdx + cardData.length) % cardData.length;
        
        // 为堆叠卡片添加交错延迟，营造“被推”的波动感
        const staggerDelay = isTransitioning ? (offset * 80) : 0;
        card.style.transitionDelay = `${staggerDelay}ms`;

        // Base styles for stacked cards
        let zIndex = 20 - offset;
        let opacity = 0.95; // Fully opaque
        
        let xOffsetMultiplier = isMobile ? 20 : isTablet ? 40 : 60;
        let yOffsetMultiplier = isMobile ? -30 : isTablet ? -50 : -70;
        let zOffsetMultiplier = isMobile ? -80 : isTablet ? -120 : -150;

        let x = offset * xOffsetMultiplier;
        let y = offset * yOffsetMultiplier;
        let z = offset * zOffsetMultiplier;
        let skewY = 6;
        let filter = 'none'; // No blur
        let visibility = offset > 4 ? 'hidden' : 'visible';

        // Set z-index always, but skip other styles if it's currently in an explicit CSS animation phase
        // to avoid conflicting with keyframes.
        card.style.zIndex = zIndex;
        
        if (card.classList.contains('dropping') || card.classList.contains('slide-back')) {
            return;
        }

        card.style.opacity = opacity;
        card.style.visibility = visibility;
        card.style.filter = filter;
        card.style.transform = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), ${z}px) skewY(${skewY}deg)`;
    });
}

function cycleCards() {
    if (isTransitioning) return;
    
    // Find the current top card by its data-id
    const topCard = cardElements.find(c => c.dataset.id === currentIdx.toString());

    if (topCard) {
        isTransitioning = true;
        
        // Phase 1: Card drops down (Visual focus)
        topCard.classList.add('dropping');
        
        // Phase 2: Midway through drop, switch to slide-back
        setTimeout(() => {
            topCard.classList.remove('dropping');
            topCard.classList.add('slide-back');

            // Phase 2.5: 额外延迟，等待绕后卡片“钻入”深层后再触发前移
            setTimeout(() => {
                currentIdx = (currentIdx + 1) % cardData.length;
                renderCards();
            }, 400); 
        }, 800); 

        // Phase 3: Cleanup and reset
        setTimeout(() => {
            // Before removing the animation class, temporarily disable transitions
            // to prevent the browser from trying to transition between the 
            // animation end-state and the JS-applied state.
            topCard.style.transition = 'none';
            topCard.classList.remove('slide-back');
            isTransitioning = false;
            
            // Sync final state
            renderCards();
            
            // Re-enable transitions after a tiny delay
            requestAnimationFrame(() => {
                topCard.style.transition = '';
            });
        }, 2400); 
    }
}

function initUpdateNotificationBento() {
    const container = document.getElementById('updateNotificationBento');
    if (!container) return;

    try {
        if (localStorage.getItem(UPDATE_BENTO_KEY) === '1') {
            return;
        }
    } catch (e) {}

    const closeBtn = document.getElementById('updateNotificationClose');
    const hideCheckbox = document.getElementById('updateNotificationHide');
    const gotItBtn = document.getElementById('updateNotificationGotIt');

    const dismiss = (e) => {
        e.stopPropagation();
        if (hideCheckbox && hideCheckbox.checked) {
            try { localStorage.setItem(UPDATE_BENTO_KEY, '1'); } catch (e) {}
        }
        container.classList.remove('show');
        setTimeout(() => container.hidden = true, 600);
    };

    const minimize = () => {
        if (!container.classList.contains('show')) return;
        container.classList.add('minimized');
    };

    const expand = () => {
        container.classList.remove('minimized');
    };

    closeBtn?.addEventListener('click', dismiss);
    gotItBtn?.addEventListener('click', dismiss);
    container.addEventListener('click', (e) => {
        if (container.classList.contains('minimized')) {
            expand();
        }
    });

    // 1. 5s 后渐变出现
    setTimeout(() => {
        container.hidden = false;
        // 强制重绘以触发 transition
        container.offsetHeight; 
        container.classList.add('show');

        // 2. 出现 5s 后自动收起
        setTimeout(minimize, 5000);
    }, 5000);
}

// Initialize after DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    initDots();
    animate();
    initBentoGlow();
    initButtonGlow();
    initCards(); // Use initCards for efficient management
    setInterval(cycleCards, 5000);
    initUpdateNotificationBento();
});

