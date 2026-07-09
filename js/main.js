/* ============================================================
   STAGWIFHOOD ($STAG) — interactions
   ============================================================ */
(function () {
  'use strict';

  /* ---- nav scrolled state ---- */
  const nav = document.getElementById('nav');
  const onScroll = () => nav && nav.classList.toggle('scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---- reveal on scroll ---- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* ---- copy contract address ---- */
  const caBar = document.getElementById('ca-bar');
  const caText = document.getElementById('ca-text');
  const caBtn = document.getElementById('ca-copy');
  function copyCA() {
    const txt = caText.textContent.trim();
    if (/TBA/i.test(txt)) { flash('Soon™'); return; }
    navigator.clipboard?.writeText(txt).then(() => flash('Copied!'));
  }
  function flash(msg) {
    const old = caBtn.textContent;
    caBtn.textContent = msg; caBtn.classList.add('ok');
    setTimeout(() => { caBtn.textContent = old; caBtn.classList.remove('ok'); }, 1400);
  }
  caBar?.addEventListener('click', copyCA);

  /* ---- count-up stats ---- */
  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 2 : 0) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
  }
  const statIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      const dur = 1400; const t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(Math.round(target * eased)) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      statIO.unobserve(el);
    });
  }, { threshold: 0.6 });
  document.querySelectorAll('.stat-num').forEach((el) => statIO.observe(el));

  /* ---- prize ladder fill ---- */
  const ladder = document.getElementById('ladder');
  const fill = document.getElementById('ladder-fill');
  if (ladder && fill) {
    const lIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { fill.style.width = '100%'; lIO.unobserve(e.target); } });
    }, { threshold: 0.4 });
    lIO.observe(ladder);
  }

  /* ---- build The Hooded 20 gallery (animated) ----
     Manifest-driven: shows the art, plays the animation on hover/focus. ---- */
  const grid = document.getElementById('nft-grid');
  if (grid) {
    const BASE = 'assets/nft/stagwifhood';
    const rarClass = { Mythic: 'rar-mythic', Legendary: 'rar-legendary', Epic: 'rar-epic', Rare: 'rar-rare', Common: 'rar-common' };
    fetch(`${BASE}/manifest.json`).then((r) => r.json()).then((m) => {
      grid.innerHTML = m.items.map((it) => `
        <a class="nft-card" href="${BASE}/anim/${it.animation}" target="_blank" rel="noopener"
           data-anim="${BASE}/anim/${it.animation}" aria-label="${it.name}">
          <span class="nft-rar ${rarClass[it.rarity] || 'rar-common'}">${it.rarity}</span>
          <img src="${BASE}/img/${it.image}" alt="${it.name}" loading="lazy" />
          <span class="nft-name">${it.character || it.name}</span>
        </a>`).join('');
      grid.querySelectorAll('.nft-card').forEach((card) => {
        let vid = null;
        const play = () => {
          if (vid) return;
          vid = document.createElement('video');
          vid.src = card.dataset.anim; vid.muted = true; vid.loop = true;
          vid.autoplay = true; vid.playsInline = true; vid.className = 'nft-vid';
          card.appendChild(vid); vid.play().catch(() => {});
        };
        const stop = () => { if (vid) { vid.remove(); vid = null; } };
        card.addEventListener('mouseenter', play);
        card.addEventListener('mouseleave', stop);
        card.addEventListener('focus', play);
        card.addEventListener('blur', stop);
      });
    }).catch(() => {});
  }

  /* ---- social links (fill these in when live) ---- */
  const SOCIALS = { x: 'https://x.com/StagWifHood', tg: 'https://t.me/StagWifHood' };
  document.querySelectorAll('[data-social]').forEach((a) => {
    const url = SOCIALS[a.dataset.social];
    if (url && url !== '#') { a.href = url; a.target = '_blank'; a.rel = 'noopener'; }
  });
})();
