# Privacy answers: Google Play "Data safety" and Apple "App Privacy"

These match the public policy at https://stagr.junkjunkiesindiana.com/privacy.html. If the app changes, change all three together.

Facts behind the answers (checked against the code):
- No ads, no analytics SDKs, no crash-reporting SDKs, no advertising ID.
- The app does not read location, contacts, calendar, health data or browsing history.
- Card payments happen on Square's hosted checkout under the business's own Square account. STAGR stores amount, method and date only, never card numbers.
- Service providers: Neon (database), Vercel (hosting), Twilio (texts, when set up), Resend (email, when set up), Square (card checkout, when the business connects it), Firebase Cloud Messaging (push, only when enabled).
- Push notifications are OFF in the current build, so no device token is collected today.

---

## Google Play: Data safety form

**Does your app collect or share any of the required user data types?** Yes
**Is all of the user data collected by your app encrypted in transit?** Yes
**Do you provide a way for users to request that their data is deleted?** Yes
- Account deletion URL: https://stagr.junkjunkiesindiana.com/delete-account.html
- Account creation method: Username and password

**Is data "shared"?** No for every type. Sending data to service providers that process it for us (Neon, Vercel, Twilio, Resend, Square, Firebase) does not count as sharing under Google's definition.

For every type below: **Collected: Yes. Shared: No. Processed ephemerally: No. Required (users cannot turn it off), except where noted. Purpose: App functionality** (add **Account management** for name and email, and **Fraud prevention, security and compliance** for email).

| Category | Data type | Collected? | What it is in STAGR |
|---|---|---|---|
| Personal info | Name | Yes | Account name; names of the business's customers |
| Personal info | Email address | Yes | Sign-in email; customer emails |
| Personal info | Phone number | Yes | Account phone; customer phones |
| Personal info | Address | Yes | Customers' service addresses; business city and state |
| Personal info | Other info | Yes | Notes the business keeps about its customers |
| Personal info | User IDs, race, political or religious beliefs, sexual orientation | No | |
| Financial info | Purchase history | Yes | Invoices and payment records (amount, method, date) |
| Financial info | Other financial info | Yes | Quotes, expenses, deposits |
| Financial info | User payment info (card or bank numbers) | **No** | Card entry happens on Square's page, outside the app |
| Financial info | Credit score | No | |
| Messages | Other in-app messages | Yes | Texts and emails the business sends to its customers through STAGR |
| Messages | Emails, SMS or MMS (reading the phone's own messages) | No | The app never reads the phone's inbox |
| Photos and videos | Photos | Yes (optional) | Photos the user chooses to attach to requests, quotes and jobs |
| Photos and videos | Videos | No | |
| App activity | (all types) | **No** | No analytics or interaction tracking |
| App info and performance | (crash logs, diagnostics) | No | No crash or diagnostics SDK |
| Device or other IDs | Device or other IDs | **No today. Yes once push is enabled** | Firebase push token, to deliver notifications. Optional (only if the user allows notifications) |
| Location, Health and fitness, Contacts, Calendar, Audio, Files and docs, Web browsing | (all types) | No | |

**When push is turned on:** edit the form, set Device or other IDs to Collected, Not shared, Optional, purpose App functionality, and submit it with the build that enables push.

---

## Apple: App Privacy ("nutrition label")

**Do you or your third-party partners collect data from this app?** Yes

For every type below: **Linked to the user: Yes. Used for tracking: No. Purpose: App Functionality only.**

| Apple category | Data type | Collected? | Notes |
|---|---|---|---|
| Contact Info | Name | Yes | |
| Contact Info | Email Address | Yes | |
| Contact Info | Phone Number | Yes | |
| Contact Info | Physical Address | Yes | Customers' service addresses |
| Contact Info | Other User Contact Info | No | |
| Financial Info | Other Financial Info | Yes | Quotes, invoices, payment records, expenses |
| Financial Info | Payment Info | **No** | Card details are entered on Square's page, not in the app |
| Financial Info | Credit Info | No | |
| Purchases | Purchase History | Yes | Invoice and payment records the business keeps |
| User Content | Photos or Videos | Yes | Photos attached to requests, quotes and jobs |
| User Content | Emails or Text Messages | Yes | Messages the business sends to its customers through STAGR |
| User Content | Other User Content | Yes | Notes, checklists, time-clock entries |
| User Content | Customer Support, Audio Data, Gameplay Content | No | |
| Identifiers | User ID | Yes | The account (sign-in email / account ID) |
| Identifiers | Device ID | **No today. Yes once push is enabled** | Push notification token |
| Location, Health & Fitness, Contacts, Browsing History, Search History, Sensitive Info, Usage Data, Diagnostics, Surroundings, Body, Other Data | (all) | No | |

**Tracking:** No. The app does not track users and does not need the App Tracking Transparency prompt.
**Privacy policy URL:** https://stagr.junkjunkiesindiana.com/privacy.html

Check this: `Info.plist` contains a location permission message ("show directions to your next job"), but the app code
never asks for location (directions open a Google Maps link). So "Location: No" is correct today. If location is ever
used, update these answers. Consider removing the unused message from `Info.plist` so a reviewer does not ask about it.
