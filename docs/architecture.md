# Architecture

## How it works

```
one Cloudflare Worker "ourspace-social" (same origin for pages and API, so the login cookie is HttpOnly + SameSite=Lax)
 ├── public/      the pages: index.html + app.js (single-page app, ES modules), app.css, blog/, assets/   (Workers static assets)
 ├── /api/*       src/index.js → accounts, profiles, social, messages, safety, music, horoscope
 ├── D1 "ourspace-social-db"   migrations/0001_init.sql (users, profiles, sessions, identities, oauth_states,
 │                             oauth_signups, password_resets, spotify, friendships, posts, messages, blocks,
 │                             reports, mod_log, attempts)
 └── cron */30    housekeeping: expired sessions, sign-in tickets, reset links, old rate-limit rows
```

`wrangler.jsonc` sends only `/api/*` to the Worker first. Every other path is served from `public/`, and a path that isn't a file gets `index.html`, so `/u/<name>`, `/inbox`, `/edit` and the rest are drawn by the page's own router.

## File map

```
src/
  index.js     Worker entry
  shared/      infrastructure; never imports a feature
  catalog/     the choices people have when decorating a page
  accounts/  profiles/  social/  messages/  safety/  music/  horoscope/     features
```

| Path | What |
|---|---|
| `src/index.js` | The route table (one list at the top), the cross-site check on writes, the cron. |
| `src/shared/http.js` | JSON answers, `fail(status, message)` errors, reading JSON bodies, cookies, SHA-256. |
| `src/shared/db.js` | User lookups, the shape a user takes in every answer, friendships, blocks, and `limit()`, the rate limiter. |
| `src/shared/text.js` | Text cleaning: invisible characters, links removed, the blocked-word list (whole words). |
| `src/shared/dates.js` | Birthdays: parsing, the age check, age on a given day. |
| `src/shared/seal.js` | AES-GCM encryption for the tokens we have to keep (`TOKEN_KEY`), and random tokens. |
| `src/shared/mail.js` | Email through Resend (password resets only). |
| `src/shared/astro.js` | The astronomy: where the Sun, Moon and planets are on a given day (`astronomy-engine`), sign changes, retrogrades, Moon phases, aspects, star signs from birthdays, birth placements. Numbers only. |
| `src/catalog/options.js` | Every choice Edit My Page offers. The page and the server read the same list. |
| `src/catalog/avatars.js` | The picture presets. Maintained by hand. |
| `src/accounts/auth.js` | Email sign-up (birthday age check, name rules, per-IP and daily caps), log in by email or screen name (throttled), sessions, forgot/reset password, password change, account deletion. PBKDF2-SHA256 passwords. |
| `src/accounts/oauth.js` | "Other options" sign-in (Google, Apple, Microsoft, Discord, GitHub), linking and unlinking them in Settings, and the Spotify connection. Authorization code flow with PKCE (Apple uses a signed client secret instead). |
| `src/profiles/profiles.js` | Public profiles, Browse, Edit My Page validation (only values from `src/catalog/options.js` are accepted), wall/message privacy, show age / show sign. |
| `src/social/social.js` | Friend requests, wall comments, statuses, bulletins, blog entries, deleting posts, the feed. |
| `src/messages/messages.js` | Private messages. |
| `src/safety/safety.js` | Blocks, reports (with a snapshot of the reported text), the moderation actions and log. |
| `src/music/spotify.js` | Each person's Spotify: tokens (stored encrypted), their top songs (cached for 6 hours), and previews from iTunes when Spotify has none. |
| `src/horoscope/horoscope.js` | The words: today's sky, each sign's horoscope, personal readings. |
| `public/_headers` | Content-Security-Policy and other security headers for the pages. |
| `public/blog/` | malten's essays and their index: static pages, maintained by hand. |
| `public/assets/` | Every image the pages and `src/catalog/` use. Credits are in [CREDITS.md](../public/assets/CREDITS.md), served at `/assets/CREDITS.md`. |
| `migrations/` | D1 schema, one numbered file per change. |
| `tools/demo.mjs` | `npm run demo`: the site on your computer with sample content and pretend sign-in pages. |
| `test/` | `api.test.mjs` (end-to-end, against a throwaway local Worker), `astro.test.mjs` (the astronomy against known dates), `static.test.mjs` (assets and imports), `helpers/mock-providers.mjs` (a stand-in for every sign-in provider, Spotify and iTunes, used by the tests and the demo). |

