import { S, esc, get, post, put, del, money, money0, fmtDate, fmtDay, fmtTime, fmtDT, dayKey, toInput, fromInput, startOfWeek, addDays, calKey, statusChip, chip, empty, toast, hooks, modal, shrinkImage, $, $$ } from './core.js';
import { newInvoiceModal } from './sales.js';

const crewNames = ids => (ids || []).map(id => (S.team.find(t => t.id === id) || {}).name).filter(Boolean).join(', ');
const crewBoxes = (sel = []) => S.team.filter(t => t.active).map(t => `<label class="row small" style="gap:6px"><input type="checkbox" name="crew" value="${t.id}" ${sel.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('') || '<span class="mute small">Add team members in Settings.</span>';
const picked = el => $$('[name=crew]:checked', el).map(x => Number(x.value));

export function newJobModal(customerId, opts = {}) {
  const q = opts.quote, tomorrow = dayKey(new Date(Date.now() + 864e5)) + 'T09:00'; // 9:00 AM tomorrow, business time
  modal(`<h2>${q ? 'Schedule ' + esc(q.label) : 'New job'}</h2><form id="jf" class="col">
    <div class="grid g2"><label class="field"><span>Customer</span><select id="cust"></select></label><label class="field"><span>Property</span><select id="prop"></select></label></div>
    <label class="field"><span>Job title</span><input id="title" required placeholder="Haul-away, lawn care, cleaning…" value="${esc(q ? 'Job from quote ' + q.label : '')}"></label>
    <div class="grid g2"><label class="field"><span>Starts</span><input id="start" type="datetime-local" value="${esc(tomorrow)}"></label><label class="field"><span>Ends (optional)</span><input id="end" type="datetime-local"></label></div>
    <div><span class="mono">Crew</span><div class="row wrap" style="margin-top:6px">${crewBoxes()}</div></div>
    <div class="grid g3"><label class="field"><span>Repeat</span><select id="rep"><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><label class="field"><span>Every</span><input id="every" inputmode="numeric" value="1"></label><label class="field"><span>Ends after (visits)</span><input id="count" inputmode="numeric" placeholder="No end"></label></div>
    <label class="field"><span>Checklist (one item per line, optional)</span><textarea id="chk" placeholder="Take before photos&#10;Sweep up when done"></textarea></label>
    <label class="field"><span>Job notes</span><textarea id="desc"></textarea></label>
    <div class="row"><button class="btn main" type="submit">Schedule job</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, async (el, close) => {
    const { customers } = await get('/customers'), sel = $('#cust', el), psel = $('#prop', el);
    const loadProps = async id => { if (!id) { psel.innerHTML = '<option value="">—</option>'; return; } const d = await get('/customers/' + id); psel.innerHTML = '<option value="">No property</option>' + d.properties.map(p => `<option value="${p.id}">${esc(p.address)}</option>`).join(''); const want = q?.property_id; if (want) psel.value = want; else if (d.properties.length === 1) psel.value = d.properties[0].id; };
    sel.innerHTML = '<option value="">Choose a customer…</option>' + customers.map(c => `<option value="${c.id}" ${c.id == customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join(''); sel.addEventListener('change', () => loadProps(sel.value)); await loadProps(customerId || '');
    $('#jf', el).addEventListener('submit', async e => { e.preventDefault(); if (!sel.value) return toast('Choose a customer', true);
      const startIso = fromInput($('#start', el).value); if (!startIso) return toast('Pick a start time', true);
      const body = { customer_id: Number(sel.value), property_id: psel.value || null, quote_id: q ? q.id : undefined, title: $('#title', el).value, description: $('#desc', el).value,
        visit: { starts_at: startIso, ends_at: fromInput($('#end', el).value), assigned: picked(el), checklist: $('#chk', el).value.split('\n').map(t => ({ text: t.trim() })).filter(t => t.text) },
        recurrence: $('#rep', el).value ? { freq: $('#rep', el).value, interval: Number($('#every', el).value) || 1, count: Number($('#count', el).value) || undefined } : null };
      try { const r = await post('/jobs', body); close(); toast('Job scheduled'); location.hash = '#/jobs/' + r.job.id; } catch (err) { toast(err.message, true); }
    });
  });
}

// One visit: status, crew, notes, checklist, photos, clock in and out.
export async function visitModal(id) {
  let v; try { v = (await get('/visits/' + id)).visit; } catch (e) { return toast(e.message, true); }
  const admin = S.user.role !== 'worker';
  modal(`<h2>${esc(v.customer_name)}</h2><p class="mute" style="margin:-6px 0 12px">${esc(v.title)} · ${esc(fmtDT(v.starts_at))}${v.ends_at ? ' to ' + esc(fmtTime(v.ends_at)) : ''}${v.address ? ' · ' + esc(v.address) : ''}</p>
    <div class="row wrap" style="margin-bottom:12px">${statusChip(v.status)}${v.customer_phone ? `<a class="btn small" href="tel:${esc(v.customer_phone)}">Call</a>` : ''}${v.address ? `<a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.address + ' ' + (v.city || ''))}">Directions</a>` : ''}<a class="btn small" href="#/jobs/${v.job_id}" data-close>Open job</a></div>
    ${admin ? `<div class="grid g2"><label class="field"><span>Starts</span><input id="vs" type="datetime-local" value="${esc(toInput(v.starts_at))}"></label><label class="field"><span>Ends</span><input id="ve" type="datetime-local" value="${esc(toInput(v.ends_at))}"></label></div><div style="margin-top:10px"><span class="mono">Crew</span><div class="row wrap" style="margin-top:6px">${crewBoxes(v.assigned)}</div></div>` : `<p class="small mute">Crew: ${esc(crewNames(v.assigned) || 'none')}</p>`}
    <h3 style="margin-top:14px">Checklist</h3><div class="col" id="chk" style="gap:6px">${(v.checklist || []).length ? v.checklist.map((c, i) => `<label class="row"><input type="checkbox" data-ci="${i}" ${c.done ? 'checked' : ''}> ${esc(c.text)}</label>`).join('') : '<span class="mute small">No checklist for this visit.</span>'}</div>
    <label class="field" style="margin-top:12px"><span>Notes</span><textarea id="vn">${esc(v.notes)}</textarea></label>
    <h3 style="margin-top:14px">Photos</h3><div class="photos" id="ph">${(v.photos || []).map(p => `<img src="${esc(p.data)}" alt="Job photo">`).join('')}</div><label class="btn small" style="margin-top:8px"><input type="file" accept="image/*" id="pf" class="hidden" capture="environment"> + Add photo</label>
    <div class="row wrap" style="margin-top:16px"><button class="btn main" id="done">${v.status === 'completed' ? 'Reopen' : 'Mark complete'}</button>${v.status === 'scheduled' ? '<button class="btn" id="go">Start (clock in)</button>' : ''}<button class="btn" id="save">Save</button>${admin ? '<button class="btn small warn" id="rm">Cancel visit</button>' : ''}<button class="btn" data-close>Close</button></div>`, (el, close) => {
    const body = () => ({ notes: $('#vn', el).value, checklist: (v.checklist || []).map((c, i) => ({ text: c.text, done: !!$(`[data-ci="${i}"]`, el)?.checked })), ...(admin ? { starts_at: fromInput($('#vs', el).value) || undefined, ends_at: fromInput($('#ve', el).value), assigned: picked(el) } : {}) });
    $('#save', el).addEventListener('click', async () => { try { await put('/visits/' + v.id, body()); close(); toast('Saved'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#done', el).addEventListener('click', async () => { try { const done = v.status !== 'completed'; await put('/visits/' + v.id, { ...body(), status: done ? 'completed' : 'scheduled' }); try { if (done) await post('/time/stop'); } catch {} close(); toast(done ? 'Marked complete' : 'Reopened'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#go', el)?.addEventListener('click', async () => { try { await put('/visits/' + v.id, { ...body(), status: 'in_progress' }); await post('/time/start', { visit_id: v.id }).catch(() => {}); close(); toast('Clocked in'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#rm', el)?.addEventListener('click', async () => { if (!confirm('Cancel this visit?')) return; await put('/visits/' + v.id, { status: 'cancelled' }); close(); hooks.refresh(); });
    $('#pf', el).addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { const data = await shrinkImage(f); const r = await post('/visits/' + v.id + '/photos', { data }); $('#ph', el).innerHTML = r.photos.map(p => `<img src="${esc(p.data)}" alt="Job photo">`).join(''); toast('Photo added'); } catch (err) { toast(err.message, true); } });
  });
}

let weekStart = null;
export async function scheduleView() {
  weekStart ||= startOfWeek(); const main = document.getElementById('main');
  const from = addDays(weekStart, -1).toISOString(), to = addDays(weekStart, 9).toISOString();
  const { visits } = await get(`/visits?from=${from}&to=${to}`), today = calKey(new Date(dayKey(new Date()) + 'T00:00:00Z')), days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const byDay = {}; visits.filter(v => v.status !== 'cancelled').forEach(v => { (byDay[dayKey(v.starts_at)] ||= []).push(v); });
  setTimeout(() => {
    $('#prev', main).addEventListener('click', () => { weekStart = addDays(weekStart, -7); hooks.refresh(); }); $('#next', main).addEventListener('click', () => { weekStart = addDays(weekStart, 7); hooks.refresh(); }); $('#tod', main).addEventListener('click', () => { weekStart = startOfWeek(); hooks.refresh(); });
    $('#nj', main)?.addEventListener('click', () => newJobModal()); $$('[data-visit]', main).forEach(el => el.addEventListener('click', () => visitModal(Number(el.dataset.visit))));
  }, 0);
  const label = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  return `<div class="top"><h1>Schedule</h1><div class="row wrap"><button class="btn small" id="prev" aria-label="Previous week">←</button><button class="btn small" id="tod">Today</button><button class="btn small" id="next" aria-label="Next week">→</button>${S.user.role !== 'worker' ? '<button class="btn main small" id="nj">+ New job</button>' : ''}</div></div><p class="mono" style="margin:-6px 0 12px">${esc(label)}</p>
  <div class="week">${days.map(d => { const k = calKey(d), list = byDay[k] || []; return `<div class="day ${k === today ? 'today' : ''}"><h4>${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</h4>${list.map(v => `<div class="vis ${v.status === 'completed' ? 'done' : ''} ${!v.assigned.length && v.status !== 'completed' ? 'unassigned' : ''}" data-visit="${v.id}" role="button" tabindex="0"><b>${esc(fmtTime(v.starts_at))} ${esc(v.customer_name)}</b><span class="mute">${esc(v.title)}${v.assigned.length ? ' · ' + esc(crewNames(v.assigned)) : ' · no crew'}</span></div>`).join('') || '<span class="mute small">—</span>'}</div>`; }).join('')}</div>`;
}
export async function jobsView() {
  const { jobs } = await get('/jobs'), main = document.getElementById('main');
  setTimeout(() => { $('#nj', main).addEventListener('click', () => newJobModal()); }, 0);
  return `<div class="top"><h1>Jobs</h1><button class="btn main" id="nj">+ New job</button></div><div class="list">${jobs.length ? jobs.map(j => `<a class="item" href="#/jobs/${j.id}"><div class="grow"><div class="t">J-${j.number} · ${esc(j.title)}</div><div class="s">${esc(j.customer_name)}${j.next_visit ? ' · next ' + esc(fmtDT(j.next_visit)) : ''}${j.recurrence ? ' · repeats ' + esc(j.recurrence.freq) : ''}</div></div>${statusChip(j.status)}</a>`).join('') : empty('No jobs yet. Approve a quote and schedule it, or create a job directly.')}</div>`;
}
export async function jobView(id) {
  const d = await get('/jobs/' + id), j = d.job, main = document.getElementById('main'), cs = d.costing, next = d.visits.filter(v => v.status === 'scheduled' && new Date(v.starts_at) > new Date()).length;
  setTimeout(() => {
    $$('[data-visit]', main).forEach(el => el.addEventListener('click', () => visitModal(Number(el.dataset.visit))));
    $('#inv', main)?.addEventListener('click', () => newInvoiceModal(j.customer_id, null, { items: j.items, job_id: j.id, quote_id: j.quote_id }));
    $('#fin', main)?.addEventListener('click', async () => { await put('/jobs/' + j.id, { status: 'completed' }); hooks.refresh(); });
    $('#stop', main)?.addEventListener('click', async () => { if (!confirm('Stop repeating this job? Future visits stay on the calendar.')) return; await put('/jobs/' + j.id, { recurrence: null }); hooks.refresh(); });
    $('#cancelJ', main)?.addEventListener('click', async () => { if (!confirm('Cancel this job and its future visits?')) return; await put('/jobs/' + j.id, { status: 'cancelled' }); hooks.refresh(); });
    $('#exp', main)?.addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await post('/expenses', { job_id: j.id, description: f.description, amount: f.amount }); toast('Expense added'); hooks.refresh(); } catch (err) { toast(err.message, true); } });
  }, 0);
  return `<div class="top"><div><a class="small mute" href="#/jobs">← Jobs</a><h1>J-${j.number} · ${esc(j.title)} ${statusChip(j.status)}</h1><div class="mute small"><a href="#/customers/${d.customer.id}">${esc(d.customer.name)}</a>${j.recurrence ? ' · repeats ' + esc(j.recurrence.freq) + (j.recurrence.interval > 1 ? ' every ' + j.recurrence.interval : '') : ''}</div></div>
    <div class="row wrap">${j.status === 'active' ? '<button class="btn small" id="fin">Mark job complete</button>' : ''}<button class="btn main small" id="inv">Create invoice</button>${j.recurrence && j.status === 'active' ? '<button class="btn small" id="stop">Stop repeating</button>' : ''}${j.status === 'active' ? '<button class="btn small warn" id="cancelJ">Cancel job</button>' : ''}</div></div>
  <div class="grid g4 keep2"><div class="stat"><span class="mono">Invoiced</span><b>${money0(cs.invoiced)}</b></div><div class="stat hot"><span class="mono">Collected</span><b>${money0(cs.collected)}</b></div><div class="stat"><span class="mono">Expenses</span><b>${money0(cs.expenses)}</b></div><div class="stat ${cs.profit < 0 ? 'bad' : 'hot'}"><span class="mono">Profit</span><b>${money0(cs.profit)}</b><span class="small mute">${cs.hours} hours on the clock</span></div></div>
  <div class="grid g2" style="margin-top:14px;align-items:start"><section class="card"><h3>Visits (${next} coming up)</h3><div class="list">${d.visits.slice(0, 40).map(v => `<div class="item" data-visit="${v.id}" role="button" tabindex="0"><div class="grow"><div class="t">${esc(fmtDT(v.starts_at))}</div><div class="s">${esc(crewNames(v.assigned) || 'No crew yet')}${v.notes ? ' · ' + esc(v.notes.slice(0, 50)) : ''}</div></div>${statusChip(v.status)}</div>`).join('')}</div>${d.visits.length > 40 ? '<p class="small mute">Showing the first 40.</p>' : ''}</section>
  <div class="col"><section class="card"><h3>Invoices</h3><div class="list">${d.invoices.length ? d.invoices.map(i => `<a class="item" href="#/invoices/${i.id}"><div class="grow"><div class="t">${esc(i.label)} · ${money(i.total)}</div><div class="s">${i.balance > 0 ? money(i.balance) + ' due' : 'Paid'}</div></div>${statusChip(i.status)}</a>`).join('') : empty('No invoices yet.')}</div></section>
  <section class="card"><h3>Expenses</h3><div class="list">${d.expenses.map(e => `<div class="item" style="cursor:default"><div class="grow"><div class="t">${esc(e.description || 'Expense')}</div><div class="s">${esc(String(e.incurred_on).slice(0, 10))}</div></div><b>${money(e.amount)}</b></div>`).join('')}</div>
    <form id="exp" class="row wrap" style="margin-top:10px"><input name="description" placeholder="Dump fee, materials…" style="flex:2;min-width:140px"><input name="amount" placeholder="0.00" inputmode="decimal" style="flex:1;min-width:90px" required><button class="btn small main" type="submit">Add</button></form></section></div></div>`;
}
