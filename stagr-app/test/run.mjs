// Integration tests: real Postgres, real HTTP server. Run: npm test
import { execSync } from 'node:child_process';
const PGBIN = process.env.PGBIN || '/usr/lib/postgresql/16/bin', DB = 'stagr_test';
const psql = c => execSync(`${PGBIN}/psql -h /tmp -p 5544 -U postgres -qAt -c "${c}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
try { psql(`DROP DATABASE IF EXISTS ${DB}`); psql(`CREATE DATABASE ${DB}`); } catch (e) { console.error('Could not reach local Postgres on port 5544:', String(e.stderr || e)); process.exit(2); }
process.env.DATABASE_URL = `postgresql://postgres@/${DB}?host=/tmp&port=5544`; process.env.QUIET_HOURS = 'off'; process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'; process.env.CRON_SECRET = 'cron-test';
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
// a worker's login reaches only their own work, never the business's customers or money
for (const [m, path] of [['GET', '/api/customers'], ['GET', '/api/customers/' + cA.id], ['GET', '/api/quotes'], ['GET', '/api/invoices'], ['GET', '/api/requests'], ['GET', '/api/messages'], ['GET', '/api/jobs'], ['GET', '/api/export/invoices.csv'], ['GET', '/api/automations']]) { r = await W.req(m, path); ok('worker blocked: ' + m + ' ' + path, r.s === 403, r.s); }
r = await W.post('/api/quotes', { customer_id: cA.id, items: [{ name: 'x', price: 1 }] }); ok('worker cannot create quotes', r.s === 403, r.s);
r = await W.post('/api/messages', { customer_id: cA.id, body: 'hi' }); ok('worker cannot send messages', r.s === 403, r.s);
r = await W.put('/api/customers/' + cA.id, { name: 'Hacked' }); ok('worker cannot edit customers', r.s === 403, r.s);
r = await W.get('/api/team'); ok('worker team list has names only', r.s === 200 && r.j.team.length > 0 && r.j.team.every(t => t.email === undefined && t.phone === undefined), r.j.team?.[0]);
r = await W.get('/api/jobs/' + vs[0].job_id); ok('worker opens their job without money', r.s === 200 && r.j.costing === null && r.j.invoices.length === 0 && r.j.job.items.every(i => i.price === undefined), r.j);
r = await W.get('/api/expenses'); ok('worker sees only their own expenses', r.s === 200 && r.j.expenses.every(e => e.user_id === wally.id), r.j);
r = await W.post('/api/visits/' + vs[0].id + '/photos', { data: 'data:image/png;base64,iVBORw0KGgo=' }); ok('worker adds a photo', r.s === 200 && r.j.photos.length === 1, r);
{ const wi = await fetch(BASE + r.j.photos[0].data, { headers: { cookie: W.cookie } }); ok('assigned worker loads the visit photo as an image', wi.status === 200 && wi.headers.get('content-type') === 'image/png', wi.status);
  const wr = await W.get('/api/photos/request/1/0'); ok('worker cannot load request photos', wr.s === 403, wr.s); }
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

// legal pages for carrier registration
r = await anon.get('/api/legal/alpha-hauling/privacy'); ok('privacy page is public', r.s === 200 && r.text.includes('Alpha Hauling') && /do not sell/i.test(r.text) && /STOP/.test(r.text), r.s);
r = await anon.get('/api/legal/alpha-hauling/sms-terms'); ok('sms terms page is public', r.s === 200 && /Message and data rates may apply/.test(r.text) && /HELP/.test(r.text), r.s);
r = await anon.get('/api/legal/nope-nope/privacy'); ok('unknown business has no legal page', r.s === 404, r.s);
r = await anon.get('/api/legal/alpha-hauling/evil'); ok('unknown legal doc 404', r.s === 404, r.s);
{ const x = await (await fetch(BASE + '/privacy/alpha-hauling')).text(); ok('short privacy URL works', x.includes('Privacy Policy')); }

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

// ---------- delete my account (required by the app stores) ----------
{
  const O = new Client(), T = new Client();
  r = await O.post('/api/auth/signup', { business: 'Delta Delete Co', name: 'Dee Owner', email: 'dee@delta.test', password: 'password4', city: 'Tomball', state: 'tx' }); ok('signup for deletion test', r.s === 200, r);
  const tid = r.j.business.id;
  r = await O.post('/api/customers', { name: 'Delete Me Customer', phone: '5551230000' }); ok('customer for deletion test', r.s === 200 || r.s === 201, r);
  r = await O.post('/api/team', { name: 'Walt Worker', email: 'walt@delta.test', password: 'password5', role: 'worker' }); ok('add worker', r.s === 200, r);
  r = await T.post('/api/auth/login', { email: 'walt@delta.test', password: 'password5' }); ok('worker signs in', r.s === 200, r);
  r = await anon.post('/api/auth/delete-account', { password: 'x', confirm: 'DELETE' }); ok('delete needs sign-in', r.s === 401, r);
  r = await T.post('/api/auth/delete-account', { password: 'wrong-password', confirm: 'DELETE' }); ok('delete needs the right password', r.s === 401, r);
  r = await T.post('/api/auth/delete-account', { password: 'password5', confirm: 'nope' }); ok('delete needs the typed confirmation', r.s === 400, r);
  r = await T.post('/api/auth/delete-account', { password: 'password5', confirm: 'delete' }); ok('worker deletes own account', r.s === 200 && r.j.deleted === 'user', r);
  r = await T.get('/api/auth/me'); ok('deleted worker is signed out', r.s === 401, r);
  r = await anon.post('/api/auth/login', { email: 'walt@delta.test', password: 'password5' }); ok('deleted worker cannot sign in', r.s === 401, r);
  const left = await sql`SELECT (SELECT count(*) FROM tenants WHERE id = ${tid}) AS t, (SELECT count(*) FROM users WHERE tenant_id = ${tid}) AS u, (SELECT count(*) FROM customers WHERE tenant_id = ${tid}) AS c`;
  ok('business survives a worker leaving', Number(left[0].t) === 1 && Number(left[0].u) === 1 && Number(left[0].c) === 1, left);
  r = await O.post('/api/auth/delete-account', { password: 'password4', confirm: 'DELETE' }); ok('owner deletes the business', r.s === 200 && r.j.deleted === 'business', r);
  const gone = await sql`SELECT (SELECT count(*) FROM tenants WHERE id = ${tid}) AS t, (SELECT count(*) FROM users WHERE tenant_id = ${tid}) AS u, (SELECT count(*) FROM customers WHERE tenant_id = ${tid}) AS c, (SELECT count(*) FROM services WHERE tenant_id = ${tid}) AS s`;
  ok('all of the business data is gone', ['t', 'u', 'c', 's'].every(k => Number(gone[0][k]) === 0), gone);
  const others = await sql`SELECT count(*) AS n FROM tenants`; ok('other businesses untouched', Number(others[0].n) === 2, others);
}

// ---------- phones with the app installed (push tokens) ----------
{
  const E = new Client(), F = new Client(), tok = 'dev-token-' + 'x'.repeat(40);
  r = await E.post('/api/auth/signup', { business: 'Echo Devices Co', name: 'Eve Owner', email: 'eve@echo.test', password: 'password6' }); ok('signup E', r.s === 200, r);
  r = await F.post('/api/auth/signup', { business: 'Foxtrot Devices Co', name: 'Fay Owner', email: 'fay@foxtrot.test', password: 'password7' }); ok('signup F', r.s === 200, r);
  r = await anon.post('/api/devices', { platform: 'ios', token: tok }); ok('device registration needs sign-in', r.s === 401, r);
  r = await E.post('/api/devices', { platform: 'windows', token: tok }); ok('device registration rejects an unknown platform', r.s === 400, r);
  r = await E.post('/api/devices', { platform: 'ios', token: 'short' }); ok('device registration rejects a short token', r.s === 400, r);
  r = await E.post('/api/devices', { platform: 'ios', token: tok }); ok('device registers', r.s === 200, r);
  r = await E.post('/api/devices', { platform: 'android', token: tok }); ok('same token registers again without duplicating', r.s === 200, r);
  const n1 = await sql`SELECT count(*) AS n, min(platform) AS p FROM devices WHERE token = ${tok}`; ok('one row per token', Number(n1[0].n) === 1 && n1[0].p === 'android', n1);
  r = await F.req('DELETE', '/api/devices', { token: tok }); ok('another business cannot remove it', r.s === 200, r);
  const n2 = await sql`SELECT count(*) AS n FROM devices WHERE token = ${tok}`; ok('still registered after the other business tried', Number(n2[0].n) === 1, n2);
  r = await E.req('DELETE', '/api/devices', { token: tok }); ok('device removed on sign-out', r.s === 200, r);
  const n3 = await sql`SELECT count(*) AS n FROM devices WHERE token = ${tok}`; ok('device row gone', Number(n3[0].n) === 0, n3);
  await E.post('/api/devices', { platform: 'ios', token: tok });
  r = await E.post('/api/auth/delete-account', { password: 'password6', confirm: 'DELETE' }); ok('deleting the account', r.s === 200, r);
  const n4 = await sql`SELECT count(*) AS n FROM devices WHERE token = ${tok}`; ok('deleting an account removes its devices', Number(n4[0].n) === 0, n4);
}

// ---------- photos are links, served one at a time, never inside lists ----------
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const A = new Client(), B = new Client(); r = await A.post('/api/auth/signup', { business: 'Photo Co', name: 'Phil', email: 'phil@photo.test', password: 'password9' }); ok('signup photo co', r.s === 200, r);
  await B.post('/api/auth/signup', { business: 'Other Co', name: 'Otto', email: 'otto@other.test', password: 'password9' });
  r = await A.post('/api/customers', { name: 'Cam Client', phone: '5552223333' }); const cA = r.j.customer;
  r = await A.post('/api/jobs', { customer_id: cA.id, title: 'Photo job', visit: { starts_at: '2026-11-05T15:00:00Z' } }); const pj = r.j.job; ok('photo job', r.s === 200, r);
  r = await A.get('/api/jobs/' + pj.id); const pv = r.j.visits[0]; r = await A.post('/api/visits/' + pv.id + '/photos', { data: png, caption: 'before' }); ok('photo added', r.s === 200, r);
  r = await A.get('/api/visits/' + pv.id); const ph = r.j.visit.photos; ok('visit photos are links', ph.length >= 1 && ph.every(p => /^\/api\/photos\/visit\/\d+\/\d+$/.test(p.data)), ph);
  const img = await fetch(BASE + ph[0].data, { headers: { cookie: A.cookie } }); ok('the photo loads as an image', img.status === 200 && /^image\//.test(img.headers.get('content-type')) && /max-age/.test(img.headers.get('cache-control')), img.status);
  r = await B.get(ph[0].data); ok('another business cannot load the photo', r.s === 404, r.s);
  r = await anon.get(ph[0].data); ok('signed-out cannot load the photo', r.s === 401, r.s);
  r = await A.get('/api/visits?from=2026-10-01&to=2026-12-01'); ok('schedule list carries a count, not pictures', r.j.visits.every(v => v.photos === undefined && typeof v.photo_count === 'number') && !JSON.stringify(r.j).includes('base64'), Object.keys(r.j.visits[0]));
  const slug = (await A.get('/api/auth/me')).j.business.slug;
  r = await anon.post('/api/public/b/' + slug + '/request', { name: 'Photo Pete', phone: '5557778888', message: 'see pics', photos: [png, png] }); ok('booking request with photos', r.s === 200, r);
  r = await A.get('/api/requests'); const pr = r.j.requests.find(x => x.name === 'Photo Pete'); ok('request list has photo links only', !!pr && pr.photos.length === 2 && pr.photos.every(u => /^\/api\/photos\/request\//.test(u)) && !JSON.stringify(r.j).includes('base64'), pr && pr.photos);
  const ri = await fetch(BASE + pr.photos[1], { headers: { cookie: A.cookie } }); ok('manager loads a request photo', ri.status === 200 && ri.headers.get('content-type') === 'image/png', ri.status);
  r = await A.get('/api/photos/request/' + pr.id + '/9'); ok('missing photo index is 404', r.s === 404, r.s);
  r = await A.get('/api/requests/' + pr.id); ok('request detail has photo links', r.j.request.photos.length === 2 && !JSON.stringify(r.j).includes('base64'), r.j.request.photos);
}

// ---------- card payments through Square (a local stand-in for Square's API) ----------
{
  const http = await import('node:http'); const sqOrders = new Map(); let links = 0, seq = 0;
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {}, auth = String(req.headers.authorization || '');
    const send = (st, o) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/oauth2/token') return body.code === 'goodcode' || body.grant_type === 'refresh_token' ? send(200, { access_token: 'oauth-access-token-0123456789', refresh_token: 'oauth-refresh-token-0123456789', expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }) : send(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'bad code' }] });
    if (!/Bearer (good-access-token-0123456789|oauth-access-token-0123456789|inactive-token-0123456789abc)$/.test(auth)) return send(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] });
    if (req.url === '/v2/locations') return send(200, { locations: /inactive/.test(auth) ? [{ id: 'L0', status: 'ACTIVE', capabilities: [], currency: 'USD' }] : [{ id: 'LOC1', merchant_id: 'M1', status: 'ACTIVE', business_name: 'Card Co Square', capabilities: ['CREDIT_CARD_PROCESSING'], currency: 'USD' }] });
    if (req.url === '/v2/online-checkout/payment-links' && req.method === 'POST') { links++; const id = 'ORD' + (++seq); sqOrders.set(id, { amount: body.quick_pay.price_money.amount, paid: false, name: body.quick_pay.name, loc: body.quick_pay.location_id, redirect: body.checkout_options.redirect_url }); return send(200, { payment_link: { id: 'PL' + seq, url: 'https://square.link/u/' + id, order_id: id } }); }
    const m = /^\/v2\/orders\/(\w+)$/.exec(req.url); if (m && sqOrders.has(m[1])) { const o = sqOrders.get(m[1]); return send(200, { order: { id: m[1], state: o.paid ? 'COMPLETED' : 'OPEN', tenders: o.paid ? [{ amount_money: { amount: o.amount, currency: 'USD' } }] : [] } }); }
    send(404, { errors: [{ code: 'NOT_FOUND', detail: 'nope' }] });
  });
  await new Promise(r2 => mock.listen(8798, r2)); process.env.SQUARE_API_BASE = 'http://localhost:8798';
  const C = new Client(), D = new Client(); r = await C.post('/api/auth/signup', { business: 'Card Co', name: 'Cora', email: 'cora@card.test', password: 'password10' }); ok('signup card co', r.s === 200, r);
  await D.post('/api/auth/signup', { business: 'Dee Co', name: 'Dee', email: 'dee@dee.test', password: 'password10' });
  r = await C.post('/api/team', { name: 'Mgr', email: 'mgr@card.test', password: 'password10', role: 'admin' }); const Mg = new Client(); await Mg.post('/api/auth/login', { email: 'mgr@card.test', password: 'password10' });
  r = await C.post('/api/customers', { name: 'Paula Payer', phone: '5554445555' }); const pc = r.j.customer;
  r = await C.post('/api/invoices', { customer_id: pc.id, items: [{ name: 'Haul', price: 250 }], tax_pct: 0 }); const inv = r.j.invoice; await C.post('/api/invoices/' + inv.id + '/send', { sms: false, email: false });
  r = await anon.get('/api/public/i/' + inv.token); ok('no pay button before Square is connected', r.s === 200 && r.j.online_payments === false, r.j);
  r = await anon.post('/api/public/i/' + inv.token + '/pay', {}); ok('cannot start a card payment before Square is connected', r.s === 400, r);
  r = await Mg.post('/api/square/token', { access_token: 'good-access-token-0123456789' }); ok('a manager cannot connect Square (owner only)', r.s === 403, r);
  r = await C.post('/api/square/token', { access_token: 'wrong-access-token-0123456789' }); ok('a bad Square token is refused with a clear message', r.s === 400 && /did not accept/.test(r.j.error), r);
  r = await C.post('/api/square/token', { access_token: 'inactive-token-0123456789abc' }); ok('a Square account that cannot take cards is refused', r.s === 400 && /cannot take card/.test(r.j.error), r);
  r = await C.post('/api/square/token', { access_token: 'good-access-token-0123456789' }); ok('owner connects Square', r.s === 200 && r.j.location_name === 'Card Co Square', r);
  r = await Mg.get('/api/square'); ok('status shows connected and never the token', r.s === 200 && r.j.connected && !JSON.stringify(r.j).includes('good-access'), r.j);
  const stored = await sql`SELECT secret_enc FROM integrations`; ok('the Square token is encrypted at rest', stored.length === 1 && !stored[0].secret_enc.includes('good-access-token'), stored);
  r = await anon.get('/api/public/i/' + inv.token); ok('pay button offered once connected', r.j.online_payments === true, r.j);
  r = await anon.post('/api/public/i/' + inv.token + '/pay', {}); const url1 = r.j && r.j.url; ok('checkout link created for the balance', r.s === 200 && /^https:\/\/square\.link\//.test(url1) && [...sqOrders.values()][0].amount === 25000 && [...sqOrders.values()][0].loc === 'LOC1' && /\/i\/.+\?paid=1$/.test([...sqOrders.values()][0].redirect), { r, o: [...sqOrders.values()] });
  r = await anon.post('/api/public/i/' + inv.token + '/pay', {}); ok('tapping Pay twice reuses the same checkout', r.s === 200 && r.j.url === url1 && links === 1, { url: r.j, links });
  r = await anon.get('/api/public/i/' + inv.token); ok('unpaid checkout leaves the balance', r.j.invoice.balance === 250, r.j.invoice);
  sqOrders.get('ORD1').paid = true;
  r = await anon.get('/api/public/i/' + inv.token); ok('paid checkout marks the invoice paid', r.j.invoice.balance === 0 && r.j.invoice.status === 'paid' && r.j.invoice.payments.length === 1 && r.j.invoice.payments[0].method === 'card' && r.j.online_payments === false, r.j);
  await Promise.all([anon.get('/api/public/i/' + inv.token), anon.get('/api/public/i/' + inv.token), anon.get('/api/public/i/' + inv.token)]);
  r = await C.get('/api/invoices/' + inv.id); ok('the card payment is recorded exactly once', r.j.invoice.payments.length === 1 && r.j.invoice.paid === 250 && r.j.invoice.payments[0].provider_id === 'sq:ORD1', r.j.invoice.payments);
  r = await anon.post('/api/public/i/' + inv.token + '/pay', {}); ok('a paid invoice cannot be paid again', r.s === 400, r);
  // deposit on a quote
  r = await C.post('/api/quotes', { customer_id: pc.id, items: [{ name: 'Big job', price: 1000 }], deposit_pct: 25, tax_pct: 0 }); const q = r.j.quote; await C.post('/api/quotes/' + q.id + '/send', { sms: false, email: false });
  r = await anon.post('/api/public/q/' + q.token + '/pay-deposit', {}); ok('deposit cannot be paid before approval', r.s === 400, r);
  await anon.post('/api/public/q/' + q.token + '/decide', { decision: 'approve', name: 'Paula Payer' });
  r = await anon.get('/api/public/q/' + q.token); ok('deposit pay button after approval', r.j.online_payments === true && r.j.quote.deposit_due === 250, r.j);
  r = await anon.post('/api/public/q/' + q.token + '/pay-deposit', {}); ok('deposit checkout created', r.s === 200 && sqOrders.get('ORD2').amount === 25000, r); sqOrders.get('ORD2').paid = true;
  r = await anon.get('/api/public/q/' + q.token); ok('paid deposit shows on the quote', r.j.quote.deposit_paid === true && r.j.online_payments === false, r.j.quote);
  r = await C.post('/api/invoices', { customer_id: pc.id, quote_id: q.id }); ok('card deposit is credited on the invoice', r.j.invoice.paid === 250 && r.j.invoice.balance === 750, r.j.invoice);
  // the scheduled job catches payments when the customer never comes back to the page
  r = await C.post('/api/invoices', { customer_id: pc.id, items: [{ name: 'Small', price: 40 }], tax_pct: 0 }); const inv3 = r.j.invoice; await C.post('/api/invoices/' + inv3.id + '/send', { sms: false, email: false });
  await anon.post('/api/public/i/' + inv3.token + '/pay', {}); sqOrders.get('ORD3').paid = true;
  r = await anon.req('GET', '/api/cron/run', undefined, { authorization: 'Bearer cron-test' }); ok('scheduled job records a finished card payment', r.s === 200 && r.j.paid >= 1, r);
  r = await C.get('/api/invoices/' + inv3.id); ok('invoice paid by the scheduled check', r.j.invoice.status === 'paid', r.j.invoice);
  r = await D.get('/api/square'); ok('another business is not connected', r.j.connected === false, r.j);
  r = await Mg.req('DELETE', '/api/square'); ok('a manager cannot disconnect Square', r.s === 403, r);
  // sign in with Square (OAuth)
  r = await D.get('/api/square/oauth/start'); ok('Square sign-in is off until the server has app keys', r.s === 400, r);
  process.env.SQUARE_APP_ID = 'sq0idp-test'; process.env.SQUARE_APP_SECRET = 'sq0csp-test';
  r = await D.get('/api/square/oauth/start'); const st = new URL(r.j.url).searchParams.get('state'); ok('Square sign-in link carries a signed state', r.s === 200 && /oauth2\/authorize\?client_id=sq0idp-test/.test(r.j.url) && !!st, r.j);
  let cb = await fetch(BASE + '/api/square/oauth/callback?code=goodcode&state=' + encodeURIComponent(st.slice(0, -3) + 'abc'), { redirect: 'manual' }); ok('a tampered state is refused', cb.status === 302 && /square=expired/.test(cb.headers.get('location')), cb.headers.get('location'));
  cb = await fetch(BASE + '/api/square/oauth/callback?code=badcode&state=' + encodeURIComponent(st), { redirect: 'manual' }); ok('a bad code does not connect', cb.status === 302 && /square=failed/.test(cb.headers.get('location')), cb.headers.get('location'));
  cb = await fetch(BASE + '/api/square/oauth/callback?code=goodcode&state=' + encodeURIComponent(st), { redirect: 'manual' }); ok('Square sign-in connects the right business', cb.status === 302 && /square=connected/.test(cb.headers.get('location')), cb.headers.get('location'));
  r = await D.get('/api/square'); ok('connected through Square sign-in', r.j.connected && r.j.mode === 'oauth', r.j);
  r = await C.req('DELETE', '/api/square'); ok('owner disconnects Square', r.s === 200, r);
  r = await anon.get('/api/public/i/' + inv3.token); r = await C.post('/api/invoices', { customer_id: pc.id, items: [{ name: 'After', price: 60 }] }); await C.post('/api/invoices/' + r.j.invoice.id + '/send', { sms: false, email: false });
  r = await anon.get('/api/public/i/' + r.j.invoice.token); ok('no pay button after disconnecting', r.j.online_payments === false, r.j);
  delete process.env.SQUARE_APP_ID; delete process.env.SQUARE_APP_SECRET; mock.close();
}

