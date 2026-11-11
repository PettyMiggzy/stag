# Store listing (draft for Apple App Store and Google Play)

Everything here is true of the app as it is today. Do not add claims the app cannot back up: reviewers check.

## Shared facts

- **App name:** STAGR
- **Publisher:** Junk Junkies
- **Bundle ID / package name:** `com.stagr.app`
- **Category:** Business
- **Price:** Free
- **Support URL:** https://stagr.junkjunkiesindiana.com/support.html
- **Privacy policy URL:** https://stagr.junkjunkiesindiana.com/privacy.html
- **Account deletion URL (Google Play asks for it):** https://stagr.junkjunkiesindiana.com/delete-account.html
- **Marketing URL (optional):** https://stagr.junkjunkiesindiana.com
- **Support email:** info@junkjunkiesindiana.com
- **Age rating:** Apple 4+; Google "Everyone" (answer "no" to every content question; the app has no user-to-user public content)
- **Ads:** No. **In-app purchases:** No.

## Apple App Store

**Name (30 chars max):** STAGR: Field Service CRM
**Subtitle (30 chars max):** Quotes, jobs, invoices, texts
**Promotional text (170 chars max):** Run your service business from your phone: customers, requests, quotes, jobs, invoices and card payments through Square.
**Keywords (100 chars max, comma separated, no spaces):**
`field service,crm,quotes,invoices,scheduling,jobs,estimate,contractor,junk removal,cleaning`

**Description**

STAGR is the field service app for small crews: junk removal, cleaning, lawn care, handyman, pressure washing and more. Everything you need to run the day, in one place on your phone.

- Customers and properties, with every job and message in one history
- Requests from your online booking page land in your inbox, photos included
- Build and send quotes. Customers approve with one tap from a link, no app needed
- Schedule jobs and visits, assign your crew, and use checklists and photos on site
- Invoice from the job and record payments
- Take card payments through Square: connect your own Square account and customers pay from the invoice or deposit link
- Text and email customers: appointment reminders, quote follow-ups and review requests (texting and email need setup first)
- Reports on money collected, what is overdue and which customers come back
- Team logins for owners, admins and workers. Workers get a simple view with only their own work
- Time clock and job expenses
- Forgot your password? Reset it by email from the sign-in screen

Your data belongs to your business. No ads and no tracking. Delete your account any time inside the app (More > My account > Delete my account).

Card payments are processed by Square under your own Square account. STAGR never sees card numbers.

## Google Play

**App name (30 chars max):** STAGR: Field Service CRM
**Short description (80 chars max):** Customers, quotes, jobs, invoices and card payments for small service crews.
**Full description:** use the Apple description above, unchanged.
**Tags:** Business, Productivity
**Contact email:** info@junkjunkiesindiana.com
**Website:** https://stagr.junkjunkiesindiana.com

Play Console also asks:
- **App access:** "All or some functionality is restricted" and give the demo login from `review-notes.md`.
- **Ads:** No.
- **Data safety:** see `data-safety.md`.
- **Account deletion:** in the Data safety form, paste the account deletion URL above.
- **Target audience:** 18 and over. Not designed for children.
- **Government / financial / health app:** No to all.

## ENABLE AFTER FIREBASE IS SET UP (do not publish this yet)

Push notifications are switched OFF in the current build (`PUSH_ENABLED = false` in `public/js/native.js`). Do not mention
notifications anywhere in the listing, screenshots or review notes until Firebase is set up and a build with push turned
on has been tested on a real phone. When that is done, add this line to both descriptions:

> - Notifications for new requests and payments

and update the Data safety and App Privacy answers as described in `data-safety.md`.

## Screenshots

Sign in to the demo business so no real customer data is shown. Take: Home, Schedule, a customer, a quote, an invoice
with the payment section, Messages, and the worker view.

- **iPhone:** 6.7" (1290 x 2796) and 6.5" (1242 x 2688 or 1284 x 2778). At least 3 each.
- **iPad:** 13" (2064 x 2752 or 2048 x 2732), needed because the Xcode project currently targets iPad too. See `IOS_SUBMISSION_CHECKLIST.md` for how to make the app iPhone-only instead.
- **Android phone:** at least 2, 16:9 or 9:16, each side between 320 and 3840 px. Plus the 512 x 512 icon and a 1024 x 500 feature graphic.

Do not show a notification, a card-number form, or anything the app does not do.
