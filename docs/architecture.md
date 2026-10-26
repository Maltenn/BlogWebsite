# Architecture

## How it works

```
one Cloudflare Worker "ourspace-social" (same origin for pages and API, so the login cookie is HttpOnly + SameSite=Lax)
 ├── public/      the pages: index.html + app.js (single-page app, ES modules), app.css, blog/, assets/   (Workers static assets)
 ├── /api/*       src/index.js → accounts, profiles, follows, social, boards, browse, notifications, chats, media, safety, music, horoscope
 ├── /api/live/:room   a chat room's WebSocket: checked by the Worker (src/chats/live.js), then handed to the room's
 │                     Durable Object
 ├── /media/*     uploaded photos, through the Worker (src/media/media.js) to whoever may see them
 ├── D1 "ourspace-social-db"   migrations/ (users, profiles, sessions, identities, oauth_states, oauth_signups,
 │                             password_resets, spotify, follows, posts, likes, bookmarks, mentions, post_tags,
 │                             notifications, markers, boards, board_requests, votes, media, conversations,
 │                             conversation_members, chat_messages, chat_mutes, affinity, board_terms, browse_hidden,
 │                             blocks, reports, mod_log, attempts)
 ├── R2 "ourspace-social-media" (binding MEDIA)   the photo files, under random keys
 ├── Durable Objects "Room" (binding ROOMS)   one per chat room (#ourspace, each group, each DM): carries live events to
 │                             the connected sockets, owns no data (src/live/room.js)
 └── cron */30    housekeeping: expired sessions, sign-in tickets, reset links, old rate-limit rows, loose photo uploads,
                  #ourspace's rolling window, expired mutes, faded interaction scores
```

`wrangler.jsonc` sends only `/api/*` and `/media/*` to the Worker first. Every other path is served from `public/`, and a path that isn't a file gets `index.html`, so `/u/<name>`, `/messages`, `/edit` and the rest are drawn by the page's own router.

## File map

```
src/
  index.js     Worker entry
  shared/      infrastructure; never imports a feature
  catalog/     the choices people have when decorating a page
  accounts/  profiles/  follows/  social/  boards/  browse/  notifications/  chats/  media/  safety/  music/  horoscope/     features
  live/        the Durable Object behind every chat room (carries events, owns no data)
```

