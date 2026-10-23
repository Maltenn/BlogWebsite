# OurSpace, the social network (`social/`)

A reformed copy of the site: just OurSpace and the blog, no Windows 98 desktop, and real accounts.

- **People make accounts** (screen name + password) and get a public profile at `/u/<name>` that anyone can view.
- **They post and interact:** statuses, wall comments, bulletins, blog entries, friend requests, Top 8, private messages, a shared feed.
- **They decorate their page** with the original Edit My Page choices: 231 preset pictures, 10 color themes, 15 background tiles, fonts, decor gifs, 88x31 buttons.
- **Only ten bots**, the original residents (Todd, xX_DarkAngel_Xx, sk8rboi_mike, vinyl_witch, wavedash_wes, herp, BANANA_PHONE, patrick, starxgazer, zorp_51). Every name and picture of a bot carries a **BOT** tag, bot pages have a banner, and Browse can filter them. They post about 12 times a day between them, answer when spoken to, and never start conversations (except Todd's one welcome message).
- **Block and Report** on every profile, post, comment and message, plus a moderation queue for admins.
- **malten's essays** are republished verbatim under `/blog/`.

The original site (the repo root, live at ourspace.page on GitHub Pages, with `worker/` and its `ourspace-db`) is untouched. This folder is self-contained: it has its own Worker, its own database and its own copies of the images it uses.

## How it works

```
one Cloudflare Worker "ourspace-social" (same origin for pages and API, so the login cookie is HttpOnly + SameSite=Lax)
 ├── public/            the pages: index.html + app.js (single-page app), app.css, blog/, assets/   (Workers static assets)
 ├── /api/*             src/index.js → auth, profiles, social, messages, safety, bots
 ├── D1 "ourspace-social-db"   migrations/0001_init.sql (users, profiles, sessions, friendships, posts, messages,
 │                             blocks, reports, mod_log, attempts, kv)
 └── cron */30          the bots post a little; expired sessions and old rate-limit rows are cleared
```

| Path | What |
|---|---|
| `src/index.js` | Router, the cross-site check on writes, the cron. Every route is listed at the top. |
| `src/auth.js` | Sign-up (age + rules confirmation, name rules, per-IP and daily caps), log in (throttled), sessions, password change, account deletion. PBKDF2-SHA256 passwords. |
| `src/profiles.js` | Public profiles, Browse, Edit My Page validation (only values from `src/options.js` are accepted), wall/message privacy settings. |
| `src/social.js` | Friend requests, wall comments, statuses, bulletins, blog entries, deleting posts, the feed. |
| `src/messages.js` | Private messages. |
| `src/safety.js` | Blocks, reports (with a snapshot of the reported text), the moderation actions and log. |
| `src/bots.js` | The bot accounts: seeding, the posting schedule, replies, Todd's welcome. |
| `src/text.js` | Text cleaning: invisible characters, links removed, the blocked-word list (whole words). |
| `src/options.js` | Every choice Edit My Page offers. The page and the server read the same list. |
| `src/generated/` | `bots.js` (bot profiles + lines) and `avatars.js` (picture presets), **generated**. |
| `tools/build.mjs` | Regenerates `src/generated/`, copies images into `public/assets/` and republishes the essays into `public/blog/` from the original site. |
| `public/app.js` | The whole front end. User text only ever reaches the page through `textContent`. |
| `public/_headers` | Content-Security-Policy and other security headers for the pages. |
| `test/api.test.mjs` | 18 end-to-end API tests against a throwaway local Worker. |

## Run it locally

```bash
cd social
npm install
npm run db:local       # create the tables in wrangler's local database (once)
npm run dev            # http://127.0.0.1:8787
npm test               # the API tests (they start their own Worker on a fresh database)
```

The bots appear on the first request. Bot replies take a few seconds on purpose ("typing…"). To see the bots' scheduled posts without waiting half an hour:

```bash
curl -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=ourspace-social" \
  -H 'Content-Type: application/json' -d '{"cron":"*/30 * * * *"}'
```

Re-run `npm run build` (from `social/`) after editing the original site's `content-src/`, changing `BOT_IDS` or `POSTS` in `tools/build.mjs`, or adding a picture to `src/options.js`.

## Make yourself a moderator

Sign up on the site first (claim `malten` before anyone else does), then:

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "UPDATE users SET is_admin = 1 WHERE name_key = 'malten'"
```

(`--local` instead of `--remote` for the local copy.) Log out and back in, and a **Moderation** tab appears with the open reports. From there you can hide a post or message, ban an account, dismiss a report, and undo both. Every action is written to the moderation log.

## Deploy it (first time)

This creates a **new** Worker and a **new** database. It does not touch `ourspace-api`, `ourspace-db`, GitHub Pages or the ourspace.page DNS.

```bash
cd social
npx wrangler login
npx wrangler d1 create ourspace-social-db        # paste the printed database_id into wrangler.jsonc
npm run db:remote                                # tables on the real database
openssl rand -hex 32 | npx wrangler secret put IP_SALT   # salts the IP hashes used for rate limits
npm run deploy                                   # prints https://ourspace-social.<account>.workers.dev
```

After that, `npm run deploy` alone ships changes, and `npm run db:remote` applies new files in `migrations/`. To give it a real address later, add a custom domain to the Worker in the Cloudflare dashboard (for example `social.ourspace.page`). Moving ourspace.page itself over means changing its DNS away from GitHub Pages, so do that only once you're ready to retire the desktop site.

## Settings (`vars` in `wrangler.jsonc`)

| Var | Default | What |
|---|---|---|
| `MIN_AGE` | `13` | Sign-up asks people to confirm they're at least this old. Profile ages below it are refused. |
| `SIGNUPS_PER_DAY` | `200` | Site-wide cap on new accounts per day. |
| `SIGNUPS_PER_IP_PER_HOUR` | `5` | Per connection. |
| `BOT_POSTS_PER_DAY` | `12` | All ten bots together. `0` silences their schedule (they still answer). |
| `BOT_DELAY_SCALE` | `1` | Multiplies the bots' "typing" delays. The tests use `0`. |

Built-in limits: 6 posts a minute and 300 a day per person, 15 messages a minute, 20 friend requests an hour, 3 bulletins an hour, 10 reports an hour, 10 wrong passwords per name per 15 minutes.

## Operating it

- **Logs:** `npx wrangler tail`.
- **Find an account:** `npx wrangler d1 execute ourspace-social-db --remote --command "SELECT id, name, banned, is_admin, created FROM users WHERE name_key = 'someone'"`.
- **Bots:** change `BOT_IDS` in `tools/build.mjs`, run `npm run build`, deploy. Removed bots are retired (hidden), not deleted, so people's conversations with them survive. An admin can also ban a single bot from its report or with `POST /api/admin/users/<name>`.
- **Backups:** D1 Time Travel can put the database back to an earlier minute (`npx wrangler d1 time-travel restore ourspace-social-db --timestamp=…`): 7 days back on the free plan, 30 on paid.

## What's protected

- Passwords: PBKDF2-SHA256, 100k iterations, per-user salt. Same timing for unknown names and wrong passwords.
- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` on https). Only its hash is stored. Password change logs out other devices. Banning logs the person out.
- Writes: refused from other sites (Origin and Sec-Fetch-Site checks), JSON only.
- Pages: strict Content-Security-Policy (scripts and styles from the site only), no framing. Nothing people type is ever inserted as HTML.
- Profiles: every look setting must come from the lists in `src/options.js`, so nobody can inject CSS or image URLs.
- Text: invisible and direction-flipping characters stripped, links removed, blocked words starred.
- Blocks hide both people from each other and stop all contact. Reports keep a snapshot so evidence survives a delete.

## Not done yet (on purpose, or next)

- **Password reset.** There's no email on file, so a forgotten password needs a moderator. Adding an optional email (or Discord/GitHub sign-in) is the fix.
- **Changing screen names.**
- **Uploading pictures.** Only the presets for now. Hosting people's images needs R2 storage plus image scanning (Cloudflare's CSAM Scanning Tool) before it's safe to turn on.
- **Real-time chat / the #ourspace room / presence pings.** Everything polls (the inbox every few seconds, badges every 30s).
- **Profile songs and photo/video posts for people.** The bots keep their songs.
- **Terms of service.** `/rules` has plain-language rules and a privacy summary. Have them read by someone qualified before opening sign-ups widely.
- **Ban evasion.** A banned person can't log in, but can make a new account. The per-IP sign-up limit slows that down; invite codes would stop it.
- If this folder is ever merged into `main`, GitHub Pages will also publish its static files under `ourspace.page/social/`. They won't work there (no API), so deploy this with Wrangler, not Pages.
