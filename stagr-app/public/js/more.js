import { S, esc, get, post, put, del, money, money0, fmtDT, fmtDate, ago, statusChip, chip, empty, toast, hooks, modal, debounce, icon, $, $$ } from './core.js';

export function moreView() {
  const L = [['requests', 'Requests', 'inbox'], ['quotes', 'Quotes', 'doc'], ['jobs', 'Jobs', 'job'], ['reports', 'Reports', 'chart'], ['messages', 'Messages and follow-ups', 'msg'], ['settings', 'Settings', 'gear']];
  setTimeout(() => $('#out')?.addEventListener('click', async () => { await post('/auth/logout'); location.hash = ''; location.reload(); }), 0);
  return `<div class="top"><h1>More</h1></div><div class="list">${L.map(l => `<a class="item" href="#/${l[0]}"><div class="row">${icon(l[2])}<b style="margin-left:6px">${l[1]}</b></div><span class="mute">›</span></a>`).join('')}</div><p style="margin-top:18px"><button class="btn" id="out">Sign out</button></p><p class="small mute">Signed in as ${esc(S.user.email)}</p>`;
}

export async function reportsView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || ''), days = Number(q.get('d')) || 180, from = new Date(Date.now() - days * 864e5).toISOString();
  const r = await get('/reports?from=' + encodeURIComponent(from)), main = document.getElementById('main');
  setTimeout(() => $$('[data-d]', main).forEach(b => b.addEventListener('click', () => { location.hash = '#/reports?d=' + b.dataset.d; })), 0);
  const max = Math.max(1, ...r.by_month.map(m => m.amount)), maxS = Math.max(1, ...r.by_service.map(s => s.amount));
  return `<div class="top"><h1>Reports</h1><div class="seg" role="group" aria-label="Range">${[[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']].map(([d, t]) => `<button data-d="${d}" aria-pressed="${d === days}">${t}</button>`).join('')}</div></div>
  <div class="grid g4 keep2"><div class="stat hot"><span class="mono">Collected</span><b>${money0(r.collected)}</b></div><div class="stat"><span class="mono">Invoiced</span><b>${money0(r.invoiced)}</b></div><div class="stat"><span class="mono">Expenses</span><b>${money0(r.expenses)}</b></div><div class="stat ${r.profit < 0 ? 'bad' : 'hot'}"><span class="mono">Profit</span><b>${money0(r.profit)}</b></div></div>
  <div class="grid g3" style="margin-top:14px"><div class="stat"><span class="mono">Quote approval rate</span><b>${r.quotes.approval_rate === null ? '—' : r.quotes.approval_rate + '%'}</b><span class="small mute">${r.quotes.approved} of ${r.quotes.sent} sent</span></div><div class="stat"><span class="mono">Requests turned into customers</span><b>${r.requests.total ? Math.round(r.requests.converted / r.requests.total * 100) + '%' : '—'}</b><span class="small mute">${r.requests.converted} of ${r.requests.total}</span></div><div class="stat"><span class="mono">Median first reply</span><b>${r.requests.median_reply_minutes === null ? '—' : r.requests.median_reply_minutes + ' min'}</b></div></div>
  <div class="grid g2" style="margin-top:14px;align-items:start"><section class="card"><h3>Money collected by month</h3>${r.by_month.length ? `<div class="bars" style="margin-bottom:26px">${r.by_month.map(m => `<div style="height:${Math.max(3, m.amount / max * 100)}%" title="${esc(m.month)}: ${money(m.amount)}"><span>${esc(m.month.slice(5))}</span></div>`).join('')}</div>` : empty('No payments in this range.')}</section>
  <section class="card"><h3>Top services invoiced</h3><div class="col" style="gap:8px">${r.by_service.length ? r.by_service.map(s => `<div><div class="row between small"><span>${esc(s.name)}</span><b>${money0(s.amount)}</b></div><div style="height:6px;background:var(--panel2);border-radius:4px"><div style="height:6px;width:${s.amount / maxS * 100}%;background:var(--accent);border-radius:4px"></div></div></div>`).join('') : empty('Nothing invoiced yet.')}</div></section></div>
  <section class="card" style="margin-top:14px"><h3>Repeat customers</h3><div class="list">${r.top_customers.length ? r.top_customers.map(c => `<a class="item" href="#/customers/${c.id}"><div class="t">${esc(c.name)}</div><span class="mute">${c.jobs} job${c.jobs === 1 ? '' : 's'}</span></a>`).join('') : empty('No jobs yet.')}</div></section>
  <p class="small mute" style="margin-top:14px">Download for your accountant: <a href="/api/export/invoices.csv">invoices.csv</a> · <a href="/api/export/payments.csv">payments.csv</a></p>`;
}

