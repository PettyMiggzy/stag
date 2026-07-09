/* ============================================================
   STAGWIFHOOD — mint page (The Hooded 20)
   ============================================================ */
(function () {
  'use strict';
  const BASE = 'assets/nft/stagwifhood';

  /* rotating "random" preview */
  const shuffle = document.getElementById('mint-shuffle');
  if (shuffle) {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    let last = 1;
    shuffle.style.transition = 'opacity .18s ease';
    setInterval(() => {
      let n;
      do { n = ids[Math.floor(Math.random() * ids.length)]; } while (n === last);
      last = n;
      shuffle.style.opacity = '0';
      setTimeout(() => { shuffle.src = `${BASE}/img/${n}.jpg`; shuffle.style.opacity = '1'; }, 180);
    }, 1100);
  }

  /* supply meter (0 minted until launch) */
  const MINTED = 0, TOTAL = 20;
  const fill = document.getElementById('supply-fill');
  const count = document.getElementById('supply-count');
  const mMinted = document.getElementById('m-minted');
  if (fill) setTimeout(() => { fill.style.width = (MINTED / TOTAL * 100) + '%'; }, 300);
  if (count) count.textContent = `${MINTED} / ${TOTAL} minted`;
  if (mMinted) mMinted.textContent = String(MINTED);
})();