// ---------- two-way texting, STOP, on my way, quiet hours ----------
{
  const { twilioSignature } = await import('../lib/routes/reviews.js'); const { quietUntil } = await import('../lib/routes/comms.js');
  const T1 = new Client(), T2 = new Client(), TW = new Client();
  r = await T1.post('/api/auth/signup', { business: 'Text Co', name: 'Tina Texter', email: 'tina@text.test', password: 'password11' }); ok('signup text co', r.s === 200, r);
  await T2.post('/api/auth/signup', { business: 'Other Text', name: 'Omar', email: 'omar@text2.test', password: 'password11' });
  r = await T1.post('/api/team', { name: 'Wes Worker', email: 'wes@text.test', password: 'password11', role: 'worker' }); const wes = r.j.member; await TW.post('/api/auth/login', { email: 'wes@text.test', password: 'password11' });
  r = await T1.post('/api/customers', { name: 'Rita Reply', phone: '5559990001', sms_opt_in: true }); const rc = r.j.customer;
  r = await T1.post('/api/messages', { customer_id: rc.id, body: 'Hi Rita, see you at 9' }); ok('outbound text saved', r.s === 200, r);
  const inbound = async (params, { sign = true, token = 'twilio-test-token' } = {}) => { const url = BASE + '/api/webhooks/twilio/inbound', body = new URLSearchParams(params).toString();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign ? twilioSignature(token, url, params) : 'nope' }, body }); return { s: res.status, t: await res.text(), ct: res.headers.get('content-type') }; };
  r = await inbound({ From: '+15559990001', Body: 'ok thanks', MessageSid: 'SMin1' }); ok('inbound webhook is off until Twilio is configured', r.s === 404, r);
  process.env.TWILIO_AUTH_TOKEN = 'twilio-test-token'; process.env.PUBLIC_URL = BASE;
  r = await inbound({ From: '+15559990001', Body: 'ok thanks', MessageSid: 'SMin1' }, { sign: false }); ok('unsigned inbound text is refused', r.s === 403, r);
  r = await inbound({ From: '+15559990001', Body: 'ok thanks', MessageSid: 'SMin1' }); ok('signed inbound text accepted with TwiML', r.s === 200 && /<Response>/.test(r.t) && /xml/.test(r.ct), r);
  await inbound({ From: '+15559990001', Body: 'ok thanks', MessageSid: 'SMin1' });
  r = await T1.get('/api/inbox'); ok('reply shows in the right business inbox, once, unread', r.s === 200 && r.j.conversations.length === 1 && r.j.conversations[0].unread === 1 && r.j.conversations[0].body === 'ok thanks' && r.j.unread === 1, r.j);
  r = await T2.get('/api/inbox'); ok('another business does not see the reply', r.j.conversations.length === 0, r.j);
  r = await TW.get('/api/inbox'); ok('workers cannot read the inbox', r.s === 403, r.s);
  r = await T1.get('/api/inbox/' + rc.id); ok('thread shows both directions in order', r.j.messages.length === 2 && r.j.messages[0].direction === 'out' && r.j.messages[1].direction === 'in', r.j.messages);
  r = await T1.get('/api/inbox'); ok('opening the thread marks it read', r.j.unread === 0, r.j);
  r = await T2.get('/api/inbox/' + rc.id); ok('another business cannot open the thread', r.s === 404, r.s);
  r = await inbound({ From: '+15559990001', Body: ' Stop. ', MessageSid: 'SMin2' }); const [oc] = await sql`SELECT sms_opt_in, sms_opt_out_at FROM customers WHERE id = ${rc.id}`; ok('STOP turns off texting for that customer', r.s === 200 && oc.sms_opt_in === false && !!oc.sms_opt_out_at, oc);
  r = await T1.post('/api/messages', { customer_id: rc.id, body: 'one more thing' }); ok('texts to a customer who said STOP are blocked', r.s === 200 && r.j.message.status === 'blocked', r.j);
  await inbound({ From: '+15559990001', Body: 'START', MessageSid: 'SMin3' }); const [oc2] = await sql`SELECT sms_opt_out_at FROM customers WHERE id = ${rc.id}`; ok('START lifts the block', oc2.sms_opt_out_at === null, oc2);
  r = await inbound({ From: '+15550000000', Body: 'who dis', MessageSid: 'SMin4' }); ok('a text from an unknown number is ignored quietly', r.s === 200, r);
  delete process.env.TWILIO_AUTH_TOKEN; delete process.env.PUBLIC_URL;
  // on my way
  r = await T1.post('/api/jobs', { customer_id: rc.id, title: 'Haul', visit: { starts_at: new Date(Date.now() + 3600e3).toISOString(), assigned: [wes.id] } }); const oj = r.j.job; r = await T1.get('/api/jobs/' + oj.id); const ov = r.j.visits[0];
  r = await TW.post('/api/visits/' + ov.id + '/omw', { eta_minutes: 20 }); ok('assigned worker sends on-my-way', r.s === 200 && r.j.status === 'preview', r);
  const [om] = await sql`SELECT body, kind FROM messages WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = 'tina@text.test') AND kind = 'on_my_way'`; ok('on-my-way text names the worker and the wait', !!om && /Wes from Text Co is on the way/.test(om.body) && /20 minutes/.test(om.body), om);
  r = await TW.post('/api/visits/' + ov.id + '/omw', {}); ok('on-my-way is sent once per visit per day', r.s === 200 && r.j.already === true, r);
  r = await T1.post('/api/jobs', { customer_id: rc.id, title: 'Not his', visit: { starts_at: new Date(Date.now() + 7200e3).toISOString() } }); r = await T1.get('/api/jobs/' + r.j.job.id);
  r = await TW.post('/api/visits/' + r.j.visits[0].id + '/omw', {}); ok('worker cannot send on-my-way for a visit that is not theirs', r.s === 403, r.s);
  // quiet hours: automatic texts wait for 8 AM local, hand-sent ones do not
  const at = h => new Date(Date.UTC(2026, 5, 10, h, 0, 0)); // June: Chicago is UTC-5
  ok('11 PM local holds a reminder until 8 AM local', quietUntil('appointment_reminder', 'America/Chicago', at(4)).toISOString() === '2026-06-10T13:00:00.000Z', quietUntil('appointment_reminder', 'America/Chicago', at(4)));
  ok('7 AM local still holds', !!quietUntil('review_request', 'America/Chicago', at(12)), 1); ok('8 AM local sends', quietUntil('invoice_reminder', 'America/Chicago', at(13)) === null, 1);
  ok('8:59 PM local sends, 9 PM holds', quietUntil('quote_followup', 'America/Chicago', new Date(Date.UTC(2026, 5, 11, 1, 59))) === null && !!quietUntil('quote_followup', 'America/Chicago', new Date(Date.UTC(2026, 5, 11, 2, 0))), 1);
  ok('texts a person sends are never held', quietUntil('manual', 'America/Chicago', at(4)) === null && quietUntil('on_my_way', 'America/Chicago', at(4)) === null && quietUntil('invoice', 'America/Chicago', at(4)) === null, 1);
}

