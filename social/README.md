# OurSpace, the social network (`social/`)

A reformed copy of the site: just OurSpace and the blog, no Windows 98 desktop, real accounts, and no bots.

- **Real people only.** There are no bot accounts, and nothing posts on anyone's behalf. Requests and Inbox only ever hold things from people.
- **Sign up with an email and a password** (the default tab), or under **Other options** with Google, Apple, Microsoft, Discord or GitHub. Every way in asks for a screen name and a **birthday**.
- **Birthdays keep it 13+** and give everyone their **star sign**. The birthday itself stays private. People choose whether their page shows their age and their sign.
- **Public profiles** at `/u/<name>` that anyone can view, with statuses, wall comments, bulletins, blog entries, friend requests, Top 8, private messages and a shared feed.
- **Everyone can connect their own Spotify.** Their page then shows their top songs, with previews (see the Spotify limit below before relying on it).
- **Daily horoscopes, written from the real sky.** There's a reading of today's sky for everybody, a horoscope for each sign, and a personal reading for each member that also compares today's planets with the sky on the day they were born.
- **Pages are decorated** with the original Edit My Page choices: 231 preset pictures, 10 color themes, 15 background tiles, fonts, decor gifs and 88x31 buttons.
- **Block and Report** sit on every profile, post, comment and message. Admins get a moderation queue.
- **malten's essays** are republished verbatim under `/blog/`.
- **Forgot my password** sends a one-hour reset link by email.

The original site is untouched: the repo root, live at ourspace.page on GitHub Pages, along with `worker/` and its `ourspace-db`. That includes its guestbook, which this copy never had. This folder is self-contained, with its own Worker, its own database and its own copies of the images it uses.

## Try it on your computer (the demo)

One command starts the whole site on your own computer, already filled with sample people, posts, friend requests and messages. Nothing in it is real or online, and it can't touch the live site.

