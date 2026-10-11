// Public privacy policy and text-message terms for each business, so every business can give carriers (A2P 10DLC / toll-free) a link
// that anyone can open without logging in. The pages are filled in from the business profile.
import { route } from '../router.js';
import { missing } from '../http.js';
import { sql } from '../db.js';
import { clean } from '../util.js';

const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (t, title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · ${h(t.name)}</title><link rel="icon" href="/favicon.png">
<style>body{margin:0;background:#0b0f0c;color:#e8efe9;font:16px/1.6 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:28px 18px 60px}h1{font-size:1.8rem;margin:0 0 4px}h2{font-size:1.15rem;margin:26px 0 6px;color:#39ff14}p,li{color:#c9d3cb}a{color:#39ff14}.mute{color:#8a968d;font-size:.9rem}</style></head><body><main>${body}<p class="mute" style="margin-top:34px">Powered by <a href="/">STAGR</a></p></main></body></html>`;
const contact = t => `<p><b>${h(t.name)}</b>${t.city ? '<br>' + h([t.city, t.state].filter(Boolean).join(', ')) : ''}${t.phone ? '<br>Phone: ' + h(t.phone) : ''}${t.email ? '<br>Email: <a href="mailto:' + h(t.email) + '">' + h(t.email) + '</a>' : ''}</p>`;

const privacy = t => page(t, 'Privacy Policy', `<h1>Privacy Policy</h1><p class="mute">${h(t.name)} · Last updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
<h2>Who we are</h2>${contact(t)}
<h2>What we collect</h2><p>When you ask for a quote, book a job, or become our customer, we collect your name, phone number, email address, service address, and details about the work and payments for your jobs.</p>
<h2>How we use it</h2><p>We use your information to answer your request, schedule and complete work, send quotes and invoices, take payments, send appointment reminders and follow-ups, and ask for feedback or a review. With your consent we may also send promotional offers.</p>
<h2>Text messages</h2><p>If you give us your mobile number, we may text you about your service: quotes, appointment reminders, invoices, and review requests. We send promotional texts only if you agreed to receive them. Message frequency varies. Message and data rates may apply. Reply <b>STOP</b> to any text to opt out at any time, or <b>HELP</b> for help. See our <a href="/sms-terms/${h(t.slug)}">text message terms</a>.</p>
<h2>No selling or sharing for marketing</h2><p><b>We do not sell your personal information, and we do not share your mobile number or text-messaging opt-in data with third parties or affiliates for their marketing purposes.</b> We share information only with service providers that help us run our business (for example, our texting provider, email provider, payment processor, and software host), and only as needed to provide those services.</p>
<h2>How we protect it</h2><p>Our systems require a login, and access is limited to our staff. Data is stored with reputable cloud providers and sent over encrypted connections.</p>
<h2>Your choices</h2><p>You can ask us to see, correct, or delete your information, or stop messages, by contacting us using the details above.</p>`);

const terms = t => page(t, 'Text Message Terms', `<h1>Text Message Terms</h1><p class="mute">${h(t.name)} text messaging program</p>
<h2>Program</h2><p>${h(t.name)} sends text messages to customers who give us their mobile number, including quotes and booking confirmations, appointment reminders, invoice and payment reminders, requests for a Google review after a job, and, only if you agreed to them, promotional offers.</p>
<h2>How you opt in</h2><p>You opt in by giving us your mobile number on our online booking or quote request form, by phone, or in person. Promotional texts are sent only if you check the box agreeing to receive marketing texts. Consent to texts is not a condition of buying anything.</p>
<h2>Frequency and cost</h2><p>Message frequency varies with your service. Message and data rates may apply.</p>
<h2>Opt out and help</h2><p>Reply <b>STOP</b> at any time to stop receiving texts. You will get one message confirming that you are unsubscribed. Reply <b>HELP</b> for help, or contact us below.</p>
<h2>Carriers</h2><p>Carriers are not liable for delayed or undelivered messages.</p>
<h2>Privacy</h2><p>We do not sell or share your mobile number or opt-in data with third parties for marketing. See our <a href="/privacy/${h(t.slug)}">Privacy Policy</a>.</p>
<h2>Contact</h2>${contact(t)}`);

const serve = async ctx => {
  const [t] = await sql`SELECT name, slug, phone, email, city, state FROM tenants WHERE slug = ${clean(ctx.params.slug, 80)}`;
  const doc = ctx.params.doc || ctx.doc; if (!t || (doc !== 'privacy' && doc !== 'sms-terms')) throw missing('Page not found');
  return { __raw: true, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }, body: doc === 'privacy' ? privacy(t) : terms(t) };
};
route('GET', '/api/legal/:slug/:doc', { public: true }, serve);
route('GET', '/privacy/:slug', { public: true }, ctx => serve({ ...ctx, doc: 'privacy' }));
route('GET', '/sms-terms/:slug', { public: true }, ctx => serve({ ...ctx, doc: 'sms-terms' }));
