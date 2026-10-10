import { S, esc, get, post, put, del, money, money0, fmtDate, fmtDT, ago, statusChip, chip, empty, toast, hooks, modal, $, $$ } from './core.js';
import { newCustomerModal } from './people.js';

const totals = (items, disc, tax) => { const sub = Math.round(items.reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100, d = Math.round(sub * Math.min(100, Math.max(0, disc || 0))) / 100, t = Math.round((sub - d) * Math.min(30, Math.max(0, tax || 0))) / 100; return { sub, d, t, total: Math.round((sub - d + t) * 100) / 100 }; };
const lineRow = (i = { name: '', description: '', qty: 1, price: '' }) => `<div class="line" data-line><div class="col" style="gap:6px"><input data-f="name" list="svc" placeholder="Item or service" value="${esc(i.name)}" aria-label="Item name"><input data-f="description" placeholder="Details (optional)" value="${esc(i.description || '')}" aria-label="Details"></div><input data-f="qty" inputmode="decimal" value="${esc(i.qty)}" aria-label="Quantity"><input data-f="price" inputmode="decimal" placeholder="0.00" value="${esc(i.price)}" aria-label="Price"><button type="button" class="btn small" data-rm aria-label="Remove line" style="padding:0">×</button></div>`;
// Shared editor for the line items of a quote or an invoice.
function editor(el, initial) {
  const box = $('#lines', el);
  box.innerHTML = (initial.items && initial.items.length ? initial.items : [undefined]).map(lineRow).join('');
  const read = () => $$('[data-line]', box).map(r => ({ name: $('[data-f=name]', r).value.trim(), description: $('[data-f=description]', r).value.trim(), qty: Number($('[data-f=qty]', r).value) || 1, price: Number(String($('[data-f=price]', r).value).replace(/[$,]/g, '')) || 0 })).filter(i => i.name || i.price);
  const calc = () => { const t = totals(read(), Number($('#disc', el).value), Number($('#tax', el).value)); $('#tot', el).innerHTML = `<div><span class="mute">Subtotal</span><span>${money(t.sub)}</span></div>${t.d ? `<div><span class="mute">Discount</span><span>−${money(t.d)}</span></div>` : ''}${t.t ? `<div><span class="mute">Tax</span><span>${money(t.t)}</span></div>` : ''}<div class="big"><span>Total</span><span>${money(t.total)}</span></div>`; };
  box.addEventListener('input', e => { calc(); const r = e.target.closest('[data-line]'); if (e.target.dataset.f === 'name' && r) { const s = S.services.find(x => x.name === e.target.value); if (s) { const p = $('[data-f=price]', r); if (!p.value) p.value = s.unit_price; if (!$('[data-f=description]', r).value) $('[data-f=description]', r).value = s.description; calc(); } } });
  box.addEventListener('click', e => { if (e.target.closest('[data-rm]')) { const r = e.target.closest('[data-line]'); if ($$('[data-line]', box).length > 1) r.remove(); else $$('input', r).forEach(i => { i.value = i.dataset.f === 'qty' ? 1 : ''; }); calc(); } });
  $('#addLine', el).addEventListener('click', () => { box.insertAdjacentHTML('beforeend', lineRow()); $$('[data-line]', box).at(-1).querySelector('input').focus(); });
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
export function newQuoteModal(customerId, quote) {
  modal(`${svcList()}<h2>${quote ? 'Edit ' + esc(quote.label) : 'New quote'}</h2><form id="qf" class="col">
    <div class="grid g2"><label class="field"><span>Customer</span><select id="cust" ${quote ? 'disabled' : ''}></select></label><label class="field"><span>Property</span><select id="prop"></select></label></div>
    <div class="lines" id="lines"></div><div class="row wrap"><button type="button" class="btn small" id="addLine">+ Add a line</button></div>
    <div class="grid g3"><label class="field"><span>Discount %</span><input id="disc" inputmode="decimal" value="${esc(quote ? Number(quote.discount_pct) : 0)}"></label><label class="field"><span>Tax %</span><input id="tax" inputmode="decimal" value="${esc(quote ? Number(quote.tax_pct) : S.business.tax_pct)}"></label><label class="field"><span>Deposit $</span><input id="dep" inputmode="decimal" value="${esc(quote ? Number(quote.deposit) : 0)}"></label></div>
    <div class="totals" id="tot"></div><label class="field"><span>Message to the customer</span><textarea id="qmsg" placeholder="Thanks for the chance to work with you!">${esc(quote?.message || '')}</textarea></label>
    <div class="row wrap"><button class="btn main" type="submit" data-send="1">Save and send</button><button class="btn" type="submit">Save as draft</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, async (el, close) => {
    await customerPicker(el, customerId || quote?.customer_id, quote?.property_id); const read = editor(el, { items: quote?.items });
    let send = false; $$('button[type=submit]', el).forEach(b => b.addEventListener('click', () => { send = !!b.dataset.send; }));
    $('#qf', el).addEventListener('submit', async e => { e.preventDefault(); const items = read(); if (!$('#cust', el).value) return toast('Choose a customer', true); if (!items.length) return toast('Add at least one line', true);
      const body = { customer_id: Number($('#cust', el).value), property_id: $('#prop', el).value || null, items, discount_pct: $('#disc', el).value, tax_pct: $('#tax', el).value, deposit: $('#dep', el).value, message: $('#qmsg', el).value };
      try { const r = quote ? await put('/quotes/' + quote.id, body) : await post('/quotes', body); let msg = 'Quote saved';
        if (send) { const s = await post('/quotes/' + r.quote.id + '/send', {}); await navigator.clipboard?.writeText(s.link).catch(() => {}); msg = 'Quote sent. The link is copied.'; }
        close(); toast(msg); hooks.refresh(); } catch (err) { toast(err.message, true); }
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
  return `<div class="top"><h1>Quotes</h1><button class="btn main" id="nq">+ New quote</button></div>${quotes.length ? groups.map(([t, f]) => { const rows = quotes.filter(f); return rows.length ? `<h3 class="mono" style="margin:16px 0 8px">${t} · ${rows.length}</h3><div class="list">${rows.map(q => `<a class="item" href="#/customers/${q.customer_id}"><div class="grow"><div class="t">${esc(q.customer_name)} · ${esc(q.label)}</div><div class="s">${q.status === 'approved' ? 'Approved ' + esc(fmtDate(q.decided_at)) : q.viewed_at ? 'Viewed ' + esc(ago(q.viewed_at)) : q.sent_at ? 'Sent ' + esc(ago(q.sent_at)) : 'Created ' + esc(ago(q.created_at))}</div></div><b>${money(q.total)}</b></a>`).join('')}</div>` : ''; }).join('') : empty('No quotes yet. Quote a customer and they can approve it from their phone.')}`;
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
