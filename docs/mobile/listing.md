# Store listing: text, questionnaires, screenshots

Paste-ready text and answers for App Store Connect and Play Console. Read it with [store.md](store.md) (what the stores
require) and [review-notes.md](review-notes.md) (what App Review reads).

**Placeholders.** `<origin>` is the production URL and `<support-email>` is the contact address. Neither exists yet.
`<MIN_AGE>` is the minimum age, which the owner has not decided (13, 16 or 18). Search this file for `<` before pasting
anything. [launch.md](../launch.md) says when each one gets a value.

**What this file is not.** It is not legal advice and it takes no position on which `MIN_AGE` to pick or what the law
requires. Where the code and an existing doc disagree, the disagreement is listed in the last section and both are quoted.
I could not open either console, so every question wording below is from memory of the forms and must be checked
against the live form. The sizes were read from the stores' help pages on 2026-11-07.

---

## 1. Listing text

Voice: lowercase, friendly, plain. Push notifications are **not** mentioned, because no build can receive one yet
(`store.md`, "Push"). Nothing here claims dark mode, widgets, biometric unlock, Spotify in the app (connecting does not
work in the app, `deviations.md` D15), video (dropped) or an iPad layout.

### Apple App Store

| Field | Limit | Text |
|---|---|---|
| Name | 30 | `OurSpace` |
| Subtitle | 30 | `a retro place for your friends` |
| Promotional text | 170 | `your own page, a top 8, a blog, boards and a chat room that never sleeps. make it loud. make it yours.` |
| Keywords | 100 | `retro,social,profile,friends,blog,boards,chat,top 8,glitter,y2k,2000s,nostalgia,horoscope,pages` |
| Primary category | | Social Networking |
| Secondary category | | optional. Entertainment or Lifestyle; leave empty if unsure |
| What's new (1.0) | 4000 | `hello! this is the first version.` |
| Support URL | | `<origin>/rules` once that page shows `<support-email>` (it shows no contact today) |
| Privacy policy URL | | `<origin>/privacy` (the full policy; `/rules` has only a short summary) |
| Marketing URL | | `<origin>` (optional) |
| Copyright | | `<year> <owner's name>` (the owner's to fill in) |

Do not put another company's name in the keywords (Myspace, Facebook and the like). Apple rejects competitor trademarks
in metadata. Keywords: 95 characters with the commas.

**Description (4000 max):**

```
ourspace is a small, friendly social network with a deliberately retro look. think the web around 2005: your own page, loud and glittery if you want it, and people you actually know.

what you get

- your own page. pick a theme, a background, a font, badges and a mood, write an about me, and set your top 8.
- a feed of your friends. statuses, replies, likes, reposts, quotes and photos.
- a blog. write entries, add a cover photo, let people comment.
- boards. 14 topic boards with threads, comments and votes.
- #ourspace, a live chat room for everybody, plus direct messages and group chats.
- friends' comments on your page, and a private-page option where people have to ask to follow you.
- a daily horoscope, worked out from the real positions of the sun, moon and planets. it's for fun.
- photos (no video), shrunk on your phone first and stripped of hidden location data on our server.

how it behaves

- no ads and no analytics.
- you must be <MIN_AGE> or older to join. you give your birthday when you sign up. your page shows your age and star sign, and you can hide both.
- real people moderate it. you can report any post, comment, message or profile, and block anyone. there is no automatic filter, so reports matter.
- you can delete your account in Settings, any time. it deletes your page, posts, messages and follows.
- the app opens even with no signal, but your friends' posts need a connection.

the rules are short: be nice, no sexual content, no spam, no pretending to be someone else, no posting other people's private information. read them any time under "house rules & privacy".

questions or problems: <support-email>
```

### Google Play

| Field | Limit | Text |
|---|---|---|
| App name | 30 | `OurSpace: retro social` |
| Short description | 80 | `a retro social network: your own page, a top 8, blogs, boards and live chat.` |
| Category | | Social |
| Tags | up to 5 | pick from Play's list in the console (Social, Social networking and the like); the list changes, so check it |
| Contact email | | `<support-email>` |
| Website | | `<origin>` |
| Privacy policy | | `<origin>/privacy` |
| Account deletion URL | | **a gap.** Play wants a web page that says how to delete. `<origin>/settings` needs a login, and the rules page only says "Settings". Add a short public section on how to delete an account (and what is kept) before filling this in |
| Feature graphic | | 1024 x 500, JPEG or 24-bit PNG, no alpha. **Not made yet** (only `mobile/store/play-icon-512.png` exists) |

**Full description (4000 max):** use the Apple description above unchanged. Play shows it as plain text, so the dashes
are fine. Delete the "what you get" heading if you want it shorter.

---

## 2. Apple App Privacy answers

Source of truth for the data types: `mobile/ios/App/App/PrivacyInfo.xcprivacy`, with the reasoning in
[store.md](store.md#the-ios-privacy-manifest). Everything below was re-read from the code on 2026-11-07. **Tracking: No.**
**Third-party advertising: No. Data used to track you: none.** Every type below is **linked to the user** and used for
**App Functionality** only. (Apple counts fraud prevention and security as App Functionality.)

| Apple data type | Collected? | Evidence |
|---|---|---|
| Contact Info: Email Address | Yes | `src/accounts/auth.js:134` (`INSERT INTO users`, column `email`); `migrations/0001_init.sql:7`. A provider sign-in with no email stores none |
| Contact Info: Name | **Judgment call.** The manifest says No: a screen name is a User ID. A member can type their real name, but nothing asks for one | `src/accounts/auth.js:134` (`name` is the screen name). Apple's wording for Name is "first or last name"; the owner decides |
| Identifiers: User ID | Yes | `users.id` / `users.name`; `sessions` (`migrations/0001_init.sql:7`, `:36`) |
| Identifiers: Device ID | Yes | the device label (`Device.getInfo().name`) and, when the phone gives one, the push token: `public/js/core/native.js:502-505`, stored at `src/push/devices.js:39`. Also the salted hash of the sign-up network and browser: `src/trust/signup.js:57`, `migrations/0009_trust.sql` (`ip_group_hash`, `ua_hash`, 90 days) |
| User Content: Photos or Videos | Yes | `src/media/media.js:71` (`uploadMedia`), `:99` (`INSERT INTO media`). Location data is stripped from the file (`src/media/strip.js:1-14`) |
| User Content: Emails or Text Messages | Yes | `src/chats/chats.js:154`, `src/chats/ourspace.js:51`. A push carries no message text (`src/push/push.js:8-16`, `:147`) |
| User Content: Other User Content | Yes | statuses, comments, board threads, blog entries, profile text: `src/social/items.js:210`, `src/profiles/profiles.js`. Likes, votes, follows, bookmarks, blocks and reports are stored too (`src/social/interactions.js`, `src/follows/follows.js`, `src/safety/safety.js:102`). `store.md` does not name them. They fit here, so say so when asked. A connected Spotify account's top tracks are stored and shown on the page (`src/music/spotify.js:35`); same bucket |
| Location: Coarse Location | Yes, but only the country (and network name) Cloudflare derives from the address at sign-up. The app never reads device location | `src/trust/signup.js:57` (`country`, `asn`, `as_org`); `migrations/0009_trust.sql`; no location permission in `AndroidManifest.xml:63-68` or `Info.plist:40-43` |
| Sensitive Info | No | |
| Other Data Types | Yes | the birthdate (`users.birthdate`, `src/accounts/auth.js:134`); the sign-up risk score and reason codes (`signup_signals.risk`); AI-writing scan scores (`ai_scans`, `migrations/0009_trust.sql`) |
| Contacts, Financial Info, Health and Fitness, Browsing History, Search History, Purchases | No | no address-book read; nothing sold; no search is stored |
| Usage Data: Product Interaction | No | no analytics SDK or event log in `public/`, `mobile/` or `src/` |
| Diagnostics: Crash Data, Performance Data | No in the app. **Open:** Cloudflare Workers logging is on (`wrangler.jsonc:21`, `"observability": { "enabled": true }`), which keeps request logs on Cloudflare's side. The owner decides whether Apple's definition of diagnostics covers that. The code writes only error messages to the log (`console.error`) |

**Things the form asks that need a sentence of honesty:**

- **Third parties that receive data from the app's web view or the Worker:** Cloudflare (hosts the Worker; Turnstile
  receives the visitor's address and browser signals, `src/trust/turnstile.js:11`, `:41`, and the page loads
  `https://challenges.cloudflare.com`, `public/_headers:4`); Resend (receives the email address and the message,
  `src/shared/mail.js:14`); Apple and Google (receive the push token and a push that holds the sender's screen name,
  `src/push/apns.js:28`, `src/push/fcm.js:44`); Google and Discord when a member signs in with them
  (`src/accounts/oauth.js:30`, `:36`; they receive nothing from us beyond the redirect); Spotify's image CDN when a page
  shows songs (`public/_headers:4`, `i.scdn.co`), and Apple's CDN when a member presses play on a preview.
- **If `AI_DETECTOR` is switched on** (default `off`), public post text goes to Cloudflare Workers AI, Pangram or GPTZero
  (`src/ai/detect.js:76`, `:92`, `:107`). The answers above then change: those posts are shared with a third party.
- **Retention:** on account deletion the server removes the rows listed at `src/accounts/auth.js:425-452`. Kept on purpose:
  copies of reported text in `reports.snapshot` (`src/safety/safety.js:55-62`), and photos a moderator hid as evidence
  (`docs/operations.md`, "Photos"). Rate-limit rows (hashed address, and the typed login name on a failed login,
  `src/accounts/auth.js:269-270`) are cleared after 2 days (`src/index.js:291`). Sign-up signals and AI scores go after
  90 days (`src/trust/clusters.js:95`).

---

## 3. Google Play Data safety answers

Same facts, in Play's categories. Play counts as "shared" only a transfer to a third party that is not a service
provider acting for you, and not one the user starts. Cloudflare, Resend, and Apple/Google push are service providers
here, so the answer below is **not shared**. That reading of Play's definitions is the owner's call.

| Section | Answer |
|---|---|
| Does the app collect or share user data? | Yes, collects. Shares: **No** (see the reading above) |
| Is all data encrypted in transit? | Yes. The Worker is https only, and chat uses `wss:` (`public/_headers:4`; `connect-src 'self' wss:`); a release build refuses a non-https origin (`mobile/android/app/build.gradle`, `check:release`) |
| Can users request deletion? | Yes. In the app: Settings, "Delete my account" (`public/js/pages/settings.js:128-139`, `DELETE /api/me` at `src/index.js:89`). Web URL: see section 1, it is a gap |
| Independent security review | No |
| Families policy | No. The app is not for children |

| Play category | Collected | Required or optional | Purpose | Evidence |
|---|---|---|---|---|
| Personal info: Email address | Yes | Optional (a provider sign-in may have none) | Account management | `src/accounts/auth.js:134` |
| Personal info: Name | Same judgment call as Apple | | | |
| Personal info: User IDs | Yes | Required | App functionality, account management | `migrations/0001_init.sql:7` |
| Personal info: Other info (date of birth) | Yes | Required | App functionality (age check, star sign) | `src/accounts/auth.js:98-110`, `:134` |
| Messages: Other in-app messages | Yes | Optional | App functionality | `src/chats/chats.js:154` |
| Photos and videos: Photos | Yes | Optional | App functionality | `src/media/media.js:71`, `:99` |
| App activity: Other user-generated content | Yes (posts, comments, threads, blog, likes, follows, connected-song list) | Optional | App functionality | `src/social/items.js:210`, `src/music/spotify.js:35` |
| App activity: App interactions | No | | | no analytics |
| Location: Approximate location | Yes (country from the sign-up request) | Required (it is derived, not asked) | Fraud prevention, security and compliance | `src/trust/signup.js:57` |
| Device or other IDs | Yes (push token, device label, hashed network and browser) | Required for the hash, optional for the token | App functionality, fraud prevention | `src/push/devices.js:39`, `src/trust/signup.js:57` |
| App info and performance | No in the app. Same open Cloudflare logging question as Apple | | | `wrangler.jsonc:21` |
| Audio, Files and docs, Calendar, Contacts, Health and fitness, Financial info, Web browsing | No | | | |

Permissions the Play form and review will see: `INTERNET`, `CAMERA` (not required hardware) and `POST_NOTIFICATIONS` are ours. The built app also has `VIBRATE` and `ACCESS_NETWORK_STATE`, plus `WAKE_LOCK` and `com.google.android.c2dm.permission.RECEIVE` from the push plugin (read from the release APK, 2026-11-07)
(`AndroidManifest.xml:63-68`). No location, microphone or storage permission.

---

## 4. Age ratings

### What the app is, for the questionnaires

- Members post text and photos that anyone (or any follower) can read, in statuses, comments, board threads and blogs
  (`src/social/items.js`, `src/boards/boards.js`).
- Members message each other: DMs, groups of 2 to 50, and the open #ourspace room (`src/chats/`). Who may DM defaults to
  **everyone** (`migrations/0001_init.sql:17`; `src/chats/chats.js:88-94`). There is no rule that stops an adult messaging
  a 13 to 17 year old.
- Browse and who-to-follow keep adults and under-18s apart (`src/browse/browse.js:68-73`). Boards, profiles, #ourspace,
  tag pages and DMs are not split by age (`docs/architecture.md`, "Ages").
- The rules ban sexual content (`public/js/pages/rules.js`), but **nothing scans text for it**. Only photos are looked at,
  by a person, in the Photos queue (`docs/deploy.md`, CSAM section). `src/ai/` is the AI-writing detector, default off.
- Reports have ten reasons, including `sexual`, `csam`, `self_harm`, `underage` (`src/catalog/options.js:66-77`). A
  moderator acts on them. The 48-hour clock is on screen (`src/safety/safety.js:10`).
- The age gate is a **self-declared birthday** checked against `MIN_AGE` (`src/accounts/auth.js:96-110`). Nobody checks it.
- There are no ads, purchases, gambling, web browser, or location sharing. Outside links open in the system browser (D14).

### Apple's questionnaire (13+, 16+ and 18+, plus 4+ and 9+)

Apple changed the ratings and added required questions ([notice](https://developer.apple.com/news/?id=ks775ehf)). From the
console as I remember it; check each wording. "Frequency" answers are None, Infrequent, or Frequent.

| Question | Honest answer | Why |
|---|---|---|
| Parental controls | No | none in the app |
| Age assurance (verifying a user's age) | No | the birthday is typed in, not checked. Say so in review if asked |
| Unrestricted web access | No | no browser in the app; links leave to Safari View Controller / a Custom Tab (D14) |
| User-generated content | **Yes** | everything above. This is the question that moves the rating most |
| Messaging and chat | **Yes** | DMs, groups, #ourspace |
| Advertising | No | none |
| Medical or treatment information; health or wellness topics | No | astrology is not a health topic, and the horoscope says it is for fun |
| Profanity or crude humor | Infrequent | not filtered. Members can write anything the rules do not catch. The conservative answer for an unfiltered UGC app |
| Horror or fear themes | Infrequent | same |
| Alcohol, tobacco or drug references | Infrequent | same |
| Mature or suggestive themes | Infrequent | the rules ban sexual content, but nothing blocks it |
| Sexual content or nudity | None built in | the app has none of its own. UGC risk is carried by the UGC question. The owner may prefer Infrequent |
| Graphic sexual content | None | |
| Cartoon or fantasy violence | None | |
| Realistic violence; prolonged graphic violence; guns or weapons | Infrequent | threats are a report reason, and posts are unfiltered |
| Simulated gambling; contests; gambling | None | |

**What changes with `MIN_AGE`.** Apple lets a developer pick a rating higher than Apple computes, and the age the app is
offered at must not be below the minimum age the server enforces. Apple's computed result is not something I can
reproduce, so the "likely" column is a reading, not a promise.

| `MIN_AGE` | Lowest rating consistent with the server | Likely computed from the answers above | What also changes |
|---|---|---|---|
| 13 | 13+ | 13+ at the least; with UGC and chat both Yes and no filter, 16+ or 18+ is plausible. Apple's form shows the result before you save | 13 to 17 year olds are inside the app, so the missing adult/teen split in DMs and boards matters most here (see section 6). Play target age groups: 13-15, 16-17, 18+ |
| 16 | 16+ | 16+ at the least; 18+ plausible | Set the rating to 16+ or higher by hand if the form gives less. Play groups: 16-17, 18+. `check:release` and the server need `MIN_AGE=16` in `wrangler.jsonc:31` and `docs/deploy.md` says the same |
| 18 | 18+ | 18+ | No minors on the site. Browse's adult/teen split becomes moot. Play: 18+ only. The age-gate answer is simpler, since the app is adults only; the self-declared birthday is still the only check |

Whatever the choice: the rules page says "You have to be `S.minAge` or older" and fills the number from the server
(`public/js/pages/rules.js:14`), so it follows `MIN_AGE` by itself. `docs/mobile/checklist.md` item 14 names 13 and must be
read as `MIN_AGE`. Checklist item 14 is the test: sign up under the age, expect a refusal, and compare with the rating set.

### Google Play content rating (IARC questionnaire)

Choose the category **Social, communication or user generated content**, as I remember it; check the live wording.

| Question | Honest answer | Why |
|---|---|---|
| Violence, blood, sexual content, language, controlled substances, crude humor in the app itself | No | the app ships none; it is user content |
| Can users interact or exchange content with each other? | **Yes** | feed, boards, chat, DMs |
| Does the app share user-provided content publicly? | Yes | open pages, boards, #ourspace |
| Does it share the user's location with others? | No | no location is read |
| Does it allow users to buy digital goods, or have gambling? | No | |
| Does it give unrestricted internet access / a web browser? | No | |
| Is user content moderated? (if asked) | Yes, by people. No automatic filter | section 6 |

IARC computes the result; I cannot say what it will be. Play also asks for **Target audience and content**: pick the age
groups from the table above (13-15, 16-17, 18+ for `MIN_AGE` 13). Do not pick any group under 13, which also keeps the
app out of Play's Families policy. The groups chosen must agree with `MIN_AGE`.

Whether the app needs age-assurance work under any law is **not decided here**: it is a legal-review question
(`docs/roadmap.md`, "Terms of service"; [launch.md](../launch.md), iOS).

---

## 5. Screenshots

Sizes are from Apple's and Google's help pages read on 2026-11-07. Verify them in the console on the day.

### Apple

[Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications):
1 to 10 per size, JPEG or PNG, **no alpha**. Sizes seen there for iPhone, portrait:

- large Dynamic Island (6.9 inch class): 1260 x 2736, 1290 x 2796 or 1320 x 2868
- medium Dynamic Island (6.3 and 6.1 inch class): 1179 x 2556 or 1206 x 2622
- older sizes (6.5 inch 1284 x 2778 or 1242 x 2688, 5.5 inch 1242 x 2208 and so on) are accepted but no longer needed
  if the larger ones are supplied; the page says App Store Connect scales from the next larger one

The page's wording on which iPhone size is the required one was unclear to me. Read the console, and supply the
largest size, which it can scale down.

**iPad: decide now.** The Xcode project targets iPhone **and** iPad (`TARGETED_DEVICE_FAMILY = "1,2"` in
`mobile/ios/App/App.xcodeproj/project.pbxproj:391`, `:411`). If it ships that way, Apple requires 13 inch iPad
screenshots, 2064 x 2752 or 2048 x 2732. `review-notes.md` says to submit iPhone-only until there is an iPad layout, but
nothing in the project does that yet. To go iPhone-only, set `TARGETED_DEVICE_FAMILY = 1` (a code change, and it has to
be done on a Mac or by Claude with CI to check).

Screenshots must show the real app. Take them from the simulator or a real iPhone, not from the website in a browser. The
app has never launched anywhere, so none can exist yet.

### Google Play

[Preview assets](https://support.google.com/googleplay/android-developer/answer/9866151):

- app icon: 512 x 512, 32-bit PNG, up to 1024 KB (`mobile/store/play-icon-512.png`)
- feature graphic: 1024 x 500, JPEG or 24-bit PNG, no alpha. **To make**
- phone screenshots: JPEG or 24-bit PNG, each side 320 to 3840 px, the long side no more than twice the short side; at
  least 2 and up to 8. For better placement, 4 or more at 1080 px minimum, 9:16
- tablet screenshots: optional (the page lists 7 and 10 inch types; check the console)

The Android emulator (Android 17 image) works for these today.

### Which demo-seed routes make good shots

Run `npm run demo` (sample people, all adults, `tools/demo.mjs:98-153`), signed in as `the_reviewer`. The demo seeds
a profile, feed, blog entries, boards, chats and sample photos, and `tools/plates.mjs:77-113` shows how each route is
picked. Eight good shots, in the order I would show them:

1. `/` signed in, the feed (a busy status with photos). Shows what the app is.
2. `/u/xX_glitterkat_Xx`, the most dressed-up page (theme, top 8, songs if the demo seeds them: leave songs out of the
   listing text, but the page can show them). The retro look is the selling point.
3. `/boards` then a busy board, `/boards/<slug>` (`plates.mjs:102-103`).
4. `/messages/<id>` a group chat (`plates.mjs:98`), so chat is shown.
5. `/ourspace`, the open chat room. Its demo plate is the least stable (`checklist.md`, "cannot see"), so take it by
   hand.
6. `/browse`, for discovery.
7. `/u/malten/blog` a blog entry (`plates.mjs:85-86`).
8. `/horoscope/<sign>` (`plates.mjs:107`).
9. `/join` signed out, with the "use a photo of my own" camera button (D24, `public/js/core/joinphoto.js`). Only the app
   has this button, and it is the Guideline 4.2 point.

Keep out of shots: `/settings` and `/edit` (form screens, dull), `/admin` (moderator view, shows other people's reports),
`/verify`, `/reset`, anything with the demo account's password on screen. The demo members' names are invented; no real
person's data is in them.

---

## 6. Where the code and the docs disagree

Quoted, not resolved. Each needs the owner (or a code change) to settle.

1. **Push payload.** `store.md` (before this change) and a comment in `PrivacyInfo.xcprivacy` say the first 140
   characters of a message go in the push. The code says the opposite, with a test: `src/push/push.js:8-16` ("a push never
   carries what a member wrote") and `:147`. `store.md` is corrected. The comment in `PrivacyInfo.xcprivacy` is not (it is
   not a doc), and it has since been corrected.
2. **"A filter for objectionable content."** `store.md` named `src/ai/` as the filter. `src/ai/` detects AI-written text
   and is off by default. No other filter exists. Apple 1.2 asks for one, so the review answer has to be "moderation is
   by people". `store.md` is corrected.
3. **The privacy summary is shorter than the code.** `public/js/pages/rules.js:30-34` says "A salted hash of your IP
   address, used only to stop spam (rate limits)", "No ads, no tracking scripts" and lists what is kept. The code also
   keeps the network hash for 90 days for held-account review and cluster checks (`src/trust/signup.js:57`,
   `src/trust/clusters.js:34`), the country and network name, a hashed browser string, the device label and push token,
   AI scan scores, and a sign-up risk score. It also loads Cloudflare's Turnstile script and sends the address to Cloudflare
   and the email to Resend. None of that is on the rules page. The stores' forms are built from the code, so the page
   and the forms will not match until the page is rewritten. That is a legal-review item.
4. **Review notes say the wrong place for Settings.** `review-notes.md` item 8 says deletion is "three taps from the tab
   bar". Settings is not a tab: it is a button in the header (`public/js/core/chrome.js:44`), one tap from the feed. The
   delete button, then the confirm dialog, make three, and the panel is at the bottom of the page. Fix the wording.
5. **iPad.** `review-notes.md` implies an iPhone-only submission; the project is universal (section 5).
6. **The adult and teen split.** `docs/architecture.md` says Browse never puts an adult and a 13 to 17 year old in front of
   each other. DMs, boards, #ourspace and profiles are not split, and DMs default to everyone. At `MIN_AGE` 13 this is the
   thing a rating reviewer, and a legal reviewer, will ask about. No doc says the owner decided it.
7. **`docs/decisions/007-mobile-apps.md`** still says a social app "usually rates 17+ on the App Store". Apple no longer
   has 17+.
8. **`docs/deploy.md`** names the branch `claude/intelligent-fermat-keh09f` as the one to merge, and PR #1 on GitHub is a
   different, draft branch titled "do not merge". See [launch.md](../launch.md).
