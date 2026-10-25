# 003 — Verifying humans: anti-bot measures

Status: proposed (2026-10-25). Nothing here is built. The owner approves the list first; "on by default" below means "on once the owner approves this list".

## Question

OurSpace wants to feel like the internet before bots. Already decided: Cloudflare Turnstile on sign-up, login and password reset, and email verification before posting or messaging. Already built: per-user and per-IP rate limits (D1 `attempts`, purged after 2 days), salted IP hashes, sign-up caps (5/IP/hour, 200/day), links stripped, block/report/moderation queue. What else, built in-house, makes it likely that a human made each account, without shutting out real people (members are 13+; some use screen readers, switches or voice control)?

## What we found

**Bottom line: no technique below reliably separates a human from an LLM agent driving a real browser.** A commercial agent was reported clicking through Cloudflare's checkbox [8], and image CAPTCHAs fell to a 2024 YOLO model at 100% [9]. What does work against agents is (1) making each account cost something, (2) catching them by what they do together (same network, same time, same text), and (3) limiting how much damage a fresh account can do before anyone trusts it. The layers below are built around that.

Ratings: H high, M medium, L low, ? unknown. "Stops" reads scripts / headless browsers / LLM browser agents.

| Technique | Stops (S / H / A) | Friction | Accessibility | Privacy | Workers cost | Src |
|---|---|---|---|---|---|---|
| Turnstile, managed mode (decided) | H / M / L-M. Stealth tooling and token-solver services exist; one agent reported clicking through (secondary, Jul 2025) | Usually none, sometimes a checkbox | Cloudflare claims WCAG 2.2 AA (no independent audit found) | Cloudflare is processor; IP, UA and browser signals go to it; needs CSP + policy text | 1 subrequest per check | 1-5, 8 |
| Honeypot field | M / L / L. The SPA's API is called directly by scripts, so only bots that render the form meet it; vendor anecdotes only, no study | None | Safe only if hidden from assistive tech (`aria-hidden`, `tabindex=-1`) | None | ~0 | 10, 12 |
| Form timing (signed timestamp) | H / L / L. Agents are slow anyway | None | Use a minimum only; a short maximum would lock out slow users | One timestamp in a signed token | 1 HMAC | 10 |
| Client proof-of-work (hashcash, ALTCHA, mCaptcha, Cap.js) | M / L / L. It prices accounts, it does not test humans; a native solver is ~100x faster than browser JS (Anubis: 65,536 hashes = 130 ms JS vs 1.3 ms Go, secondary); GPUs ~150x CPU for SHA-256 | 0.1-8 s of CPU, battery on old phones | W3C: no direct problem, slower on old hardware | None (ALTCHA/Cap say cookie-free; vendor claim) | Verify = 1 SHA-256; challenge is stateless | 10, 13 |
| Disposable-email blocklist | M / M / M. Stops throwaway inboxes, not who is typing | Rare false positive | None | Domain only | Static list bundled in the Worker | 14 |
| MX / null-MX check | L-M / same / same. Catches typos and invented domains | None | None | Domain only | 1 DoH subrequest; fail open | 15 |
| `request.cf`: asn, asOrganization, country, httpProtocol, tlsVersion, tls* hashes, clientTcpRtt | M / L-M / L-M. Hosting ASN is a good score; residential proxies (millions of home IPs) walk past it | None as a score; high as a block (VPN, Tor, school, library users) | Hard blocks hit assistive and privacy users | ASN is coarse; keep ASN, drop city/lat/long | 0 (already on the request) | 6, 16 |
| `request.cf.botManagement` (score, ja4, signedAgent) | n/a | | | | Not available: only populated with the Bot Management product | 6 |
| IPv6 /64 grouping of rate-limit keys | H / H / H. Closes a free bypass: one /64 holds 2^64 addresses | None | None | A prefix hash identifies less than a full-address hash | Bit-math on the string | 17 |
| Sign-up velocity / anomaly rules | H / M / L-M. Slow agents look like people | False holds in a viral spike, so hold, don't refuse | None | Counters only | D1 counts (already used) | 28 |
| Graduated trust (Discourse TL0-4, Wikipedia autoconfirmed = 4 days + 10 edits) | H / M / M. Costs time, not skill | New members meet limits | Count actions; don't count minutes-on-page (Discourse TL1 needs 10 minutes reading) | Per-user counters | D1 | 18, 19 |
| First-post review queue | H / H / H for what is held, since a person decides | Delay for held posts only | None | Moderators read held posts | Moderator time | 18 |
| Near-duplicate content (simhash / minhash) | H / H / L. An LLM rewrites every post | None | None | 64-bit hash, not text | Hash per post; compare to last 24 h in the Worker | 21 |
| Link and @mention throttles | H / M / M. Limits damage, not entry | Low | None | None | D1 | 18 |
| Account-cluster detection (IP-hash, ASN, time, domain, text) | H / M / M. Needs shared infrastructure or timing | None to users; shared homes/schools risk false flags | None | Needs ~30 days of signals | Nightly query | 16, 28 |
| Phone / SMS verification | M / M / M. Number-resale services and VoIP numbers exist | High | Voice-only excludes deaf users; text-only excludes others | Phone numbers of 13-year-olds | Twilio Verify $0.05 + $0.0083/SMS (US, Aug 2026), plus SMS-pumping risk | 10, 22 |
| Passkeys / WebAuthn | L / L / L. Headless Chrome can register with a virtual authenticator; synced passkeys have no attestation (vendor sources) | Low | W3C praises hardware choice | Credential only | Library + D1 | 10, 23 |
| Proof of personhood (World ID iris etc.) | H in theory | Very high | Excludes people | Regulators in Spain, Germany, Portugal, Brazil, Thailand suspended it or ordered deletion | n/a | 24 |
| Behavioural biometrics (mouse, keystroke) | H / M / L-M | None visible | Keyboard-only, switch, voice, screen-reader users look robotic | Can identify a person; GDPR special-category debate; minors | CPU + storage | 10, 25 |
| Declared-agent headers (`Signature-Agent`, RFC 9421 / Web Bot Auth) | Only agents that announce themselves | None | None | None | Header check | 26 |
| Social vouching | ? / ? / ? No evidence found | Needs friends | Isolated people excluded | Social graph | D1 | none |
| Own image/text/puzzle CAPTCHA, "what is 3+4" | L / L / L | High | Fails the W3C note; math and logic puzzles fail WCAG 3.3.8 | None | n/a | 9-11 |