// ---------- import, export, quick prices, logo, signature ----------
{
  const I = new Client(), I2 = new Client(), IW = new Client(); r = await I.post('/api/auth/signup', { business: 'Import Co', name: 'Ivy', email: 'ivy@import.test', password: 'password12' }); ok('signup import co', r.s === 200, r);
  await I.post('/api/team', { name: 'Wyn', email: 'wyn@import.test', password: 'password12', role: 'worker' }); await IW.post('/api/auth/login', { email: 'wyn@import.test', password: 'password12' });
  await I.post('/api/customers', { name: 'Already Here', phone: '5551110000' });
  const rows = [{ name: 'New One', phone: '(555) 222-0000', email: 'one@x.test', address: '1 Main St', city: 'Avon', state: 'in', zip: '46123' }, { name: 'Dup Phone', phone: '555-111-0000' }, { name: '', phone: '5553330000' }, { name: 'New Two', email: 'two@x.test' }, { name: 'Dup In File', email: 'TWO@x.test' }, { name: '=HYPERLINK("http://evil")', phone: '5554440000' }];
  r = await I.post('/api/import/customers', { rows }); ok('import adds new people and skips duplicates and blanks', r.s === 200 && r.j.added === 3 && r.j.skipped === 2 && r.j.invalid === 1, r.j);
  r = await I.post('/api/import/customers', { rows }); ok('importing the same file again adds nothing', r.j.added === 0, r.j);
  r = await IW.post('/api/import/customers', { rows }); ok('workers cannot import', r.s === 403, r.s);
  r = await I.post('/api/import/customers', { rows: Array.from({ length: 2001 }, (_, i) => ({ name: 'N' + i })) }); ok('import size is capped', r.s === 400, r.s);
  r = await I.get('/api/export/customers.csv'); ok('customer export has the imported address', r.s === 200 && /New One,,5552220000,one@x\.test,1 Main St,Avon,IN,46123/.test(r.text), r.text.slice(0, 300));
  ok('a formula in a name is defused in the export', r.text.includes(`"'=HYPERLINK(""http://evil"")"`), r.text);
  r = await IW.get('/api/export/customers.csv'); ok('workers cannot export customers', r.s === 403, r.s);
  r = await I.put('/api/business/pricing', { loads: [{ label: '1/4 truck', price: '$225' }, { label: 'Full truck', price: 650 }, { label: '', price: 5 }, { label: 'Free', price: 0 }], hourly: { rate: 65, min_hours: 2, truck_fee: 50 }, show_on_booking: true });
  ok('quick prices saved and cleaned', r.s === 200 && r.j.pricing.loads.length === 2 && r.j.pricing.loads[0].price === 225 && r.j.pricing.hourly.rate === 65, r.j);
  const slug = (await I.get('/api/auth/me')).j.business.slug; r = await anon.get('/api/public/b/' + slug); ok('booking page shows the price guide when turned on', r.j.pricing && r.j.pricing.loads.length === 2 && r.j.pricing.hourly.min_hours === 2, r.j);
  await I.put('/api/business/pricing', { loads: [{ label: 'Full truck', price: 650 }], show_on_booking: false }); r = await anon.get('/api/public/b/' + slug); ok('price guide hidden when turned off', r.j.pricing === null, r.j);
  r = await I.get('/api/auth/me'); ok('saving prices did not wipe other settings', r.j.business.settings.pricing.loads.length === 1, r.j.business.settings);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await I.put('/api/business/logo', { data: 'data:text/html;base64,PGI+' }); ok('logo must be an image', r.s === 400, r.s);
  r = await I.put('/api/business/logo', { data: png }); ok('logo saved', r.s === 200 && r.j.business.settings.logo === png && r.j.business.settings.pricing.loads.length === 1, Object.keys(r.j.business.settings));
  r = await I.get('/api/customers'); const ic = r.j.customers.find(c => c.name === 'New One');
  r = await I.post('/api/quotes', { customer_id: ic.id, items: [{ name: 'Full truck', price: 650 }] }); const iq = r.j.quote; await I.post('/api/quotes/' + iq.id + '/send', { sms: false, email: false });
  r = await anon.get('/api/public/q/' + iq.token); ok('customer quote page carries the logo', r.j.business.logo === png, Object.keys(r.j.business));
  r = await anon.post('/api/public/q/' + iq.token + '/decide', { decision: 'approve', name: 'New One', signature: 'data:image/svg+xml;base64,AAAA' }); ok('approve with a bad signature image still approves, without it', r.s === 200, r);
  r = await anon.get('/api/public/q/' + iq.token); ok('bad signature was not stored', r.j.quote.signature === '', r.j.quote.signature);
  r = await anon.post('/api/public/q/' + iq.token + '/decide', { decision: 'approve', name: 'Again' }); ok('a quote cannot be answered twice', r.s === 400, r);
  r = await I.post('/api/quotes', { customer_id: ic.id, items: [{ name: 'Half truck', price: 400 }] }); const iq2 = r.j.quote; await I.post('/api/quotes/' + iq2.id + '/send', { sms: false, email: false });
  r = await anon.post('/api/public/q/' + iq2.token + '/decide', { decision: 'approve', name: 'New One', signature: png }); ok('approve with a drawn signature', r.s === 200, r);
  r = await I.get('/api/quotes/' + iq2.id); ok('signature is kept with the approval', r.j.quote.signature === png && r.j.quote.signed_name === 'New One' && !!r.j.quote.signed_ip, { n: r.j.quote.signed_name, ip: r.j.quote.signed_ip });
  r = await I.get('/api/quotes'); ok('quote list flags the signature without carrying the image', r.j.quotes.find(q => q.id === iq2.id).has_signature === true && !JSON.stringify(r.j).includes('iVBOR'), 1);
  r = await anon.get('/api/public/i/nope'); const hd = await fetch(BASE + '/app'); ok('pages carry a content security policy', /default-src 'self'/.test(hd.headers.get('content-security-policy') || ''), hd.headers.get('content-security-policy'));
}

