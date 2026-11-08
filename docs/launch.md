# Launch checklist

The one master list, from the code to both stores. Work it top to bottom. Every step says who does it, what it needs
first, and which doc explains it. "Owner" means a person with the accounts and the authority. "Claude" means Claude
can do it in the repo, usually after the owner supplies a value.

The detail lives elsewhere: [deploy.md](deploy.md) (the site), [operations.md](operations.md) (running it),
[mobile/shells.md](mobile/shells.md) (building the apps), [mobile/store.md](mobile/store.md) (what the stores require),
[mobile/listing.md](mobile/listing.md) (text and questionnaire answers), [mobile/review-notes.md](mobile/review-notes.md)
(what App Review reads) and [mobile/checklist.md](mobile/checklist.md) (the device checks).

## Changes to the order this list started from

Each was checked against the docs and the repo on 2026-11-07. Read these first.

1. **"Main" here means two things, so be careful.** The work branch `claude/intelligent-fermat-keh09f` now holds PR #1's fixes, and that is what C1 and C2 mean. GitHub's `main` still has the old desktop site and none of the app. The only planned way into it is the cutover merge (W11). PR #1 is a draft and must never be merged. Until the cutover the release jobs cannot run, because they only build a `mobile-v*` tag whose commit is on `main` ([shells.md](mobile/shells.md), "CI"). So **the website has to go live before either store build**.
2. **`plates:check` goes after the public contact address and the Terms, not before.** Both edit `public/`, and the
   `rules` route is one of the plates. A check run first would pass, and then the next change would break it. If the
   rules plates change, that is a deliberate re-baseline ([harness.md](mobile/harness.md)), not a failure to ignore. It also
   needs `git lfs pull` first, and about 11 minutes.
3. **Apple's team id is needed before the Android release, not just before iOS.** `check:release` reads **both**
   `public/.well-known/` files whichever platform it is building (`mobile/scripts/check.mjs:128-130`). An Android tag
   fails while `apple-app-site-association` still says `REPLACE_APPLE_TEAM_ID`, and an iOS tag fails while
   `assetlinks.json` still has the placeholder fingerprint. So the Apple Developer enrolment (I1) starts early, in
   parallel, and it can take days.
4. **The first Android upload cannot come from CI.** The Play App Signing fingerprint is read from the Play Console
   after a first bundle has been uploaded (as I understand Play; check the console), and CI refuses to build until that
   fingerprint is in `assetlinks.json`. So the first bundle is built by hand and uploaded in the console (A4), then the
   fingerprint goes into the repo, then CI takes over.
5. **Rotate the Spotify secret after the old Worker is retired, not before.** The old `ourspace-api` Worker uses the
   same secret, so rotating first breaks the desktop site's songs ([deploy.md](deploy.md), cutover step 8).
6. **Register sign-in apps with the final host first.** `deploy.md` says both "add the custom domain before registering
   sign-in apps" and, in the cutover list, "register the redirect with the final host before pointing the domain". They do
   not conflict. A redirect address is only text, so register `https://ourspace.page/api/oauth/<provider>/callback` early.
7. **Added:** a public page that says how to delete an account (Play wants a URL, and Settings needs a login); the iPad
   decision (the project is universal, `listing.md` section 5); the support mailbox behind `<support-email>`.
8. **The website steps were reordered (W3 to W9).** A test sign-up needs Resend and Turnstile, so they come first. The
   moderator step needs a name only the owner holds: claim `malten` with the first working sign-up, and check it is yours
   before the SQL in `operations.md` makes it `is_admin`. The domain moves only after that.
9. **The demo account's password is never committed.** This repository is public. `review-notes.md` keeps
   `REPLACE_DEMO_PASSWORD` for good; the real password is pasted into App Store Connect and Play Console, and set as the
   `REVIEW_DEMO_PASSWORD` secret of the `release` environment, which `check:release` reads (P3, P5).
10. **Never run a Time Travel restore as a test.** It overwrites the live database (W12).

## 1. Code

