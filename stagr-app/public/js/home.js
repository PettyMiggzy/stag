import { S, esc, get, put, post, money, money0, phoneFmt, fmtDT, fmtDate, ago, statusChip, chip, empty, toast, hooks, modal, $, $$ } from './core.js';
import { newCustomerModal } from './people.js';
import { newQuoteModal } from './sales.js';
import { newJobModal, visitModal } from './work.js';

const crew = ids => (ids || []).map(id => (S.team.find(t => t.id === id) || {}).name).filter(Boolean).join(', ');
export const visitRow = v => `<div class="item" data-visit="${v.id}" role="button" tabindex="0"><div class="grow"><div class="t">${esc(v.customer_name)} · ${esc(v.title)}</div><div class="s">${esc(fmtDT(v.starts_at))}${v.address ? ' · ' + esc(v.address) : ''}${v.assigned && v.assigned.length ? ' · ' + esc(crew(v.assigned)) : ' · no crew yet'}</div></div>${statusChip(v.status)}</div>`;
export function wireVisits(root) { $$('[data-visit]', root).forEach(el => { const open = () => visitModal(Number(el.dataset.visit)); el.addEventListener('click', open); el.addEventListener('keydown', e => { if (e.key === 'Enter') open(); }); }); }

export async function homeView() {
  const d = await get('/dashboard'), main = document.getElementById('main'), worker = S.user.role === 'worker', hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const upcoming = d.upcoming.length ? d.upcoming.map(visitRow).join('') : empty(worker ? 'Nothing assigned to you this week.' : 'No visits scheduled this week.');
  if (worker) { setTimeout(() => wireVisits(main), 0); return `<div class="top"><div><div class="mono">${esc(S.business.name)}</div><h1>${greet}, ${esc(S.user.name.split(' ')[0])}</h1></div></div><h3 class="mono" style="margin:0 0 8px">Your week</h3><div class="list">${upcoming}</div>`; }
  const r = d.receivables;
  setTimeout(() => {
    wireVisits(main);
    $$('[data-act]', main).forEach(b => b.addEventListener('click', () => ({ customer: () => newCustomerModal(), quote: () => newQuoteModal(), job: () => newJobModal() }[b.dataset.act]())));
    $$('[data-convert]', main).forEach(b => b.addEventListener('click', async () => { try { const x = await post('/requests/' + b.dataset.convert + '/convert'); location.hash = '#/customers/' + x.customer.id; } catch (e) { toast(e.message, true); } }));
  }, 0);
  return `<div class="top"><div><div class="mono">${esc(S.business.name)}</div><h1>${greet}, ${esc(S.user.name.split(' ')[0])}</h1></div>
    <div class="row wrap"><button class="btn small" data-act="customer">+ Customer</button><button class="btn small" data-act="quote">+ Quote</button><button class="btn main small" data-act="job">+ Job</button></div></div>
  <div class="grid g4 keep2"><a class="stat ${d.new_requests.length ? 'hot' : ''}" href="#/requests" style="text-decoration:none"><span class="mono">New requests</span><b>${d.new_requests.length}</b></a>
    <a class="stat" href="#/quotes" style="text-decoration:none"><span class="mono">Quotes waiting</span><b>${d.open_quotes.length}</b><span class="small mute">${money0(d.open_quotes.reduce((a, q) => a + q.total, 0))}</span></a>
    <a class="stat ${r.overdue ? 'bad' : ''}" href="#/invoices" style="text-decoration:none"><span class="mono">To collect</span><b>${money0(r.total)}</b><span class="small mute">${r.overdue ? money0(r.overdue) + ' overdue' : 'nothing overdue'}</span></a>
    <a class="stat hot" href="#/reports" style="text-decoration:none"><span class="mono">Collected this month</span><b>${money0(d.month.collected)}</b><span class="small mute">${d.month.visits_completed} visits done</span></a></div>
  <div class="grid g2" style="margin-top:16px;align-items:start">
    <section class="card"><h3>This week</h3><div class="list">${upcoming}</div><p class="small" style="margin:10px 0 0"><a href="#/schedule">Open the full schedule</a></p></section>
    <section class="card"><h3>New requests</h3><div class="list">${d.new_requests.length ? d.new_requests.map(q => `<div class="item"><div class="grow"><div class="t">${esc(q.name)}</div><div class="s">${esc(q.service || 'Request')} · ${esc(ago(q.created_at))}</div></div><button class="btn small main" data-convert="${q.id}">Start</button></div>`).join('') : empty('No new requests. Share your booking page so customers can ask for work.', `<p class="small" style="margin-top:8px"><a href="#/settings">Get your booking link</a></p>`)}</div></section>
    <section class="card"><h3>Quotes waiting on a yes</h3><div class="list">${d.open_quotes.length ? d.open_quotes.slice(0, 6).map(q => `<a class="item" href="#/customers/${q.customer_id}"><div class="grow"><div class="t">${esc(q.customer_name)} · ${esc(q.label)}</div><div class="s">${q.viewed_at ? 'Viewed ' + esc(ago(q.viewed_at)) : 'Not opened yet'}</div></div><b>${money0(q.total)}</b></a>`).join('') : empty('No quotes waiting.')}</div></section>
    <section class="card"><h3>Invoices to collect</h3><div class="list">${r.invoices.length ? r.invoices.map(i => `<a class="item" href="#/invoices/${i.id}"><div class="grow"><div class="t">${esc(i.customer_name)} · ${esc(i.label)}</div><div class="s">${i.due_date && String(i.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) ? '<span style="color:var(--bad)">Overdue</span>' : 'Due ' + esc(String(i.due_date || '').slice(0, 10))}</div></div><b>${money(i.balance)}</b></a>`).join('') : empty('Nothing to collect.')}</div></section></div>`;
}

