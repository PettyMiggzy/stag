# Notes for the review teams (paste into App Store Connect "App Review Information" and Play Console "App access")

Fill in the two placeholders first. Create a demo business in the app (sign up with a mailbox you control), add a few
sample customers, a quote, a job and an invoice, and add one worker login. Never use the real Junk Junkies business.

- `DEMO_EMAIL` = (owner login of the demo business)
- `DEMO_PASSWORD` = (its password)
- Optional worker login, to show the worker-only view: `DEMO_WORKER_EMAIL` / `DEMO_WORKER_PASSWORD`

Do not delete the demo business while a review is open. Reviewers may test "Delete my account": ask them (below) to use
the worker login for that, and re-create the worker afterwards.

---

## Text to paste

STAGR is a business tool for small field-service companies (junk removal, cleaning, lawn care and similar). The business
uses it to manage its customers, requests, quotes, jobs, invoices, customer messages and team logins. An account is
required; sign-up is free and is done in the app.

Demo account (a sample business with sample data):
- Email: DEMO_EMAIL
- Password: DEMO_PASSWORD

Worker account (limited view, same business):
- Email: DEMO_WORKER_EMAIL
- Password: DEMO_WORKER_PASSWORD

Things to try:
1. Sign in with the demo account. Home shows today's work and money owed.
2. Customers: open a customer to see their properties, jobs, quotes, invoices and message history. Add a new customer.
3. Create a quote for a customer and send it. The customer gets a link and approves with one tap in their browser (no app or account needed).
4. Schedule: open a job visit, tick the checklist and add a photo from the camera or library.
5. Invoices: open an invoice and record a payment (cash or check).
6. More > Settings: business profile, services, team members and the Square connection.
7. Sign out and sign in with the worker account to see the simpler worker-only view.
8. Sign-in screen: "Forgot your password?" sends a reset link by email.
9. Account deletion: More (or the Me tab) > My account > Delete my account, then enter the password and type DELETE.
   Please use the worker account for this. Deleting the owner account deletes the whole demo business.

Payments: STAGR has no in-app purchases and sells no digital goods. Invoices are for real-world services (for example a
junk removal job) performed by the business for its own customers. If the business connects its own Square account,
its customers can pay an invoice by card on Square's hosted checkout page. Cash and check payments are recorded by hand.
The demo business may not have Square connected; in that case no card button is shown.

Messages: the business's customers receive texts only if they agreed to them, and can reply STOP. In the demo business,
texts and emails may be saved as previews instead of being sent.

Permissions: camera and photo library are requested only when the user chooses to add a photo.
The app does not track users and has no ads.

Account deletion on the web: https://stagr.junkjunkiesindiana.com/delete-account.html
Privacy policy: https://stagr.junkjunkiesindiana.com/privacy.html
Support: https://stagr.junkjunkiesindiana.com/support.html
Contact: info@junkjunkiesindiana.com

---

## ENABLE AFTER FIREBASE IS SET UP (do not paste this yet)

Push notifications are switched off in the current build. Once they are on and tested, add this line to the text above:

> Notifications are used to tell owners and admins about new customer requests and payments.

## Before you paste: check

- The demo logins work on the live site, signed out first.
- Email sending is set up on the server, or step 8 will show "Email is not set up". If it is not set up, remove step 8.
- The demo business has at least one customer, quote, scheduled visit and invoice.
