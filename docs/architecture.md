# Architecture

## How it works

```
one Cloudflare Worker "ourspace-social" (same origin for pages and API, so the login cookie is HttpOnly + SameSite=Lax)
 ├── public/      the pages: index.html + app.js (single-page app, ES modules), app.css, blog/, assets/   (Workers static assets)
 ├── /api/*       src/index.js → accounts, profiles, follows, social, notifications, messages, safety, music, horoscope
 ├── D1 "ourspace-social-db"   migrations/ (users, profiles, sessions, identities, oauth_states, oauth_signups,
 │                             password_resets, spotify, follows, posts, likes, bookmarks, mentions, post_tags,
 │                             notifications, markers, messages, blocks, reports, mod_log, attempts)
 └── cron */30    housekeeping: expired sessions, sign-in tickets, reset links, old rate-limit rows
```

`wrangler.jsonc` sends only `/api/*` to the Worker first. Every other path is served from `public/`, and a path that isn't a file gets `index.html`, so `/u/<name>`, `/inbox`, `/edit` and the rest are drawn by the page's own router.

## File map

```
src/
  index.js     Worker entry
  shared/      infrastructure; never imports a feature
  catalog/     the choices people have when decorating a page
  accounts/  profiles/  follows/  social/  notifications/  messages/  safety/  music/  horoscope/     features
```

