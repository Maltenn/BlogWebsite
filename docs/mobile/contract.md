# The mobile contract

Amended 2026-10-31 from what the server implementation actually found. Amendments are marked.

One document the server and both app shells are built against. Written before any code, so the
server agent and the shell agents cannot drift. Anything here that turns out wrong gets changed
*here first*, then in the code.

## Why the app bundles `public/`

The apps ship the existing `public/` bundle — the same `app.css`, the same 23 page modules, the
same 39 widgets, byte for byte. The aesthetic is identical by construction, not by effort. There
is no second stylesheet and no reimplementation.

The consequence that drives everything below: a locally-bundled page is **cross-origin** to the
Worker. `SameSite=Lax` cookies will not travel from `capacitor://localhost` to the API. So a
token session is not an enhancement, it is load-bearing.

## Identifying the app

Every request from an app carries:

    X-OurSpace-Client: app/<ios|android>/<app version>

App origins (the only origins CORS ever answers):

    capacitor://localhost     iOS (WKWebView)
    http://localhost          Android (WebView, androidScheme http)
    https://localhost         Android (androidScheme https)

`OURSPACE_ORIGIN` is the deployed Worker origin. It is **not yet known** (the D1 id in
wrangler.jsonc is still a placeholder), so it is a build-time setting in the app, never hardcoded
in a page module.

## 1. Session tokens

`currentUser(c)` resolves in this order:

1. `Authorization: Bearer <token>` — if present, that is the session.
2. Otherwise cookie `os_sid`, exactly as today.

Same `sessions` table, same SHA-256 of the token, same expiry. Nothing about the web path
changes. When the session came from the header, the request context carries `c.viaBearer = true`.

## 2. Handing a token to the app

Every route that answers with `Set-Cookie` from `startSession()` **also** puts the raw token in
the JSON body, but only when `X-OurSpace-Client` names an app:

    { ..., session: { token: "<raw>", expires: <ms epoch> } }

Affected: `POST /api/signup`, `POST /api/login`, `POST /api/signup/finish`,
`POST /api/password/reset`.

**Amended:** `POST /api/verify` is *not* in that list. It never started a session and works
while logged out, so handing it a token would turn a single-use email link into a login link.

`POST /api/oauth/exchange` answers with the same `session` object and no cookie at all (§6).

**Amended:** an app has no `os_signup` cookie either, so the half-finished sign-up travels as its
own header, `X-OurSpace-Ticket`, on `GET /api/signup/pending` and `POST /api/signup/finish`. The
app gets that ticket from the body of `POST /api/oauth/exchange` (§6) — never from the
`ourspace://` scheme, which is public.

A browser never sends that header, so a browser response is byte-identical to today. This is
testable and must be tested.

## 3. CSRF and the origin check

The check in `src/index.js` stays exactly as it is for cookie requests. It is skipped only when
there is **no `os_sid` cookie** and the request either carries a bearer token or names an app in
`X-OurSpace-Client`.

**Amended:** as first written this said "bearer token" alone, which was wrong and would have
broken the app's own sign-in. `POST /api/login` from the app arrives with
`Origin: capacitor://localhost` and *no token yet* — there is none until login succeeds — so it
would have been refused with 403. Sign-up, password reset and the sign-up forms are the same.

What still protects that door: a bearer token is not ambient credentials, so a hostile page
cannot make the app send one; and a browser cannot send `X-OurSpace-Client` cross-site without a
CORS preflight, which is answered for the three app origins and nothing else.

## 4. CORS

`OPTIONS` is answered for the three app origins above and nothing else.

    Access-Control-Allow-Origin: <the echoed app origin>
    Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
    Access-Control-Allow-Headers: Authorization, Content-Type, X-OurSpace-Client
    Access-Control-Max-Age: 600

`X-OurSpace-Ticket` is in the allowed headers too.

`Access-Control-Allow-Credentials` is **never** sent. Tokens only. If cookies can't cross, they
can't be stolen across either.

**Amended:** CORS is not only the preflight. Real `/api/*` **and `/media/*`** responses to an app
origin also carry `Access-Control-Allow-Origin` and `Vary: Origin`. Other origins still get 405
on `OPTIONS`, as before.

