# Operations

Commands here run from the repo root. Use `--remote` for the real database and `--local` for the copy on your computer.

## Make yourself a moderator

Sign up on the site first (claim `malten` before anyone else does), then:

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "UPDATE users SET is_admin = 1 WHERE name_key = 'malten'"
```

Use `--local` instead of `--remote` for the local copy. Log out and back in, and a **Moderation** tab appears with the open reports. From there you can hide a post or message, ban an account, dismiss a report, and undo both. Every action is written to the moderation log. Banning logs the person out. Admins can't be banned from the tab: set `is_admin = 0` the same way first.

## Logs

`npx wrangler tail` shows the live logs, including errors from the Worker. Logging is also switched on in `wrangler.jsonc` (`observability`), so recent logs are in the Cloudflare dashboard too.

## Find an account

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "SELECT id, name, email, banned, is_admin, created FROM users WHERE name_key = 'someone'"
```

## Backups

D1 Time Travel can put the database back to an earlier minute:

```bash
npx wrangler d1 time-travel restore ourspace-social-db --timestamp=…
```

That reaches 7 days back on the free plan and 30 on paid.

## Rotating `TOKEN_KEY`

`TOKEN_KEY` encrypts the stored Spotify tokens. Setting a new one makes the stored Spotify connections unreadable, so people would need to connect again. Nothing else depends on it. Set it with `npx wrangler secret put TOKEN_KEY`.

## Built-in rate limits

They are counted per person unless noted, in the `attempts` table, and old rows are cleared by the cron. When one is hit, the person gets a 429 and a short message.

| What | Limit |
|---|---|
| Posts (statuses, replies, quotes, Friends' Comments, bulletins and blog posts together) | 6 a minute and 300 a day |
| Likes · reposts · bookmarks (undoing one is free) | 300 · 60 · 300 an hour |
| Messages | 15 a minute and 400 a day |
| Follows (new ones; unfollowing is free) | 20 an hour and 100 a day |
| Read positions (`PUT /api/me/markers/feed` and `/notifications`) | 120 a minute |
| Bulletins (also count as posts) | 3 an hour and 10 a day |
| Blog entries (also count as posts) | 10 a day |
| Reports | 10 an hour and 40 a day |
| Blocks | 30 an hour |
| Wrong passwords | 10 per account, and 30 per connection, per 15 minutes. Only failures count |
| Password changes | 5 per 15 minutes |
| Account deletions | 5 per 15 minutes |
| Forgot-password emails | 3 per address an hour, and 5 per connection an hour |
| Password reset attempts | 10 per connection an hour |
| Provider sign-ins | 30 per connection per 10 minutes |
| Spotify refreshes | 6 an hour |
| New accounts | `SIGNUPS_PER_IP_PER_HOUR` (default 5) per connection, and `SIGNUPS_PER_DAY` (default 200) for the whole site ([deploy.md](deploy.md)) |

A "connection" is a hash of the visitor's IP address, salted with `IP_SALT`.
