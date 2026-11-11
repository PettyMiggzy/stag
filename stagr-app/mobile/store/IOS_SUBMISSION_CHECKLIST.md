# STAGR iPhone app: App Store submission checklist

For the owner, on a Mac, no coding needed. Work top to bottom and tick each box. Anything marked **check this** could
not be confirmed from the project files and needs a look on your side.

Facts about the project (from the files in `mobile/`):

| Item | Value |
|---|---|
| App name | STAGR |
| Bundle ID | `com.stagr.app` |
| Version / build | 1.0 / 1 |
| Minimum iOS | 14.0 |
| Devices | iPhone and iPad (see step 5) |
| Built with | Capacitor 7 (a native shell that loads `https://stagr.junkjunkiesindiana.com/app`) |
| Signing | Automatic, no team chosen yet |
| Export compliance | `ITSAppUsesNonExemptEncryption` is already `false` in `Info.plist` |
| Push notifications | Code present but switched OFF. No Push capability added to the Xcode project yet |

---

## 1. Accounts and tools

- [ ] Join the **Apple Developer Program** at developer.apple.com/programs ($99 per year). Enrolling as an
      **organization** (Junk Junkies) shows the business name as the seller and needs a D-U-N-S number; enrolling as an
      individual shows your personal name. Approval can take from a day to a couple of weeks.
- [ ] Install **Xcode** from the Mac App Store (large download). Open it once and let it install its extra components.
      Check this: Apple requires a recent Xcode for uploads; use the newest one your Mac can run.
- [ ] In Xcode: **Settings > Accounts > +** and sign in with the Apple ID that owns the developer account.
- [ ] Install **Node.js** (LTS version from nodejs.org) and **CocoaPods** (in Terminal: `sudo gem install cocoapods`,
      or `brew install cocoapods` if you use Homebrew).

## 2. Get the project ready

In Terminal, from the `stagr-app/mobile` folder:

    npm install
    npx cap sync ios
    npx cap open ios

- [ ] The last command opens Xcode. Make sure it opened **App.xcworkspace** (not `App.xcodeproj`).
- [ ] If `cap sync` reports a CocoaPods error, run `cd ios/App && pod install`, then try again.

## 3. Before building: confirm the live site is ready

The app is a shell around the live website, so these must work in Safari on a phone first:

- [ ] https://stagr.junkjunkiesindiana.com/app loads and you can sign in.
- [ ] https://stagr.junkjunkiesindiana.com/privacy.html
- [ ] https://stagr.junkjunkiesindiana.com/support.html
- [ ] https://stagr.junkjunkiesindiana.com/delete-account.html
- [ ] The demo business exists and its logins work (see `review-notes.md`).

## 4. Bundle ID and signing

- [ ] In Xcode's left panel click the blue **App** project, then the **App** target, then the **Signing & Capabilities** tab.
- [ ] **Bundle Identifier** reads `com.stagr.app`. It cannot be changed after the first upload. If Xcode says the ID is
      not available, someone else has registered it: pick another (for example `com.junkjunkies.stagr`), and tell your
      developer, because it must also be changed in `capacitor.config.json` and should match Android.
- [ ] Tick **Automatically manage signing** and choose your **Team**. Xcode creates the certificate and profile for you.
- [ ] No red errors remain on this tab.

## 5. iPhone only, or iPhone and iPad?

The project currently targets **both** iPhone and iPad. That means Apple will require iPad screenshots and will test the
app on an iPad. Choose one:

- **Keep iPad (more work):** run the app in an iPad simulator and check every main screen looks right in portrait and
  landscape. Take iPad screenshots (step 9).
- **Make it iPhone-only (simpler, recommended for a first release):** App target > **General** tab > **Supported
  Destinations** > select **iPad** and click **-** to remove it. Remove **Mac (Designed for iPad)** and **Apple Vision**
  too if they are listed. Do this **before the first upload**: Apple does not let you drop iPad support after a version
  with it has been released. The app can still be installed on an iPad in iPhone-size mode, and reviewers may try that.

- [ ] Decision made and applied.

## 6. Push notifications (skip this whole step unless push is being turned on)

Push is off in the current build and the listing does not mention it. **Leave it off for the first submission.** Do not
add the Push Notifications capability "just in case": an app that has the capability but never uses it can draw questions.

If and when you turn push on, a developer is needed for the code parts:

