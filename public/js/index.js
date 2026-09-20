// Check if user is already authenticated
window.addEventListener('load', () => {
    const authToken = localStorage.getItem('authToken');
    const clientId = localStorage.getItem('clientId');
    
    if (authToken && clientId) {
        // Hide Get Started button and show Dashboard button in hero.
        // inline-flex, not block: .btn centres its label with flexbox, and an
        // inline `display: block` here would beat that and push the text to the
        // top of the button.
        document.getElementById('heroGetStartedBtn').style.display = 'none';
        document.getElementById('heroDashboardBtn').style.display = 'inline-flex';
    }
    
    // Handle Hero Get Started button
    const heroGetStartedBtn = document.getElementById('heroGetStartedBtn');
    if (heroGetStartedBtn) {
        heroGetStartedBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const authToken = localStorage.getItem('authToken');
            const clientId = localStorage.getItem('clientId');
            
            if (authToken && clientId) {
                // User is logged in, redirect to dashboard
                window.location.href = '/dashboard';
            } else {
                // User is not logged in, redirect to auth
                window.location.href = '/auth';
            }
        });
    }
    
    // Handle CTA Start Withdrawing button
    const ctaStartBtn = document.getElementById('ctaStartBtn');
    if (ctaStartBtn) {
        ctaStartBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const authToken = localStorage.getItem('authToken');
            const clientId = localStorage.getItem('clientId');
            
            if (authToken && clientId) {
                // User is logged in, redirect to dashboard
                window.location.href = '/dashboard';
            } else {
                // User is not logged in, redirect to auth
                window.location.href = '/auth';
            }
        });
    }
});


// ── Typewriter ─────────────────────────────────────────────────────────────
// Types each phrase from data-phrases, holds, deletes it, and moves on. Runs
// forever while the page is open; under a reduced-motion preference the
// first phrase is shown and left alone.
(() => {
    const el = document.getElementById('heroTyped');
    if (!el) return;

    let phrases = [];
    try { phrases = JSON.parse(el.dataset.phrases || '[]'); } catch { phrases = []; }
    if (phrases.length === 0) return;

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
        el.textContent = phrases[0];
        return;
    }

    const TYPE_MS = 70;      // per character while typing
    const DELETE_MS = 38;    // per character while deleting
    const HOLD_MS = 1700;    // pause with the full phrase shown
    const GAP_MS = 420;      // pause with nothing shown before the next

    let index = 0;
    let shown = '';
    let deleting = false;

    function step() {
        const phrase = phrases[index];

        if (!deleting) {
            shown = phrase.slice(0, shown.length + 1);
            el.textContent = shown;
            if (shown === phrase) {
                deleting = true;
                return setTimeout(step, HOLD_MS);
            }
            // A little human unevenness.
            return setTimeout(step, TYPE_MS + Math.random() * 40);
        }

        shown = phrase.slice(0, shown.length - 1);
        el.textContent = shown;
        if (shown.length === 0) {
            deleting = false;
            index = (index + 1) % phrases.length;
            return setTimeout(step, GAP_MS);
        }
        return setTimeout(step, DELETE_MS);
    }

    // Start after the hero's own entrance so the two do not fight.
    setTimeout(step, 700);
})();