// ---------- any kind of service business: the trade only chooses the starting price list ----------
{
  r = await anon.get('/api/public/trades'); ok('trade list is public and broad', r.s === 200 && r.j.trades.length >= 8 && r.j.trades.some(t => t.key === 'cleaning') && r.j.trades.some(t => t.key === 'other'), r.j);
  const G = new Client(); r = await G.post('/api/auth/signup', { business: 'Sparkle Clean', name: 'Gia', email: 'gia@clean.test', password: 'password13', trade: 'cleaning' }); ok('signup as a cleaning business', r.s === 200, r);
  r = await G.get('/api/services'); ok('cleaning business starts with cleaning prices', r.j.services.some(x => x.name === 'Deep clean') && !r.j.services.some(x => /truck/i.test(x.name)), r.j.services.map(x => x.name));
  r = await G.get('/api/auth/me'); ok('trade is remembered', r.j.business.settings.trade === 'cleaning', r.j.business.settings);
  const G2 = new Client(); r = await G2.post('/api/auth/signup', { business: 'Mystery Co', name: 'Max', email: 'max@mystery.test', password: 'password13', trade: 'not-a-trade' }); r = await G2.get('/api/services');
  ok('an unknown or missing trade gets the general price list', r.j.services.some(x => x.name === 'Service call') && r.j.services.length === 3, r.j.services.map(x => x.name));
}