You need [Node.js](https://nodejs.org) 22 or newer and [git](https://git-scm.com). Then, in a terminal:

```bash
git clone https://github.com/Maltenn/BlogWebsite.git      # (skip if you already have it)
cd BlogWebsite
git fetch origin
git checkout claude/intelligent-fermat-keh09f
git pull
cd social
npm install
npm run demo
```

When it says **ourspace demo is running**, open **http://127.0.0.1:8787** in your browser.

| Log in as | Email | Password | Who |
|---|---|---|---|
| you | `you@example.com` | `ourspace-demo` | `the_reviewer`, a regular member with friend requests and messages waiting |
| the moderator | `malten@example.com` | `ourspace-demo` | `malten`, sees the **Moderation** tab with a sample report |
| anyone else | `kat@`, `jules@`, `drew@`, `pete@`, `mia@` or `banana@example.com` | `ourspace-demo` | the sample members, to see the site from their side |

How the demo differs from the real site:

- **Sign-in and Spotify go to pretend pages.** "Continue with Google" (or Apple, Microsoft, Discord, GitHub) and "connect Spotify" open a page labeled *local demo: not the real Google*. Type any name to continue; the same name brings back the same pretend account. Cancel works too. On Spotify's pretend page you can tick a box to see what people outside the 5-person allowlist are told.
- **Pretend Spotify has no album covers** (grey squares). The 30-second previews are real ones from Apple when your computer can reach the iTunes Search API.
- **"Forgot my password" emails** appear in the terminal window running the demo. Copy the link from there.
- **Your changes stick** between runs: the data lives in `social/.demo/`. `npm run demo -- --fresh` starts over with just the sample content.
- **Editing works live.** Change a file in `public/` or `src/` and refresh the browser.

Stop it with **Ctrl+C**. If port 8787 is already taken, it picks the next free one and prints the address.

## How it works

```
one Cloudflare Worker "ourspace-social" (same origin for pages and API, so the login cookie is HttpOnly + SameSite=Lax)
 ├── public/      the pages: index.html + app.js (single-page app), app.css, blog/, assets/   (Workers static assets)
 ├── /api/*       src/index.js → auth, oauth, profiles, social, messages, safety, spotify, horoscope
 ├── D1 "ourspace-social-db"   migrations/0001_init.sql (users, profiles, sessions, identities, oauth_states,
 │                             oauth_signups, password_resets, spotify, friendships, posts, messages, blocks,
 │                             reports, mod_log, attempts)
 └── cron */30    housekeeping: expired sessions, sign-in tickets, reset links, old rate-limit rows
```

| Path | What |
|---|---|
| `src/index.js` | Router, the cross-site check on writes, the cron. Every route is listed at the top. |
| `src/auth.js` | Email sign-up (birthday age check, name rules, per-IP and daily caps), log in by email or screen name (throttled), sessions, forgot/reset password, password change, account deletion. PBKDF2-SHA256 passwords. |
| `src/oauth.js` | "Other options" sign-in (Google, Apple, Microsoft, Discord, GitHub), linking and unlinking them in Settings, and the Spotify connection. Authorization code flow with PKCE (Apple uses a signed client secret instead). |
| `src/spotify.js` | Each person's Spotify: tokens (stored encrypted), their top songs (cached for 6 hours), and previews from iTunes when Spotify has none. |
| `src/astro.js` | The astronomy: where the Sun, Moon and planets are on a given day (`astronomy-engine`), sign changes, retrogrades, Moon phases, aspects, star signs from birthdays, birth placements. Numbers only. |
| `src/horoscope.js` | The words: today's sky, each sign's horoscope, personal readings. |
| `src/profiles.js` | Public profiles, Browse, Edit My Page validation (only values from `src/options.js` are accepted), wall/message privacy, show age / show sign. |
| `src/social.js` | Friend requests, wall comments, statuses, bulletins, blog entries, deleting posts, the feed. |
| `src/messages.js` | Private messages. |
| `src/safety.js` | Blocks, reports (with a snapshot of the reported text), the moderation actions and log. |
| `src/seal.js` | AES-GCM encryption for the tokens we have to keep (`TOKEN_KEY`). |
| `src/mail.js` | Email through Resend (password resets only). |
| `src/text.js` | Text cleaning: invisible characters, links removed, the blocked-word list (whole words). |
| `src/options.js` | Every choice Edit My Page offers. The page and the server read the same list. |
| `src/generated/avatars.js` | The picture presets, **generated**. |
| `tools/build.mjs` | Regenerates `src/generated/`, copies images into `public/assets/` and republishes the essays into `public/blog/` from the original site. |
| `public/app.js` | The whole front end. User text only ever reaches the page through `textContent`. |
| `public/_headers` | Content-Security-Policy and other security headers for the pages. |
| `test/api.test.mjs` | 26 end-to-end API tests against a throwaway local Worker. |
| `test/astro.test.mjs` | 4 tests of the astronomy against known ephemeris dates. |
| `test/mock-providers.mjs` | A stand-in for every sign-in provider, Spotify and iTunes, used by the tests and the demo. |
| `tools/demo.mjs` | `npm run demo`: the site on your computer with sample content and pretend sign-in pages. |

## Run it locally

```bash
cd social
npm install
npm run db:local       # create the tables in wrangler's local database (once)
npm run dev            # http://127.0.0.1:8787
npm test               # all tests (they start their own Worker on a fresh database, plus the stand-in providers)
```

If you ran the earlier version of this folder (the one with bots): the schema was rewritten in place, so start the local database over with `rm -rf .wrangler/state && npm run db:local`.

Locally you don't need any secrets to sign up with email. **Forgot my password** prints the reset link in the `npm run dev` terminal instead of sending an email.

To try the sign-in buttons and Spotify without real apps, use `npm run demo` (above). It runs the stand-in providers from `test/mock-providers.mjs` and points the site at them through `TEST_PROVIDER_BASE`. **Never set `TEST_PROVIDER_BASE` on a real deployment.** It sends every sign-in to whatever server it names.

Re-run `npm run build` (from `social/`) after editing the original site's `content-src/` or adding a picture to `src/options.js`.

## Deploy it (first time)

This creates a **new** Worker and a **new** database. It does not touch `ourspace-api`, `ourspace-db`, GitHub Pages or the ourspace.page DNS.

```bash
cd social
npx wrangler login
npx wrangler d1 create ourspace-social-db                   # paste the printed database_id into wrangler.jsonc
npm run db:remote                                           # tables on the real database
openssl rand -hex 32    | npx wrangler secret put IP_SALT   # salts the IP hashes used for rate limits
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY # encrypts stored Spotify tokens. Don't lose or change it
npm run deploy                                              # prints https://ourspace-social.<account>.workers.dev
```

After that, `npm run deploy` alone ships changes, and `npm run db:remote` applies new files in `migrations/`. To give it a real address, add a custom domain to the Worker in the Cloudflare dashboard (for example `social.ourspace.page`). Do this **before** registering the sign-in apps below, because their redirect addresses include the host. Moving ourspace.page itself over means changing its DNS away from GitHub Pages, so do that only once you're ready to retire the desktop site.

The email sign-up works with just the steps above. Everything below is optional, and each piece switches itself on once its secrets are set.

### Password reset emails

Make a free [Resend](https://resend.com) account, verify a sending domain (for example `ourspace.page`), and then:

```bash
npx wrangler secret put RESEND_API_KEY     # re_…
npx wrangler secret put MAIL_FROM          # OurSpace <no-reply@ourspace.page>
```

Without these, the forgot-password page says email isn't set up. It never pretends a message went out.

### Other sign-in options

A provider's button appears under **Other options** only once its secrets are set. For every provider, the redirect (callback) address to register is:

```
https://<your host>/api/oauth/<provider>/callback      e.g. https://social.ourspace.page/api/oauth/google/callback
```

| Provider | Where | Secrets |
|---|---|---|
| Google | [Google Cloud console](https://console.cloud.google.com/apis/credentials). Set up the OAuth consent screen, then create an OAuth client ID of type *Web application* with the redirect address above. | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft | [Entra admin center → App registrations](https://entra.microsoft.com/). Pick *any organizational directory and personal Microsoft accounts*, add a *Web* redirect, then create a client secret under *Certificates & secrets*. It expires, so put a renewal in the calendar. | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| Discord | [Discord Developer Portal](https://discord.com/developers/applications). New application, then OAuth2, then add the redirect. | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| GitHub | [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers). An OAuth app has one callback address, so make a second app for local testing. | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Apple | Needs the paid Apple Developer Program. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), create an App ID with *Sign in with Apple*, then a **Services ID** (this is the client ID) with your domain and the return URL. Then create a **key** with Sign in with Apple and download the `.p8`. Apple only accepts https addresses, so it can't be tried on `127.0.0.1`. | `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the whole `.p8` file) |

Set each with `npx wrangler secret put NAME`. For the Apple key, use `npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXX.p8`.

Before launch, check each company's button branding rules ([Google](https://developers.google.com/identity/branding-guidelines), [Apple](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple), [Microsoft](https://learn.microsoft.com/entra/identity-platform/howto-add-branding-in-apps)). The buttons here are styled to match the site and use a letter instead of each company's logo. Google and Apple in particular expect their own logos and wording.

How accounts and providers fit together:

- **First time with a provider:** the person picks a screen name and enters their birthday (`/join/finish`), the same as an email sign-up.
- **Already a member:** they connect more ways in under **Settings → sign-in methods**, and can remove any of them as long as one is left (a password counts as one).
- **No automatic merging by email.** If a provider says the address already belongs to an account, the person is told to log in with that account and connect the provider from Settings. That stops anyone from taking over an account by registering its email address with another service. Microsoft addresses are never trusted for this, because Microsoft doesn't promise they were checked.
- **Accounts without a password:** they log in only through their providers. To delete the account, they type their screen name to confirm.

### Spotify (everybody's top songs)

**Read this first.** Since February 2026, a Spotify app in *Development Mode* can only be used by people its owner adds by hand in the developer dashboard. There's a maximum of **5 people**, and the owner needs Spotify Premium. Spotify only lifts the cap ("extended quota") for registered organizations with at least 250,000 monthly active users. So on day one, only you and up to four friends can connect. Anyone else is told Spotify said no (development mode) and to ask a moderator to add them, and nothing is stored for them. The feature is fully built for everyone, but Spotify's rules decide who can use it. Sources:

- [Spotify for Developers blog, July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
- [TechCrunch, Feb 2026](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)
- [Spotify community update thread](https://community.spotify.com/t5/Spotify-for-Developers/February-2026-Spotify-for-Developers-update-thread/m-p/7361273/highlight/true)

**Reuse the Spotify app the live site already has** rather than making a new one. Spotify postponed its endpoint restrictions for integrations that already existed, while new apps get the smaller endpoint list, which may not include top tracks. Adding a redirect address to it doesn't change anything for the live site.

1. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open that app and add the redirect `https://<your host>/api/oauth/spotify/callback`. For local testing also add `http://127.0.0.1:8787/api/oauth/spotify/callback`. Spotify accepts loopback IPs but not `localhost`.
2. Under **User Management**, add each person (name + the email on their Spotify account).
3. Set the secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (and `TOKEN_KEY` from above).

People connect from **Settings → Spotify**. They choose the time range (last 4 weeks, 6 months, all time) and whether their page shows the songs, and can disconnect at any time. Only the `user-top-read` permission is asked for. Album art comes from Spotify. When Spotify has no 30-second preview, one is looked up from the iTunes Search API.

## Horoscopes: how they work

- **Star signs** come from the birthday: the sign the Sun was in on that day. If the Sun changed sign that day (a cusp birthday), their personal reading mentions the other sign too.
- **Today's sky** (`/horoscope`, for everybody) is computed for the reader's own local day. It covers where the Sun, Moon and planets are (tropical zodiac), the Moon's phase and any New or Full Moon, which planets are retrograde and when they turn direct, planets changing sign or stationing today, and the major aspects between them. All of it is computed with [`astronomy-engine`](https://github.com/cosinekitty/astronomy), not looked up from a list. `test/astro.test.mjs` checks it against known dates, for example the Sun entering Scorpio on 23 October 2026 and Mercury turning retrograde on the 24th.
- **Each sign's horoscope** (`/horoscope/<sign>`) reads that same sky through "solar houses": whole signs counted from the person's Sun sign, the method newspaper horoscopes use. The same sky therefore reads differently for every sign. It covers what the Moon is lighting up today, the month's theme from the Sun, the Moon phase, retrogrades, a lucky number and color, a mood, and a do and a don't.
- **The personal reading** (logged in) adds the person's birth chart: where the Sun, Moon, Mercury, Venus, Mars and the rest were on their birthday (at noon, since we don't ask for a birth time). Today's planets are then compared against those positions ("transits"). On their birthday it says so.
- A reading is seeded by the date and sign (and person), so it stays the same all day and changes the next. It's for fun, and the horoscope page says so.

## Make yourself a moderator

Sign up on the site first (claim `malten` before anyone else does), then:

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "UPDATE users SET is_admin = 1 WHERE name_key = 'malten'"
```

Use `--local` instead of `--remote` for the local copy. Log out and back in, and a **Moderation** tab appears with the open reports. From there you can hide a post or message, ban an account, dismiss a report, and undo both. Every action is written to the moderation log.

## Settings (`vars` in `wrangler.jsonc`)

| Var | Default | What |
|---|---|---|
| `MIN_AGE` | `13` | Birthdays younger than this can't sign up. The browser is then refused for 24 hours, so changing the date doesn't get around it. |
| `SIGNUPS_PER_DAY` | `200` | Site-wide cap on new accounts per day. |
| `SIGNUPS_PER_IP_PER_HOUR` | `5` | Per connection. |

Secrets (all with `npx wrangler secret put`):

| Secret | Needed for |
|---|---|
| `IP_SALT`, `TOKEN_KEY` | Always. |
| `RESEND_API_KEY`, `MAIL_FROM` | Password reset emails. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify. |
| `GOOGLE_*`, `MICROSOFT_*`, `DISCORD_*`, `GITHUB_*` (`CLIENT_ID`, `CLIENT_SECRET`), `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Other sign-in options. |

Built-in limits, per person unless noted:

- **Posts:** 6 a minute and 300 a day.
- **Messages:** 15 a minute.
- **Friend requests:** 20 an hour.
- **Bulletins:** 3 an hour.
- **Reports:** 10 an hour.
- **Wrong passwords:** 10 per account per 15 minutes.
- **Reset emails:** 3 per address an hour.
- **Provider sign-ins:** 30 per connection per 10 minutes.
- **Spotify refreshes:** 6 an hour.

## Operating it

- **Logs:** `npx wrangler tail`.
- **Find an account:** `npx wrangler d1 execute ourspace-social-db --remote --command "SELECT id, name, email, banned, is_admin, created FROM users WHERE name_key = 'someone'"`.
- **Backups:** D1 Time Travel can put the database back to an earlier minute (`npx wrangler d1 time-travel restore ourspace-social-db --timestamp=…`). That reaches 7 days back on the free plan and 30 on paid.
- **Rotating `TOKEN_KEY`** makes the stored Spotify connections unreadable. People would need to connect again.

## What's protected

- **Passwords:** PBKDF2-SHA256, 100k iterations, per-user salt. Unknown accounts and wrong passwords take the same time. A password can't be the screen name or the email, or one of the most common passwords.
- **Sessions:** a random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` on https), with only its hash stored. A password change logs out other devices, and a password reset logs out all of them. Banning logs the person out.
- **Provider sign-in:**
  - The state is single-use, expires in 10 minutes, is stored server-side and is tied to the browser by a cookie.
  - PKCE is used wherever the provider supports it.
  - Accounts are never merged by email (see above).
  - Apple's client secret is a short-lived ES256 token signed on the server.
- **Spotify tokens:** encrypted with AES-256-GCM before they reach the database. Only the `user-top-read` permission is asked for.
- **Reset links:** single-use, valid for 1 hour, and kept in the URL fragment so they never reach server logs. The forgot-password page gives the same answer whether or not the address has an account.
- **Birthdays:** never shown. Pages show age and sign only if the person allows it.
- **Writes:** refused from other sites (Origin and Sec-Fetch-Site checks), JSON only. The one exception is Apple's sign-in reply, which arrives as a form post and is checked against its single-use state.
- **Pages:** strict Content-Security-Policy (scripts and styles from the site only, images also from Spotify's CDN, audio previews from Spotify and Apple), no framing. Nothing people type is ever inserted as HTML.
- **Profiles:** every look setting must come from the lists in `src/options.js`, so nobody can inject CSS or image URLs.
- **Text:** invisible and direction-flipping characters stripped, links removed, blocked words starred.
- **Blocks and reports:** a block hides both people from each other and stops all contact. Reports keep a snapshot, so the evidence survives a delete.

## Not done yet (on purpose, or next)

- **Spotify for more than 5 people.** This needs Spotify's extended quota (see above), which is out of reach for a small site. Alternatives would be letting people paste a song or playlist link (no sign-in needed), or Apple Music / Last.fm.
- **Changing screen names.**
- **Uploading pictures.** Only the presets for now. Hosting people's images needs R2 storage plus image scanning (Cloudflare's CSAM Scanning Tool) before it's safe to turn on.
- **Real-time chat and presence.** Everything polls (the inbox every few seconds, badges every 30s).
- **Email verification at sign-up.** Addresses are only used for password resets for now. Sending a confirmation link first would stop people signing up with someone else's address.
- **Terms of service.** `/rules` has plain-language rules and a privacy summary. Have them read by someone qualified before opening sign-ups widely, especially since the site stores birthdays and allows 13-year-olds.
- **Ban evasion.** A banned person can't log in, but can make a new account. The per-IP sign-up limit slows that down, and invite codes would stop it.
- **GitHub Pages.** If this folder is ever merged into `main`, GitHub Pages will also publish its static files under `ourspace.page/social/`. They won't work there (no API), so deploy this with Wrangler, not Pages.
