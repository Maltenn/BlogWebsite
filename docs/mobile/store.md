# Store readiness

What the two stores require, what this repo already satisfies, and what is still missing. The
missing column is the honest one: most of it needs credentials or a Mac, neither of which exists
yet.

## Apple App Store

| Guideline | What it demands | Where we stand |
|---|---|---|
| **4.2 Minimum Functionality** | Not a repackaged website | **The main risk, and the case is now made out of things that exist.** What a reviewer can see without being told where to look, in this order: (1) the **tab bar is native** — a scroll view of native buttons the shell draws, with the system's own scrolling, hit testing and badges, not a web control (`D3`); (2) the **camera / photo-library sheet** is two taps from a cold launch, on the sign-up screen (`D24`); (3) **share sheet**, **haptics**, outbound links in Safari View Controller / a Custom Tab, the session in the **Keychain / Keystore**, and an **offline shell** that opens with no network. `docs/mobile/review-notes.md` is the reviewer-facing version of that list, with the taps. What is NOT in it: biometric unlock (never built), universal links / App Links (they cannot work until `D18`/`D19` are real), and push (the code is there and tested against a fake, but no build can receive a notification until an APNs key and an FCM project exist — see below) |
| **1.2 User-Generated Content** | A filter for objectionable content, a way to report, a way to block, and a published way to contact | All four exist server-side (`src/ai/`, `src/trust/moderation.js`, `POST /api/reports`, `POST /api/blocks/:name`, the house rules page) **and all four are reachable in the app**, checked by following the imports rather than by memory: `widgets/safety.js` gives `postActions` (the report / delete menu) to `widgets/postcard.js`, `widgets/comments.js` and `widgets/blogindex.js`, so every status, comment, blog entry and board thread carries it wherever it is shown, feed included; `reportDialog` and `blockUser` are also on profiles (`pages/profile.js`), in a conversation (`pages/chat.js`) and in #ourspace (`pages/ourspace.js`). The house rules are in the footer of every page (`public/index.html:30`). Not yet counted in taps on a device |
| **5.1.1(v) Account Deletion** | Deletion from inside the app | `DELETE /api/me` exists and Settings has a "delete my account" panel (`public/js/pages/settings.js`). Checklist item 12 holds it to ≤3 taps; **that count has not been made on a device** |
| **1.4 / 2.3.8 Age rating** | A rating that matches the content | `MIN_AGE` is a Worker environment variable that **defaults** to 13 (`src/accounts/auth.js:101`), so the deployment decides it and the rating has to match whatever it is set to. A social network with unfiltered UGC rates 17+ unless moderation is argued. Needs a decision |
| **5.1.1 Privacy** | A privacy policy URL and an accurate privacy manifest | The rules page covers policy. The iOS privacy manifest is written (`mobile/ios/App/App/PrivacyInfo.xcprivacy`, below); the App Store privacy questionnaire is **not filled in**, but its answers are the manifest's list |
| **3.1.1 In-App Purchase** | No outside payment | Nothing is sold. Clean |
| **4.8 Login Services** | A privacy-preserving login option alongside third-party ones | Email + password exists alongside Google and Discord. Likely clean; Sign in with Apple may still be requested |
| **2.1 App Completeness** | A working demo account, a real icon, nothing placeholder | The icon is drawn, not a font glyph (`D11`), and `npm run check:release` fails on an icon that is the wrong size or carries an alpha channel. The **demo account does not exist yet** — it cannot, until there is a deployed origin (`D20`). `docs/mobile/review-notes.md` says how to make it, and `check:release` fails while its `REPLACE_…` placeholders are still in the file |

## The iOS privacy manifest

`mobile/ios/App/App/PrivacyInfo.xcprivacy` is in the App target's Copy Bundle Resources phase. Without a manifest, App Store Connect
rejects the upload (ITMS-91053) before any human sees it. It was written from the code, not from a template.

**Tracking: none.** `NSPrivacyTracking` false, `NSPrivacyTrackingDomains` empty. There is no advertising SDK, no analytics SDK
and no cross-app identifier anywhere in `public/`, `mobile/` or `src/`.

