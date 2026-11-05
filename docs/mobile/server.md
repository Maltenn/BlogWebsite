# The server side of the apps

What the Worker does for the mobile apps, as built to [contract.md](contract.md). Where the build differs from the
contract, that is listed last, and the contract is the thing to correct.

## Where it lives

| Piece | File |
| --- | --- |
| Who is an app, bearer tokens, the three origins, CORS | `src/shared/app.js` |
| `currentUser` (bearer, then cookie), `startSession`, `withSession`, 90-day sliding sessions capped at 180 days | `src/accounts/auth.js` |
| The origin check, CORS on every `/api` and `/media` answer, the one-minute cron | `src/index.js` |
| Sign-in with Google or Discord from an app | `src/accounts/oauth.js` |
| The chat socket's one-room ticket | `src/chats/live.js`, `src/shared/live.js`, `src/live/room.js` |
| Devices (3 routes) | `src/push/devices.js` |
| Push: outbox drain, direct chat push, `pushReady` | `src/push/push.js` |
| APNs, FCM, the JWTs | `src/push/apns.js`, `src/push/fcm.js`, `src/push/jwt.js` |
| Tables, the trigger | `migrations/0010_devices.sql`; `0012_push_shown.sql` (the outbox line knows its notification; `push_sent`) |

## Routes

    GET    /api/me/devices        AUTH
    POST   /api/me/devices        AUTH, free: 'your own devices'
    DELETE /api/me/devices/:id    AUTH, free: 'your own devices'

`POST` takes `{ platform: 'ios'|'android', label, pushToken? }` and is an upsert on the session it is called with (one
device per session). `pushToken` left out keeps the one we have, `null` forgets it, a value moves it here from any other
device. Answers `{ device: { id, platform, label, push, created, lastSeen, current } }`; the token itself is never sent
back. `GET` answers `{ devices: [...] }`, `current` marking the caller. `DELETE` deletes the device's session, closes its
sockets and answers `{ ok, current }`. A device is tied to its session by a foreign key: logging out, a password change,
expiry or deleting the account takes the device with it.

## Signing in

* `Authorization: Bearer <token>` is the session when present. A bad token is *no session*; the cookie is not tried.
  `c.viaBearer` is set.
* `X-OurSpace-Client: app/<ios|android>/<version>` makes `signup`, `login`, `password/reset` and `signup/finish` answer with
  `session: { token, expires }` and start a 90-day session. Without it the answer is byte-identical to before.
* A device session (one made longer than 30 days) has its `expires` moved to now + 90 days when used with a bearer token,
  at most once an hour, and its device's `last_seen` with it. **It never slides past 180 days after it began**
  (`DEVICE_MAX_DAYS`, red team R7): from then the app gets a 401 and the member signs in again. 180, not 365: twice a
  year is a few seconds with a password manager or "continue with Google", and a token lifted from a backup or a
  debugger is then good for six months at most instead of for ever. Revoking a device, logging out and changing the
  password still end a session at once. Web sessions (30 days, no sliding) are unchanged.
* The origin check is skipped when the request has no `os_sid` cookie and carries a bearer token or names an app. With
  the cookie the check stands, bearer or not.
* `OPTIONS` from the three app origins answers 204 with the contract's headers (plus `X-OurSpace-Ticket`, below); every
  `/api` and `/media` answer to those origins carries `Access-Control-Allow-Origin` and `Vary: Origin`. No other origin gets
  anything, and `Access-Control-Allow-Credentials` is never sent.

### Google and Discord

