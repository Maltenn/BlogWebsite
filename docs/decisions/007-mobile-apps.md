# 007 — iOS and Android apps without a second codebase
Status: proposed (2026-10-31)

## Question
OurSpace should be on the App Store and Google Play, behaving as it does on the web, talking to
the same Worker, and with the aesthetic **absolutely unchanged**. What shape should the apps be,
and what has to change on the server?

## What we found in our own code
Measured in this repo on 2026-10-31, not from memory:

- **The aesthetic is not portable.** `public/app.css` is 1,175 lines, and what it themes through
  CSS custom properties is **two colours**: `--ms-accent` and `--ms-panel`, set at runtime per
  profile from `public/js/core/ui.js:41,44` and read back through `var()` 26 times with literal
  fallbacks. Everything else — every layout, border, inset, font stack and spacing value — is a
  hard-coded literal, and the look *is* those literals plus the DOM structure of 39 widgets in
  `public/js/widgets/`. So there is no token layer to port: a native rewrite would have to
  re-derive the appearance by eye. (An earlier draft of this record said "zero custom properties",
  from a `grep -cE '^\s*--'` that only matched declarations at the start of a line. Wrong in
  letter; the conclusion is unchanged.) It already has a tuned phone pass — nine
  `@media (max-width: 760px)` blocks, plus `@media (hover: none)` rules for touch.
- **The front end is vanilla ES modules with no build step**: `public/app.js` holds a 37-entry
  route table and imports 23 page modules from `public/js/pages/` and 8 from `public/js/core/`.
  Nothing to compile means nothing to port.
- **The API is large and finished**: 119 routes in the table in `src/index.js`.
- **Sessions are cookie-only**: `os_sid`, HttpOnly, `SameSite=Lax`, Path=/ (`sessionCookie` in
  `src/shared/http.js`), resolved by `currentUser()` in `src/accounts/auth.js` against the
  `sessions` table, which stores only the token's SHA-256. CSRF rests on three locks: the
  SameSite cookie, JSON-only bodies, and the Origin / `Sec-Fetch-Site` check in `src/index.js`.
  There is deliberately **no CORS**.
- **Chat is a WebSocket** to a Durable Object per room (`GET /api/live/:room`, `src/live/room.js`).
- **Notifications are D1 rows**, written inside batches by every feature through `notify()` in
  `src/shared/notify.js`. There are ~30 call sites and no outbound channel.
- **There is no PWA**: no manifest, no service worker.
- **4 MB of `public/assets/`**, much of it animated GIF avatars.

## The three shapes considered

**A. Rewrite the views natively (React Native, Flutter).**
Rejected. With no custom properties and no design tokens, "absolutely the same" would have to be
re-derived by eye across 37 routes and 39 widgets, then kept in step with the web forever, in two
more codebases. The look would drift on the first day and keep drifting. It also duplicates the
client half of 119 endpoints.

**B. A WebView pointed at the live origin.**
Rejected. Cookies keep working, which is tempting, but: cold start depends on the network, nothing
works offline, and it is the exact shape Apple's **Guideline 4.2 (Minimum Functionality)** exists
to reject. (4.2's existence and intent are well known; the precise current wording was not
re-read for this record.)

**C. Bundle `public/` into a native app; API over HTTPS. — chosen.**
The app ships the same `app.css` and the same page modules, byte for byte, so the aesthetic is
identical *by construction* rather than by effort. Cold start is local, an offline shell is
possible, and the engineering budget goes to things a page cannot do at all.

## What C forces, and this is the whole point
A locally-bundled page is **cross-origin** to the Worker. `SameSite=Lax` will not send `os_sid`
from `capacitor://localhost`. So:

1. **A token session is load-bearing, not optional.** `Authorization: Bearer` resolved ahead of
   the cookie in `currentUser()`, against the same `sessions` table and the same hash. Routes that
   set a session cookie also return the raw token in the body, but only when
   `X-OurSpace-Client` names an app — so a browser's response stays byte-identical.
2. **CORS, narrowly.** Three app origins, `Access-Control-Allow-Credentials` never sent. Tokens
   only; if cookies cannot cross, they cannot be stolen across either.
3. **The Origin check is skipped only for bearer requests with no cookie.** A bearer token is not
   ambient credentials — a hostile page cannot make the app send it — so the check has nothing
   left to protect there. The cookie path is untouched.
4. **The token must not live in `localStorage`**, which a WebView XSS could read. It goes in the
   iOS Keychain / Android Keystore. The repo's `textContent`-only invariant makes XSS unlikely;
   "unlikely" is not where a session token belongs.