// ---------- money: concurrent payments, edits, deposits ----------
{
  const M = new Client(); r = await M.post('/api/auth/signup', { business: 'Mike Money', name: 'Mike', email: 'mike@money.test', password: 'password7' }); ok('signup money', r.s === 200, r);
  r = await M.post('/api/customers', { name: 'Pat Payer', phone: '5553334444' }); const pc = r.j.customer;
  r = await M.post('/api/invoices', { customer_id: pc.id, items: [{ name: 'Haul', price: 100 }], tax_pct: 0 }); const inv = r.j.invoice; ok('invoice made', r.s === 200 && inv.total === 100, r);
  const both = await Promise.all([1, 2, 3, 4].map(() => M.post('/api/invoices/' + inv.id + '/payments', { amount: 25, method: 'cash' })));
  r = await M.get('/api/invoices/' + inv.id); ok('four payments at the same moment are all kept', both.every(x => x.s === 200) && r.j.invoice.payments.length === 4 && r.j.invoice.paid === 100 && r.j.invoice.status === 'paid', { s: both.map(x => x.s), n: r.j.invoice.payments.length, paid: r.j.invoice.paid });
  r = await M.post('/api/invoices/' + inv.id + '/payments', { amount: 1, method: 'cash' }); ok('cannot overpay', r.s === 400, r);
  r = await M.put('/api/invoices/' + inv.id, { items: [{ name: 'Haul', price: 160 }] }); ok('raising a paid invoice makes it partial again', r.s === 200 && r.j.invoice.status === 'partial' && r.j.invoice.balance === 60 && !r.j.invoice.paid_at, r.j.invoice);
  r = await M.put('/api/invoices/' + inv.id, { items: [{ name: 'Haul', price: 100 }] }); ok('lowering it back makes it paid', r.s === 200 && r.j.invoice.status === 'paid' && !!r.j.invoice.paid_at, r.j.invoice);
  // deposit paid on the quote is credited to the first invoice from that quote, once
  r = await M.post('/api/quotes', { customer_id: pc.id, items: [{ name: 'Big haul', price: 400 }], deposit: 100, tax_pct: 0 }); const q = r.j.quote; ok('quote with deposit', r.s === 200 && q.deposit_due === 100, r);
  r = await M.post('/api/quotes/' + q.id + '/deposit-paid', { method: 'zelle' }); ok('deposit marked', r.s === 200, r);
  r = await M.post('/api/invoices', { customer_id: pc.id, quote_id: q.id }); ok('deposit is credited on the invoice', r.s === 200 && r.j.invoice.paid === 100 && r.j.invoice.balance === 300 && r.j.invoice.status === 'partial' && r.j.invoice.payments[0].deposit === true, r.j.invoice);
  r = await M.post('/api/invoices', { customer_id: pc.id, quote_id: q.id }); ok('deposit is not credited twice', r.s === 200 && r.j.invoice.paid === 0, r.j.invoice);
}

