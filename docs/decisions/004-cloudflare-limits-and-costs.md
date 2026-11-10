# 004 — Cloudflare limits and costs
Status: reference (checked 2026-10-25; Workers, D1, Durable Objects, R2 and Turnstile rows re-checked against Cloudflare's docs 2026-11-07, with the corrections below; rows not re-checked are marked). See [Free or Paid](#free-or-paid-for-ourspace-checked-2026-11-07). **Video was dropped by the owner** (phase 4 is photos only), so the video lines in the estimates below (0.02 videos a day at 25 MB, presigned uploads for 50 MB clips) no longer apply; photos go through the Worker at 2 MB at most, stored stripped and resized.

Every row links its source. "unverified" = not confirmed on an official page. USD list prices.

## Plans and limits

### Workers
| Item | Workers Free | Workers Paid ($5/mo minimum) | Source |
|---|---|---|---|
| Requests | 100,000/day, resets 00:00 UTC; over it returns Error 1027 (the 100,000 confirmed 2026-11-07; the Error 1027 behavior not re-checked) | 10M/mo included, +$0.30/M | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| CPU per invocation | 10 ms | Default 30 s, max 5 min; 30M CPU-ms/mo included, +$0.02/M | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Subrequests per invocation | 50 external + 1,000 to Cloudflare services | 10,000 default, up to 10M via config | [changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) |
| Request body | 100 MB on a Free zone (zone plan sets it, not Workers plan) | 100 MB Pro zone; 200 MB Business zone | [limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) |
| Static assets | 20,000 files/version; 25 MiB per file; requests free and unlimited | 100,000 files/version; 25 MiB per file; free and unlimited | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) (note 3) |
| Cron Triggers | 5 per account | 250 per account | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU per Cron Trigger run (added 2026-11-07) | 10 ms | 30 s if the interval is under 1 hour, 15 min if 1 hour or more; 15 min wall time either way | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers per account (added 2026-11-07) | 100 | 500 | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Memory, Worker size | 128 MB; 64 MiB uncompressed, no compressed limit (confirmed 2026-11-07) | Same | [limits](https://developers.cloudflare.com/workers/platform/limits/), [changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/) |

### D1
| Item | Free | Paid | Source |
|---|---|---|---|
| Rows read | 5M/day | 25B/mo incl., +$0.001/M | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Rows written | 100,000/day | 50M/mo incl., +$1.00/M | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Storage | 5 GB total | 5 GB incl., +$0.75/GB-mo; 1 TB account max | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max size per database | 500 MB | 10 GB, cannot be raised | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Databases per account | 10 | 1,000,000 (the first 100,000 included, then $0.10 per database per month; corrected 2026-11-07, was 50,000) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Queries per Worker invocation | 50 | 1,000 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Time Travel | 7 days | 30 days | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Egress | None | None | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Free-tier cutoff | Since 2026-09-01, queries fail past the daily read or write cap until 00:00 UTC (confirmed 2026-11-07: binding and REST API both error, stored data is untouched, an email alert is sent; at the 5 GB storage cap you can't insert, create tables or indexes until you free space); upgrading to Paid lifts it within minutes | n/a | [changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/) |
| SQLite math (log, pow, exp) | "Math functions" listed as a supported extension; specific functions unverified | Same | [sql-statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) |

### R2
| Item | Free (per month) | Paid rate | Source |
|---|---|---|---|
| Standard storage | 10 GB-month (Standard class only) | $0.015/GB-mo | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Class A (PUT, multipart, LIST) | 1M | $4.50/M | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Class B (GET, HEAD) | 10M | $0.36/M | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Delete, abort multipart | Free | Free | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Egress | Free | Free | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Max single PUT | 5 GiB | Same | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| Multipart | 5 TiB object; 10,000 parts; 5 MiB to 5 GiB per part (last part may be smaller) | Same | [upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/) |
| Presigned URLs | PUT, GET, HEAD, DELETE; 1 s to 7 days; S3 endpoint only, not custom domains | Same | [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| Browser uploads | Bucket CORS must allow the app origin; expired URLs return 403 with no CORS headers | Same | [CORS](https://developers.cloudflare.com/r2/buckets/cors/) |
| Writes per key | 1 per second; higher returns 429 | Same | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| Abandoned multipart | Auto-aborted after 7 days | Same | [upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/) |

### Durable Objects
| Item | Free | Paid | Source |
|---|---|---|---|
| Storage backend | SQLite only | SQLite (KV legacy only) | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Requests | 100,000/day | 1M/mo incl., +$0.15/M; counts HTTP, RPC, WebSocket messages, alarms | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| WebSocket messages billed | 1 request per 20 messages (ratio used in examples) | Same | [DO pricing examples](https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing-examples) |
| Duration | 13,000 GB-s/day | 400,000 GB-s/mo incl., +$12.50/M GB-s; 128 MB billed per active object | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Idle and hibernatable | Not billed | Not billed; `accept()` bills the whole connection | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (note 4); [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) |
| SQL rows read | 5M/day | 25B/mo incl., +$0.001/M | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| SQL rows written | 100,000/day | 50M/mo incl., +$1.00/M | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| SQL stored | 5 GB total | 5 GB-mo incl., +$0.20/GB-mo | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Storage per object | 10 GB | 10 GB | [concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) |
| WebSockets per object | 32,768 max with Hibernation API | Same | [state API](https://developers.cloudflare.com/durable-objects/api/state/) |
| WebSocket message size | 32 MiB | Same | [changelog](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/) |
| SQL math functions | Supported ("Math functions" listed; specific names unverified) | Same | [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |

### Turnstile
| Item | Free | Source |
|---|---|---|
| Widgets | 20 per account (Enterprise can raise) | [plans](https://developers.cloudflare.com/turnstile/plans/) |
| Price | Free plan; request-volume cap unverified | [plans](https://developers.cloudflare.com/turnstile/plans/) |
| Test sitekeys | `1x00000000000000000000AA` always passes; `2x00000000000000000000AB` always fails; `1x00000000000000000000BB` / `2x00000000000000000000BB` always pass / fail, invisible widget (added 2026-11-07); `3x00000000000000000000FF` forces challenge; work on localhost and 127.0.0.1 | [testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) |
| Test secret | `1x0000000000000000000000000000000AA` passes; `2x…AA` always fails; `3x…AA` answers `timeout-or-duplicate`; production secrets reject dummy tokens | [testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) |

### Workers AI
| Item | Value | Source |
|---|---|---|
| Free allocation | 10,000 Neurons/day on Free and Paid; resets 00:00 UTC; over it fails | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Beyond allocation | $0.011 per 1,000 Neurons (Paid) | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

### Images and Stream (for later comparison)
| Item | Value | Source |
|---|---|---|
| Images Free | 5,000 unique transformations/mo; over it returns error 9422, not billed | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Images Paid | Transforms $0.50/1,000 after 5,000; stored $5 per 100k/mo; delivered $1 per 100k/mo; no base fee stated | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Stream | Stored $5/mo per 1,000 min capacity (prepaid); delivered $1 per 1,000 min; encoding and ingress free; free allocation not stated | [Stream pricing](https://developers.cloudflare.com/stream/pricing/) |

### CSAM Scanning Tool
| Item | Value | Source |
|---|---|---|
| Scope | Images ("block images identified as CSAM"); video not stated | [CSAM](https://developers.cloudflare.com/cache/reference/csam-scanning/) |
| Requirements | Content served through Cloudflare cache; notification email; Service-Specific Terms. Proxy status, plan, custom domain: not stated | [CSAM](https://developers.cloudflare.com/cache/reference/csam-scanning/) |
| Cost | Not stated | [CSAM](https://developers.cloudflare.com/cache/reference/csam-scanning/) |
| On a match | Matched URL blocked if possible; one daily email listing paths | [CSAM](https://developers.cloudflare.com/cache/reference/csam-scanning/) |

## Cost model

Assumptions per monthly active member (MAM), Workers Paid, month 12, nothing deleted:
- 15 Worker requests/day; 30 D1 rows read per request; 4 D1 rows written/day; 2 KB D1 data/day incl. indexes.
- Media: 0.6 photos/day at 2.2 MB (2 MB + thumbnail, 2 PUTs); 0.02 videos/day at 25 MB; 20 media GETs/day from R2, no CDN hits assumed. About 55 MB per member per month.
- Chat: 20 inbound WebSocket messages/day, 1 connect/day, 2 DO RPC calls/day; 2 SQL rows written and 200 B stored per message.
- Public-room object always on (worst case 0.128 GB x 2,628,000 s = 336,384 GB-s/mo); all chat in that one object (worst case). Average Worker CPU 5 ms.

| USD per month | 100 MAM | 1,000 MAM | 10,000 MAM |
|---|---|---|---|
| Lowest plan that fits | Free works until R2 passes 10 GB (~month 2); use Paid | Free until 500 MB D1 DB cap (~month 8); Paid | Paid required: 150k Worker requests/day and 400k DO rows/day exceed Free |
| Workers Paid base | 5.00 | 5.00 | 5.00 |
| Workers overage (4.8M requests, 24M CPU-ms at 10k) | 0.00 | 0.00 | 0.00 |
| D1 reads and writes (135M reads, 1.2M writes at 10k) | 0.00 | 0.00 | 0.00 |
| D1 storage over 5 GB (7.3 GB at 10k) | 0.00 | 0.00 | 1.73 |
| DO requests over 1M (1.2M at 10k) | 0.00 | 0.00 | 0.03 |
| DO duration (336k GB-s, under 400k) | 0.00 | 0.00 | 0.00 |
| DO SQL storage over 5 GB (14.6 GB at 10k) | 0.00 | 0.00 | 1.92 |
| R2 storage over 10 GB (66 / 660 / 6,600 GB) | 0.84 | 9.75 | 98.85 |
| R2 Class A and B (366k / 6.0M at 10k, under free) | 0.00 | 0.00 | 0.00 |
| Turnstile, Workers AI, Images, Stream, egress | 0.00 | 0.00 | 0.00 |
| **Total, month 12** | **5.84** | **14.75** | **107.53** |
| Total, month 1 | 5.00 | 5.68 | 13.13 |

- Budget: $10/mo holds for 100 MAM all year and for 1,000 MAM until ~month 7 (R2 passes ~343 GB). Levers: photo size and retention. At month 12, each 1 MB less per photo saves ~$3.24/mo at 1,000 MAM and ~$32/mo at 10,000 MAM.
- Stream (not used): 6,000 videos/mo at 10,000 MAM, assuming 1 min each, is 72,000 min stored at month 12 = $360/mo storage, before delivery fees.

## Gotchas for our design
- Uploads: 50 MB passes the 100 MB body limit, but proxying bytes through a Worker costs CPU, memory and request time. Use presigned R2 PUTs (single PUT up to 5 GiB; no multipart needed at 50 MB). Presigned URLs skip custom domains and need bucket CORS. Size caps on presigned PUTs are unverified: HEAD the object after upload and delete if over limit.
- Free-plan cliffs: Workers Free returns Error 1027 past 100k requests/day; D1 Free queries fail past daily caps since 2026-09-01. Launch on Workers Paid ($5/mo); the reasons, with measurements, are in the next section.
- D1 ceiling: 500 MB per Free database, 10 GB per Paid database, not raisable. At 10,000 MAM, shard by group or year before ~month 16 (7.3 GB at month 12, +0.6 GB/mo).
- Chat billing: DO bills requests (connect = 1, messages at 1/20), wall-clock duration of active objects, and SQL rows and storage. Use the Hibernation API (`ctx.acceptWebSocket`), never `accept()`.
- **As built (phase 5):** messages live in D1, not in the objects (the owner's call: one place for data, reports and moderation), so the DO SQL storage line above is $0: a `Room` object stores nothing. Per message: one D1 write batch (the message, the conversation's time, the writer's read position, the interaction scores) and one RPC to the room (1 DO request), plus one outgoing frame per connected socket (outgoing frames aren't billed as requests). Typing and pings are client frames (billed at 1/20 of a request); pings are answered by `setWebSocketAutoResponse` without waking the object, so an idle room with open sockets bills no duration. What keeps one member from running that bill up (enforced since the phase 5 red team): opening sockets is rate limited in the Worker before the room is reached (30 a minute, 600 a day per member, one D1 write each); a room holds 5 sockets per member (a sixth closes the oldest); a socket that sends more than about one frame a second, sustained (a bucket of 10), is closed, so one socket can wake its room about 86,400 times a day at most (about 4,300 billed requests at 1/20) and only while it keeps reconnecting inside the upgrade limit; typing is relayed once per 2 seconds per person, after one D1 read of the session; and presence goes out in rounds at most once a second (one alarm, billed as a request, per round), not one fan-out per connect, so a burst of connects costs one round of frames to everybody instead of n². Ending a session (logout, password change or reset, ban, account deletion) is one RPC per room the member may have open (#ourspace plus up to 500 of their conversations), and a room checks its sockets' sessions against D1 at most once a minute while it carries events. #ourspace is trimmed by the cron to 500 messages / 24 hours, so its D1 footprint stays under ~0.2 MB. Rough month at 1,000 MAM with the chat assumptions above: 600k messages ≈ 0.6M DO requests (under the 1M included), duration only while a room handles an event (well under the 400k GB-s included), about 2.4M D1 rows written (about 4 per message, under the 50M included) and ~120 MB more D1 storage a month (inside the 5 GB included until month 12 or so, then $0.75/GB-month). So chat should add $0 to the $5 base at that size, comfortably inside the ~$10 budget; the unverified piece is still single-object throughput for #ourspace at 10,000 MAM.
- Chat hot spot: all public-room messages land in one object. At 10,000 MAM (200k messages/day, ~40 MB/day at 200 B) the 10 GB object cap is reached in ~8 months without pruning. Plan pruning or sharding. Single-object throughput is unverified; load-test it.
- Storage prices: D1 $0.75/GB-mo vs DO SQLite $0.20/GB-mo beyond included. Keep per-room chat history in DOs; cross-user feeds stay in D1.
- R2 reads: 20 media GETs/day per member gives 6M Class B/mo at 10,000 MAM, near the 10M free tier. CDN caching would cut this; its effect on Class B is unverified.
- CSAM tool: images only (video not stated), only for content served through the Cloudflare cache; blocks matches and emails daily; cost not stated. Decide before launch whether media is served through a cached zone.
- Turnstile: 20 widgets on Free. Use `1x00000000000000000000AA` locally; keep localhost out of production hostnames.
- SQL math: verify `log`, `pow`, `exp` in a dev D1 before relying on them; fall back to Worker JS if missing.
- Cron: 5 per account on Free, 250 on Paid. Workers AI free allocation (10,000 Neurons/day) is excluded from the model.

## Free or Paid for OurSpace (checked 2026-11-07)

**Recommendation: Workers Paid ($5/month) from the first deploy.** Evidence, each line with how it was got:

| Question | Finding | Verdict |
|---|---|---|
| Crons (`wrangler.jsonc`) | Three: `*/30 * * * *`, `17 3 * * *`, `* * * * *` (every minute, push outbox). Free allows 5 per account across all Workers; Paid 250. The account already has the old `ourspace-api` Worker, whose crons were not inspected (no read-only Wrangler command lists them), so the Free budget of 5 may be shared. | Fits Free if `ourspace-api` has at most 2. Not the deciding factor. |
| Durable Object | `Room`, declared `new_sqlite_classes` in `wrangler.jsonc`: SQLite-backed. Docs: only SQLite-backed objects are available on Free. | Allowed on Free. Free caps (100,000 requests/day, 13,000 GB-s/day) apply; 1/20 billing of incoming socket messages. |
| Bundle size | Measured with `wrangler deploy --dry-run`: 502.4 KiB uncompressed, 143.3 KiB gzip; assets 361 files, about 4 MB. Limit 64 MiB uncompressed on both plans, no compressed limit; assets 20,000 files and 25 MiB each on Free. | Fits Free by a factor of over 100. Not a factor. |
| CPU, 10 ms per request on Free | Sign-up and log-in: PBKDF2-SHA256, 100,000 iterations (`src/accounts/auth.js`). Measured 23 ms (23.2, 24.9, 23.2) in Node 24 on the owner's PC, as a stand-in: **not measured inside workerd**, so the exact figure on Cloudflare is unconfirmed, but it is more than twice the Free limit on any hardware likely to differ by that much. Sign-up's proof-of-work check is one SHA-256 (0.04 ms measured; the 2^18 hashes are the browser's work), simhash/minhash of a post is cheap string work (not measured), the nightly cluster check reads up to 5,000 + 2,000 rows and compares fingerprints in JS (not measured; Cron CPU on Free is also 10 ms). | **The deciding factor.** Password hashing alone breaks the Free limit; the docs' advice to confirm Paid before relying on PoW, simhash and clusters is right, and PBKDF2 is the bigger reason. |
| D1 daily limits | Free: 5M rows read, 100,000 rows written a day. Past either, every query fails until 00:00 UTC (since 2026-09-01), taking the whole site down (the Worker needs D1 for sessions on nearly every request), and an email alert is sent. Paid: 25B reads and 50M writes a month included. | Free is a daily outage waiting to happen once the site is busy; Paid removes it. |
| Cost | $5 base; the model above puts 100 members at $5.84 and 1,000 at $14.75 by month 12 (mostly R2 photos). | Within the $10 budget for a good while. |

Decision-001 question 9 and decision-003 question 9 ("which plan are we on?") can be answered: Paid. That also removes the need for the 6-hour mutuals cache and 6-queries-per-Browse-page limit that decision 001 says Free requires (it allows 1,000 D1 queries per invocation and 30 s CPU).

Not confirmed on 2026-11-07: workerd's real CPU time for PBKDF2 (measure with `wrangler tail` or the dashboard's CPU graphs after the first sign-ups), Error 1027 behavior, request-body limits, the Workers AI, Images, Stream and CSAM rows, the subrequest limits (the limits page says 10,000 per request on Paid; the Paid-configurable ceiling in the changelog was not re-read), Turnstile's request-volume cap, and whether R2 asks for a payment method (the docs don't say; on this account R2 was simply not enabled: error 10042).
