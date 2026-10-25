# Deploy

OurSpace is one Cloudflare Worker with one D1 database. Deploy it with Wrangler, not GitHub Pages: the site needs the Worker for its API, and Pages can't run it. If this repo is replacing the old desktop site at ourspace.page, read [Cutover from the desktop site](#cutover-from-the-desktop-site) before you merge anything.

## First deploy

```bash
npx wrangler login
npx wrangler d1 create ourspace-social-db                   # paste the printed database_id into wrangler.jsonc
npm run db:remote                                           # tables on the real database
openssl rand -hex 32    | npx wrangler secret put IP_SALT   # salts the IP hashes used for rate limits
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY # encrypts stored Spotify tokens. Don't lose or change it
npm run deploy                                              # prints https://ourspace-social.<account>.workers.dev
```

This creates a Worker called `ourspace-social` and a database called `ourspace-social-db`. After that, `npm run deploy` alone ships changes, and `npm run db:remote` applies new files in `migrations/`.

The email sign-up works with just the steps above. Everything below is optional, and each piece switches itself on once its secrets are set.

## Custom domain

To give the Worker a real address, add a custom domain to it in the Cloudflare dashboard (the Worker's Settings, under Domains & Routes), for example `social.ourspace.page` while you test, or `ourspace.page` itself at the cutover. Cloudflare needs the domain's DNS to be on Cloudflare for this. Do it **before** registering the sign-in apps and Spotify below, because their redirect addresses include the host.

## Password reset emails

Make a free [Resend](https://resend.com) account, verify a sending domain (for example `ourspace.page`), and then:

```bash
npx wrangler secret put RESEND_API_KEY     # re_…
npx wrangler secret put MAIL_FROM          # OurSpace <no-reply@ourspace.page>
```

Without these, the forgot-password page says email isn't set up. It never pretends a message went out.

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

Secrets are set with `npx wrangler secret put NAME`, never written to a file in the repo:

| Secret | Needed for |
|---|---|
| `IP_SALT`, `TOKEN_KEY` | Always. |
| `RESEND_API_KEY`, `MAIL_FROM` | Password reset emails. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify. |
| `GOOGLE_*`, `MICROSOFT_*`, `DISCORD_*`, `GITHUB_*` (`CLIENT_ID`, `CLIENT_SECRET`), `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Other sign-in options. |

The same list is in the comment at the top of `wrangler.jsonc`; when a feature that needs new secrets is added, update both. `TEST_PROVIDER_BASE` is not a setting: it is for the tests and the demo, and must never be set on a real deployment ([development.md](development.md)).

## Cutover from the desktop site

Merging this branch (`claude/intelligent-fermat-keh09f`) into `main` is what retires the desktop site. GitHub Pages deploys `main`'s root, which would then have no `index.html`, and the `CNAME` file (`ourspace.page`) is gone too. So the order matters:

1. **Deploy the Worker** ([First deploy](#first-deploy)) and try it on its `workers.dev` address: sign up, post, log out and in. This creates a new Worker and database and changes nothing about ourspace.page.
2. **Switch on what you want from day one**: Resend, the sign-in apps and Spotify. Register their redirect addresses with the final host, `https://ourspace.page/api/oauth/<provider>/callback`.
3. **Point ourspace.page at the Worker.** Add `ourspace.page` as a custom domain on the Worker ([Custom domain](#custom-domain)). If its DNS isn't on Cloudflare yet, move it there first, and remove the DNS records that point at GitHub Pages. Do the same for `www.ourspace.page`: today it is a CNAME to `maltenn.github.io`, so either add it as a second custom domain on the Worker or redirect it to the apex (a Cloudflare redirect rule). Wait until both `https://ourspace.page` and `https://www.ourspace.page` show the new site.
4. **Claim `malten`**, then make yourself a moderator ([operations.md](operations.md)).
5. **Disable GitHub Pages** in the repo's settings (Settings → Pages). Do this after step 3, or the site goes dark in between, and before step 6.
6. **Merge the branch into `main`.**
7. **Old backends stay up.** The old `ourspace-api` Worker and `ourspace-db` D1 database (the old site's guestbook) keep running until you remove them separately in the Cloudflare dashboard. Nothing in this repo uses them any more.
8. **Rotate the Spotify client secret.** It appeared in the old site's pre-rebuild git history (a local-only branch). Make a new one in the Spotify developer dashboard, then `npx wrangler secret put SPOTIFY_CLIENT_SECRET`. The old `ourspace-api` Worker refreshes its own Spotify token with the same secret, so rotating breaks the desktop site's Top Songs: do it once that Worker is retired, or also run `npx wrangler secret put SPOTIFY_CLIENT_SECRET --name ourspace-api`.

If you need the old site's files back, see [history.md](history.md).
