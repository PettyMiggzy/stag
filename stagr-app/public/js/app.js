import { S, $, $$, esc, get, post, icon, toast, ApiError, hooks, clearOffline } from './core.js';
import { homeView, requestsView, requestView } from './home.js';
import { customersView, customerView } from './people.js';
import { quotesView, quoteView, invoicesView, invoiceView } from './sales.js';
import { scheduleView, jobsView, jobView } from './work.js';
import { reportsView, messagesView, settingsView, moreView, accountView } from './more.js';

const NAV = [['home', '/', 'Home', 'home', 'worker'], ['requests', '/requests', 'Requests', 'inbox', 'admin'], ['customers', '/customers', 'Customers', 'users', 'admin'], ['schedule', '/schedule', 'Schedule', 'cal', 'worker'],
  ['quotes', '/quotes', 'Quotes', 'doc', 'admin'], ['jobs', '/jobs', 'Jobs', 'job', 'admin'], ['invoices', '/invoices', 'Invoices', 'inv', 'admin'], ['reports', '/reports', 'Reports', 'chart', 'admin'],
  ['messages', '/messages', 'Messages', 'msg', 'admin'], ['settings', '/settings', 'Settings', 'gear', 'admin'], ['account', '/account', 'My account', 'me', 'worker']];
const TABS = ['home', 'schedule', 'customers', 'invoices', 'more', 'account'];
const RANK = { worker: 1, admin: 2, owner: 3 };
const ROUTES = [
  [/^\/?$/, homeView], [/^\/requests$/, requestsView], [/^\/requests\/(\d+)$/, requestView], [/^\/customers$/, customersView], [/^\/customers\/(\d+)$/, customerView], [/^\/schedule$/, scheduleView],
  [/^\/quotes$/, quotesView], [/^\/quotes\/(\d+)$/, quoteView], [/^\/jobs$/, jobsView], [/^\/jobs\/(\d+)$/, jobView], [/^\/invoices$/, invoicesView], [/^\/invoices\/(\d+)$/, invoiceView],
  [/^\/reports$/, reportsView], [/^\/messages$/, messagesView], [/^\/settings$/, settingsView], [/^\/more$/, moreView], [/^\/account$/, accountView]];
const root = $('#root');

