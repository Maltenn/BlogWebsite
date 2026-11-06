# R1: the app's provider sign-in no longer puts a secret on `ourspace://`

Closes redteam **R1** (account takeover, both directions), and with it **R9** and **R13**. Written against
`docs/mobile/contract.md` §6, which needs the amendment listed at the end.

## What was wrong

`onAppUrl` (`public/js/core/native.js`) took *any* `ourspace://auth?token=…` that reached the app and saved it.
`waitingForAuth` was consulted only to close the Custom Tab; it was never required. Two attacks, both real:

- **Injection, both platforms.** Any installed app (`UIApplication.open` / `startActivity`), or a web link the member
  taps, fires `ourspace://auth?token=<the attacker's own token>`. The victim's Keychain is overwritten and
  `registerDevice(true)` posts the victim's push token and device label into the attacker's account. Everything the
  victim writes next is the attacker's to read.
- **Theft, Android, full takeover.** The Android return comes back through the **public, exported, BROWSABLE**
  `ourspace://` intent filter, so a co-installed app that declares the same scheme is offered
  `ourspace://auth?token=<the victim's raw 90-day session token>`. iOS is safe from this one because
  `ASWebAuthenticationSession(callbackURLScheme:)` claims its own callback.

`ourspace://join?ticket=<sign-up ticket>` had exactly the same shape and the same weight. Whoever holds that ticket
finishes the sign-up and owns the account the provider's **verified** identity lands in — a permanent takeover of the
victim's Google or Discord identity on OurSpace, not a session that can be revoked. It is treated identically here.

**A nonce alone does not fix this.** A nonce closes the injection, because the attacker cannot guess it. It does
nothing about the theft: a scheme-hijacking app still receives the victim's real token, nonce and all.

## What is there now: a one-time code exchange

Nothing secret rides the custom scheme. The scheme carries a **code**, and a code is worth nothing to whoever reads
it.

1. **The app arms the sign-in.** Before opening the provider sheet it mints a 256-bit `verifier`
   (`crypto.getRandomValues`, base64url), holds it in memory and nowhere else, and sends the server
   `challenge = base64url(SHA-256(verifier))` on `GET /api/oauth/:provider/start?client=app&challenge=…`. The
   challenge goes on the `oauth_states` row (`migrations/0011_oauth_app_codes.sql`). An app `/start` with no
   well-formed challenge is refused with `ourspace://auth?error=failed` — there would be nowhere safe to answer it.
2. **The callback mints a code, not a session.** For an app client it inserts one `oauth_app_codes` row — the code's
   SHA-256, the challenge copied from the state row, 90 seconds — and redirects to `ourspace://auth?code=…`. No
   session row is created, and no `Set-Cookie`. For somebody new, the row's `kind` is `signup` and it points at the
   `oauth_signups` row by hash.
