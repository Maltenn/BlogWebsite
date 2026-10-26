# Operations

Commands here run from the repo root. Use `--remote` for the real database and `--local` for the copy on your computer.

## Make yourself a moderator

Sign up on the site first (claim `malten` before anyone else does), then:

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "UPDATE users SET is_admin = 1 WHERE name_key = 'malten'"
```

Use `--local` instead of `--remote` for the local copy. Log out and back in, and a **Moderation** tab appears with the open reports. From there you can hide a post or message, ban an account, dismiss a report, and undo both. Every action is written to the moderation log. Banning logs the person out. Admins can't be banned from the tab: set `is_admin = 0` the same way first.

## Photos

Members' photos live in the R2 bucket `ourspace-social-media`, under random keys, and each has a row in the `media` table (owner, post, size, alt text). The server takes the metadata (GPS position included) out of every upload. Things to know:

- **Remove a photo now** (a Take It Down request, or anything that must not stay up): `POST /api/admin/media/<id>` with `{ "action": "remove", "note": "…" }` from a moderator's session deletes the file from R2 and its row at once, and logs `remove_media`. To find a photo's id from its address: `SELECT id, owner_id, post_id, purpose, hidden FROM media WHERE key = '<the part after /media/>'`.
- **Hold a photo as evidence**: `{ "action": "hide" }` on the photo, or hiding its post (the Moderation tab), shows it nowhere and **holds** it: from then on nothing its owner does deletes it. Deleting the post (even when it stays as a tombstone), changing their picture, taking back an upload or deleting their account only takes it off the post (it stays as a hidden photo, `post_id` NULL, and `owner_id` NULL once the account is gone), and the cron leaves it alone. It stays until a moderator `remove`s it. A report on a post lists its photos, hidden ones included (`snapshot.media`: ids and addresses), and moderators can open them whatever the post's privacy, as long as they're held or the post is still there. Held photos no longer on any post: `SELECT id, key, owner_id, purpose, created FROM media WHERE hidden = 1 AND post_id IS NULL`. `{ "action": "unhide" }` on one of those lets it go: the next cron deletes it (an unhidden picture goes when its owner next changes theirs).
- **Take It Down Act**: valid requests to remove non-consensual intimate images must be acted on within 48 hours. Note the request and when it came in, remove the photo (above; hiding isn't removing), and if the same image shows up again, remove that too. Browsers may keep showing a public photo they cached for up to 5 minutes after it's removed or hidden. Whether the Act covers OurSpace needs legal review ([decisions/005](decisions/005-media-formats.md)).
- **CSAM**: nothing scans uploads automatically yet. Cloudflare's CSAM Scanning Tool only sees images that pass through Cloudflare's cache, and photos streamed by the Worker from R2 most likely never do, so turning it on proves nothing until the owner picks how photos get checked ([deploy.md](deploy.md#photos-csam-detection-an-owner-decision-before-launch)). Until then, detection is reports and moderators. Once you know of apparent child sexual abuse material:
  1. **Hide it at once** (`{ "action": "hide" }` on the photo, or hide the post): it stops showing everywhere and is held, so the uploader deleting the post or the account can't destroy it.
  2. **Report it** to the NCMEC CyberTipline (report.cybertip.org) as soon as reasonably possible (18 U.S.C. 2258A), and keep what you reported for a year. For the report, keep a copy offline and off the site (`npx wrangler r2 object get ourspace-social-media/<key> --remote --file …`), and look at no more of it than the report needs.
  3. **Then remove it** (`{ "action": "remove", "note": "NCMEC report <number>" }`) and ban the account. Never forward the material by email or chat.
- **Storage**: each member may keep 200 MB. `SELECT owner_id, COUNT(*), SUM(bytes) / 1048576.0 AS mb FROM media GROUP BY owner_id ORDER BY mb DESC LIMIT 20` shows who uses the most; `SELECT SUM(bytes) / 1073741824.0 FROM media` the whole bucket in GB (R2's first 10 GB are free, then $0.015 per GB-month: [decisions/004](decisions/004-cloudflare-limits-and-costs.md)).
- **Housekeeping**: the cron deletes uploads nobody attached within a day, and photos whose post or owner went without them, but never held (hidden) ones. If an R2 delete ever fails, the Worker logs `R2 delete failed:` with the keys; delete them by hand with `npx wrangler r2 object delete ourspace-social-media/<key> --remote`.

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

That reaches 7 days back on the free plan and 30 on paid. It puts back the `media` rows, not the photo files: a photo deleted from R2 stays deleted (its address answers 404).

## Rotating `TOKEN_KEY`

`TOKEN_KEY` encrypts the stored Spotify tokens. Setting a new one makes the stored Spotify connections unreadable, so people would need to connect again. Nothing else depends on it. Set it with `npx wrangler secret put TOKEN_KEY`.

## Built-in rate limits

They are counted per person unless noted, in the `attempts` table, and old rows are cleared by the cron. When one is hit, the person gets a 429 and a short message.

| What | Limit |
|---|---|
| Posts (statuses, replies, quotes, Friends' Comments, blog posts, board threads and comments together) | 6 a minute and 300 a day |
| Likes · reposts · bookmarks (undoing one is free) | 300 · 60 · 300 an hour |
| Votes on threads and comments (taking one back is free) | 300 an hour |
| Messages | 15 a minute and 400 a day |
| Follows (new ones; unfollowing is free) | 20 an hour and 100 a day |
| Read positions (`PUT /api/me/markers/feed` and `/notifications`) | 120 a minute |
| Board threads (also count as posts) | 3 an hour and 10 a day |
| Board requests | 3 a day |
| Photo uploads | 30 an hour and 150 a day (and 200 MB stored per member) |
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