**Required-reason APIs: none declared** (`NSPrivacyAccessedAPITypes` is an empty array). The five categories Apple lists are
`UserDefaults`, file timestamps, system boot time, disk space and active keyboards. I searched for every API in all five categories in:
the app's own Swift (`AppDelegate.swift`, `SceneDelegate.swift`), `@capacitor/ios` 8.6.0 core and CapacitorCordova, and the iOS Swift of the
ten plugins in `mobile/package.json`. There are no hits. What does appear and is *not* on the list: `FileManager.fileExists`,
`URLResourceKey.fileSizeKey` (`WebViewAssetHandler.swift`), `task_info` for memory (`@capacitor/device`), `sysctlbyname("hw.machine")`.
`@capacitor/ios` and `CapacitorCordova` ship their own manifests, and both are empty, which agrees. The red-team report (R4) expected
`UserDefaults` CA92.1, `FileTimestamp` C617.1 and `DiskSpace` E174.1; none of those is used by this dependency set (older Capacitor
versions used `UserDefaults`; 8.6.0 does not), and declaring an API the binary never calls is an inaccurate manifest too.
**Not read here:** the source of the two CocoaPods dependencies that are not on disk without `pod install`, `KeychainSwift` (its source
uses only `SecItem*`) and `IONCameraLib`.

**Open: `IONCameraLib` is not covered.** The first CI build (2026-11-05, `IONCameraLib` 2.0.x) contradicts what was assumed here: the
built framework imports `NSURLCreationDateKey`, a file-timestamp API, and it contains no privacy manifest, despite its README saying it
ships one. So the empty list above may not survive the first upload (ITMS-91053). Before that upload, find out what the library uses
it for, then either add the matching `NSPrivacyAccessedAPICategoryFileTimestamp` reason to the app's manifest or get a version that
ships its own. Do not guess the reason code.

The `ios` CI job has a step that is meant to print any required-reason symbol in the built app and frameworks, but on that build it
printed "no required-reason API references found", which is wrong: the symbol is in the file. The cause is not known. Until that is
fixed, check the archive by searching the binaries for the same names, and do it again after every plugin upgrade.

**Collected data: all "linked to the user", all for App Functionality, none for tracking.** (Fraud prevention and security count as App
Functionality in Apple's definitions.) Each line is the code it was inferred from:

| Apple data type | What | Read from |
|---|---|---|
| Email Address | the sign-up / sign-in email | `users.email` (`migrations/0001_init.sql`), `src/accounts/` |
| User ID | the screen name and account id; the session token | `users.name` / `users.id`, `sessions` |
| Device ID | the APNs push token and a device label (`Device.getInfo().name`) sent to `POST /api/me/devices`; the salted hashes of the sign-up network and browser | `native.js` `registerDevice()`, `migrations/0010_devices.sql`, `signup_signals.ip_group_hash` / `ua_hash` (`src/trust/signup.js`, `migrations/0009_trust.sql`, deleted after 90 days) |
| Photos or Videos | pictures a member picks or takes and uploads to a post, a page or a message | `@capacitor/camera` via `native.js` (the file input), `src/media/` |
| Emails or Text Messages | direct and group chat messages (and the first 140 characters in the push payload, see R5) | `src/chats/`, `src/push/push.js` |
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
| Data safety form | **Not written.** Its answers are the same list as the iOS privacy manifest above, plus an honest account of what `src/trust/` collects (hashed IPs, sign-up signals, 90-day retention) |
| Target API level | `targetSdk` is 36 and CI builds against it (`mobile/android/variables.gradle`) |
| UGC policy | Same four mechanisms as Apple 1.2, and the same app routes to them |
| Account deletion, including a web route | `DELETE /api/me` plus Settings in the app and on the site. Play also wants a **deletion URL in the listing**; there is no deployed origin to put there yet (`D20`) |
| Permissions | `INTERNET`, `CAMERA` (with `android.hardware.camera` not required) and `POST_NOTIFICATIONS`, and nothing else (`AndroidManifest.xml`). The site's `Permissions-Policy` separately denies geolocation, microphone and payment |
| App icon | Drawn, with an adaptive foreground and a monochrome layer for Android 13+ themed icons (`D11`). A 512px listing icon without transparency is written to `mobile/store/play-icon-512.png` |
| App access (test credentials) | The same demo account as App Review. See `docs/mobile/review-notes.md`; it does not exist yet |

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