## 5. Devices

    devices(id, user_id, token_hash, platform, label, push_token, push_provider,
            created, last_seen, revoked)

`token_hash` ties a device to the session row it signed in with, so revoking a device kills its
session.

    POST   /api/me/devices            {platform, label, pushToken?}  — upsert this device
    GET    /api/me/devices                                           — list, for Settings
    DELETE /api/me/devices/:id                                       — revoke, deletes the session

All `AUTH`. `free: 'your own devices'` — managing your devices must work while held or timed out.

**Amended:** `devices.revoked` exists, but revoking normally makes the row vanish with its
session through an `ON DELETE CASCADE` foreign key. Logging out, changing a password, expiry and
deleting the account all take the device with them.

## 6. Signing in with Google or Discord

The redirect flow can't stay in the WebView: the provider refuses a custom scheme and the app
needs a session back.

**A custom scheme is not a private channel.** `ourspace://` is a public, exported BROWSABLE intent
filter on Android and an unclaimed `CFBundleURLType` on iOS: any installed app can fire a URL at
it, and on Android a co-installed app that declares the same scheme is offered the OAuth return.
So nothing secret travels on it. What travels on it is a one-time code that is worthless on its
own.

    GET /api/oauth/:provider/start?client=app&challenge=<base64url SHA-256 of the verifier>

records `client = 'app'` and that `challenge` on the `oauth_states` row. The app mints the
`verifier` (256 bits) before it opens the sheet and keeps it **in memory only**. An app `/start`
without a well-formed challenge is refused: there would be nowhere safe to answer it.

The callback then, for app clients only, redirects to a custom scheme instead of a path:

    ourspace://auth?code=<one-time code>            the sign-in got this far
    ourspace://auth?error=<code>                    refused

and the app redeems the code:

    POST /api/oauth/exchange  { code, verifier }    -> { session: { token, expires } }  signed in
                                                    -> { ticket: "<signup ticket>" }    needs to finish signing up

Apps only (a browser gets 404). The code is stored as its SHA-256, lives 90 seconds, is bound to
the challenge, and is single use — claimed before anything is handed out, so a replay or a race
with whoever read it off the scheme finds nothing. No session row exists until the code is
redeemed, and the sign-up ticket is minted *at the exchange*, so neither ever touches the scheme.
`onAppUrl` accepts a code only when it has a verifier outstanding for a sign-in it started itself,
and spends that verifier on the first `ourspace://auth` that arrives.

The app opens `/start` in `ASWebAuthenticationSession` (iOS) or a Custom Tab (Android) with
callback scheme `ourspace`, so the provider sees a real browser and nothing of ours touches a page
the provider controls.

**Amended — the first version of this section was an account takeover.** It had the callback
redirect to `ourspace://auth?token=<raw session token>` and `ourspace://join?ticket=<signup
ticket>`, and the app saved whatever arrived. On Android a co-installed app reading the scheme got
the victim's 90-day token outright; on either platform any app could write its *own* token into
the victim's Keychain and collect the victim's push token and device label. The sign-up ticket was
the same hole with a worse ending, since whoever finishes that sign-up owns the account the
provider's verified identity lands in. A nonce alone would have closed only the second half. See
redteam R1 and `docs/mobile/r1-fix.md`.

**What is left, and why it cannot be closed here.** The code still rides a hijackable scheme, so an
app that races for it can *spend* it: the member sees "that sign-in has expired, start again" and
retries. That is a nuisance, not a takeover. Closing it needs the OAuth return to arrive on a
verified https App Link, which is blocked on the real signing fingerprint (deviation D19). Firing
`ourspace://auth?error=x` at the app while the sheet is open cancels a sign-in in progress for the
same reason — one attempt per sign-in is the requirement, so that is the deliberate trade.

