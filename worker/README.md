# ourspace-api (Cloudflare Worker)

One Worker + one D1 database replace the two old localhost backends (`msgserver/` on 3001, `spotifyserver/` on 8080) for the live site. Everything it uses is on Cloudflare's free plan: Workers (100k requests/day), D1 (5M row reads + 100k row writes/day), Cron Triggers.

| Route | What |
|---|---|
| `GET /messages` | guestbook entries, newest first, max 50 — `[{ id, screenName, message, timestamp }]` |
| `POST /messages` | `{ screenName, message }` → `{ id }`. Trims, caps at 20/200 chars, strips links and the same blocked words as `Guestbook.filter`, 3 posts per minute per IP |
| `GET /top-tracks?limit=N` | malten's Spotify top tracks (1–20, `short_term`), same objects `spotifyserver` returned (`name, artist, album, preview_url, image_url, image_small, url`); iTunes 30s previews fill in where Spotify has none |

`/top-tracks` is served from a 10-minute cache in D1; a cron (`*/10 * * * *`) keeps the `limit=10` list warm, and a stale list is still served while Spotify is down. The page (`apps.js`: `Spotify.API`, `Guestbook.API`) points at the deployed URL; `ALLOWED_ORIGINS` in `wrangler.jsonc` lists the pages browsers may call it from.

## Local development

```bash
cd worker
npm install
npm run db:local          # creates the tables in wrangler's local D1
npm run dev               # http://127.0.0.1:8787  (add --test-scheduled to get /__scheduled for the cron)
```

Secrets for local runs live in `worker/.dev.vars` (gitignored): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `IP_SALT`.

## Deploying (first time)

```bash
cd worker
npx wrangler login                                   # opens the browser once
npx wrangler d1 create ourspace-db                   # paste the printed database_id into wrangler.jsonc
npm run db:remote                                    # tables on the real database
npx wrangler secret put SPOTIFY_CLIENT_ID            # each prompts for the value (or pipe it in)
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REFRESH_TOKEN
npx wrangler secret put IP_SALT                      # any random string; only salts the IP hashes
npm run deploy                                       # prints the https://ourspace-api.<account>.workers.dev URL
```

After that, `npm run deploy` alone ships code changes. Secrets and the database survive redeploys.

## Operating it

- **Hide a guestbook entry** (keeps it in the table): `npx wrangler d1 execute ourspace-db --remote --command "UPDATE messages SET hidden = 1 WHERE created = <id>"`. List them: `... --command "SELECT created, screen_name, message FROM messages ORDER BY created DESC LIMIT 20"`.
- **Logs:** `npx wrangler tail` streams live requests and errors.
- **Spotify stops working** (`/top-tracks` answers 502 and the cron logs a token error): the refresh token was revoked. Get a new one by running the old `spotifyserver/` locally once (`npm start`, open `http://localhost:8080/login`), then `npx wrangler secret put SPOTIFY_REFRESH_TOKEN` from the new `spotify_tokens.json`, and clear the rotated copy: `npx wrangler d1 execute ourspace-db --remote --command "DELETE FROM kv WHERE k LIKE 'spotify:%'"`.
- **Change which pages may call it:** edit `ALLOWED_ORIGINS` in `wrangler.jsonc`, redeploy.