`GET /api/oauth/:provider/start?mode=login&client=app&challenge=<base64url SHA-256 of the app's verifier>` records
`client = 'app'` and the challenge on the `oauth_states` row; an app start without a well-formed challenge is refused.
The callback then redirects to `ourspace://auth?code=<one-time code>` or `ourspace://auth?error=<code>` (`expired`,
`cancelled`, `failed`, `unavailable`, `busy`, `suspended`, `email_in_use`). **Nothing secret rides the scheme**: the code
is stored as its SHA-256, lives 90 seconds, is bound to the challenge and is single use, and `POST /api/oauth/exchange`
`{ code, verifier }` trades it for `{ session: { token, expires } }` (a 90-day device session, no cookie) or
`{ ticket }` for a sign-up still to finish. No session row exists until the code is redeemed. The earlier design put the
raw token and the sign-up ticket on the scheme itself, which was an account takeover on Android (redteam R1,
`r1-fix.md`).
`link` and `spotify` modes are web-only (they need a page that has the cookie), so with `client=app` they answer
`ourspace://auth?error=failed`.

An app finishes a new person's sign-up with the ticket as a header, since it has no cookie to hold it:
`X-OurSpace-Ticket: <ticket>` on `GET /api/signup/pending` and `POST /api/signup/finish` (honoured only together with
`X-OurSpace-Client`). `signup/finish` then answers with `session`.

### The chat socket

`POST /api/live/ticket { room }` → `{ ticket, expires, ms }`, then
`new WebSocket(url, ['ourspace.live', 'ourspace.bearer.' + ticket])`. The Worker takes the ticket from
`Sec-WebSocket-Protocol` (on an upgrade only, and only under `/api/live/`: a ticket is not a credential at any other
address, so it cannot be spent as one ordinary request by adding an `Upgrade` header) and claims it — hashed at rest,
single use, one room, 30 seconds (`migrations/0013_live_tickets.sql`); the row names the session that asked for it, so
from `currentUser` on the request *is* that session. The room's 101 answers with the fixed `ourspace.live`, never the credential: whatever a handshake
selects, the browser publishes as `socket.protocol` to every script in the page, which is what put the raw session
token there before (redteam R8, contract §7). A socket with no `os_sid` cookie is let in without the `Origin` check
(an app has no page of ours to come from); with a cookie the check stands. The session token is not accepted in the
subprotocol at all — only `Authorization: Bearer`, for a client that can send headers.

## Push

Off and silent until `pushReady(env)`: `APNS_KEY_P8` + `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_TOPIC` (iOS) and/or
`FCM_SERVICE_ACCOUNT_JSON` (Android). `APNS_SANDBOX=1` (a variable, not a secret) sends to Apple's development servers,
for builds run from Xcode; TestFlight and the store use production. Devices may register tokens before the secrets exist.

* **Invariant: a push never carries member-written text** (red team R5; the owner chose sender-only notifications, for
  everyone, with no per-member setting). A push is handed to Apple's and Google's servers and read there in the clear, so
  nothing a member typed goes in it: no message, no post or comment excerpt, no group or board title, no profile text. It
  says who and what kind: "kat sent you a message", "ann liked your post". The sender's screen name is the one
  member-chosen string allowed (it is the name anyone sees). A push also says nothing about moderation: an AI-writing
  strike or an appeal's answer goes out as "you have a notification from OurSpace", titled "ourspace", opening
  `/notifications`, with `kind: "notification"` on the wire (the `kind` is in the payload too). The app fetches the
  real thing itself, over its own session, when it opens. The consequence worth having: the Play Data-safety form and
  Apple's privacy questionnaire have no message content to declare as handed to a third party for notifications. Pinned
  by `test/push.test.mjs` ("a push never carries member-written text"): a DM, a group message and every kind of outbox
  line, checked on the wire. The fixed phrases live in `migrations/0012_push_shown.sql` (the trigger; 0010's two moderation
  phrases and address were replaced there, and lines already waiting rewritten) and `pushChat`.
