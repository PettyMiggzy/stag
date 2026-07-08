/* ============================================================
   STAGWIFHOOD ($STAG) — interactions
   ============================================================ */
(function () {
  'use strict';

  /* ---- nav scrolled state ---- */
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
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

  /* ---- build The Hooded 20 gallery ----
     Renders real art from assets/nft/stagwifhood/img/NN.png when present,
     falling back to an elegant placeholder tile. ---- */
  const grid = document.getElementById('nft-grid');
  if (grid) {
    const rarity = (i) => (i === 1 ? 'legendary' : i <= 4 ? 'epic' : i <= 10 ? 'rare' : 'common');
    const label = { legendary: 'Legendary', epic: 'Epic', rare: 'Rare', common: 'Common' };
    let html = '';
    for (let i = 1; i <= 20; i++) {
      const n = String(i).padStart(2, '0');
      const r = rarity(i);
      html += `
        <a class="nft-card" href="assets/nft/stagwifhood/img/${n}.png" target="_blank" rel="noopener" data-i="${i}" aria-label="Hooded Stag #${n}">
          <span class="nft-rar rar-${r}">${label[r]}</span>
          <img src="assets/nft/stagwifhood/thumb/${n}.webp" alt="Hooded Stag #${n}"
               onerror="this.replaceWith(ph(${i}))" loading="lazy" />
        </a>`;
    }
    grid.innerHTML = html;
  }
  // placeholder factory (referenced by inline onerror)
  window.ph = function (i) {
    const d = document.createElement('div');
    d.className = 'nft-ph';
    d.innerHTML = `<div class="shimmer"></div><div class="num">#${String(i).padStart(2, '0')}</div>`;
    return d;
  };

  /* ---- social links (fill these in when live) ---- */
  const SOCIALS = { x: '#', tg: '#' };
  document.querySelectorAll('[data-social]').forEach((a) => {
    const url = SOCIALS[a.dataset.social];
    if (url && url !== '#') { a.href = url; a.target = '_blank'; a.rel = 'noopener'; }
  });
})();
