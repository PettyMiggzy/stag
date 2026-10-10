# STAGR app

Field-service business software (customers, requests, quotes, jobs and scheduling, invoices and payments,
follow-up texts, reports) for any service business. Multi-tenant: every business signs up and sees only its own data.

## Run it locally
```
npm install
export DATABASE_URL=postgres://...    # any Postgres. Neon works.
export SESSION_SECRET=...             # 24+ random characters
npm run dev                           # http://localhost:8790/app
npm test                              # 109 API tests (needs local Postgres, see test/run.mjs)
node test/e2e.mjs                     # browser walk-through (Playwright)
```

## Deploy (Vercel)
Create a Vercel project with this folder (`stagr-app`) as the root. Set these environment variables:

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Neon). Tables are created automatically on first request. |
| `SESSION_SECRET` | yes | 24+ random characters. Signs the sign-in cookie. |
| `CRON_SECRET` | yes | Random string. Vercel Cron sends it to `/api/cron/run` every 15 minutes to send due reminders. |
| `PUBLIC_URL` | recommended | e.g. `https://app.stagr.example`. Used for links in texts and emails. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | for texting | Without these, texts are saved as **preview** and not sent. |
| `RESEND_API_KEY`, `EMAIL_FROM` | for email | Without these, emails are saved as **preview** and not sent. |

## How it is built
- `api/index.js` is one serverless function; `lib/router.js` dispatches `/api/*`. Routes are in `lib/routes/`.
- **Tenant isolation:** the signed-in user's `tenant_id` is read from the database, never from the request, and every query on business data filters by it. `npm test` (131 checks) signs up two businesses and checks that neither can read or change the other's customers, quotes, jobs, visits, invoices, payments, messages or requests, then scans the database for any row that points across businesses.
- Money: quotes and invoices store line items; totals are computed on the server. Payments are recorded on the invoice (cash, check, Zelle, card terminal).
- Recurring jobs create visits ahead of time and keep them at the same local time across daylight saving changes.
- Texting rules: promotional texts only go to customers with a recorded opt-in and always end with "Reply STOP to opt out." Messages are de-duplicated with a unique reference, so running automations twice never sends twice.

## Matches Jobber's request-to-quote flow
Request (booking page: separate email and text consent, availability dates, arrival times, photos) -> Convert to Quote or Convert to Job -> quote with title, rating, salesperson, reminder date, optional add-ons the customer ticks, text sections, line photos and a fixed or percent deposit -> customer approves from a link -> Convert to Job -> visits -> invoice (only the lines the customer chose) -> payments.

## Not built yet
- Online card payments, including paying the quote deposit by card or bank (ACH) on the approval page, with payouts to the owner's bank (needs a Stripe Connect account). Today the owner marks a deposit or payment as received.
- Two-way texting (replies and STOP handling need a Twilio webhook).
- QuickBooks sync (CSV export of invoices and payments is available).
- Subscription billing for STAGR itself, and a password reset email.
