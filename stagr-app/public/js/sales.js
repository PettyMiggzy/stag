import { S, esc, get, post, put, del, money, money0, fmtDate, fmtDateOnly, fmtDT, ago, statusChip, chip, empty, toast, hooks, modal, shrinkImage, $, $$ } from './core.js';
import { newCustomerModal } from './people.js';

const totals = (items, disc, tax) => { const sub = Math.round(items.filter(i => i.kind !== 'text' && (!i.optional || i.selected)).reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100, d = Math.round(sub * Math.min(100, Math.max(0, disc || 0))) / 100, t = Math.round((sub - d) * Math.min(30, Math.max(0, tax || 0))) / 100; return { sub, d, t, total: Math.round((sub - d + t) * 100) / 100 }; };
const lineRow = (i = { kind: 'item', name: '', description: '', qty: 1, price: '', optional: false, selected: true, image: '' }) => i.kind === 'text'
  ? `<div class="line text" data-line data-kind="text"><div class="col" style="gap:6px;grid-column:1/4"><input data-f="name" placeholder="Section heading (optional)" value="${esc(i.name)}" aria-label="Heading"><textarea data-f="description" placeholder="Words only: terms, scope, notes for the customer" aria-label="Text">${esc(i.description || '')}</textarea></div><button type="button" class="btn small" data-rm aria-label="Remove section" style="padding:0">×</button></div>`
  : `<div class="line" data-line data-kind="item"><div class="col" style="gap:6px"><input data-f="name" list="svc" placeholder="Item or service" value="${esc(i.name)}" aria-label="Item name"><input data-f="description" placeholder="Details (optional)" value="${esc(i.description || '')}" aria-label="Details">
    <div class="row wrap small"><label class="row" style="gap:6px"><input type="checkbox" data-f="optional" ${i.optional ? 'checked' : ''}> Optional add-on</label><label class="row ${i.optional ? '' : 'hidden'}" data-selwrap style="gap:6px"><input type="checkbox" data-f="selected" ${i.selected ? 'checked' : ''}> Pre-selected</label>
    <label class="btn small" style="min-height:30px;padding:2px 10px"><input type="file" accept="image/*" data-photo class="hidden"> ${i.image ? 'Change photo' : '+ Photo'}</label>${i.image ? `<img data-img src="${esc(i.image)}" alt="" style="width:34px;height:34px;object-fit:cover;border-radius:6px"><button type="button" class="btn small" data-rmimg style="min-height:30px;padding:2px 8px">Remove photo</button>` : ''}</div></div>
    <input data-f="qty" inputmode="decimal" value="${esc(i.qty)}" aria-label="Quantity"><input data-f="price" inputmode="decimal" placeholder="0.00" value="${esc(i.price)}" aria-label="Price"><button type="button" class="btn small" data-rm aria-label="Remove line" style="padding:0">×</button></div>`;
// Shared editor for the line items of a quote or an invoice.
function editor(el, initial, allowExtras = true) {
  const box = $('#lines', el);
  box.innerHTML = (initial.items && initial.items.length ? initial.items : [undefined]).map(lineRow).join('');
  const rowItem = r => r.dataset.kind === 'text' ? { kind: 'text', name: $('[data-f=name]', r).value.trim(), description: $('[data-f=description]', r).value.trim() }
    : { kind: 'item', name: $('[data-f=name]', r).value.trim(), description: $('[data-f=description]', r).value.trim(), qty: Number($('[data-f=qty]', r).value) || 1, price: Number(String($('[data-f=price]', r).value).replace(/[$,]/g, '')) || 0,
        optional: $('[data-f=optional]', r).checked, selected: $('[data-f=selected]', r).checked, image: r.dataset.image ?? ($('[data-img]', r)?.getAttribute('src') || '') };
  const read = () => $$('[data-line]', box).map(rowItem).filter(i => i.kind === 'text' ? (i.name || i.description) : (i.name || i.price));
  const calc = () => { const t = totals(read(), Number($('#disc', el).value), Number($('#tax', el).value)); $('#tot', el).innerHTML = `<div><span class="mute">Subtotal</span><span>${money(t.sub)}</span></div>${t.d ? `<div><span class="mute">Discount</span><span>−${money(t.d)}</span></div>` : ''}${t.t ? `<div><span class="mute">Tax</span><span>${money(t.t)}</span></div>` : ''}<div class="big"><span>Total</span><span>${money(t.total)}</span></div>`; box.dispatchEvent(new CustomEvent('recalc', { detail: t })); };
  box.addEventListener('input', e => { calc(); const r = e.target.closest('[data-line]'); if (e.target.dataset.f === 'optional') $('[data-selwrap]', r).classList.toggle('hidden', !e.target.checked); if (e.target.dataset.f === 'name' && r && r.dataset.kind === 'item') { const s = S.services.find(x => x.name === e.target.value); if (s) { const p = $('[data-f=price]', r); if (!p.value) p.value = s.unit_price; if (!$('[data-f=description]', r).value) $('[data-f=description]', r).value = s.description; calc(); } } });
  box.addEventListener('change', async e => { if (!e.target.matches('[data-photo]')) return; const r = e.target.closest('[data-line]'), f = e.target.files[0]; if (!f) return; try { r.dataset.image = await shrinkImage(f, 700, 0.7); toast('Photo added'); const it = rowItem(r); const idx = $$('[data-line]', box).indexOf(r); r.outerHTML = lineRow({ ...it, image: r.dataset.image }); } catch (err) { toast(err.message, true); } });
  box.addEventListener('click', e => { if (e.target.closest('[data-rmimg]')) { const r = e.target.closest('[data-line]'), it = rowItem(r); r.outerHTML = lineRow({ ...it, image: '' }); return; }
    if (e.target.closest('[data-rm]')) { const r = e.target.closest('[data-line]'); if ($$('[data-line]', box).length > 1) r.remove(); else $$('input:not([type=checkbox]),textarea', r).forEach(i => { i.value = i.dataset.f === 'qty' ? 1 : ''; }); calc(); } });
  $('#addLine', el).addEventListener('click', () => { box.insertAdjacentHTML('beforeend', lineRow()); $$('[data-line]', box).at(-1).querySelector('input').focus(); });
  $('#addText', el)?.addEventListener('click', () => { box.insertAdjacentHTML('beforeend', lineRow({ kind: 'text', name: '', description: '' })); $$('[data-line]', box).at(-1).querySelector('input').focus(); });
  ['disc', 'tax'].forEach(id => $('#' + id, el).addEventListener('input', calc)); calc();
  return read;
}
const svcList = () => `<datalist id="svc">${S.services.map(s => `<option value="${esc(s.name)}">`).join('')}</datalist>`;
// Pick an existing customer (and one of their properties) inside a modal.
async function customerPicker(el, customerId, propertyId) {
  const { customers } = await get('/customers'), sel = $('#cust', el), psel = $('#prop', el);
  const loadProps = async id => { if (!id) { psel.innerHTML = '<option value="">—</option>'; return; } const d = await get('/customers/' + id); psel.innerHTML = '<option value="">No property</option>' + d.properties.map(p => `<option value="${p.id}" ${p.id == propertyId ? 'selected' : ''}>${esc(p.address)}</option>`).join(''); if (!propertyId && d.properties.length === 1) psel.value = d.properties[0].id; };
  sel.innerHTML = '<option value="">Choose a customer…</option>' + customers.map(c => `<option value="${c.id}" ${c.id == customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + '<option value="new">+ New customer…</option>';
  sel.addEventListener('change', () => { if (sel.value === 'new') { sel.value = ''; newCustomerModal({}, async c => { sel.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name)}</option>`); sel.value = c.id; await loadProps(c.id); }); } else loadProps(sel.value); });
  await loadProps(customerId || '');
}
const stars = (n, id = 'rate') => [1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" aria-label="${i} star${i > 1 ? 's' : ''}" style="all:unset;cursor:pointer;font-size:1.5rem;line-height:1;color:${i <= n ? '#f0c419' : '#3a4a41'}">★</button>`).join('');
export function newQuoteModal(customerId, quote, prefill = {}) {
  const team = S.team.filter(t => t.active);
  modal(`${svcList()}<h2>${quote ? 'Edit ' + esc(quote.label) : 'New quote'}</h2><form id="qf" class="col">
    <label class="field"><span>Quote title</span><input id="qtitle" placeholder="Weekly cleaning, deck repair…" value="${esc(quote?.title || prefill.title || '')}" maxlength="120"></label>
    <div class="grid g2"><label class="field"><span>Customer</span><select id="cust" ${quote ? 'disabled' : ''}></select></label><label class="field"><span>Property</span><select id="prop"></select></label></div>
    <div class="grid g3"><div class="field"><span>Rate this opportunity</span><div class="row" id="stars" style="gap:2px;min-height:42px">${stars(quote?.rating || 0)}</div></div>
      <label class="field"><span>Salesperson</span><select id="sales"><option value="">—</option>${team.map(t => `<option value="${t.id}" ${t.id === (quote ? quote.salesperson_id : S.user.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Remind me to follow up on</span><input id="remind" type="date" value="${esc(String(quote?.reminder_date || '').slice(0, 10))}"></label></div>
    <div class="lines" id="lines"></div><div class="row wrap"><button type="button" class="btn small" id="addLine">+ Add a line</button><button type="button" class="btn small" id="addText">+ Add text section</button></div>
    <p class="small mute" style="margin:0">Tick “Optional add-on” on a line to let the customer choose it. “Pre-selected” adds it to their total until they untick it.</p>
    <div class="grid g3"><label class="field"><span>Discount %</span><input id="disc" inputmode="decimal" value="${esc(quote ? Number(quote.discount_pct) : 0)}"></label><label class="field"><span>Tax %</span><input id="tax" inputmode="decimal" value="${esc(quote ? Number(quote.tax_pct) : S.business.tax_pct)}"></label>
      <div class="field"><span>Required deposit</span><div class="row"><select id="deptype" style="width:64px;flex:none"><option value="$" ${Number(quote?.deposit_pct) > 0 ? '' : 'selected'}>$</option><option value="%" ${Number(quote?.deposit_pct) > 0 ? 'selected' : ''}>%</option></select><input id="dep" inputmode="decimal" value="${esc(Number(quote?.deposit_pct) > 0 ? Number(quote.deposit_pct) : quote ? Number(quote.deposit) : 0)}"></div></div></div>
    <div class="totals" id="tot"></div><p class="small mute right" id="depnote" style="margin:0"></p><label class="field"><span>Message to the customer</span><textarea id="qmsg" placeholder="Thanks for the chance to work with you!">${esc(quote?.message || '')}</textarea></label>
    <div class="row wrap"><button class="btn main" type="submit" data-send="1">Save and send</button><button class="btn" type="submit">Save as draft</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, async (el, close) => {
    await customerPicker(el, customerId || quote?.customer_id, quote?.property_id); const items0 = quote?.items || prefill.items; const read = editor(el, { items: items0 });
    let rating = quote?.rating || 0; $('#stars', el).addEventListener('click', e => { const b = e.target.closest('[data-star]'); if (!b) return; const n = Number(b.dataset.star); rating = rating === n ? 0 : n; $('#stars', el).innerHTML = stars(rating); });
    const depNote = () => { const t = totals(read(), Number($('#disc', el).value), Number($('#tax', el).value)), v = Number($('#dep', el).value) || 0, due = $('#deptype', el).value === '%' ? Math.round(t.total * v) / 100 : v; $('#depnote', el).textContent = due > 0 ? `Customer owes a deposit of ${money(due)} to begin.` : ''; };
    $('#lines', el).addEventListener('recalc', depNote); $('#dep', el).addEventListener('input', depNote); $('#deptype', el).addEventListener('change', depNote); depNote();
    let send = false; $$('button[type=submit]', el).forEach(b => b.addEventListener('click', () => { send = !!b.dataset.send; }));
    $('#qf', el).addEventListener('submit', async e => { e.preventDefault(); const items = read(); if (!$('#cust', el).value) return toast('Choose a customer', true); if (!items.some(i => i.kind !== 'text')) return toast('Add at least one line', true);
      const pct = $('#deptype', el).value === '%';
      const body = { customer_id: Number($('#cust', el).value), property_id: $('#prop', el).value || null, request_id: prefill.request_id, title: $('#qtitle', el).value, rating, salesperson_id: $('#sales', el).value || null, reminder_date: $('#remind', el).value || null,
        items, discount_pct: $('#disc', el).value, tax_pct: $('#tax', el).value, deposit: pct ? 0 : $('#dep', el).value, deposit_pct: pct ? $('#dep', el).value : 0, message: $('#qmsg', el).value };
      try { const r = quote ? await put('/quotes/' + quote.id, body) : await post('/quotes', body); let msg = 'Quote saved';
        if (send) { const s = await post('/quotes/' + r.quote.id + '/send', {}); await navigator.clipboard?.writeText(s.link).catch(() => {}); msg = 'Quote sent. The link is copied.'; }
        close(); toast(msg); if (quote) hooks.refresh(); else location.hash = '#/quotes/' + r.quote.id; } catch (err) { toast(err.message, true); }
    });
  });
}
export function newInvoiceModal(customerId, invoice, prefill = {}) {
  modal(`${svcList()}<h2>${invoice ? 'Edit ' + esc(invoice.label) : 'New invoice'}</h2><form id="qf" class="col">
    <div class="grid g2"><label class="field"><span>Customer</span><select id="cust" ${invoice ? 'disabled' : ''}></select></label><label class="field"><span>Due date</span><input id="due" type="date" value="${esc(String(invoice?.due_date || '').slice(0, 10))}"></label></div><select id="prop" class="hidden"></select>
    <div class="lines" id="lines"></div><div class="row wrap"><button type="button" class="btn small" id="addLine">+ Add a line</button></div>
    <div class="grid g2"><label class="field"><span>Discount %</span><input id="disc" inputmode="decimal" value="${esc(invoice ? Number(invoice.discount_pct) : 0)}"></label><label class="field"><span>Tax %</span><input id="tax" inputmode="decimal" value="${esc(invoice ? Number(invoice.tax_pct) : S.business.tax_pct)}"></label></div>
    <div class="totals" id="tot"></div><label class="field"><span>Note on the invoice</span><textarea id="qmsg">${esc(invoice?.message || '')}</textarea></label>
    <div class="row wrap"><button class="btn main" type="submit" data-send="1">Save and send</button><button class="btn" type="submit">Save as draft</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, async (el, close) => {
    await customerPicker(el, customerId || invoice?.customer_id); const read = editor(el, { items: invoice?.items || prefill.items });
    let send = false; $$('button[type=submit]', el).forEach(b => b.addEventListener('click', () => { send = !!b.dataset.send; }));
    $('#qf', el).addEventListener('submit', async e => { e.preventDefault(); const items = read(); if (!$('#cust', el).value) return toast('Choose a customer', true); if (!items.length) return toast('Add at least one line', true);
      const body = { customer_id: Number($('#cust', el).value), items, discount_pct: $('#disc', el).value, tax_pct: $('#tax', el).value, due_date: $('#due', el).value, message: $('#qmsg', el).value, job_id: prefill.job_id, quote_id: prefill.quote_id };
      try { const r = invoice ? await put('/invoices/' + invoice.id, body) : await post('/invoices', body); let msg = 'Invoice saved';
        if (send) { const s = await post('/invoices/' + r.invoice.id + '/send', {}); await navigator.clipboard?.writeText(s.link).catch(() => {}); msg = 'Invoice sent. The link is copied.'; }
        close(); toast(msg); if (invoice) hooks.refresh(); else location.hash = '#/invoices/' + r.invoice.id; } catch (err) { toast(err.message, true); }
    });
  });
}

export async function quotesView() {
  const { quotes } = await get('/quotes'), main = document.getElementById('main');
  setTimeout(() => { $('#nq', main).addEventListener('click', () => newQuoteModal()); }, 0);
  const groups = [['Waiting on the customer', q => q.status === 'sent'], ['Approved', q => q.status === 'approved'], ['Drafts', q => q.status === 'draft'], ['Declined', q => q.status === 'declined']];
  return `<div class="top"><h1>Quotes</h1><button class="btn main" id="nq">+ New quote</button></div>${quotes.length ? groups.map(([t, f]) => { const rows = quotes.filter(f); return rows.length ? `<h3 class="mono" style="margin:16px 0 8px">${t} · ${rows.length}</h3><div class="list">${rows.map(q => `<a class="item" href="#/quotes/${q.id}"><div class="grow"><div class="t">${esc(q.customer_name)} · ${esc(q.title || q.label)}</div><div class="s">${esc(q.label)} · ${q.status === 'approved' ? 'Approved ' + esc(fmtDate(q.decided_at)) : q.viewed_at ? 'Viewed ' + esc(ago(q.viewed_at)) : q.sent_at ? 'Sent ' + esc(ago(q.sent_at)) : 'Created ' + esc(ago(q.created_at))}</div></div><b>${money(q.total)}</b></a>`).join('')}</div>` : ''; }).join('') : empty('No quotes yet. Quote a customer and they can approve it from their phone.')}`;
}
export async function invoicesView() {
  const { invoices } = await get('/invoices'), main = document.getElementById('main'), today = new Date().toISOString().slice(0, 10);
  setTimeout(() => { $('#ni', main).addEventListener('click', () => newInvoiceModal()); $('#csv', main).addEventListener('click', () => { location.href = '/api/export/invoices.csv'; }); }, 0);
  const due = invoices.filter(i => ['sent', 'partial'].includes(i.status)), over = due.filter(i => i.due_date && String(i.due_date).slice(0, 10) < today);
  const rows = list => list.map(i => `<a class="item" href="#/invoices/${i.id}"><div class="grow"><div class="t">${esc(i.customer_name)} · ${esc(i.label)}</div><div class="s">${i.status === 'paid' ? 'Paid ' + esc(fmtDate(i.paid_at)) : 'Due ' + esc(String(i.due_date || '').slice(0, 10))}</div></div><div class="right"><b>${money(i.status === 'paid' ? i.total : i.balance || i.total)}</b><div>${statusChip(i.status)}</div></div></a>`).join('');
  return `<div class="top"><h1>Invoices</h1><div class="row"><button class="btn small" id="csv">Export CSV</button><button class="btn main" id="ni">+ New invoice</button></div></div>
  <div class="grid g3 keep2" style="margin-bottom:14px"><div class="stat"><span class="mono">To collect</span><b>${money0(due.reduce((a, i) => a + i.balance, 0))}</b></div><div class="stat ${over.length ? 'bad' : ''}"><span class="mono">Overdue</span><b>${money0(over.reduce((a, i) => a + i.balance, 0))}</b></div><div class="stat hot"><span class="mono">Paid</span><b>${invoices.filter(i => i.status === 'paid').length}</b></div></div>
  ${invoices.length ? `<div class="list">${rows(invoices.filter(i => i.status !== 'void'))}</div>` : empty('No invoices yet. When a job is done, turn it into an invoice in one tap.')}`;
}
export async function invoiceView(id) {
  const { invoice: i } = await get('/invoices/' + id), cd = await get('/customers/' + i.customer_id), c = cd.customer, main = document.getElementById('main');
  const link = location.origin + '/i/' + i.token;
  setTimeout(() => {
    $('#pay', main)?.addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await post('/invoices/' + i.id + '/payments', f); toast('Payment recorded'); hooks.refresh(); } catch (err) { toast(err.message, true); } });
    $('#sendI', main)?.addEventListener('click', async () => { try { const r = await post('/invoices/' + i.id + '/send', {}); await navigator.clipboard?.writeText(r.link).catch(() => {}); toast('Invoice sent. Link copied.'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#copyI', main)?.addEventListener('click', async () => { await navigator.clipboard?.writeText(link).catch(() => {}); toast('Link copied'); });
    $('#editI', main)?.addEventListener('click', () => newInvoiceModal(c.id, i));
    $('#voidI', main)?.addEventListener('click', async () => { if (!confirm('Void this invoice?')) return; try { await post('/invoices/' + i.id + '/void'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
  }, 0);
  return `<div class="top"><div><a class="small mute" href="#/invoices">← Invoices</a><h1>${esc(i.label)} ${statusChip(i.status)}</h1><div class="mute small"><a href="#/customers/${c.id}">${esc(c.name)}</a> · due ${esc(String(i.due_date || '').slice(0, 10))}</div></div>
    <div class="row wrap">${i.status !== 'void' ? `<button class="btn small" id="editI">Edit</button><button class="btn small" id="copyI">Copy link</button><button class="btn main small" id="sendI">${i.sent_at ? 'Resend' : 'Send to customer'}</button>` : ''}${i.status !== 'void' && !i.payments.length ? '<button class="btn small warn" id="voidI">Void</button>' : ''}</div></div>
  <div class="grid g2" style="align-items:start"><section class="card"><h3>Items</h3><div class="list">${i.items.map(l => `<div class="item" style="cursor:default"><div class="grow"><div class="t">${esc(l.name)}</div>${l.description ? `<div class="s">${esc(l.description)}</div>` : ''}<div class="s">${esc(l.qty)} × ${money(l.price)}</div></div><b>${money(l.qty * l.price)}</b></div>`).join('')}</div>
    <div class="totals"><div><span class="mute">Subtotal</span><span>${money(i.subtotal)}</span></div>${i.discount ? `<div><span class="mute">Discount</span><span>−${money(i.discount)}</span></div>` : ''}${i.tax ? `<div><span class="mute">Tax</span><span>${money(i.tax)}</span></div>` : ''}<div><span class="mute">Paid</span><span>${money(i.paid)}</span></div><div class="big"><span>Balance</span><span>${money(i.balance)}</span></div></div></section>
  <section class="card"><h3>Payments</h3><div class="list">${i.payments.length ? i.payments.map(p => `<div class="item" style="cursor:default"><div class="grow"><div class="t">${money(p.amount)} · ${esc(p.method)}</div><div class="s">${esc(fmtDate(p.at))}${p.note ? ' · ' + esc(p.note) : ''}</div></div></div>`).join('') : empty('No payments yet.')}</div>
    ${i.balance > 0 && i.status !== 'void' ? `<hr class="sep"><form id="pay" class="col"><h3 style="margin:0">Record a payment</h3><div class="grid g2"><label class="field"><span>Amount</span><input name="amount" inputmode="decimal" required value="${i.balance.toFixed(2)}"></label><label class="field"><span>Method</span><select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="zelle">Zelle</option><option value="card">Card (terminal)</option><option value="bank">Bank transfer</option><option value="other">Other</option></select></label></div><label class="field"><span>Note</span><input name="note" placeholder="Check #, who paid…"></label><button class="btn main" type="submit">Record payment</button></form>` : ''}
    ${i.message ? `<hr class="sep"><p class="small mute" style="white-space:pre-wrap">${esc(i.message)}</p>` : ''}</section></div>`;
}

// Quote detail, laid out like Jobber's: status, Convert to Job / Edit / More, a details panel and the lines.
export async function quoteView(id) {
  const { quote: q } = await get('/quotes/' + id), cd = await get('/customers/' + q.customer_id), c = cd.customer, prop = cd.properties.find(p => p.id === q.property_id), main = document.getElementById('main');
  const sp = S.team.find(t => t.id === q.salesperson_id), link = location.origin + '/q/' + q.token, today = new Date().toISOString().slice(0, 10);
  const showItems = q.items;
  setTimeout(() => {
    $('#edit', main).addEventListener('click', () => newQuoteModal(c.id, q));
    $('#send', main).addEventListener('click', async () => { try { const r = await post('/quotes/' + q.id + '/send', {}); await navigator.clipboard?.writeText(r.link).catch(() => {}); toast('Quote sent. Link copied.'); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#copy', main)?.addEventListener('click', async () => { await navigator.clipboard?.writeText(link).catch(() => {}); toast('Link copied'); });
    $('#toJob', main)?.addEventListener('click', () => import('./work.js').then(m => m.newJobModal(c.id, { quote: q })));
    $('#toInv', main)?.addEventListener('click', () => newInvoiceModal(c.id, null, { quote_id: q.id }));
    $('#dep', main)?.addEventListener('click', async () => { const m = prompt('How was the deposit paid? (cash, check, zelle, card)', 'cash'); if (m === null) return; try { await post('/quotes/' + q.id + '/deposit-paid', { method: m }); hooks.refresh(); } catch (e) { toast(e.message, true); } });
    $('#undep', main)?.addEventListener('click', async () => { await post('/quotes/' + q.id + '/deposit-paid', { paid: false }); hooks.refresh(); });
    $('#del', main)?.addEventListener('click', async () => { if (!confirm('Delete this quote?')) return; try { await del('/quotes/' + q.id); location.hash = '#/quotes'; } catch (e) { toast(e.message, true); } });
    $$('.more', main).forEach(m => m.addEventListener('toggle', () => {}));
  }, 0);
  const row = (k, v) => `<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--line)"><span class="mute">${k}</span><span>${v}</span></div>`;
  return `<div class="top"><div><a class="small mute" href="#/quotes">← Quotes</a></div><div class="row wrap">${q.status === 'approved' ? '<button class="btn main" id="toJob">Convert to Job</button>' : ''}<button class="btn" id="edit" ${q.status === 'approved' ? 'disabled title="Approved quotes cannot be edited"' : ''}>Edit</button>
    <details class="more" style="position:relative"><summary class="btn" style="list-style:none">⋯ More actions</summary><div class="card" style="position:absolute;right:0;top:46px;z-index:20;min-width:210px;display:grid;gap:6px;padding:10px"><button class="btn small" id="send" style="justify-content:flex-start">${q.sent_at ? 'Resend to customer' : 'Send to customer'}</button>${q.sent_at ? '<button class="btn small" id="copy" style="justify-content:flex-start">Copy customer link</button>' : ''}<button class="btn small" id="toInv" style="justify-content:flex-start">Create invoice</button>${q.status !== 'approved' ? '<button class="btn small warn" id="del" style="justify-content:flex-start">Delete</button>' : ''}</div></details></div></div>
  <div class="card" style="border-top:4px solid ${q.status === 'approved' ? 'var(--accent)' : 'var(--warn)'}"><div class="row between wrap"><div>${statusChip(q.status)}</div><b class="mono" style="font-size:.9rem">Quote #${q.number - 1000}</b></div>
    <div class="grid g2" style="margin-top:12px;align-items:start"><div><h1 style="font-size:2.4rem;margin-bottom:4px">${esc(c.name)}</h1>${q.title ? `<div class="mute" style="margin-bottom:10px">${esc(q.title)}</div>` : ''}
      <div class="grid g2"><div><b class="small">Property address</b><div class="mute small">${prop ? esc(prop.address) + '<br>' + esc([prop.city, prop.state, prop.zip].filter(Boolean).join(' ')) : '—'}</div></div><div><b class="small">Contact details</b><div class="mute small">${esc(c.phone) || '—'}<br>${esc(c.email)}</div></div></div></div>
      <div><b class="small">Quote details</b>${row('Rating', q.rating ? '<span style="color:#f0c419;font-size:1.2rem">' + '★'.repeat(q.rating) + '</span><span style="color:#3a4a41;font-size:1.2rem">' + '★'.repeat(5 - q.rating) + '</span>' : '—')}${row('Reminder', q.reminder_date ? `<span style="${String(q.reminder_date).slice(0, 10) <= today && q.status === 'sent' ? 'color:var(--warn)' : ''}">${esc(fmtDateOnly(q.reminder_date))}</span>` : '—')}${row('Created', esc(fmtDate(q.created_at)))}${row('Sent', q.sent_at ? esc(fmtDate(q.sent_at)) : '—')}${row('Approved', q.decided_at && q.status === 'approved' ? esc(fmtDate(q.decided_at)) + ' by ' + esc(q.signed_name) : '—')}${row('Salesperson', sp ? esc(sp.name) : '—')}
        ${q.deposit_due > 0 ? row('Required deposit', `${money(q.deposit_due)} ${q.deposit_paid_at ? chip('paid', 'ok') + ` <button class="btn small" id="undep" style="min-height:26px;padding:0 8px">undo</button>` : `<button class="btn small main" id="dep" style="min-height:30px">Mark received</button>`}`) : ''}</div></div>
    <hr class="sep"><div class="mono" style="margin-bottom:8px">Product / Service</div>
    ${showItems.map(i => i.kind === 'text' ? `<div style="padding:10px 0;border-bottom:1px solid var(--line)">${i.name ? `<b>${esc(i.name)}</b><br>` : ''}<span class="mute" style="white-space:pre-wrap">${esc(i.description)}</span></div>`
      : `<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line);align-items:flex-start;gap:14px"><div class="grow"><b>${esc(i.name)}</b> ${i.optional ? chip(i.selected ? 'optional · included' : 'optional · not included', i.selected ? 'blue' : '') : ''}<div class="mute small" style="white-space:pre-wrap">${esc(i.description)}</div></div>${i.image ? `<img src="${esc(i.image)}" alt="" style="width:84px;height:60px;object-fit:cover;border-radius:8px">` : ''}<div class="right nowrap small mute">${esc(i.qty)} × ${money(i.price)}</div><b class="nowrap ${i.optional && !i.selected ? 'mute' : ''}" style="min-width:84px;text-align:right">${money(i.qty * i.price)}</b></div>`).join('')}
    <div class="totals"><div><span class="mute">Subtotal</span><span>${money(q.subtotal)}</span></div>${q.discount ? `<div><span class="mute">Discount (${Number(q.discount_pct)}%)</span><span>−${money(q.discount)}</span></div>` : ''}${q.tax ? `<div><span class="mute">Tax (${Number(q.tax_pct)}%)</span><span>${money(q.tax)}</span></div>` : ''}<div class="big"><span>Total</span><span>${money(q.total)}</span></div>${q.deposit_due > 0 ? `<div><span class="mute">Deposit required</span><span>${money(q.deposit_due)}</span></div>` : ''}</div>
    ${q.message ? `<hr class="sep"><p class="small mute" style="white-space:pre-wrap;margin:0">${esc(q.message)}</p>` : ''}${q.client_note ? `<hr class="sep"><p class="small" style="margin:0"><b>Customer note:</b> ${esc(q.client_note)}</p>` : ''}</div>`;
}