// ── Route network ──────────────────────────────────────────────────────────
// The hero's backdrop: four chain nodes around the edges, each joined to the
// wordmark by a curve, with packets travelling along them and landing behind
// the word. Drawn on a canvas so hundreds of frames a second cost nothing in
// layout. Colours come from the theme tokens and are re-read on themechange.
(() => {
    const canvas = document.getElementById('routeCanvas');
    const hero = document.getElementById('hero');
    const wordmark = document.getElementById('wordmark');
    if (!canvas || !hero || !wordmark || !canvas.getContext) return;

    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The stylesheet hides the canvas on narrow screens; nothing to draw then.
    if (getComputedStyle(canvas).display === 'none') return;

    const CHAINS = [
        { label: 'BTC', ax: 0.09, ay: 0.22 },
        { label: 'ETH', ax: 0.91, ay: 0.20 },
        { label: 'LTC', ax: 0.08, ay: 0.80 },
        { label: 'SOL', ax: 0.92, ay: 0.78 },
    ];

    let width = 0, height = 0, dpr = 1;
    let colors = {};
    let packets = [];
    let ripples = [];
    let pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    let rafId = null;
    let last = 0;
    let running = false;

    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (name) => cs.getPropertyValue(name).trim();
        colors = { ink: v('--ink'), ink3: v('--ink-3'), line: v('--line-strong'), info: v('--info'), ok: v('--ok') };
    }

    function rgba(hex, alpha) {
        // Tokens are hex; anything else falls back to a neutral.
        const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return `rgba(128,128,128,${alpha})`;
        const n = parseInt(m[1], 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }

    function resize() {
        const rect = hero.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = rect.width;
        height = rect.height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Where the word sits, in canvas coordinates. Packets aim here. */
    function hub() {
        const h = hero.getBoundingClientRect();
        const w = wordmark.getBoundingClientRect();
        return { x: w.left - h.left + w.width / 2, y: w.top - h.top + w.height / 2, rx: w.width / 2, ry: w.height / 2 };
    }

    function nodePosition(chain) {
        // Parallax: the far edge nodes shift a little with the pointer.
        const px = (pointer.x - 0.5) * 26;
        const py = (pointer.y - 0.5) * 18;
        return { x: chain.ax * width + px, y: chain.ay * height + py };
    }

    /** Cubic bezier from a node to the hub, bowing outward so paths do not overlap the copy. */
    function pathFor(chain, target) {
        const from = nodePosition(chain);
        const dx = target.x - from.x;
        const bow = (chain.ay < 0.5 ? -1 : 1) * Math.min(120, height * 0.18);
        return {
            p0: from,
            p1: { x: from.x + dx * 0.35, y: from.y + bow },
            p2: { x: target.x - dx * 0.25, y: target.y + bow * 0.4 },
            p3: { x: target.x, y: target.y },
        };
    }

    function pointAt(path, t) {
        const u = 1 - t;
        const x = u * u * u * path.p0.x + 3 * u * u * t * path.p1.x + 3 * u * t * t * path.p2.x + t * t * t * path.p3.x;
        const y = u * u * u * path.p0.y + 3 * u * u * t * path.p1.y + 3 * u * t * t * path.p2.y + t * t * t * path.p3.y;
        return { x, y };
    }

    function spawnPacket(chainIndex) {
        packets.push({
            chain: chainIndex,
            t: 0,
            speed: 0.16 + Math.random() * 0.14,   // fraction of the path per second
            size: 2.2 + Math.random() * 1.6,
        });
    }

    function pulseWord() {
        wordmark.style.setProperty('--pulse', '1.012');
        setTimeout(() => wordmark.style.setProperty('--pulse', '1'), 180);
    }

    function draw(now) {
        const dt = Math.min(0.05, (now - last) / 1000 || 0);
        last = now;

        // Ease the pointer so the parallax glides.
        pointer.x += (pointer.tx - pointer.x) * 0.06;
        pointer.y += (pointer.ty - pointer.y) * 0.06;

        ctx.clearRect(0, 0, width, height);
        const target = hub();
        const paths = CHAINS.map((c) => pathFor(c, target));

        // Routes
        ctx.lineWidth = 1;
        for (const path of paths) {
            ctx.strokeStyle = rgba(colors.line, 0.9);
            ctx.beginPath();
            ctx.moveTo(path.p0.x, path.p0.y);
            ctx.bezierCurveTo(path.p1.x, path.p1.y, path.p2.x, path.p2.y, path.p3.x, path.p3.y);
            ctx.stroke();
        }

        // Nodes
        CHAINS.forEach((chain, i) => {
            const p = paths[i].p0;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
            ctx.fillStyle = rgba(colors.ink, 0.06);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
            ctx.strokeStyle = rgba(colors.ink, 0.35);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = rgba(colors.ink, 0.75);
            ctx.font = '600 10px system-ui, -apple-system, Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(chain.label, p.x, p.y + 0.5);
        });

        // Packets
        for (let i = packets.length - 1; i >= 0; i--) {
            const pk = packets[i];
            pk.t += pk.speed * dt;
            if (pk.t >= 1) {
                packets.splice(i, 1);
                ripples.push({ x: target.x, y: target.y, r: 6, life: 1 });
                pulseWord();
                continue;
            }
            const path = paths[pk.chain];
            const head = pointAt(path, pk.t);
            // Trail: a few points behind the head, fading.
            for (let k = 1; k <= 6; k++) {
                const tt = Math.max(0, pk.t - k * 0.018);
                const q = pointAt(path, tt);
                ctx.beginPath();
                ctx.arc(q.x, q.y, pk.size * (1 - k / 7), 0, Math.PI * 2);
                ctx.fillStyle = rgba(colors.info, 0.35 * (1 - k / 7));
                ctx.fill();
            }
            const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, pk.size * 5);
            glow.addColorStop(0, rgba(colors.info, 0.55));
            glow.addColorStop(1, rgba(colors.info, 0));
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(head.x, head.y, pk.size * 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(head.x, head.y, pk.size, 0, Math.PI * 2);
            ctx.fillStyle = rgba(colors.ink, 0.95);
            ctx.fill();
        }

        // Ripples where packets land
        for (let i = ripples.length - 1; i >= 0; i--) {
            const rp = ripples[i];
            rp.life -= dt * 1.4;
            rp.r += dt * 90;
            if (rp.life <= 0) { ripples.splice(i, 1); continue; }
            ctx.beginPath();
            ctx.ellipse(rp.x, rp.y, rp.r * 1.6, rp.r * 0.6, 0, 0, Math.PI * 2);
            ctx.strokeStyle = rgba(colors.ok, 0.45 * rp.life);
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }

        // Keep a steady stream: one packet in flight per route on average.
        if (packets.length < CHAINS.length && Math.random() < dt * 1.4) {
            spawnPacket(Math.floor(Math.random() * CHAINS.length));
        }

        if (running) rafId = requestAnimationFrame(draw);
    }

    function start() {
        if (running) return;
        running = true;
        last = performance.now();
        rafId = requestAnimationFrame(draw);
    }

    function stop() {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
    }

    readColors();
    resize();

    if (reduceMotion) {
        // One still frame: routes and nodes, no traffic.
        draw(performance.now());
        return;
    }

    // A first wave so the scene is alive on arrival.
    CHAINS.forEach((_, i) => setTimeout(() => spawnPacket(i), 400 + i * 350));

    hero.addEventListener('pointermove', (event) => {
        const rect = hero.getBoundingClientRect();
        pointer.tx = (event.clientX - rect.left) / rect.width;
        pointer.ty = (event.clientY - rect.top) / rect.height;
    });
    hero.addEventListener('pointerleave', () => { pointer.tx = 0.5; pointer.ty = 0.5; });

    window.addEventListener('resize', resize);
    window.addEventListener('themechange', readColors);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    // Stop drawing once the hero is scrolled away; nobody can see it.
    if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
            entries.forEach((e) => (e.isIntersecting ? start() : stop()));
        }, { threshold: 0.05 }).observe(hero);
    } else {
        start();
    }
})();
