# Security

## What's protected

- **Passwords:** PBKDF2-SHA256, 100k iterations, per-user salt. Unknown accounts and wrong passwords take the same time. A password can't be the screen name or the email, or one of the most common passwords.
- **Sessions:** a random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` on https), with only its hash stored. A password change logs out other devices, and a password reset logs out all of them. Banning logs the person out. Whatever ends a session (logging out, a password change or reset, a ban, deleting the account) also closes its live chat sockets at once (code 4001), and a room re-checks the sessions of its sockets against the database before acting on a frame and at least once a minute while it carries events, so a socket never outlives its session.
- **Provider sign-in:**
  - The state is single-use, expires in 10 minutes, is stored server-side and is tied to the browser by a cookie.
  - PKCE is used wherever the provider supports it.
  - Accounts are never merged by email (see below).
- **Spotify tokens:** encrypted with AES-256-GCM before they reach the database. Only the `user-top-read` permission is asked for.
- **Reset links:** single-use, valid for 1 hour, and kept in the URL fragment so they never reach server logs. The forgot-password page gives the same answer whether or not the address has an account.
- **Birthdays:** never shown. Pages show age and sign only if the person allows it.
- **Adults and teens:** Browse never suggests a 13–17-year-old to an adult or an adult to a 13–17-year-old: not as a person (Mutuals, Who to follow) and not as a post in For you. Logged out, Browse suggests adults only. The line is drawn from the birthdays both gave, by the same rule as the age shown on a profile (`ageCut` / `ageOn` in `src/shared/dates.js`, leap days included). Boards, tag pages and profiles aren't split: this is about who gets put in front of whom by the site itself. See [architecture.md](architecture.md#browse-for-you-mutuals-boards-for-you-who-to-follow).
- **Caching:** every API answer that depends on who's asking is `Cache-Control: no-store` (the default of `json()` in `src/shared/http.js`), so a browser shared by two accounts never shows one the other's feed, suggestions or settings. Only answers that are the same for everybody may be cached: the editor's options and the sign-in providers (`public`, 5 minutes), the sky and sign horoscopes (by date, `private`, 10 minutes) and public photos. A test (`test/api.test.mjs`, "every answer that depends on who is asking is no-store") holds the personalized routes to it.
- **"Not interested":** hiding a post takes any post id without looking it up, so its answer never tells whether a private or moderator-hidden post exists; the daily limit counts before anything is looked up.
- **Writes:** refused from other sites (Origin and Sec-Fetch-Site checks), JSON only. No exceptions: the providers come back with a plain GET. See [the life of a request](architecture.md#the-life-of-a-request).
- **Pages:** strict Content-Security-Policy (scripts and styles from the site only, images also from Spotify's CDN, audio previews from Apple), no framing. Nothing people type is ever inserted as HTML.
- **Photos:** the server reads each upload's type from its bytes (JPEG, PNG, GIF or WebP only; never SVG or HTML), refuses broken or cut-off files and takes out the metadata, GPS position included, whatever the browser did. Files get random keys and are served by the Worker with their real type, `nosniff`, `Content-Disposition: inline` and `Content-Security-Policy: default-src 'none'; sandbox`, and only to whoever may see the post they're on (a private profile's to its followers). See [architecture.md](architecture.md#photos).
- **Profiles:** every look setting must come from the lists in `src/catalog/options.js`, so nobody can inject CSS or image URLs.
- **Text:** invisible and direction-flipping characters stripped, links removed, blocked words starred.
- **Blocks and reports:** a block hides both people from each other and stops all contact. Reports keep a snapshot, so the evidence survives a delete. A child-safety (`csam`) report also holds the photos and accounts it is about until a moderator ends the hold (below).
- **Verifying humans** (phase 7, [architecture.md](architecture.md#verifying-humans-anti-spam-and-ai-writing-strikes)): Cloudflare Turnstile on sign-up, log in and "forgot my password" (checked on our side for `success`, `action` and `hostname`); a signed, single-use sign-up form with a honeypot and a minimum time; a proof of work on every sign-up; throwaway email domains refused; an emailed confirmation link (POST from a page, single use, 24 hours, kept in the URL fragment) before posting, commenting, messaging or following; suspicious sign-ups held for a moderator. Nothing bans anybody automatically: clusters and duplicates raise alerts, a 5th AI-writing strike goes to a moderator.
- **The write gate:** every member write in the route table passes `src/shared/gate.js` (email confirmed, not held; public posting also no posting timeout) unless the table marks it `free` with the reason (account, page set-up, privacy, undoing, blocks and reports). `test/api.test.mjs` reads the table and tries every gated route, so a new route can't skip it by accident.

### What the anti-bot checks keep, and for how long

| Data | Why | Kept |
|---|---|---|
| `signup_signals`: the salted hash of the network (IPv4 address, IPv6 /64), the provider's ASN, name and country from `request.cf`, a salted hash of the User-Agent, the email domain, how long the form was open, the risk score and its reason codes | reviewing held sign-ups, the nightly cluster check | **90 days**, then deleted by the cron |
| `ai_scans`: post, writer, score, label, model, a hash of the scanned text, the decision | moderators' shadow-mode review, appeals | **90 days** |
| `ai_strikes.text`: the flagged words of a strike | the member and moderators see what was flagged | while the strike counts, then 30 more days |
| `post_fingerprints`: a MinHash signature and a hash of each public post's normalised words (no text) | the duplicate check | **7 days** |
| `spent_nonces`, `email_tokens` (hashes only) | single-use forms and links | until they'd have expired (2 hours, 24 hours) |
| `mod_alerts` (user and post ids, counts, a provider's name, a domain; never addresses) | moderators | resolved ones 90 days |
| Never stored | raw IP addresses, full User-Agents, Turnstile tokens, device fingerprints, mouse or keyboard data | — |

The privacy summary on `/rules` should say: Cloudflare runs the "verify you are human" check (it sees the IP address and browser signals, as Cloudflare's processor terms describe); we keep a salted hash of your network, your network provider's name, your email's domain and how long the form took for 90 days to spot bot sign-ups; public posts of 100+ words (150 for blog posts) may be scored for AI writing (when switched on), and a scored text that earns a strike is kept so you can appeal it. (The page itself is the front end's to update.)

### What a child-safety hold keeps, and for how long

A member's `csam` report only hides the reported thing's own photos, if its reporter is verified and can see them, until a moderator dismisses or confirms it. Only a moderator's **confirmation**, after reporting to NCMEC, holds an account, and it bans the account in the same step ([architecture.md](architecture.md#child-safety-holds), [operations.md](operations.md)). 18 U.S.C. 2258A(h) asks a provider that reports to NCMEC to keep what it reported, and reasonably accessible related data, for a year, securely.

| Data | For whom | Kept |
|---|---|---|
| A reported photo a member's report listed or hid (hidden: served to moderators only) | the reported account | until a moderator dismisses (shown again; if its owner deleted it meanwhile, then deleted) or confirms the report |
| A confirmed report's photos | the confirmed account | until a moderator releases the hold, then deleted, never shown again |
| A held account's photos, own posts, messages, profile, account row (no password), sign-in identities, sign-up signals and AI scores, once they would go | only confirmed accounts | until released, then deleted within the hour |
| One DM with a held account, both sides, when the other member deletes their account (their id only, nothing else of theirs) | that other member | the same |
| Sign-up signals, AI scores, strike text, fingerprints, resolved alerts and loose uploads past their dates | only confirmed accounts | the dated sweeps skip them until the hold ends |

Nothing is kept for anyone not under a hold, and nothing ends a hold by a date. Not yet confirmed by a lawyer: keeping data past a deletion request, and keeping a third person's DM; whether this meets Apple's and Google's account-deletion rules; how long to keep it (a year from the NCMEC report is the statute's minimum); whether D1 and R2 with database access for moderators is the "secure location" 2258A(h)(3) and the NIST framework (h)(6) ask for ([decisions/008](decisions/008-launch-legal.md), section 4).

### External origins

The Content-Security-Policy in `public/_headers` allows exactly these outside origins, and nothing else:

| For | Origins |
|---|---|
| Images (besides the site's own and `data:`) | `i.scdn.co`, `*.spotifycdn.com` (Spotify album art) |
| Audio previews | `*.itunes.apple.com`, `*.apple.com`, `*.mzstatic.com` (Apple's 30-second previews) |

Scripts, styles, fonts and fetches are the site's own only. Adding a new outside origin means changing the CSP in `public/_headers` and this table together.

**Phase 7 adds one origin for the pages: `https://challenges.cloudflare.com`** in `script-src` (Turnstile's `api.js`) and `frame-src` (its widget's iframe), nothing else ([Cloudflare's CSP note](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)). The front end makes that change in `public/_headers`, this table and the CSP assertion in `test/static.test.mjs` together. The proof of work runs in the page itself (Web Crypto SHA-256, yielding to the page every few milliseconds), from the site's own `/js/…` files, so `script-src 'self'` covers it (no `blob:`, no `'wasm-unsafe-eval'`).