| Path | What |
|---|---|
| `src/index.js` | The route table (one list at the top), the cross-site check on writes, the cron. |
| `src/shared/http.js` | JSON answers, `fail(status, message)` errors, reading JSON bodies, cookies, SHA-256. |
| `src/shared/db.js` | `meter()`, which counts the rows D1 reads for a request (the Browse routes), user lookups, the shape a user takes in every answer, follows (who are friends, who may see a private profile's posts, how two people are connected, the SQL for the followers / following / friends lists), blocks, which posts the viewer may see (`VISIBLE`, `SEES`, `REPOST_OK`), a post in brief (`lite`), and `limit()`, the rate limiter. |
| `src/shared/notify.js` | Notifications: `notify()`, the statement each feature adds to its write batch (never to yourself, across a block, or about a post the person can't see), and `SHOWN`, which ones still show. |
| `src/shared/media.js` | Photos as the other features use them: a page of posts' photos in one read (`MEDIA_OF`), checking a post's `media` (`claimMedia`) and the statements that attach it in the post's write batch, a member's own uploaded picture, and deleting files from R2 (`dropObjects`) with the rows that held them. |
| `src/shared/affinity.js` | The interaction score of [decisions/001](decisions/001-ranking.md): weights, the 30-day half-life, closeness, each as JS (unit-tested) and SQL, and `bump()`, the statement every interaction adds to its write batch. |
| `src/shared/chat.js` | Chat SQL other features need: which conversations a member may open (`CHAT_OPEN`) and has on their list (`CHAT_LISTED`), unread counts (`UNREAD_CHATS`, the badge in `GET /api/me`), and handing a group to its next owner (`HANDOVER`). |
| `src/shared/live.js` | How the features reach a room's Durable Object: `tell()` (broadcast an event, minus people with a block), `kick()`, `online()`, `connect()` (the upgrade). Best effort: a failure is logged, never fails the write. |
| `src/shared/ranking.js` | The board sort keys of [decisions/001](decisions/001-ranking.md): hot, best (the Wilson bound) and score, with their constants, each as a JS function and as the SQL that stores it (`RESORT`). |
| `src/shared/text.js` | Text cleaning: invisible characters, links removed, the blocked-word list (whole words). Reading the `@mentions` and `#tags` out of a post. |
| `src/shared/dates.js` | Birthdays: parsing, the age check, age on a given day. |
| `src/shared/seal.js` | AES-GCM encryption for the tokens we have to keep (`TOKEN_KEY`), and random tokens. |
| `src/shared/mail.js` | Email through Resend (password resets only). |
| `src/shared/astro.js` | The astronomy: where the Sun, Moon and planets are on a given day (`astronomy-engine`), sign changes, retrogrades, Moon phases, aspects, star signs from birthdays, birth placements. Numbers only. |
| `src/catalog/options.js` | Every choice Edit My Page offers. The page and the server read the same list. |
| `src/catalog/avatars.js` | The picture presets. Maintained by hand. |
| `src/accounts/auth.js` | Email sign-up (birthday age check, name rules, per-IP and daily caps), log in by email or screen name (throttled), sessions, forgot/reset password, password change, account deletion. PBKDF2-SHA256 passwords. |
| `src/accounts/oauth.js` | "Other options" sign-in (Google, Apple, Microsoft, Discord, GitHub), linking and unlinking them in Settings, and the Spotify connection. Authorization code flow with PKCE (Apple uses a signed client secret instead). |
| `src/profiles/profiles.js` | Profiles (counts, a Top 8 of friends, the latest status and blog posts, Friends' Comments), Browse, Edit My Page validation (only values from `src/catalog/options.js` are accepted), the follow and message settings, show age / show sign. |
| `src/follows/follows.js` | Following, unfollowing, accepting and removing followers, the Requests tab, the followers / following / friends lists. |
| `src/social/social.js` | Statuses, blog posts, Friends' Comments, deleting posts (tombstones; board threads and comments too), conversations, the Posts and Replies tabs, `#tag` pages, the feed and the read markers. |
| `src/social/interactions.js` | Replies, quotes, likes, reposts, bookmarks and the bookmarks list. |
| `src/social/items.js` | The item every list shows (board threads and comments too), with what a whole page of them needs fetched in one batch, and writing a new post with its mentions, tags, counts and notifications in one batch. |
| `src/boards/boards.js` | The boards index, a board's threads in each sort, threads and their comment trees, writing threads and comments, and the moderators' sticky, lock and archive. |
| `src/boards/tree.js` | A thread's comments as a tree, with the caps and the "more" stubs. |
| `src/boards/votes.js` | Likes and dislikes on threads and comments. |
| `src/boards/requests.js` | Asking for a new board, and the moderators approving or declining. |
| `src/browse/browse.js` | Browse: the discovery stream (For you), Mutuals, Boards for you, Who to follow, and "not interested". Bounded, indexed candidate reads; the scoring is `score.js`. |
| `src/browse/score.js` | Browse's small algorithm as pure, unit-tested functions: interests → boards (phrases, 1–3 word runs, IDF), the mutuals order (Adamic–Adar), the discovery score, its caps and cursor, every "why" string. |
| `src/browse/terms.js` | The board_terms crosswalk (kept 5 minutes per isolate) and the moderators' routes for a board's terms. |
| `src/notifications/notifications.js` | The Notifications tab. |
| `src/chats/chats.js` | Group chats and DMs: the list, a chat, its messages, sending, read positions, making a DM or a group, adding and removing people, leaving (and the owner hand-over), answering invites, renaming, and the group suggestions. |
| `src/chats/ourspace.js` | #ourspace: its messages (the rolling window), writing (slow mode, mentions), mutes, and the cron's chat housekeeping. |
| `src/chats/messages.js` | What every chat message shares: its shape, who may see it, a page of them (`before=` / `after=`), deleting one. |
| `src/chats/live.js` | `GET /api/live/:room`: Origin, session and membership checked, then the upgrade goes to the room. |
| `src/live/room.js` | The Durable Object `Room` (WebSocket Hibernation API): who is connected (with whom they have blocks), presence, typing, broadcasts, kicks. Its event list is the comment at its top. |
| `src/media/media.js` | Photo uploads (checked, stripped, stored in R2), taking back an unused one, serving `/media/<key>` to whoever may see it, the moderators' hide and remove-now, and the cron's sweep of loose uploads. |
| `src/media/sniff.js` | What an upload really is, from its bytes: JPEG, PNG, GIF or WebP, its size in pixels, whether it moves, and whether it's whole (each format walked from end to end). |
| `src/media/strip.js` | The same walks, rebuilding the file without its metadata (EXIF and GPS, XMP, ICC, IPTC, comments, text chunks) or anything after the picture's end. |
| `src/safety/safety.js` | Blocks, reports (with a snapshot of the reported text), the moderation actions and log. |
| `src/music/spotify.js` | Each person's Spotify: tokens (stored encrypted), their top songs (cached for 6 hours), and previews from iTunes when Spotify has none. |
| `src/horoscope/horoscope.js` | The words: today's sky, each sign's horoscope, personal readings. |
| `public/_headers` | Content-Security-Policy and other security headers for the pages. |
| `public/blog/` | malten's essays and their index: static pages, maintained by hand. |
| `public/assets/` | Every image the pages and `src/catalog/` use. Credits are in [CREDITS.md](../public/assets/CREDITS.md), served at `/assets/CREDITS.md`. |
| `migrations/` | D1 schema, one numbered file per change. |
| `tools/demo.mjs` | `npm run demo`: the site on your computer with sample content and pretend sign-in pages. |
| `test/` | `api.test.mjs` (end-to-end, against a throwaway local Worker), `migrations.test.mjs` (a migration applied to a database the earlier ones left), `astro.test.mjs` (the astronomy against known dates), `text.test.mjs` (the `@mention` and `#tag` readers), `media.test.mjs` (the photo sniffers and metadata strippers, on byte-built files with GPS blocks, comments and text chunks, and on the real images in `public/assets`), `ranking.test.mjs` (the board sort keys against worked-out values, and the comment tree), `browse.test.mjs` (Browse's scoring on fixed fixtures), `affinity.test.mjs` (the interaction score's decay and closeness), the WebSocket tests inside `api.test.mjs` (Node's own `WebSocket` against the test `wrangler dev`, with its Durable Objects), `frontend.test.mjs` (page code from `public/js` on a pretend browser, `helpers/fake-dom.mjs`, with the API answered by the test), `static.test.mjs` (assets and imports), `helpers/mock-providers.mjs` (a stand-in for every sign-in provider, Spotify and iTunes, used by the tests and the demo), `helpers/images.mjs` (small JPEG, PNG, GIF and WebP files built byte by byte, for the photo tests and the demo's sample photos). |

Features import only `shared/` and `catalog/`. The few exceptions are listed in [CONVENTIONS.md](../CONVENTIONS.md).

## The life of a request

1. `fetch` in `src/index.js` hands anything that isn't under `/api/` or `/media/` to the static assets. A `/media/<key>` address (GET or HEAD) reads the session and goes to `serveMedia` ([Photos](#photos)).
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
7. **Cron**, every 30 minutes (`*/30 * * * *`): deletes expired sessions, sign-in tickets (`oauth_states`, `oauth_signups`) and reset links, rate-limit rows (`attempts`) older than two days, photo uploads never attached to anything within a day or left without their post or owner (with their files in R2; never photos held as evidence), #ourspace messages outside its rolling window (never reported ones), expired mutes, and interaction scores faded below 0.05.

## Following, friends and the feed

### The data

`migrations/0002_follows.sql` replaced the friend requests of `0001` (friends became two follows, a waiting request became the asker's follow).

| Table / column | What |
|---|---|
| `follows` | One row per follow: `follower_id` follows `followee_id`, `status` `accepted` or `pending`, `created`, `accepted` (when). **Friends** are two people who follow each other, both accepted; friendship isn't stored anywhere else. |
| `users.follow_policy` | `open` (the default: a follow is accepted at once) or `approve` (a private profile: follows wait as requests). |
| `users.dm_policy` | `everyone` or `friends` (in the sense above). |
| `posts` | `kind` is `status` (up to 500 characters), `blog` (title in `subject`, an optional `subtitle`, `mood`, a body up to 20,000), `wall` (a Friends' Comment on `target_id`'s page) or `bulletin`; since `0003` also `reply`, `quote` and `repost` (see [the next section](#replies-likes-reposts-quotes-bookmarks-mentions-tags-and-notifications)); since `0004` `thread` and `comment` instead of `bulletin` (see [Boards](#boards-threads-nested-comments-and-votes)). |
| `markers` | Read positions, like Mastodon's markers: `(user_id, name)` → `last_created` / `last_id` of the last thing seen. `name` is `feed` (the last post) or `notifications` (the newest notification). |

### Who sees what

- Everyone sees a profile page itself: name, picture, details, counts, Top 8, Spotify. A private profile's statuses, blog, Friends' Comments and its followers / following / friends lists are for its accepted followers, the owner and moderators only (`canSeePosts` in `src/shared/db.js`); anyone else gets `403 this profile is private.` (a single post, `GET /api/posts/:id`, answers `404 that post is gone.` instead, exactly like a post that doesn't exist, so the answer doesn't say a private post is there). Going private keeps the followers someone already has. Going open accepts everyone who was waiting.
- Friends' Comments are written by the owner and their friends only, and never appear in a feed. The owner can delete any comment on their page. The Top 8 holds friends only (the server drops anyone else when it's saved). It is the friends the owner chose, then their newest friends up to 8; somebody who can't see a private profile's posts gets only the chosen ones, so the fill doesn't give the friend list away.
- Blocking deletes the follows between the two people, both ways, and they can't follow each other while it lasts.

### The feed

`GET /api/feed` has statuses, blog posts, quotes and reposts, never replies, Friends' Comments or board threads. A repost of a post the viewer may not see (its author went private, blocked them, was banned) is left out.

- **scope** `following` (the default when logged in): people I follow (accepted) and me. `everyone` (always, when logged out): everybody with an open profile.
- **mode** `latest`: newest first, 30 a page; `next` is the cursor (`<created>:<id>`) for `before=`. `resume` ("pick up where I left off"): oldest first, from just after my `feed` marker (or three days back if I have none yet); `next` is the cursor for `after=`. Resume leaves out my own posts and, in the following scope, anything written before I followed its author.
- Every answer carries `marker` (`{ created, id }` or null) and `unseen`: how many posts resume mode has waiting after the marker, up to 999. The page moves the marker with `PUT /api/me/markers/feed` as posts scroll past, and the server ignores a position older than the one it has.
- Blog bodies over 400 characters arrive cut short, with `excerpt: true`. `GET /api/posts/:id` has the whole post.

### The routes

| Route | Access | Answer |
|---|---|---|
| `POST /api/follows/:name` | member | Follow (or ask to). `{ relation }`. Refuses yourself (400), a block either way (403), banned or missing (404). 20 an hour, 100 a day. |
| `DELETE /api/follows/:name` | member | Unfollow, or take back a request. `{ relation }` |
| `POST /api/followers/:name` | member | Accept their request (404 if there isn't one). `{ relation }` |
| `DELETE /api/followers/:name` | member | Remove a follower, or decline their request. `{ relation }` |
| `GET /api/requests` | member | `{ incoming: [{ user, created }], outgoing: [{ user, created }] }`: pending follows to and from me. |
| `GET /api/users/:name/followers` · `/following` · `/friends` | anyone | `{ user, people: [{ id, name, avatar, online }] }`, up to 500, newest first. |
| `GET /api/users/:name` | anyone | The profile: `counts { followers, following, friends, statuses, replies, blog, comments }` (the last four are the totals the tabs show, left off when `canSeePosts` is false; `statuses` is the Posts tab: statuses, quotes and reposts), `top8`, `private`, `canSeePosts`, `latestStatus`, `blog` (the latest 3: `{ id, title, subtitle, created }`), `relation`, `policies { follow, dm }`, and the page itself. |
| `GET /api/users/:name/statuses?before=` | anyone | The Posts tab: statuses, quotes and reposts. `{ items, next }`, 30 a page. |
| `GET /api/users/:name/replies?before=` | anyone | The Replies tab. `{ items, next }`, 30 a page. |
| `GET /api/users/:name/blog` | anyone | `{ user, entries }`, newest first, long bodies cut short. |
| `GET /api/users/:name/comments?page=N` | anyone | `{ comments: [{ id, body, created, author, mentions, canDelete }], total, page, pages }`: Friends' Comments, newest first, 10 a page. `page` starts at 1; one past the end answers with the last page. `canDelete`: the author, the page's owner, moderators. |
| `POST /api/users/:name/comments` | member | `{ body }` up to 500 → `{ id, body }`. Owner and friends only. The owner is notified, and so is anyone it `@mentions` who may see it. |
| `POST /api/status` | member | `{ body }` up to 500 → `{ id, body }`. |
| `POST /api/blog` | member | `{ title (100), subtitle? (160), mood?, body (20,000) }` → `{ id }`. |
| `GET /api/posts/:id?after=` | anyone | A status, blog post, quote or reply in full, with its conversation (next section). 404 if it's missing or the writer's profile is private to you. |
| `GET /api/feed?scope=&mode=&before=&after=` | anyone | `{ items, next, marker, unseen }` |
| `PUT /api/me/markers/:name` | member | `name` is `feed` or `notifications`. `{ created, id }` → `{ ok, marker }`. Forward only, 120 a minute. |
| `PUT /api/me/settings` | member | `{ followPolicy: open \| approve, dmPolicy: everyone \| friends }` |

`relation` is `{ following: none | pending | accepted, followsMe, friends, blockedByMe, canComment, canMessage }`, or null when logged out. Every list holds items, described in the next section.

## Replies, likes, reposts, quotes, bookmarks, mentions, tags and notifications

Statuses and blog posts get Twitter's interactions. Friends' Comments only get `@mentions`. Board threads and comments get Reddit's instead (next section).

### The data

`migrations/0003_interactions.sql`:

| Table / column | What |
|---|---|
| `posts.kind` | adds `reply` (up to 500 characters, answering `reply_to`), `quote` (up to 500, about `quote_of`) and `repost` (no words, just `quote_of`; one per person per post, a partial unique index). |
| `posts.reply_to`, `root_id`, `quote_of` | The post a reply answers, its conversation's first post (NULL on that post itself and on anything that isn't a reply), the post a quote or repost points at. `quote_of` is `ON DELETE SET NULL`; `reply_to` and `root_id` are plain ids, not foreign keys, so when a post goes with its writer's account the replies to it keep pointing at it: they stay in their conversation and say they answer a deleted account. (Board comments are the exception: they move up to the post above, see Boards.) |
| `posts.like_count`, `reply_count`, `repost_count`, `quote_count` | Changed in the same batch as every write that changes them, and only when that write really happens (`EXISTS` / `NOT EXISTS` guards), so liking twice or two deletes at once can't skew them. Deleted replies and quotes aren't counted. Posts the viewer can't see are (as on Twitter). |
| `posts.deleted` | A tombstone: a deleted post that still has replies or quotes stays, its words cleared, so the conversation keeps its shape. Once nothing holds it (no replies left, no quote that isn't deleted) it's removed, and so are the tombstones above it that only it held (`CLEAR_TOMBSTONES` in `src/shared/db.js`). |
| `likes`, `bookmarks` | `(user_id, post_id, created)`. Bookmarks are private to their owner. |
| `mentions` | `(post_id, user_id)`: who a post `@mentions`, resolved when it's written. |
| `post_tags` | `(tag, post_id, created)`: its `#tags`, lower case; `created` is the post's, so a tag's page reads newest first from the index. |
| `notifications` | `(id, user_id, kind, actor_id, post_id, created)`. `kind`: `like`, `reply`, `repost`, `quote`, `mention`, `comment` (a Friends' Comment on your page), `follow`, `follow_request`, `follow_accepted`. `post_id` is the post that was liked or reposted, or the reply, quote, mention or comment itself; NULL for follows. |

### The rules

- **Visible** means what it meant before (author not banned, no block either way, the author's privacy, not hidden by a moderator) and not deleted. Replying, liking and bookmarking need a post you can see; reposting and quoting also need its author's profile to be open. Only statuses, blog posts, replies and quotes take them. You may repost and quote your own posts.
- **A repost stands for its original.** Replying to, liking, reposting, quoting or bookmarking a repost acts on its original, and `GET /api/posts/<a repost>` opens the original. Undoing (`DELETE …/like`, `…/repost`, `…/bookmark`) works whether or not you can still see the post, but only a post you can see gets its count in the answer: for one you can't (private to you, blocked, banned, hidden, deleted) the answer is exactly the one a missing post gets (`200 { liked: false }`, `{ reposted: false }`, `{ bookmarked: false }`), so it says nothing about it.
- **A post deleted at the same moment** gets nothing: every like, repost, bookmark, reply and quote checks in its own write batch that the post is still there (not deleted, not hidden), and only a write that happened moves a count or sends a notification. Otherwise it's `404 that post is gone.`
- **Deleting** (`DELETE /api/posts/:id`, answering `{ ok, tombstone }`): a post with replies or quotes becomes a tombstone (`tombstone: true`), otherwise it's removed. Either way its likes, bookmarks, reposts, mentions, tags and notifications go, and the counts of the post it answered or quoted come down; if that post is a tombstone nothing holds any more, it's removed too, and so on up the conversation. Deleting a repost undoes it. Deleting an account takes its likes, reposts, bookmarks and notifications with it and brings the counts on other people's posts down, and other people's tombstones that only its replies or quotes held go; others' replies to and quotes of its posts stay (a reply then answers "a deleted account", a quote's original is unavailable).
- **@mentions**: `@name` in statuses, replies, quotes, blog posts (title and body) and Friends' Comments, read from the stored text. Names are 3–20 of `A-Za-z0-9_~*.-`; a trailing `. ~ * -` is punctuation unless somebody's name really ends that way (the longest name that exists wins). Up to 10 per post; never yourself, anyone banned, or anyone with a block either way.
- **#tags**: 1–40 letters (any alphabet), digits or `_` with at least one letter, lower case, up to 10 per post, in statuses, replies, quotes and blog posts (title and body); not in Friends' Comments, so the page doesn't link a comment's `#tags`. Blank "letters" (the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the blank Braille pattern U+2800) are invisible characters, stripped from everything people type, so they make no tag.
- **Notifications** (`notify()` in `src/shared/notify.js`, a statement in the same batch as the write): never for your own doings, never across a block either way (with whoever did it, the post's writer, or, for a Friends' Comment, the owner of the page it's on), never about a post the person can't see (a private profile mentioning somebody who doesn't follow it tells nobody). Someone told about a reply or a quote isn't told again that it mentions them. Taking back a like, a repost or a follow takes its notification back; deleting a post takes back the notifications about it. The same rules are applied again when they're read (`SHOWN`), so a later block or a profile going private hides old ones too. Unread means newer than the `notifications` marker.
- **Rate limits**: replies and quotes count as posts (6 a minute and 300 a day, with statuses and the rest); likes 300 an hour, reposts 60 an hour, bookmarks 300 an hour.

### The item

Every list and page returns posts in one shape:

```
{ id, kind, created, subject, subtitle, body, excerpt, mood, author: { id, name, avatar }, canDelete,
  replyTo: { id, author } | null,     a reply's parent, named only if the viewer may see it: { id, author: null } when it
                                      went with its writer's account, { id: null, author: null } when it's private to the
                                      viewer, blocked either way, banned or hidden
  rootId: id | null,                  a reply's conversation; null on everything else
  quoted: …,                          see below; null unless kind is quote or repost
  counts: { likes, replies, reposts, quotes },
  viewer: { liked, reposted, bookmarked },        all false when logged out
  mentions: [{ id, name }],           the people the server resolved (banned or blocked ones left out)
  tags: [tag],
  media: [{ id, url, width, height, alt }],       its photos in order ([] for none; see Photos)
  cover: { id, url, width, height, alt } | null,  blog posts only
  deleted: bool }                     a tombstone: no words, canDelete false, quoted null, no photos
```

- A **quote**'s `quoted` is the original in brief: `{ id, kind, created, subject, subtitle, body (cut at 280 characters, with …), author, deleted, media }` (`deleted: true` and no words for a tombstone: "this post was deleted"), or `{ unavailable: true }` when it's gone, hidden, or not visible to the viewer. Notifications carry their post in the same shape, without `media`.
- A **repost**'s `author` is the person who reposted it and its `body` is empty; `quoted` is the original as a whole item (with its own counts, flags, mentions, tags and, for a quote, its own `quoted`). The repost's `counts` and `viewer` are the original's, since acting on a repost acts on the original. Lists leave out reposts of posts the viewer can't see.
- Blog bodies in lists over 400 characters arrive cut short, with `excerpt: true`.
- What a page of items needs beyond their own columns (originals, flags, mentions, tags, photos) is fetched for the whole page in one batch (`hydrate()` in `src/social/items.js`).

### The routes

| Route | Access | Answer |
|---|---|---|
| `GET /api/posts/:id?after=` | anyone | `{ post, ancestors, replies, next }`: `ancestors` are the posts it answers up to the conversation's first (the nearest 20, oldest first); `replies` is everything under it however deep, oldest first, 50 a page (`next` is the cursor for `after=`). Tombstones keep their place. |
| `POST /api/posts/:id/replies` | member | `{ body }` up to 500 → 201 `{ post }`. |
| `POST /api/posts/:id/quote` | member | `{ body }` up to 500 (required) → 201 `{ post }`. 403 for a private profile's post. |
| `DELETE /api/posts/:id` | member | Your own post, a comment on your page, or anything (moderators). `{ ok, tombstone }`: whether it stays as a tombstone. 404 if it's already gone, 403 if it isn't yours. |
| `POST` · `DELETE /api/posts/:id/like` | member | `{ liked, likes }` (undoing on a post you can't see: `{ liked: false }`, as for a missing one) |
| `POST` · `DELETE /api/posts/:id/repost` | member | `{ reposted, reposts }` (undoing: as for likes). 403 for a private profile's post. |
| `POST` · `DELETE /api/posts/:id/bookmark` | member | `{ bookmarked }` |
| `GET /api/me/bookmarks?before=` | member | `{ items, next }`: newest bookmark first, 30 a page, only posts you may still see. The cursor is `<bookmarked>:<post id>`. |
| `GET /api/tags/:tag?before=` | anyone | `{ tag, items, next }`: the visible posts with that tag (replies included), newest first, 30 a page. Any case, with or without the `#`; anything that isn't a tag is 404. |
| `GET /api/users/:name/replies?before=` | anyone | The Replies tab (previous section). |
| `GET /api/notifications?before=` | member | `{ items: [{ id, kind, created, actor, post, unread }], next, unread }`, newest first, 30 a page. `post` is the post in brief (as a quote's `quoted`, plus `page: { id, name, avatar }` for a Friends' Comment) or null. `unread` (the total) stops at 99. |
| `GET /api/me` | anyone | `counts` adds `notifications`: unread ones, up to 99. |

## Boards: threads, nested comments and votes

The bulletin board became topic boards, like a forum: a board (Cooking, Random …) lists its threads, phpBB-style, and a thread opens with its whole post and its comments, nested Reddit-style. Threads and every comment take a like and a dislike, both counted and shown. Statuses and blog posts keep their tweet-style replies and likes.

### The data

`migrations/0004_boards.sql`:

| Table / column | What |
|---|---|
| `boards` | `(id, slug, name, description, icon, position, created, archived)`. Curated: the 14 at launch (Music, Movies & TV, Games, Art & Layouts, Cooking, Pets, Sports, Tech & Computers, Fashion, Books & Writing, Astrology, School, Advice, Random), more from approved requests. `icon` is an emoji; the index is in `position` order. An archived board leaves the index and takes no new threads, comments or votes; what's in it stays readable. |
| `board_requests` | `(id, user_id, name, reason, status, created, decided_by, decided, board_id)`. `status` `pending`, `approved` (`board_id` is the board it made) or `declined`. |
| `posts.kind` | `thread` (a title in `subject` up to 120 characters, words up to 10,000) and `comment` (up to 10,000, answering `reply_to`: the thread or another comment; `root_id` is the thread). Both carry `board_id`. The bulletins became threads in Random, keeping their ids, writers and times; nothing writes `bulletin` any more. |
| `posts.sticky`, `locked` | Threads only. Sticky threads come first in every sort; a locked one takes no new comments or votes. |
| `posts.up_count`, `down_count` | The votes. `comment_count`: a thread's comments that aren't deleted, however deep. `reply_count` stays the direct answers (a thread's top-level comments, a comment's replies). Kept exact like 0003's counts: they move in the same batch as the write that changes them, and only when it really happens. |
| `posts.hot`, `best`, `score` | The stored sort keys of [decisions/001](decisions/001-ranking.md), in `src/shared/ranking.js`: `score` = up - down; `best` = the Wilson lower bound of up among up + down at z = 1.2816; `hot` (threads) = sign(s)·log10(1 + \|s\|) + (created - EPOCH) / UNIT with s = up - down + min(comments from others, 5), EPOCH 2026-01-01, UNIT 2 days. They're recomputed by SQL in the same batch as every vote, comment and delete (`RESORT`), from the row the counts just landed in, so nothing can leave them stale; the JS functions are the unit-tested reference and what a new thread starts with. Each board sort has its index (`board_id, sticky, key DESC, created DESC, id DESC`, threads only). |
| `votes` | `(user_id, post_id, value +1 \| -1, created)`, one per person per post. |
| `notifications.request_id` | For the kinds `board_approved` and `board_declined`: the request it answers. A comment is told as a `reply`. |

### The rules

- **Boards are public spaces.** A thread or comment shows to everyone, logged in or not, even when its writer's profile is private (the privacy hint in Settings says a private member's bulletins are seen by whoever can see them; the front end words it for boards). Everything else that hides a post still hides it: a banned writer, a block either way, a moderator's hide, a deleted post. A comment the viewer can't see is left out of the tree with every reply under it.
- **Never in the feed.** Board threads aren't in the Following or Everyone feed or on the Posts tab; Browse's For you suggests them ([Browse](#browse-for-you-mutuals-boards-for-you-who-to-follow)). Their `#tags` have pages like other posts' (`GET /api/tags/:tag`), and `@mentions` work in threads and comments. Comments get `@mentions` only, no `#tags`, like Friends' Comments.
- **Reach.** A vote or a reply needs its target to be reachable for the writer the way the tree reaches it: the thread and every comment above the target show to them (none hidden, none by someone banned, no block either way; a tombstone on the way is fine). Otherwise it's a 404 and nothing moves. A notification about a comment shows only while that holds for its reader, so hiding a thread or a comment silences what was told about the comments under it.
- **Votes**: one per person per post, switched or taken back (`value` 0). Never on your own post, a deleted or hidden one, in a locked thread or an archived board. Nobody is told about a vote. A vote checks in its own batch that the voter's vote is still the one it read and that the post still takes votes, so two votes at once or a delete or a lock at the same moment can't move the counts without the vote.
- **Comments**: nested as deep as people like. A deleted comment that still has replies stays as a tombstone (`deleted: true`, no words, "[deleted]") until nothing holds it, as in phase 2; a deleted thread stays as one while any comment is in it, however deep. When a comment goes with its writer's account, the replies to it move up to the comment (or thread) it answered, so every comment answers a post that's there and every thread holding comments is there. Deleting an account takes its threads with all their comments, its comments elsewhere, and its votes, and puts the counts and keys of everyone else's posts right.
- **Notifications**: a comment tells whoever wrote what it answers (the thread or the comment) as a `reply`, and anyone it `@mentions`, by phase 2's rules (never across a block, never about your own doings). A board request's answer tells the member who asked.
- **Moderators** (only they) pin and lock threads, archive boards and decide requests; each lands in the moderation log. Threads and comments are reported and hidden like any post, and a locked thread can still be moderated.
- **Rate limits**: threads 3 an hour and 10 a day, and they and comments count as posts (6 a minute, 300 a day); votes 300 an hour (taking one back is free); board requests 3 a day.

### The answers

- **A board's thread** (thread-lite): `{ id, subject, excerpt (the words cut at 200 characters, with …), author, created, sticky, locked, counts: { up, down, comments }, lastComment: { created, author } | null, viewer: { vote }, media }` (`media` as on an item). `viewer.vote` is 1, -1 or 0.
- **A thread or comment as an item** (the item of the previous section, with votes instead of likes): `counts: { up, down, comments }` (a thread's comments however deep, a comment's direct replies), `viewer: { vote }`, `board: { slug, name, icon, archived }`; a thread also has `sticky` and `locked`. On a `#tag` page a thread shows as a card with its board, title, a line of its words and its ▲ ▼ 💬 counts (to read), all leading to the thread page. A comment's `replyTo` is the thread or the comment it answers, `rootId` its thread.
- **A comment tree**: `[{ item, children: [...] }]`, siblings sorted within their parent: `best` (ties: older first), `new` or `old`. One answer holds up to 200 comments, 8 levels and 10 replies per comment (the top level takes the rest of the 200). What's cut is a stub `{ more, parent, after }`: `more` comments under `parent` (a comment, or the thread's id for the top level) after the sibling the cursor `after` names (`<best>:<created>:<id>` in best, `<created>:<id>` in new and old; null: from the first), which `GET /api/threads/:id/comments/:parent?sort=&after=` brings back. The cursor is a place in the sort, not a position, so comments written or deleted in between neither repeat nor go missing (the page also never draws a comment twice). The whole thread is read in one query (its oldest 5,000 comments), the tree is cut in the Worker (`src/boards/tree.js`), and only the comments that show are read in full, with one batch for what their items need.

### The routes

| Route | Access | Answer |
|---|---|---|
| `GET /api/boards` | anyone | `{ boards: [{ slug, name, description, icon, threads, lastPost: { created, author, thread: { id, subject } } \| null }] }`: the index in order, without archived boards. `threads` and `lastPost` count only what the viewer may see. |
| `GET /api/boards/:slug?sort=hot\|new\|top\|best&before=` | anyone | `{ board: { slug, name, description, icon, archived }, sort, items: [thread-lite], next }`: 25 a page, the sticky threads first (first page only). Every sort ties on newest first. `next` is the cursor for `before=`: `<key>:<created>:<id>`. |
| `POST /api/boards/:slug/threads` | member | `{ subject (120), body (10,000) }` → 201 `{ thread }` (an item). 403 on an archived board. |
| `GET /api/threads/:id?sort=best\|new\|old` | anyone | `{ thread, sort, comments }`: the thread as an item (a tombstone too) and its comment tree. 404 if it's missing or hidden from the viewer. |
| `GET /api/threads/:id/comments/:commentId?sort=&after=` | anyone | `{ parent, sort, comments }`: the tree under one of its comments (`parent` is that comment as an item), or under the thread itself when `:commentId` is the thread's id (`parent` null), after the sibling a stub's cursor `after` names (none: from the first). 404 for a comment that isn't in the thread or doesn't show. |
| `POST /api/threads/:id/comments` | member | `{ body (10,000), parent? }` → 201 `{ comment }` (an item). `parent` is a comment in the thread (default: the thread). 403 when locked or archived, 404 when the thread or the comment is gone or the writer can't reach it (rules above). |
| `PUT /api/posts/:id/vote` | member | `{ value: 1 \| -1 \| 0 }` → `{ vote, up, down }`. Threads and comments only (404 otherwise, and for one the voter can't reach); 400 on your own post; 403 when locked or archived (the message says which). |
| `DELETE /api/posts/:id` | member | Deletes threads and comments too (previous section). |
| `POST /api/boards/requests` | member | `{ name (40), reason (500) }` → 201 `{ request: { id, name, reason, status, created, decided } }` |
| `GET /api/admin/board-requests?status=open\|closed` | moderator | `{ requests: [{ …request, user, decidedBy, board }] }`: waiting ones oldest first, or the last 100 decided. |
| `POST /api/admin/board-requests/:id` | moderator | `{ action: approve \| decline, slug?, name?, icon?, description? }` → `{ request, board }`. Approving makes the board at the end of the index: `slug` (default: from the name; up to 30 lower-case letters, digits and dashes), `name` (default: the one asked for), `icon` (an emoji, default 💬), `description` (140). 409 when it was already decided or the slug is taken. |
| `POST /api/admin/threads/:id` | moderator | `{ sticky?, locked? }` → `{ thread: { id, sticky, locked } }` |
| `POST /api/admin/boards/:slug` | moderator | `{ archived }` → `{ board }` |
| `GET /api/notifications` | member | A board thread's or comment's `post` adds `board: { slug, name }` and `threadId`; `board_approved` and `board_declined` carry `request: { name, status, board: { slug, name, icon } \| null }` and no post. |

## Photos

Members put photos on statuses, replies, quotes and board threads (up to 4), board comments (1) and blog posts (a cover), and may upload their own profile picture instead of a preset. No video: the owner dropped it ([decisions/005](decisions/005-media-formats.md)). Not in messages or Friends' Comments.

### The pipeline

1. **The browser** decodes the photo (`createImageBitmap(file, { imageOrientation: 'from-image' })`), shrinks it to 1600 px on the long side (a picture: a 300 px square, centre-cropped) and encodes it again (JPEG at about 0.85, PNG for transparency), which drops its EXIF and GPS. An animated GIF up to 2 MB and 800 × 800 goes up as it is.
2. **`POST /api/media?purpose=post|cover|avatar`** never trusts the browser. It reads what the file really is from its bytes (`src/media/sniff.js`: JPEG, PNG, GIF or WebP; SVG, HTML, HEIC and everything else are refused, whatever the name or the `Content-Type` say, and a declared type that doesn't match is refused too), walks the whole file so a cut-off one or one that only starts like a picture is refused, and checks its size: 2 MB, 4096 px a side, an animated one 800 × 800, a picture square and 300 px at most. Then it takes the metadata out (`src/media/strip.js`) and checks the result again. The body is the raw file (`Content-Type: image/jpeg` (or `image/jpg`), `png`, `gif` or `webp`) or a multipart form with one file (a part typed `application/octet-stream`, or not typed, declares nothing and is read from its bytes alone); both still pass the cross-site check on every write.
3. **R2** keeps the stripped file under `<32 random hex digits>.<jpg|png|gif|webp>`, never the uploaded name, with the type the server read.
4. **Attaching**: a post's create call names the uploads in `media`; a picture is set with `PUT /api/me/profile { avatar: '/media/<key>' }`. Until then an upload is loose, seen only by its owner, and the cron deletes it after a day.

What the stripper keeps is an allowlist, each part cut to the size its own fields give it, so nothing rides along inside a kept part: JPEG DQT, DHT, DAC, DRI, SOFn, SOS with its scan data, RSTn, DNL and EOI (DQT or DHT that aren't whole tables make the file broken), a JFIF APP0 cut to its 16-byte header (no thumbnail) and Adobe's APP14 colour marker cut to its 12 bytes; everything else goes (APP1–APP15 with EXIF, GPS, XMP, ICC and IPTC, JFXX thumbnails, COM, JPGn, reserved markers). PNG IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, sBIT, bKGD and pHYs at their proper sizes, and acTL, fcTL, fdAT only in a real APNG (so tEXt, zTXt, iTXt, eXIf, tIME and iCCP go: a colour profile has room for any text, and dropping it can shift colours slightly). GIF graphic control extensions rebuilt at their 4 bytes and the NETSCAPE2.0 / ANIMEXTS1.0 loop at its 3, everything else (comments, plain text, other application extensions, extra sub-blocks) dropped. WebP VP8X (cut to 10 bytes, the EXIF, XMP and ICC flags off), VP8, VP8L, ALPH, ANIM (cut to 6) and ANMF frames holding only their picture chunks; EXIF, XMP, ICCP and anything unknown go. Bytes after the picture's end go too. What no walker can take out is data inside the compressed picture itself (a JPEG scan, a VP8 or VP8L bitstream): only re-encoding clears that, which the browser does before every upload but which the server doesn't redo.

### The data

`migrations/0005_media.sql` (and `0006_media_review.sql`, which adds `media.reviewed_by` / `reviewed_at`, the moderators' review marks, and `reports.intimate`):

| Table / column | What |
|---|---|
| `media` | `(id, key, owner_id, purpose, mime, bytes, width, height, alt, created, attached, post_id, position, hidden, reviewed_by, reviewed_at)`. `reviewed_by` / `reviewed_at`: the moderator who marked it seen, and when (NULL until then). `purpose`: `post`, `cover` or `avatar`. `attached`: when it went on its post (`post_id`, in `position` order, with its `alt` text up to 200 characters) or became its owner's picture; NULL while it's loose. `hidden`: a moderator hid this one photo (it's then held as evidence). `post_id` and `owner_id` are `ON DELETE SET NULL`, so a post or an account that went some other way leaves its photos for the cron (which skips hidden ones). |
| trigger `media_attach_once` | An upload is attached once: a second attach fails its whole write batch, so two posts racing for the same upload can't both get it (the loser writes nothing at all: no post, counts or notifications). |
| trigger `media_held_with_post` | A post a moderator hid that's deleted, however it goes, turns its photos into hidden photos first, so they stay held. |

Every path that deletes `media` rows does it with `DELETE … RETURNING key` in the batch that deletes what they were on, then deletes those keys from R2 (`dropObjects`): deleting a post (whether it goes or stays as a tombstone), deleting an account (its uploads, and the photos on other people's comments that go with its threads), changing the picture, a member taking back an upload, a moderator's remove, the cron. Only the batch that really deleted the rows gets their keys, so nothing is deleted twice or missed when two deletes race. Except for a moderator's remove, each of them skips photos held as evidence (see the rules): `releaseMedia` deletes the others and turns the held ones into hidden photos off their post.

### The rules

- **Attaching** (`claimMedia` in `src/shared/media.js`): `media` is a list of upload ids or `{ id, alt }`; only your own uploads of the right purpose (`post`, or `cover` for a blog post), not attached to anything yet and not older than 23 hours, up to the kind's limit, each once. Otherwise 400 (not yours, wrong purpose, too many, twice), 409 (already on another post) or 410 (expired). With a photo, a status, reply, quote, thread or comment may leave out its words (a thread still needs its title).
- **Who sees a photo** (`GET /media/:key`): moderators, everything; a loose upload, its owner only; a picture, everyone; a post's photo, whoever may see that post: not hidden, not deleted, writer not banned, no block either way, and a private profile's only for its accepted followers (board posts are public spaces). A board comment's photo also needs its thread to show to the viewer (not deleted or hidden, writer not banned, no block either way, like the boards' `THREAD_SHOWN`) and every comment above it (`REACHABLE`: none hidden by a moderator, by someone banned or across a block). Anyone else gets a 404 exactly like a missing key, so following someone's photos stops working the moment they go private, remove you, block you or delete the post. A photo a moderator hid on its own is 404 too.
- **Headers**: the stored `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, an `ETag`. `Cache-Control: public, max-age=300` for public ones (an open profile's posts, board threads, pictures), then revalidated with the `ETag` (`If-None-Match` → 304, after the access check, so a viewer who lost access gets 404, not 304); `private, no-store` for everything else, board comments included. The trade-off: five minutes of caching spares the Worker repeat reads, and a profile going private, a block, a ban, a moderator's hide or remove reaches browsers that already loaded a public photo within those five minutes. (The keys never change, so a year's `immutable` cache would be possible, but it would keep showing a photo from the browser's cache long after access to it was taken away.) Photos are same-origin, so the pages' CSP (`img-src 'self'`) already covers them. A page previewing a file before it's uploaded has to use a `data:` URL, since `blob:` isn't allowed.
- **Pictures**: `avatar` takes a preset or `/media/<key>` of your own picture upload (not hidden). Changing it (to an upload or a preset) deletes the picture you uploaded before. A moderator removing someone's picture puts them back on the default preset.
- **Moderators** (`POST /api/admin/media/:id`): `remove` deletes the photo from R2 and the table at once and logs `remove_media` (for Take It Down requests and anything that must go now); `hide` / `unhide` stop and restart it showing anywhere. Hiding a post hides its photos. A report on a post keeps its photos, hidden ones included (`{ id, url, width, height, alt }`), in its snapshot, and moderators can open them whatever their privacy. **Review** (launch plan: in-house, no automatic scanning; [deploy.md](deploy.md#photos-csam-detection-launch-in-house-review)): the Photos section of the Moderation page lists every upload through `GET /api/admin/media`, and a moderator marks each seen (`reviewed`). **CSAM reports**: a report with reason `csam` on a post sets `hidden = 1` on its photos at once (served to moderators only, and held through the author deleting the post), lists first in `GET /api/admin/reports`, and carries `deadline` (filed + 48 hours; also on a report a moderator marked `intimate` with `POST /api/admin/reports/:id { action: 'intimate' }`, which leaves it open). The Moderation page shows the time since filing and the time left.
- **Held as evidence**: a photo a moderator hid, or any photo on a post a moderator hid, is held (`HELD` in `src/shared/media.js`). Nothing its owner does deletes it: deleting the post (gone or a tombstone), changing the picture, taking back an upload, deleting the account. Those only take it off its post as a hidden photo (`post_id` NULL; `owner_id` NULL once the account is gone), the cron skips it, and it stays (reachable by moderators, from the report) until a moderator removes it. Unhiding a held photo that's no longer on a post lets the cron delete it.
- **Limits**: 30 uploads an hour and 150 a day per member, and 200 MB of photos in all (`413 you've used all 200 MB of your photo space …`).

### The routes

| Route | Access | Answer |
|---|---|---|
| `POST /api/media?purpose=post\|cover\|avatar` | member | The raw file (`Content-Type: image/…`) or a multipart form with one file → 201 `{ media: { id, url, width, height, mime } }`. 415 not a picture (or not what it says), 400 broken, too large or a picture that isn't a square up to 300 px, 413 over 2 MB or over the 200 MB space, 429 too many. |
| `DELETE /api/media/:id` | member | Take back your own loose upload → `{ ok }` (404 when it's gone or already attached). |
| `GET` · `HEAD /media/:key` | anyone | The photo, for whoever may see it (rules above), else 404. |
| `POST /api/status`, `POST /api/posts/:id/replies`, `POST /api/posts/:id/quote` | member | Also take `media` (up to 4). |
| `POST /api/boards/:slug/threads` · `POST /api/threads/:id/comments` | member | Also take `media` (up to 4 · 1). |
| `POST /api/blog` | member | Also takes `cover` (one cover upload: an id or `{ id, alt }`; `media: [that]` works too). |
| `PUT /api/me/profile` | member | `avatar` also takes `/media/<key>` of your own picture upload; the answer's `avatar` is the one now set. |
| `GET /api/admin/media?before=&filter=unreviewed\|all` | moderator | The photo review queue: every upload, attached or loose, newest first, 30 a page → `{ media: [{ id, url, width, height, alt, purpose, created, hidden, reviewed, reviewedAt, reviewedBy, uploader: { id, name, avatar, created } \| null, where }], next }`. `uploader.created` is the account's age; `where` is `null` (loose) or `{ type: avatar \| cover \| post \| thread \| comment \| gone, id, author, board, thread }`; `next` is the `before` for the following page (an id) or `null`. The default filter is `unreviewed`. |
| `POST /api/admin/media/:id` | moderator | `{ action: reviewed \| remove \| hide \| unhide, note }` → `{ ok }`. `reviewed` records who and when (the first mark stays; not in the moderation log). 404 when it's already gone. |

## Live chat: #ourspace, group chats and DMs

**#ourspace** is one room every member can read and write, like a Discord channel. **DMs** are the one conversation between two people; **group chats** hold 2–50. Everything arrives live: messages, "is typing…", who's online, read positions. The private messages of 0001 became DMs.

### How it works

- **D1 owns all the data**; a Durable Object per room (`Room`, `src/live/room.js`; `idFromName('ourspace')`, `idFromName('c:' + conversation id)`) only carries events to the sockets connected to it. It uses the WebSocket Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage` / `webSocketClose`), so a quiet room is evicted while its sockets stay open, and who each socket is (`{ id, name, avatar, blocks }`) rides on the socket (`serializeAttachment`). Pings are answered by `setWebSocketAutoResponse` without waking it. Costs: [decisions/004](decisions/004-cloudflare-limits-and-costs.md).
- **Sending is HTTP**: `POST …/messages` checks, writes D1 in one batch (the message, the conversation's time, the writer's read position, the interaction scores, #ourspace's mention notifications) and then asks the room to broadcast it (RPC `broadcast(event, skip)`, `skip` being everyone with a block with the writer either way). If the room can't be reached the message is still stored.
- **Receiving is a WebSocket**: `GET /api/live/:room` (`room` is `ourspace` or a chat id). Before the upgrade reaches the room, the Worker checks the session (401), the `Origin` header (must be the site's own, 403: the router's cross-site check skips GETs, and any site's page could open a socket with our cookie) and, for a chat, that the member has joined it (404). Anything else than an upgrade is 426. Opening sockets is rate limited (30 a minute and 600 a day per member, 429).
- **Sessions**: whatever ends a session closes its sockets in every room the member may have open (#ourspace and their conversations) with code `4001`, and the page stops: logging out (that session's), a password change (every other one), a password reset, a ban and deleting the account (all of them). As a backstop the room keeps the session (its token hash and expiry) with each socket: a socket past its session's expiry is closed whenever the room next carries an event, the session is checked against D1 before the room acts on a socket's frame (typing), and every socket's session at least once a minute while the room carries events. A banned member never shows in presence or `online`.
- **Floods**: a member has 5 sockets at most in one room (a sixth closes the oldest, code `4002`, and that page stops); a socket sending more than about a frame a second, sustained (a bucket of 10, refilled one a second; the auto-answered pings don't count), is closed with `1008`; typing goes out once every 2 seconds per person, however many sockets they have; and presence goes out to everyone at most once a second (a Durable Object alarm gathers the connects and disconnects of that second into one round), while a newcomer hears it at once.
- **Blocks**: between two members of a group, neither sees the other's messages (left out of every read, every unread count, every last-message preview and every broadcast), their typing, or them in the presence list. A DM with a block either way, or with someone banned, is hidden (404) and its sockets are closed when the block is made. A block made (or lifted) while they're connected reaches the rooms they share (#ourspace and their groups) at once: their sockets' block lists change and presence goes out again, so typing and presence follow it immediately; messages use the blocks at the moment they're sent.
- **Reconnecting**: a page that lost its socket asks for `?after=<the last id it has>` to catch up, and polls that every few seconds if the socket can't come back.

### The data

`migrations/0007_chat.sql`:

| Table / column | What |
|---|---|
| `conversations` | `(id, kind 'dm' \| 'group', title, created_by, created, last_message_at, dm_key)`. A DM's `dm_key` is `'<smaller user id>:<larger>'`, unique: one DM per pair. |
| `conversation_members` | `(conversation_id, user_id, role 'owner' \| 'member', status 'joined' \| 'invited' \| 'left', invited_by, joined, last_read_id, declined)`. `declined`: when they last said no to an invite to it (`invited_by` asked). A trigger caps a group at 50 non-left rows (joined and invited), so two adds at once can't both get in. Leaving, being removed or declining sets `left`; adding them back revives the row. |
| `chat_messages` | `(id, conversation_id, room, author_id, body (2,000), created, hidden, deleted)`: `room = 'ourspace'` with no conversation, or a conversation with no room. `hidden`: a moderator took it down (kept, shown to nobody). `deleted`: its writer deleted it (words cleared). The 0001 `messages` came across with their ids, writers, times and hidden marks, so reports of them point at the same ids; the id counter carries on from where `messages`' stood (not from the highest id that survived), so a report of a message that went before the move (its writer deleted their account) points at nothing rather than at somebody's new message; each member's `last_read_id` is just before the oldest message to them they hadn't read. |
| `chat_mutes` | `(user_id, until, muted_by, reason, created)`: no writing in #ourspace until `until`. |
| `affinity` | `(from_id, to_id, eff, updated)`: the interaction score of [decisions/001](decisions/001-ranking.md), `eff` as it stood at `updated`, halving every 30 days. Added to (decayed first) in the same batch as: a reply 3, a Friends' Comment 3, a board comment to its parent's writer 3, a mention 2, a quote 2, a DM 2, a like 1, a repost 1, a group message 0.5 to each other member (groups of 8 or fewer). Never toward yourself or across a block; a like or repost that didn't happen (already there, post gone) adds nothing. |
| `notifications.conversation_id`, `message_id` | For the kinds `group_invite` (shows while the invite is pending or accepted) and `chat_mention` (an `@mention` in #ourspace; shows while the message is there). |

### The rules

- **DMs** follow the old inbox: no messages across a block either way, and someone with `dm_policy: friends` only takes them from friends (both follow each other). Starting a DM makes (or reuses) the pair's conversation; it shows on the other person's list once somebody writes in it. A DM can't be left.
- **Groups**: 2–50 people with the owner. Friends join at once; anyone else is invited (their `dm_policy` and blocks apply, as for a DM), gets a `group_invite` notification (one per person and group: a new invite replaces the old one), and sees only the title, who invited them and how many are in it until they accept. The owner renames, adds and removes; anyone leaves; when the owner leaves (or deletes their account) the member who joined first becomes the owner. Someone who declines an invite can't be invited to that group again for 30 days, nor into any group by the person who asked for 7 days (403); friends, who join without an invite, aren't held back. Members added later (or accepting) start with everything so far read, and see the history.
- **#ourspace**: members only (logged out: 401). The newest 500 messages of the last 24 hours show; the cron deletes the rest except reported ones. Slow mode: one message every 3 seconds and 20 a minute. Links are removed as in posts; `@mentions` notify (`chat_mention`). Moderators delete any message and mute members for 1 hour, 24 hours or 7 days.
- **Unread**: per membership, `last_read_id`. Writing marks your own message read; `PUT /api/chats/:id/read` moves it forward (never past the newest). `GET /api/me` `counts.unread` is the number of conversations with unread messages (up to 99); invites don't count.
- **Reports**: a chat message is reported (`type: 'message'`) by someone who can read it and didn't write it; the snapshot keeps its words (`{ author, body, created, chatId, room }`). Hiding it from the Moderation tab takes it off every screen.
- **Deleting an account** deletes its DMs whole, hands its groups on, and takes its messages, memberships, scores and mutes.
- **Rate limits**: messages 15 a minute and 400 a day (DMs and groups together, as the inbox had); new DMs 30 an hour; new groups 10 a day; invites to non-friends 30 an hour; read positions 120 a minute; live sockets 30 a minute and 600 a day; #ourspace as above.

### The answers

- **A chat**: `{ id, kind: 'dm' | 'group', title, status: 'joined' | 'invited', role: 'owner' | 'member', created, memberCount (joined, me included), owner: ref | null (groups), members: [ref] (joined, not me, nobody with a block), invited: [ref] (groups), lastMessage: { id, body (cut at 140), author, created } | null, unread (up to 99), invitedBy: ref | null }`. An invite has `members: []`, `invited: []`, `lastMessage: null`, `unread: 0`, `owner: null`. A `ref` is `{ id, name, avatar }`.
- **A message**: `{ id, chatId (null in #ourspace), room ('ourspace' or null), body, created, author: ref, mine }` (`mine` only in HTTP answers, not in live events).

### The routes

| Route | Access | Answer |
|---|---|---|
| `GET /api/chats` | member | `{ items: [chat] }`: my DMs and groups, newest activity first, and the invites waiting (200 at most). |
| `POST /api/chats` | member | `{ dm: name }` → the pair's DM (`201` made, `200` already there) or `{ members: [names], title? (60) }` → a group (`201`), `{ chat }`. 404 for someone missing, banned or who blocked you; 403 if you blocked them or they only take messages from friends; 400 with nobody else or over 50; 429 over the limits. |
| `GET /api/chats/suggestions?q=` | member | `{ people: [{ id, name, avatar, friend, online }] }`: friends by closeness, then whoever I talked to last, then name; then non-friends I've interacted with (closeness above 0, taking messages from everyone); never anyone banned or with a block; 30 at most; `q` keeps names containing it. |
| `GET /api/chats/:id` | member | `{ chat }` (an invite too). 404 when I'm not in it. |
| `PUT /api/chats/:id` | owner | `{ title }` → `{ chat }` (empty: no title). |
| `GET /api/chats/:id/messages?before=&after=` | member | `{ chat, messages, next, reads: [{ user, id }], canMessage, reason }`: 50 a page, oldest first; `before=<id>` pages back (`next` is the next `before`); `after=<id>` catches up, 100 at most (`next` is the next `after`). `reads`: how far the other members have read. 403 while it's an invite. |
| `POST /api/chats/:id/messages` | member | `{ body (2,000) }` → 201 `{ message }`. 403 in a DM that's no longer allowed. |
| `PUT /api/chats/:id/read` | member | `{ id }` → `{ ok, lastReadId }`. |
| `POST /api/chats/:id/members` | owner | `{ names: [] }` → `{ chat }`. 400 when they're all in already, 409 past 50. |
| `DELETE /api/chats/:id/members/:name` | owner | → `{ chat }`; their socket closes (code 4003). |
| `POST /api/chats/:id/leave` | member | → `{ ok }` (groups only). |
| `POST /api/chats/:id/invite` | invitee | `{ action: 'accept' \| 'decline' }` → `{ chat }` / `{ ok }`. 409 if already answered. |
| `DELETE /api/chat-messages/:id` | member | Your own (words cleared) or, for a moderator, anybody's (taken down, logged) → `{ ok }`. |
| `GET /api/ourspace/messages?before=&after=` | member | `{ messages, next, online: [ref], mutedUntil, slowMode: { seconds: 3, perMinute: 20 } }`. |
| `POST /api/ourspace/messages` | member | `{ body (2,000) }` → 201 `{ message }`. 403 while muted, 429 in slow mode. |
| `POST /api/admin/mutes` | moderator | `{ name, hours: 1 \| 24 \| 168 \| 0, reason }` → `{ ok, until }` (0 lifts it). |
| `GET /api/live/:room` | member | The WebSocket (101), or 401 / 403 (Origin) / 404 (not a member) / 426 (not an upgrade). |
| `GET /api/notifications` | member | `group_invite` items carry `chat: { id, title }`; `chat_mention` items `message: { id, body (cut at 140), created, room }`. Both have `post: null`. |

The old `/api/inbox` routes are gone.

### The live events

Every frame is JSON text. Server → client:

| Event | When |
|---|---|
| `{ type: 'message', message }` | a new message (the message shape without `mine`) |
| `{ type: 'deleted', id }` | deleted by its writer, or taken down by a moderator |
| `{ type: 'typing', user }` | someone typing (at most every 2 seconds per person) |
| `{ type: 'presence', online: [ref] }` | who has the room open, each once: to a newcomer at once, and to everyone within a second of any connect, disconnect or block |
| `{ type: 'read', user, id }` | a member of a group or DM read up to `id` |
| `{ type: 'changed' }` | the chat's title or members changed (fetch `GET /api/chats/:id`) |
| `{ type: 'pong' }` | the answer to a ping |

Client → server: `{"type":"typing"}` and `{"type":"ping"}` (exactly that text, answered without waking the room). Anything else is ignored (but counts toward the flood limit).

Close codes: `4001` signed out, `4002` open in too many places (5 per member per room), `4003` not a member any more (left, removed, or a block closed the DM): the page stops for good on these (`public/js/core/live.js`) and says why, as it does when the history answers 401 (signed out) or 403/404 (not in the chat). After `1008` (too many frames) or anything else it reconnects with backoff, polling the history meanwhile (once a minute while the tab is hidden).

## Browse: For you, Mutuals, Boards for you, Who to follow

Phase 6. A very small, explainable algorithm ([decisions/001](decisions/001-ranking.md)): no scroll, dwell, watch-time or impression signals are recorded anywhere, and every suggestion carries the reason it's shown. The Following feed stays newest first. People search stays `GET /api/users`.

### The data

`migrations/0008_browse.sql`:

| Table / index | What |
|---|---|
| `board_terms` | `(term, board_id, weight)`, `WITHOUT ROWID`: the curated interests → boards crosswalk. `term` is one to three words, stored cleaned (lower case, no accents or punctuation); both sides are folded the same way when compared (a leading "the" and a trailing "s" on words over 3 letters go). Each board's name and its words count too, without being stored. Seeded for the 14 launch boards (about 240 terms); moderators add and remove terms per board, so boards made from requests can get theirs. |
| `browse_hidden` | `(user_id, kind, ref_id, created)`: "not interested". `kind` is `person` (out of Mutuals and Who to follow, their posts out of discovery), `board` (out of Boards for you, its threads out of discovery) or `post`. The only thing Browse ever writes, and only when the member asks. |
| `posts_author_board` | `(author_id, board_id, created) WHERE board_id IS NOT NULL`: "boards you post in" is one short seek per board. |
| `posts_discover` | `(author_id % 8, created, author_id, kind) WHERE kind IN ('status', 'blog', 'quote', 'thread')`: For you's candidates, each bucket of writers newest first, read off the index alone (it covers the query). |
| `follows_recent` | `(follower_id, status, accepted, followee_id)`: a member's newest follows, off the index alone (Mutuals, your friends, the follows whose replies count). |

### The rules

- **Who shows.** Discovery shows only posts the viewer may see (`VISIBLE`: not hidden, deleted, dated ahead, by someone banned or with a block either way) and only by **open** profiles: a private member's posts, and their board threads too, are never in discovery. No post with a photo a moderator holds (`media.hidden`), no thread on an archived board or at net -3 or lower. People suggestions skip yourself, anyone banned, anyone with a block either way, anyone you follow or asked to follow, and anyone you hid. A private profile can be suggested as a person (it's in search too), but as its name and picture only.
- **Ages.** Browse never puts an adult and a 13–17-year-old in front of each other, by the birthday each side gave: not in Mutuals or Who to follow (001, open question 3, "the default here: no"), and not in For you either (the owner's decision in phase 6): an adult's For you shows adults' posts only, a teen's only teens'. Logged out, Browse suggests adults only (For you and Who to follow). The line is `ageCut` in `src/shared/dates.js`, the same rule as `ageOn` (someone born 2010-03-01 is 17 on 2028-02-29). Boards, tag pages, profiles and the Everyone feed aren't split by age: Browse only stops suggesting strangers across the line.
- **For you** (`discover`). Candidates, each set cut to size before anything is filtered: the writers fall in 8 buckets by id, and each bucket's newest 64 statuses, blog posts, quotes and board threads of the last 7 days are read straight off the `posts_discover` index (512 at most); of those, each writer's newest 3, then the newest 150; only those are read and checked (logged in: not by people you follow, not yourself, not on a board you posted in within 30 days, nothing you hid). So one account posting all day takes 3 places among the candidates (and 2 on a page), and its flood only crowds the writers of its own bucket. Plus the posts that people you follow replied to or commented on this week: your newest 40 follows, each one's newest 2 replies and 2 comments, and of what they answered at most 40 posts that aren't candidates already. Score = hot (a thread's stored `hot`; for the others the same formula with likes + reposts as votes and replies up to 5) + 0.2 per person you follow who replied or commented (up to 3) + 0.3 when friends of yours follow the writer + 0.3 for a thread on a board your interests point to. Then, per page of 20, at most 2 per writer and 4 per board: what a cap holds back rides in the cursor and leads the next page. Reasons, first match wins: `Replied to by kat, who you follow` / `kat and 2 others you follow commented`; `Your friend kat follows zed` / `kat and 2 other friends follow zed`; `Because you listed "kittens" under General`; `Popular in Cooking` / `Popular on OurSpace this week`. Logged out: everybody's open posts, by hot, "popular". **No like-based reason**: who liked what isn't shown anywhere in the app, so "Liked by kat" (001's first reason) would give it away; replies and comments are public already.
- **Mutuals.** Friends of your friends (friend = both follow each other), in one query: your friends among your newest 100 follows (the newest 25 friendships), each one's newest 20 follows (off the `follows_recent` index, never their whole list) that follow them back, at most 250 pairs. Order: mutual friends, then "follows you", then Adamic–Adar (Σ 1 / ln(2 + d) over the mutual friends, d = their friend count among their newest 20 follows, you included when you're among them), then active in the last 30 days, then the older account. Each with the count and up to 3 mutual friends by name, closest to you first (the interaction score), then A to Z.
- **Who to follow.** The top mutuals; when there are fewer than asked for, recently active (30 days) open profiles with the most followers (counted up to 25 each, among the first 20 who could be suggested of the 60 members seen most recently). Logged out: adults only.
- **Boards for you.** Your six interest fields, cut on commas, semicolons, slashes, new lines, "&", "+" and " and " (40 phrases, 60 characters each); every 1–3 word run looked up in the terms; a board scores Σ over distinct matched terms of (1.5 if the field is the board's subject: Music → Music, Movies and Television → Movies & TV, Books → Books & Writing; else 1) × the term's weight × ln(1 + N / df) (N boards, df boards holding the term), and needs 1.0. Never a board you've posted in, one you hid, or an archived one. Then the ladder: boards busy this week (most people posting, among each board's newest 20 posts of the week), then the rest of the index. Logged out: the ladder alone. The terms are read once per isolate and kept 5 minutes.
- **Paging.** Every cursor is a place in the order, never a position: a post written in between takes its own place in the order and never makes a later page of For you repeat or skip anything (one that scores above where you are waits for a refresh), and people followed in between never shift Mutuals. Each page recomputes the candidates (nothing is cached per member).
- **Rate limits.** For you, Mutuals and Who to follow recompute everything on each request: 60 a minute and 600 an hour each, per member (logged out, per connection). "Not interested": 300 a day, counted before anything is looked up.
- **Never cached.** Every Browse answer depends on who asks, so all of them are `Cache-Control: no-store` (as every personalized API answer is: `json()`'s default), never `private, max-age`: a browser shared by two accounts would otherwise show the first one's suggestions to the second.

### The answers

- **A discovery item**: `{ item, reason: 'replied' | 'friends' | 'interest' | 'popular', why, relation }`. `item` is the item every list shows ([above](#the-item)); a thread carries `board: { slug, name, icon, archived }` for "View board". `relation` is to the item's writer, in the profile's shape (`{ following: 'none', followsMe, friends: false, blockedByMe: false, canComment: false, canMessage }`), for the follow button; null when logged out.
- **A suggested person**: `{ user: { id, name, avatar }, private, relation, mutual: { count, people: [{ id, name, avatar }] (up to 3) } | null, because: 'mutual' | 'popular', why }`, plus `followers` (up to 25: `Followed by 25+ people`) on a popular one. `why`: `Friends with kat, pete and 2 others` (` · follows you` when they do), `Followed by 12 people`, `Active on OurSpace lately`.
- **A suggested board**: `{ board: { slug, name, description, icon }, because: 'interests' | 'busy' | 'all', terms: [{ term, field }] (interests only), posters (this week), why }`. `why`: `Because you listed "my chemical romance" under Music`, `5 members posted in Music this week`, `Quiet this week: start something`.

### The routes

| Route | Access | Answer |
|---|---|---|
| `GET /api/browse/discover?before=` | anyone | `{ items: [discovery item], next }`, 20 a page. `next` is the cursor for `before=` (`<score>:<id>:<held-back ids>`); a cursor that can't be read is 400. |
| `GET /api/browse/mutuals?before=` | anyone | `{ people: [suggested person], next }`, 20 a page. Logged out: `{ people: [], next: null, prompt }`. |
| `GET /api/browse/people?limit=3` | anyone | `{ people: [suggested person] }`, 1–10. `Cache-Control: no-store`, like every Browse answer. |
| `GET /api/browse/boards?limit=5` | anyone | `{ boards: [suggested board], hasInterests }`, 1–10. |
| `POST` · `DELETE /api/browse/hidden/:kind/:ref` | member | "Not interested", and undoing it: `kind` person (`:ref` their id), board (its slug) or post (its id). → `{ hidden: { kind, id } }` · `{ hidden: null }`. 404 for yourself or a person or board that isn't there; a post id isn't looked up (any id is 200), so the answer never tells whether a private or hidden post exists. |
| `GET /api/admin/boards/:slug/terms` | moderator | `{ board, terms: [{ term, weight }] }` |
| `PUT /api/admin/boards/:slug/terms` | moderator | `{ add?: [term \| { term, weight }], remove?: [term] }` (100 each; a term is 1–3 words, 60 characters; weight 0.1–5, default 1) → as GET. Logged (`board_terms`). Other isolates see it within 5 minutes. |

### The row budget

D1 bills rows read, not returned ([decisions/004](decisions/004-cloudflare-limits-and-costs.md)). Besides the session lookup every route does, each answer reads at most:

Every read is cut to a fixed size **before** it is filtered (a `LIMIT` on an index range, per bucket, per friend or per board), so no member's data can make a request read more: a friend following 10,000 people, 10,000 replies by someone you follow, 10,000 private posts or 300 statuses a day by one account all leave the bound where it is.

| Route | Bound | Measured: the demo (the_reviewer · logged out) | Measured: the demo flooded (the_reviewer · logged out) |
|---|---|---|---|
| `discover` | ≤ 512 `posts_discover` index rows (8 buckets × 64; the cap per writer and the newest 150 are picked in the Worker, since a window function and sorts in SQL would read them over again); then those 150, and ≤ 40 posts people you follow answered, read and checked by id (a few seeks each); + your newest 40 follows × 4 replies and comments (≤ 400 rows); + your friends (≤ 300) × point lookups for the candidates' writers; + one hydrate batch for 20 items; + the terms (≈ 240 rows, once per isolate per 5 minutes) | 400 (page 2: 308) · 260 (page 2: 157) | 466 (page 2: 374) · 323 (page 2: 220) |
| `mutuals` | your newest 100 follows (+ 2 seeks each) → 25 friends × their newest 20 follows (+ a seek each) → ≤ 250 pairs → ≤ 250 candidates × a few seeks + the names (≤ 25) | 220 · 0 | 383 · 0 |
| `people` | the same as mutuals, + (when it falls back) the 60 most recently seen members, the first 20 suggestable × their followers (≤ 25 each) | 220 · 84 | 378 · 107 |
| `boards` | the boards + each board's newest 20 posts of the week (+ the post and its writer) + one seek per board for "you posted here" + the terms (≈ 240 rows, once per isolate per 5 minutes) | 204 · 188 | 204 · 188 |
| rate limit | For you, Mutuals and Who to follow count their `attempts` first (≤ 660 rows, outside `X-Rows-Read`) | | |

"Flooded": the demo plus 10,000 replies this week by somebody the_reviewer follows, 10,000 statuses by a private profile, 10,000 people a friend of theirs follows one way who then all follow back, and 300 statuses in a day by one account. The tests read every answer's `X-Rows-Read` (set when the Worker runs with `SHOW_ROWS_READ=1`, as the tests and the demo do; `meter()` in `src/shared/db.js`) and hold every route to 2,000 rows, before and after the same floods (`test/api.test.mjs`, "the row budget under floods"). The price of the caps: Mutuals sees 25 friends' newest 20 follows each, so on a big site a friend of a friend you share through an older friendship can be missed; 001's 6-hour per-member cache isn't built (see the roadmap).

## Front end

`public/index.html` loads `public/app.js` as an ES module. There is no build step: the files in `public/` are what the browser gets.

```
public/
  app.js                entry: the ROUTES table (address pattern → page) and boot
  js/core/              basics every page uses
    dom.js              h() builds elements, with text going in through textContent; $, enc, userPath, poss
    api.js              the JSON API (/api/*); a failed call throws with the server's message and .status
    format.js           dates and times, printed the 2006 way
    ui.js               toasts, the Win98 message box, page titles, error cards, "show more" paging, profile skins
    state.js            who's logged in and what the server told us (S, loadMe)
    router.js           the page router, the link interceptor, and STATIC_PREFIXES
    chrome.js           the header (who's logged in) and the tabs with their badges (Notifications, Messages)
    live.js             a live room: one WebSocket to /api/live/:room with reconnect (1 s doubling to 30 s), a ping every 25 s, `sync()` after every reconnect and a poll of the history every 4 s once it has failed three times in a row; closed on route leave; `dropSockets()` knocks every open one over for trying it out
  js/widgets/           code two or more pages share, or a piece of one page big enough for its own file
    people.js           a person's picture, name link and Browse card
    safety.js           report and block, under posts, on pages and in messages
    songs.js            someone's Spotify top songs, with 30-second previews
    auth-forms.js       what join, finish-sign-up and log-in share, the picture gallery, the sign-in error texts
    followbutton.js     the Follow button (Follow / Requested / Following / Friends)
    discovery.js        a card in Browse > For you: the post or thread with a line saying why it is shown, Follow, View board and ✕
    suggestions.js      suggested people (Mutuals rows with the friends in common; the Feed sidebar's "Who to follow") and suggested boards (Boards for you rows, the matched words marked)
    hide.js             the ✕ "not interested" button: hides the card, with a click-to-undo toast (POST / DELETE /api/browse/hidden)
    privatecard.js      what shows instead of a private page's posts
    composer.js         the "What's on your mind?" status box with its live counter and 📷 button (up to 4 photos); with a URL it is the reply box
    photos.js           putting photos on a post: prepareImage (the browser half of the pipeline: shrink to 1600 px, JPEG / WebP / PNG, a small GIF as it is, a 300 px square for a picture) and photoPicker (the 📷 button, thumbnails with description, ✕ and progress, the ids for the create call; previews are data: URLs)
    photoqueue.js       the Photos section of the Moderation page: thumbnails newest first (unreviewed by default), uploader and account age, where each is, Mark reviewed / Hide / Remove, "show older photos"
    photogrid.js        a post's photos as a 1–4 grid with the room reserved from width and height, lazy loading; a blog cover is the same as a wide single photo
    photoviewer.js      the Win98 picture viewer: ◀ ▶ / arrow keys / swipe between a post's photos, Esc, the description underneath
    postcard.js         one post as a card (status, blog, reply, quote, repost, tombstone), in the feed, the profile tabs, a conversation, a tag page and Bookmarks
    reactions.js        the 💬 ↻ ♥ 🔖 row under a post: likes, reposts and bookmarks flip at once and roll back on an error; the ↻ menu
    postdialog.js       the Reply and Quote windows (500 characters, up to 4 photos, the post being answered or quoted shown with it)
    quotebox.js         a post inside a box (under a quote, in the Reply and Quote windows) with its photos small, or "this post is unavailable"
    replies.js          the reply box and the replies under a post (flat cards, paged), under a conversation's post and a blog post's Discussion
    richtext.js         a body's @mentions (the ones the server resolved) and #tags as links, by the server's own patterns (no #tag links in Friends' Comments)
    postlinks.js        where a post lives: a blog post's page, or a conversation (/u/name/post/123)
    blogtext.js         a blog post's body (plain text plus a few marks, links inside them) and the teaser for the feed and index
    blogindex.js        the Blog tab: the write form (with a cover photo) and the index of posts (with covers)
    readmarker.js       "pick up where I left off": which cards you've seen and how far you've read
    votes.js            ▲n ▼n under a thread or comment: both counts, your vote pressed; changes at once and puts only the vote back if refused
    comments.js         a thread's nested comments: 14px indent under a rail, [−] / [+n] fold, depth cap 6 (3 on a phone) then "Continue this thread →", "Load more replies (n)", [deleted] tombstones
    commentbox.js       the comment box (a Win98 window at the top of a thread, a small reply box under a comment), 10,000 characters and one photo
    threaddialog.js     the New Thread window (title 120, words 10,000, up to 4 photos)
    boardlinks.js       where boards and threads live: /boards/cooking, /boards/cooking/42
    boardrequests.js    the board requests on the Moderation page: approve (address, icon, description) or decline
    chatparts.js        what the Messages list, the chat window and the profile share: a chat's name and picture, the unread badge, `openDm(name)` (Send Message: POST /api/chats {dm}, then open it)
    peoplepicker.js     the search box over /api/chats/suggestions (friends first, then "people you talk to", who get an invite), chips, "add by name"
    newgroup.js         the New group window (name, picker); resolves the new chat
    groupsettings.js    a group's settings under the chat window's title bar: rename, members (the owner removes), invited, Add people, Leave
  js/pages/             one module per screen
    home.js             Home: a welcome and the latest from everyone, or the Feed (sidebar: Who to follow, horoscope, who is online)
    profile.js          someone's page, with the Posts, Replies, Blog and Friends' Comments tabs
    blog.js             one blog post on its own page, with its Discussion
    post.js             a conversation: the posts above, the post enlarged, the reply box, the replies
    notifications.js    the Notifications tab: follow requests waiting (Accept / Decline) and what happened, grouped, with unread ones highlighted (a group invite answers in place; a #ourspace mention leads to the room)
    bookmarks.js        your bookmarks
    tags.js             a #tag's page
    lists.js            who follows someone, who they follow, and their friends
    browse.js           Browse, four tabs (?tab=): For you (discovery stream), Mutuals, Boards for you, Search people (the old people grid; ?q= from the header search lands here)
    requests.js         follow requests, in and out (also reached from Notifications)
    messages.js         the Messages tab: DMs and groups (unread in bold, invites with Accept / Decline at the top), search, New group; looks again every 10 s; also the old /inbox addresses (redirect, /inbox/name opens the DM)
    chat.js             one conversation (/messages/:id) in an AIM / MSN window, live: day separators, buddy pictures, "kat is typing…", who has it open, read ticks, delete / report, load earlier, mark read while visible, group settings, the reason instead of the box when you can't write; an unanswered invite shows Accept / Decline instead
    ourspace.js         #ourspace (/ourspace), mIRC-style and live: [time] <nick> words, @mentions linked, a nick list from presence, join / quit lines, the slow-mode countdown on Send, the muted notice, [del] / [mute] for moderators; logged out: a login prompt
    boards.js           the boards: the index (a phpBB-style table, "request a board") and one board's thread list (Hot / New / Top / Best, paged)
    thread.js           a thread: the post, ▲n ▼n, the comment box and the nested comments (?c= opens one comment's replies), Pin and Lock for moderators
    horoscope.js        the daily horoscope, your birth chart and today's sky
    auth.js             sign up, finish a provider sign-up, log in, forgot / reset password
    edit.js             Edit My Page (with "Upload my own picture": cropped to a 300 px square before it goes up)
    settings.js         Settings
    admin.js            Moderation (moderators only): board requests, reports (CSAM ones first, with the 48-hour clock, and the reported post's photos: Remove photo, Hide photo), the Photos review queue, the log
    rules.js            House Rules & Privacy
  app.css  _headers  assets/  blog/
```

- A page module exports `renderX(root, arg)`: it fills `root`, and `arg` is the captured piece of the address (a screen name, a sign). It is registered in the `ROUTES` table in `app.js`.
- Code that two or more pages use, or a self-contained piece of one page big enough for its own file, lives in `js/widgets/` (pages stay thin). `js/core/` imports nothing above it: no widgets, no pages, no entry.
- The router leaves some addresses to the server, so links into them are real page loads instead of in-app navigation. They are listed in `STATIC_PREFIXES` in `js/core/router.js` (the blog, the assets, the API). A new static folder under `public/` has to be added there.
- User text only ever reaches the page through `textContent`, never as HTML.

## Horoscopes: how they work

- **Star signs** come from the birthday: the sign the Sun was in on that day. If the Sun changed sign that day (a cusp birthday), their personal reading mentions the other sign too.
- **Today's sky** (`/horoscope`, for everybody) is computed for the reader's own local day. It covers where the Sun, Moon and planets are (tropical zodiac), the Moon's phase and any New or Full Moon, which planets are retrograde and when they turn direct, planets changing sign or stationing today, and the major aspects between them. All of it is computed with [`astronomy-engine`](https://github.com/cosinekitty/astronomy), not looked up from a list. `test/astro.test.mjs` checks it against known dates, for example the Sun entering Scorpio on 23 October 2026 and Mercury turning retrograde on the 24th.
- **Each sign's horoscope** (`/horoscope/<sign>`) reads that same sky through "solar houses": whole signs counted from the person's Sun sign, the method newspaper horoscopes use. The same sky therefore reads differently for every sign. It covers what the Moon is lighting up today, the month's theme from the Sun, the Moon phase, retrogrades, a lucky number and color, a mood, and a do and a don't.
- **The personal reading** (logged in) adds the person's birth chart: where the Sun, Moon, Mercury, Venus, Mars and the rest were on their birthday (at noon, since we don't ask for a birth time). Today's planets are then compared against those positions ("transits"). On their birthday it says so.
- A reading is seeded by the date and sign (and person), so it stays the same all day and changes the next. It's for fun, and the horoscope page says so.
