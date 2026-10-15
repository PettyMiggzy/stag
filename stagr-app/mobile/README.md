# STAGR mobile app (iPhone and Android)

The app is a native shell (Capacitor) around the live STAGR web app at `https://stagr-app-ten.vercel.app/app`.
Everything you build in the web app shows up in the phone app the moment it is deployed, with no store review for
normal changes. The shell adds the phone parts: push notifications, haptics, the Android back button, a native
launch screen and icon, and an offline screen.

What is already done:

- Android project (`android/`) and iPhone project (`ios/`), icons and launch screens generated from the StagR logo.
- In-app **Delete my account** (Settings, bottom of the page). Apple and Google both require it.
- Push notification plumbing: the app asks for permission, and registers the phone with the server (`/api/devices`).
- Offline screen, offline banner, safe-area fixes for notches and home bars, and a service worker so the app opens fast.
- The CRM's test suite (`npm test` in the folder above) covers sign-in, tenant isolation, account deletion and devices.

## Before you build: decide these three things

1. **App ID** (`appId` in `capacitor.config.json`). It is `com.stagr.app` now. It must match what you create in App Store
   Connect and Google Play, and it cannot be changed after the first upload. Change it now if you want a different one.
2. **Web address.** `server.url` points at `stagr-app-ten.vercel.app`. When you get your own domain, change it here
   (and in `allowNavigation`), then run `npx cap sync`.
3. **Support email and privacy policy address.** Both stores require them. Drafts of the privacy policy and terms are in
   `store/`. Put them on a public page you control and fill in the support email.

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

In Xcode: select the **App** target, set your **Team** and the bundle identifier, add the **Push Notifications** capability,
then **Product > Archive > Distribute App > App Store Connect**. In App Store Connect create the app with the same bundle
ID, add screenshots (6.9-inch and 6.5-inch iPhone are required), fill in the App Privacy answers
(`store/data-safety.md`), and add review notes with a demo login (`store/review-notes.md`). Send it to TestFlight first.

## Push notifications (not switched on yet)

The app already registers each phone's token with the server. To actually send notifications you need:

1. A **Firebase** project (free). Add an Android app and an iOS app with the same App ID. Download `google-services.json`
   into `android/app/` and `GoogleService-Info.plist` into `ios/App/App/` (both are git-ignored).
2. In the Apple Developer account, create an **APNs key** and upload it to Firebase (Project settings > Cloud Messaging).
3. A Firebase service account key set as an environment variable on the server, and a small sender that calls the FCM API
   for the rows in the `devices` table (for example: new request, quote approved, invoice paid, tomorrow's visits).
   I have not written the sender yet because it needs those keys; the table and registration are ready.

## Apple review: one risk to know about

Apple rejects apps that are only a website in a frame (guideline 4.2). This one is a real native shell with push
notifications, haptics, back button handling and an offline screen, and the web app behaves like an app (tab bar, no
browser chrome). That usually passes, but if review pushes back the fix is to bundle the web files inside the app
(offline-first). That needs the API to accept cross-origin sign-in from the app, which is a few hours of work, not a rewrite.
