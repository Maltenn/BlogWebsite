# Red team: the mobile apps

An adversarial pass over the iOS/Android shells, the token session, CORS, push and the plate harness, as built on
branch `claude/intelligent-fermat-keh09f`. Nothing in `src/`, `public/`, `mobile/`, `migrations/`, `tools/` or
`.github/` was changed to write this. Ranked by real severity.

Every finding is labelled **CONFIRMED** (an exact code path, a file that exists or does not, or a command that ran)
or **PLAUSIBLE** (reasoned from the code but needing a device, a store upload or a live engine to settle). The
attacks that were tried and **failed** are listed at the end, because that is the half of a red team that tells you
where not to spend time.

---

## R1 — `ourspace://auth?token=` is accepted from anywhere. CONFIRMED

`public/js/core/native.js:350-375` (`onAppUrl`), `:592` (`app.addListener('appUrlOpen', …)`),
`:306-318` (`webAuth`), `mobile/android/app/src/main/AndroidManifest.xml:28-34`,
`mobile/ios/App/App/Info.plist` (`CFBundleURLTypes` → `ourspace`), `src/accounts/oauth.js:179-183`.

`onAppUrl` takes *any* `ourspace://auth?token=…` that reaches the app and calls `saveToken(t)`. There is no nonce, no
check that a sign-in is in progress, and no confirmation. `waitingForAuth` is consulted (`:355`) only to close the
Custom Tab — it is not required.

Two directions, both real:

**(a) Injection — both platforms.** Any installed app (`UIApplication.open` / `startActivity`), or a web page the
user taps a link on, fires `ourspace://auth?token=<the attacker's own session token>`. The victim's Keychain entry is
overwritten, `loadMe()` runs, `signedIn(true)` fires, and `registerDevice(true)` posts the victim's **push token and
device label** (`info.name` — usually "Marco's iPhone") into the attacker's account. The victim is now reading and
writing inside an account the attacker controls: every post, photo and DM they send next is the attacker's to read,
and the attacker's profile is whatever they want the victim to believe they are looking at. Passing a garbage token
instead is a silent permanent sign-out.

**(b) Theft — Android only, account takeover.** On Android `webAuth` opens a Custom Tab and takes the return through
the **public** `ourspace://` intent filter (`exported="true"`, `BROWSABLE`). A co-installed app that declares the same
scheme is offered `ourspace://auth?token=<the victim's raw 90-day session token>`. iOS is safe from this one because
`ASWebAuthenticationSession(url:callbackURLScheme:)` claims its own callback. There is no safe alternative in place:
D18/D19 are placeholders, so verified App Links do not work.

**Smallest fix.** In `startProviderSignIn` mint a random nonce, carry it through `/start` → the `oauth_states` row →
`ourspace://auth?token=…&n=<nonce>`, and in `onAppUrl` accept `auth` and `join` only when a flow is pending and the
nonce matches; drop the URL silently otherwise. That closes (a) outright and reduces (b) to "the attacker must also
guess the nonce". Closing (b) properly needs the OAuth return on an https App Link, i.e. D19.

---

## R2 — `webContentsDebuggingEnabled: true` ships in the release build. CONFIRMED

`mobile/capacitor.config.json`, `android` block (also copied into
`mobile/android/app/src/main/assets/capacitor.config.json`).

Capacitor passes this straight to `WebView.setWebContentsDebuggingEnabled`, with no build-type condition. Anyone with
adb access to the phone opens `chrome://inspect`, evaluates JS in the production app's WebView, and reads the
in-memory `token` or calls
`Capacitor.Plugins.SecureStorage.internalGetItem({ prefixedKey: 'ourspace_session', sync: false })` directly. The
whole "the token is in the Keystore, never in localStorage, because a WebView XSS can read that"
(`native.js:7`) argument is void while this is on. Play's pre-launch report and any pentest flag it.

**Fix.** Delete the key. Capacitor already enables debugging for debug builds only.