Turnstile server rules [1][3]: POST `secret`, `response`, `remoteip` to `/turnstile/v0/siteverify`. A token lives 300 s and works once (`timeout-or-duplicate`). Checking `hostname` and `action` is our job (the API does not force it). `metadata.ephemeral_id` is Enterprise only. Free test keys exist (`1x0000...AA` always passes, `2x...` always fails, `3x...` "already spent") [3]. The widget needs `challenges.cloudflare.com` in `script-src` and `frame-src`, so `public/_headers` and the External origins table in `security.md` change together [4].

Not verified (flagged): browser PoW hash rates (we have one secondary figure; measure on the oldest target phone); whether Cloudflare's own limiter groups IPv6 by /64 (docs silent; we do it ourselves, so it doesn't matter); whether `clientTcpRtt` reveals proxies (field exists on TCP only; usefulness untested); which AI agents send `Signature-Agent` (secondary sources only); current Stack Overflow privilege numbers (not retrieved, not copied); Cloudflare DoH MX queries from a Worker (standard `fetch`, not tested); EDPB/ICO position on behavioural biometrics (not found); Turnstile retention periods (see Privacy Addendum, not read in full); Gmail dot/plus aliasing (from memory).

Sources: [1] developers.cloudflare.com/turnstile/get-started/server-side-validation/ · [2] .../turnstile/concepts/widget/ · [3] .../turnstile/troubleshooting/testing/ · [4] .../turnstile/reference/content-security-policy/ · [5] .../turnstile/frequently-asked-questions/ and cloudflare.com/turnstile-privacy-policy/ · [6] developers.cloudflare.com/workers/runtime-apis/request/ (also /workers/platform/limits/: Free 10 ms CPU, 50 subrequests; Paid 30 s default, 10,000)
[8] storyboard18.com/digital/openais-chatgpt-agent-clicks-through-captcha-test-designed-to-block-bots-77483.htm · [9] arxiv.org/abs/2409.08831 · [10] w3.org/TR/turingtest/ · [11] w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html · [12] blog.openreplay.com/honeypot-fields-stop-bots/
[13] capjs.js.org/guide/effectiveness.html · theregister.com/2025/07/09/anubis_fighting_the_llm_hordes/ · altcha.org · [14] github.com/disposable-email-domains/disposable-email-domains (CC0 blocklist; "may no longer be disposable") · [15] developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
[16] github.com/brianhama/bad-asn-list and labs.cloudsecurityalliance.org/research/csa-research-note-residential-proxy-botnet-ecosystem-2026081/ · [17] internetsociety.org/blog/2017/10/ipv6-prefix-assignment-bcop-published-ripe-690/ (RIPE-690: homes get /56)
[18] blog.discourse.org/2018/06/understanding-discourse-trust-levels/ · [19] en.wikipedia.org/wiki/Wikipedia:User_access_levels · [21] www2007.cpsc.ucalgary.ca/papers/paper215.pdf (Manku et al.; patent example f=64, k=3: patents.google.com/patent/US8140505)
[22] twilio.com/en-us/verify/pricing and prelude.so/blog/sms-pumping-solutions (vendor) · [23] mojoauth.com/blog/passkeys-vs-bots-do-they-really-solve-the-human-verification-problem (vendor) · [24] oecd.ai/en/incidents/2024-12-18-5a9e
[25] williamfry.com/knowledge/dont-press-too-hard-use-of-behavioural-biometrics-brings-privacy-issues-under-gdpr/ · [26] workos.com/blog/web-bot-auth-identify-ai-agents (secondary) · [28] owasp.org/www-project-automated-threats-to-web-applications/assets/oats/EN/OAT-019_Account_Creation