**Amended — a real gap, not a detail.** `client=app` covers **signing in only** (`mode=login`).
*Connecting* Google, Discord or Spotify to an account you are already signed in to, from
Settings, does **not** work in the app: the system sheet cannot carry the bearer token, so the
server has no way to know who is linking. Those modes currently answer
`ourspace://auth?error=failed` and the app shows a message. Logged as deviation D15, and left as
a follow-up rather than half-built. Closing it needs an authenticated
`POST /api/me/oauth-ticket`, a one-time hashed ticket table with its own cron line, and `link` /
`spotify` return modes — about half a day with tests.

**Amended:** an unknown or already-used `state` cannot know it belonged to an app, so it lands on
the web `/login?error=expired`. A *known* state that then fails returns `ourspace://auth?error=…`,
which carries no `provider` parameter, unlike the web redirects.

## 7. The chat WebSocket

`GET /api/live/:room` is a WebSocket upgrade. A browser `WebSocket` can set no headers, so it
cannot carry `Authorization`. Our own pages don't need to: the `os_sid` cookie rides the handshake
like any other same-origin GET, and nothing in this section changes for them. An app has no
cookie, so it has to put a credential in the one field the API does give it — the subprotocol.

That credential is a **ticket for one room**, not the session token:

    POST /api/live/ticket   { room: 'ourspace' | <chat id> }  ->  { ticket, expires, ms }

    new WebSocket(url, ['ourspace.live', 'ourspace.bearer.' + ticket])

A ticket is:

- **one room.** `room` is checked when it is minted — a ticket is never issued for a room its
  holder could not open anyway — and checked again at the handshake against the room actually
  asked for. A ticket for `#ourspace` opens no group chat, and one group's opens no other.
- **single use.** The row is deleted, and only the request that deleted it may go on, so a replay
  and a race lose. A refused attempt (wrong room, expired) still spends it.
- **~30 seconds.** `ms` says how long; `expires` is the instant, ms since the epoch.
- **hashed at rest.** The table stores only its SHA-256, like sessions, sign-up tickets and
  `oauth_app_codes` (`migrations/0013_live_tickets.sql`).
- **the session's.** The row names the session that asked for it, and the socket it opens *is*
  that session's: logging out, a password change, a ban or a deleted account take the ticket and
  the socket with them, exactly as before.
- **only a credential at `/api/live/`.** Every other route, `/media/*` and the mint route itself
  take a session and nothing else, so a ticket cannot be turned into one ordinary request as its
  owner by adding an `Upgrade: websocket` header. Off that address it is not even read, so it is
  not spent there either.

**And the handshake echoes nothing secret.** A handshake selects one of the subprotocols the
client offered, and the browser publishes whichever it selected on the live socket as
`socket.protocol`. So the client offers the fixed name `ourspace.live` beside the ticket, and the
room selects *that* one. `socket.protocol` is the string `ourspace.live` on every platform. A
client that offers the ticket alone gets no subprotocol back, which the spec allows.

The ticket is the floor, not the wall: even if something did read it off the socket, it buys one
room the holder is already in, for half a minute, once.

**Amended:** the room's Origin check is also skipped for a socket with no cookie. It required
Origin to equal the Worker's origin, which an app can never match. The ticket is the proof
instead, and a hostile page cannot get one — minting it is a `POST`, which the router's cross-site
check does cover. With a cookie present the Origin check stands, ticket or not.

**Amended 2026-11-05 — this section used to hand the session token to page script (red team R8).**
As first written, the token itself travelled as `ourspace.bearer.<token>` and the room echoed that
exact value back in the 101. The reasoning given was that this kept the token out of a query
string "because it ends up in logs" — true, but it missed the nearer problem entirely: because the
handshake must select one of the offered subprotocols, the browser then exposed the raw session
token as `socket.protocol` on a live `WebSocket` object in the page, readable by **any script
running in the page**, with no plugin call and no storage access. The token is kept in the iOS
Keychain / Android Keystore precisely so that a WebView XSS cannot reach it (§8), and this handed
it straight back on every chat page — making one injection anywhere in the bundle the difference
between a defaced page and a stolen 90-day session. The room's authorisation was never bypassable
and is unchanged; what was wrong was the credential, and what it was worth. It is now a ticket,
and it is not echoed. `docs/mobile/r1-fix.md` is the same move made earlier for the OAuth return:
put something worthless on the channel you cannot keep secrets on.

