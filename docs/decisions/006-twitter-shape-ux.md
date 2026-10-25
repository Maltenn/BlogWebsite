# 006 — Twitter shape, OurSpace look
Status: proposed (2026-10-25)

## Question
OurSpace is being reshaped like Twitter: one-way follows (mutual = friends), statuses, a Substack-style blog section, a separate Friends' Comments tab, a feed with a "pick up where I left off" mode, and later replies, boards and chat. How does that sit on the existing blue-header / Win98 / MySpace-1.0 skin, and what exactly is the reading marker?

## What we found
- **Our code today:**
  - `#page` is 980px with a sticky blue `.ms-header` + `.ms-tabs` (app.css:39-50, 107-135). Profile = `.ms-left` 230px + fluid `.ms-right`, stacked at ≤760px (182-184, 423).
  - Feed = `GET /api/feed?scope&before=<created:id>` over one `posts` table, newest first, `paged()` "show more" (social.js:147-176). `posts.id` is AUTOINCREMENT (0001_init.sql:112); `created` is `Date.now()` ms.
  - Reusable: article typography of the static blog (`.post` 640px, Georgia 16/1.75, app.css:408-413), `.os-tabs2` Win98 tabs, `.ms-comment` rows, `dialog()`.
- **X layout:** nav + primary column + sidebar. The primary column is 600px ([userscript note](https://greasyfork.org/vi/scripts/560904-twitter-x-layout-modifier/code)); the 2012 layout was 600px + sidebar max 340px ([archived CSS](https://cybercemetery.unt.edu/oilspill/20120916185736cs_/http://a0.twimg.com/a/1347580850/stylesheets/layout_newtwitter.css)). The ~275px/88px nav, ~350px sidebar and breakpoints are from memory, not verified (X pages were blocked).
- **X posts:** reposts and quote posts from people you follow appear in Home; a quote embeds the original, which doesn't count toward the limit ([How to Repost](https://help.x.com/en/using-x/how-to-repost), [Repost FAQs](https://help.x.com/en/using-x/repost-faqs)). Keyboard `.` loads new posts, `j`/`k` move between posts (search snippets of those help pages). The "Show N posts" pill and reply connector lines are from familiarity, unsourced.
- **Mastodon markers:**
  - `GET/POST /api/v1/markers`, timelines `home` and `notifications` only. `last_read_id` is "the ID of the most recently viewed entity"; `version` is a counter "used for locking"; 409 on a stale write ([methods](https://docs.joinmastodon.org/methods/markers/), [entity](https://docs.joinmastodon.org/entities/Marker/)).
  - `min_id` "returns results immediately newer" and paginates forward; `since_id` is only a lower bound; limit 20 default, 40 max ([timelines](https://docs.joinmastodon.org/methods/timelines/)). `min_id` is the primitive for reading oldest-first with no gap.
- **Clients:**
  - Tweet Marker (2011) synced only a last-read position ([Manton](https://www.manton.org/2011/06/03/tweet-marker.html)). Tweetbot scrolls to the synced tweet and shows a marker, opt-in; Twitterrific can show the marker or auto-scroll ([MacStories](https://www.macstories.net/news/tweetbot-1-6-gets-tweet-marker-timeline-sync/)).
  - Ivory and Tweetbot sync through iCloud, not the markers API ([Tsai](https://mjtsai.com/blog/2023/01/24/ivory-1-0/), [zerokspot](https://zerokspot.com/weblog/2023/01/29/five-cents-on-ivory/)). Tusker offers both and says API sync doesn't work with the Mastodon web UI ([commit](https://git.shadowfacts.net/Fahim/Tusker/commit/9d2324b587d9c8395a4e16c30c7950fa5915506d)).
  - Mastodon iOS shows a "Load More" button at gaps and a new-posts pill ([DeepWiki summary](https://deepwiki.com/mastodon/mastodon-ios/4.1-timeline)). I could not confirm Tusky/Elk behaviour.
- **Reading position elsewhere:**
  - Discourse keeps only the deepest position, deliberately not "reading holes", and you lose your place when a notification jumps you ahead ([staff](https://meta.discourse.org/t/remember-last-read-post-after-navigating-to-a-notification/152371), [read time](https://meta.discourse.org/t/how-is-read-time-calculated/133465/2)).
  - A "seen" dwell timer of 500ms with `threshold: [0, 1]` is a known recipe ([jefftk](https://jefftk.com/p/detecting-whats-been-seen)).
  - Instagram's "You're all caught up" (2018) appears after two days of posts and is a deliberate stopping cue ([9to5Google](https://9to5google.com/2018/07/02/instagram-youre-all-caught-up-feature/), [NBC](https://www.nbcnews.com/news/amp/ncna890771)).
- **Substack:**
  - Post page: nav, title, date + counts (subtitle optional), hero image, body, engagement row, previous/next, "Discussion about this post" with Top/Latest sort, subscribe prompt ([sample](https://on.substack.com/p/grow-3)). One narrow centered column; serif display ~32px, serif body ~19px per a [third-party breakdown](https://kombai.com/examples/design-systems/substack-kombai); no official measure found.
  - Archive: Latest/Top/Discussions tabs, month headings, rows of title + subtitle + date + author + counts + thumbnail ([archive](https://on.substack.com/archive)).
- **Steam comments:** setting "Can post comments on my profile" = public / friends only / private; friends-only limits posting, not reading ([forum](https://steamcommunity.com/discussions/forum/0/1736594593595936718), [ghacks](https://www.ghacks.net/?p=143128)); commenting on non-friends needs a community-badge level ([2021 user report](https://steamcommunity.com/discussions/forum/0/3118150513199361000)). Valve's help page returned no body; I found no source for profile paging.
- **MySpace 2006:** "Add Comment" sits above the comment block, "View All" opens the rest, commenters get "Delete My Comment" on their own ([Taylor](https://www.askdavetaylor.com/?p=1134)); owners can delete any and tick "approve before posting" ([Taylor](https://www.askdavetaylor.com/myspace_comments_approve_before_they_are_added_live/)); an inline comment box saved the extra click ([Quackit](https://quackit.com/myspace/codes/myspace_comment_box_code.cfm)). No archived 2006 layout found.
- **Reddit / phpBB:**
  - Past a depth threshold render "Continue this thread", which loads the subtree as its own page ([guide](https://www.techinterview.org/post/3233475316/build-comments-thread-nested-replies-pagination-optimistic/)). Alternatives: stop indenting single-reply chains after depth 4 ([Tildes](https://tildes.net/~tildes.official/cjg/experimenting_with_a_way_of_avoiding_deeply_nested_comment_threads)); minimum comment width, permalinks as new roots ([LessWrong](https://www.lesswrong.com/posts/4kaXYC67oPA6ZwPML/feature-request-green-glow-for-continue-this-thread)).
  - phpBB topic rows use status icons: announcement, sticky, read/unread, posted-in, hot, locked ([icon gallery](https://forum.openoffice.org/en/forum/viewtopic.php?p=1396)). Official phpBB docs were not retrieved.

## Recommendation

### Page shell
- **Keep** `#page` 980px and `.os-top` (blue header + `.ms-tabs`). The tab bar *is* the left nav, so no left rail: Home→**Feed**, Explore→Browse, Notifications→Requests (later Notifications), Messages→Inbox, Bulletins→Boards, Profile→My Page. The logged-out tab stays "Home".
- **Feed-like pages** (Feed, Boards, Notifications, tag/search results) get `.os-shell`: grid `620px 336px`, gap 8, padding 8 (= 980; the 600/350 lineage of X).
  - Center `.os-main`: compose window, mode bar, post list.
  - Right `.os-side` (sticky under the header): "Who to follow" (3 mini `personCard` + Follow), the horoscope teaser (moved from the top of Home), "Online now"; later "#tags", "hot boards", "#ourspace chat (N online)". Each is a `.ms-section` with a blue `.ms-boxtitle`.
- **Unchanged frames:** Profile (own 230 + fluid), Browse grid, Inbox, Settings, Edit, and the blog post (centered 640px reading column).
- **≤980px:** one column, `.os-side` hidden.
- **≤760px / 375px:**
  - 8px gutters, 40px avatars, `.btn98` min-height 32px for touch.
  - `.ms-tabs` becomes one horizontally scrolling line (`flex-wrap: nowrap; overflow-x: auto`; today it wraps to 2-3 rows).
  - A fixed `✏` compose `.btn98.go` bottom-right (toasts move up 56px); the resume status bar is fixed to the bottom.
- **Chrome stays Win98:** the compose box is a `.win98` window with a `.title-bar` ("✏ What's on your mind?" + `0/500`), posts keep the flat zebra rows of `.ms-feeditem`, resume progress is a sunken Win98 status bar, actions are glyph links (`💬 ↻ ♥ 🔖`), no SVG icon set.

### Profile
- **Left column** keeps photo, details, Contacting box, URL, Interests. Under the name: `41 Followers · 37 Following · 12 Friends`, each linking to `/u/:name/followers|following|friends` (the `personCard` grid of `renderFriends`). A "Follows you" chip sits next to the name. Friends = follows in both directions.
- **Follow button** (`.btn98` under the photo; replaces "Add to Friends"):

  | State | Label | Click |
  |---|---|---|
  | none | `★ Follow` (yellow `.go`; "Follow back" if they follow you) | open profile → Following; approval profile → Requested |
  | requested | `⏳ Requested` (pressed look) | cancels, no dialog |
  | following | `✔ Following` (hover: "Unfollow") | unfollows; Win98 `dialog()` only on approval profiles (re-follow needs approval) |
  | friends (mutual) | `👥 Friends` (yellow) | same as Following, with a dialog |

  Own page: "Edit My Page". Logged out: every state calls `needLogin`. Incoming requests stay in the **Requests** tab. Send Message / Block / Report stay in Contacting; "Add Comment" shows only for friends.
- **Right column, desktop order** (keeps the MySpace anatomy): banner → Top Songs → Blurbs → Friend Space (Top 8) → **tab strip** → tab body.
  - Tabs use `.os-tabs2`: **Statuses (128)** · **Blog (9)** · **Friends' Comments (34)**.
  - Each tab is a route (`/u/:name`, `/u/:name/blog`, `/u/:name/comments`) so links, back and sharing work; the shell data is cached ~30s to avoid a refetch.
- **Mobile order** via `display: contents` on `.ms-left`/`.ms-right` plus `order`: idcard (72px avatar, counts, Follow + Message) → tab strip + body → "About" boxes (Blurbs, Top 8, Interests, Details) in an open `<details>`. The stream is above the fold on a phone and below the furniture on desktop (open question 1).
- **Statuses tab:** composer (own page only), `paged()` list, ≤500 chars shown in full; photos/video later slot into the same card.
- **Approval profile, not following:** photo, name, counts, About-me and "follow to see their posts"; tabs, Top 8 and songs hidden.
- **Data:** `follows(follower, followee, status accepted|pending, created, PK(follower, followee))`; friends is a query on both rows; backfill two rows per accepted `friendships`. `POST/DELETE /api/follows/:name`; relation field `rel.follow = none|requested|following|friends` plus `rel.followsMe`.

### Feed + "pick up where I left off"
- **Contents:** statuses and blog posts (later reposts/quotes) by people you follow. Wall comments, bulletins, "joined" and "friends" events leave the feed.
- **Layout:** compose window → mode bar `[Latest] [Pick up where I left off (138)]` (+ a `Friends only` filter, Latest mode only) → list.
  - **Latest:** newest first, `before=<created:id>` as today. A `▲ Show 7 new posts` pill (`.btn98.go`, sticky under the tabs) appears when the 30s poll `GET /api/feed?mode=latest&since=<newestId>&count=1` finds more; posts are never inserted under the reader.
  - Posts newer than the marker get a 4px orange left border; a dashed `📍 you left off here` rule sits at the marker (Tweetbot's marker); `↧ jump to where I left off` scrolls to it, or switches to resume if it isn't loaded.
- **Marker = one number per user:** `feed_markers(user_id PK, last_id INTEGER NOT NULL DEFAULT 0, updated INTEGER, skipped_from, skipped_to, skipped_n)`.
  - `last_id` is a `posts.id` meaning "I have seen every post from people I follow with id ≤ this".
  - Id, not time: AUTOINCREMENT ids are monotonic and never reused, while `created` can skew across isolates (an older `created` with a newer id would be missed). Resume order is `id ASC`; Latest should move to `id DESC` too.
- **Resume queue:** `kind IN ('status','blog')`, author followed by you (not you), `id > marker`, `created >= follows.created` (what arrived since you followed them, so a new follow doesn't dump their backlog), plus today's hidden/banned/blocked rules. Unread is capped at 500 ("500+"); it rides in `/api/me` as `counts.feed` for an `.ms-badge` on the Feed tab.
- **UI:** `.ms-pagetitle` "Reading forward from Tue 14 Oct 9:12pm · oldest first, newest at the bottom"; day separators; up to 3 dimmed already-read posts above the first unread for context; a sticky Win98 status bar `[42 of 138 read] [~96 left] [↑ first unseen] [⏭ skip to newest]`; a "↺ read again from here" link on each card.
- **When the marker advances** (resume mode only; never in Latest, on prefetch, or on opening a profile):
  - An `IntersectionObserver` (`threshold [0, .6, 1]`) marks a card *seen* after ≥60% visible for 800ms, or when it leaves through the top after having been ≥60% visible.
  - The candidate is the highest id such that **every earlier rendered card is seen**, so dragging the scrollbar skips nothing. This deliberately differs from Discourse's hole-blindness: "know I saw everything" is the feature. Skipped cards stay unread and the bar offers `↑ first unseen`.
  - Writes are debounced 2s and flushed on `visibilitychange: hidden`, `pagehide` and route leave with `fetch(..., {keepalive: true})` (`sendBeacon` can't `PUT`).
- **API:**
  - `GET /api/feed?mode=resume&after=<id>&limit=30` → `{items (id ASC, id > after), marker:{lastId,updated}, unread, capped, next:<lastItemId>|null, context:[≤3 read posts, only when after is omitted]}`. `after` omitted = the stored marker; afterwards the client passes the last id on screen. This is `min_id` semantics, so there is no gap; `next:null` means caught up.
  - `GET /api/me/feed-marker` → `{lastId, updated, unread, capped, oldestUnread:{id,created}, skipped}`.
  - `PUT /api/me/feed-marker` with `{lastId}`, `{lastId:"newest"}` or `{lastId, rewind:true}`. Server: `last_id = MAX(last_id, ?)` unless `rewind`. A max-merge makes two devices' writes commute, so no `version`/409 dance (Mastodon needs one because its marker can move back).
  - Cross-device falls out of the marker living on the server; if a fetch returns a marker ahead of the screen, the bar says "read further on another device [jump ahead]".
- **Hundreds unseen:** over 100 unread, entering resume opens a Win98 `dialog()`: **Start from the oldest** / **Skip to the last 50** / **Mark all read**. A skip is explicit and recorded (`skipped_from/to/n`); Latest then shows `── 362 posts skipped (Oct 14 – Oct 22) · read them ──` (a `rewind`). Phase 2: a per-day histogram `GET /api/feed/days?after=` to jump to a day (counts as a skip). No auto-expiry (open question 4).
- **Empty states:** no follows → "follow some people" + a Browse button. Caught up → `deco_hearts_bar.gif`, "✔ You're all caught up as of 10:42pm", the 3 context posts, `[↻ check for new]` `[Latest ▸]`; polling appends "3 new posts · keep reading" at the bottom with no scroll jump (newest is last).
- **Cost and files:** a resume page scans `posts` from `id > marker` until 31 followed matches. Fine now, but D1 bills rows read ([004](004-cloudflare-limits-and-costs.md)); add `posts(author_id, id)`, and if it hurts fan out `feed_items(user_id, post_id)` on write. Migration `0002_follows_and_feed_markers.sql`; code in `src/social/` (`follows.js`, `feed.js`), `widgets/postcard.js`, `widgets/followbutton.js`.

### Blog post page and blog index
- **Index** (Blog tab), Substack-archive style: newest first, month headings ("October 2026"); each row = Georgia bold title, italic subtitle, `Oct 25 · 6 min read`, later `💬 3`. No thumbnails (no uploads yet). `paged()`.
  - Owner sees `✏ Write` (`.btn98.go`) and a "Drafts (2)" group only they can see.
  - In the Feed a blog post is a card: "wrote a blog post", title, subtitle, 280-char teaser, `Continue reading →`.
- **Post page** `/u/:name/blog/:id`: a "← Tom's Blog" `.ms-pagetitle` strip, then a centered column (max 640px) in the existing `.post` / `.post-head` / `.post-body` styles.
  - Title Georgia 30px/1.15 (24px mobile); optional subtitle ≤140 chars, italic 18px.
  - Author line: 32px avatar, name, inline Follow button, date, read time (~220 wpm), "edited".
  - Double rule in the author's accent color; body Georgia 16/1.75 (15/1.7 mobile) on white. The author's skin only touches the rule and title, for legibility.
  - Then `← Older: "…"   Newer: "…" →` and `copy link`. Replies and likes come with phase 2 under a "Discussion" heading. No email, no paywall, no subscribe box.
- **Body format:** plain text plus a tiny subset (blank-line paragraphs, `##` headings, `>` quotes, `- ` lists, `**bold**`, `*italic*`) built with `createElement`/`textContent`, so the no-`innerHTML` invariant holds. Length cap 8000 → 20000 (open question 5). `posts` gains `subtitle` and a draft/published flag.

### Friends' Comments
- **Layout** (Steam/MySpace): header `Displaying 1–10 of 34 comments`; composer on top, as MySpace's inline box saved a click (≤500 chars); newest first; rows are the existing `.ms-comment` (50px avatar left, name, time, body, `delete` / `⚑ report`). **Numbered pages** (`« 1 2 3 »`, 10 per page, `?page=`), because this wall is bounded, unlike the feed.
- **Who writes:** mutual follows (friends) and the owner. Everyone else sees the composer replaced by "Only Tom's friends can write here. [Follow]" (or "Requested"). **Who reads:** anyone who can see the profile.
- **Who deletes:** the author, the owner (any comment), moderators.
- **Never** in the Feed or the Statuses tab. The owner gets a notification in phase 2. Storage stays `posts.kind='wall'`.

### Later phases at a glance
- **Post card (phase 2):** `[av] Tom · 3h ⋯` / text with `@mentions` and `#tags` / optional embedded quote box (1px border) / icon row `💬 4  ↻ 2  ♥ 9  🔖  ⇪`. `↻` opens a Win98 menu "Repost / Quote". The permalink is the conversation view: the post enlarged, replies below as flat cards with "Replying to Tom", a self-thread joined by a vertical avatar rule. Bookmarks live at `/u/me/bookmarks`; Notifications replaces Requests as a tab.
- **Boards (phase 3):** a phpBB-style table in a `.ms-section`: icon (📌 sticky, 🔒 locked, ● unread) · title + starter · Replies · Last post (avatar, name, time). Unread threads are bold and open at the first unread through a per-thread `thread_reads(user_id, thread_id, last_post_id)`: the same max-merge marker as the feed.
- **Nested comments:** each reply indents 14px under a 2px vertical rail; clicking the rail or `[−]` collapses it (`[+4 more]`). Visual depth cap 6 desktop / 3 mobile, then `Continue this thread →` opens the subtree as a new root. Siblings beyond 10 → `Load more replies (12)`. Sort Best / New / Old. Skip Tildes' single-reply flattening at first.

## ASCII wireframes
Schematic, not to scale. `[...]` = `.btn98`, `[av]` = `avatar()`.
```
PROFILE (desktop 980px)                                                 (mobile 375px)
+--------------------------------------------------------------------+  +--------------------------+
| ourspace. a place for friends  [find people][Search] (av)marco     |  | ourspace.    [find][Go]  |
| Feed | My Page | Browse | Requests | Inbox | Boards | Horoscope    |  | Feed|My Page|Browse|In>  |
+---------------+----------------------------------------------------+  +--------------------------+
| Tom           | [ Tom is your friend. ]            banner          |  | [av] Tom    ONLINE NOW   |
| [  photo  ]   | Tom's Top Songs (Spotify)                          |  | 41 Followers 37 Following|
| 41 Followers  | Tom's Blurbs: About me / Who I'd like to meet      |  | 12 Friends   [* Friends] |
| 37 Following  | Tom's Friend Space   [1][2][3][4]                  |  | [Message]                |
| 12 Friends    |                      [5][6][7][8]    Top 8         |  | [Status][Blog 9][Comm 34]|
| [* Friends]   | [Statuses 128][Blog 9][Friends' Comments 34]       |  | Tom: status text...   2h |
| [Message]     | [av] Tom  status text, up to 500 chars   2h        |  | Tom: status text...   1d |
| Contacting    | [av] Tom  status text                   1d         |  | [show more]              |
| Interests     | [show more]                                        |  | v About Tom (open)       |
| Details       |                                                    |  |  Blurbs, Top 8, Interests|
+---------------+----------------------------------------------------+  +--------------------------+

FEED, RESUME MODE (desktop)                                             (mobile)
+--------------------------------------------------------------------+  +--------------------------+
| ... header + tabs as above (Feed tab on) ...                       |  | [compose.......] [Post]  |
+---------------------------------------------+----------------------+  | [Latest][*Resume 138*]   |
| +- What's on your mind? ------- 0/500 -+    | Who to follow        |  | oldest first, from Tue 14|
| | [                          ] [Post] |     | [av] Bo   [Follow]   |  | -- Tue 14 Oct --         |
| +--------------------------------------+    | [av] Cy   [Follow]   |  | [av] Ann 9:12pm          |
| [Latest] [*Pick up where I left off 138*]   | Today for Libra:     |  |   status text            |
| Reading forward from Tue 14 Oct 9:12pm.     |  ...                 |  | [av] Bo  9:40pm  BLOG    |
| ---------- Tue 14 Oct ----------            | Online now: ...      |  |   "Title" - 5 min read   |
| [av] Ann . 9:12pm  status text              | (later: #tags,       |  | -- Wed 15 Oct --         |
| [av] Bo  . 9:40pm  wrote "Title" -          |  boards, chat)       |  | [av] ...                 |
|      subtitle . 5 min  [Continue ->]        |                      |  | [42/138|96 left|Skip >]  |
| ---------- Wed 15 Oct ----------            |                      |  +--------------------------+
| [42 of 138 | ~96 left | first unseen | skip]|                      |
+---------------------------------------------+----------------------+

BLOG POST (desktop)                                                     (mobile)
+--------------------------------------------------------------------+  +--------------------------+
| < Tom's Blog                                         pagetitle     |  | < Tom's Blog             |
|         +----------------------------------+                       |  | Title, Georgia 24px      |
|         | Title, Georgia 30px bold         |                       |  | italic subtitle          |
|         | Subtitle, italic 18px, grey      |                       |  | (av) Tom  [Follow]       |
|         | (av) Tom [Follow]  Oct 25 . 6 min read                   |  | Oct 25 . 6 min read      |
|         | ====== double rule, author accent ======                 |  | =======================  |
|         | Body Georgia 16/1.75, max 640px; ## > - lists            |  | Body 15/1.7, 12px gutter |
|         | < Older: "Title"       Newer: "Title" >                  |  | < Older        Newer >   |
|         | Discussion (phase 2)        [copy link]                  |  | Discussion (phase 2)     |
|         +----------------------------------+                       |  |                          |
+--------------------------------------------------------------------+  +--------------------------+
```

## Open questions for the owner
1. **Profile order on desktop:** furniture first (Spotify, Blurbs, Top 8, then tabs; authentic MySpace, my default) or tabs first (more Twitter)? Mobile is stream-first either way.
2. **Top 8** from friends (mutuals) only? I assume yes; it keeps "friend" meaningful.
3. **Feed tab badge** showing the unread count: on by default (my pick) or opt-in? Should Feed open in resume mode automatically when unread > 0, or always in Latest?
4. **Unread expiry:** never (my pick, honest to "know I saw everything" with a visible "skipped" record), or auto-skip after 30/90 days?
5. **Blog:** length cap 20000, subtitle, drafts, and **links** (today `shared/text.js` strips links; blog readers will want them, perhaps blog-only)? Rich text beyond the tiny subset later?
6. **Friends' Comments:** when someone is unfriended, keep or hide their old comments? Add MySpace's "approve before showing" toggle? Should an approval-only profile hide the tab from non-followers (my default: yes)?
7. **Resume ignores posts older than your follow** (a new follow doesn't flood your queue). OK, or should a new follow pull in their last N posts?
8. **Existing friendships** migrate to two follow rows each; do DM and wall policies (`dm_policy`, `wall_policy`) map to "friends = mutuals" unchanged?
9. **Replies in the feed (phase 2):** show a reply only when you follow both people (X-style), or never?
10. **Exact X numbers:** I could not verify nav/sidebar widths or breakpoints from an official source; want me to measure the live site in devtools before the CSS is written?