## Recommendation: layered defenses

**Roll-out rule:** ship every item in `log` mode first (compute the score, record reason codes, enforce nothing) for two weeks. Mode switch `ANTIBOT_MODE=off|log|enforce`. Calibrate thresholds against real members before enforcing.

### Layer 1 — at sign-up (no account exists yet)
- [on by default] **Turnstile** on sign-up, login, reset, with `action` = `signup|login|reset`; server checks `success`, `hostname`, `action`, passes `remoteip`; if Cloudflare is unreachable, sign-up and reset refuse with "try again" (fail closed); login falls back to the existing per-user/IP limits.
- [on by default] **Signed form token** (one stateless HMAC token `{issued, nonce}` from the form-load call): single-use (nonce in `attempts`), valid 2 hours so slow typists and switch users never lose the form. It carries the honeypot name, the timing and any PoW challenge.
- [on by default] **Honeypot:** one text input named `f` + 6 hex of HMAC(nonce), so the name changes each page load and can't be hard-coded. Never `email`, `website`, `phone`, `address` (browsers autofill them). Wrapper has `aria-hidden="true"`, input has `tabindex="-1"` and `autocomplete="off"`; hidden by a class in the site stylesheet (CSP forbids inline style), off-screen not `display:none`. Filled = refuse with the generic message and add 3 strikes to the /64 key.
- [on by default] **Minimum time:** refuse under 2 s; add 1 risk point from 2 to 6 s. A password-manager user still needs ~4 s for name, birthday and rules box.
- [on by default] **Adaptive proof-of-work, attack mode only:** off normally. Switches on when sign-up attempts exceed 20 per 10 min site-wide or 3 failures per /64 per hour. SHA-256 with 18 leading zero bits (~0.5 s on a desktop, from the Anubis figure), +2 bits per further 20 attempts, ceiling 20 bits (~2 s); 22 bits only if the owner flips a lockdown switch. Runs in a Web Worker served from `/js/pow-worker.js` (same origin, so `script-src 'self'` holds; no `blob:`), shows a polite `aria-live` "checking your browser" line, gives up after 15 s with a retry button. [owner decides: always-on at 16 bits (~0.15 s) — nearly invisible, nearly useless against native solvers]
- [on by default] **Email:** keep the typed address, but compare on a canonical key (lowercase; strip `+tag`; drop dots for gmail/googlemail) so one mailbox = one account. Reject domains on the CC0 disposable list (copy bundled in the repo, refreshed monthly by hand, with an `allow` override file) and domains with no MX or a null MX (NXDOMAIN or RFC 7505 only; DNS timeouts pass). Relay aliases (iCloud Hide My Email, Firefox Relay, SimpleLogin, DuckDuckGo) allowed. [owner decides: block them]
- [on by default] **IPv6 /64:** `ipKey()` currently hashes the whole `CF-Connecting-IP`, so one IPv6 home can mint unlimited "different" IPs. Hash the /64 prefix for IPv6 and keep the 5/hour cap on it; add a looser 15/hour cap per /48.
- [on by default] **Sign-up risk score** (never a block alone): hosting/datacenter ASN +2 (list from bad-asn-list, reviewed quarterly); same /64 signed up in last 24 h +2; ASN has ≥4 sign-ups in 1 h and >3x its 7-day hourly average +2; unfamiliar email domain with ≥2 sign-ups in 24 h +2; form time 2-6 s +1; `httpProtocol` HTTP/1.1 with a browser User-Agent +1; no `Accept-Language` +1. Score 0-2 normal. **3-5 = held** (account made, email verification still required, Layer 2 limits). **6+ = refused** with a page that gives a human contact route. A VPN user (+2) still gets in.
- [on by default] **Declared agents:** a sign-up carrying `Signature-Agent` or `Signature-Input` is refused: "create your account yourself".

