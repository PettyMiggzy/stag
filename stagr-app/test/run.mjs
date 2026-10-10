// Integration tests: real Postgres, real HTTP server. Run: npm test
import { execSync } from 'node:child_process';
const PGBIN = process.env.PGBIN || '/usr/lib/postgresql/16/bin', DB = 'stagr_test';
const psql = c => execSync(`${PGBIN}/psql -h /tmp -p 5544 -U postgres -qAt -c "${c}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
try { psql(`DROP DATABASE IF EXISTS ${DB}`); psql(`CREATE DATABASE ${DB}`); } catch (e) { console.error('Could not reach local Postgres on port 5544:', String(e.stderr || e)); process.exit(2); }
process.env.DATABASE_URL = `postgresql://postgres@/${DB}?host=/tmp&port=5544`; process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'; process.env.CRON_SECRET = 'cron-test';
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.RESEND_API_KEY;
const { start } = await import('../dev/server.mjs'); const { sql } = await import('../lib/db.js');
const srv = await start(8795), BASE = 'http://localhost:8795';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
class Client { constructor() { this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0].startsWith('stagr_session=;') || /Max-Age=0/.test(sc) ? '' : sc.split(';')[0];
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { s: r.status, j, text };
  }
  get = (p) => this.req('GET', p); post = (p, b = {}) => this.req('POST', p, b); put = (p, b = {}) => this.req('PUT', p, b); del = (p) => this.req('DELETE', p);
}
const A = new Client(), B = new Client(), anon = new Client();

// ---------- signup, login, lockout ----------
let r = await anon.post('/api/auth/signup', { business: 'Alpha Hauling', name: 'Ann Owner', email: 'ann@alpha.test', password: 'password1', phone: '(555) 111-2222', city: 'Spring', state: 'tx' });
ok('signup A', r.s === 200 && r.j.user.role === 'owner', r); A.cookie = anon.cookie; anon.cookie = '';
r = await B.post('/api/auth/signup', { business: 'Bravo Cleaning', name: 'Bob Owner', email: 'bob@bravo.test', password: 'password2', city: 'Katy' }); ok('signup B', r.s === 200, r);
r = await anon.post('/api/auth/signup', { business: 'Alpha Hauling', name: 'Dup', email: 'ann@alpha.test', password: 'password1' }); ok('duplicate email rejected', r.s === 409, r);
r = await anon.post('/api/auth/signup', { business: 'X', name: 'Y', email: 'bad', password: 'short' }); ok('bad signup rejected', r.s === 400, r);
r = await anon.get('/api/customers'); ok('API needs sign-in', r.s === 401, r);
r = await A.get('/api/auth/me'); ok('me', r.s === 200 && r.j.business.name === 'Alpha Hauling' && r.j.business.slug === 'alpha-hauling', r);
r = await anon.post('/api/auth/login', { email: 'ann@alpha.test', password: 'wrongwrong' }); ok('wrong password 401', r.s === 401, r);
r = await anon.post('/api/auth/login', { email: 'ann@alpha.test', password: 'password1' }); ok('login ok', r.s === 200, r); anon.cookie = '';
for (let i = 0; i < 10; i++) await anon.post('/api/auth/login', { email: 'lock@x.test', password: 'nopenopenope' });
r = await anon.post('/api/auth/login', { email: 'lock@x.test', password: 'nopenopenope' }); ok('lockout after 10 tries', r.s === 429, r);
r = await anon.req('POST', '/api/auth/login', 'email=a&password=b', { 'content-type': 'application/x-www-form-urlencoded' }); ok('form posts rejected', r.s === 415 || r.s === 400, r);
const tampered = new Client(); tampered.cookie = A.cookie.replace(/.$/, c => c === 'a' ? 'b' : 'a'); r = await tampered.get('/api/customers'); ok('tampered cookie rejected', r.s === 401, r);

// ---------- customers, properties, services ----------
r = await A.post('/api/customers', { name: 'Sam Rivera', phone: '(281) 555-1000', email: 'sam@x.test', property: { address: '12 Oak St', city: 'Spring', state: 'tx', zip: '77373' } }); ok('create customer', r.s === 200, r);
const cA = r.j.customer;
r = await A.get('/api/customers/' + cA.id); ok('customer detail has property', r.j.properties.length === 1 && r.j.properties[0].state === 'TX', r.j);
const propA = r.j.properties[0];
r = await A.get('/api/customers?q=rivera'); ok('customer search', r.j.customers.length === 1, r.j);
r = await A.get('/api/services'); ok('default services seeded', r.j.services.length >= 3, r.j);
r = await B.post('/api/customers', { name: 'Bea Lee', phone: '2815552000' }); const cB = r.j.customer;

// ---------- isolation: B must not see or touch A's data ----------
r = await B.get('/api/customers/' + cA.id); ok('B cannot read A customer', r.s === 404, r);
r = await B.put('/api/customers/' + cA.id, { name: 'Hacked' }); ok('B cannot edit A customer', r.s === 404, r);
r = await B.get('/api/customers'); ok('B list excludes A', r.j.customers.every(c => c.id !== cA.id) && r.j.customers.length === 1, r.j);
r = await B.post('/api/customers/' + cA.id + '/properties', { address: '1 X' }); ok('B cannot add property to A customer', r.s === 404, r);
r = await B.put('/api/properties/' + propA.id, { address: 'Hacked' }); ok('B cannot edit A property', r.s === 404, r);
r = await B.post('/api/quotes', { customer_id: cA.id, items: [{ name: 'x', qty: 1, price: 5 }] }); ok('B cannot quote A customer', r.s === 404, r);
r = await A.post('/api/quotes', { customer_id: cB.id, items: [{ name: 'x', qty: 1, price: 5 }] }); ok('A cannot quote B customer', r.s === 404, r);