The Worker itself (not the pages) calls out to: `challenges.cloudflare.com/turnstile/v0/siteverify` (each Turnstile check), `cloudflare-dns.com/dns-query` (the MX check of a new sign-up's email domain, no address sent, just the domain), `api.resend.com` (emails), and, only if `AI_DETECTOR` names one, `text.api.pangram.com` / `api.gptzero.me` (the words of a public post of 100+ words, without the writer's name) or Workers AI (inside Cloudflare).

**WebSockets (`connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:*`).** The live chat's socket goes to the site itself (`wss://<this host>/api/live/…`). CSP Level 3 lets `'self'` cover that, but older WebKit (older Safari, iOS browsers included; WebKit bug 235873) never matched `ws:`/`wss:` against `'self'` and refused the socket, leaving those visitors on the polling fallback. A static `_headers` file can't name "this request's host" (the site answers on its workers.dev name and its own domain alike), so the policy allows `wss:` to any host, plus plain `ws:` to the local machine for `wrangler dev`. The trade-off: a script running on our pages could open a socket to another server. Scripts only come from the site itself (`script-src 'self'`, no inline scripts) and nothing people type is ever inserted as HTML, so that takes a script injection we don't have; fetches and images stay as locked down as before. Once those old Safaris are gone, `connect-src 'self'` alone is enough again.

## How accounts and providers fit together

- **First time with a provider:** the person picks a screen name and enters their birthday (`/join/finish`), the same as an email sign-up.
- **Already a member:** they connect more ways in under **Settings → sign-in methods**, and can remove any of them as long as one is left (a password counts as one).
- **No automatic merging by email.** If a provider says the address already belongs to an account, the person is told to log in with that account and connect the provider from Settings. That stops anyone from taking over an account by registering its email address with another service. An address the provider hasn't verified is never used for this, or kept.
- **Accounts without a password:** they log in only through their providers. To delete the account, they type their screen name to confirm.

Setting the providers up is in [deploy.md](deploy.md).