- [ ] Create a Firebase project and add an iOS app with bundle ID `com.stagr.app`. Download `GoogleService-Info.plist`
      and add it to the App target in Xcode.
- [ ] developer.apple.com > Certificates, Identifiers & Profiles > **Keys** > **+** > tick **Apple Push Notifications
      service (APNs)** > download the `.p8` file (you can only download it once). Note the Key ID and your Team ID.
- [ ] Firebase console > Project settings > **Cloud Messaging** > Apple app configuration > upload the `.p8` with the
      Key ID and Team ID.
- [ ] Xcode > Signing & Capabilities > **+ Capability** > **Push Notifications**.
- [ ] Developer tasks. Check this: `AppDelegate.swift` does not yet contain the push registration hooks the Capacitor
      plugin needs, and the server sends through Firebase, which needs a Firebase token on iPhone (the Firebase
      Messaging SDK), not a raw Apple token. Then set `PUSH_ENABLED = true` in `public/js/native.js` and the
      `FCM_SERVICE_ACCOUNT` variable on the server.
- [ ] Test on a real iPhone (push does not work reliably in the simulator), then update the listing, review notes and
      App Privacy answers using the "enable after Firebase" notes in this folder.

## 7. Test on a real iPhone

- [ ] Plug in an iPhone, choose it at the top of Xcode and press the Play button.
- [ ] Sign up, sign in, sign out, **Forgot your password?**.
- [ ] Add a customer, a quote, a job, an invoice; record a payment.
- [ ] Add a photo from the camera and from the library (the permission pop-ups should appear with a clear reason).
- [ ] Turn on Airplane Mode and reopen the app: the offline screen appears instead of a blank page.
- [ ] **Delete my account** works (More or the Me tab > My account). Use a throwaway account.
- [ ] Nothing is hidden under the notch or home bar; no web-browser bars are visible.
- [ ] Check this: tap a link that leaves STAGR (for example Directions, or the Square connect button in Settings). It
      should open in Safari and you should be able to get back to the app.

## 8. Create the app in App Store Connect

At appstoreconnect.apple.com > **My Apps** > **+** > **New App**:

- [ ] Platform iOS, name `STAGR: Field Service CRM` (if taken, try `STAGR Field Service`), language English (U.S.),
      bundle ID `com.stagr.app`, SKU `stagr-ios-1`, full access.
- [ ] **App Information:** category Business; content rights: does not contain third-party content.
- [ ] **Pricing and Availability:** Free; choose countries (United States at minimum).
- [ ] **Age rating:** answer None / No to everything. Result should be 4+.
- [ ] Copy the name, subtitle, description, keywords, promotional text and URLs from `listing.md`.
- [ ] Support URL: https://stagr.junkjunkiesindiana.com/support.html
- [ ] Privacy Policy URL: https://stagr.junkjunkiesindiana.com/privacy.html

## 9. Screenshots

Use the demo business so no real customer data appears. In Xcode's simulator, press Cmd+S to save a screenshot.

- [ ] **iPhone 6.7"** (1290 x 2796): simulator "iPhone 15 Pro Max" or "iPhone 16 Plus". 3 to 10 images.
- [ ] **iPhone 6.5"** (1242 x 2688 or 1284 x 2778): simulator "iPhone 11 Pro Max" or "iPhone 14 Plus". 3 to 10 images.
- [ ] **iPad 13"** (2064 x 2752 or 2048 x 2732): simulator "iPad Pro 13-inch". Only if you kept iPad in step 5.
- [ ] Suggested set: Home, Schedule, a customer, a quote, an invoice with payments, Messages, the worker view.
- [ ] No notification banners, no card-number forms, no features the app does not have.

Check this: Apple changes the required sizes from time to time (its newest slot is 6.9", which accepts 1290 x 2796
images). App Store Connect shows exactly which slots are required when you upload; follow what it shows.

## 10. App Privacy

App Store Connect > **App Privacy** > Get Started. Copy the answers from the Apple table in `data-safety.md`.

- [ ] "Do you collect data?" Yes.
- [ ] Types: Name, Email Address, Phone Number, Physical Address, Other Financial Info, Purchase History, Photos or
      Videos, Emails or Text Messages, Other User Content, User ID.
- [ ] For each: purpose **App Functionality**, **linked to the user**, **not used for tracking**.
- [ ] Not collected: Payment Info, Location, Contacts, Identifiers > Device ID (until push is on), Usage Data, Diagnostics.
- [ ] Publish the privacy answers.