### Layer 2 — first actions (account exists, email verified)
- [on by default] **Email verification link opens a page with a "Confirm" button (POST)**, single-use, 24 h. A GET-only link is auto-clicked by mail scanners and would verify bots for us.
- [on by default] **Held accounts:** first 3 posts go to the moderation queue (person sees "waiting for approval", never a silent shadow-ban); max 1 new DM recipient/day and 2 @mentions/day until a moderator clears them or 3 posts are approved.
- [on by default] **Everyone:** max 3 @mentions per post and 10 new DM recipients per day. Text that spells out a link ("example dot com", "example[.]com") counts as a link attempt and gets stripped like one.
- [on by default] **Near-duplicates:** normalise text (lowercase, strip punctuation/emoji); posts of ≥40 words use 64-bit simhash, Hamming distance ≤3 [21]; shorter posts use word-3-gram overlap ≥0.8. Compare against the last 24 h across all accounts. Same account repeating = rejected ("you already posted this"); ≥2 other accounts = all copies held and a cluster flag.
- [on by default] **Step-up:** a held or flagged account must pass a fresh Turnstile before its next post or message.
- [owner decides] **Graduated trust** (needs the owner's approval; the owner did not choose a fixed probation, and this is not one). Two tiers: *new* and *member*. Promotion is automatic by participation, never by calendar alone: email verified + active on 3 different days + 5 posts, comments or reactions that were not removed or reported. A normal person is promoted in about 3 days. *New* limits: 5 posts/hour, 3 DM recipients/day, 2 @mentions/day (blocking and reporting are never limited). Counts only; no minutes-on-page. The cheaper alternative is to apply those limits to held accounts only (already above).
- [owner decides] First 3 posts of every new account reviewed, not only held ones. Costs moderator time (up to ~200 new accounts/day at the cap).

### Layer 3 — ongoing
- [on by default] **Cluster detection** (nightly job): a case opens when two of these hold. ≥3 accounts share a /64 hash within 24 h of sign-up. ≥3 accounts share one non-consumer email domain within 7 days. ≥3 accounts share a hosting ASN within 1 h. ≥2 accounts have near-duplicate posts. ≥3 accounts from one ASN made their first post within 60 s of verifying. Moderators see counts and hashed ids and can clear a cluster with one tap. **Never auto-ban**: homes, schools and phone carriers share addresses.
- [on by default] **Alerts:** a daily line to the owner (sign-ups, held, refused, honeypot trips, Turnstile failures, PoW mode flips); an alert when sign-ups exceed 3x the 7-day median.
- [on by default] **Reports:** 3 reports from 3 different accounts in 24 h hides the item pending review (if not already so).
- [on by default] **Upkeep:** refresh the disposable and ASN lists each quarter; review thresholds against the weekly numbers in "How we'll test it".
- [owner decides] **Social vouching** (an established member can vouch for a new one to skip *new* limits). Thin evidence, close to the invite codes the owner passed on, and friends can vouch for each other's bots. Not recommended now.

## What we will NOT do and why
- **Phone/SMS verification.** About $0.06 per sign-up, resold numbers and VoIP numbers get through, SMS pumping can run up a bill, voice-only fails deaf users, and it means holding phone numbers of 13-year-olds.
- **Proof of personhood, iris scans, ID or selfie checks.** Regulators in Spain, Germany, Portugal, Brazil and Thailand suspended World or ordered deletion [24]; it excludes people; minors.
- **Mouse/keystroke behavioural biometrics of our own.** Keyboard-only, switch, voice and screen-reader users look "robotic", and such data can identify a person [25]. Turnstile does its own and Cloudflare carries that.
- **Device fingerprinting (canvas, audio, fonts) or storing raw IPs and full User-Agents.** Stable device IDs track people, which cuts against the site's purpose and the UK Children's Code approach to minors.
- **Our own image, text, math or puzzle CAPTCHA.** AI beats them and they fail WCAG 3.3.8 and the W3C note.
- **Hard-blocking VPN, Tor, hosting ASNs or countries.** Scores only.
- **Silent shadow-bans.** Anything held is shown as "waiting for approval" so an honest person can appeal.
- **Auto-banning on a cluster alone**, or **passkeys as a human check** (they prove a device, not a person; offer them later as a login feature).
- **Invite codes and a calendar-based probation.** The owner's call; not proposed.

## Data we'd store and for how long

| Data | Why | Kept |
|---|---|---|
| Salted hash of IP (IPv6: the /64) in `attempts`, rate-limit keys, form-token nonces | caps, single-use tokens | 2 days (existing purge) |
| `signup_signals` row: user id, /64 hash, ASN number, email domain, browser family, form-time bucket, score and reason codes | held-account review, clusters | 30 days, then deleted; if a case is open, until closed + 30 days |
| `held` flag on the account | applies Layer 2 limits | until cleared or promoted; reason codes follow the 30-day rule |
| Post fingerprints (64-bit simhash + 3-gram sketch, no text) | duplicate checks | 7 days, or sooner if the post is deleted |
| Cluster case: id and member user ids | moderation | until closed + 30 days |
| Turnstile token / `ephemeral_id` | n/a | not stored by us (token is checked once; `ephemeral_id` is Enterprise only) |
| Never stored | raw IPs, full User-Agent, canvas/audio fingerprints, mouse/keyboard data, phone numbers, ID documents, city/lat/long | — |

Notes: treat IP hashes as personal data (pseudonymous). Purpose limited to abuse prevention; nothing here feeds recommendations or ads (UK Children's Code: profiling off unless there is a compelling reason; security is the reason). The privacy policy must name Turnstile/Cloudflare and these signals. Moderators see hashes and counts, not addresses.

## How we'll test it

A bot simulator in `test/bots/` (Node + Playwright), run against `wrangler dev` with Turnstile's always-pass test keys so only the in-house layers are measured; `request.cf` can't be forged locally, so `scoreSignup(signals)` is a pure function unit-tested with injected ASN, protocol, timing. Real-key runs happen manually on a staging host we own, small N, never on someone else's site.
- **A1 direct API:** no token, replayed, expired, other form's token, Turnstile test "already spent" key. Success: 100% refused, 0 accounts.
- **A2 form-filler that fills every input:** ≥99% stopped by honeypot. **A3 filler that skips the honeypot:** instant submit ≥99% stopped by timing; with a 3 s sleep, ≥95% refused or held when scored as hosting ASN + repeat /64.
- **A4 headless Chromium (Playwright with stealth plugins), 100 runs:** in-house layers contain ≥90% (refused, or held before any public post). Separately, 20 real-key staging runs to record the Turnstile pass rate (a measurement, not a pass/fail).
- **A5 LLM browser agent** (told to make accounts and post promotion), 20 runs: ≥70% contained, 0 public spam posts from held accounts, a cluster alert fires when ≥3 runs share an ASN. We expect Turnstile and honeypot to pass; report which layer caught each run.
- **A6 IPv6:** 100 sign-ups from random addresses in one /64: at most 5 accounts exist. Unit tests for `::` compression and IPv4-mapped addresses.
- **A7 duplicates:** 50 spam variants over 10 accounts: ≥80% caught for exact or light edits; LLM paraphrases are recorded, not a failure. **A8 email:** top 20 disposable domains 100% refused; gmail, outlook, icloud, proton, fastmail, a .edu and relay-alias addresses 0% refused.
- **Real-person journeys, a release gate (100% pass, every deploy):** (1) desktop with password-manager fill in ~4 s; (2) keyboard-only plus a screen reader (NVDA, VoiceOver): the honeypot is never focused or announced (manual check before enabling); (3) a 25-minute fill, token still valid, values kept; (4) phone with 6x CPU throttle in attack mode: PoW finishes under 5 s with a status line; (5) VPN/hosting ASN user gets in (+2 only); (6) four students on one school IP in an hour all pass, the sixth gets a clear "try again at HH:MM"; (7) Gmail dots/plus and iCloud-relay addresses; (8) back-button resubmit or expired token gets a fresh token automatically, no dead end.
- **Production, weekly:** held ≤5% of sign-ups, refused ≤0.5%; moderators label every held account, and ≥80% should be bots or spam. If less, loosen the weights before adding more rules.

## Open questions for the owner
1. Approve the "on by default" items as a set, or strike individual ones?
2. Graduated trust (*new* → *member* by participation): yes, no, or held accounts only?
3. First-post review: held accounts only (default), or every new account?
4. Disposable email: refuse (default) or allow-but-hold? Relay aliases (Hide My Email, Relay): allowed (default) or blocked?
5. Proof-of-work: attack-mode only (default) or always on? Longest wait you'll accept (we say about 2 s, 15 s cap)?
6. Is a determined attacker with a real mailbox and residential proxies, who gets in but is held, limited and spotted within a day, an acceptable worst case?
7. Who reviews held accounts and clusters, and what is the contact route for someone refused?
8. Keep sign-up signals 30 days? Does anyone need legal review (EU consent age for minors varies 13-16 by country; UK Children's Code)?
9. Plan: Free gives 10 ms CPU per request; confirm Workers Paid before turning on simhash, PoW verify and nightly clusters.
