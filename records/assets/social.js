/* Share buttons and the collectors wall for Stag House Records pages. No tracking; the collectors list comes from the label's own public API. */
(function () {
  var API = 'https://buybot.stagwifhood.fun';
  var css = document.createElement('style');
  css.textContent = '.shr{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0}.shr span{font:700 11px/1 "Space Mono",ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:#9bb197;margin-right:4px}' +
    '.shr a,.shr button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:9px 16px;border-radius:999px;border:1px solid #1d3022;background:#0a110c;color:#e9f2e5;font:600 13px/1 Barlow,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;cursor:pointer}' +
    '.shr a:hover,.shr button:hover,.shr a:focus-visible,.shr button:focus-visible{border-color:#39ff14;color:#39ff14;outline:none}' +
    '.shr.win{background:#0e1810;border:1px solid #39ff14;border-radius:16px;padding:14px}.shr.win span{flex:1 1 100%;color:#39ff14;margin-bottom:4px}' +
    '.cwall{margin:18px 0;border:1px solid #1d3022;border-radius:16px;background:#0a110c;padding:14px 16px}.cwall h3{font:700 12px/1 "Space Mono",ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#39ff14;margin:0 0 10px}' +
    '.cwall ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}.cwall li{display:flex;justify-content:space-between;gap:10px;font:600 14px/1.3 Barlow,Arial,sans-serif;color:#e9f2e5}.cwall li a{color:#f4dc8f;text-decoration:none}.cwall li small{color:#9bb197;font-size:13px}';
  document.head.appendChild(css);

  function ago(ts) { var s = Math.max(0, Date.now() / 1000 - ts); if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }

  function buttons(el, o) { // o: { text, url, label, win }
    if (!el) return; var url = o.url || location.href, text = o.text || document.title;
    el.className = 'shr' + (o.win ? ' win' : ''); el.innerHTML = '';
    var s = document.createElement('span'); s.textContent = o.label || 'Share'; el.appendChild(s);
    var x = document.createElement('a'); x.textContent = 'X'; x.target = '_blank'; x.rel = 'noopener'; x.href = 'https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url); el.appendChild(x);
    var t = document.createElement('a'); t.textContent = 'Telegram'; t.target = '_blank'; t.rel = 'noopener'; t.href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text); el.appendChild(t);
    var c = document.createElement('button'); c.type = 'button'; c.textContent = 'Copy link'; el.appendChild(c);
    c.onclick = function () {
      var done = function () { c.textContent = 'Copied'; setTimeout(function () { c.textContent = 'Copy link'; }, 1600); };
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { navigator.share({ title: document.title, text: text, url: url }).catch(function () {}); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () {});
    };
  }

  function collectors(el, id, names) { // shows nothing at all until there is at least one collector
    if (!el) return;
    fetch(API + '/api/collectors' + (id ? '?id=' + id : '')).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok || !d.total || !d.recent || !d.recent.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = ''; el.className = 'cwall'; el.innerHTML = '<h3></h3><ul></ul>';
      el.querySelector('h3').textContent = 'Latest collectors · ' + d.total + ' so far';
      var ul = el.querySelector('ul');
      d.recent.slice(0, 6).forEach(function (r) {
        var li = document.createElement('li'), a = document.createElement('a'), sm = document.createElement('small');
        a.href = 'https://robinhoodchain.blockscout.com/tx/' + r.tx; a.target = '_blank'; a.rel = 'noopener'; a.textContent = r.buyer;
        sm.textContent = (names && names[r.id] ? names[r.id] + ' · ' : '') + ago(r.ts); li.appendChild(a); li.appendChild(sm); ul.appendChild(li);
      });
    }).catch(function () { el.style.display = 'none'; });
  }

  window.StagShare = { buttons: buttons, collectors: collectors };
})();
