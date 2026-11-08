# Store readiness

What the two stores require, what this repo already satisfies, and what is still missing. The
missing column is the honest one: most of it needs credentials or a Mac, neither of which exists
yet.

## Apple App Store

| Guideline | What it demands | Where we stand |
|---|---|---|
| **4.2 Minimum Functionality** | Not a repackaged website | **The main risk, and the case is now made out of things that exist.** What a reviewer can see without being told where to look, in this order: (1) the **tab bar is native** — a scroll view of native buttons the shell draws, with the system's own scrolling, hit testing and badges, not a web control (`D3`); (2) the **camera / photo-library sheet** is two taps from a cold launch, on the sign-up screen (`D24`); (3) **share sheet**, **haptics**, outbound links in Safari View Controller / a Custom Tab, the session in the **Keychain / Keystore**, and an **offline shell** that opens with no network. `docs/mobile/review-notes.md` is the reviewer-facing version of that list, with the taps. What is NOT in it: biometric unlock (never built), universal links / App Links (they cannot work until `D18`/`D19` are real), and push (the code is there and tested against a fake, but no build can receive a notification until an APNs key and an FCM project exist — see below) |
| **1.2 User-Generated Content** | A filter for objectionable content, a way to report, a way to block, and a published way to contact | **Three of the four exist, and the filter and the contact are the gaps.** Report, block and the house rules exist server-side (`POST /api/reports`, `POST /api/blocks/:name`, `public/js/pages/rules.js`). There is **no automatic filter for objectionable content**: `src/ai/` detects AI-written text, is off by default (`AI_DETECTOR=off`), and judges nothing else; what exists is human moderation (`src/trust/moderation.js`, the Photos queue, held sign-ups). There is **no public contact address** on the rules page or anywhere else yet (`<support-email>` in [listing.md](listing.md)). Apple 1.2 asks for both, so say plainly in review that moderation is by people, and add the address before submitting. The mechanisms that exist **are reachable in the app**, checked by following the imports rather than by memory: `widgets/safety.js` gives `postActions` (the report / delete menu) to `widgets/postcard.js`, `widgets/comments.js` and `widgets/blogindex.js`, so every status, comment, blog entry and board thread carries it wherever it is shown, feed included; `reportDialog` and `blockUser` are also on profiles (`pages/profile.js`), in a conversation (`pages/chat.js`) and in #ourspace (`pages/ourspace.js`). The house rules are in the footer of every page (`public/index.html:30`). Checklist item 13 was run on the Android emulator on 2026-11-05 (`shells.md`); iOS is unchecked |
| **5.1.1(v) Account Deletion** | Deletion from inside the app | `DELETE /api/me` exists and Settings has a "delete my account" panel (`public/js/pages/settings.js:128`). Checklist item 12 holds it to ≤3 taps. **Checked on the Android emulator:** Settings is one tap from the feed (the header's Settings button, `public/js/core/chrome.js:44`) and it shows "Delete my account". The panel is at the bottom of the page, so it is a scroll, not a tap; after it come the typed password, the button, and the confirm dialog's "Delete everything". **iOS is unchecked.** It has never launched anywhere |
| **1.4 / 2.3.8 Age rating** | A rating that matches the content | `MIN_AGE` is a Worker environment variable that **defaults** to 13 (`src/accounts/auth.js:101`), so the deployment decides it and the rating has to match whatever it is set to. Apple replaced its 12+ and 17+ ratings with **13+, 16+ and 18+** (4+ and 9+ stay) and added required questionnaire questions ([Apple's developer notice](https://developer.apple.com/news/?id=ks775ehf), dated 24 July 2025; its deadline to answer for existing apps was 31 January 2026). A social app with user content and no automatic filter will not rate low. What each `MIN_AGE` gives is worked through in [listing.md](listing.md). Needs a decision, and the age the app is listed at must not be below `MIN_AGE` |
| **5.1.1 Privacy** | A privacy policy URL and an accurate privacy manifest | The rules page covers policy. The iOS privacy manifest is written (`mobile/ios/App/App/PrivacyInfo.xcprivacy`, below); the App Store privacy questionnaire is **not filled in**, but its answers are the manifest's list |
| **3.1.1 In-App Purchase** | No outside payment | Nothing is sold. Clean |
| **4.8 Login Services** | A privacy-preserving login option alongside third-party ones | Email + password exists alongside Google and Discord. Likely clean; Sign in with Apple may still be requested |
| **2.1 App Completeness** | A working demo account, a real icon, nothing placeholder | The icon is drawn, not a font glyph (`D11`), and `npm run check:release` fails on an icon that is the wrong size or carries an alpha channel. The **demo account does not exist yet** — it cannot, until there is a deployed origin (`D20`). `docs/mobile/review-notes.md` says how to make it, and `check:release` fails while its `REPLACE_…` placeholders are still in the file |

## The iOS privacy manifest

`mobile/ios/App/App/PrivacyInfo.xcprivacy` is in the App target's Copy Bundle Resources phase. Without a manifest, App Store Connect
rejects the upload (ITMS-91053) before any human sees it. It was written from the code, not from a template.

**Tracking: none.** `NSPrivacyTracking` false, `NSPrivacyTrackingDomains` empty. There is no advertising SDK, no analytics SDK
and no cross-app identifier anywhere in `public/`, `mobile/` or `src/`.

**Required-reason APIs: none declared in the app's manifest** (`NSPrivacyAccessedAPITypes` is an empty array). The five categories Apple lists are
`UserDefaults`, file timestamps, system boot time, disk space and active keyboards. I searched for every API in all five categories in:
the app's own Swift (`AppDelegate.swift`, `SceneDelegate.swift`), `@capacitor/ios` 8.6.0 core and CapacitorCordova, and the iOS Swift of the
ten plugins in `mobile/package.json`. There are no hits. What does appear and is *not* on the list: `FileManager.fileExists`,
`URLResourceKey.fileSizeKey` (`WebViewAssetHandler.swift`), `task_info` for memory (`@capacitor/device`), `sysctlbyname("hw.machine")`.
`@capacitor/ios` and `CapacitorCordova` ship their own manifests, and both are empty, which agrees. The red-team report (R4) expected
`UserDefaults` CA92.1, `FileTimestamp` C617.1 and `DiskSpace` E174.1. Neither `UserDefaults` nor disk space is used by this dependency
set (older Capacitor versions used `UserDefaults`; 8.6.0 does not), and declaring an API the binary never calls is an inaccurate
manifest too. File timestamps are used by one dependency, `IONCameraLib`, which is covered below.

**`IONCameraLib` uses a file-timestamp API, and its own manifest declares it.** `URL.metadata` in its `URL+Transformations.swift` reads
`URLResourceKey.creationDateKey`, which the built framework imports as `NSURLCreationDateKey`. Its repository has a manifest declaring
that (`NSPrivacyAccessedAPICategoryFileTimestamp`, reasons `C617.1` and `3B52.1`), but its podspec leaves the file out, at the 2.0.0 tag
and on `main` as of 2026-11-06, so a CocoaPods build loses it. The app's manifest is the wrong place to make up for that. Apple says
"the bundle that includes the executable or dynamic library needs to include a privacy manifest file that reports the API", and this
is a dynamic framework. So `mobile/ios/App/IONCameraLib.podspec.json` is the published 2.0.0 podspec with that file added to
`resources`, and the Podfile points at it. Delete both once a release of the library ships the manifest. If the camera plugin ever
requires a different major or minor version, `pod install` stops with an error rather than losing the manifest quietly.

CI's archive at `08650a0` (2026-11-07) has `IONCameraLib.framework/PrivacyInfo.xcprivacy`, at the framework's root as Apple asks, and
it is byte-identical to the file in the library's 2.0.0 tag. The same build found no other binary referencing an API on Apple's list.

**Not proven:** nothing has been uploaded, so App Store Connect has never validated this build. What is shown is that the file is
where Apple's documentation says it goes. ITMS-91053 could still appear at the first upload, and only that upload settles it.

**The `ios` CI job checks this on every build.** Its required-reason step lists what each built binary references from Apple's list, and
warns when one has no privacy manifest in its own bundle, so a plugin upgrade that starts using one shows up there, not at upload.
It does not read what a manifest says, so after a plugin upgrade check the reasons by hand. The step's first version wrongly printed
"no required-reason API references found": `strings -a` did not show this symbol, although `nm -u` did, and the step's `nm` pattern
expected a leading space that `nm -u` does not print, so that half could never match.

**Collected data: all "linked to the user", all for App Functionality, none for tracking.** (Fraud prevention and security count as App
Functionality in Apple's definitions.) Each line is the code it was inferred from:

| Apple data type | What | Read from |
|---|---|---|
| Email Address | the sign-up / sign-in email | `users.email` (`migrations/0001_init.sql`), `src/accounts/` |
| User ID | the screen name and account id; the session token | `users.name` / `users.id`, `sessions` |
| Device ID | the APNs push token and a device label (`Device.getInfo().name`) sent to `POST /api/me/devices`; the salted hashes of the sign-up network and browser | `native.js` `registerDevice()`, `migrations/0010_devices.sql`, `signup_signals.ip_group_hash` / `ua_hash` (`src/trust/signup.js`, `migrations/0009_trust.sql`, deleted after 90 days) |
| Photos or Videos | pictures a member picks or takes and uploads to a post, a page or a message | `@capacitor/camera` via `native.js` (the file input), `src/media/` |
| Emails or Text Messages | direct and group chat messages. **No message text goes in a push**: R5 is fixed, and a push carries the sender's screen name and a fixed phrase only (`src/push/push.js:8-16`, `:147`, pinned by `test/push.test.mjs`) | `src/chats/`, `src/push/push.js` |
| Other User Content | statuses, comments, board threads, blog entries, profile text | `src/social/`, `src/boards/`, `src/profiles/` |
| Coarse Location | the **country** (and network ASN) Cloudflare derives from the request address at sign-up. The app never reads device location | `signup_signals.country` / `asn`, 90 days |
| Other Data Types | the birthdate (age check, star sign); the sign-up risk score; AI-writing scan scores | `users.birthdate`, `signup_signals.risk`, `ai_scans` |

**Not declared, deliberately:** Name (the site has screen names, which are User IDs, not legal names), Precise Location, Contacts,
Search History (no query is stored), Browsing History, Product Interaction / Usage Data (no analytics exists), Crash and Performance
Data (no crash reporter exists), Purchases and Payment Info (nothing is sold). If any of those changes, the manifest and both stores'
questionnaires change in the same commit.

**Open question the manifest cannot answer:** the sign-up form loads Cloudflare Turnstile (`challenges.cloudflare.com`) inside the web view.
It is Cloudflare's script and collects whatever it collects; the App Store questionnaire (not the manifest) should say a third party
receives browser signals for bot detection. Spotify and Apple preview images and audio are fetched from their CDNs.

**To verify on a Mac:** archive, then in Xcode's Organizer select the archive and choose *Generate Privacy Report*. It aggregates this
manifest with the pods' and shows the privacy-label table the App Store questionnaire needs. *Distribute > Validate* runs the same
checks App Store Connect does. ITMS-91053 in the rejection email means a required-reason API was found that no manifest declares.

## Google Play

| Requirement | Where we stand |
|---|---|
| Data safety form | **Drafted, not submitted.** The answers, with `file:line` evidence, are in [listing.md](listing.md). They are the iOS manifest's list plus what `src/trust/` collects (hashed IPs, sign-up signals, 90-day retention) |
| Closed test before production | **Adds weeks.** A **personal** developer account created after 13 November 2023 must run a closed test with **at least 12 testers, each opted in for 14 days in a row**, before it can apply for production access ([Play Help](https://support.google.com/googleplay/android-developer/answer/14151465)). A tester who opts out and back in restarts their 14 days. Organization accounts are said to be exempt; the page above covers personal accounts only, so confirm that in the console. Which account type to open is an owner decision ([launch.md](../launch.md)) |
| Target API level | **Met.** Play requires new apps and updates to target Android 16 (API 36) from 31 August 2026 ([Play Help](https://support.google.com/googleplay/android-developer/answer/11926878)). `targetSdkVersion` is 36 (`mobile/android/variables.gradle:4`) and CI builds against it |
| UGC policy | Same four mechanisms as Apple 1.2, and the same app routes to them |
| Account deletion, including a web route | `DELETE /api/me` plus Settings in the app and on the site. Play also wants a **deletion URL in the listing**; there is no deployed origin to put there yet (`D20`) |
| Permissions | `INTERNET`, `CAMERA` (not required hardware) and `POST_NOTIFICATIONS` are ours. The built app also has `VIBRATE` and `ACCESS_NETWORK_STATE`, plus `WAKE_LOCK` and `com.google.android.c2dm.permission.RECEIVE` from the push plugin (read from the release APK, 2026-11-07). The site's `Permissions-Policy` separately denies geolocation, microphone and payment |
| App icon | Drawn, with an adaptive foreground and a monochrome layer for Android 13+ themed icons (`D11`). A 512px listing icon without transparency is written to `mobile/store/play-icon-512.png` |
| App access (test credentials) | The same demo account as App Review. See `docs/mobile/review-notes.md`; it does not exist yet |

## The build floor for App Store uploads

- **Now:** uploads must be built with **Xcode 26 or later** against the iOS 26 SDK, in force since 28 April 2026 ([Apple's upcoming requirements](https://developer.apple.com/news/upcoming-requirements/), read 2026-11-07). CI uses Xcode 26.3 on `macos-15`, so it meets this. The app's deployment target is iOS 15 (`mobile/ios/App/Podfile`), above the iOS 13 minimum Apple lists from 9 September 2026.
- **Reported, not confirmed:** Xcode 27, which installs only on Apple silicon, is reported to become required from **April 2027**. Apple's page does not say so yet. If it does, the `macos-15` runner will probably be too old and `IOS_RUNNER` will need a newer label. Check Apple's page again before the first upload and before any submission after March 2027.

## Push: what is built and what cannot work yet

Worth being exact, because "push is native" is a Guideline 4.2 argument and an untrue one is expensive.

**Built and tested:** the permission prompt on first sign-in, device registration (`POST /api/me/devices`), the
server half (`src/push/`), and routing a notification tap to the right page including from a cold start — all of it
covered by `mobile/test/bridge.test.mjs` against a fake plugin.

**Cannot work in any build today:** no APNs auth key, and no `google-services.json` (Android's build log literally
says "Push Notifications won't work" when it is absent, `mobile/android/app/build.gradle:76`). So the app asks for
permission and registers, and no notification is ever delivered. Until both exist, **do not list push in the App
Review notes** — a reviewer who allows the prompt and then waits is being shown a feature that is not there.


## Blocked on credentials

Nothing here can be finished without:

- Apple Developer Program + App Store Connect API key — team id, bundle id, TestFlight upload
- Google Play Console + a service-account JSON — upload key fingerprint for `assetlinks.json`
- APNs auth key, FCM project — push
- The real production origin — the D1 id in `wrangler.jsonc` is still a placeholder, so the app
  has no server to point at
- A macOS machine or runner — no iOS artifact can exist without one

Until the fingerprint and team id arrive, `apple-app-site-association` and `assetlinks.json` carry
placeholders and universal links cannot work. That is logged in the deviation register, not
hidden.
