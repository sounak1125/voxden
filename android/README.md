# Voxden for Android

Native Kotlin / Jetpack Compose Android beta. This is a separate client of Voxden's account service; the Electron desktop application is unchanged. Android 8.0 or newer, targeting Android 16 (API 36).

Branding uses the desktop's unmodified `assets/logo-mark.png` inside the app and `assets/icon.png` for the launcher. Colors come from `src/theme.css`, including the desktop's charcoal/mint palette and separate readable accent and mint button-fill colors in the white theme.

## Test on this computer

After the first successful build, double-click **Run Voxden.cmd** in this directory. It installs the latest debug APK and opens Voxden in the existing Android emulator (or a single connected phone). The emulator stays open for interactive testing.

To build and run from PowerShell:

```powershell
.\android\run-android.ps1
# Reopen the already-built app:
.\android\run-android.ps1 -NoBuild
# Choose a device when multiple devices are connected:
.\android\run-android.ps1 -NoBuild -Device emulator-5554
```

Prerequisites: JDK 17+, Android SDK Platform 36 and Build Tools 36, platform-tools, and an Android emulator image. This workstation already has these tools and a `medium_phone` Android 16 Google Play AVD. On another machine, install them through Android Studio and set `ANDROID_HOME`. The Gradle wrapper downloads its pinned, checksum-verified distribution.

