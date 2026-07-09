/* ============================================================
   STAGWIFHOOD — stake page (UI only; backend at launch)
   ============================================================ */
(function () {
  'use strict';
  /* tab switching */
  const tabs = document.querySelectorAll('.stake-tab');
  const panels = { token: document.getElementById('panel-token'), nft: document.getElementById('panel-nft') };
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    Object.entries(panels).forEach(([k, p]) => p && p.classList.toggle('active', k === t.dataset.tab));
  }));

  /* selectable NFT grid (cosmetic until backend) */
  const grid = document.getElementById('stake-nft-grid');
  const selCount = document.getElementById('nft-selected');
  if (grid) {
    const BASE = 'assets/nft/stagwifhood';
    const rarClass = { Mythic: 'rar-mythic', Legendary: 'rar-legendary', Epic: 'rar-epic', Rare: 'rar-rare', Common: 'rar-common' };
    fetch(`${BASE}/manifest.json`).then((r) => r.json()).then((m) => {
      grid.innerHTML = m.items.map((it) => `
        <div class="nft-card stake-pick" data-id="${it.id}" tabindex="0" role="button" aria-pressed="false" aria-label="${it.name}">
          <span class="nft-rar ${rarClass[it.rarity] || 'rar-common'}">${it.rarity}</span>
          <img src="${BASE}/img/${it.image}" alt="${it.name}" loading="lazy" />
          <span class="stake-check">✓</span>
        </div>`).join('');
      const cards = grid.querySelectorAll('.stake-pick');
      const update = () => { if (selCount) selCount.textContent = grid.querySelectorAll('.stake-pick.selected').length; };
      cards.forEach((c) => {
        const toggle = () => { c.classList.toggle('selected'); c.setAttribute('aria-pressed', c.classList.contains('selected')); update(); };
        c.addEventListener('click', toggle);
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      });
    }).catch(() => {});
  }
})();
