# 001 — Ranking: a small, explainable algorithm
Status: proposed (2026-10-25)

Every claim links its source. "unverified" means I could not confirm it on a primary page. Table and column names below are illustrative.

## Question
The Following feed is strictly newest-first. Which small set of ranking rules do we still need, with no scroll, dwell or watch-time signals? Five places only: Browse, board threads and comments, group-chat suggestions, mutuals, board recommendations. Each must run in D1 SQL, a few ms of JS in a Worker, or a cron.

## What we found
- **X / Twitter (2023).** About half of For You candidates come from the in-network search index; the rest come from graph traversal and follow recommendations ([README](https://github.com/twitter/the-algorithm)). A neural heavy ranker predicts 10 probabilities and sums them with fixed weights: like 0.5, retweet 1, reply 13.5, reply the author answers 75, good profile click 12, negative feedback -74, report -369 ([weights](https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md), April 2023). Then heuristics run: author diversity, in/out-of-network balance, feedback fatigue, dedupe, visibility ([home-mixer](https://github.com/twitter/the-algorithm/blob/main/home-mixer/README.md)); the author-diversity constants I could not find. Reuse: candidates then score, author diversity, negatives outweigh positives. Warning: a reply is worth 27 likes. RealGraph (exponentially decayed counts of user-to-user interactions) is known only second-hand ([summary](https://happystrongcoder.substack.com/p/dive-into-twitters-recommendation)); the paper was not read.
- **Reddit.** hot = sign(s)·log10(max(|s|,1)) + (t - 1134028003)/45000, with s = ups - downs, so 10x votes equals 12.5 hours. It does not depend on "now", so it can be stored. controversial = (ups+downs)^(min/max), 0 if either side is 0. best = Wilson lower bound with z = 1.2816 (80%) ([source](https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx)). Wilson: [Evan Miller](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html), who recommends 95% (z = 1.96) and warns it only fits binary votes. Quirk: scores -1, 0 and +1 get the same vote term.
- **Hacker News.** (votes-1)^0.8 / (age_hours+2)^1.8 times penalties, including one when comments exceed votes ([righto](https://www.righto.com/2013/11/how-hacker-news-ranking-really-works.html)). That penalty hides flame wars and real debate alike. **Lemmy** hot = 10000·log(max(1, 3+score)) / (hours+2)^1.8 ([docs](https://join-lemmy.org/docs/contributors/07-ranking-algo.html)).
- **Facebook.** EdgeRank (affinity × weight × decay per edge) was never published; only third-party descriptions exist ([example](https://www.thryv.com.au/?p=11229), unverified). Its 2018 successor scored like 1, reaction 5, comment 30, times a closeness factor. Internal memos later said it rewarded outrage, and "angry" went from 5 to 1.5 to 0 ([CNN via KRDO](https://krdo.com/news/2021/10/27/likes-anger-emojis-and-rsvps-the-math-behind-facebooks-news-feed-and-how-it-backfired/)).
- **Instagram.** "A variety of algorithms". Feed signals are post info, poster info, your activity and your history with the poster; top predictions include "will spend a few seconds on it", comment, like, reshare ([post](https://about.instagram.com/blog/announcements/shedding-more-light-on-how-instagram-works)). "Why am I seeing this" reached Reels and Explore in 2023 ([Fortune](https://fortune.com/2023/06/30/meta-facebook-instagram-algorithim-transparency), secondary).
- **Bluesky.** A feed is a service that returns a list of post URIs, built by any algorithm ([feed-generator](https://github.com/bluesky-social/feed-generator)). Its README suggests reimplementing What's Hot as a running like tally per post, returning recent posts over a like threshold. I found no published formula or constants for the real feed (unverified). Discover mixes trending, followed and nearby-graph posts ([blog](https://bsky.social/about/blog/7-27-2023-custom-feeds)).
- **Mastodon.** Home is reverse-chronological; only search and trends sort by relevance ([API guidelines](https://docs.joinmastodon.org/api/guidelines/)). Trending posts need 5+ boosts and favourites, score (n-1)², halved every hour, no replies or sensitive posts, with a review step ([source](https://github.com/mastodon/mastodon/blob/main/app/models/trends/statuses.rb)). Reuse: hard thresholds and a half-life.
- **YouTube and TikTok (the contrast).** YouTube moved from clicks to watch time in 2012, then added survey-based "valued watchtime" ([blog](https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/)). TikTok lists likes, shares, follows, comments, captions and sounds, and whether you finish a longer video ([newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)).
- **Evidence.** Guess et al., Science 2023: reverse-chronological Facebook and Instagram feeds cut time on platform, showed more political and untrustworthy content and less uncivil content, and did not change polarization in 3 months ([abstract](https://csmapnyu.org/research/academic-research/how-do-social-media-feed-algorithms-affect-attitudes-and-behavior-in-an-election-campaign)). Milli et al., PNAS Nexus 2025: Twitter's engagement ranking amplified emotional, out-group-hostile tweets that users said they did not prefer ([arXiv](https://arxiv.org/abs/2305.16941), abstract only). Gauthier et al., Nature 2026: X's algorithmic feed raised engagement and moved opinions right by 0.08 to 0.12 SD ([coverage](https://www.psypost.org/xs-feed-algorithm-shifts-users-political-opinions-to-the-right-new-study-finds/), paper not read). Fair reading: chronological is not a proven cure for polarization, and it needs block, mute and report tools. Engagement-optimizing against what people say they want is the clearer harm.
- **D1 math.** The docs say math functions are supported but do not list them ([SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)). I tested local D1 (wrangler 4.152.0): ln, log (base 10), log2, pow, sqrt, exp, ceil, floor, round work. log10, power and sqlite_version() fail with "not authorized". Remote D1 is untested. FTS5 works locally, but D1 cannot export a database that has virtual tables ([docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/)). Billing counts rows scanned, not returned ([docs](https://developers.cloudflare.com/d1/best-practices/use-indexes/)).

## What we will NOT do
- **No scroll, dwell, watch-time, completion or view-count signals**, and no impression log. They need surveillance to work, and engagement ranking measurably favours content people say they don't want (Milli, above; Facebook's MSI memos).
- **No reply-heavy weighting.** Twitter's 27x reply weight and Facebook's 30x comment weight reward conflict. A reply counts as one vote and is capped.
- **No machine-learned ranker, embeddings or per-member models.** No way to explain them, and no budget to run them.
- **No algorithm in the Following feed**, and no mixing recommended posts into it.
- **No controversy boost.** Controversial is an optional manual sort only.
- **No secret penalties.** HN-style hidden domain and keyword penalties are out. Moderation is a visible action; ranking never punishes an account.
- **No unexplained ranking.** Every ranked list shows its sort name, and every Browse item shows its reason.

## Recommendation
Every post and thread carries three counters: `likes`, `dislikes`, `replies_by_others` (replies from anyone except the author). The author's own like is added automatically and can be removed. Sort keys are plain columns recomputed in JS on each vote or reply, so reads are indexed `ORDER BY`s and need no D1 math.

### Board threads: hot / new / top / best
All sorts tie-break on `created DESC, id DESC`. Constants: `EPOCH = 1767225600` (2026-01-01 UTC), `UNIT = 172800` (2 days).
- **new:** `created DESC`.
- **top:** `score = likes - dislikes`, optional window (day, week, month, all).
- **hot:** `s = likes - dislikes + min(replies_by_others, 5)`, then `hot = sign(s)·log10(1 + |s|) + (created - EPOCH)/UNIT`. Stored, indexed `(board_id, hot DESC)`.
- **best:** Wilson lower bound of likes vs dislikes (formula in the next section), stored in `best`.
- **Why these numbers.** `1 + |s|` fixes Reddit's -1/0/+1 tie. UNIT is 2 days, not Reddit's 12.5 hours, because a small forum moves much slower (a guess until we have traffic): 10x the net votes buys 2 days. For example, a 100-net-vote thread 4 days old ties a fresh thread with 0 votes. Cap 5 replies so two people arguing cannot launch a thread.
- **Optional extras.** *active*: `last_reply_at DESC` (classic bump). *controversial*: Reddit's formula, using `pow()` in SQL; never the default.
- **Cost.** One UPDATE per vote. A board page is one indexed query of 25 rows.

### Nested comments: best sort
- `n = likes + dislikes`; `p = likes/n`; `z = 1.2816`.
- `best = (p + z²/(2n) - z·sqrt(p(1-p)/n + z²/(4n²))) / (1 + z²/n)`, clamped to 0 or more, and 0 when `n = 0`.
- A dislike is one full negative vote. There is no separate penalty. Both counts are shown; only the pair is ranked.
- z = 1.2816 follows Reddit's code. A 95% z (1.96) marks small samples down harder (1 up, 0 down scores 0.207, not 0.378), which suits a big site more than ours. Examples at z = 1.2816: 1 up, 0 down = 0.378; 5-0 = 0.753; 10-2 = 0.658; 100-100 = 0.455; 1-1 = 0.164.
- Ties: older comment first, so replies read in order. Threads tie-break newest first.
- Sort siblings only, within each parent. Fetch all comments of a thread in one query (cap 300, depth 6, then "continue thread"), order by `(parent_id, best DESC, created ASC)`, build the tree in JS. Collapse (never delete) a comment at net -5 or lower.
- **Implemented** (phase 3, `src/boards/tree.js`): one answer holds up to 200 comments, 8 levels and 10 replies per comment (the top level takes the rest of the 200); what's cut is a "load more" stub whose cursor is the last shown sibling's place in the sort (best, created, id), not a position. The front end shows 6 levels on a desktop and 3 on a phone, then "Continue this thread". There is no collapse at net -5: that front-end choice was not taken, and every comment shows open (anyone can fold one by hand).
- SQL form, tested in local D1, in case you prefer no JS: `max(0, (1.0*up/n + 1.6425/(2.0*n) - 1.2816*sqrt((1.0*up/n)*(1.0*down/n)/n + 1.6425/(4.0*n*n))) / (1 + 1.6425/n))`.

### Browse discovery
- **Candidates** (each at most 40 rows, newest 7 days, from indexed queries, at most 6 queries per page):
  1. Posts liked or replied to by someone I follow.
  2. Posts by mutuals (friends of friends) whom I do not follow.
  3. Threads in boards I joined or posted in, or that match my interests.
  4. Site-wide hot, as the fallback and for new members.
  5. One "new here" slot per 10 items: a post from a member under 14 days old.
- **Exclude:** my own posts; anyone I follow (Following already has them); blocked or muted either way; hidden items; net score of -3 or lower; adult-flagged boards for members under 18.
- **Score** = `hot` + boosts, where 1.0 = 2 days of freshness. Social proof +0.2 per distinct followed person (max 3). Author is a mutual +0.3. Board matches an interest +0.3; board I joined or posted in within 30 days +0.4 (take the larger).
- **Diversity pass** over the sorted list, per page of 20: at most 2 per author, at most 4 per board. Overflow items drop to a later page. This is Twitter's author-diversity idea with hard caps instead of unpublished decay.
- **No impression log.** Pages use a score cursor. The page JS may send the ids it already showed (kept in the page, not stored) so refreshes skip them.
- **Reasons** (first match wins; the same SQL that finds the candidate returns it):
  1. `Liked by {A} and {n} others you follow` / `Liked by {A}, who you follow`
  2. `Replied to by {A}, who you follow`
  3. `{A}, a friend of {B}` / `{n} mutual friends`
  4. `Because you listed "{term}" under {Field}`
  5. `From {board}, which you joined`
  6. `New to OurSpace`
  7. `Popular on OurSpace this week` (the always-true fallback)

- **Implemented** (phase 6, `src/browse/`): candidates are read in fixed-size index ranges before any filtering (writers in 8 buckets by id, each bucket's newest 64 posts of 7 days; each writer's newest 3; the newest 150 of those), then kept if eligible: statuses, blog posts, quotes and threads by open profiles you don't follow, on your side of the 18 line (the owner's phase 6 decision: adults see adults, teens see teens, logged out sees adults), in boards you don't post in (30 days), plus what people you follow replied to or commented on (your newest 40 follows, 2 replies and 2 comments each); score and caps as above (hot for posts: likes + reposts as votes). Changes: **no "Liked by" source or reason**, since who liked what is shown nowhere else in the app (replies and comments, which are public, take its place: +0.2 per person, max 3); no "new here" slot (open question 7); no +0.4 for boards you joined, because the owner's spec leaves boards you're active in out of discovery; private authors are never shown (not even their board threads); net -3 threads and posts with a photo a moderator holds are left out. The "author is a mutual" boost reads "friends of yours follow the writer" (`Your friend kat follows zed`). Diversity overflow rides in the cursor (40 ids at most) and leads the next page. No sent-ids list: the cursor alone keeps pages apart.

### Interaction score
Used for group-chat suggestions and mutual tie-breaks. Directed table `affinity(a, b, score, updated_at)`, primary key `(a, b)`, `WITHOUT ROWID`: what `a` did toward `b`. It is updated on write and decayed on read.
- **Weights:** reply or wall comment 3 (effort); 1:1 message sent 2; mention 2; follow 2 (so new friends outrank strangers); like 1; group-chat message 0.5 to each other member, only in groups of 8 or fewer (to cap writes). **Zero:** dislikes (disliking is not closeness), profile visits and views (not recorded, privacy).
- **Half-life 30 days.** Long enough that a quiet week does not reset a friend; short enough that last month's best friend loses to this month's. Prune rows below 0.05 in the nightly cron.
- **Write**, in the same `db.batch()` as the action (tested in local D1):
  `INSERT INTO affinity (a,b,score,updated_at) VALUES (:me,:them,:w,:now) ON CONFLICT (a,b) DO UPDATE SET score = score * pow(0.5, (:now - updated_at)/2592000.0) + :w, updated_at = :now;`
- **Read** (tested in local D1):
  `SELECT x.b, x.eff, COALESCE(y.score * pow(0.5,(:now - y.updated_at)/2592000.0), 0) AS back FROM (SELECT b, score * pow(0.5,(:now - updated_at)/2592000.0) AS eff FROM affinity WHERE a = :me) x LEFT JOIN affinity y ON y.a = x.b AND y.b = :me ORDER BY x.eff DESC LIMIT 200`
- **Closeness** = `eff + min(eff, back)`. Their activity counts only as far as it matches yours, so a stranger who spams me cannot show up in my list.
- **Group-chat picker:** (1) friends by closeness, then name; (2) non-friends with `eff >= 3` and `back > 0`, at most 5, not blocked, DMs allowed; (3) everyone else A to Z with search. If the profile has a Top 8, add +5 at read time (not stored).
- **Cost:** one extra row write per interaction. A member has about 50 to 200 rows, so reads are a primary-key prefix scan.

### Mutuals
Friend = mutual follow, kept in a both-directions `friends(a, b)` table updated at follow-back and unfollow. Core join, tested in local D1 (order and exclusions below are added on top):
`SELECT f2.b AS cand, COUNT(*) AS n, group_concat(f1.b) AS via, SUM(1.0/ln(2 + (SELECT COUNT(*) FROM friends d WHERE d.a = f1.b))) AS aa FROM friends f1 JOIN friends f2 ON f2.a = f1.b WHERE f1.a = :me AND f2.b <> :me AND f2.b NOT IN (SELECT b FROM friends WHERE a = :me) GROUP BY f2.b`
- **Order:** `n` (mutual friends) DESC; they already follow me; `aa` (Adamic-Adar: rare shared friends count more, [explainer](https://en.wikipedia.org/wiki/Adamic%E2%80%93Adar_index)); active in the last 30 days; id.
- **Exclude:** me; friends; anyone I follow or have a pending request with; blocked either way; muted; suspended or hidden.
- **Show who:** first 3 names from `via`, ordered by my closeness, then "and N others". Fetch names in one query, 60 ids at most (D1 allows 100 bound parameters).
- **Cost:** about the sum of my friends' friend counts in rows (10,000 for 100 friends of 100). That is trivial on Paid and about 500 views a day on Free's 5M reads, so cache 6 hours per member on Free.
- If there are fewer than 5 results, pad with active members of my boards, labeled differently.

- **Implemented** (phase 6, `src/browse/`): as above, with no `friends` table (friends are two accepted follows) and caps that hold every request under 2,000 rows read (architecture.md, the row budget): your friends among your newest 100 follows (the newest 25 friendships), each one's newest 20 follows, 250 pairs; degrees count from the pairs read (so up to 20). Muted people aren't a thing here; blocked, banned, followed or requested, hidden ("not interested") and the other side of the 18 line (open question 3's default) are left out. Private profiles may show, as name and picture. No padding with board members below 5, and no 6-hour cache yet (roadmap). Names: up to 3, by closeness.

### Board recommendations from interests
Interests live in the profile JSON, so there is no SQL match. We match in JS against a curated table, with no FTS5 (export blocker) and no embeddings (not researched; revisit only if hand-curation fails).
1. **Boards carry terms.** `board_terms(board_id, term)` is written by the board owner; the board's name words are added automatically. Load once per Worker isolate, cache 5 minutes (about 2,000 rows).
2. **Normalize** each of the six fields (General, Music, Movies, Television, Books, Heroes): lowercase, strip accents, `&` to "and", split on commas, semicolons, slashes, newlines and " and ", drop a leading "the". Fold a trailing "s" on words over 3 letters, on both sides. Limits: 40 phrases, 60 characters each.
3. **Look up** every 1 to 3 word run in a `Map(term -> boards)`.
4. **Score** `Σ over distinct matched terms: w_field · ln(1 + N/df)`. N = board count, df = boards holding the term, so rare terms count more and generic ones fade. `w_field` = 1.5 if the field matches the board's category (Music for a music board), else 1.
5. **Keep** score of 1.0 or more, drop joined, muted and adult-flagged boards, show the top 5. Reason: `Because you listed "shoegaze" under Music`.
6. **Fallback** (no interests, or no match), in order: boards where 2+ people I follow posted in 30 days (`Maya and Jo post here`); boards with 3+ distinct posters in 14 days (`5 members posted this week`); owner-featured starter boards. Never recommend a board with no thread in 30 days.

- **Implemented** (phase 6, `migrations/0008_browse.sql`, `src/browse/`): `board_terms(term, board_id, weight)` curated by moderators (`PUT /api/admin/boards/:slug/terms`), seeded for the 14 launch boards; the name words are added in the Worker; cached 5 minutes per isolate. Normalising as above, also splitting on "+"; terms are at most 3 words. Skipped are boards you posted in and boards you hid. The fallback ladder is the owner's simpler one: boards busy this week (most posters), then the whole index; the "people I follow post here" rung and the 30-day dead-board rule aren't built. Reasons use the words as typed: `Because you listed "my chemical romance" under Music`.

### Constants (one `src/ranking/constants.js`, with unit tests for `wilson()` and `hot()`)
| Name | Value | Used for |
|---|---|---|
| `EPOCH` / `UNIT` | 1767225600 / 172800 s | hot: zero point, and 2 days per 10x votes |
| `REPLY_CAP` | 5 | hot: most replies that count |
| `WILSON_Z` | 1.2816 | best, threads and comments |
| `HALF_LIFE` | 30 days | interaction score |
| `W_*` | reply 3, message 2, mention 2, follow 2, like 1, group 0.5 | interaction weights |
| boosts | 0.2 per person (max 3), 0.3, 0.3 / 0.4 | Browse, in UNITs |
| caps | 2 per author, 4 per board, per 20 | Browse diversity |

CPU: scoring about 200 candidates in JS is a few thousand arithmetic operations (my estimate, not measured), so it should fit even the Free plan's 10 ms.

## Open questions for the owner
1. Should authors auto-like their own post or comment (Reddit does), and can they remove it?
2. Is 2 days the right freshness unit? It is a guess until there is real traffic. Should it live in a `settings` row so it can change without a deploy?
3. Should mutuals and Browse ever connect a 13 to 17 year old with an adult they do not know? The default here: no.
4. Should members be able to turn off "friends of friends" suggestions, and hide their friend list from this feature?
5. Do you want a pinned/sticky thread flag per board, ahead of any sort?
6. Who curates `board_terms`: the board owner, moderators, or you? Is a missing term acceptable, or should unmatched profile phrases be reported to the owner?
7. Is the "new here" slot (1 in 10) wanted, or should new members get no special lane?
8. Is Top 8 a strong enough signal to add +5 to closeness?
9. Which plan are we on? Free (10 ms CPU, 50 D1 queries per request, 5M reads a day) needs the 6-hour mutuals cache and at most 6 queries per Browse page. Paid does not.
