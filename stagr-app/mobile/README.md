# STAGR mobile app (iPhone and Android)

The app is a native shell (Capacitor) around the live STAGR web app at `https://stagr.junkjunkiesindiana.com/app`.
Everything you build in the web app shows up in the phone app the moment it is deployed, with no store review for
normal changes. The shell adds the phone parts: haptics, the Android back button, a native launch screen and icon,
an offline screen, and push notifications (built but switched off until Firebase is set up, see below).

What is already done:

- Android project (`android/`) and iPhone project (`ios/`), icons and launch screens generated from the StagR logo.
- In-app **Delete my account** (More or the Me tab > My account; also at the bottom of Settings). Apple and Google
  both require it. The public deletion page Google asks for is `/delete-account.html`.
- Push notification plumbing: the code to ask for permission, register the phone (`/api/devices`) and send through
  Firebase is written, but it is switched off (`PUSH_ENABLED = false` in `public/js/native.js`).
- Offline screen, offline banner, safe-area fixes for notches and home bars, and a service worker so the app opens fast.
- The CRM's test suite (`npm test` in the folder above) covers sign-in, tenant isolation, account deletion and devices.

## Before you build: decide these three things

1. **App ID** (`appId` in `capacitor.config.json`). It is `com.stagr.app` now. It must match what you create in App Store
   Connect and Google Play, and it cannot be changed after the first upload. Change it now if you want a different one.
2. **Web address.** `server.url` points at `stagr.junkjunkiesindiana.com`. If the domain ever changes, change it here
   (and in `allowNavigation`), then run `npx cap sync`.
3. **Support email and public pages.** Both stores require them. The support email is info@junkjunkiesindiana.com and
   the pages are live with the web app: `https://stagr.junkjunkiesindiana.com/privacy.html`, `/support.html` and
   `/delete-account.html`. The store answers are in `store/`.

## Build

    cd mobile
    npm install
    npx cap sync              # copies config and plugins into android/ and ios/

### Android (Google Play)

You need Java 17+ and Android Studio (or the command line SDK). From this folder:

    cd android
    ./gradlew assembleDebug                   # test APK: app/build/outputs/apk/debug/app-debug.apk
    # release: make an upload key ONCE and keep it safe (lose it and you lose the ability to update the app)
    keytool -genkey -v -keystore stagr-upload.jks -alias stagr -keyalg RSA -keysize 2048 -validity 10000
    # then add the key to android/app/build.gradle (signingConfigs) and run:
    ./gradlew bundleRelease                   # app/build/outputs/bundle/release/app-release.aab  <- upload this

In Play Console: create the app, turn on **Play App Signing**, upload the `.aab` to an Internal testing track first, fill
in the Data safety form (see `store/data-safety.md`), the content rating questionnaire, the privacy policy address, and
the store listing (`store/listing.md`). New personal developer accounts must run a closed test with 12 testers for
14 days before production; accounts registered as an organization are exempt.

### iPhone (App Store)

iPhone apps can only be built on a Mac (or a cloud Mac service such as Codemagic or Xcode Cloud).

    npx cap sync ios
    npx cap open ios          # opens Xcode

In Xcode: select the **App** target, set your **Team** and the bundle identifier (add the **Push Notifications**
capability only when push is being turned on), then **Product > Archive > Distribute App > App Store Connect**. In App
Store Connect create the app with the same bundle ID, add screenshots, fill in the App Privacy answers
(`store/data-safety.md`), and add review notes with a demo login (`store/review-notes.md`). Send it to TestFlight first.
The full step-by-step is in `store/IOS_SUBMISSION_CHECKLIST.md`.

## Push notifications (not switched on yet)

The registration code and the server-side sender (`lib/push.js`) are written but off. Calling the push plugin without
Firebase crashes the Android app on launch, so do every step below before setting `PUSH_ENABLED = true` in
`public/js/native.js`:

1. A **Firebase** project (free). Add an Android app and an iOS app with the same App ID. Download `google-services.json`
   into `android/app/` and `GoogleService-Info.plist` into `ios/App/App/` (both are git-ignored).
2. In the Apple Developer account, create an **APNs key** and upload it to Firebase (Project settings > Cloud Messaging).
3. A Firebase service account key set on the server as the `FCM_SERVICE_ACCOUNT` environment variable. Without it the
   server sends nothing.
4. In Xcode add the **Push Notifications** capability; rebuild both apps, test on real phones, then update the store
   listing and privacy answers (see the "enable after Firebase" notes in `store/`).

## Apple review: one risk to know about

Apple rejects apps that are only a website in a frame (guideline 4.2). This one is a real native shell with haptics,
camera and photo access, back button handling and an offline screen, and the web app behaves like an app (tab bar, no
browser chrome). That usually passes, but if review pushes back the fix is to bundle the web files inside the app
(offline-first). That needs the API to accept cross-origin sign-in from the app, which is a few hours of work, not a rewrite.