## 8. Session length

Web sessions keep `SESSION_DAYS`. A device session gets 90 days and its expiry is pushed forward
on use, so a phone in a drawer for a month is still signed in. A reinstall loses the token and
signs in again — that is the one thing the killer-items checklist tests first.

## 9. Push

Notifications are already rows in `notifications`, written inside D1 batches by every feature.
Hooking 30-odd call sites would be invasive, so push is drained from an outbox instead:

    push_outbox(id, user_id, kind, title, body, url, created, attempts)

filled by an `AFTER INSERT ON notifications` SQLite trigger — no call-site changes at all — and
drained by a new one-minute cron. Chat messages, where a minute is too slow, push directly from
`sendChatMessage` via `ctx.waitUntil`.

APNs: ES256 JWT (`crypto.subtle`, P-256). FCM HTTP v1: RS256 service-account JWT for an access
token. Secrets: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`,
`FCM_SERVICE_ACCOUNT_JSON`. Push is off and silent when they are unset, like `mailReady`.

**Push payloads never carry member-written text.** This is an invariant, decided deliberately, not
an implementation detail. A push body leaves our servers and reaches Apple and Google in cleartext
*to them*, so a DM preview would hand them the contents of private messages, and the first draft of
the strike notification (“a note about your writing”) would have told them which members are under
moderation. A push therefore says who, and how many — “kat sent you a message” — and never what was
written. It also keeps both stores' privacy declarations short and true.

The cost is real and accepted: no at-a-glance preview, which is what iMessage and WhatsApp give
people. A per-member setting was considered and rejected, so there is one behaviour for everyone.

Every notification carries the `url` the app opens — the deep link must land on the exact thread,
cold start included.

## 10. Deep links

    ourspace://                       custom scheme, for OAuth return and notification taps
    https://<OURSPACE_ORIGIN>/...     universal / app links

`public/.well-known/apple-app-site-association` and `public/.well-known/assetlinks.json` are
served from the origin. Both need the real team id, bundle id and signing fingerprint, which
nobody has yet — they ship with clearly-marked placeholders and a line in the deviation register.

## 12. Photos

`/media/*` was sending `Cross-Origin-Resource-Policy: same-origin`, which would have blanked
**every photo in the app** — an `<img>` on `capacitor://localhost` loading from the Worker is
exactly what CORP blocks. Found by the shells, fixed on the server, narrowly:

- **Public photos** (the ones `serveMedia` already answers `public, max-age=300`: pictures,
  open-profile posts, board posts) now send `cross-origin`. That gives up Spectre-style embedding
  protection for images anyone can already fetch with no credentials. `nosniff`, the sandbox CSP,
  the byte-level sniffer in `src/media/sniff.js` and the access check are all untouched.
- **Private photos, and every 404, keep `same-origin`.**

It cannot be keyed on `X-OurSpace-Client`, because an `<img>` sends no custom headers.

So a private photo — a private profile's, a DM's, a group chat's — cannot load in an `<img>` in
the app at all: CORP blocks the embed, and even without it there is no `Authorization` header on
an image request. The app must `fetch` those with the bearer token in CORS mode (a CORS-mode
fetch is not governed by CORP) and hand the page a blob URL, revoking it when the page is left.
On a social network where profiles can be private that is a large share of all photos, not an
edge case.

## 11. The deviation register

Every forced departure from the web CSS gets a row in `docs/mobile/deviations.md`: what changed,
which platform forced it, and why. Aesthetic debt stays explicit. An empty register is a claim
that the apps render exactly like the site, and the pixel diff is what checks that claim.

A row is not a licence to approximate. Where a departure can be **measured** instead of judged by
eye, it must be: the native tab bar (D3) is drawn from numbers `public/js/core/tabspec.js` reads
off the live `.ms-tabs` in the running web view, and `npm run tabbar:check` holds a bar rebuilt
from those numbers to a **zero**-pixel difference against the real one, in both engines. Nothing
about that bar is written down in Swift or Java, so it cannot drift from `app.css`. A future
departure that could be built the same way and is not should say in its row why not.
