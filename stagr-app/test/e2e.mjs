// Browser walk-through: a new business signs up and runs a job from request to payment. Run: node test/e2e.mjs
import { execSync } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const PGBIN = '/usr/lib/postgresql/16/bin', DB = 'stagr_e2e';
const psql = c => execSync(`${PGBIN}/psql -h /tmp -p 5544 -U postgres -qAt -c "${c}"`);
psql(`DROP DATABASE IF EXISTS ${DB}`); psql(`CREATE DATABASE ${DB}`);
process.env.DATABASE_URL = `postgresql://postgres@/${DB}?host=/tmp&port=5544`; process.env.SESSION_SECRET = 'e2e-secret-e2e-secret-e2e-secret';
const { start } = await import('../dev/server.mjs'); const srv = await start(8796); const BASE = 'http://localhost:8796';
const ok = (n, c, x) => console.log(c ? 'PASS' : 'FAIL', n, c ? '' : String(x ?? '').slice(0, 200));
const b = await chromium.launch(); let errs = [];
for (const [w, h, t] of [[1280, 860, 'd'], [390, 844, 'm']]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: t === 'm', isMobile: t === 'm' }), p = await ctx.newPage(); errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/fonts|net::|Failed to load resource/.test(m.text()) && errs.push(m.text()));
  const email = `owner-${t}@e2e.test`;
  await p.goto(BASE + '/app'); await p.waitForSelector('#authForm');
  await p.click('[data-mode=signup]'); await p.fill('[name=business]', 'Lone Star Cleaning ' + t); await p.fill('[name=name]', 'Pat Owner'); await p.fill('[name=city]', 'Katy'); await p.fill('[name=state]', 'TX'); await p.fill('[name=phone]', '7135550100'); await p.fill('[name=email]', email); await p.fill('[name=password]', 'password123');
  await p.click('button[type=submit]'); await p.waitForSelector('#main h1'); ok(t + ' signed up and landed on home', (await p.textContent('#main h1')).toLowerCase().includes('pat'), await p.textContent('#main h1'));
  await p.screenshot({ path: `/tmp/pw/stagr-${t}-home.png` });
  // customer
  await p.goto(BASE + '/app#/customers'); await p.waitForSelector('#addC'); await p.click('#addC'); await p.fill('#cf [name=name]', 'Sam Rivera'); await p.fill('#cf [name=phone]', '2815551000'); await p.fill('#cf [name=email]', 'sam@x.test'); await p.fill('#cf [name=address]', '12 Oak St'); await p.check('#cf [name=sms]');
  await p.click('#cf button[type=submit]'); await p.waitForSelector('#newQuote'); ok(t + ' customer created', (await p.textContent('#main h1')).includes('Sam Rivera'));
  // quote
  await p.click('#newQuote'); await p.waitForSelector('#qf'); await p.waitForFunction(() => document.querySelector('#cust').value);
  await p.fill('[data-line] [data-f=name]', 'Service call'); await p.waitForTimeout(100); await p.fill('[data-line] [data-f=price]', '120'); await p.click('#addLine'); await p.locator('[data-line]').nth(1).locator('[data-f=name]').fill('Extra labor'); await p.locator('[data-line]').nth(1).locator('[data-f=price]').fill('80');
  ok(t + ' quote total updates live', (await p.textContent('#tot')).includes('$200.00'), await p.textContent('#tot'));
  await p.locator('#qf').evaluate(f => f.scrollIntoView()); await p.waitForTimeout(3200); await p.screenshot({ path: `/tmp/pw/stagr-${t}-quote.png` });
  await p.click('#qf button[data-send]'); await p.waitForURL(/#\/quotes\/\d+/); await p.waitForSelector('#edit'); ok(t + ' quote saved, sent, and shown on its detail page', (await p.textContent('#main')).includes('Quote #1') && (await p.textContent('#main')).includes('Service call'), (await p.textContent('#main')).slice(0, 200));
  const token = await p.evaluate(async () => (await (await fetch('/api/quotes')).json()).quotes[0].token);
  // customer approves on their own page
  const cust = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage(); await cust.goto(BASE + '/q/' + token); await cust.waitForSelector('#f');
  await cust.screenshot({ path: `/tmp/pw/stagr-${t}-public-quote.png`, fullPage: true }); await cust.fill('[name=name]', 'Sam Rivera'); await cust.click('#f button[type=submit]'); await cust.waitForSelector('.ok'); ok(t + ' customer approved quote', (await cust.textContent('.ok')).includes('Thank you'));
  await cust.context().close();
  // job from approved quote, repeating weekly
  await p.reload(); await p.waitForSelector('#toJob'); ok(t + ' approved quote shows Convert to Job', (await p.textContent('#main')).includes('Approved')); await p.click('#toJob'); await p.waitForSelector('#jf'); await p.waitForFunction(() => document.querySelector('#cust').value);
  ok(t + ' default start is 9:00 AM business time', (await p.inputValue('#start')).endsWith('T09:00'), await p.inputValue('#start')); await p.selectOption('#rep', 'weekly'); await p.click('#jf button[type=submit]'); await p.waitForURL(/#\/jobs\/\d+/); await p.waitForSelector('#inv'); ok(t + ' recurring job created from quote', (await p.textContent('#main')).includes('repeats weekly'));
  const nv = await p.locator('#main [data-visit]').count(); ok(t + ' many weekly visits generated', nv >= 10, nv);
  await p.goto(BASE + '/app#/schedule'); await p.waitForSelector('.week'); await p.click('#next'); await p.waitForTimeout(600); await p.screenshot({ path: `/tmp/pw/stagr-${t}-schedule.png` });
  // complete a visit and invoice
  await p.goto(BASE + '/app#/jobs'); await p.click('.item'); await p.waitForSelector('#inv'); await p.click('#main [data-visit]'); await p.waitForSelector('#done'); await p.click('#done'); await p.waitForTimeout(500);
  await p.waitForSelector('#inv'); await p.click('#inv'); await p.waitForSelector('#qf'); await p.waitForFunction(() => document.querySelector('#cust').value && document.querySelector('#tot').textContent.includes('Total')); ok(t + ' invoice form starts with the job items', (await p.textContent('#tot')).includes('$200.00'), await p.textContent('#tot'));
  await p.click('#qf button:not([data-send])[type=submit]'); await p.waitForSelector('#pay'); ok(t + ' invoice created', (await p.textContent('#main h1')).includes('INV-1001'));
  await p.fill('#pay [name=amount]', '50'); await p.selectOption('#pay [name=method]', 'zelle'); await p.click('#pay button'); await p.waitForTimeout(700); ok(t + ' partial payment recorded', (await p.textContent('#main')).includes('$150.00'), (await p.textContent('#main')).slice(0, 400));
  await p.screenshot({ path: `/tmp/pw/stagr-${t}-invoice.png` });
  // booking page
  const book = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage(); const slug = await p.evaluate(async () => (await (await fetch('/api/auth/me')).json()).business.slug);
  await book.goto(BASE + '/b/' + slug); await book.waitForSelector('#f'); await book.fill('[name=first]', 'Web'); await book.fill('[name=last]', 'Lead'); await book.fill('[name=phone]', '7135559000'); await book.fill('[name=email]', 'web@lead.test'); await book.check('[name=sms_ok]'); await book.fill('[name=street]', '5 Elm St'); await book.fill('[name=city]', 'Katy'); await book.fill('[name=message]', 'Need a deep clean'); await book.fill('[name=d1]', '2026-11-03'); await book.check('[name=arr][value=morning]'); await book.screenshot({ path: `/tmp/pw/stagr-${t}-booking.png`, fullPage: true }); await book.click('#f button[type=submit]'); await book.waitForSelector('.ok'); ok(t + ' booking request sent', (await book.textContent('.ok')).includes('Your request has been confirmed')); await book.context().close();
  await p.goto(BASE + '/app#/requests'); await p.waitForSelector('text=Web Lead'); ok(t + ' request shows up for the owner', true);
  await p.click('a:has-text("Open")'); await p.waitForSelector('#notes'); ok(t + ' request detail shows availability and consent', (await p.textContent('#main')).includes('Morning') && (await p.textContent('#main')).includes('agreed'));
  await p.fill('#notes', 'Call before 5'); await p.locator('#notes').blur(); await p.waitForTimeout(500);
  await p.click('summary:has-text("More")'); await p.click('#toQuote'); await p.waitForURL(/#\/quotes\/\d+/); await p.waitForSelector('#edit'); ok(t + ' Convert to Quote opens the new quote', (await p.textContent('#main')).includes('Web Lead'));
  await p.screenshot({ path: `/tmp/pw/stagr-${t}-quote-detail.png` });
  for (const r of ['reports', 'messages', 'settings', 'invoices', 'quotes']) { await p.goto(BASE + '/app#/' + r); await p.waitForSelector('#main h1'); }
  await p.goto(BASE + '/app#/messages'); await p.waitForSelector('[data-tog]'); await p.screenshot({ path: `/tmp/pw/stagr-${t}-messages.png` });
  await p.goto(BASE + '/app#/messages'); await p.waitForSelector('#rvEdit'); await p.click('#rvEdit'); await p.waitForSelector('#rs'); await p.fill('#rs [name=link]', 'https://g.page/r/E2E/review'); await p.check('#rs [name=enabled]'); await p.selectOption('#rs [name=when]', 'morning'); await p.click('#rs button[type=submit]'); await p.waitForTimeout(700);
  ok(t + ' review settings saved', (await p.textContent('#main')).includes('auto-send on') && (await p.textContent('#main')).includes('next morning'));
  await p.screenshot({ path: `/tmp/pw/stagr-${t}-reviews.png` });
  await p.goto(BASE + '/app#/customers'); await p.waitForSelector('#main .item'); await p.click('#main .item >> nth=0'); await p.waitForSelector('#rvw'); await p.click('#rvw'); await p.waitForSelector('#rf');
  ok(t + ' review text has the link', (await p.inputValue('#rt')).includes('g.page/r/E2E/review')); await p.click('#rf button[type=submit]'); await p.waitForTimeout(800);
  ok(t + ' review request shows in customer history', (await p.textContent('#main')).includes('Review requests') && (await p.textContent('#main')).includes('preview'));
  await p.goto(BASE + '/app#/reports'); await p.waitForSelector('.stat'); await p.screenshot({ path: `/tmp/pw/stagr-${t}-reports.png` });
  ok(t + ' no horizontal overflow', await p.evaluate(() => document.documentElement.scrollWidth) <= w + 1, await p.evaluate(() => document.documentElement.scrollWidth));
  ok(t + ' no JS errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
await b.close(); srv.close(); process.exit(0);
