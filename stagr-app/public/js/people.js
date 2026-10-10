import { S, esc, get, post, put, del, money, phoneFmt, fmtDate, fmtDT, ago, statusChip, chip, empty, toast, hooks, modal, debounce, $, $$ } from './core.js';
import { newQuoteModal, newInvoiceModal } from './sales.js';
import { newJobModal } from './work.js';

const CONSENT = 'Only tick this if the customer agreed to get text messages from your business (for example, they said yes on the phone or ticked a box). Every promotional text includes “Reply STOP to opt out.”';
export function newCustomerModal(prefill = {}, then) {
  modal(`<h2>New customer</h2><form class="col" id="cf">
    <div class="grid g2"><label class="field"><span>Name</span><input name="name" required value="${esc(prefill.name || '')}"></label><label class="field"><span>Company (optional)</span><input name="company"></label></div>
    <div class="grid g2"><label class="field"><span>Phone</span><input name="phone" inputmode="tel" value="${esc(prefill.phone || '')}"></label><label class="field"><span>Email</span><input name="email" type="email" value="${esc(prefill.email || '')}"></label></div>
    <label class="field"><span>Service address</span><input name="address" value="${esc(prefill.address || '')}"></label>
    <div class="grid g3"><label class="field"><span>City</span><input name="city" value="${esc(S.business.city || '')}"></label><label class="field"><span>State</span><input name="state" maxlength="2" value="${esc(S.business.state || '')}"></label><label class="field"><span>ZIP</span><input name="zip"></label></div>
    <label class="field"><span>Notes</span><textarea name="notes"></textarea></label>
    <label class="row small" style="align-items:flex-start"><input type="checkbox" name="sms"> <span class="mute">This customer agreed to get texts. ${esc(CONSENT)}</span></label>
    <div class="row"><button class="btn main" type="submit">Save customer</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (el, close) => {
    $('#cf', el).addEventListener('submit', async e => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try { const r = await post('/customers', { name: f.name, company: f.company, phone: f.phone, email: f.email, notes: f.notes, source: 'manual', sms_opt_in: !!f.sms, property: f.address ? { address: f.address, city: f.city, state: f.state, zip: f.zip } : null });
        close(); toast('Customer saved'); if (then) then(r.customer); else location.hash = '#/customers/' + r.customer.id; } catch (err) { toast(err.message, true); }
    });
  });
}

export async function customersView() {
  const main = document.getElementById('main');
  const draw = async q => {
    const { customers } = await get('/customers?q=' + encodeURIComponent(q || '')), el = $('#clist');
    el.innerHTML = customers.length ? customers.map(c => `<a class="item" href="#/customers/${c.id}"><div class="grow"><div class="t">${esc(c.name)}${c.company ? ' · ' + esc(c.company) : ''}</div><div class="s">${esc(phoneFmt(c.phone) || c.email || 'No contact info')}${c.last_visit ? ' · last visit ' + esc(fmtDate(c.last_visit)) : ''}</div></div>${c.sms_opt_in ? chip('texts ok', 'ok') : ''}</a>`).join('') : empty(q ? 'No one matches that search.' : 'No customers yet. Add your first customer to get started.');
  };
  setTimeout(() => { draw(''); $('#q', main).addEventListener('input', debounce(e => draw(e.target.value.trim()), 250)); $('#addC', main).addEventListener('click', () => newCustomerModal()); }, 0);
  return `<div class="top"><h1>Customers</h1><button class="btn main" id="addC">+ New customer</button></div><label class="field" style="margin-bottom:12px"><input id="q" type="search" placeholder="Search name, phone, email…" aria-label="Search customers"></label><div class="list" id="clist"><p class="mute">Loading…</p></div>`;
}

export async function customerView(id) {
  const d = await get('/customers/' + id), c = d.customer, main = document.getElementById('main'), cust = c;
  const act = d.activity.length ? `<div class="tl">${d.activity.slice(0, 30).map(a => `<div>${esc(a.text)}<br><small>${esc(fmtDT(a.at))}</small></div>`).join('')}</div>` : '<p class="mute small">Nothing yet.</p>';
  setTimeout(() => {
    $('#newQuote', main).addEventListener('click', () => newQuoteModal(c.id)); $('#newJob', main).addEventListener('click', () => newJobModal(c.id)); $('#newInv', main).addEventListener('click', () => newInvoiceModal(c.id));
    $('#editC', main).addEventListener('click', () => editCustomer(d)); $('#addProp', main).addEventListener('click', () => propertyModal(c.id));
    $('#msg', main).addEventListener('click', () => messageModal(d));
    $$('[data-eprop]', main).forEach(b => b.addEventListener('click', () => propertyModal(c.id, d.properties.find(p => p.id == b.dataset.eprop))));
    $$('[data-sendq]', main).forEach(b => b.addEventListener('click', async () => { try { const r = await post('/quotes/' + b.dataset.sendq + '/send', {}); await navigator.clipboard?.writeText(r.link).catch(() => {}); toast('Quote sent. Link copied.'); hooks.refresh(); } catch (e) { toast(e.message, true); } }));
    $$('[data-copy]', main).forEach(b => b.addEventListener('click', async () => { await navigator.clipboard?.writeText(location.origin + b.dataset.copy).catch(() => {}); toast('Link copied'); }));
    $$('[data-editq]', main).forEach(b => b.addEventListener('click', () => newQuoteModal(c.id, d.quotes.find(q => q.id == b.dataset.editq))));
    $$('[data-jobq]', main).forEach(b => b.addEventListener('click', () => newJobModal(c.id, { quote: d.quotes.find(q => q.id == b.dataset.jobq) })));
  }, 0);
  return `<div class="top"><div><a class="small mute" href="#/customers">← Customers</a><h1>${esc(c.name)}</h1><div class="mute small">${c.company ? esc(c.company) + ' · ' : ''}${c.sms_opt_in ? chip('texts ok', 'ok') : chip('no text consent')} ${c.sms_opt_out_at && !c.sms_opt_in ? chip('opted out', 'bad') : ''}</div></div>
    <div class="row wrap"><button class="btn small" id="editC">Edit</button><button class="btn small" id="msg">Message</button><button class="btn small" id="newInv">Invoice</button><button class="btn small" id="newJob">Job</button><button class="btn main small" id="newQuote">+ Quote</button></div></div>
  <div class="grid g2" style="align-items:start"><div class="col">
    <section class="card"><h3>Contact</h3><div class="col" style="gap:6px">${c.phone ? `<div class="row between"><span>${esc(phoneFmt(c.phone))}</span><span class="row"><a class="btn small" href="tel:${esc(c.phone)}">Call</a><a class="btn small" href="sms:${esc(c.phone)}">Text</a></span></div>` : '<span class="mute small">No phone</span>'}${c.email ? `<div class="row between"><span>${esc(c.email)}</span><a class="btn small" href="mailto:${esc(c.email)}">Email</a></div>` : ''}${c.notes ? `<p class="small mute" style="white-space:pre-wrap;margin:6px 0 0">${esc(c.notes)}</p>` : ''}</div></section>
    <section class="card"><div class="row between"><h3>Properties</h3><button class="btn small" id="addProp">+ Add</button></div><div class="list">${d.properties.length ? d.properties.map(p => `<div class="item" data-eprop="${p.id}" role="button" tabindex="0"><div class="grow"><div class="t">${esc(p.address)}</div><div class="s">${esc([p.city, p.state, p.zip].filter(Boolean).join(', '))}${p.notes ? ' · ' + esc(p.notes) : ''}</div></div><span class="mute small">Edit</span></div>`).join('') : empty('No property yet.')}</div></section>
    <section class="card"><h3>Quotes</h3><div class="list">${d.quotes.length ? d.quotes.map(q => `<div class="item"><div class="grow"><div class="t"><a href="#/quotes/${q.id}" style="text-decoration:none">${esc(q.title || q.label)}</a> · ${money(q.total)} ${statusChip(q.status)}</div><div class="s">${q.status === 'approved' ? 'Approved by ' + esc(q.signed_name) : q.viewed_at ? 'Viewed ' + esc(ago(q.viewed_at)) : q.sent_at ? 'Sent ' + esc(ago(q.sent_at)) : 'Draft'}</div></div>
      <div class="row wrap">${q.status === 'approved' ? `<button class="btn small main" data-jobq="${q.id}">Schedule job</button>` : `<button class="btn small" data-editq="${q.id}">Edit</button><button class="btn small main" data-sendq="${q.id}">${q.sent_at ? 'Resend' : 'Send'}</button>`}${q.sent_at ? `<button class="btn small" data-copy="/q/${esc(q.token)}">Copy link</button>` : ''}</div></div>`).join('') : empty('No quotes yet.')}</div></section></div>
  <div class="col"><section class="card"><h3>Jobs</h3><div class="list">${d.jobs.length ? d.jobs.map(j => `<a class="item" href="#/jobs/${j.id}"><div class="grow"><div class="t">J-${j.number} · ${esc(j.title)}</div><div class="s">${j.next_visit ? 'Next: ' + esc(fmtDT(j.next_visit)) : j.status === 'completed' ? 'Completed' : 'No upcoming visit'}${j.recurrence ? ' · repeats ' + esc(j.recurrence.freq) : ''}</div></div>${statusChip(j.status)}</a>`).join('') : empty('No jobs yet.')}</div></section>
    <section class="card"><h3>Invoices</h3><div class="list">${d.invoices.length ? d.invoices.map(i => `<a class="item" href="#/invoices/${i.id}"><div class="grow"><div class="t">${esc(i.label)} · ${money(i.total)}</div><div class="s">${i.balance > 0 ? money(i.balance) + ' due' : 'Paid in full'}</div></div>${statusChip(i.status)}</a>`).join('') : empty('No invoices yet.')}</div></section>
    <section class="card"><h3>Messages</h3><div class="list">${d.messages.length ? d.messages.slice(0, 8).map(m => `<div class="item" style="align-items:flex-start"><div class="grow"><div class="s" style="white-space:normal">${esc(m.body)}</div><div class="s">${esc(m.channel)} · ${esc(fmtDT(m.created_at))}${m.status === 'blocked' ? ' · ' + esc(m.error || 'blocked') : ''}</div></div>${statusChip(m.status)}</div>`).join('') : empty('No messages yet.')}</div></section>
    <section class="card"><h3>Activity</h3>${act}</section></div></div>`;
}
function editCustomer(d) {
  const c = d.customer;
  modal(`<h2>Edit customer</h2><form class="col" id="ef"><div class="grid g2"><label class="field"><span>Name</span><input name="name" required value="${esc(c.name)}"></label><label class="field"><span>Company</span><input name="company" value="${esc(c.company)}"></label></div>
    <div class="grid g2"><label class="field"><span>Phone</span><input name="phone" value="${esc(c.phone)}"></label><label class="field"><span>Email</span><input name="email" type="email" value="${esc(c.email)}"></label></div>
    <label class="field"><span>Notes</span><textarea name="notes">${esc(c.notes)}</textarea></label>
    <label class="row small" style="align-items:flex-start"><input type="checkbox" name="sms" ${c.sms_opt_in ? 'checked' : ''}> <span class="mute">Agreed to get texts. ${esc(CONSENT)}</span></label>
    <div class="row between wrap"><div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div><button class="btn small warn" type="button" id="arch">Archive customer</button></div></form>`, (el, close) => {
    $('#ef', el).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await put('/customers/' + c.id, { name: f.name, company: f.company, phone: f.phone, email: f.email, notes: f.notes, sms_opt_in: !!f.sms }); close(); hooks.refresh(); } catch (err) { toast(err.message, true); } });
    $('#arch', el).addEventListener('click', async () => { if (!confirm('Archive this customer? You can still find them in your records.')) return; await put('/customers/' + c.id, { archived: true }); close(); location.hash = '#/customers'; });
  });
}
function propertyModal(customerId, p) {
  modal(`<h2>${p ? 'Edit' : 'Add'} property</h2><form class="col" id="pf"><label class="field"><span>Address</span><input name="address" required value="${esc(p?.address || '')}"></label>
    <div class="grid g3"><label class="field"><span>City</span><input name="city" value="${esc(p?.city || S.business.city || '')}"></label><label class="field"><span>State</span><input name="state" maxlength="2" value="${esc(p?.state || S.business.state || '')}"></label><label class="field"><span>ZIP</span><input name="zip" value="${esc(p?.zip || '')}"></label></div>
    <label class="field"><span>Notes (gate codes, pets, parking)</span><textarea name="notes">${esc(p?.notes || '')}</textarea></label>
    <div class="row between"><div class="row"><button class="btn main" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>${p ? '<button class="btn small warn" type="button" id="delp">Delete</button>' : ''}</div></form>`, (el, close) => {
    $('#pf', el).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { p ? await put('/properties/' + p.id, f) : await post('/customers/' + customerId + '/properties', f); close(); hooks.refresh(); } catch (err) { toast(err.message, true); } });
    $('#delp', el)?.addEventListener('click', async () => { if (!confirm('Delete this property?')) return; await del('/properties/' + p.id); close(); hooks.refresh(); });
  });
}
function messageModal(d) {
  const c = d.customer;
  modal(`<h2>Message ${esc(c.name.split(' ')[0])}</h2><form class="col" id="mf"><div class="seg" role="group" aria-label="Channel"><button type="button" data-ch="sms" aria-pressed="true">Text</button><button type="button" data-ch="email" aria-pressed="false">Email</button></div>
    <label class="field hidden" id="subjF"><span>Subject</span><input name="subject"></label><label class="field"><span>Message</span><textarea name="body" required maxlength="800"></textarea></label>
    <label class="row small"><input type="checkbox" name="promo"> <span class="mute">This is a promotion or offer (needs the customer's text consent)</span></label>
    <p class="small mute" style="margin:0" id="mnote"></p><div class="row"><button class="btn main" type="submit">Send</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (el, close) => {
    let ch = 'sms'; const note = () => { $('#mnote', el).textContent = ch === 'sms' ? (c.phone ? '' : 'This customer has no phone number.') : (c.email ? '' : 'This customer has no email address.'); };
    $$('[data-ch]', el).forEach(b => b.addEventListener('click', () => { ch = b.dataset.ch; $$('[data-ch]', el).forEach(x => x.setAttribute('aria-pressed', String(x === b))); $('#subjF', el).classList.toggle('hidden', ch !== 'email'); note(); })); note();
    $('#mf', el).addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { const r = await post('/messages', { customer_id: c.id, channel: ch, body: f.body, subject: f.subject, promo: !!f.promo }); close(); toast(r.message.status === 'preview' ? 'Saved as a preview. Connect texting to send it for real.' : r.message.status === 'blocked' ? 'Not sent: ' + r.message.error : 'Sent'); hooks.refresh(); } catch (err) { toast(err.message, true); } });
  });
}
