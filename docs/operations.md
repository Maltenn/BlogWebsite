# Operations

Commands here run from the repo root. Use `--remote` for the real database and `--local` for the copy on your computer.

## Make yourself a moderator

Sign up on the site first (claim `malten` before anyone else does), then:

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "UPDATE users SET is_admin = 1 WHERE name_key = 'malten'"
```

Use `--local` instead of `--remote` for the local copy. Log out and back in, and a **Moderation** tab appears with the open reports. From there you can hide a post or chat message, ban an account, dismiss a report, and undo both. Every action is written to the moderation log. Banning logs the person out. Admins can't be banned from the tab: set `is_admin = 0` the same way first.

## Daily routine

1. Open **Moderation**. Work the reports from the top: child-safety reports come first. Their clock shows 48 hours, but that is our own outer limit: the law says as soon as reasonably possible, so do these first and do not wait for it.
2. Skim the **Photos** section (unreviewed ones, newest first): open anything doubtful, **Mark reviewed** on what's fine, **Hide** what you're unsure of, **Remove** what must go. A few minutes a day keeps it empty.
3. Look at the other open reports and board requests.
4. Work the trust queues (below): **held sign-ups** (approve or refuse; "usually within a day" is what members are told), **alerts** (clusters, duplicate text, 5th AI strikes), **appeals** of AI strikes, and, while detection runs in shadow mode, a look down the **AI scans** list.

If a photo is apparent child sexual abuse material (a **child sexual abuse material** report, or one you find yourself): **don't download, screenshot, copy or share it**. A verified member's report already hid the reported thing's own photos, if the reporter could see them; otherwise **Hide** it now. A report about something else: press **may be under 18** on it. One you find yourself: report it yourself as child sexual abuse material. Report it to the NCMEC CyberTipline (report.cybertip.org) as soon as reasonably possible and note the report number. Then press **confirm: apparent CSAM** on the report and give that number: this bans the account and starts the hold on its data in the same moment. Do not **Remove** it. Details under Photos below.

A **Take It Down** request (or a report you mark **intimate image without consent**) has 48 hours: the Moderation page shows the time left. **First ask whether the person shown may be under 18. If they may be, it is apparent CSAM, whatever the report says: do not remove it.** Press **may be under 18**, report it to NCMEC and confirm it, as above: removing it would destroy apparent CSAM that was never reported. Only when they are clearly an adult: remove the photo (hiding isn't removing), and log when the request came in.

## Photos

Members' photos live in the R2 bucket `ourspace-social-media`, under random keys, and each has a row in the `media` table (owner, post, size, alt text). The server takes the metadata (GPS position included) out of every upload. Things to know:

- **Remove a photo now** (a Take It Down request, or anything that must not stay up): `POST /api/admin/media/<id>` with `{ "action": "remove", "note": "…" }` from a moderator's session deletes the file from R2 and its row at once, and logs `remove_media`. A photo under a child-safety hold is refused (below). To find a photo's id from its address: `SELECT id, owner_id, post_id, purpose, hidden FROM media WHERE key = '<the part after /media/>'`.
- **Hold a photo as evidence**: `{ "action": "hide" }` on the photo, or hiding its post (the Moderation tab), shows it nowhere and **holds** it: from then on nothing its owner does deletes it. Deleting the post (even when it stays as a tombstone), changing their picture, taking back an upload or deleting their account only takes it off the post (it stays as a hidden photo, `post_id` NULL, and `owner_id` NULL once the account is gone), and the cron leaves it alone. It stays until a moderator `remove`s it. A report lists the reported thing's own photos, hidden ones included: a post's, or a profile's uploaded picture, never another member's (`snapshot.media`: ids and addresses; `GET /api/admin/reports` adds how each stands now: `hidden`, `held`, `gone`). Moderators can open them whatever the post's privacy, as long as they're held or the post is still there. Held photos no longer on any post: `SELECT id, key, owner_id, purpose, created FROM media WHERE hidden = 1 AND post_id IS NULL`. `{ "action": "unhide" }` on one of those lets it go: the next cron deletes it (an unhidden picture goes when its owner next changes theirs), unless a child-safety hold refuses it.
- **Review queue**: `GET /api/admin/media` (the Photos section) lists uploads newest first; `reviewed` stores who looked and when (`media.reviewed_by`, `reviewed_at`). Unreviewed count: `SELECT COUNT(*) FROM media WHERE reviewed_at IS NULL`.
- **Take It Down Act**: valid requests to remove non-consensual intimate images must be acted on within 48 hours. **This is for images of adults. If the person shown may be under 18, stop: it is apparent CSAM, so hold it and report it (below), and do not remove it.** Press **may be under 18** on the report (`{ "action": "csam", "note": "…" }` on `POST /api/admin/reports/<id>`): it becomes a child-safety report with the same clock, its photos are hidden and held, and the server refuses Remove. Then report it to NCMEC and confirm it. For an adult: note the request and when it came in (a report marked **intimate image without consent** starts a 48-hour clock on the Moderation page, like a `csam` report), remove the photo (above; hiding isn't removing), and if the same image shows up again, remove that too. Browsers may keep showing a public photo they cached for up to 5 minutes after it's removed or hidden. Whether the Act covers OurSpace needs legal review ([decisions/005](decisions/005-media-formats.md)).
- **CSAM**: nothing scans uploads automatically. Launch is **in-house review**: moderators skim the Photos queue and act on reports; the upgrade paths are in [deploy.md](deploy.md#photos-csam-detection-launch-in-house-review). A report with reason `csam` from a verified member in good standing hides at once the reported thing's own photos that the reporter can see: a post's, or a profile's uploaded picture. Never another member's: for a quote, report the original post too. A new or review-held account's report, one about a photo its reporter can't see, or one past the auto-hide limits (below) hides nothing and waits for you; it still lists the photos, so the uploader can't destroy them. A message has no photos, and a preset picture is nothing to hide: the Moderation banner says when no photo is held. Once you know of apparent child sexual abuse material:
  1. **Hide it at once** (the Hide button, `{ "action": "hide" }`, or hide the post; a `csam` report may already have): it stops showing everywhere and is held, so the uploader deleting the post or the account can't destroy it. Don't download or share it.
  2. **Report it** to the NCMEC CyberTipline (report.cybertip.org) as soon as reasonably possible (18 U.S.C. 2258A), and look at no more of it than the report needs. **Never download it, and never run `wrangler r2 object get` on it.** A copy on a personal computer is not secure storage, and possessing this material is itself a serious crime.
  3. **Confirm the report** (**confirm: apparent CSAM**, `{ "action": "confirm", "note": "NCMEC <number> …" }`): the note is required. That bans the account and starts the hold on its data in one step, so its owner never sees anything but a ban. **Leave the material held, in the private bucket, and do not Remove it.** A report counts as a request to preserve what you reported, and reasonably accessible related data such as the account and its messages, for a year, in secure storage with access limited to those who need it (2258A(h)). The server refuses Remove and Unhide while the hold lasts, and the related data is kept as **Holds and preservation** below says. Never forward the material by email or chat.

  **Have a lawyer confirm this procedure before launch:** [decisions/008](decisions/008-launch-legal.md), section 4. It also covers what these steps don't yet: the provider's own registration with NCMEC, and enticement or trafficking reports in private messages, which have no flow today.
- **Holds and preservation**. Two things, started by two different people:
  - **A member's `csam` report** always lists the reported thing's own photos (`report_holds`), whoever filed it. While it is open the server refuses Remove and Unhide on them, and nothing their owner does (deleting the post or the account, changing the picture) destroys them: it only takes them out of sight. It hides them at once only within limits: no auto-hide of a photo for 30 days after a moderator dismissed a `csam` report about it, none from a reporter who had a `csam` report dismissed in the last 30 days, and 3 a day per reporter. Past those a report is still filed, at the top of the queue, and hides nothing. A report always goes through. It holds nothing else: no account, no copy, and the sweeps run as usual. Each `csam` report is decided by itself, only by **confirm** or **dismiss**, both with a note. A decision on another report about the same thing never closes it. **Dismiss** puts back exactly what that report hid, unless another report still holds it, and a photo whose post or owner went meanwhile is then deleted by the cron. **If nobody decides**, nothing expires: the photos stay hidden (in R2 even if the account is deleted, with no copy of anything else), and the report stays at the top of the queue, overdue. Re-publishing possible CSAM nobody looked at would be worse.
  - **A hold on the account** starts only when a moderator **confirms** a `csam` report: the views `held_accounts` and `held_photos` are built from confirmed reports. The same step bans the account. It ends only when a moderator **releases** it (**release hold**, `{ "action": "release", "note": "…" }`, when the year is over or a lawyer says so): the report's own photos, the confirmed material, are deleted at once, or by the cron as soon as no other report or hold has them, and what the hold kept for the account within the hour. A confirmed photo is never shown again: no dismissal or release can, and Unhide needs an override. Nothing ends a hold by itself, and a held account can't be unbanned until its hold is released.
  - **On a held photo**, the server answers Remove and Unhide with 409 `child_safety_hold`, whichever screen asks. Only `{ "override": true, "note": "…" }` gets past it, and it is logged as `remove_media_override` or `unhide_override`. Override only on a lawyer's or law enforcement's word, or for an adult's Take It Down request caught by a wrong report (better: dismiss that report, with a note, then Remove). A plain Remove on any other photo works as it always did. Your own **Hide** is yours: a report or hold ending never shows or deletes a photo you hid yourself, or one on a post you hid.
  - **A held account can't act**: it is banned, and the site refuses to unban it until the hold is released. Were its ban ever lifted another way, everything it does looks as it does for anyone, and loses nothing: a post it deletes keeps its words and photos in `evidence`, a picture it changes and an upload it takes back stay, hidden, and none of them count against its 200 MB.
  - **If a held account is deleted**, it is deleted as any account is: same answer, sign-in and page gone at once, name and email free. **Do not tell the member anything.** No error, delay or message may hint that a report exists. A private copy stays in the `evidence` table, filed under the old account id: the account (name, email, birthday, dates; never the password), its sign-in identities, profile, sign-up signals, AI scores, its own posts, every message it wrote, and all its uploaded photos, hidden in R2. Lines it cleared or deleted first are kept too. Other members' words are not: not their comments on its page, not their group messages; nor its likes, follows and blocks.
  - **If someone deletes their account while in a DM with a held account**, that one DM is copied, both sides, filed under the held account. All that is kept of the person leaving is their id on their messages. Nothing else of theirs is kept, and nothing at all for anyone else's deletion. The hold doesn't reach group chats.
  - **The sweeps skip a held account**: sign-up signals, post fingerprints, AI scores, flagged strike text and resolved alerts naming it stay past their dates; its old loose uploads are kept, hidden, as if deleted. #ourspace's rolling window still trims, but a held account's lines are copied to `evidence` first.
  - **Reading it**: no screen shows it, and only a report's `preserved` count says it exists. `SELECT source, source_id, data FROM evidence WHERE user_id = <id> ORDER BY source, source_id`, only for a report you are handling, and look at no more than it needs. The id is in `SELECT target FROM report_holds WHERE report_id = <report> AND kind = 'user'`.
  - **Not covered**: a hold is not a copy: nothing is copied until the account, the DM or the line would go. It never reaches another member's photos (a quote's original), group chats beyond the held account's own lines, or photos in chat (there are none).

  **Have a lawyer confirm all of this before launch** ([decisions/008](decisions/008-launch-legal.md), section 4): keeping data past a deletion request, and a third person's DM; how long; and whether this is secure storage.
- **Storage**: each member may keep 200 MB. `SELECT owner_id, COUNT(*), SUM(bytes) / 1048576.0 AS mb FROM media GROUP BY owner_id ORDER BY mb DESC LIMIT 20` shows who uses the most; `SELECT SUM(bytes) / 1073741824.0 FROM media` the whole bucket in GB (R2's first 10 GB are free, then $0.015 per GB-month: [decisions/004](decisions/004-cloudflare-limits-and-costs.md)).
- **Housekeeping**: the cron deletes uploads nobody attached within a day, and photos whose post or owner went without them, but never held (hidden) ones; an account's under a child-safety hold are kept, hidden. If an R2 delete ever fails, the Worker logs `R2 delete failed:` with the keys; delete them by hand with `npx wrangler r2 object delete ourspace-social-media/<key> --remote`.

## Held sign-ups, alerts, AI strikes

Nothing here bans anybody by itself: every ban is a moderator's decision, logged in the moderation log. How it works: [architecture.md](architecture.md#verifying-humans-anti-spam-and-ai-writing-strikes).

- **Held sign-ups** (`GET /api/admin/held`): new accounts whose sign-up scored 3+ on the risk score. Each shows its reason codes (`hosting_network`, `same_network_24h`, `provider_burst`, `domain_burst`, `fast_form`, `old_protocol_browser`, `no_accept_language`, and `no_verified_email`: signed up through a provider that vouched for no email, like a Discord account without one; approving it counts as its confirmation), the network's provider and country (never an address), the email's domain and how long the form took. A held account can log in and set up its page but can't post, comment, message, follow, like or vote, and nobody but itself and moderators can see its page (a 404, left out of Browse and suggestions). **Approve** (`POST /api/admin/held/<name> { "action": "approve" }`) and it works like any other once its email is confirmed; **refuse** (`{ "action": "refuse", "reason": "…" }`, a reason is required) suspends it (a ban, signed out at once). A VPN or a school network alone never holds anyone; a datacenter network signing up repeatedly does. If most held accounts turn out to be real people, loosen the weights in `src/trust/risk.js` before adding rules (decision 003 aims at ≤ 5% of sign-ups held and ≥ 80% of those being bots).
- **Alerts** (`GET /api/admin/alerts`, closed ones with `?status=closed`; `POST /api/admin/alerts/<id> { "action": "dismiss" | "release" | "ban", "note" }`):
  - `cluster` (the nightly check, 03:17 UTC): 3+ sign-ups from one network in 24 hours, from one hosting provider within an hour, from one provider with the same browser within a minute, with one unfamiliar email domain in 7 days, or 3+ accounts posting the same text in 24 hours. Homes, schools and phone networks share addresses: look at the accounts, then dismiss (or report / ban individually from their pages).
  - `duplicate`: the same text (or nearly) from 3+ accounts under 30 days old within a day. The copy that makes it three, and every later one, is **held** when the accounts look related (one network or provider, or all of them under 3 days old); the earlier copies never are (someone may have copied a real member's post). Unrelated accounts only raise the alert. Each post shows "held" or "hidden by a moderator". **release** shows the held ones again and never a post a moderator hid; to remove held posts, hide them, or dismiss and leave them held, or delete them.
  - `held_signup`: one per held account; it closes when you approve or refuse it from the held list.
  - `ban_review`: a member's 5th AI-writing strike. Read their strikes (`/api/admin/appeals` lists appealed ones; their notices show the text and scores), then **ban** or **dismiss**.
- **AI-writing strikes**: with `AI_DETECTOR` on and `AI_ENFORCEMENT=shadow` (the default), nobody is struck; `GET /api/admin/ai-scans` lists every score (`?decision=would_strike` for the ones that would have struck). In enforce mode the ladder is automatic: 1 a warning, 2 a day without public posting, 3 a week, 4 a month, 5 an alert for you. **Appeals** (`GET /api/admin/appeals`): read the flagged text and the member's note, then `POST /api/admin/strikes/<id> { "action": "uphold" | "remove", "note" }`. Removing lifts its timeout at once and keeps automatic strikes off that member for 180 days (their posts are still scored). You can remove any strike that still counts, appealed or not. If more than 1 in 10 appealed strikes are removed, switch back to shadow mode and re-run the evaluation (decision 002's kill switch). A struck post stays up; hide it with the usual tools if it breaks the rules otherwise.
- **Retention**: the cron deletes sign-up signals and AI scores after 90 days, post fingerprints after 7, resolved alerts after 90 days, and a strike's flagged text 30 days after the strike stops counting ([security.md](security.md#what-the-anti-bot-checks-keep-and-for-how-long)), except what is tied to an account under a child-safety hold (**Holds and preservation** above).
- **Someone can't sign up**: the answer's `code` says why (`form`, `form_used`, `form_expired`, `too_fast`, `pow`, `turnstile`, `turnstile_unavailable`, `automation`, `disposable_email`, `email_domain`, or 429 `busy`: 60+ sign-up requests a minute from their network, gone a minute after the flood stops). A real person refused for `disposable_email` can use another address; `email_domain` means the domain has no mail server. A domain wrongly on the throwaway list goes in `ALLOW` in `src/trust/disposable.js`.
- **Someone never got the confirmation email**: they can send it again from the banner (3 an hour, 10 a day); `SELECT email_verified_at FROM users WHERE name_key = '<name>'` shows whether it worked. To confirm by hand after checking it's really theirs: `UPDATE users SET email_verified_at = <ms now> WHERE name_key = '<name>'`.

## Chat

Every chat message is in D1 (`chat_messages`): #ourspace's have `room = 'ourspace'`, a group's or DM's a `conversation_id`. The Durable Objects only pass events along, so there's nothing to back up or clean in them.

- **Delete a message**: a moderator's delete button in #ourspace, or `DELETE /api/chat-messages/<id>` from a moderator's session, takes it down (`hidden = 1`: kept as evidence, shown to nobody, logged as `hide`), and it disappears from every open screen at once. Hiding a reported message from the Moderation tab does the same. A member deleting their own clears its words (`deleted = 1`); the report, if there is one, keeps them in its snapshot.
- **Mute someone in #ourspace**: `POST /api/admin/mutes { "name": "…", "hours": 1 | 24 | 168, "reason": "…" }` (0 hours lifts it). They can still read the room and use their DMs and groups. Logged as `mute` / `unmute`. Who's muted: `SELECT u.name, m.until, m.reason FROM chat_mutes m JOIN users u ON u.id = m.user_id`. The cron clears expired mutes.
- **Trimming**: #ourspace shows only the newest 500 messages of the last 24 hours, and the cron deletes everything older, **except messages someone reported** (`reports.target_type = 'message'`), which stay as evidence for as long as the report does, and copies of what a held account said (**Holds and preservation** above). Groups and DMs are never trimmed.
- **Read a reported DM or group message in context**: the Moderation tab shows the reported message's snapshot and nothing around it, and no route does: the only way to see more is this query by hand, with database access. It shows up to 20 messages of that chat on each side of it (message ids count across the whole site, so taking the ids 20 either side would miss most of them): `WITH c AS (SELECT conversation_id AS id FROM chat_messages WHERE id = <id>) SELECT id, author_id, body, created, hidden FROM chat_messages WHERE id IN (SELECT id FROM (SELECT id FROM chat_messages WHERE conversation_id = (SELECT id FROM c) AND id <= <id> ORDER BY id DESC LIMIT 21) UNION SELECT id FROM (SELECT id FROM chat_messages WHERE conversation_id = (SELECT id FROM c) AND id > <id> ORDER BY id LIMIT 20)) ORDER BY id`. Only do this for a report you are handling, and read no more than the report needs. A message a member deleted has lost its words here; a report keeps them in its snapshot.
- **Interaction scores** (`affinity`, which orders the group-chat suggestions): the cron deletes scores that have faded below 0.05. Nobody sees them but the suggestion list.
- **If live chat breaks** (the Durable Object can't be reached): messages are still stored, and the pages fall back to polling. `npx wrangler tail` shows `live: telling … failed`.

## Logs

`npx wrangler tail` shows the live logs, including errors from the Worker. Logging is also switched on in `wrangler.jsonc` (`observability`), so recent logs are in the Cloudflare dashboard too.

## Find an account

```bash
npx wrangler d1 execute ourspace-social-db --remote --command "SELECT id, name, email, banned, is_admin, created FROM users WHERE name_key = 'someone'"
```

## Backups

D1 Time Travel can put the database back to an earlier minute. **A restore overwrites the live database.** Every write since that minute is lost: posts, messages, sign-ups, reports, moderators' actions, ended holds. Everything deleted since comes back, **accounts deleted at their owner's request included**, and nothing left behind says which ones they were. So restore only on purpose, as an emergency (a bad migration, a lost table), never to undo one mistake: fix that by hand instead.

First check that Time Travel has a bookmark for that minute (this changes nothing):

```bash
npx wrangler d1 time-travel info ourspace-social-db --timestamp=…
```

Then, and only then:

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
| Messages (DMs and group chats together) | 15 a minute and 400 a day |
| New DMs opened · new group chats · group invites to non-friends | 30 an hour · 10 a day · 30 an hour |
| #ourspace (slow mode) | 1 every 3 seconds and 20 a minute |
| Read positions in chats (`PUT /api/chats/:id/read`) | 120 a minute |
| Follows (new ones; unfollowing is free) | 20 an hour and 100 a day |
| Read positions (`PUT /api/me/markers/feed` and `/notifications`) | 120 a minute |
| Board threads (also count as posts) | 3 an hour and 10 a day |
| Board requests | 3 a day |
| Browse: For you, Mutuals, Who to follow | 60 a minute and 600 an hour each, per member (logged out: per connection) |
| Browse: "not interested" | 300 a day (a miss counts too) |
| Photo uploads | 30 an hour and 150 a day (and 200 MB stored per member) |
| Blog entries (also count as posts) | 10 a day |
| Reports | 10 an hour and 40 a day |
| Blocks | 30 an hour |
| Wrong passwords | 10 per account, and 30 per connection, per 15 minutes. Only failures count |
| Password changes | 5 per 15 minutes |
| Account deletions | 5 per 15 minutes |
| Forgot-password emails | 3 per address an hour, and 5 per connection an hour |
| Password reset attempts | 10 per connection an hour |
| Sign-ups | 5 per connection an hour, 200 a day site-wide; a filled-in honeypot uses up 3 of the connection's 5 |
| Confirmation emails (resend) | 3 an hour and 10 a day |
| Confirmation links that don't work | 20 per connection an hour (working ones don't count) |
| AI-strike appeals | 10 a day |
| Provider sign-ins | 30 per connection per 10 minutes |
| Spotify refreshes | 6 an hour |
| New accounts | `SIGNUPS_PER_IP_PER_HOUR` (default 5) per connection, and `SIGNUPS_PER_DAY` (default 200) for the whole site ([deploy.md](deploy.md)) |

A "connection" is a hash of the visitor's IP address, salted with `IP_SALT`.
