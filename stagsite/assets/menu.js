/* Phone menu: the header links are hidden on small screens, so this adds a menu button with every page in it. Same file on both sites. */
(function () {
  var rec = /^records\./.test(location.hostname) || document.documentElement.hasAttribute('data-records');
  var M = 'https://stagwifhood.fun', R = 'https://records.stagwifhood.fun';
  var links = rec ? [
    ['Records home', '/'], ['The album', '/album/'], ['WYTE BOYZ single', '/songs/'], ['Winslow Bankz', '/artist/'], ['The Launchpad', '/launch/'],
    ['$STAG main site', M + '/'], ['Hood Rich Club lounge', M + '/lounge/'], ['StagR CRM', M + '/stagr/'], ['Telegram', 'https://t.me/StagWifHood']
  ] : [
    ['Home', '/'], ['StagR CRM', '/stagr/'], ['Stag House Records', R + '/'], ['Winslow Bankz', R + '/artist/'], ['The Launchpad', R + '/launch/'], ['Hood Rich Club lounge', '/lounge/'],
    ['Stag Shot game', '/play/'], ['Claim rewards', '/claim/'], ['Telegram', 'https://t.me/StagWifHood'], ['X', 'https://x.com/stagwifhoodrh']
  ];
  var bar = document.querySelector('header .in'); if (!bar) return;
  var css = document.createElement('style');
  css.textContent = '#mBtn{display:none;flex:none;width:44px;height:44px;border-radius:12px;border:1px solid #1d3022;background:#0a110c;color:#e9f2e5;cursor:pointer;align-items:center;justify-content:center;padding:0;margin-left:8px}' +
    '#mBtn svg{width:22px;height:22px;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;fill:none}#mBtn[aria-expanded=true]{border-color:#39ff14;color:#39ff14}' +
    '#mPanel{display:none;position:fixed;left:0;right:0;top:0;bottom:0;z-index:49;background:rgba(5,8,6,.98);padding:calc(84px + env(safe-area-inset-top,0px)) 16px 24px;overflow:auto}' +
    '#mPanel.on{display:block}#mPanel a{display:flex;align-items:center;justify-content:space-between;min-height:54px;padding:6px 14px;margin-bottom:8px;border:1px solid #1d3022;border-radius:14px;background:#0a110c;color:#e9f2e5;text-decoration:none;font:600 16px/1.2 Barlow,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase}' +
    '#mPanel a::after{content:"\\203A";color:#39ff14;font-size:22px}#mPanel a[aria-current]{border-color:#39ff14;color:#39ff14}' +
    '@media(max-width:820px){#mBtn{display:inline-flex}header .in{gap:8px}header nav{margin-left:auto}}';
  document.head.appendChild(css);
  var b = document.createElement('button'); b.id = 'mBtn'; b.type = 'button'; b.setAttribute('aria-label', 'Menu'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'mPanel');
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  if (!bar.querySelector('nav')) b.style.marginLeft = '0';
  bar.appendChild(b);
  var p = document.createElement('nav'); p.id = 'mPanel'; p.setAttribute('aria-label', 'All pages');
  links.forEach(function (l) {
    var a = document.createElement('a'); a.textContent = l[0]; a.href = l[1];
    if (/^https:\/\/(t\.me|x\.com)/.test(l[1])) { a.target = '_blank'; a.rel = 'noopener'; }
    if (l[1] === location.pathname) a.setAttribute('aria-current', 'page');
    p.appendChild(a);
  });
  document.body.appendChild(p);
  function set(on) { p.classList.toggle('on', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); document.documentElement.style.overflow = on ? 'hidden' : ''; }
  b.addEventListener('click', function () { set(!p.classList.contains('on')); });
  p.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  addEventListener('resize', function () { if (innerWidth > 820) set(false); });
})();