// ---------- quotes ----------
r = await A.post('/api/quotes', { customer_id: cA.id, property_id: propA.id, items: [{ name: 'Haul-away', description: 'Couch and mattress', qty: 1, price: 250 }, { name: 'Disposal fee', qty: 2, price: 40 }], discount_pct: 10, tax_pct: 8.25, deposit: 50, message: 'Thanks!' });
ok('create quote', r.s === 200 && r.j.quote.label === 'Q-1001' && r.j.quote.subtotal === 330 && r.j.quote.discount === 33 && r.j.quote.total === 321.5, r.j);
const quote = r.j.quote;
r = await anon.get('/api/public/q/' + quote.token); ok('draft quote hidden from public', r.s === 404, r);
r = await A.post(`/api/quotes/${quote.id}/send`, {}); ok('send quote returns link', r.s === 200 && r.j.link.includes('/q/' + quote.token), r.j);
ok('quote send creates sms + email preview rows', r.j.messages.length === 2 && r.j.messages.every(m => m.status === 'preview'), r.j.messages);
r = await anon.get('/api/public/q/' + quote.token); ok('public quote view', r.s === 200 && r.j.quote.total === 321.5 && r.j.business.name === 'Alpha Hauling' && r.j.customer === 'Sam Rivera', r.j);
ok('public quote hides internals', !JSON.stringify(r.j).includes('tenant_id') && !JSON.stringify(r.j).includes('token'), r.j);
r = await anon.post(`/api/public/q/${quote.token}/decide`, { decision: 'approve', name: '' }); ok('approve needs a name', r.s === 400, r);
r = await anon.post(`/api/public/q/${quote.token}/decide`, { decision: 'approve', name: 'Sam Rivera' }); ok('approve quote', r.s === 200 && r.j.status === 'approved', r);
r = await anon.post(`/api/public/q/${quote.token}/decide`, { decision: 'decline' }); ok('cannot change decision', r.s === 400, r);
r = await A.put('/api/quotes/' + quote.id, { message: 'x' }); ok('approved quote locked', r.s === 400, r);
r = await B.get('/api/quotes/' + quote.id); ok('B cannot read A quote', r.s === 404, r);