| # | Step | Who | Needs | Read |
|---|---|---|---|---|
| C1 | Finish PR #1 | **Done.** CI passed on `9a9ef96`: `bridge`, `tabbar`, `android`, `ios` | | [shells.md](mobile/shells.md) |
| C2 | Bring its fixes to the work branch | **Done** locally, not pushed | | [deploy.md](deploy.md#cutover-from-the-desktop-site) |
| C3 | Public contact address | **Built.** The `CONTACT_EMAIL` var shows it on `/rules`, `/terms` and `/privacy`. Owner supplies the address (D-contact) | D-contact | [deploy.md](deploy.md) |
| C4 | Terms of Service | **Drafted** at `/terms`, for review by someone qualified (D4) | D4 | [decisions/008](decisions/008-launch-legal.md) |
| C5 | Privacy policy, and how to delete an account | **Drafted** at `/privacy`, each claim traced to the code, for the same review | D4 | [decisions/008](decisions/008-launch-legal.md) |
| C6 | Fix the small doc errors | **Done** | | |
| C7 | Run `git lfs pull`, then `npm run plates:check` (after C3 to C5, see change 2) | Claude | C3, C4, C5 | [harness.md](mobile/harness.md) |
| C8 | Fix `store.md` | Claude. **Done** in this change | | [store.md](mobile/store.md) |
| C9 | If the owner picks iPhone-only: set `TARGETED_DEVICE_FAMILY` to 1 (iOS project, lines 391 and 411) | Claude | D-ipad below | [listing.md](mobile/listing.md) section 5 |

## 2. Owner decisions

Nothing below can be settled by Claude. `listing.md` shows how the age choice changes the ratings.

| # | Decision | What it changes | Read |
|---|---|---|---|
| D1 | **Minimum age: 13, 16 or 18.** The server default is 13 (`src/accounts/auth.js:101`, `wrangler.jsonc:31`) | `MIN_AGE`; the store ratings and Play target ages; listing text; the rules page; checklist item 14; whether adult-to-teen messaging is an issue at all | [listing.md](mobile/listing.md) section 4 |
| D2 | **Workers Free or Paid** ($5 a month minimum). Free gives 10 ms of CPU a request, 100,000 requests a day, and D1 stops at 100,000 writes a day (since 1 Sept 2026). Paid gives 30 days of D1 Time Travel instead of 7, and push can send more per run | whether to subscribe before launch; backups; push volume | [decisions/004](decisions/004-cloudflare-limits-and-costs.md), [operations.md](operations.md#backups) |
| D3 | **Who moderates every day**, and covers when the owner cannot, including the **48-hour Take It Down clock** and NCMEC reporting for CSAM. In-house review is the launch plan, so a person has to open the Photos queue daily | whether photos can be allowed at launch; the answer to Apple 1.2 and Play's UGC policy | [operations.md](operations.md#daily-routine), [deploy.md](deploy.md#photos-csam-detection-launch-in-house-review) |
| D4 | **Legal review**: Terms, the privacy text, the Take It Down Act's reach, age-assurance duties for the chosen `MIN_AGE`, and whether the site storing birthdays of 13-year-olds needs anything | C4, C5, I5 | [roadmap.md](roadmap.md), [operations.md](operations.md#photos) |
| D5 | **The real app id** (a reverse-domain name, for example `<something>.ourspace`). `com.ourspace.app` is rejected by `check:release`. One id is used for both stores, the `.well-known` files and the APNs topic | `OURSPACE_APP_ID`; I2; A2 | [shells.md](mobile/shells.md) ("Signing, push and links") |
| D6 | **Personal or organization store accounts** (Apple and Google). A personal Play account made after 13 Nov 2023 must run a closed test of 12 testers for 14 days first, which adds weeks. Organization accounts are said to be exempt. Organizations need a legal entity, and I believe a D-U-N-S number, which can take weeks: check both stores' enrolment pages | A6 and the schedule; the seller name the stores show | [store.md](mobile/store.md) (Google Play table) |
| D-contact | The mailbox for `<support-email>`. Cloudflare Email Routing could forward `support@ourspace.page` to a personal inbox (check it fits the plan) | C3, the stores' contact fields | [listing.md](mobile/listing.md) |
| D-ipad | iPhone-only, or ship the universal build and make 13-inch iPad screenshots | C9, I7 | [listing.md](mobile/listing.md) section 5 |
| D-push | Ship 1.0 without push (the app still asks for notification permission and nothing arrives), or wait for APNs and Firebase keys. The listing does not mention push either way | P2 | [store.md](mobile/store.md) ("Push") |
| D-data | The two judgment calls in the store questionnaires: whether a screen name counts as "Name", and whether Cloudflare's request logs count as diagnostics. Also whether Play counts Cloudflare, Resend and push as "shared" | I7, A7 | [listing.md](mobile/listing.md) sections 2 and 3 |

## 3. Launch the website

All of it is Wrangler and dashboards; the steps are in [deploy.md](deploy.md). Wrangler logs in as the owner, so the
owner runs the commands unless they let Claude use their session.

| # | Step | Who | Needs | Read |
|---|---|---|---|---|
| W1 | Cloudflare login (`npx wrangler login`); create the D1 database and paste its id into `wrangler.jsonc`; apply the migrations (`npm run db:remote`) | owner | D2 | [deploy.md](deploy.md#first-deploy) |
| W2 | Switch on R2 (it may ask for a payment method); create the bucket; set `IP_SALT` and `TOKEN_KEY` (**never lose `TOKEN_KEY`**); `npm run deploy` | owner | W1 | [deploy.md](deploy.md#first-deploy) |
| W3 | Resend: account, verified sending domain, `RESEND_API_KEY`, `MAIL_FROM`. **Email sign-ups are refused until this is done**, so no test sign-up can pass before it | owner | W2 | [deploy.md](deploy.md#emails-confirming-new-accounts-password-resets) |
| W4 | Turnstile: widget, site key into `wrangler.jsonc` (`TURNSTILE_SITE_KEY`) and redeploy, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_HOSTNAMES`. Allow the domain (`ourspace.page`, `www.ourspace.page`), the `workers.dev` host, **and `localhost`** (the apps' web view runs on it). **Sign-ups are refused until this is done**, so no test sign-up can pass before it | owner; Claude edits `wrangler.jsonc` | W2 | [deploy.md](deploy.md#the-human-check-cloudflare-turnstile), [shells.md](mobile/shells.md) ("Turnstile") |
| W5 | Test on the `workers.dev` address: sign up, confirm the email, post with a photo, log out and in. **Make the first working sign-up the screen name `malten`**: it is the moderator name the docs use, and whoever claims it first is the one `operations.md` makes a moderator. Nothing about `ourspace.page` changes yet | owner, Claude can script it | W3, W4 | [deploy.md](deploy.md#cutover-from-the-desktop-site) (step 3) |
| W6 | Make `malten` a moderator. **Check first that the account called `malten` is yours** (its email is yours: run the `SELECT` in [operations.md](operations.md) before the `UPDATE`). If anyone else got the name, do not run the `UPDATE`: it would hand them `is_admin`. Choose another screen name for the moderator and use that name in the SQL | owner | W5 | [operations.md](operations.md#make-yourself-a-moderator) |
| W7 | Optional: Google and Discord sign-in, with callback `https://ourspace.page/api/oauth/<provider>/callback`. Check each company's button branding rules | owner | W2 | [deploy.md](deploy.md#other-sign-in-options) |
| W8 | Optional: Spotify. Reuse the old app, add the callback, add up to **5 people** by hand (Premium needed; the cap is Spotify's rule). Not available inside the apps (D15) | owner | W2 | [deploy.md](deploy.md#spotify-everybodys-top-songs) |
| W9 | Point `ourspace.page` and `www.ourspace.page` at the Worker (custom domains; DNS must be on Cloudflare; remove the GitHub Pages records). Wait until both show the new site. The moderator exists by now (W6): photos launch with in-house review | owner | W5, W6, D3 | [deploy.md](deploy.md#cutover-from-the-desktop-site) (step 4) |
| W10 | Disable GitHub Pages (repo Settings, then Pages). **Only after W9**, or the site goes dark | owner | W9 | [deploy.md](deploy.md#cutover-from-the-desktop-site) (step 5) |
| W11 | Merge the branch into `main`. This is what retires the desktop site, and it triggers the mobile CI on `main` | owner | W10, C3 to C7 | [deploy.md](deploy.md#cutover-from-the-desktop-site) (step 6) |
| W12 | Test the live site, and confirm backups are there: `npx wrangler d1 time-travel info ourspace-social-db` only reads, and shows the restore points. **Never run `time-travel restore` to try it**: it puts the live database back to an earlier minute, so every write since is lost and deleted accounts come back. Restore only in a real disaster, deliberately | owner, Claude can script | W11 | [operations.md](operations.md#backups) |
| W13 | Retire the old `ourspace-api` Worker and `ourspace-db` database in the Cloudflare dashboard, **then** rotate the Spotify client secret (`wrangler secret put SPOTIFY_CLIENT_SECRET`) | owner | W12, W8 | [deploy.md](deploy.md#cutover-from-the-desktop-site) (steps 7, 8) |

## 4. Prepare the apps

| # | Step | Who | Needs | Read |
|---|---|---|---|---|
| P1 | Set the real origin and app id: repository variables `OURSPACE_ORIGIN` (https, no trailing slash) and `OURSPACE_APP_ID`; update `mobile/ourspace.config.json` and both `.well-known` files' package and bundle id | owner sets the variables; Claude edits the files | W9, D5 | [shells.md](mobile/shells.md) ("The one setting") |
| P2 | Firebase project and APNs key, for push. Optional for 1.0 (D-push). If wanted: `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` as Worker secrets, `google-services.json` as the build secret `GOOGLE_SERVICES_JSON`. The APNs key needs I1 | owner | D-push, I1 for APNs | [deploy.md](deploy.md#vars-and-secrets), [store.md](mobile/store.md) ("Push") |
| P3 | Make the **demo account** on the live origin: sign up on the site, confirm the email, have a moderator clear its hold, fill it with a picture, statuses, a thread, a friend and a conversation. Put its **name** (never its password) in `review-notes.md`. **The password never goes in this repository, which is public**: paste it into App Store Connect and Play Console directly, and set it as the `REVIEW_DEMO_PASSWORD` secret of the `release` environment, which `check:release` needs. A moderator is `malten` (W6) | owner makes it; Claude fills in the name | W3, W9, W6 | [review-notes.md](mobile/review-notes.md) |
| P4 | Create the GitHub `release` environment: required reviewers, deployment rule allowing only tags `mobile-v*`, and the signing secrets moved into it | owner | | [shells.md](mobile/shells.md) ("CI"), top of `.github/workflows/mobile.yml` |
| P5 | `npm run check:release` passing for each platform. It fails on a placeholder origin or app id, the two `.well-known` placeholders, `REPLACE_` in `review-notes.md` (except `REPLACE_DEMO_PASSWORD`, which stays: the password is not in git), and a missing `REVIEW_DEMO_PASSWORD`. It also fails if that password is found in the file. So it only goes green after P1, P3, A4 and I1 | Claude | P1, P3, A4, I1 | [shells.md](mobile/shells.md), `mobile/scripts/check.mjs` |

## 5. Android

| # | Step | Who | Needs | Read |
|---|---|---|---|---|
| A1 | Play Console account and identity checks | owner | D6 | [store.md](mobile/store.md) |
| A2 | Create the app in the console, using the app id from D5 | owner | A1, D5 | [shells.md](mobile/shells.md) |
| A3 | Make the upload keystore and keep it somewhere safe (losing it is a long recovery). Set `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `PLAY_SERVICE_ACCOUNT_JSON` in the `release` environment | owner; Claude gives the commands | A2, P4 | [shells.md](mobile/shells.md) ("Android") |
| A4 | Build the first signed bundle by hand (`./gradlew bundleRelease` with the keystore variables and an https `OURSPACE_ORIGIN`) and upload it in the console to internal testing. Then copy the **Play App Signing** SHA-256 (App integrity, not the upload key's) into `public/.well-known/assetlinks.json`, commit it to `main`, **redeploy the Worker**, and check the file at `https://<origin>/.well-known/assetlinks.json` | owner uploads; Claude edits the file and checks | A3, P1, W11 | [deviations.md](mobile/deviations.md) (D19), [shells.md](mobile/shells.md) |
| A5 | The real-phone checklist on an Android phone: items 1, 2, 4 to 11, 16 to 20, 23 to 24, 26, 27 and 30. Items 1 to 5, 12 to 14, 16 to 20, 23b and 23c have run on the emulator only | owner holds the phone; Claude reads the results | A4 | [checklist.md](mobile/checklist.md) |
| A6 | **Personal account only:** a closed test with at least 12 testers, each opted in for 14 days in a row, before applying for production. Recruit the testers first. A tester who leaves and returns restarts their 14 days. **This is the long pole: start it as soon as A4 is done** | owner | A4, D6 | [store.md](mobile/store.md), [Play Help](https://support.google.com/googleplay/android-developer/answer/14151465) |
| A7 | Fill the console: Data safety, content rating, target audience, App access (the review-notes block), listing text, screenshots, feature graphic, and the deletion URL | Claude drafts everything in `listing.md`; owner pastes it | D1, D-data, C3, C5, P3 | [listing.md](mobile/listing.md) sections 1, 3, 4, 5 |
| A8 | Tag `mobile-v<version>` on `main`. The reviewer approves in the `release` environment, CI uploads, then the owner rolls out (staged is safer) | owner tags and approves | P5, A5, A6 (personal), A7 | [shells.md](mobile/shells.md) ("CI") |

## 6. iOS

The app has **never launched on any Apple device or simulator.** CI has compiled and archived it, and nothing more
([shells.md](mobile/shells.md)).

| # | Step | Who | Needs | Read |
|---|---|---|---|---|
| I1 | Apple Developer Program enrolment. **Start this at the beginning**: change 3. Then put the Team ID in `public/.well-known/apple-app-site-association` and the `IOS_TEAM_ID` secret | owner enrols; Claude edits the file | D6 | [store.md](mobile/store.md) ("Blocked on credentials") |
| I2 | Register the app id with Push Notifications and Associated Domains; create the app in App Store Connect; make the distribution certificate, provisioning profile and App Store Connect API key; set `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY_P8` | owner | I1, D5, P4 | [shells.md](mobile/shells.md) ("Signing, push and links") |
| I3 | A Mac, a cloud Mac or a CI job that boots the Simulator, for the **first launch**. Look at the layout, the tab bar, sign-in and the splash. Xcode 26 is the floor now; Xcode 27 (Apple silicon only) is **reported, not confirmed**, as required from April 2027 and would need a newer runner than `macos-15` | owner provides the Mac; Claude can write a CI simulator job | | [shells.md](mobile/shells.md) ("iOS: needs a Mac"), [store.md](mobile/store.md) ("The build floor") |
| I4 | A real iPhone: Keychain (checklist 1, 2), Google and Discord sign-in (5), Turnstile (6, the first run with the app's own origin), account deletion count (12, **unchecked on iOS**), push if P2 (7 to 11), and items 13, 16 to 20, 23 to 24, 26, 27, 30 | owner holds the phone | I2, I3, W4 | [checklist.md](mobile/checklist.md) |
| I5 | Age-law work, only if legal review (D4) says the chosen age needs it | owner and counsel; Claude builds what is asked | D4 | [listing.md](mobile/listing.md) section 4 |
| I6 | TestFlight: tag `mobile-v<version>` on `main`. This is the **first real test of the privacy-manifest fix**. App Store Connect has never seen the build, so ITMS-91053 could still appear. In Xcode's Organizer, run Generate Privacy Report and Validate | owner tags and approves | P5, I2 | [store.md](mobile/store.md#the-ios-privacy-manifest) |
| I7 | App Store Connect: age-rating questionnaire (13+, 16+ or 18+), App Privacy answers, privacy policy and support URLs, screenshots (iPad: D-ipad), App Review notes and the demo account, export compliance (`ITSAppUsesNonExemptEncryption` is already set in `Info.plist`) | Claude drafts from `listing.md`; owner pastes | D1, D-data, C3, C5, P3, I6 | [listing.md](mobile/listing.md) sections 1, 2, 4, 5 |
| I8 | Submit for review. If 4.2 (minimum functionality) is raised, see the argument in `review-notes.md` | owner | I4, I6, I7 | [review-notes.md](mobile/review-notes.md) |

## Added by the legal brief

These came from [decisions/008](decisions/008-launch-legal.md), dated 2026-11-07. It is research for a lawyer, not legal advice, and about 19 of its claims are from secondary sources only. None of this can be settled by Claude.

| # | Step | Who | Needs |
|---|---|---|---|
| L1 | **Decide who legally runs OurSpace.** The DMCA agent's address, the NCMEC "provider" and some state tests all depend on it | Owner, lawyer | |
| L2 | **Take It Down notice and removal route.** Reported as due since 2026-05-19. The notice is built, and reports need a login, so `CONTACT_EMAIL` is the only route for someone with no account. Must be set before launch | Owner | D-contact |
| L3 | **App age signals.** Texas SB 2420 is reported enforceable now, with no size exemption. Ask the lawyer what applies, then Claude builds Apple's Declared Age Range and Google's Play Age Signals before any store release | Lawyer, then Claude | L1 |
| L4 | **NCMEC.** Register the provider's contact details, get credentials, and name who files reports | Owner | L1 |
| L5 | **Confirm the CSAM procedure.** `operations.md` was rewritten on 2026-11-07 to stop telling moderators to download material or delete it after reporting. Enticement or trafficking in private messages has no flow yet | Lawyer | |
| L6 | **DMCA agent:** whether to register one | Owner, lawyer | L1 |
| L7 | **Sign-up agrees to the house rules only, not the Terms.** Changing it re-baselines the `join` plates | Lawyer, then Claude | C4 |

## Optional: try it on your iPhone

No paid account needed: [mobile/iphone-testing.md](mobile/iphone-testing.md).

## What takes longest

Start these first, in parallel: Apple enrolment (I1), the Play account (A1) and a **personal** account's 14-day closed
test (A6), legal review (D4), and finding 12 testers. Everything else is hours or a day.