// ---------- forgot password, reset, and signing out other devices ----------
{
  const { createHash } = await import('node:crypto');
  const P = new Client(), P2 = new Client(); r = await P.post('/api/auth/signup', { business: 'Reset Co', name: 'Rita', email: 'rita@reset.test', password: 'password8' }); ok('signup reset', r.s === 200, r);
  r = await P2.post('/api/auth/login', { email: 'rita@reset.test', password: 'password8' }); ok('second device signed in', r.s === 200, r);
  r = await anon.post('/api/auth/forgot', { email: 'nobody@nowhere.test' }); const unknown = JSON.stringify(r.j);
  r = await anon.post('/api/auth/forgot', { email: 'rita@reset.test' }); ok('forgot answers the same for known and unknown emails', r.s === 200 && JSON.stringify(r.j) === unknown, r);
  const rows = await sql`SELECT pr.token_hash FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email = 'rita@reset.test'`; ok('one reset token stored, hashed', rows.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].token_hash), rows);
  r = await anon.post('/api/auth/reset', { token: 'not-the-token', password: 'newpassword9' }); ok('wrong reset token refused', r.s === 400, r);
  const [u] = await sql`SELECT id FROM users WHERE email = 'rita@reset.test'`, known = 'known-test-token-0123456789';
  await sql`UPDATE password_resets SET token_hash = ${createHash('sha256').update(known).digest('hex')} WHERE user_id = ${u.id}`;
  r = await anon.post('/api/auth/reset', { token: known, password: 'short' }); ok('reset needs 8+ characters', r.s === 400, r);
  const R = new Client(); r = await R.post('/api/auth/reset', { token: known, password: 'newpassword9' }); ok('reset works and signs in', r.s === 200 && !!R.cookie, r);
  r = await R.get('/api/auth/me'); ok('signed in after reset', r.s === 200 && r.j.user.email === 'rita@reset.test', r);
  r = await anon.post('/api/auth/reset', { token: known, password: 'another-pass1' }); ok('reset link works once', r.s === 400, r);
  r = await P.get('/api/auth/me'); ok('old sessions are signed out after a reset', r.s === 401, r); r = await P2.get('/api/auth/me'); ok('every old device is signed out', r.s === 401, r);
  r = await anon.post('/api/auth/login', { email: 'rita@reset.test', password: 'password8' }); ok('old password no longer works', r.s === 401, r); anon.cookie = '';
  const R2 = new Client(); r = await R2.post('/api/auth/login', { email: 'rita@reset.test', password: 'newpassword9' }); ok('new password works', r.s === 200, r);
  r = await R.post('/api/auth/password', { current: 'newpassword9', password: 'thirdpassword1' }); ok('change password', r.s === 200, r);
  r = await R.get('/api/auth/me'); ok('the device that changed it stays signed in', r.s === 200, r); r = await R2.get('/api/auth/me'); ok('other devices are signed out on password change', r.s === 401, r);
  for (let i = 0; i < 6; i++) r = await anon.post('/api/auth/forgot', { email: 'rita@reset.test' }); ok('forgot is rate limited per email', r.s === 429, r);
}

srv.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