export async function requestsView() {
  const { requests } = await get('/requests'), main = document.getElementById('main');
  setTimeout(() => {
    $$('[data-convert]', main).forEach(b => b.addEventListener('click', async () => { try { const x = await post('/requests/' + b.dataset.convert + '/convert'); location.hash = '#/customers/' + x.customer.id; } catch (e) { toast(e.message, true); } }));
    $$('[data-st]', main).forEach(b => b.addEventListener('click', async () => { try { await put('/requests/' + b.dataset.id, { status: b.dataset.st }); hooks.refresh(); } catch (e) { toast(e.message, true); } }));
    $$('.thumb', main).forEach(i => i.addEventListener('click', () => window.open(i.src, '_blank')));
    $('#addReq', main)?.addEventListener('click', () => requestModal());
  }, 0);
  return `<div class="top"><h1>Requests</h1><button class="btn main" id="addReq">+ Add request</button></div><p class="mute small" style="margin-top:-8px">Every time someone asks for work, from your booking page or a phone call you type in, it shows up here.</p>
  <div class="list">${requests.length ? requests.map(q => `<div class="card"><div class="row between wrap"><div><a href="#/requests/${q.id}" style="text-decoration:none"><b>${esc(q.name)}</b></a> ${statusChip(q.status)}<div class="small mute">${esc(q.service || 'Request')} · ${esc(q.source)} · ${esc(ago(q.created_at))}</div></div>
      <div class="row wrap">${q.phone ? `<a class="btn small" href="tel:${esc(q.phone)}">Call ${esc(phoneFmt(q.phone))}</a>` : ''}<a class="btn small main" href="#/requests/${q.id}">Open</a>${q.status === 'new' ? `<button class="btn small" data-st="contacted" data-id="${q.id}">Contacted</button>` : ''}${q.status !== 'lost' && q.status !== 'converted' ? `<button class="btn small warn" data-st="lost" data-id="${q.id}">Lost</button>` : ''}</div></div>
      ${q.address ? `<p class="small" style="margin:8px 0 0">📍 ${esc(q.address)}</p>` : ''}${q.message ? `<p style="margin:8px 0 0;white-space:pre-wrap">${esc(q.message)}</p>` : ''}
      ${(q.photos || []).length ? `<div class="photos" style="margin-top:10px">${q.photos.map(p => `<img class="thumb" src="${esc(p)}" alt="Customer photo" loading="lazy" style="cursor:pointer">`).join('')}</div>` : ''}</div>`).join('') : empty('No requests yet.')}</div>`;
}
function requestModal() {
  modal(`<h2>Add a request</h2><form class="col" id="rf"><div class="grid g2"><label class="field"><span>Name</span><input name="name" required></label><label class="field"><span>Phone</span><input name="phone" inputmode="tel"></label></div>
    <label class="field"><span>What do they need?</span><input name="service"></label><label class="field"><span>Address</span><input name="address"></label><label class="field"><span>Notes</span><textarea name="message"></textarea></label>
    <div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (el, close) => {
    $('#rf', el).addEventListener('submit', async e => { e.preventDefault(); try { await post('/requests', Object.fromEntries(new FormData(e.target))); close(); hooks.refresh(); } catch (err) { toast(err.message, true); } });
  });
}

// A single request, laid out like Jobber's: contact card, what they asked for, when they are free, photos, internal notes.
export async function requestView(id) {
  const d = await get('/requests/' + id), r = d.request, main = document.getElementById('main'), av = r.availability || {};
  const arrival = { any: 'Any time', morning: 'Morning', afternoon: 'Afternoon' };
  const ensureCustomer = async () => (await post('/requests/' + r.id + '/convert')).customer;
  setTimeout(() => {
    $('#toQuote', main).addEventListener('click', async () => { try { const x = await post('/requests/' + r.id + '/convert-quote'); toast('Quote started'); location.hash = '#/quotes/' + x.quote.id; } catch (e) { toast(e.message, true); } });
    $('#toJob', main).addEventListener('click', async () => { try { const c = await ensureCustomer(); newJobModal(c.id, { title: r.service || 'New job' }); } catch (e) { toast(e.message, true); } });
    $('#assess', main).addEventListener('click', async () => { try { const c = await ensureCustomer(); newJobModal(c.id, { title: 'Assessment' + (r.service ? ': ' + r.service : '') }); } catch (e) { toast(e.message, true); } });
    $('#lost', main)?.addEventListener('click', async () => { await put('/requests/' + r.id, { status: 'lost' }); hooks.refresh(); });
    $('#contacted', main)?.addEventListener('click', async () => { await put('/requests/' + r.id, { status: 'contacted' }); hooks.refresh(); });
    $('#notes', main).addEventListener('change', async e => { try { await put('/requests/' + r.id, { notes: e.target.value }); toast('Note saved'); } catch (err) { toast(err.message, true); } });
    $$('.thumb', main).forEach(i => i.addEventListener('click', () => window.open(i.src, '_blank')));
  }, 0);
  return `<div class="top"><div><a class="small mute" href="#/requests">← Requests</a></div><div class="row wrap"><button class="btn main" id="assess">Schedule assessment</button>
    <details style="position:relative"><summary class="btn" style="list-style:none">⋯ More</summary><div class="card" style="position:absolute;right:0;top:46px;z-index:20;min-width:210px;display:grid;gap:6px;padding:10px"><button class="btn small" id="toQuote" style="justify-content:flex-start">Convert to Quote</button><button class="btn small" id="toJob" style="justify-content:flex-start">Convert to Job</button>${r.status === 'new' ? '<button class="btn small" id="contacted" style="justify-content:flex-start">Mark contacted</button>' : ''}${r.status !== 'lost' && r.status !== 'converted' ? '<button class="btn small warn" id="lost" style="justify-content:flex-start">Mark lost</button>' : ''}<button class="btn small" onclick="window.print()" style="justify-content:flex-start">Print</button></div></details></div></div>
  <div class="grid g2" style="align-items:start"><div class="col"><div class="card"><div class="row between"><div>${statusChip(r.status)}</div><span class="mute small">${esc(fmtDT(r.created_at))} · ${esc(r.source)}</span></div><h1 style="font-size:2.4rem;margin:10px 0 4px">Request for ${esc(r.name)}</h1>
      <div class="grid g2" style="margin-top:8px"><div><b class="small">${esc(r.name)}${r.company ? ' · ' + esc(r.company) : ''}</b><div class="mute small">${esc(r.address) || 'No address'}<br>${r.phone ? `<a href="tel:${esc(r.phone)}" style="color:inherit">${esc(phoneFmt(r.phone))}</a>` : ''}<br>${esc(r.email)}</div></div>
        <div class="small"><b>Marketing consent</b><div class="mute">Texts: ${r.sms_ok ? chip('agreed', 'ok') : chip('no')}<br>Email: ${r.email_ok ? chip('agreed', 'ok') : chip('no')}</div></div></div>
      ${d.customer ? `<p class="small" style="margin:10px 0 0">Customer: <a href="#/customers/${d.customer.id}">${esc(d.customer.name)}</a>${d.quotes.length ? ' · ' + d.quotes.map(x => `<a href="#/quotes/${x.id}">Q-${x.number}</a>`).join(', ') : ''}</p>` : ''}</div>
    <div class="card"><h3>Overview</h3><div class="col" style="gap:12px"><div><b class="small">Service details</b><p style="margin:2px 0 0;white-space:pre-wrap">${esc(r.service) ? '<b>' + esc(r.service) + '</b><br>' : ''}${esc(r.message) || '<span class="mute">—</span>'}</p></div>
      <div><b class="small">Your availability</b><div class="mute small">Preferred days: ${(av.dates || []).length ? av.dates.map(x => esc(fmtDate(x + 'T12:00:00Z'))).join(' · ') : '—'}<br>Arrival times: ${(av.arrival || []).length ? av.arrival.map(x => esc(arrival[x])).join(', ') : '—'}</div></div>
      <div><b class="small">Photos</b>${(r.photos || []).length ? `<div class="photos" style="margin-top:6px">${r.photos.map(p => `<img class="thumb" src="${esc(p)}" alt="Customer photo" loading="lazy" style="cursor:pointer">`).join('')}</div>` : '<div class="mute small">None sent</div>'}</div></div></div></div>
  <div class="card"><h3>Notes</h3><p class="small mute" style="margin:-4px 0 8px">Internal notes. The customer never sees these.</p><textarea id="notes" style="min-height:180px" placeholder="Leave an internal note for yourself or a team member">${esc(r.notes)}</textarea></div></div>`;
}