5. **OAuth leaves the WebView.** Providers refuse custom schemes and the app needs a session back,
   so `/api/oauth/:provider/start?client=app&challenge=…` returns to `ourspace://auth?code=…` via
   `ASWebAuthenticationSession` / Custom Tabs, and the app trades that one-time code for the session
   over TLS at `POST /api/oauth/exchange`. **Nothing secret rides the scheme** — the first draft of
   this design put the raw token there and was an account takeover; see below.
6. **The chat WebSocket cannot send a header.** The browser `WebSocket` API allows no custom
   headers, and a token in a query string lands in logs. So a credential travels as a subprotocol
   instead — but **not the session token**, because the handshake selects one of the offered
   subprotocols and the browser then publishes it as `socket.protocol`. `POST /api/live/ticket`
   mints a single-use, one-room, 30-second ticket; the client offers it as
   `ourspace.bearer.<ticket>` next to the fixed `ourspace.live`, and the room selects the fixed
   one. The first draft of this design put the raw token there; see below.
7. **Push needs an outbox.** Hooking ~30 `notify()` call sites would be invasive; an
   `AFTER INSERT ON notifications` trigger filling `push_outbox`, drained by a one-minute cron,
   changes no call sites at all. Chat pushes directly from `sendChatMessage`, where a minute is
   too slow. (That SQLite triggers behave this way under D1 was taken as given here and must be
   confirmed by the migration test.)

## How "absolutely the same" is checked
Not by looking. A frozen **reference plate set** — all 37 routes from the deterministic
`npm run demo` seed, at four viewports, in Chromium (what the Android WebView is) and WebKit (what
WKWebView is) — is captured before any change and committed. `tools/pixeldiff.mjs` compares the
app's capture against it and fails over 0.1% differing pixels. Because the app ships the same CSS
and the same DOM, the honest expected diff is near zero; anything above it is a bug with a cause.
Every forced departure (safe-area inset, keyboard avoidance, status bar) gets a row in
`docs/mobile/deviations.md`, so aesthetic debt stays explicit.

## What the adversarial pass found

A red team was run over the finished work (`docs/mobile/redteam.md`). It is recorded here because
two of its findings were faults in *this design*, not in its implementation.

- **The custom-scheme return was an account takeover.** `ourspace://auth?token=…` handed the app a
  raw 90-day session token, and §6 above said nothing about proving the app had asked for it. Any
  installed app could inject its own token into a member's phone; on Android, where the return comes
  back through a public BROWSABLE intent filter, a co-installed app could *receive the victim's*
  token. A nonce would have fixed only the first half. The custom scheme now carries a one-time code
  exchanged over TLS for the token, so a hijacked link is worth nothing.
- **Moving the socket token out of the query string moved it somewhere worse.** §7 reasoned that a
  query-string token ends up in logs — true — and put it in `Sec-WebSocket-Protocol` instead. But the
  handshake must select one of the offered subprotocols, and the browser exposes whichever it
  selected as `socket.protocol` to any script in the page. Logs became the DOM, on every chat page,
  for the one secret the Keychain existed to hold. Fixed 2026-11-05: the handshake carries a
  single-use, one-room, 30-second ticket instead, and selects a fixed name rather than echoing the
  credential, so `socket.protocol` holds nothing worth stealing. Both faults were the same mistake
  — reasoning about where a secret would be *logged* instead of who could *read* it — which is why
  both channels now carry something worthless.

Two further notes worth keeping, because they are about method rather than code. The report's most
confident finding about a token leaking to third-party origins was **wrong**, and disproved by its
own probes — the request target is rebuilt from the Worker's origin rather than merely host-checked.
And one finding named a file that does not exist and called a gate missing that is present, while
the exposure it described was nevertheless real by a different route. Acting on an adversarial report
verbatim would have repaired a working gate and left the hole open. Findings were therefore required
to be marked CONFIRMED or PLAUSIBLE, and each was re-verified before anything was changed.

## Open questions for the owner
- **No Mac.** Development is on Windows 11; Xcode is macOS-only. Cloud runner (`macos-14`) or your
  own machine?
- **No production origin.** The D1 id in `wrangler.jsonc` is still
  `00000000-0000-0000-0000-000000000000`, so the app has no server to point at and universal links
  cannot be configured.
- **Age rating.** `MIN_AGE` is 13, but a social network with unfiltered user content usually rates
  17+ on the App Store unless the moderation in `src/ai/` and `src/trust/` is argued successfully.
- **Sign in with Apple** may be requested alongside Google and Discord under Guideline 4.8;
  email + password probably satisfies it, unconfirmed.
- **Credentials.** Nothing ships without an Apple Developer Program membership, a Play Console, an
  APNs key and an FCM project.