const AUTO = {
  appointment_reminder: ['Appointment reminders', 'Texts the customer before a scheduled visit.'], quote_followup: ['Quote follow-ups', 'Nudges customers who have not answered a quote.'],
  invoice_reminder: ['Invoice reminders', 'Reminds customers about unpaid invoices.'], monthly_followup: ['Monthly offer to past customers', 'Texts past customers an offer so they book again. Only goes to customers who agreed to get texts.'],
  job_followup: ['Thank-you and review request', 'Asks happy customers for a review after a job. Needs your review link in Settings.']
};
export async function messagesView() {
  const [ms, au] = await Promise.all([get('/messages'), get('/automations')]), main = document.getElementById('main'), d = ms.delivery;
  setTimeout(() => {
    $$('[data-edit]', main).forEach(b => b.addEventListener('click', () => autoModal(au.automations.find(a => a.kind === b.dataset.edit))));
    $$('[data-tog]', main).forEach(b => b.addEventListener('change', async () => { try { await put('/automations/' + b.dataset.tog, { enabled: b.checked }); toast(b.checked ? 'Turned on' : 'Turned off'); hooks.refresh(); } catch (e) { toast(e.message, true); b.checked = !b.checked; } }));
    $('#runNow', main).addEventListener('click', async () => { try { const r = await post('/automations/run'); toast(r.made ? `${r.made} message${r.made === 1 ? '' : 's'} created` : 'Nothing is due right now'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
  }, 0);
  return `<div class="top"><h1>Messages</h1><button class="btn small" id="runNow">Check for due messages now</button></div>
  ${d.sms || d.email ? '' : `<div class="card" style="border-color:rgba(240,180,41,.5);margin-bottom:14px"><b>Texting and email are not connected yet.</b><p class="small mute" style="margin:6px 0 0">Messages are saved as previews so you can see exactly what customers will get, but nothing is sent until a texting or email service is connected for STAGR.</p></div>`}
  <h3 class="mono" style="margin:6px 0 8px">Automatic messages</h3><div class="list">${au.automations.map(a => { const t = AUTO[a.kind] || [a.kind, '']; return `<div class="item" style="cursor:default"><div class="grow"><div class="t">${esc(t[0])}</div><div class="s" style="white-space:normal">${esc(t[1])}</div></div><div class="row"><button class="btn small" data-edit="${esc(a.kind)}">Edit</button><label class="row small"><input type="checkbox" data-tog="${esc(a.kind)}" ${a.enabled ? 'checked' : ''} aria-label="${esc(t[0])} on or off"> On</label></div></div>`; }).join('')}</div>
  <h3 class="mono" style="margin:20px 0 8px">Recent messages</h3><div class="list">${ms.messages.length ? ms.messages.slice(0, 60).map(m => `<div class="item" style="cursor:default;align-items:flex-start"><div class="grow"><div class="t">${esc(m.customer_name || 'Customer')} · ${esc(m.channel)}</div><div class="s" style="white-space:normal">${esc(m.body)}</div><div class="s">${esc(fmtDT(m.created_at))}${m.error ? ' · ' + esc(m.error) : ''}</div></div>${statusChip(m.status)}</div>`).join('') : empty('No messages yet.')}</div>`;
}
function autoModal(a) {
  const t = AUTO[a.kind] || [a.kind, ''], c = a.config;
  const num = (k, label) => c[k] !== undefined ? `<label class="field"><span>${label}</span><input data-n="${k}" inputmode="numeric" value="${esc(c[k])}"></label>` : '';
  modal(`<h2>${esc(t[0])}</h2><p class="mute small" style="margin:-4px 0 12px">${esc(t[1])}</p><form class="col" id="af"><div class="grid g2">${num('hours_before', 'Hours before')}${num('days_after', 'Days after')}${num('days_between', 'Days between reminders')}${num('max_sends', 'Most reminders')}${num('days_since_last_job', 'Days since their last job')}${num('min_gap_days', 'Days between offers')}</div>
    ${c.discount !== undefined ? `<label class="field"><span>Discount (shown as you type it)</span><input id="disc" value="${esc(c.discount)}" maxlength="20"></label>` : ''}
    <label class="field"><span>Message</span><textarea id="tpl" maxlength="500" style="min-height:110px">${esc(c.template)}</textarea></label><p class="small mute" style="margin:0">You can use: {business} {first} {city} {phone} {discount} {when} {where} {link} {number} {balance} {review_link}</p>
    <div class="card" style="background:var(--panel2)"><div class="mono">Preview</div><p id="prev" style="margin:6px 0 0;white-space:pre-wrap"></p></div>
    <div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (el, close) => {
    const upd = debounce(async () => { try { const r = await post('/automations/preview', { template: $('#tpl', el).value, discount: $('#disc', el)?.value }); $('#prev', el).textContent = r.text; } catch {} }, 200);
    $('#tpl', el).addEventListener('input', upd); $('#disc', el)?.addEventListener('input', upd); upd();
    $('#af', el).addEventListener('submit', async e => { e.preventDefault(); const config = { template: $('#tpl', el).value }; $$('[data-n]', el).forEach(i => { config[i.dataset.n] = Number(i.value); }); if ($('#disc', el)) config.discount = $('#disc', el).value;
      try { await put('/automations/' + a.kind, { config }); close(); toast('Saved'); hooks.refresh(); } catch (err) { toast(err.message, true); } });
  });
}

export async function settingsView() {
  const [{ team }, { services }] = await Promise.all([get('/team'), get('/services')]); S.team = team; S.services = services;
  const b = S.business, s = b.settings || {}, link = location.origin + '/b/' + b.slug, owner = S.user.role === 'owner', main = document.getElementById('main');
  setTimeout(() => {
    $('#bf', main).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { const r = await put('/business', { name: f.name, phone: f.phone, email: f.email, city: f.city, state: f.state, timezone: f.timezone, tax_pct: f.tax_pct, brand_color: f.brand_color, settings: { booking_enabled: !!f.booking, booking_intro: f.intro, review_link: f.review, payment_note: f.paynote } }); S.business = r.business; document.documentElement.style.setProperty('--accent', r.business.brand_color); toast('Saved'); } catch (err) { toast(err.message, true); } });
    $('#copyB', main).addEventListener('click', async () => { await navigator.clipboard?.writeText(link).catch(() => {}); toast('Booking link copied'); });
    $('#addM', main).addEventListener('click', () => memberModal()); $$('[data-m]', main).forEach(x => x.addEventListener('click', () => memberModal(team.find(t => t.id == x.dataset.m))));
    $('#addS', main).addEventListener('click', () => serviceModal()); $$('[data-s]', main).forEach(x => x.addEventListener('click', () => serviceModal(services.find(t => t.id == x.dataset.s))));
    $('#pw', main).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await post('/auth/password', f); e.target.reset(); toast('Password changed'); } catch (err) { toast(err.message, true); } });
  }, 0);
  return `<div class="top"><h1>Settings</h1></div><div class="grid g2" style="align-items:start"><div class="col">
  <form class="card col" id="bf"><h3>Business</h3><label class="field"><span>Name</span><input name="name" value="${esc(b.name)}" required></label><div class="grid g2"><label class="field"><span>Phone</span><input name="phone" value="${esc(b.phone)}"></label><label class="field"><span>Email</span><input name="email" value="${esc(b.email)}"></label></div>
    <div class="grid g3"><label class="field"><span>City</span><input name="city" value="${esc(b.city)}"></label><label class="field"><span>State</span><input name="state" maxlength="2" value="${esc(b.state)}"></label><label class="field"><span>Sales tax %</span><input name="tax_pct" inputmode="decimal" value="${esc(Number(b.tax_pct))}"></label></div>
    <div class="grid g2"><label class="field"><span>Time zone</span><select name="timezone">${['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'].map(z => `<option ${z === b.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label><label class="field"><span>Brand color</span><input type="color" name="brand_color" value="${esc(b.brand_color)}" style="padding:2px;height:42px"></label></div>
    <label class="field"><span>Review link (Google review page)</span><input name="review" value="${esc(s.review_link || '')}" placeholder="https://g.page/…"></label><label class="field"><span>Payment instructions shown on invoices</span><input name="paynote" value="${esc(s.payment_note || '')}" placeholder="Zelle to … or call us to pay by card"></label>
    <hr class="sep"><h3>Online booking page</h3><label class="row"><input type="checkbox" name="booking" ${s.booking_enabled !== false ? 'checked' : ''}> Let customers request work online</label><label class="field"><span>Welcome message</span><input name="intro" value="${esc(s.booking_intro || '')}" placeholder="Tell us what you need and we will get back to you fast."></label>
    <div class="row between wrap"><span class="small mute" style="word-break:break-all">${esc(link)}</span><button class="btn small" type="button" id="copyB">Copy link</button></div><button class="btn main" type="submit">Save</button></form>
  <form class="card col" id="pw"><h3>Change your password</h3><label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label><label class="field"><span>New password (8+)</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label><button class="btn" type="submit">Change password</button></form></div>
  <div class="col"><section class="card"><div class="row between"><h3>Team</h3><button class="btn small main" id="addM">+ Add</button></div><div class="list">${team.map(t => `<div class="item" data-m="${t.id}" role="button" tabindex="0"><div class="grow"><div class="t">${esc(t.name)} ${t.active ? '' : chip('off', 'bad')}</div><div class="s">${esc(t.email)} · ${esc(t.role)}</div></div><span class="mute small">Edit</span></div>`).join('')}</div></section>
  <section class="card"><div class="row between"><h3>Price list</h3><button class="btn small main" id="addS">+ Add</button></div><p class="small mute" style="margin:-4px 0 10px">Services you quote often. Pick them from the list when you build a quote or invoice.</p><div class="list">${services.map(x => `<div class="item" data-s="${x.id}" role="button" tabindex="0"><div class="grow"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.description)}</div></div><b>${money(x.unit_price)}</b></div>`).join('')}</div></section></div></div>`;
}
function memberModal(m) {
  modal(`<h2>${m ? 'Edit' : 'Add'} team member</h2><form class="col" id="mf"><div class="grid g2"><label class="field"><span>Name</span><input name="name" required value="${esc(m?.name || '')}"></label><label class="field"><span>Phone</span><input name="phone" value="${esc(m?.phone || '')}"></label></div>
    ${m ? '' : '<label class="field"><span>Email (they sign in with this)</span><input name="email" type="email" required></label>'}
    <div class="grid g2"><label class="field"><span>Role</span><select name="role" ${m?.role === 'owner' ? 'disabled' : ''}><option value="worker" ${m?.role === 'worker' ? 'selected' : ''}>Worker (sees only their jobs)</option><option value="admin" ${m?.role === 'admin' ? 'selected' : ''}>Manager (full access except owner)</option>${m?.role === 'owner' ? '<option selected>owner</option>' : ''}</select></label>
    <label class="field"><span>${m ? 'New password (optional)' : 'Temporary password (8+)'}</span><input name="password" type="password" autocomplete="new-password" ${m ? '' : 'required'} minlength="8"></label></div>
    ${m && m.role !== 'owner' ? `<label class="row"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Can sign in</label>` : ''}
    <div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (el, close) => {
    $('#mf', el).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const body = { name: f.name, phone: f.phone, role: f.role, email: f.email, password: f.password || undefined }; if (m && m.role !== 'owner') body.active = !!f.active; try { m ? await put('/team/' + m.id, body) : await post('/team', body); close(); toast('Saved'); hooks.refresh(); } catch (err) { toast(err.message, true); } });
  });
}
function serviceModal(x) {
  modal(`<h2>${x ? 'Edit' : 'Add'} service</h2><form class="col" id="sf"><label class="field"><span>Name</span><input name="name" required value="${esc(x?.name || '')}"></label><label class="field"><span>Description</span><input name="description" value="${esc(x?.description || '')}"></label><label class="field"><span>Price</span><input name="unit_price" inputmode="decimal" value="${esc(x ? Number(x.unit_price) : '')}"></label>
    <div class="row between"><div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>${x ? '<button class="btn small warn" type="button" id="rm">Remove</button>' : ''}</div></form>`, (el, close) => {
    $('#sf', el).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { x ? await put('/services/' + x.id, f) : await post('/services', f); close(); hooks.refresh(); } catch (err) { toast(err.message, true); } });
    $('#rm', el)?.addEventListener('click', async () => { await put('/services/' + x.id, { active: false }); close(); hooks.refresh(); });
  });
}