* Every row in `notifications` fires `notifications_push`, which writes a `push_outbox` line (title: who did it; body:
  "liked your post"; url: the page's own address, e.g. `/u/ann/post/7`, `/boards/random/12`, `/requests`) **only if the
  person has a device with a push token**, and records the `notification_id` it came from (0012). No feature knows about
  push.
* **The cron `* * * * *` shows the line to the same rule as the Notifications tab before it sends** (red team R6). A
  notification row is only written when the person may be told, but it can stop showing afterwards (the post is hidden or
  deleted, the actor is banned or blocked, a group invite is declined, a board comment becomes unreachable). So each run
  first deletes the lines among the next ones (`PER_USER` per person) whose notification is no longer in `SHOWN`
  (`src/shared/notify.js`, rewritten for the line's person), in the same D1 batch that picks the lines. "A likes B's post,
  B blocks A eight seconds later" no longer buzzes B's phone. What remains is the few seconds of the sends themselves.
* **What a run sends, and the limit it respects** (red team R12). Lines are taken *round-robin over people*: everybody's
  oldest line, then everybody's second one, up to 10 a person per run, so one busy member's hundred likes cannot keep
  anyone else waiting. The cap is on **sends** (one per device), not lines: every push is one `fetch` to APNs or FCM, and
  a Worker on the **free plan may make 50 subrequests in one invocation** (docs/decisions/004). A run makes at most **45**
  (the 50, less one for FCM's access token when the isolate is cold, less four to spare); lines it did not reach keep their
  place, and an attempt is counted only for lines it really tried. The D1 work is a constant handful of batches (the free
  plan allows 50 queries an invocation). On the **paid plan** (10,000 subrequests) set the variable
  `PUSH_SENDS_PER_RUN` (for example `500`) and the same code does that many sends a minute; with one phone each that is
  up to 45 pushes a minute on free (about 64,800 a day) against the old 20 lines (28,800).
* **Retries are per device.** A line is sent to each device that has a token and a live session. A device that answered
  `ok`, or that can never be sent to (a dead token, which is also forgotten; a message the service refuses for good), is
  recorded in `push_sent (outbox_id, device_id)`; only a "try again later" is not. The line stays while any device is
  left to retry (5 attempts, then dropped; a line a day old is dropped unsent) and the next run sends **only to the
  devices still owed it**, so a phone that got the push is never pushed twice. `push_sent` rows go with their line or
  device. With push not set up the outbox is emptied each minute, so switching it on later sends nothing old.
* `sendChatMessage` pushes the message at once (`ctx.waitUntil`) to the other joined members' devices, skipping people with
  a block either way (no retry: the message is in the chat when they open the app; a huge group is cut at the same number of
  sends as a cron run). Title: the sender; body "sent you a message" (a DM) or "sent a message in a group chat" (not the group's name, which a
  member chose); url `/messages/<id>`.
* The APNs provider token (ES256) is reused for 40 minutes; the FCM access token for its lifetime.

Secrets are listed in the comment at the top of `wrangler.jsonc`. `docs/deploy.md` has not been updated (it was not part
of this change): add the five names there.

## What no test here can show

No real APNs or FCM was spoken to: the tests run the Worker against a stand-in that verifies each JWT's signature with the
public key and records the payloads. Still unproven until real credentials exist: that Apple accepts the `.p8` key and
topic, that FCM accepts the service account, the sandbox/production choice for a given build, and that Cloudflare's `fetch`
negotiates HTTP/2 with `api.push.apple.com` (it does for other Workers, but it hasn't been run from this one). A deployed
Worker is also needed to see the cron fire on schedule and the `ourspace://` redirects open the real browser sheets.

## Where this differs from the contract

1. **The origin check is also skipped for requests that name an app but carry no token yet** (login, sign-up, password
   reset, the sign-up forms), not only for requests whose session came from a bearer token. The contract's rule would refuse
   the app's own `POST /api/login`: it has `Origin: capacitor://localhost`, which is not the Worker's origin, and no token to
   skip the check with. The skip needs `X-OurSpace-Client` (or a bearer header) and no `os_sid`, and a browser cannot send
   those cross-site without a preflight that only the three app origins ever get.
2. **`POST /api/verify` does not answer with a session.** It never started one (it works logged out, and the link in the
   email is single-use but is not a login); handing out a session for it would turn an email link into a login link. The app
   gets its token from sign-up or log-in, and verifying needs none.
3. **`Access-Control-Allow-Headers` also lists `X-OurSpace-Ticket`**, and `GET /api/signup/pending` / `POST
   /api/signup/finish` accept that header (from an app) in place of the `os_signup` cookie. The app gets the ticket from
   the body of `POST /api/oauth/exchange` (§6); it never travels on the `ourspace://` scheme.
4. **Google and Discord from an app are sign-in only** (`mode=login`). Linking from Settings and connecting Spotify start
   from a page with the cookie, which a browser sheet does not have. **Follow-up, not built** (it is not a small change): the
   sheet cannot send the bearer token, so the app would first ask the Worker for a one-time link ticket (a new
   authenticated route, `POST /api/me/oauth-ticket {provider, mode}`, and a table for the tickets, hashed, single use, five
   minutes, with an `expires` line in the cron). It opens `/start?mode=link|spotify&client=app&ticket=…`; `start` consumes the
   ticket, sets the usual state cookie (kept: it is what stops someone else's browser finishing your link) and stores the
   ticket's user on the `oauth_states` row. The callback then needs app returns for `link` and `spotify`
   (`ourspace://settings?linked=<provider>`, `?spotify=connected`, or `?error=<code>`) beside the sign-in ones. About half a
   day with its tests.
5. **The WebSocket `Origin` check is skipped for a bearer socket without a cookie** (the contract is silent; the Worker
   refused any `Origin` that wasn't its own, which an app can never match).
6. **CORS also answers `/media/*`** and every real response, not only `OPTIONS`; an app cannot read a response without
   `Access-Control-Allow-Origin`. Private photos are served by session, and an `<img>` sends no `Authorization`: the apps
   must fetch them with the bearer token and show a blob URL.
7. `devices.revoked` exists as the contract says, but a revoked device's row is deleted with its session, so it is only
   ever seen as 1 for an instant.
8. An `ourspace://auth?error=expired` only reaches an app when the sign-in's state row still exists; an unknown or
   already-used `state` has no `client` to read and lands on `/login?error=expired`.
9. **Photos and `Cross-Origin-Resource-Policy`.** `/media/*` sent `same-origin`, which makes a browser refuse an `<img>`
   from the apps' pages (`capacitor://localhost`, `https://localhost`): every photo would have been blank. It is now
   `cross-origin` for a **public** photo (a picture, an open profile's post, a board post: the ones `serveMedia` marks
   `public, max-age=300`) and stays `same-origin` for everything else (a viewer-only photo, `private, no-store`; a 404).
   The split is by what the photo is, not by `X-OurSpace-Client`, because an `<img>` sends no custom headers.
   *What it gives up:* other sites may now embed public photos, and their renderers may hold the bytes (the Spectre-era
   side channel CORP `same-origin` closes). That protects nothing for a public photo, which anyone can already fetch with no
   credentials at all; `nosniff`, the sandbox CSP, the byte-level sniffer and the permission check in `serveMedia` are
   unchanged. A viewer-only photo can't load in an app's `<img>` anyway (no token), so the apps read those with `fetch` and
   the bearer token and show a blob URL; a CORS-mode fetch isn't governed by CORP. Pinned by a test in `test/api.test.mjs`
   (browser request, app request, revalidation, and the private case).
   *Profile pictures* (red team R10) are public on purpose: they are on every profile page, a private one's too. Only the
   picture that is the member's **current** avatar is served (a leftover is a 404), so a superseded one can't be hotlinked
   for ever. *Photos on a page of someone else's* (a Friends' Comment) are judged against the **page owner**
   (`COALESCE(p.target_id, p.author_id)`: private page, block, ban), as `notify()` and `SHOWN` do; `wall` is still not
   in `MEDIA_LIMITS`, but adding it no longer opens a hole. Pinned in `test/push.test.mjs`. `docs/architecture.md`'s photo section still says
   `same-origin`; it was outside this change.