function authScreen(mode = 'login') {
  const signup = mode === 'signup';
  root.innerHTML = `<div class="auth"><div class="box"><a class="brand" href="/" style="flex-direction:column"><img src="/logo-full.webp" alt="STAGR" style="width:200px;height:200px;filter:none"></a>
    <form class="card col" id="authForm" novalidate><h2 style="font-size:2rem">${signup ? 'Start your business' : 'Sign in'}</h2>
    ${signup ? `<label class="field"><span>Business name</span><input name="business" required autocomplete="organization" maxlength="80"></label>
      <label class="field"><span>What kind of work do you do?</span><select name="trade" id="trade"><option value="other">Choose one…</option></select></label>
      <div class="grid g2"><label class="field"><span>Your name</span><input name="name" required autocomplete="name" maxlength="80"></label><label class="field"><span>Business phone</span><input name="phone" inputmode="tel" autocomplete="tel"></label></div>
      <div class="grid g2"><label class="field"><span>City</span><input name="city" maxlength="60"></label><label class="field"><span>State</span><input name="state" maxlength="2" placeholder="TX"></label></div>` : ''}
    <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email"></label>
    <label class="field"><span>Password${signup ? ' (8+ characters)' : ''}</span><input name="password" type="password" required autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8"></label>
    <p class="small" id="authErr" style="color:var(--bad);margin:0" role="alert"></p>
    <button class="btn main" type="submit">${signup ? 'Create my account' : 'Sign in'}</button>
    ${signup ? '' : '<p class="small" style="margin:0;text-align:center"><a href="#" id="forgot">Forgot your password?</a></p>'}
    <p class="small mute" style="margin:0;text-align:center;display:flex;gap:8px;align-items:center;justify-content:center"><img src="/logo.webp" alt="" width="22" height="22" style="object-fit:contain"> STAGR field service CRM</p>
    <p class="small mute" style="margin:0;text-align:center">${signup ? 'Already have an account? <a href="#" data-mode="login">Sign in</a>' : 'New to STAGR? <a href="#" data-mode="signup">Create an account</a>'}</p></form></div></div>`;
  $('[data-mode]').addEventListener('click', e => { e.preventDefault(); authScreen(e.target.dataset.mode); });
  if (signup) get('/public/trades').then(r => { const s = $('#trade'); if (s) s.insertAdjacentHTML('beforeend', r.trades.filter(t => t.key !== 'other').map(t => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('') + '<option value="other">Something else</option>'); }).catch(() => {});
  $('#forgot')?.addEventListener('click', e => { e.preventDefault(); forgotScreen($('input[name=email]').value); });
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), btn = $('button[type=submit]', e.target); btn.disabled = true; $('#authErr').textContent = '';
    try { await post(signup ? '/auth/signup' : '/auth/login', f); location.hash = '#/'; await boot(); } catch (err) { $('#authErr').textContent = err.message; btn.disabled = false; }
  });
}
const authCard = inner => { root.innerHTML = `<div class="auth"><div class="box"><a class="brand" href="/" style="flex-direction:column"><img src="/logo-full.webp" alt="STAGR" style="width:160px;height:160px;filter:none"></a>${inner}</div></div>`; };
function forgotScreen(email = '') {
  authCard(`<form class="card col" id="ff" novalidate><h2 style="font-size:2rem">Reset your password</h2><p class="small mute" style="margin:-6px 0 0">Enter the email you sign in with. We will email you a link that works for 1 hour.</p>
    <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label><p class="small" id="fMsg" style="margin:0" role="status"></p>
    <button class="btn main" type="submit">Email me a reset link</button><p class="small mute" style="margin:0;text-align:center"><a href="#" id="backIn">Back to sign in</a></p></form>`);
  $('#backIn').addEventListener('click', e => { e.preventDefault(); authScreen('login'); });
  $('#ff').addEventListener('submit', async e => { e.preventDefault(); const btn = $('button[type=submit]', e.target), msg = $('#fMsg'); btn.disabled = true; msg.style.color = ''; msg.textContent = '';
    try { const r = await post('/auth/forgot', { email: e.target.email.value }); msg.textContent = r.delivery === 'none' ? 'Email is not set up for this STAGR server yet. Ask your manager to set a new password for you in Settings, Team.' : 'If that email has an account, a reset link is on its way. Check your inbox and spam folder.'; }
    catch (err) { msg.style.color = 'var(--bad)'; msg.textContent = err.message; btn.disabled = false; } });
}
function resetScreen(token) {
  authCard(`<form class="card col" id="rf" novalidate><h2 style="font-size:2rem">Choose a new password</h2><label class="field"><span>New password (8+ characters)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label class="field"><span>Type it again</span><input name="again" type="password" required minlength="8" autocomplete="new-password"></label><p class="small" id="rMsg" style="color:var(--bad);margin:0" role="alert"></p>
    <button class="btn main" type="submit">Save and sign in</button><p class="small mute" style="margin:0;text-align:center"><a href="#" id="backIn">Back to sign in</a></p></form>`);
  $('#backIn').addEventListener('click', e => { e.preventDefault(); location.hash = ''; authScreen('login'); });
  $('#rf').addEventListener('submit', async e => { e.preventDefault(); const f = e.target, msg = $('#rMsg'), btn = $('button[type=submit]', f); msg.textContent = '';
    if (f.password.value !== f.again.value) { msg.textContent = 'The two passwords do not match'; return; }
    btn.disabled = true; try { await post('/auth/reset', { token, password: f.password.value }); location.hash = '#/'; await boot(); } catch (err) { msg.textContent = err.message; btn.disabled = false; } });
}
function allowed(role) { return RANK[S.user.role] >= RANK[role]; }
function shell() {
  const items = NAV.filter(n => allowed(n[4]));
  root.innerHTML = `<div id="app"><aside class="side"><a class="brand" href="#/"><img src="/logo.webp" alt=""><b>STAGR</b></a>
    <nav class="nav" aria-label="Main">${items.map(n => `<a href="#${n[1]}" data-nav="${n[0]}">${icon(n[3])}<span>${n[2]}</span>${n[0] === 'requests' ? '<span class="badge hidden" id="reqBadge"></span>' : ''}</a>`).join('')}</nav>
    <div class="who"><b>${esc(S.user.name)}</b><div class="mute small">${esc(S.business.name)} · ${esc(S.user.role)}</div><button class="btn small" id="logout" style="margin-top:8px">Sign out</button></div></aside>
    <main class="main" id="main" tabindex="-1"></main></div>
    <nav class="tabbar" aria-label="Main">${TABS.filter(t => t === 'more' ? allowed('admin') : t === 'account' ? !allowed('admin') : NAV.find(n => n[0] === t && allowed(n[4]))).map(t => { const n = NAV.find(x => x[0] === t) || ['more', '/more', 'More', 'gear']; return `<a href="#${n[1]}" data-nav="${t}">${icon(n[3])}<span>${t === 'account' ? 'Me' : n[2]}</span></a>`; }).join('')}</nav>`;
  $('#logout').addEventListener('click', async () => { await import('./native.js').then(m => m.forgetDevice()).catch(() => {}); await post('/auth/logout').catch(() => {}); clearOffline(); S.user = null; location.hash = ''; authScreen(); });
  document.documentElement.style.setProperty('--accent', S.business.brand_color || '#39ff14');
}
let navToken = 0;
async function route() {
  if (!S.user) return;
  const path = location.hash.replace(/^#/, '') || '/', token = ++navToken, main = $('#main');
  const hit = ROUTES.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  const key = path.split('/')[1] || 'home';
  $$('[data-nav]').forEach(a => { const k = a.dataset.nav; a.toggleAttribute('aria-current', k === key || (k === 'more' && ['reports', 'messages', 'settings', 'quotes', 'jobs', 'requests', 'more', 'account'].includes(key) && allowed('admin'))); if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page'); });
  main.innerHTML = '<p class="mute">Loading…</p>';
  try {
    if (!hit) { main.innerHTML = '<div class="empty">Page not found. <a href="#/">Go home</a></div>'; return; }
    const navItem = NAV.find(n => n[0] === key); // a screen above this person's role says so plainly instead of failing halfway
    if (navItem && !allowed(navItem[4])) { main.innerHTML = '<div class="empty">This screen is for managers. <a href="#/">Go to your jobs</a></div>'; return; }
    const html = await hit[1](...hit[0].slice(1));
    if (token !== navToken) return; // user already navigated elsewhere
    if (typeof html === 'string') main.innerHTML = html;
    window.scrollTo(0, 0);
  } catch (e) { if (token === navToken) main.innerHTML = `<div class="empty">${esc(e.message || 'Something went wrong')}<br><button class="btn small" onclick="location.reload()" style="margin-top:10px">Try again</button></div>`; }
}
hooks.refresh = route;
async function boot() {
  const rm = /^#\/reset\/([A-Za-z0-9_-]{20,})$/.exec(location.hash); if (rm) return resetScreen(rm[1]); // a reset link opens the new-password form, signed in or not
  try { const me = await get('/auth/me'); S.user = me.user; S.business = me.business; } catch (e) { if (e instanceof ApiError && e.status === 401) return authScreen('login'); root.innerHTML = '<div class="auth"><div class="empty">Could not reach the server. Check your connection and refresh.</div></div>'; return; }
  const [t, s] = await Promise.all([get('/team'), get('/services')]); S.team = t.team; S.services = s.services;
  shell(); await route();
  import('./native.js').then(m => m.initNative()).catch(() => {});
  if (allowed('admin')) get('/requests').then(r => { const n = r.requests.filter(x => x.status === 'new').length, b = $('#reqBadge'); if (b && n) { b.textContent = n; b.classList.remove('hidden'); } }).catch(() => {});
}
window.addEventListener('hashchange', () => { if (/^#\/reset\//.test(location.hash)) boot(); else route(); });
boot();

// ---- phone and offline polish ----
if (window.Capacitor?.isNativePlatform?.()) document.documentElement.classList.add('native');
const syncOnline = () => document.documentElement.classList.toggle('offline', !navigator.onLine);
addEventListener('online', syncOnline); addEventListener('offline', syncOnline); syncOnline();
if ('serviceWorker' in navigator && location.protocol === 'https:') addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
