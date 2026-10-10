// Shared helpers for the STAGR app. Every value that comes from a user goes through esc() before it is put in HTML.
export const hooks = { refresh: () => {} };
export const S = { user: null, business: null, team: [], services: [] };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money0 = n => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
export const phoneFmt = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || ''; };
export const debounce = (f, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

// ---- API ----
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && S.user) { S.user = null; location.hash = ''; location.reload(); } throw new ApiError(r.status, j.error || 'Something went wrong'); }
  return j;
}
export const get = p => api('GET', p), post = (p, b = {}) => api('POST', p, b), put = (p, b = {}) => api('PUT', p, b), del = p => api('DELETE', p);

// ---- time zone aware formatting (the business's own time zone, not the browser's) ----
export const tz = () => (S.business && S.business.timezone) || 'America/Chicago';
const fmtCache = {};
const F = (key, opts) => (fmtCache[key + tz()] ||= new Intl.DateTimeFormat('en-US', { timeZone: tz(), ...opts }));
export const fmtDate = d => d ? F('d', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d)) : '';
// Date-only values (like a reminder date) must not shift with the time zone, so format them at midday UTC.
export const fmtDateOnly = d => d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(String(d).slice(0, 10) + 'T12:00:00Z')) : '';
export const fmtDay = d => F('dd', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
export const fmtTime = d => d ? F('t', { hour: 'numeric', minute: '2-digit' }).format(new Date(d)) : '';
export const fmtDT = d => d ? `${fmtDay(d)} · ${fmtTime(d)}` : '';
export const ago = d => { const s = (Date.now() - new Date(d)) / 1000; if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' hr ago'; return Math.round(s / 86400) + ' days ago'; };
function wall(date) { const p = {}; F('w', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).forEach(x => { p[x.type] = x.value; }); return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }; }
export const dayKey = d => { const w = wall(new Date(d)); return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`; };
// <input type=datetime-local> works in "wall clock" text. Convert to and from the business time zone.
export const toInput = d => { if (!d) return ''; const w = wall(new Date(d)); const p = n => String(n).padStart(2, '0'); return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`; };
export function fromInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || ''); if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); let g = want;
  for (let i = 0; i < 3; i++) { const w = wall(new Date(g)); g += want - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s); }
  return new Date(g).toISOString();
}
export const startOfWeek = (d = new Date()) => { const w = wall(d), base = new Date(Date.UTC(w.y, w.mo - 1, w.d)); base.setUTCDate(base.getUTCDate() - base.getUTCDay()); return base; }; // Sunday as a UTC-midnight "calendar date"
export const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
export const calKey = d => d.toISOString().slice(0, 10);

// ---- icons (simple line icons) ----
const P = { home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', inbox: 'M4 4h16v12h-5l-1 3h-4l-1-3H4zM4 12h5', users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 100-5M18 14.2c2.4.5 4 2.5 4 5.8', doc: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6', cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', job: 'M3 8h18v12H3zM8 8V5h8v3', inv: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .7-1.5-1L15 4h-4l-.5 2.7-1.5 1-2-.7-2 4 2 1v2l-2 1 2 4 2-.7 1.5 1L11 20h4l.5-2.7 1.5-1 2 .7 2-4-2-1z', msg: 'M4 5h16v11H9l-5 4z', plus: 'M12 5v14M5 12h14' };
export const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n] || ''}"/></svg>`;

// ---- toast and modal ----
export function toast(msg, err = false) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 2600); }
export function modal(html, onMount) {
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div role="dialog" aria-modal="true">${html}</div>`; document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_); m.addEventListener('mousedown', e => { if (e.target === m) close(); });
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const first = m.querySelector('input,select,textarea'); if (first) setTimeout(() => first.focus(), 30);
  if (onMount) onMount(m, close); return { el: m, close };
}
export const chip = (text, kind = '') => `<span class="chip ${kind}">${esc(text)}</span>`;
export const statusChip = s => chip(String(s).replace('_', ' '), { paid: 'ok', approved: 'ok', completed: 'ok', converted: 'ok', sent: 'blue', partial: 'warn', scheduled: 'blue', in_progress: 'warn', new: 'warn', draft: '', declined: 'bad', void: 'bad', cancelled: 'bad', lost: 'bad', blocked: 'bad', preview: 'warn', failed: 'bad', active: 'blue' }[s] || '');
export function empty(text, action = '') { return `<div class="empty"><p>${esc(text)}</p>${action}</div>`; }
// Shrink a photo in the browser before upload (keeps requests small).
export function shrinkImage(file, max = 1100, q = 0.72) {
  return new Promise((res, rej) => { const img = new Image(), url = URL.createObjectURL(file); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', q)); }; img.onerror = () => rej(new Error('That file is not a photo')); img.src = url; });
}