The debug APK is `app/build/outputs/apk/debug/app-debug.apk` (`com.voxden.android.debug`). It carries debug-only test switches: an adb-only broadcast receiver for the flow bar (`flowbar/FlowBarDebug.kt`, senders need the DUMP permission that only adb's shell holds) and `debug_cmd` intent extras on `MainActivity` (`ui/DebugHooks.kt`).

For testers, build `:app:assembleBeta`: release code with every debug hook off and full Compose speed, signed with this PC's debug key so it can be sideloaded (`app/build/outputs/apk/beta/app-beta.apk`, `com.voxden.android.beta`). It is not a Play artifact; production uses `com.voxden.android` with the real release key.

## Speech modes

- **Phone's speech engine** (`SpeechProvider.ANDROID`) is the default and the free mode. It uses the device's installed speech-recognition provider. That provider may send audio over the network; this mode is not advertised as private or offline. Emulator availability and language support depend on its system image/provider. Enable **Extended controls > Microphone > Virtual microphone uses host audio input** to speak through the computer's microphone. Windows must also allow desktop microphone access.
- **Voxden Cloud** uses the existing HTTPS account service: Pro accounts, or a free account's one-time trial (60 minutes by default, `CLOUD_TRIAL_CREDITS` on the service; the app reads `account.trial`). The account sheet starts it after the audio-upload disclosure. Until the service with the trial is deployed, a free account sees "Voxden Cloud is part of Pro" after signing in. When the minutes run out the app falls back to the phone's engine with a notice. The beta does not bypass limits or fabricate recognition results. Personal vocabulary is sent as transcription hints in cloud mode.
- **Upgrade to Pro** is on the account sheet (before and during the trial, and once the free minutes are used) and in Settings. The button works only once the price from `GET /billing/options` is on screen (with a retry if it could not be fetched). Continue, after a dialog that shows the price and says the payment is on a Razorpay page and renews monthly, asks `POST /billing/checkout` for the account service's hosted Razorpay page (UPI, cards and net banking in India; international cards elsewhere, an offer the service notes has not yet taken a real payment) and opens it in the browser. Only a plain `https` address is opened, and the app starts waiting only once the page really opened. It then checks the account every 10 seconds for up to 20 minutes until the service has seen the payment and the account is Pro; returning to the app also refreshes it, and the wait is saved so a restart (or a UPI app taking the phone away) carries on with it. Nothing is offered a second time while a payment may be on its way, and when the wait ends the sheet says not to pay again if the payment went through. That is the only protection against paying twice: the account service records nothing when a payment page is created, only when a payment is confirmed, so a second phone, or a tap after a late confirmation, is not stopped until the service reuses a pending page. The web checkout is compiled in for the debug and beta builds (`BuildConfig.WEB_CHECKOUT`) and off in the release build, and the button is also hidden on installs from the Play Store. Google Play Billing would replace the checkout call in `AppController.startUpgrade`, and the dialog and waiting text, which describe the web page, with it. There is no cancel or manage screen on Android yet: renewal is ended in Plans & billing in the desktop app.
- A mobile offline Voxden model is not bundled in this beta.

Cloud recordings stop at four minutes to keep base64 WAV uploads below the existing server's 12 MiB request limit. Android speech uses the installed service's utterance endpoint detection, with a 90-second safety limit. Neither provider continuously listens while the app is idle.

Cloud API keys stay on the server. Session tokens and local user data are stored using Android Keystore-backed encryption. App backup is disabled. Recordings are temporary, not an audio library.

## Flow bar and voice keyboard

The flow bar is an accessibility service (`services/VoxdenAccessibilityService.kt`, work in `flowbar/`). It draws the Island pill and capsule as `TYPE_ACCESSIBILITY_OVERLAY` windows, so it needs no "display over other apps" permission. The pill shows only while an editable, non-password field is focused with the keyboard up (or always, with Always show), never on the lock screen. Pull it inward 40 dp or tap it to dictate; drag it vertically to move it. The capsule is compact (about 105 x 36 dp while recording: cancel, meter, stop) and takes the pill's place on the same screen edge, opening inward from where the pill was pulled out, so it leaves the field being typed into and the keyboard uncovered. "Inserted" stays for 2 seconds (3 when Polish is offered). The text is typed at the cursor through the accessibility input connection (Android 13+), then `ACTION_SET_TEXT`, `ACTION_PASTE`, and finally the clipboard ("Copied"). Polish replaces the inserted text in place when it is still there.

Why an accessibility service: Android 14+ refuses a microphone foreground service to a background app, and a visible overlay does not count. An enabled accessibility service is bound as a foreground service and holds the microphone capability, so the flow bar records directly; `MicHandoffActivity` is the fallback for devices that refuse it. Measured on the Android 16 emulator: [docs/flow-bar-microphone-spike.md](docs/flow-bar-microphone-spike.md).

Field detection uses the windows API plus, on Android 13+, the editor the keyboard is connected to (`withEditor` in `FlowBarLogic.kt`): Compose fields in this app's own process can reach the tree as a plain view when Android started the process for the service, and some web and cross-platform toolkits do the same.

Sideloaded APKs: Android 13+ blocks switching on the accessibility service for apps installed from a file until the user opens App info, taps the menu, and chooses Allow restricted settings. The setup screens explain this.

Enable **Voxden voice** in Android's keyboard settings for the backup path. The microphone opens the recording screen; return to the same input field and use Insert. Password fields are excluded. Settings has a keyboard test field.

## Validation commands

v0.2.0, verified on the Android 16 `medium_phone` emulator on 4 October 2026: 130 unit tests, 25 instrumentation tests, lint with zero errors. Instrumentation covers onboarding, history, dictionary, the trial sheet, setup and disclosure, licences, encrypted storage, the voice keyboard, and the flow bar typing into a real `EditText` in another app over all four paths, Polish in place, visibility rules and microphone access from the service. Real speech, cloud sign-in, the trial and Polish against the live service, haptics and real phones are not verified. Running two emulators: `emulator -avd medium_phone -read-only -port 5556`; set `ANDROID_SERIAL` for connected tests.

```powershell
.\android\gradlew.bat -p android :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
.\android\gradlew.bat -p android :app:connectedDebugAndroidTest
```

## Before Google Play release

This is an installable development beta, not a published or approved Play release.

- Complete pending personal developer identity/device verification. For personal accounts subject to the new-account rule, complete at least 12 continuously opted-in closed testers for 14 days and apply for production access.
- Establish release signing / Play App Signing and increment version codes. Do not upload the debug APK as the release artifact.
- Complete the real-device test matrix: Pixel, Samsung, another manufacturer; microphone permission denial/revocation, incoming calls, Bluetooth, background/lock-screen transitions, process termination, keyboard focus changes, gesture navigation, and accessibility/font scaling.
- Submit the AccessibilityService declaration (prominent disclosure in-app, `isAccessibilityTool=false`) and the microphone foreground-service declaration. Play approval is not guaranteed by an APK build.
- Publish Android-specific privacy information, Data Safety disclosures, retention/deletion details, reviewer instructions, and a working external account-deletion page.
- Add and verify Google Play Billing before selling subscriptions in an app Google Play distributes. The beta sells Pro through the hosted web checkout described above, which is compiled off in the release build (`BuildConfig.WEB_CHECKOUT`), so the Play artifact offers no purchase until a Play Billing purchase replaces `AppController.startUpgrade`. Other copy that mentions Pro ("Part of Pro.", "Pro keeps dictation going.") also needs a decision for the Play build. The beta still does not implement Android Google sign-in.
- Add a way to see and cancel the Pro subscription inside the Android app (`GET /billing`, `POST /billing/cancel`), and have the account service reuse a pending checkout so a second tap cannot create a second subscription.
- Cover Android in the public Terms, Privacy and Refunds pages (they describe Windows and Mac), and name Razorpay in the Data Safety answers.
- Deploy the account service with the cloud trial (`scripts/test-cloud-trial.js`) before advertising the trial.
- Benchmark mobile on-device recognition separately before promising Voxden offline speech.

Reference: [Android input methods](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method), [foreground microphone restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [Play closed testing](https://support.google.com/googleplay/android-developer/answer/14151465).
