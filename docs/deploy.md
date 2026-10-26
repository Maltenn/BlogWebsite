# Deploy

OurSpace is one Cloudflare Worker with one D1 database and one R2 bucket (members' photos). Deploy it with Wrangler, not GitHub Pages: the site needs the Worker for its API, and Pages can't run it. If this repo is replacing the old desktop site at ourspace.page, read [Cutover from the desktop site](#cutover-from-the-desktop-site) before you merge anything.

## First deploy

```bash
npx wrangler login
npx wrangler d1 create ourspace-social-db                   # paste the printed database_id into wrangler.jsonc
npm run db:remote                                           # tables on the real database
npx wrangler r2 bucket create ourspace-social-media         # members' photos (the MEDIA binding in wrangler.jsonc)
openssl rand -hex 32    | npx wrangler secret put IP_SALT   # salts the IP hashes used for rate limits
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY # encrypts stored Spotify tokens. Don't lose or change it
npm run deploy                                              # prints https://ourspace-social.<account>.workers.dev
```

This creates a Worker called `ourspace-social`, a database called `ourspace-social-db` and a bucket called `ourspace-social-media`. R2 has to be switched on for the account once, on the dashboard's R2 page (it may ask for a payment method even for the free tier). The bucket stays private: the Worker serves its files at `/media/<key>` to whoever may see them, so don't give it a public `r2.dev` address or a custom domain of its own. After that, `npm run deploy` alone ships changes, and `npm run db:remote` applies new files in `migrations/`.

The email sign-up works with just the steps above. Everything below is optional, and each piece switches itself on once its secrets are set.

## Custom domain

To give the Worker a real address, add a custom domain to it in the Cloudflare dashboard (the Worker's Settings, under Domains & Routes), for example `social.ourspace.page` while you test, or `ourspace.page` itself at the cutover. Cloudflare needs the domain's DNS to be on Cloudflare for this. Do it **before** registering the sign-in apps and Spotify below, because their redirect addresses include the host.

## Photos: CSAM detection (launch: in-house review)

**Status: decided.** Launch with in-house moderation: members' photos are skimmed in the Moderation page's Photos queue, a `csam` report holds a post's photos at once, and the 48-hour clocks are on screen ([operations.md](operations.md#daily-routine)). Nothing checks photos against known CSAM automatically. That costs nothing and gives decent consistency for a small site, but it only catches what a person sees. **Upgrade when the site grows** (the options below, in order of effort): apply for Microsoft PhotoDNA Cloud or the Google Content Safety API (free to approved organisations; approval takes time; covers every photo, private ones included; needs code on upload), or serve public photos through a cached R2 custom domain so Cloudflare's free CSAM Scanning Tool sees them (no approval; public photos only; needs code and cache purges).

Cloudflare's [CSAM Scanning Tool](https://developers.cloudflare.com/cache/reference/csam-scanning/) checks images *as they enter Cloudflare's cache* on a zone. The Worker streams photos from R2 itself (`GET /media/<key>`, so it can check who may see each one), and those responses most likely never enter the cache, so switching the tool on for the domain would probably scan nothing. That's unverified either way: don't count on it until a test shows otherwise. The options for the upgrade:

1. **Public photos through the cache.** Serve photos that anyone may see (open profiles, boards, pictures) from an [R2 custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains) on the zone (for example `img.ourspace.page`), which does go through the cache, and turn the tool on for that zone. This needs code: those photos' URLs, the pages' `img-src` in `public/_headers`, and private and loose photos still going through the Worker (they'd stay unscanned). Removing or hiding a photo then also needs a cache purge, and a public bucket domain serves any key it's asked for, so private photos must never be put there.
2. **A hash-matching service** called on upload (for example Microsoft PhotoDNA or Thorn Safer: eligibility, cost and terms unverified), which covers every photo, private ones included.
3. **Manual review only**: reports and moderators. The law doesn't require scanning (18 U.S.C. 2258A(f)), but nothing would be caught until someone reports it.

Whatever is chosen, the duties stay the site owner's: report apparent CSAM to NCMEC once you know of it, keep the report for a year, and act on Take It Down requests within 48 hours ([operations.md](operations.md#photos)). Neither the tool nor a vendor files the NCMEC report for you unless their terms say so.

## Emails: confirming new accounts, password resets

Make a free [Resend](https://resend.com) account, verify a sending domain (for example `ourspace.page`), and then:

```bash
npx wrangler secret put RESEND_API_KEY     # re_…
npx wrangler secret put MAIL_FROM          # OurSpace <no-reply@ourspace.page>
```

Every new email account gets a "confirm your OurSpace email" link and can't post, comment, message or follow until it's confirmed, so **email sign-ups are refused (503) until these are set**; sign-ups through Google & co. still work (the provider vouched for the address; one that vouches for none, like Microsoft, is held for a moderator). Without them the forgot-password page also says email isn't set up. It never pretends a message went out. Resend's free tier (100 emails a day, 3,000 a month at the time of writing) covers the 200-a-day sign-up cap only if a good share of sign-ups use the providers; check the current limits.

## The human check: Cloudflare Turnstile

Sign-up, log in and "forgot my password" show Cloudflare's "verify you are human" widget (free). In the dashboard: **Turnstile → Add widget**, the site's hostname(s), mode **Managed**. Then:

- put the **site key** (public) in `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`;
- `npx wrangler secret put TURNSTILE_SECRET_KEY` with the **secret key**;
- if the site answers on more than one hostname (workers.dev and the domain), set `TURNSTILE_HOSTNAMES` (comma-separated) so the hostname check accepts each.

Until both are set, **email and provider sign-ups and password resets are refused** on a real server ("the human check isn't set up"); log in still works. Turnstile's widget needs `https://challenges.cloudflare.com` in the pages' CSP (`script-src`, `frame-src`; [security.md](security.md#external-origins)). The tests and the demo use Cloudflare's published test keys (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`) against a stand-in for siteverify, so they never reach Cloudflare.

## AI-writing detection (off by default) and the evaluation gate

`AI_DETECTOR` (a var) picks the detector ([decisions/002](decisions/002-ai-writing-detection.md), `src/ai/detect.js`): `off` (the default), `workersai` (Cloudflare Workers AI's free allocation), `pangram` (`PANGRAM_API_KEY` secret) or `gptzero` (`GPTZERO_API_KEY` secret). It scores public posts of 100+ words (blog posts 150+) after they're published; never DMs or chat. `AI_ENFORCEMENT` says what happens: `shadow` (the default: scores go to the moderators' list, nobody is struck) or `enforce` (the strike ladder: [architecture.md](architecture.md#ai-writing-strikes)).

- **Workers AI** has no AI-text classifier and no documented token log-probabilities, so what it can do is ask an instruction model to judge (`AI_DETECTOR_MODEL`, default `@cf/meta/llama-3.1-8b-instruct`). Research finds that unreliable; expect it to fail the gate below and keep it in shadow mode. It needs the `ai` binding (commented out in `wrangler.jsonc`, because the binding needs a Cloudflare login even for `wrangler dev`, which would stop the tests and the demo running offline).
- **Pangram / GPTZero**: the adapters follow the field names decision 002 read in their docs and haven't been checked against a live key. Run the harness first; it shows every answer.

**Before switching `AI_ENFORCEMENT` to `enforce`, run the evaluation harness and get a PASS:**

```bash
AI_DETECTOR=pangram PANGRAM_API_KEY=… node tools/eval-detector.mjs
```

It runs the detector over `eval/human/*.txt` (people's writing) and `eval/ai/*.txt` (AI writing) through the same cleaning and length rule as the site, and prints the confusion matrix, the false-positive rate on human text and the AI catch rate with Wilson 95% intervals. **PASS means the upper end of the false-positive interval is at or under 1%**, which takes 300+ human texts with no false positives (the starter corpus has about 30, so it always fails: [eval/README.md](../eval/README.md) says how to grow it). Then run 2–4 weeks in shadow mode and read the moderators' AI scans list before enforcing, as decision 002 plans.

## Proof of work and the sign-up form

`POW_BITS` (default 18) is how hard the sign-up's proof of work is: about 2^18 SHA-256 hashes, 1–2 seconds in a normal browser. Every 2 more bits is 4× the work. `SIGNUP_MIN_MS` (2000) and `SIGNUP_SOFT_MS` (6000): a form sent sooner than the first is refused, sooner than the second adds a risk point. The form token is signed with `TOKEN_KEY`.

## Other sign-in options

A provider's button appears under **Other options** only once its secrets are set. For every provider, the redirect (callback) address to register is:

```
https://<your host>/api/oauth/<provider>/callback      e.g. https://ourspace.page/api/oauth/google/callback
```

| Provider | Where | Secrets |
|---|---|---|
| Google | [Google Cloud console](https://console.cloud.google.com/apis/credentials). Set up the OAuth consent screen, then create an OAuth client ID of type *Web application* with the redirect address above. | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft | [Entra admin center → App registrations](https://entra.microsoft.com/). Pick *any organizational directory and personal Microsoft accounts*, add a *Web* redirect, then create a client secret under *Certificates & secrets*. It expires, so put a renewal in the calendar. | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| Discord | [Discord Developer Portal](https://discord.com/developers/applications). New application, then OAuth2, then add the redirect. | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| GitHub | [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers). An OAuth app has one callback address, so make a second app for local testing. | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Apple | Needs the paid Apple Developer Program. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), create an App ID with *Sign in with Apple*, then a **Services ID** (this is the client ID) with your domain and the return URL. Then create a **key** with Sign in with Apple and download the `.p8`. Apple only accepts https addresses, so it can't be tried on `127.0.0.1`. | `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the whole `.p8` file) |

Set each with `npx wrangler secret put NAME`. For the Apple key, use `npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXX.p8`.

**Branding rules.** Before launch, check each company's button branding rules ([Google](https://developers.google.com/identity/branding-guidelines), [Apple](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple), [Microsoft](https://learn.microsoft.com/entra/identity-platform/howto-add-branding-in-apps)). The buttons here are styled to match the site and use a letter instead of each company's logo. Google and Apple in particular expect their own logos and wording.

How accounts and providers fit together is in [security.md](security.md).

## Spotify (everybody's top songs)

**Read this first.** Since February 2026, a Spotify app in *Development Mode* can only be used by people its owner adds by hand in the developer dashboard. There's a maximum of **5 people**, and the owner needs Spotify Premium. Spotify only lifts the cap ("extended quota") for registered organizations with at least 250,000 monthly active users. So on day one, only you and up to four friends can connect. Anyone else is told Spotify said no (development mode) and to ask a moderator to add them, and nothing is stored for them. The feature is fully built for everyone, but Spotify's rules decide who can use it. Sources:

- [Spotify for Developers blog, July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
- [TechCrunch, Feb 2026](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)
- [Spotify community update thread](https://community.spotify.com/t5/Spotify-for-Developers/February-2026-Spotify-for-Developers-update-thread/m-p/7361273/highlight/true)

**Reuse the Spotify app the desktop site used** rather than making a new one. Spotify postponed its endpoint restrictions for integrations that already existed, while new apps get the smaller endpoint list, which may not include top tracks. Adding a redirect address to it doesn't change anything for the desktop site while that is still live. Its client secret must be rotated, but not before the cutover: see step 8 of the cutover checklist below.

1. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open that app and add the redirect `https://<your host>/api/oauth/spotify/callback`. For local testing also add `http://127.0.0.1:8787/api/oauth/spotify/callback`. Spotify accepts loopback IPs but not `localhost`.
2. Under **User Management**, add each person (name + the email on their Spotify account).
3. Set the secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (and `TOKEN_KEY` from above).

People connect from **Settings → Spotify**. They choose the time range (last 4 weeks, 6 months, all time) and whether their page shows the songs, and can disconnect at any time. Only the `user-top-read` permission is asked for. Album art comes from Spotify. When Spotify has no 30-second preview, one is looked up from the iTunes Search API.

## Vars and secrets

Vars are plain settings in `wrangler.jsonc`:

| Var | Default | What |
|---|---|---|
| `MIN_AGE` | `13` | Birthdays younger than this can't sign up. The browser is then refused for 24 hours, so changing the date doesn't get around it. |
| `SIGNUPS_PER_DAY` | `200` | Site-wide cap on new accounts per day. |
| `SIGNUPS_PER_IP_PER_HOUR` | `5` | Per connection. |
| `TURNSTILE_SITE_KEY` | empty | Turnstile's public site key. Empty: sign-ups and password resets are refused on a real server. |
| `TURNSTILE_HOSTNAMES` | the request's host | The hostnames a Turnstile answer may name (comma-separated). |
| `POW_BITS` | `18` | The sign-up proof of work's difficulty. |
| `SIGNUP_MIN_MS`, `SIGNUP_SOFT_MS` | `2000`, `6000` | A sign-up form sent sooner is refused / gets a risk point. |
| `AI_DETECTOR` | `off` | `off`, `workersai`, `pangram` or `gptzero` (`mock` is for the tests and the demo). |
| `AI_DETECTOR_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | The Workers AI model asked to judge. |
| `AI_ENFORCEMENT` | `shadow` | `shadow` or `enforce` (only after the evaluation harness passes). |

Secrets are set with `npx wrangler secret put NAME`, never written to a file in the repo:

| Secret | Needed for |
|---|---|
| `IP_SALT`, `TOKEN_KEY` | Always. |
| `RESEND_API_KEY`, `MAIL_FROM` | Emails: confirming new accounts (email sign-ups are refused without them), password resets. |
| `TURNSTILE_SECRET_KEY` | The human check (sign-ups and resets are refused without it). |
| `PANGRAM_API_KEY` or `GPTZERO_API_KEY` | An AI-writing detector, if `AI_DETECTOR` names it. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify. |
| `GOOGLE_*`, `MICROSOFT_*`, `DISCORD_*`, `GITHUB_*` (`CLIENT_ID`, `CLIENT_SECRET`), `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Other sign-in options. |

The same list is in the comment at the top of `wrangler.jsonc`; when a feature that needs new secrets is added, update both. `TEST_PROVIDER_BASE` is not a setting: it is for the tests and the demo, and must never be set on a real deployment ([development.md](development.md)). The same goes for `TEST_SIGNALS` (it lets a request claim its own address and network with `X-Test-Ip` / `X-Test-Cf`, and its AI enforcement mode with `X-Test-Enforcement`), `TURNSTILE_VERIFY_URL` and `DOH_URL`.

## Cutover from the desktop site

Merging this branch (`claude/intelligent-fermat-keh09f`) into `main` is what retires the desktop site. GitHub Pages deploys `main`'s root, which would then have no `index.html`, and the `CNAME` file (`ourspace.page`) is gone too. So the order matters:

1. **Deploy the Worker** ([First deploy](#first-deploy)) and try it on its `workers.dev` address: sign up, post (a photo too), log out and in. This creates a new Worker, database and bucket and changes nothing about ourspace.page.
2. **Switch on what you want from day one**: Resend, the sign-in apps and Spotify. Register their redirect addresses with the final host, `https://ourspace.page/api/oauth/<provider>/callback`.
3. **Point ourspace.page at the Worker.** Add `ourspace.page` as a custom domain on the Worker ([Custom domain](#custom-domain)). If its DNS isn't on Cloudflare yet, move it there first, and remove the DNS records that point at GitHub Pages. Do the same for `www.ourspace.page`: today it is a CNAME to `maltenn.github.io`, so either add it as a second custom domain on the Worker or redirect it to the apex (a Cloudflare redirect rule). Wait until both `https://ourspace.page` and `https://www.ourspace.page` show the new site. Photos launch with [in-house review](#photos-csam-detection-launch-in-house-review): make sure a moderator is signed up and knows the [daily routine](operations.md#daily-routine).
4. **Claim `malten`**, then make yourself a moderator ([operations.md](operations.md)).
5. **Disable GitHub Pages** in the repo's settings (Settings → Pages). Do this after step 3, or the site goes dark in between, and before step 6.
6. **Merge the branch into `main`.**
7. **Old backends stay up.** The old `ourspace-api` Worker and `ourspace-db` D1 database (the old site's guestbook) keep running until you remove them separately in the Cloudflare dashboard. Nothing in this repo uses them any more.
8. **Rotate the Spotify client secret.** It appeared in the old site's pre-rebuild git history (a local-only branch). Make a new one in the Spotify developer dashboard, then `npx wrangler secret put SPOTIFY_CLIENT_SECRET`. The old `ourspace-api` Worker refreshes its own Spotify token with the same secret, so rotating breaks the desktop site's Top Songs: do it once that Worker is retired, or also run `npx wrangler secret put SPOTIFY_CLIENT_SECRET --name ourspace-api`.

If you need the old site's files back, see [history.md](history.md).