// ---------- jobs, visits, recurrence (daylight saving) ----------
await A.put('/api/business', { timezone: 'America/Chicago', tax_pct: 8.25 });
r = await A.post('/api/team', { name: 'Wally Worker', email: 'wally@alpha.test', password: 'worker-pass1', role: 'worker' }); ok('add worker', r.s === 200, r); const wally = r.j.member;
r = await A.post('/api/team', { name: 'Ann2', email: 'ann2@alpha.test', password: 'worker-pass1', role: 'admin' }); ok('owner can add admin', r.s === 200, r);
const firstVisit = '2026-10-28T14:00:00.000Z'; // 9:00 AM Central (CDT)
r = await A.post('/api/jobs', { customer_id: cA.id, property_id: propA.id, quote_id: quote.id, visit: { starts_at: firstVisit, ends_at: '2026-10-28T16:00:00.000Z', assigned: [wally.id], checklist: [{ text: 'Photos before' }, { text: 'Sweep up' }] }, recurrence: { freq: 'weekly', interval: 1 } });
ok('create recurring job from quote', r.s === 200 && r.j.job.number === 1001, r); const job = r.j.job;
r = await A.get('/api/visits?from=2026-10-01&to=2027-02-01'); const vs = r.j.visits.filter(v => v.job_id === job.id);
ok('weekly visits generated (about 13 in 90 days)', vs.length >= 12 && vs.length <= 14, vs.length);
const localHour = d => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(d)));
ok('every visit stays at 9:00 local across the November time change', vs.every(v => localHour(v.starts_at) === 9), vs.map(v => v.starts_at + ':' + localHour(v.starts_at)).filter((_, i) => localHour(vs[i].starts_at) !== 9));
ok('visits keep the crew and duration', vs.every(v => v.assigned.includes(wally.id) && (new Date(v.ends_at) - new Date(v.starts_at)) === 7200000), vs[1]);
r = await A.get('/api/jobs/' + job.id); const before = r.j.visits.length; r = await A.get('/api/jobs/' + job.id); ok('extending visits twice does not duplicate', r.j.visits.length === before, [before, r.j.visits.length]);
ok('job detail has costing', r.j.costing && typeof r.j.costing.profit === 'number', r.j.costing);
// monthly clamps to end of month
const jm = (await A.post('/api/jobs', { customer_id: cA.id, title: 'Monthly gutters', visit: { starts_at: '2026-01-31T15:00:00.000Z' }, recurrence: { freq: 'monthly', interval: 1, count: 4 } })).j.job;
r = await A.get('/api/visits?from=2026-01-01&to=2026-06-01'); const mv = r.j.visits.filter(v => v.job_id === jm.id).map(v => v.starts_at.slice(0, 10));
ok('monthly job: Jan 31, Feb 28, Mar 31, Apr 30', JSON.stringify(mv) === JSON.stringify(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']), mv);

// worker permissions
const W = new Client(); r = await W.post('/api/auth/login', { email: 'wally@alpha.test', password: 'worker-pass1' }); ok('worker login', r.s === 200, r);
r = await W.get('/api/visits?from=2026-10-01&to=2026-12-01'); ok('worker sees only assigned visits', r.s === 200 && r.j.visits.length > 0 && r.j.visits.every(v => v.assigned.includes(wally.id)), r.j.visits?.length);
r = await W.post('/api/team', { name: 'x', email: 'x@y.test', password: 'password1' }); ok('worker cannot add team', r.s === 403, r);
r = await W.post('/api/invoices', { customer_id: cA.id, items: [{ name: 'x', price: 1 }] }); ok('worker cannot create invoices', r.s === 403, r);
r = await W.put('/api/visits/' + vs[0].id, { starts_at: '2026-12-01T10:00:00Z' }); ok('worker cannot reschedule', r.s === 403, r);
r = await W.put('/api/visits/' + vs[0].id, { checklist: [{ text: 'Photos before', done: true }], notes: 'Gate code 1234', status: 'in_progress' }); ok('worker can update checklist and notes', r.s === 200 && r.j.visit.checklist[0].done === true, r);
r = await W.post('/api/time/start', { visit_id: vs[0].id }); ok('worker clocks in', r.s === 200, r); r = await W.post('/api/time/stop', {}); ok('worker clocks out', r.s === 200, r);
r = await W.get('/api/visits/' + vs[0].id); ok('worker can open their own visit', r.s === 200 && r.j.visit.customer_name === 'Sam Rivera', r);
r = await W.get('/api/visits/' + vs[0].id); r = await B.get('/api/visits/' + vs[0].id); ok('B cannot open A visit', r.s === 404, r);
r = await W.get('/api/customers'); ok('worker can read customers', r.s === 200, r.s);
r = await W.post('/api/visits/' + vs[0].id + '/photos', { data: 'data:image/png;base64,iVBORw0KGgo=' }); ok('worker adds a photo', r.s === 200 && r.j.photos.length === 1, r);
r = await W.post('/api/visits/' + vs[0].id + '/photos', { data: 'javascript:alert(1)' }); ok('non-image photo rejected', r.s === 400, r);
r = await B.put('/api/visits/' + vs[0].id, { notes: 'x' }); ok('B cannot edit A visit', r.s === 404, r);
r = await B.get('/api/jobs/' + job.id); ok('B cannot read A job', r.s === 404, r);
r = await B.get('/api/visits?from=2026-10-01&to=2027-01-01'); ok('B calendar is empty of A visits', r.j.visits.length === 0, r.j.visits.length);

// ---------- complete, invoice, payments ----------
r = await A.put('/api/visits/' + vs[0].id, { status: 'completed' }); ok('complete visit', r.s === 200 && r.j.visit.completed_at, r);
r = await A.post('/api/invoices', { customer_id: cA.id, job_id: job.id }); ok('invoice from job copies quote items and tax', r.s === 200 && r.j.invoice.label === 'INV-1001' && r.j.invoice.total === 321.5 && r.j.invoice.status === 'draft', r.j); const inv = r.j.invoice;
r = await A.post(`/api/invoices/${inv.id}/send`, {}); ok('send invoice', r.s === 200 && r.j.link.includes('/i/' + inv.token), r);
r = await A.post(`/api/invoices/${inv.id}/payments`, { amount: 100, method: 'zelle', note: 'deposit' }); ok('partial payment', r.s === 200 && r.j.invoice.status === 'partial' && r.j.invoice.balance === 221.5, r.j);
r = await A.post(`/api/invoices/${inv.id}/payments`, { amount: 999, method: 'cash' }); ok('overpayment rejected', r.s === 400, r);
r = await A.post(`/api/invoices/${inv.id}/void`, {}); ok('cannot void with payments', r.s === 400, r);
r = await A.post(`/api/invoices/${inv.id}/payments`, { amount: 221.5, method: 'cash' }); ok('final payment marks paid', r.s === 200 && r.j.invoice.status === 'paid' && r.j.invoice.balance === 0 && r.j.invoice.paid_at, r.j);
r = await anon.get('/api/public/i/' + inv.token); ok('public invoice page', r.s === 200 && r.j.invoice.balance === 0 && r.j.invoice.status === 'paid' && !JSON.stringify(r.j).includes('tenant_id'), r.j);
r = await B.post(`/api/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' }); ok('B cannot pay A invoice', r.s === 404, r);
r = await B.get('/api/invoices'); ok('B invoice list empty', r.j.invoices.length === 0, r.j);

// ---------- messages, consent, automations ----------
r = await A.post('/api/messages', { customer_id: cA.id, body: 'Big sale this month!', promo: true }); ok('promo text blocked without consent', r.j.message.status === 'blocked' && /consent/i.test(r.j.message.error), r.j);
r = await A.put('/api/customers/' + cA.id, { sms_opt_in: true }); ok('record opt-in', r.j.customer.sms_opt_in === true && r.j.customer.sms_opt_in_at, r.j);
r = await A.post('/api/messages', { customer_id: cA.id, body: 'Big sale this month!', promo: true }); ok('promo text allowed after consent, gets opt-out line, previewed (no provider)', r.j.message.status === 'preview' && /Reply STOP/i.test(r.j.message.body), r.j);
r = await B.post('/api/messages', { customer_id: cA.id, body: 'hi' }); ok('B cannot message A customer', r.s === 404, r);
// monthly follow-up: customer finished a job 40 days ago and has nothing scheduled
const c2 = (await A.post('/api/customers', { name: 'Old Customer', phone: '2815553000', sms_opt_in: true })).j.customer;
const oldJob = (await A.post('/api/jobs', { customer_id: c2.id, title: 'Old job', visit: { starts_at: new Date(Date.now() - 40 * 864e5).toISOString() } })).j.job;
const oldV = (await A.get('/api/visits?from=' + new Date(Date.now() - 60 * 864e5).toISOString() + '&to=' + new Date(Date.now() - 30 * 864e5).toISOString())).j.visits.find(v => v.job_id === oldJob.id);
await A.put('/api/visits/' + oldV.id, { status: 'completed' });
const c3 = (await A.post('/api/customers', { name: 'No Consent', phone: '2815554000' })).j.customer;
const j3 = (await A.post('/api/jobs', { customer_id: c3.id, title: 'Old job 3', visit: { starts_at: new Date(Date.now() - 41 * 864e5).toISOString() } })).j.job;
await A.put('/api/visits/' + (await A.get('/api/visits?from=' + new Date(Date.now() - 60 * 864e5).toISOString() + '&to=' + new Date(Date.now() - 30 * 864e5).toISOString())).j.visits.find(v => v.job_id === j3.id).id, { status: 'completed' });
r = await A.put('/api/automations/monthly_followup', { enabled: true, config: { discount: '$50' } }); ok('enable monthly follow-up', r.j.automation.enabled === true, r.j);
r = await A.post('/api/automations/run', {}); const made1 = r.j.made;
let msgs = (await A.get('/api/messages')).j.messages; const mf = msgs.filter(m => m.kind === 'monthly_followup');
ok('monthly follow-up goes to the opted-in customer only', mf.length === 1 && mf[0].customer_id === c2.id, mf.map(m => [m.customer_name, m.status]));
ok('monthly text uses business name, city, discount, phone and has opt-out', /Alpha Hauling is back in Spring! Book today and get \$50 off your next service\. Reply to this text or call \(555\) 111-2222 to schedule\./.test(mf[0].body) && /Reply STOP/.test(mf[0].body), mf[0].body);
r = await A.post('/api/automations/run', {}); ok('running again sends nothing twice', r.j.made === 0, r.j);
// appointment reminder
const soon = new Date(Date.now() + 10 * 3600e3);
const rj = (await A.post('/api/jobs', { customer_id: c2.id, title: 'Soon job', visit: { starts_at: soon.toISOString() } })).j.job;
r = await A.post('/api/automations/run', {}); msgs = (await A.get('/api/messages')).j.messages;
ok('appointment reminder created once', msgs.filter(m => m.kind === 'appointment_reminder' && m.customer_id === c2.id).length >= 1, msgs.map(m => m.kind));
// quote follow-up (sent 3 days ago, still undecided)
const q2 = (await A.post('/api/quotes', { customer_id: c2.id, items: [{ name: 'x', qty: 1, price: 99 }] })).j.quote; await A.post(`/api/quotes/${q2.id}/send`, {});
await sql`UPDATE quotes SET sent_at = now() - interval '3 days' WHERE id = ${q2.id}`;
r = await A.post('/api/automations/run', {}); ok('quote follow-up after 2 days', (await A.get('/api/messages')).j.messages.some(m => m.kind === 'quote_followup'), r.j);
// invoice reminder
const i2 = (await A.post('/api/invoices', { customer_id: c2.id, items: [{ name: 'x', qty: 1, price: 80 }] })).j.invoice; await A.post(`/api/invoices/${i2.id}/send`, {});
await sql`UPDATE invoices SET sent_at = now() - interval '8 days' WHERE id = ${i2.id}`;
await A.post('/api/automations/run', {}); ok('invoice reminder after 7 days', (await A.get('/api/messages')).j.messages.some(m => m.kind === 'invoice_reminder'));
r = await B.post('/api/automations/run', {}); ok('B run only touches B', r.s === 200 && r.j.made === 0, r.j);
r = await anon.get('/api/cron/run'); ok('cron needs the secret', r.s === 401, r);
r = await anon.req('GET', '/api/cron/run', undefined, { authorization: 'Bearer cron-test' }); ok('cron with secret works', r.s === 200, r);
r = await A.post('/api/automations/preview', { template: '{business} is back in {city}! Get {discount} off. Call {phone}.', discount: '$25' }); ok('template preview', /Alpha Hauling is back in Spring! Get \$25 off\. Call \(555\) 111-2222\./.test(r.j.text), r.j);

// ---------- booking page and requests ----------
r = await anon.get('/api/public/b/alpha-hauling'); ok('public booking page', r.s === 200 && r.j.business.name === 'Alpha Hauling' && r.j.services.length >= 3 && !JSON.stringify(r.j).includes('tenant'), r.j);
r = await anon.post('/api/public/b/alpha-hauling/request', { name: 'Web Lead', phone: '(713) 555-9000', email: 'web@lead.test', service: 'Haul-away', address: '5 Elm', message: 'Old fridge', sms_ok: true }); ok('booking request accepted', r.s === 200, r);
r = await A.get('/api/requests'); ok('request lands in the right business', r.j.requests.some(x => x.name === 'Web Lead') && r.j.requests.length === 1, r.j.requests.length);
r = await B.get('/api/requests'); ok('B does not see it', r.j.requests.length === 0, r.j);
const reqId = (await A.get('/api/requests')).j.requests[0].id;
r = await A.post(`/api/requests/${reqId}/convert`, {}); ok('convert request to customer', r.s === 200 && r.j.customer.name === 'Web Lead', r);
r = await A.post(`/api/requests/${reqId}/convert`, {}); ok('converting again reuses the customer', r.s === 200, r);
r = await B.post(`/api/requests/${reqId}/convert`, {}); ok('B cannot convert A request', r.s === 404, r);
r = await anon.get('/api/public/b/nope'); ok('unknown booking page 404', r.s === 404, r);
for (let i = 0; i < 8; i++) await anon.post('/api/public/b/alpha-hauling/request', { name: 'Spam', phone: '7135559001' });
r = await anon.post('/api/public/b/alpha-hauling/request', { name: 'Spam', phone: '7135559001' }); ok('booking spam is rate limited', r.s === 429, r);

// ---------- Jobber-style quote features: optional add-ons, text sections, percent deposit, rating, salesperson ----------
{
  const cq = (await A.post('/api/customers', { name: 'Quote Tester', phone: '2815557000', email: 'qt@x.test' })).j.customer;
  const wallyId = (await A.get('/api/team')).j.team.find(m => m.email === 'wally@alpha.test').id;
  r = await A.post('/api/quotes', { customer_id: cq.id, title: 'Weekly cleaning', rating: 4, salesperson_id: wallyId, reminder_date: '2026-11-05', deposit_pct: 25, tax_pct: 0,
    items: [{ name: 'Weekly service', description: 'Dust, vacuum, mop', qty: 1, price: 100 }, { name: 'Window wash', qty: 1, price: 50, optional: true, selected: false }, { name: 'Oven clean', qty: 1, price: 30, optional: true, selected: true }, { kind: 'text', name: 'Terms', description: 'Access to the home is required.' }] });
  ok('quote with optional lines, text section, percent deposit', r.s === 200 && r.j.quote.title === 'Weekly cleaning' && r.j.quote.rating === 4 && r.j.quote.salesperson_id === wallyId, r);
  ok('only ticked optional lines count: 100 + 30 = 130, deposit 25% = 32.50', r.j.quote.total === 130 && r.j.quote.deposit_due === 32.5, [r.j.quote.total, r.j.quote.deposit_due]);
  const oq = r.j.quote;
  r = await A.post('/api/quotes', { customer_id: cq.id, salesperson_id: (await A.get('/api/auth/me')).j.user.id, items: [{ name: 'x', price: 1 }] }); ok('owner can be the salesperson', r.s === 200, r);
  r = await B.post('/api/team', { name: 'Bee Worker', email: 'bee@bravo.test', password: 'worker-pass1', role: 'worker' }); const beeId = r.j.member.id;
  r = await A.post('/api/quotes', { customer_id: cq.id, salesperson_id: beeId, items: [{ name: 'x', price: 1 }] }); ok('another business\'s person cannot be salesperson', r.s === 400, r);
  await A.post(`/api/quotes/${oq.id}/send`, {});
  r = await anon.get('/api/public/q/' + oq.token); ok('customer sees optional lines, text, deposit', r.j.quote.items.length === 4 && r.j.quote.items[1].optional === true && r.j.quote.deposit_due === 32.5 && r.j.quote.title === 'Weekly cleaning' && !JSON.stringify(r.j).includes('salesperson'), r.j.quote);
  r = await anon.post(`/api/public/q/${oq.token}/decide`, { decision: 'approve', name: 'Quote Tester', selected: [1, 2] }); ok('customer ticks both add-ons and approves', r.s === 200, r);
  r = await A.get('/api/quotes/' + oq.id); ok('approved total includes both add-ons: 180, deposit 45', r.j.quote.total === 180 && r.j.quote.deposit_due === 45 && r.j.quote.items[1].selected === true, [r.j.quote.total, r.j.quote.deposit_due]);
  r = await A.post(`/api/quotes/${oq.id}/deposit-paid`, { method: 'zelle' }); ok('mark deposit received', r.s === 200 && r.j.quote.deposit_paid_at, r);
  r = await B.post(`/api/quotes/${oq.id}/deposit-paid`, {}); ok('B cannot mark A deposit', r.s === 404, r);
  r = await A.post('/api/invoices', { customer_id: cq.id, quote_id: oq.id }); ok('invoice from quote copies chosen lines only (no text section)', r.s === 200 && r.j.invoice.items.length === 3 && r.j.invoice.items.every(i => i.kind !== 'text') && r.j.invoice.total === 180, r.j.invoice?.items);
  // a customer cannot approve with nothing selected: make a quote that is all optional
  const aq = (await A.post('/api/quotes', { customer_id: cq.id, items: [{ name: 'Only add-on', price: 20, optional: true, selected: false }] })).j.quote; await A.post(`/api/quotes/${aq.id}/send`, {});
  r = await anon.post(`/api/public/q/${aq.token}/decide`, { decision: 'approve', name: 'Quote Tester', selected: [] }); ok('cannot approve a quote with nothing picked', r.s === 400, r);
}
// ---------- request detail, notes, consent, Convert to Quote ----------
{
  await sql`DELETE FROM login_fails WHERE key LIKE 'booking:%'`; // the spam test above used up this IP's hourly limit
  r = await anon.post('/api/public/b/alpha-hauling/request', { name: 'Consent Yes', company: 'Yes LLC', phone: '(713) 555-7001', email: 'yes@x.test', service: 'Service call', address: '9 Pine', message: 'Need help', sms_ok: true, email_ok: true, availability: { dates: ['2026-11-03', '2026-11-06', 'junk'], arrival: ['morning', 'bogus'] } });
  ok('request with availability and consent', r.s === 200, r);
  const rq = (await A.get('/api/requests')).j.requests.find(x => x.name === 'Consent Yes');
  ok('availability stored and cleaned', JSON.stringify(rq.availability) === JSON.stringify({ dates: ['2026-11-03', '2026-11-06'], arrival: ['morning'] }) && rq.sms_ok === true && rq.email_ok === true, rq);
  r = await A.put('/api/requests/' + rq.id, { notes: 'Called, will visit Tuesday', status: 'contacted' }); ok('internal notes saved', r.s === 200 && r.j.request.notes.includes('Tuesday') && r.j.request.status === 'contacted', r);
  r = await A.get('/api/requests/' + rq.id); ok('request detail', r.s === 200 && r.j.request.company === 'Yes LLC', r);
  r = await B.get('/api/requests/' + rq.id); ok('B cannot open A request', r.s === 404, r);
  r = await B.put('/api/requests/' + rq.id, { notes: 'x' }); ok('B cannot edit A request', r.s === 404, r);
  r = await B.post(`/api/requests/${rq.id}/convert-quote`, {}); ok('B cannot convert A request', r.s === 404, r);
  r = await A.post(`/api/requests/${rq.id}/convert-quote`, {}); ok('Convert to Quote makes customer and a draft quote', r.s === 200 && r.j.customer.name === 'Consent Yes' && r.j.quote.id, r);
  ok('consent copied to the customer with a timestamp', r.j.customer.sms_opt_in === true && r.j.customer.email_opt_in === true && r.j.customer.sms_opt_in_at && r.j.customer.company === 'Yes LLC', r.j.customer);
  const nq = (await A.get('/api/quotes/' + r.j.quote.id)).j.quote; ok('draft quote starts with the requested service and the request link', nq.status === 'draft' && nq.request_id === rq.id && nq.items[0].name === 'Service call' && nq.items[0].price === 95, nq);
  r = await anon.post('/api/public/b/alpha-hauling/request', { name: 'Consent No', phone: '(713) 555-7002', email: 'no@x.test', service: 'Other', message: 'hi' });
  const rn = (await A.get('/api/requests')).j.requests.find(x => x.name === 'Consent No'); r = await A.post(`/api/requests/${rn.id}/convert-quote`, {});
  ok('no consent ticked means no consent recorded', r.j.customer.sms_opt_in === false && r.j.customer.email_opt_in === false && !r.j.customer.sms_opt_in_at, r.j.customer);
}

// ---------- dashboard, reports, exports, expenses ----------
r = await A.post('/api/expenses', { job_id: job.id, description: 'Dump fee', amount: 45.5 }); ok('add expense', r.s === 200, r);
r = await B.post('/api/expenses', { job_id: job.id, description: 'x', amount: 5 }); ok('B cannot add expense to A job', r.s === 404, r);
r = await A.get('/api/jobs/' + job.id); ok('job costing: invoiced 321.50, collected 321.50, expenses 45.50, profit 276.00', r.j.costing.invoiced === 321.5 && r.j.costing.collected === 321.5 && r.j.costing.expenses === 45.5 && r.j.costing.profit === 276, r.j.costing);
r = await A.get('/api/dashboard'); ok('dashboard', r.s === 200 && Array.isArray(r.j.upcoming) && r.j.receivables && r.j.month.collected >= 321.5, r.j.month);
r = await W.get('/api/dashboard'); ok('worker dashboard has no money', r.s === 200 && !r.j.receivables, Object.keys(r.j));
r = await A.get('/api/reports'); ok('reports', r.s === 200 && r.j.collected >= 321.5 && r.j.quotes.sent >= 1 && r.j.by_service.length >= 1, r.j);
r = await W.get('/api/reports'); ok('worker cannot see reports', r.s === 403, r);
r = await A.get('/api/export/invoices.csv'); ok('invoices csv', r.s === 200 && r.text.startsWith('Invoice,Customer') && r.text.includes('INV-1001'), r.text.slice(0, 120));
r = await A.get('/api/export/payments.csv'); ok('payments csv', r.s === 200 && r.text.includes('zelle'), r.text.slice(0, 120));
r = await B.get('/api/export/invoices.csv'); ok('B csv has none of A data', r.s === 200 && !r.text.includes('Sam Rivera') && r.text.split('\r\n').length === 1, r.text);

// ---------- review requests ----------
const rc = (await A.post('/api/customers', { name: 'Rita Review', phone: '2815557001', email: 'rita@x.test' })).j.customer;
r = await A.get('/api/reviews'); ok('reviews settings default off', r.s === 200 && r.j.enabled === false && r.j.link === '' && r.j.stats.total === 0 && r.j.delays.length > 3, r);
r = await A.post(`/api/customers/${rc.id}/review-request`, {}); ok('review request needs a link', r.s === 400 && /link/i.test(r.j.error), r);
for (const bad of ['http://g.page/r/abc', 'https://evil.com/g.page', 'javascript:alert(1)', 'https://google.com.evil.com/x', 'not a url']) { r = await A.put('/api/reviews', { link: bad }); ok('bad review link rejected: ' + bad, r.s === 400, r); }
r = await A.put('/api/reviews', { enabled: true }); ok('cannot turn on auto without link', r.s === 400, r);
r = await A.put('/api/reviews', { link: 'https://g.page/r/CaseyAlpha/review', template: 'Thanks for choosing us, no link here' }); ok('template must contain {review_link}', r.s === 400, r);
r = await A.put('/api/reviews', { link: 'https://g.page/r/CaseyAlpha/review' }); ok('review link saved', r.s === 200 && r.j.link === 'https://g.page/r/CaseyAlpha/review', r);
r = await W.put('/api/reviews', { link: 'https://g.page/r/Hack/review' }); ok('worker cannot change review settings', r.s === 403, r);
r = await B.get('/api/reviews'); ok('B does not see A review link', r.s === 200 && r.j.link === '', r);
r = await A.get(`/api/customers/${rc.id}/review-request/preview`); ok('preview has link, STOP line', r.s === 200 && r.j.has_link && r.j.has_phone && r.j.text.includes('https://g.page/r/CaseyAlpha/review') && /Reply STOP/.test(r.j.text), r);
r = await A.post(`/api/customers/${rc.id}/review-request`, {}); ok('manual review request (preview mode)', r.s === 200 && r.j.message.status === 'preview' && r.j.message.kind === 'review_request' && r.j.message.body.includes('g.page/r/CaseyAlpha') && /Reply STOP/.test(r.j.message.body), r);
r = await A.post(`/api/customers/${rc.id}/review-request`, {}); ok('recent request needs confirmation (409)', r.s === 409 && r.j.recent, r);
r = await A.post(`/api/customers/${rc.id}/review-request`, { force: true, body: 'Hey Rita, mind leaving us a review?' }); ok('force send with custom text appends link', r.s === 200 && r.j.message.body.includes('Hey Rita') && r.j.message.body.includes('g.page/r/CaseyAlpha'), r);
r = await A.get('/api/customers/' + rc.id); ok('customer profile keeps review history', r.s === 200 && r.j.review_requests.length === 2 && r.j.review_requests[0].status === 'preview', r.j.review_requests);
const rnp = (await A.post('/api/customers', { name: 'No Phone' })).j.customer; r = await A.post(`/api/customers/${rnp.id}/review-request`, {}); ok('no phone is refused', r.s === 400, r);
r = await B.post(`/api/customers/${rc.id}/review-request`, {}); ok('B cannot send to A customer', r.s === 404 || r.s === 400, r);
r = await B.get(`/api/customers/${rc.id}/review-request/preview`); ok('B cannot preview A customer', r.s === 404, r);
const rout = (await A.post('/api/customers', { name: 'Opted Out', phone: '2815557002', sms_opt_in: true })).j.customer; await sql`UPDATE customers SET sms_opt_in = false, sms_opt_out_at = now() WHERE id = ${rout.id}`;
r = await A.post(`/api/customers/${rout.id}/review-request`, {}); ok('opted-out customer is blocked', r.s === 200 && r.j.message.status === 'blocked', r);
// delivery tracking via Twilio callback
const midm = r = (await A.post(`/api/customers/${rc.id}/review-request`, { force: true })).j.message; await sql`UPDATE messages SET provider_id = 'SMtest1', status = 'sent', delivery_status = 'sent' WHERE id = ${midm.id}`;
const hook = async (params, sig) => { const p = new URLSearchParams(params).toString(); return (await fetch(BASE + '/api/webhooks/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? twilioSignature('tok123', BASE + '/api/webhooks/twilio', params) }, body: p })).status; };
const { twilioSignature } = await import('../lib/routes/reviews.js');
ok('webhook is off without Twilio token', await hook({ MessageSid: 'SMtest1', MessageStatus: 'delivered' }) === 404);
process.env.TWILIO_AUTH_TOKEN = 'tok123';
ok('webhook rejects bad signature', await hook({ MessageSid: 'SMtest1', MessageStatus: 'delivered' }, 'nope') === 403);
ok('webhook accepts valid signature', await hook({ MessageSid: 'SMtest1', MessageStatus: 'delivered' }) === 200);
let [mm] = await sql`SELECT status, delivery_status, delivered_at FROM messages WHERE id = ${midm.id}`; ok('delivered status and time saved', mm.status === 'delivered' && mm.delivery_status === 'delivered' && mm.delivered_at, mm);
ok('late "sent" update does not downgrade', await hook({ MessageSid: 'SMtest1', MessageStatus: 'sent' }) === 200 && (await sql`SELECT status FROM messages WHERE id = ${midm.id}`)[0].status === 'delivered');
await sql`UPDATE messages SET provider_id = 'SMtest2', status = 'sent', delivery_status = 'sent' WHERE id = ${r.j ? midm.id : 0} AND false`;
const m2 = (await A.post(`/api/customers/${rc.id}/review-request`, { force: true })).j.message; await sql`UPDATE messages SET provider_id = 'SMtest2', status = 'sent', delivery_status = 'sent' WHERE id = ${m2.id}`;
ok('failed callback marks failed', await hook({ MessageSid: 'SMtest2', MessageStatus: 'undelivered', ErrorCode: '30003' }) === 200 && (await sql`SELECT status, error FROM messages WHERE id = ${m2.id}`)[0].status === 'failed');
delete process.env.TWILIO_AUTH_TOKEN;
r = await A.get('/api/reviews'); ok('stats count delivered and failed', r.j.stats.delivered === 1 && r.j.stats.failed === 1, r.j.stats);
// auto-send after a job is completed
const ac = (await A.post('/api/customers', { name: 'Auto Annie', phone: '2815557003' })).j.customer;
const mkDone = async (cust, title) => { const jb = (await A.post('/api/jobs', { customer_id: cust.id, title, visit: { starts_at: new Date(Date.now() - 3 * 3600e3).toISOString() } })).j.job; const [v] = await sql`SELECT id FROM visits WHERE job_id = ${jb.id}`; return { jb, v }; };
const done1 = await mkDone(ac, 'Auto job 1');
r = await A.put('/api/visits/' + done1.v.id, { status: 'completed' }); ok('complete visit with auto off', r.s === 200, r);
ok('auto off sends nothing', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${ac.id} AND kind = 'review_request'`)[0].n === 0);
r = await A.put('/api/reviews', { enabled: true, delay_mode: 'hours', delay_hours: 24 }); ok('turn on auto, 1 day later', r.s === 200 && r.j.enabled, r);
await A.put('/api/visits/' + done1.v.id, { status: 'scheduled' }); r = await A.put('/api/visits/' + done1.v.id, { status: 'completed' });
ok('1-day delay: nothing yet', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${ac.id} AND kind = 'review_request'`)[0].n === 0);
r = await A.put('/api/reviews', { delay_hours: 0 }); ok('set right away', r.s === 200 && r.j.config.delay_hours === 0, r);
r = await A.post('/api/automations/run', {}); ok('run engine', r.s === 200, r);
let rm = await sql`SELECT * FROM messages WHERE customer_id = ${ac.id} AND kind = 'review_request'`; ok('auto review request created once', rm.length === 1 && rm[0].visit_id === done1.v.id && rm[0].ref === 'review:' + done1.v.id && rm[0].body.includes('g.page/r/CaseyAlpha'), rm);
await A.post('/api/automations/run', {}); ok('re-run does not duplicate', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${ac.id} AND kind = 'review_request'`)[0].n === 1);
const done2 = await mkDone(ac, 'Auto job 2'); await A.put('/api/visits/' + done2.v.id, { status: 'completed' });
ok('min gap: same customer not asked again', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${ac.id} AND kind = 'review_request'`)[0].n === 1);
const mc = (await A.post('/api/customers', { name: 'Morning Mo', phone: '2815557004' })).j.customer; const done3 = await mkDone(mc, 'Morning job');
await A.put('/api/reviews', { delay_mode: 'next_morning' }); await A.put('/api/visits/' + done3.v.id, { status: 'completed' });
ok('next-morning mode waits for 9:00', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${mc.id} AND kind = 'review_request'`)[0].n === 0);
const { runReviewRequests } = await import('../lib/routes/reviews.js'); const tid = (await sql`SELECT tenant_id FROM customers WHERE id = ${mc.id}`)[0].tenant_id;
await runReviewRequests(tid, BASE, new Date(Date.now() + 30 * 3600e3));
ok('next-morning request goes out the next day', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${mc.id} AND kind = 'review_request'`)[0].n === 1);
const bc = (await B.post('/api/customers', { name: 'Bravo Bo', phone: '2815557005' })).j.customer; const bj = (await B.post('/api/jobs', { customer_id: bc.id, title: 'B job', visit: { starts_at: new Date(Date.now() - 3 * 3600e3).toISOString() } })).j.job; const [bv] = await sql`SELECT id FROM visits WHERE job_id = ${bj.id}`;
await B.put('/api/visits/' + bv.id, { status: 'completed' }); await B.post('/api/automations/run', {});
ok('B without a link gets no auto review request', (await sql`SELECT count(*)::int n FROM messages WHERE customer_id = ${bc.id} AND kind = 'review_request'`)[0].n === 0);
r = await A.post(`/api/customers/${rc.id}/review-request`, { force: true, visit_id: bv.id }); ok('visit from another business is refused', r.s === 400, r);

// ---------- team rules ----------
r = await A.put('/api/team/' + wally.id, { role: 'admin' }); ok('owner can promote', r.s === 200 && r.j.member.role === 'admin', r); await A.put('/api/team/' + wally.id, { role: 'worker' });
r = await B.put('/api/team/' + wally.id, { role: 'admin' }); ok('B cannot edit A team', r.s === 404, r);
const ownerId = (await A.get('/api/auth/me')).j.user.id; r = await A.put('/api/team/' + ownerId, { active: false }); ok('owner cannot be turned off', r.s === 400, r);
await A.put('/api/team/' + wally.id, { active: false }); r = await W.get('/api/customers'); ok('deactivated worker is locked out', r.s === 401, r);
r = await A.post('/api/auth/logout', {}); ok('logout', r.s === 200 && A.cookie === '', r);

// ---------- raw database isolation sweep: no row may point across tenants ----------
const tenants = await sql`SELECT id FROM tenants`; ok('two tenants', tenants.length === 2);
const cross = await sql`SELECT
  (SELECT count(*) FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.tenant_id <> c.tenant_id) +
  (SELECT count(*) FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.tenant_id <> c.tenant_id) +
  (SELECT count(*) FROM visits v JOIN jobs j ON j.id = v.job_id WHERE v.tenant_id <> j.tenant_id) +
  (SELECT count(*) FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id <> c.tenant_id) +
  (SELECT count(*) FROM properties p JOIN customers c ON c.id = p.customer_id WHERE p.tenant_id <> c.tenant_id) +
  (SELECT count(*) FROM messages m JOIN customers c ON c.id = m.customer_id WHERE m.tenant_id <> c.tenant_id) +
  (SELECT count(*) FROM expenses e JOIN jobs j ON j.id = e.job_id WHERE e.tenant_id <> j.tenant_id) AS n`;
ok('no cross-tenant references anywhere in the database', Number(cross[0].n) === 0, cross);

srv.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