Features import only `shared/` and `catalog/`. The few exceptions are listed in [CONVENTIONS.md](../CONVENTIONS.md).

## The life of a request

1. `fetch` in `src/index.js` hands anything that isn't under `/api/` to the static assets.
2. An `/api/` path is matched against the route table. No match is 404, a known path with the wrong method is 405, and a path that can't be decoded is 400.
3. **Cross-site check.** Every non-GET request must come from our own pages: if an `Origin` header is present it must match the site, and `Sec-Fetch-Site: cross-site` is refused with 403. The one route that skips this check is the Apple sign-in reply (`crossSite: true` in the table), which arrives as a form post from Apple and is protected by its single-use state instead. Bodies are JSON only (`readBody` refuses anything else), which is the third lock on that door after the check and the `SameSite=Lax` cookie.
4. **Session.** `currentUser` reads the session cookie and looks up its hash.
5. **Access level**, set per route in the table:

   | Level | Who | If not |
   |---|---|---|
   | `OPEN` | anyone | |
   | `AUTH` | a logged-in member | 401 "log in first." |
   | `ADMIN` | a moderator (`users.is_admin`) | 403 "moderators only." |

6. **The handler** (`verbNoun(c)`) gets one context, `c` (`req`, `env`, `ctx`, `url`, `now`, `params`, `user`), and returns `json(...)`. Problems are thrown with `fail(status, message)`. An `HttpError` becomes a JSON `{ "error": ... }` answer with that status. Anything else is logged and answered with a plain 500, so no internals leak.
7. **Cron**, every 30 minutes (`*/30 * * * *`): deletes expired sessions, sign-in tickets (`oauth_states`, `oauth_signups`) and reset links, and rate-limit rows (`attempts`) older than two days.

## Front end

`public/index.html` loads `public/app.js` as an ES module. There is no build step: the files in `public/` are what the browser gets.

```
public/
  app.js        entry: the ROUTES table (address pattern → page) and boot
  js/core/      dom.js  api.js  format.js  ui.js  state.js  router.js  chrome.js     basics every page uses
  js/widgets/   people.js  safety.js  songs.js  auth-forms.js                        pieces two or more pages share
  js/pages/     home  profile  browse  requests  inbox  bulletins  horoscope
                auth  edit  settings  admin  rules   (.js)                            one module per screen
  app.css  _headers  assets/  blog/
```

- A page module exports `renderX(root, arg)`: it fills `root`, and `arg` is the captured piece of the address (a screen name, a sign). It is registered in the `ROUTES` table in `app.js`.
- Code that two or more pages use lives in `js/widgets/`. `js/core/` imports nothing above it: no widgets, no pages, no entry.
- The router leaves some addresses to the server, so links into them are real page loads instead of in-app navigation. They are listed in `STATIC_PREFIXES` in `js/core/router.js` (the blog, the assets, the API). A new static folder under `public/` has to be added there.
- User text only ever reaches the page through `textContent`, never as HTML.

## Horoscopes: how they work

- **Star signs** come from the birthday: the sign the Sun was in on that day. If the Sun changed sign that day (a cusp birthday), their personal reading mentions the other sign too.
- **Today's sky** (`/horoscope`, for everybody) is computed for the reader's own local day. It covers where the Sun, Moon and planets are (tropical zodiac), the Moon's phase and any New or Full Moon, which planets are retrograde and when they turn direct, planets changing sign or stationing today, and the major aspects between them. All of it is computed with [`astronomy-engine`](https://github.com/cosinekitty/astronomy), not looked up from a list. `test/astro.test.mjs` checks it against known dates, for example the Sun entering Scorpio on 23 October 2026 and Mercury turning retrograde on the 24th.
- **Each sign's horoscope** (`/horoscope/<sign>`) reads that same sky through "solar houses": whole signs counted from the person's Sun sign, the method newspaper horoscopes use. The same sky therefore reads differently for every sign. It covers what the Moon is lighting up today, the month's theme from the Sun, the Moon phase, retrogrades, a lucky number and color, a mood, and a do and a don't.
- **The personal reading** (logged in) adds the person's birth chart: where the Sun, Moon, Mercury, Venus, Mars and the rest were on their birthday (at noon, since we don't ask for a birth time). Today's planets are then compared against those positions ("transits"). On their birthday it says so.
- A reading is seeded by the date and sign (and person), so it stays the same all day and changes the next. It's for fun, and the horoscope page says so.