| Path | What |
|---|---|
| `src/index.js` | The route table (one list at the top), the cross-site check on writes, the cron. |
| `src/shared/http.js` | JSON answers, `fail(status, message)` errors, reading JSON bodies, cookies, SHA-256. |
| `src/shared/db.js` | User lookups, the shape a user takes in every answer, follows (who are friends, who may see a private profile's posts, how two people are connected, the SQL for the followers / following / friends lists), blocks, which posts the viewer may see (`VISIBLE`, `SEES`, `REPOST_OK`), a post in brief (`lite`), and `limit()`, the rate limiter. |
| `src/shared/notify.js` | Notifications: `notify()`, the statement each feature adds to its write batch (never to yourself, across a block, or about a post the person can't see), and `SHOWN`, which ones still show. |
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
| `src/social/social.js` | Statuses, blog posts, Friends' Comments, bulletins, deleting posts (tombstones), conversations, the Posts and Replies tabs, `#tag` pages, the feed and the read markers. |
| `src/social/interactions.js` | Replies, quotes, likes, reposts, bookmarks and the bookmarks list. |
| `src/social/items.js` | The item every list shows, with what a whole page of them needs fetched in one batch, and writing a new post with its mentions, tags, counts and notifications in one batch. |
| `src/notifications/notifications.js` | The Notifications tab. |
| `src/messages/messages.js` | Private messages. |
| `src/safety/safety.js` | Blocks, reports (with a snapshot of the reported text), the moderation actions and log. |
| `src/music/spotify.js` | Each person's Spotify: tokens (stored encrypted), their top songs (cached for 6 hours), and previews from iTunes when Spotify has none. |
| `src/horoscope/horoscope.js` | The words: today's sky, each sign's horoscope, personal readings. |
| `public/_headers` | Content-Security-Policy and other security headers for the pages. |
| `public/blog/` | malten's essays and their index: static pages, maintained by hand. |
| `public/assets/` | Every image the pages and `src/catalog/` use. Credits are in [CREDITS.md](../public/assets/CREDITS.md), served at `/assets/CREDITS.md`. |
| `migrations/` | D1 schema, one numbered file per change. |
| `tools/demo.mjs` | `npm run demo`: the site on your computer with sample content and pretend sign-in pages. |
| `test/` | `api.test.mjs` (end-to-end, against a throwaway local Worker), `migrations.test.mjs` (a migration applied to a database the earlier ones left), `astro.test.mjs` (the astronomy against known dates), `text.test.mjs` (the `@mention` and `#tag` readers), `frontend.test.mjs` (page code from `public/js` on a pretend browser, `helpers/fake-dom.mjs`, with the API answered by the test), `static.test.mjs` (assets and imports), `helpers/mock-providers.mjs` (a stand-in for every sign-in provider, Spotify and iTunes, used by the tests and the demo). |

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

## Following, friends and the feed

### The data

`migrations/0002_follows.sql` replaced the friend requests of `0001` (friends became two follows, a waiting request became the asker's follow).

| Table / column | What |
|---|---|
| `follows` | One row per follow: `follower_id` follows `followee_id`, `status` `accepted` or `pending`, `created`, `accepted` (when). **Friends** are two people who follow each other, both accepted; friendship isn't stored anywhere else. |
| `users.follow_policy` | `open` (the default: a follow is accepted at once) or `approve` (a private profile: follows wait as requests). |
| `users.dm_policy` | `everyone` or `friends` (in the sense above). |
| `posts` | `kind` is `status` (up to 500 characters), `blog` (title in `subject`, an optional `subtitle`, `mood`, a body up to 20,000), `wall` (a Friends' Comment on `target_id`'s page) or `bulletin`; since `0003` also `reply`, `quote` and `repost` (see [the next section](#replies-likes-reposts-quotes-bookmarks-mentions-tags-and-notifications)). |
| `markers` | Read positions, like Mastodon's markers: `(user_id, name)` → `last_created` / `last_id` of the last thing seen. `name` is `feed` (the last post) or `notifications` (the newest notification). |

### Who sees what

- Everyone sees a profile page itself: name, picture, details, counts, Top 8, Spotify. A private profile's statuses, blog, Friends' Comments and its followers / following / friends lists are for its accepted followers, the owner and moderators only (`canSeePosts` in `src/shared/db.js`); anyone else gets `403 this profile is private.` (a single post, `GET /api/posts/:id`, answers `404 that post is gone.` instead, exactly like a post that doesn't exist, so the answer doesn't say a private post is there). Going private keeps the followers someone already has. Going open accepts everyone who was waiting.
- Friends' Comments are written by the owner and their friends only, and never appear in a feed. The owner can delete any comment on their page. The Top 8 holds friends only (the server drops anyone else when it's saved). It is the friends the owner chose, then their newest friends up to 8; somebody who can't see a private profile's posts gets only the chosen ones, so the fill doesn't give the friend list away.
- Blocking deletes the follows between the two people, both ways, and they can't follow each other while it lasts.

### The feed

`GET /api/feed` has statuses, blog posts, quotes and reposts, never replies, comments or bulletins. A repost of a post the viewer may not see (its author went private, blocked them, was banned) is left out.

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

Statuses and blog posts get Twitter's interactions (bulletin-board threads are a later phase). Friends' Comments only get `@mentions`; bulletins get nothing new.

### The data

`migrations/0003_interactions.sql`:

| Table / column | What |
|---|---|
| `posts.kind` | adds `reply` (up to 500 characters, answering `reply_to`), `quote` (up to 500, about `quote_of`) and `repost` (no words, just `quote_of`; one per person per post, a partial unique index). |
| `posts.reply_to`, `root_id`, `quote_of` | The post a reply answers, its conversation's first post (NULL on that post itself and on anything that isn't a reply), the post a quote or repost points at. `quote_of` is `ON DELETE SET NULL`; `reply_to` and `root_id` are plain ids, not foreign keys, so when a post goes with its writer's account the replies to it keep pointing at it: they stay in their conversation and say they answer a deleted account. |
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
  deleted: bool }                     a tombstone: no words, canDelete false, quoted null
```

- A **quote**'s `quoted` is the original in brief: `{ id, kind, created, subject, subtitle, body (cut at 280 characters, with …), author, deleted }` (`deleted: true` and no words for a tombstone: "this post was deleted"), or `{ unavailable: true }` when it's gone, hidden, or not visible to the viewer. Notifications carry their post in the same shape.
- A **repost**'s `author` is the person who reposted it and its `body` is empty; `quoted` is the original as a whole item (with its own counts, flags, mentions, tags and, for a quote, its own `quoted`). The repost's `counts` and `viewer` are the original's, since acting on a repost acts on the original. Lists leave out reposts of posts the viewer can't see.
- Blog bodies in lists over 400 characters arrive cut short, with `excerpt: true`.
- What a page of items needs beyond their own columns (originals, flags, mentions, tags) is fetched for the whole page in one batch (`hydrate()` in `src/social/items.js`).

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
    chrome.js           the header (who's logged in) and the tabs with their badges (Notifications, Inbox)
  js/widgets/           code two or more pages share, or a piece of one page big enough for its own file
    people.js           a person's picture, name link and Browse card
    safety.js           report and block, under posts, on pages and in messages
    songs.js            someone's Spotify top songs, with 30-second previews
    auth-forms.js       what join, finish-sign-up and log-in share, the picture gallery, the sign-in error texts
    followbutton.js     the Follow button (Follow / Requested / Following / Friends)
    privatecard.js      what shows instead of a private page's posts
    composer.js         the "What's on your mind?" status box with its live counter; with a URL it is the reply box
    postcard.js         one post as a card (status, blog, reply, quote, repost, tombstone), in the feed, the profile tabs, a conversation, a tag page and Bookmarks
    reactions.js        the 💬 ↻ ♥ 🔖 row under a post: likes, reposts and bookmarks flip at once and roll back on an error; the ↻ menu
    postdialog.js       the Reply and Quote windows (500 characters, the post being answered or quoted shown with it)
    quotebox.js         a post inside a box (under a quote, in the Reply and Quote windows), or "this post is unavailable"
    replies.js          the reply box and the replies under a post (flat cards, paged), under a conversation's post and a blog post's Discussion
    richtext.js         a body's @mentions (the ones the server resolved) and #tags as links, by the server's own patterns (no #tag links in Friends' Comments)
    postlinks.js        where a post lives: a blog post's page, or a conversation (/u/name/post/123)
    blogtext.js         a blog post's body (plain text plus a few marks, links inside them) and the teaser for the feed and index
    blogindex.js        the Blog tab: the write form and the index of posts
    readmarker.js       "pick up where I left off": which cards you've seen and how far you've read
  js/pages/             one module per screen
    home.js             Home: a welcome and the latest from everyone, or the Feed
    profile.js          someone's page, with the Posts, Replies, Blog and Friends' Comments tabs
    blog.js             one blog post on its own page, with its Discussion
    post.js             a conversation: the posts above, the post enlarged, the reply box, the replies
    notifications.js    the Notifications tab: follow requests waiting (Accept / Decline) and what happened, grouped, with unread ones highlighted
    bookmarks.js        your bookmarks
    tags.js             a #tag's page
    lists.js            who follows someone, who they follow, and their friends
    browse.js           find people
    requests.js         follow requests, in and out (also reached from Notifications)
    inbox.js            the Inbox and a conversation
    bulletins.js        the Bulletin Board
    horoscope.js        the daily horoscope, your birth chart and today's sky
    auth.js             sign up, finish a provider sign-up, log in, forgot / reset password
    edit.js             Edit My Page
    settings.js         Settings
    admin.js            Moderation (moderators only)
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