## 11. Upload the build

- [ ] In Xcode, at the top choose **Any iOS Device (arm64)** as the destination.
- [ ] **Product > Archive**. When the Organizer window opens: **Distribute App > App Store Connect > Upload**, keep the defaults.
- [ ] **Export compliance:** you should not be asked, because `ITSAppUsesNonExemptEncryption` is already `false`
      (the app uses only standard HTTPS). If asked anyway, answer that the app uses no non-exempt encryption.
- [ ] Wait for the "build has completed processing" email (10 to 60 minutes).
- [ ] For every later upload, raise the **Build** number (1, 2, 3...) on the General tab. Raise **Version** (1.0, 1.1...) only for a new release.

## 12. TestFlight first

- [ ] App Store Connect > **TestFlight** > add yourself as an internal tester, install the TestFlight app on your
      iPhone, and repeat the tests in step 7 on the uploaded build.

## 13. Submit for review

- [ ] On the version page, choose the build you uploaded.
- [ ] **App Review Information:** tick "Sign-in required" and enter the demo email and password. Paste the text from
      `review-notes.md` into Notes, with `DEMO_EMAIL` and `DEMO_PASSWORD` replaced by the real demo logins.
- [ ] Contact: your name, phone and info@junkjunkiesindiana.com.
- [ ] Release: "Manually release this version" is the safer choice.
- [ ] **Add for Review > Submit**. Reviews usually take 1 to 3 days. Do not delete or change the demo business meanwhile.

---

## Common rejection reasons for this kind of app, and STAGR's answer

STAGR is a web app inside a native shell. Apple looks hard at these.

**Guideline 4.2 (Minimum Functionality): "this is just a website".** The most likely pushback. What STAGR has:

- A full app layout: bottom tab bar, no browser address bar or web navigation, safe-area handling for the notch.
- Native pieces: launch screen and icon, haptic feedback on buttons, camera and photo-library access for job photos,
  and a built-in offline screen instead of a browser error.
- Real, account-based business functions (customers, scheduling, quotes, invoices, team roles) that are not a
  marketing site or a catalogue.
- It is not locked to one company: any service business can sign up.

If rejected under 4.2, reply politely in the Resolution Center listing the points above and offer a short screen
recording. Turning on push notifications (step 6) is the single strongest addition. The fallback, described in
`mobile/README.md`, is to bundle the web files inside the app; that needs a developer.

**Guideline 2.1 (App Completeness): reviewer could not sign in, or something was broken.** Demo logins must work and the
site must be up for the whole review. Remove any screen that says "coming soon". Check this: if email sending is not set
up on the server, "Forgot your password?" shows an "email is not set up" message, which looks unfinished. Set up email first.

**Guideline 5.1.1(v): account deletion.** Covered: More (or the Me tab) > My account > Delete my account, plus the web
page. It is described in the review notes.

**Guideline 5.1.1 / 5.1.2 (Privacy): labels do not match behaviour.** The App Privacy answers must match
`privacy.html`. Check this: `Info.plist` has a location permission message, but the app never asks for location. That
is harmless as long as no location prompt ever appears; if a reviewer asks, the answer is that location is not used.
A developer can remove the line to avoid the question.

**Guideline 3.1.1 (In-App Purchase).** Not applicable, and the review notes say why: the app is free, sells nothing
digital, and card payments are a business's customers paying for real-world services through Square. Do not add any
text that offers to sell STAGR plans or upgrades inside the app unless it uses Apple's In-App Purchase.

**Guideline 2.3 (Accurate Metadata).** Screenshots and description must show only what the build does. No mention of
notifications until push is live. No Android or Google Play wording, and no other platforms' names, in the iPhone listing.

**Guideline 4.8 (Sign in with Apple).** Not required: STAGR uses only its own email and password sign-in, no
Google or Facebook sign-in.

**Guideline 2.5.4 / unused capabilities.** Do not add Push Notifications or background modes until they are used.

**iPad problems (2.4.1).** If iPad is kept, the app must look right on iPad. If you chose iPhone-only, it is still
tested in iPhone-size mode on an iPad, so check it once there.

## If you get rejected

It is common on a first submission and not a penalty. Read the message, fix or explain, and reply in the Resolution
Center. Keep replies short and factual, and never argue about features that are not in the build.