---

## R3 — the CI release path never runs `check:release`, so a store build can ship pointing at `localhost`. CONFIRMED

`.github/workflows/mobile.yml:73` (the `bridge` job runs `npm run check`, which only *notes*),
`mobile/scripts/check.mjs:63,92` (every placeholder goes to `notes` unless `--release`),
`mobile/scripts/config.cjs:15` (`process.env.OURSPACE_ORIGIN || file.origin`),
`mobile/ourspace.config.json` (`"origin": "http://localhost:8787"`).

The `android` and `ios` jobs run `npx cap sync` + archive + sign + upload and **never** run
`npm run check:release`. `env.OURSPACE_ORIGIN: ${{ vars.OURSPACE_ORIGIN }}` becomes the empty string when the
repository variable is unset, which `||` (and Groovy's `?:` in `build.gradle`) treats as absent.

Tag `mobile-v1.0.0` with the signing secrets set and `OURSPACE_ORIGIN` unset and CI happily uploads to TestFlight an
IPA whose `native-config.json` says `http://localhost:8787`, whose generated `App.entitlements` has no
`associated-domains` (`after-copy.mjs:38`), whose App Links host is `ourspace.invalid` (`build.gradle`), and whose
bundle id is the unregistered `com.ourspace.app`. On a device every API call fails; the app is a blank shell. The
guard that would have caught all of it exists and is simply not wired in.

**Fix.** Add `npm run check:release --prefix mobile` as the first step of each signed step (`if: env.RELEASE ==
'true'`), and make `RELEASE` require `vars.OURSPACE_ORIGIN != ''`.

---

## R4 — no `PrivacyInfo.xcprivacy` in the app target: the upload is rejected. CONFIRMED

`find mobile -iname '*xcprivacy*' -not -path '*/node_modules/*'` → 0 files. Of the installed pods, only
`@capacitor/ios` ships one; `@capacitor/device`, `/camera`, `/push-notifications`, `/share`, `/haptics`, `/network`,
`/app`, `/browser`, `/action-sheet` and `@aparajita/capacitor-secure-storage` ship none.

Apple's required-reason-API declarations are mandatory. `@capacitor/device` reads device and disk information,
Capacitor core uses `NSUserDefaults`, and file timestamps are read in several places. App Store Connect answers
ITMS-91053 "Missing API declaration" on upload. `docs/mobile/store.md` lists the manifest as "not written"; it is not
a to-do, it is a hard upload blocker — and it will be hit *before* any 4.2 argument is ever made.

**Fix.** One file in the App target: `NSPrivacyTracking: false`, empty `NSPrivacyTrackingDomains`, and
`NSPrivacyAccessedAPITypes` for `UserDefaults` (`CA92.1`), `FileTimestamp` (`C617.1`) and `DiskSpace` (`E174.1`).

---

## R5 — every DM's text goes to Apple and Google in the push payload. CONFIRMED

`src/push/push.js:58-70` — `title: kind === 'dm' ? from.name : …`, `body: clip(body, 140) ?? body`. Called from
`src/chats/chats.js:169-170`.

The first 140 characters of every direct message, with the sender's screen name and the conversation id, travel
through APNs and FCM in a form Apple and Google can read. That is an ordinary product choice — most messengers do
it — but it is in **none** of `contract.md`, `deviations.md`, `server.md` or `store.md`, and both the Play
Data-safety form and Apple's privacy questionnaire have to declare it. The outbox adds a second disclosure:
`migrations/0010_devices.sql:156` sends `kind: 'ai_strike'` with the body "a note about your writing", which tells
Apple and Google which members are under moderation.

**Fix (cheapest).** Write it down in the deviation register and the two store forms. **Fix (properly).** Send
`kind` + `url` only, with APNs `mutable-content` and a notification-service extension that fetches the text with the
device's own token.

---

## R6 — the outbox trigger reproduces insert-time filtering, not read-time filtering. CONFIRMED

`migrations/0010_devices.sql:136-182` against `src/shared/notify.js:31-43` (`SHOWN`).

The attack the brief expected does **not** work. I checked every site that writes a notification row —
`src/shared/notify.js:17`, `src/ai/scan.js:70`, `src/ai/strikes.js:95`, `src/boards/requests.js:80`,
`src/chats/chats.js:224`, `src/chats/ourspace.js:52` — and all of them apply `NOT_BLOCKED`, and `notify()` applies
`SEES_POST` as well. So someone who blocked you, or whose post you may not see, cannot get a row written in the first
place, and the trigger cannot manufacture one.

What `SHOWN` adds and the trigger cannot is everything that changes *after* the row is written: `p.hidden` /
`p.deleted`, `x.banned`, a block made later, a group invite declined, an `#ourspace` message deleted, and
`REACHABLE` for board comments. The cron is `* * * * *`, so the window is up to 60 seconds: A likes B's post, B
blocks A eight seconds later, B's phone still buzzes with "A liked your post". Same for a moderator hiding a post
twenty seconds after a reply to it.

**Fix.** Give `push_outbox` a `notification_id` and make the `drainPush` claim (`src/push/push.js:44`) join `SHOWN`,
so a line whose notification no longer shows is dropped instead of sent.

---

## R7 — a device session has no absolute lifetime. CONFIRMED

`src/accounts/auth.js:164-170`.

`s.created` is read only to tell a device session from a web one. Every bearer request (at most hourly) pushes
`expires` to `now + 90 days`. Nothing caps the total. A token stolen once — by R1(b), R2, a forensic image, or an
unencrypted backup — works forever unless the member notices and acts.

The revocation side is sound, and immediate: `src/push/devices.js:52-62` deletes the session row and calls
`signOut`, `src/accounts/auth.js:259-265` (logout), `:301-309` (reset: all sessions), `:319-324` (change: all other
sessions), `:409` (delete account) all delete session rows, and `devices.token_hash` cascades
(`migrations/0010_devices.sql:104`). The next API call 401s and `afterApi` (`native.js:173`) drops the local token.
The offline `/api/me` cache cannot mask it: `cachedMe` is only reached on a thrown network error (`:126-129`), not on
a 401.

**Fix.** `u.expires = Math.min(c.now + DEVICE_DAYS * 86400000, session_created + MAX_SESSION_MS)`.

---

## R8 — the bearer token is readable off every chat socket as `ws.protocol`. CONFIRMED (code); PLAUSIBLE (logging)

`public/js/core/native.js:164`, `src/shared/app.js:17-24`, `src/live/room.js:115-116`.

`contract.md:150` rejected a query-string token because "a token in a query string ends up in logs", and then put it
in `Sec-WebSocket-Protocol` — a request header that Cloudflare Logpush *can* be configured to log, that is forwarded
to the Durable Object intact, and that the room **echoes back** in the 101 (`room.js:115-116`, spec-required).

The part that matters is nearer than any log: after the handshake, the raw session token is the value of
`socket.protocol` on a live `WebSocket` object in the page. Any script injection anywhere in the bundle reads the
token with no plugin call and no storage access — which is exactly the threat the Keychain was chosen to defend
against.

The room's authorisation is **not** bypassable. `src/chats/live.js:84-91` validates membership in the Worker before
the upgrade, `src/shared/live.js:8` derives the DO id from the already-validated integer, and `connect()` uses
`headers.set('X-Live-User', …)` (`live.js:67`), so a client-supplied `X-Live-User` cannot survive. A valid token for
room A gets you nothing in room B.

**Fix.** Keep the subprotocol, change what rides in it: `POST /api/live/ticket` → a hashed, single-use, 30-second
ticket scoped to one room, sent as `ourspace.ticket.<t>`.

**FIXED 2026-11-05.** `POST /api/live/ticket` mints a ticket for one room, stored as its SHA-256, claimed (deleted,
`meta.changes === 1`) before anything is handed out, and good for 30 seconds
(`migrations/0013_live_tickets.sql`, `src/shared/live.js`, `src/chats/live.js`). The handshake carries it as
`ourspace.bearer.<ticket>` — the prefix the contract already named, so the wire shape is unchanged — and the session
token is no longer a handshake credential at all (`src/shared/app.js`: `bearerToken` no longer reads
`Sec-WebSocket-Protocol`, so an old app build offering a token gets a 401 and falls back to polling).
**And the echo is gone too, which the fix above did not ask for:** the client offers the fixed name `ourspace.live`
beside the ticket and the room selects *that* one, so `socket.protocol` is the constant string `ourspace.live` on
every platform and holds no secret even before the ticket is spent. A ticket is still the floor under that: read off
the socket it buys one room its holder is already in, once, for half a minute. `docs/mobile/contract.md` §7 is
rewritten; R2 remains the thing that makes all of this moot on a debuggable release build.

---

## R9 — `sitePath()`'s origin guard leans on `location.origin`, which is `"null"` for an opaque origin. PLAUSIBLE

`public/js/core/native.js:56-64`.

Probe (`…/scratchpad/probe.mjs`, replicating the function exactly) with `location = capacitor://localhost/u/kat`:

```
sitePath("javascript:alert(1)")            -> "alert(1)"
sitePath("data:text/html,<script>1</script>") -> "text/html,<script>1</script>"
isApi("//evil.com/api/me")                 -> true   (capacitor://evil.com/api/me)
```

`capacitor:` is not a special scheme, so its URLs have an opaque origin and `origin` serialises to the string
`"null"`. `u.origin !== location.origin` then compares `"null"` with `"null"` and passes for **every** opaque-origin
URL. The same note is already in the repo: `mobile/scripts/config.cjs:30` says "WebKit does not always match `'self'`
for `capacitor://`", which is the same fact about the same origin.

Marked PLAUSIBLE because I cannot verify from here what WKWebView reports for `document.location.origin` on a
`WKURLSchemeHandler` scheme. One line in the app settles it:
`console.log(location.origin, new URL('//evil.com/api/x', location.href).origin)`.

**Today the consequence is benign**, which is why this is rank 9 and not rank 1: `openPage` feeds only
`pathname + search + hash` to `go()` / `history.replaceState`, so `javascript:alert(1)` becomes the relative path
`alert(1)` — a broken navigation, not script execution. And `isApi` being true for `//evil.com/api/me` leaks nothing,
because the wrapper always rebuilds the target as `origin + u.pathname + u.search` (`:120`, `:142`). But the guard
the contract claims ("Only OUR origin or a relative path") is not the guard that is written, and it is one refactor
away from being an XSS.

**Fix (one line).** `if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;` before the origin test.

**The test gap underneath it.** `mobile/test/bridge.test.mjs:73,112` serves the page from
`http://127.0.0.1:<port>` and runs in **Chromium only** (`.github/workflows/mobile.yml:68`), while faking
`getPlatform() === 'ios'`. All 14 bridge tests therefore assert the *Android* origin shape in the *Android* engine.
The combination that actually ships on iOS — WebKit, `capacitor://localhost`, an opaque origin — is covered by no
test, and the 464 plates do not exercise `native.js` at all (`isApp === false` in every one).

---

## R10 — CORP `cross-origin` on avatars makes every avatar ever uploaded world-embeddable, forever. CONFIRMED

`src/media/media.js:151` (`if (m.purpose === 'avatar') return 'public';`), `:181` (the CORP flip), `:287`
(`sweepMedia` excludes `purpose = 'avatar'`).

An avatar is classified public before any block check, without checking that it is still the member's current
avatar, and regardless of whether the profile is private. Replacing your avatar leaves the old row and its R2 object
in place — the orphan sweep explicitly skips avatars — so every avatar a member has ever used stays fetchable and,
now, embeddable by any website in the world.

Low, because an avatar is already shown to anonymous visitors on the profile page. The fetchability is pre-existing;
only the embeddability is new.

**The paths the brief named came back clean**, and that is worth recording so nobody re-audits them:

- `p_hidden`, `p_deleted`, `a_banned` and `p_created > now` all force a 404 with `same-origin` (`:152`).
- A board *comment*'s photo is never `public` — it goes through `COMMENT_SHOWN` and returns `private` (`:154-157`).
- A board thread's photo stays `public` on an archived board, but archived boards still display their threads
  read-only (`src/boards/boards.js:133,241-248`), so that is consistent.
- The five-minute window on a privacy flip is documented (`:119-121`) and the 304 path only revalidates while the
  photo is still public (`:182`).
- **One latent hole.** `notify()` and `SHOWN` both evaluate visibility against `o = COALESCE(p.target_id,
  p.author_id)` — a Friends' Comment's *page owner*. `access()` joins only `p.author_id` (`:173`), so a photo on a
  Friends' Comment written by an open-profile member on a **private** member's page would be classified `public` and
  served to the world. It is unreachable today only because `wall` is not in `MEDIA_LIMITS`
  (`src/shared/media.js:12-15`): profile comments cannot carry photos. Adding one line to that table opens it.
  `access()` should carry a comment saying so, or better, join `p.target_id` now.

---

## R11 — CI: the release path is reachable from any branch, ungated; one secret-handling action is on a mutable tag. CONFIRMED

`.github/workflows/mobile.yml:32-37,51`, `:141-147`, `:163`, `:224-232`.

**The question the brief asked — can a fork PR reach the signing secrets? No.** The trigger is `pull_request`, not
`pull_request_target`, so a fork's run gets no repository secrets at all; `RELEASE` is false for `refs/pull/N/merge`;
`permissions: contents: read`; and the `HAVE_*` job envs expose only booleans. I tried to break this and could not.

What is real:

- `workflow_dispatch` with `release: true` runs on **any ref**, with no `environment:` key and therefore no
  protection rules and no required reviewer. Anyone with write access can sign an arbitrary branch and push it to
  TestFlight.
- `r0adkll/upload-google-play@v1` (`:141`) is a third-party action on a **mutable tag** and receives
  `PLAY_SERVICE_ACCOUNT_JSON` as an input. Moving that tag is a one-step supply-chain compromise of the Play upload
  key.
- The iOS signed step never removes `$RUNNER_TEMP/dist.p12` or `app.mobileprovision`, and never deletes the
  temporary keychain (the Android step does `rm` its keystore, `:131`). Harmless on GitHub-hosted runners, not
  harmless the moment `vars.IOS_RUNNER` points at a self-hosted Mac — and `IOS_RUNNER` is a *variable*, not a secret.
- `GOOGLE_SERVICES_JSON` is written on every same-repo run with no `RELEASE` gate (`:102-106`), and the debug APK
  that embeds it is uploaded as a build artifact. Low: it ships in every release APK anyway.

**Fix.** Move the signed steps into a job with `environment: release`; restrict release to `refs/tags/mobile-v*`; pin
`r0adkll/upload-google-play` to a commit SHA; add an `if: always()` cleanup step with `rm -f` and
`security delete-keychain`.

---

## R12 — push throughput ceiling and duplicate sends. CONFIRMED

`src/push/push.js:14` (`CLAIM = 20`), `:23-31` (`deliver`), `:44-53`.

The cron claims 20 outbox lines a minute for the **whole site** — 28,800 notifications a day, total. Past that,
latency grows until lines age out at 24 hours. And `deliver` returns false if *any* one device answers `retry`, so
the whole line is retried and the devices that already received it are pushed a second time.

Operational, not security. Fix: raise `CLAIM`, and record delivery per device (or accept the duplicate and say so in
`server.md`).

---

## R13 — the reinstall guard fails open, and the Keychain class is looser than it needs to be. PLAUSIBLE

`public/js/core/native.js:93-99`, `:87` (`access: 1`).

The iOS Keychain survives an uninstall, so the whole reinstall defence is the absence of a `localStorage` marker —
and the block is wrapped in `try { … } catch { /* leave things as they are */ }`. If the *read* throws (storage
blocked, quota, a WebView that refuses it), nothing is dropped and the previous installation's token is used by the
next one. The test at `bridge.test.mjs:165` covers the happy path only. Narrow, but the failure mode is the wrong
one: a guard whose whole job is to drop a token should drop it when it cannot tell.

`access: 1` in `@aparajita/capacitor-secure-storage` is the `afterFirstUnlock` class, so the token is readable
whenever the device has been unlocked once since boot. `sync: false` correctly keeps it off iCloud. I did not read
the plugin's enum to confirm the mapping — one line of verification before shipping — but `whenUnlocked` is the right
class for a value only ever read while the app is in the foreground.

---

## R14 — two transport relaxations ship in release. CONFIRMED

`mobile/ios/App/App/Info.plist` — `NSAppTransportSecurity` / `NSAllowsLocalNetworking: true`, unconditional, for the
simulator's convenience. `mobile/capacitor.config.json` — `"allowMixedContent": true` for Android.

Both low. `NSAllowsLocalNetworking` is an Apple-blessed exception that needs no App Review justification. On Android,
the release build ships no `network_security_config` (the debug one is correctly `src/debug/`, `:1-5`), so cleartext
is blocked at the network layer and `allowMixedContent` is largely inert — but it is the setting that would let a
misconfigured `http://` origin silently work, which is how R3 becomes invisible.

---

## Guideline 4.2: the reviewer's case, and the cheapest way to beat it

> **Addendum, added after this pass.** Items 1-4 of "what most cheaply defeats it" below have since been built, and
> the register rows they argue against have been rewritten: the tab bar is native on both platforms (`D3`, `D22`,
> `D23`) and its metrics are *measured* off the live `.ms-tabs` rather than guessed, with `npm run tabbar:check`
> holding a bar rebuilt from that measurement to 0 pixels in both engines; the placeholder icon is replaced with a
> drawn mark (`D11`); the camera sheet is two taps from a cold launch (`D24`); and `docs/mobile/review-notes.md` is
> the reviewer-facing list. The paragraphs below are left as they were written — they are the reason those things
> exist, and the ranking in the last line of this section still holds: **4.2 is not the most likely rejection**.
> The one claim this pass made that is still true as written is the one about `store.md`'s feature list; it has been
> gone through and now says what is built and nothing else.

**The case for rejection, from what is implemented rather than promised.**

The app is a local copy of a website with no native interface of any kind. D3 records this in the register's own
words: there is **no native tab bar**, and the reason given is that `.ms-tabs` could not be matched by eye. So the
navigation a reviewer touches first is a horizontally scrolling row of 12px web buttons inside a WebView. There is no
`UITabBarController`, no `UINavigationController`, no native list, no pull-to-refresh, no native anything the
reviewer can see without being told where to look. D13 is the app admitting it: `location.href` is
`capacitor://localhost/…`, "which is nobody's address", and anything copied has to be rewritten into the website's
URL. D14 sends every outbound link to Safari View Controller. The footer links to `/assets/CREDITS.md`. The page
renders in Arial because `app.css` asks for MS Sans Serif (D4). A reviewer opening this on an iPad — and they will,
because `UISupportedInterfaceOrientations~ipad` lists all four orientations — gets the 768–1280px *desktop web*
layout with no adaptation at all. The native features that do exist (camera, share sheet, haptics, push) are all
behind a tap the reviewer has no reason to make, and the one the register leans on hardest, D12's photo picker, only
appears after signing up, confirming an email and finding a composer.

And `store.md`'s own 4.2 mitigation list is not accurate: it claims "biometric unlock" as native behaviour. Nothing
in `mobile/package.json` or either shell implements biometrics — `@aparajita/capacitor-secure-storage` with
`access: 1` is not a biometric gate. Arguing 4.2 with a feature list that includes a feature that does not exist is
how a rejection becomes a second rejection.

**What most cheaply defeats it**, in the order I would spend the money:

1. **Build the native tab bar (close D3).** It is the single fact a 4.2 reviewer writes down, and the reason it was
   skipped — "no device and no pixel diff available when this was written" — no longer holds: the harness exists.
   Build it, diff it, keep it at 0.
2. **Replace the placeholder app icon (D11).** A script-drawn placeholder is a 2.1/4.0 rejection on its own, before
   4.2 is ever reached.
3. **Make a native thing happen in the first ten seconds.** The push permission prompt already fires on first
   sign-in (`native.js:405-408`); make the onboarding ask for a profile photo through the native picker on the first
   screen so the camera sheet is tap one, not tap twelve.
4. **Write the App Review notes.** A demo account, and a numbered list of the native behaviour with where to tap for
   each. Most 4.2 rejections are a reviewer who did not find it.

But the honest ranking is that **4.2 is not the most likely rejection**. R4 (no privacy manifest) stops the binary at
upload, and R3 ships an app that cannot reach its own API. Both happen before a human looks at it.

---

## The pixel claim: what 464 plates at 0 pixels actually proves

It proves the **harness** is deterministic on **this machine**, against the **website**. It says nothing about the
apps, and `harness.md:115-118` is honest about the font half of that. The structural half is not written down:
`native.js` exports `isApp = false` in every plate, so `patchNetwork`, `patchMedia`, `wireClicks`, the viewport
rewrite (D5) and the whole blob-URL photo path (D21) are in **zero** plates. D21 — every `/media/` image becoming a
1px transparent placeholder and then a `blob:` URL, with a 40-blob / 24 MB cap and revocation on page leave — is the
largest rendering change the apps make, and the baseline cannot see it at all.

**Where the threshold is weakest.** `--threshold 0.1` is a percentage of the union canvas and `shoot()` clips at
4000px (`tools/plates.mjs:235`). On a 390-wide plate 0.1% of 390×4000 is about 1,560 pixels — a shifted line of 12px
text, a missing 1px box border, or a wrong-coloured 40×40 avatar all fit under it. And on the routes that exceed
4000px — `boards-thread` (chosen as the *busiest* thread), `profile`, `ourspace` — everything below 4000px is never
compared to anything.

**The single plate I trust least: `ourspace--in`.** Four reasons, each checkable:

1. Its content arrives over a WebSocket, and `freezeContext()` installs `context.route('**/*')`
   (`tools/plates.mjs:171`) — which in Playwright does **not** intercept WebSockets (`routeWebSocket` is the separate
   API). The live socket really connects to the throwaway seed Worker during a capture.
2. Presence and typing are one-second-scale broadcasts (`src/live/room.js:31-32`: `PRESENCE_MS = 1000`,
   `TYPING_MS = 2000`) against `settle()`'s single `waitForTimeout(500)`.
3. The only staleness detector is `settle()`'s signature, `childElementCount + ':' + scrollHeight + ':' + imgs`
   (`:207`) — the **direct** child count of `#ms-content` and the **document**'s scrollHeight. A message appended
   inside the chat's own fixed-height scrolling pane changes neither. The harness cannot tell a half-arrived room
   from a settled one.
4. `--jobs` defaults to 2–4 parallel contexts all signed in as `the_reviewer`, so who appears in the presence list
   depends on which sibling contexts are connected at that instant.

It passed twice. Two passes is two samples of a race, not a proof. `messages-chat--in` is the same shape, one step
behind.

**Runner-up: `join--out`.** The one plate of the first screen a reviewer sees, and the harness replaces both things
that occupy space on it — Turnstile's script with a stub that "draws nothing" (`:173`) and the proof-of-work solver
with one that answers instantly (`:175`). The real Cloudflare widget's iframe therefore appears in no plate at all,
and a layout break caused by it (or by `frame-src https://challenges.cloudflare.com` behaving differently under the
app's **meta** CSP than under the site's header CSP) is invisible by construction.

---

## Attacks that were tried and failed

Recorded so the next pass does not repeat them.

- **Bearer token leaking to a third-party origin (the brief's first suspicion).** It does not. `same()` is an exact
  `origin` comparison, `addHeaders` is only ever called inside the `isApi` / `mine` guard (`native.js:119`, `:143`),
  and — the part that actually saves it — the target is always *rebuilt* as `origin + u.pathname + u.search`
  (`:120`, `:142`, `:161-162`), so even the cases where `isApi` wrongly returns true (R9) still go to the Worker.
  Probed `i.scdn.co`, `challenges.cloudflare.com`, `ourspace.page.evil.com`, `localhost.evil.com`,
  `//evil.com/api/me`, `/api/../../api/me`, `https://localhost:443/api/me` across all three app origins: no leak.
  The only residual is a cross-origin **redirect** from an `/api/*` route, and the Fetch spec strips `Authorization`
  on those (`Authorization` is a CORS non-wildcard request-header name).
- **The WebSocket wrapper's `u.host !== location.host` check** (`:160`) compares host, not origin — but the target is
  rebuilt from `origin`, so a scheme or port mismatch cannot redirect the token anywhere.
- **XSS to bridge escalation.** No sink exists. `grep` for `innerHTML`, `insertAdjacentHTML`, `outerHTML`,
  `document.write`, `eval(`, `new Function`, `srcdoc` and `javascript:` across `public/` returns only the four
  comments that assert the invariant. Every `href` in `public/js/` is a fixed path plus `encodeURIComponent`
  (`dom.js:24-25`), and the linkifier (`widgets/richtext.js:26-51`) builds links **only** for resolved `@mentions`
  and `#tags` — there is no URL auto-linking anywhere, so no user-controlled `href` ever exists. `h()`'s generic
  `setAttribute` fallback (`dom.js:14`) is never reached with a user-supplied key or a URL-valued attribute.
  `patchMedia`'s `setAttribute` override adds no sink. The invariant holds.
- **Open redirect through a notification or deep link.** `//evil.com`, `https:/evil.com`, `/\evil.com/x`,
  `\\evil.com`, `/%2fevil.com`, `https://ourspace.page@evil.com/x`, `https://ourspace.page/..//evil.com` and
  `https://evil.com\@ourspace.page/x` are all correctly refused on all three origin shapes (probe output above).
  `openPage` cannot be made to leave the origin. R9 is a type-confusion in the same function, not a redirect.
- **The origin-check skip.** `tokenRequest` (`src/shared/app.js:44`) requires no `os_sid` **and** a custom header,
  and `Authorization` / `X-OurSpace-Client` both need a CORS preflight that only the three app origins get
  (`src/index.js:254-255`). `Access-Control-Allow-Credentials` is never sent (`app.js:64-69`), so a credentialed
  cross-origin request fails its preflight and is never issued — which is what protects the `os_signup` cookie, the
  one credential `tokenRequest` does not check for. With the cookie absent there is no session, so only the `OPEN`
  state-changing routes are reachable, and those are reachable from curl anyway. `http://localhost` is port 80 only
  (`http://localhost:3000` is a different origin), which needs root on Android; another Capacitor app on the device
  shares the origin but has its own storage sandbox. Low, as the contract argues.
- **Room membership bypass with a token for another room.** Not possible: see R8.
- **A fork PR reaching the signing secrets.** Not possible: see R11.
- **The push trigger bypassing block filtering.** Not possible: see R6.
- **A non-public photo classified public.** Not reachable today: see R10.