3. **The app redeems it over TLS.** `POST /api/oauth/exchange { code, verifier }` → `200 { session: { token, expires } }`
   (contract §2's shape), or `200 { ticket }` for somebody who still has to pick a screen name. The ticket the app
   will actually use is minted *here*, and the `oauth_signups` row's `ticket_hash` replaced, so the raw ticket never
   touches the scheme either.
4. **`onAppUrl` accepts a code only for a sign-in it started itself.** The verifier is spent by the first
   `ourspace://auth` that arrives, whatever it carries. A URL arriving with no verifier outstanding is dropped in
   silence. `ourspace://join?ticket=` is gone entirely.

A hijacking app on Android now reads a code it cannot redeem: redeeming needs the verifier, which never left the
victim's process. A code fired at an app out of nowhere matches no verifier of that app's. And a code nobody collects
leaves nothing behind at all, because the session does not exist until it is redeemed.

### Why 90 seconds

The only thing between the callback's redirect and the app's POST is the operating system handing one app's URL to
another, which is milliseconds; the app already has the verifier in hand. The margin is for a Custom Tab closing
slowly or a phone that has just changed network. 60 would work and 120 is more exposure than the hand-off needs. The
exposure is small either way — the code is single-use, hashed at rest, and bound to a verifier — so the figure is
chosen for the hand-off's worst case, not for the attacker's convenience.

### Single use, and the claim

`oauthExchange` reads the row, then **deletes it and requires `meta.changes === 1`** before it hands anything out. Two
requests racing for the same code — a replay, or whoever read it off the scheme getting there first — cannot both
win, and a refused attempt (wrong verifier, expired, unknown user) still consumes the code.

### What is checked, in order

`appClient` (apps only; a browser gets 404) → the per-network rate limit → a code and a verifier of at least 32
characters → the row exists → the row is claimed → not expired → `SHA-256(verifier)` equals the stored challenge, by a
comparison whose time does not depend on where they differ → the account is not banned.

## R9: `sitePath`'s origin guard

`sitePath` compared `u.origin` against `location.origin` and nothing else. For a URL with an **opaque** origin —
`javascript:`, `data:`, `blob:`, `capacitor:`, `ourspace:` — `origin` serialises to the *string* `"null"`, and in a
WebView whose own page is on an opaque origin (`capacitor://localhost`) `"null" === "null"` passed every one of them.
`sitePath('javascript:alert(1)')` returned `"alert(1)"`. Benign today, because `openPage` feeds only
`pathname + search + hash` to `go()` — but it was not the guard the contract claimed, and one refactor away from an
XSS. The scheme is now checked first, by allow-list: `http:` and `https:` only. `mobile/test/bridge.test.mjs` holds it
to that for `javascript:`, `data:`, `blob:`, `file:`, `about:`, `ourspace:`, `capacitor:`, `//evil.com`, `/\evil.com`,
`\\evil.com`, a userinfo-smuggled host and the encoded forms, and asserts that nothing it ever returns can be resolved
off our origin.

## R13: the reinstall guard, and the Keychain class

**The guard failed open.** `forgetOnFreshInstall` was one `try { … } catch { /* leave things as they are */ }` around
both the `localStorage` read and the drop, so a read that *threw* — storage blocked, quota, a WebView that refuses it
— kept the previous installation's token. A guard whose job is to drop a token it cannot vouch for has to drop it when
it cannot tell. It is inverted: the read is its own `try`, a failure means "not installed", and the token goes. The
cost of being wrong that way is one sign-in. The cost of the other way is the previous installation's session handed
to whoever reinstalled. If storage is *permanently* unreadable the app signs in on every launch — which is the right
failure, and it is the same WebView in which `localStorage` already backs the offline `/api/me` cache.

**The Keychain class is already right, and R13's reading of it is wrong.** `access: 1` in
`@aparajita/capacitor-secure-storage` is **`whenUnlockedThisDeviceOnly`**, not `afterFirstUnlock`
(`mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/definitions.js`: `whenUnlocked = 0`,
`whenUnlockedThisDeviceOnly = 1`, `afterFirstUnlock = 2`). So the token is already foreground-only *and* excluded from
a restore onto another device — stricter than the `whenUnlocked` the finding recommended. Nothing needs it before the
first unlock: push notifications arrive and are drawn natively with no token, and the device row is only ever written
from `registerDevice()` with the app running. Left as it is, with the mapping written down next to it so the next pass
does not re-derive it.

## The amendment `docs/mobile/contract.md` §6 needs

See the report that accompanies this change; §6's three `ourspace://` return shapes become two, and
`POST /api/oauth/exchange` joins the route list.

## What is still open

- **The code still rides a hijackable scheme.** That is now a denial of service, not a takeover: an app that races to
  the code spends it, and the member sees "that sign-in has expired" and tries again. Closing it needs the OAuth
  return on a verified **https App Link** — D19, which is blocked on the real signing fingerprint.
- **An attacker can clear a sign-in in progress** by firing `ourspace://auth?error=x` while the sheet is open: the
  verifier is spent and the real return is refused. One attempt per sign-in is the point, and the member retries.
- **The verifier is in memory only**, so if Android kills the activity behind the Custom Tab the return cold-starts
  the app with nothing to match and the sign-in has to be started again.
- **The exchange is not refused over plain `http:`.** The deployed Worker is https and the app's `OURSPACE_ORIGIN` is
  a build-time setting; the test harness runs the whole API over `http://127.0.0.1`. R3 (a release build pointing at
  `http://localhost:8787`) is the thing to fix there, not a scheme check in this route.
- Everything R2 gives away is unchanged: with `webContentsDebuggingEnabled: true` in the release build, adb reaches
  the in-memory token and the verifier directly, and no amount of care in this flow matters.
