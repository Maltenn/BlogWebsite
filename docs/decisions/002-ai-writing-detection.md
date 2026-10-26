# 002 — AI-writing detection
Status: accepted with the owner's changes, built in phase 7 (2026-10-26). Free detectors only for now: the adapter takes `off` (the default) | `workersai` | `pangram` | `gptzero` (+ `mock` for tests), chosen by `AI_DETECTOR`; `AI_ENFORCEMENT` is `shadow` by default and goes to `enforce` only after `tools/eval-detector.mjs` measures the human false-positive rate at ≤ 1% (95% upper bound). Scope: public posts of 100+ words (blogs 150+), Friends' Comments included, never DMs or chat. The owner's ladder: 1 warning, 2 a day's posting timeout, 3 a week, 4 a month, 5 a moderator decides on a ban; one strike per 24-hour incident; label AI with score ≥ 0.95 only; the post stays up; strikes expire after 90 clean days; every strike appealable (removal lifts its timeout; a 180-day exemption follows, as recommended below). Workers AI has no AI-text classifier or log-probabilities, so its option is an LLM judge, expected to fail the bar. Not built yet: the scan queue with retries, the budget guard, sampling, caching, language detection. See [architecture.md](../architecture.md#ai-writing-strikes).

V = vendor claim. I = independent evaluation. S = secondary/aggregator, unverified. Prices are list prices, USD, checked 2026-10-25.

## Question
Can we flag "overwhelmingly likely AI" text in public posts (blogs, forum threads and comments, Friends' Comments, statuses) accurately enough to drive an automatic strike ladder (warning, 1 day, 1 week, 1 month, moderator ban review), for about $10/month for the whole site, without wrongly punishing real people?

Short answer: a detector can serve as a deterrent for long-ish text. It cannot judge statuses (<= 500 chars) or most short comments, and it will wrongly flag some humans. Design for that.

## What we found
| Provider | Short-text FPR (source) | Independent eval | Price at our scale | Privacy / retention | Notes |
|---|---|---|---|---|---|
| **Pangram** (v4) | V: 0.0041% overall, internal, no length split ([blog](https://www.pangram.com/blog/introducing-pangram-4)). Refuses < 50 words ([V](https://www.pangram.com/blog/why-does-pangram-have-a-minimum-word-count)). I: <= 0.75% on ~80-word reviews, <= 2.5% on < 50-word stubs ([Chicago/NBER](https://www.nber.org/papers/w34223)) | Chicago: best of 4, robust to StealthGPT. [Epoch](https://epoch.ai/data-insights/ai-detectors-false-negatives) Jul 2026 (v3.3.2): 0 of 495 human passages flagged. [Russell, ACL 2025](https://arxiv.org/abs/2501.15654): 2% FPR, 98% TPR (older version). Not in RAID. ESL: vendor data only ([tech report](https://arxiv.org/abs/2402.14873)) | $0.05 per 100 words = $0.50/1k words ([blog](https://www.pangram.com/blog/introducing-pangram-4)); the [pricing page](https://www.pangram.com/pricing) lists no API rate; Pro $65/mo bundles $200 API credits | V: never trains on your data, no outside AI vendors ([FAQ](https://www.pangram.com/knowledge-hub/does-pangram-train-on-my-data)). Policy says submissions are stored for your results view; API retention and minors' text unconfirmed. [ToS](https://www.pangram.com/terms-of-service): account holder 18+, no minors clause | Async task + poll REST ([docs](https://pangram.readthedocs.io/en/latest/api/rest.html)); latency unpublished. Returns `fraction_ai`, `prediction_short`, per-window scores |
| **GPTZero** | V: ~1% FPR at 95.7% TPR on RAID ([claim](https://gptzero.me/news/gptzero-accuracy-stats/)). I: 0–2.4% across genres, 80-word reviews worst (Chicago); Chicago calls it unsuitable for stubs | [RAID](https://arxiv.org/abs/2405.07940) 2024: unusually robust to adversarial edits (loses <= 5.5 points on every attack, by my reading of Table 6). Chicago: 2nd tier, misses ~50%+ after StealthGPT. Epoch: 0 of 495. Russell: 0.7% FPR, 85% TPR, 47% TPR on humanized | Reported $45/mo = 300k words, $150/M over ([S](https://us.fitgap.com/products/038942/gpt-zero)); [vendor page](https://gptzero.me/developers) did not render prices. Plan minimum is a large share of our budget | V: "do not store or collect the documents passed into any calls to our API" ([dev page](https://gptzero.me/developers)). Pangram's report claims 7.7% FPR on TOEFL (competitor) | `POST api.gptzero.me/v2/predict/text` ([docs](https://docs.gptzero.me/)). Min length and response fields not confirmed |
| **Originality.ai** | I: 1.7–2.2% on short reviews (0–0.3% on news/blogs), but refuses some stubs with a "length filter" error (Chicago); Epoch: 19 of 495 (3.8%) | Chicago: 2nd at strict caps; up to 21% misses on humanized short text. RAID: loses ~76 accuracy points under homoglyph substitution (my reading of Table 6) | ~$0.01 per 100 words (S), but API is Enterprise only, $179/mo ([pricing](https://originality.ai/pricing)). Over budget | Not found | Epoch could not use the API on Pro |
| **Sapling** | None published. S: one aggregator cites 17%, unverifiable. Advises >= 300 chars; < 500 chars returns `low_confidence` | None found | $0.005 per 1k chars, about $0.03/1k words ([pricing](https://sapling.ai/docs/api/pricing/)) | Not found (3-day result cache) | 8 languages. Cheapest. Triage candidate only |
| **Copyleaks, Winston, Hive** | None verified | None found; review sites conflict (Winston 0.5% vs 10%) | Winston 1 credit/word, 2,000 free ([docs](https://docs.gowinston.ai/api-reference/introduction.md)); Copyleaks about $8/mo (one review); Hive quote-based | Not verified | Not recommended without evidence |
| **Binoculars, Fast-DetectGPT, RoBERTa/DeBERTa** | Binoculars V: 0.01% FPR on 2023-era data ([paper](https://arxiv.org/abs/2401.12070)). Russell: 1.3% FPR but 67% TPR (40% at 0% FPR), 7% TPR on humanized. Fast-DetectGPT: 80% TPR at 7.2% FPR. RoBERTa-GPT2: 30–78% FPR (Chicago) | Binoculars was best open method at low FPR in RAID, but loses ~36 points to synonym swaps and ~42 to homoglyphs | Binoculars needs two 7B models (Falcon-7B + instruct) on a GPU. [Workers AI](https://developers.cloudflare.com/workers-ai/models/) has no AI-text classifier (only bge-reranker-base, distilbert-sst-2; llama-guard is a safety model) and I found no documented token-logprob output | n/a | Separate GPU host: more ops, worse accuracy than the APIs. Not worth it |

- **Evidence quality.** Chicago/NBER (Jabarian and Imas, Sep 2025; authors declare no conflicts): 1,992 human passages written before 2020 vs 4 current LLMs; vendors' default thresholds are not disclosed via API. Its human sets (Amazon, Yelp, Blog Authorship, Gutenberg) are public corpora a vendor may have trained on; I could not rule out overlap.
- **Our content is the weak spot.** Every independent test uses clean, mostly long, pre-2022 human text. I found no independent FPR measurement on casual social posts or non-native writers for Pangram or GPTZero. [Liang et al. 2023](https://arxiv.org/abs/2304.02819): seven detectors flagged 61% of 91 TOEFL essays as AI (97.8% flagged by at least one); those detectors predate today's. A 2026 Czech study reports no systematic bias for modern detectors (abstract only, not English). OpenAI's own classifier launched at 26% TPR / 9% FPR and was [withdrawn in 2023](https://searchengineland.com/openai-ai-classifier-no-longer-available-429912).
- **Evasion works at a cost.** StealthGPT (Chicago): Pangram stayed robust, Originality missed up to 21% of short texts, GPTZero 50%+. Few-shot style imitation (Epoch): 10–18% evaded; scientific-style imitation 24–29%. Pangram's own [DAMAGE paper](https://arxiv.org/abs/2501.03437) (V) says GPTZero catches only 35–60% of humanized text. An [anecdote](https://www.lesswrong.com/posts/hrpQxfYvF6CBGWfJX/pangram-ai-detection-software-can-be-evaded) beat Pangram 3.2 by iterating; an agent with API access can do the same. Expect a deterrent against copy-paste, not against a determined user.
- **Could not verify:** GPTZero price, min length and response fields; Pangram API retention/minors terms and latency; privacy terms for Sapling, Originality, Winston, Copyleaks; any Pangram RAID result (it is not in the paper); RAID Table 6 row labels (I matched rows to detectors using the paper's own text); Workers AI logprobs.

## The base-rate math
Assumptions (mine, from the sources above): Pangram catches 90% of AI posts (TPR) at a strict threshold; GPTZero 80%. Planning FPR: Pangram 0.5% (Chicago short-text <= 0.75%; Epoch's 0 of 495 only bounds it below 0.6% at 95%), range 0.1–2% (2% is Russell); GPTZero 1%, range 0.3–2.5%. pi = share of scanned posts that are AI. PPV = share of flags that are truly AI.

| Option (TPR / FPR) | PPV at pi=1% | pi=5% | pi=20% |
|---|---|---|---|
| Pangram 0.90 / 0.1% | 90% | 98% | 99.6% |
| Pangram 0.90 / 0.5% | 65% | 90% | 98% |
| Pangram 0.90 / 2% | 31% | 70% | 92% |
| GPTZero 0.80 / 0.3% | 73% | 93% | 98.5% |
| GPTZero 0.80 / 1% | 45% | 81% | 95% |
| GPTZero 0.80 / 2.5% | 24% | 63% | 89% |

Expected false flags for one human who posts n scanned items (binomial; in brackets: chance of >= 1 / chance of >= 5):
| FPR | n = 100 | n = 500 | n = 2,000 |
|---|---|---|---|
| 0.1% | 0.1 (9.5% / 0%) | 0.5 (39% / 0.02%) | 2.0 (87% / 5.3%) |
| 0.5% | 0.5 (39% / 0.02%) | 2.5 (92% / 10.8%) | 10 (100% / 97%) |
| 1% | 1.0 (63% / 0.3%) | 5.0 (99% / 56%) | 20 (100% / 100%) |

- Strikes expire after 90 days, so exposure is items scanned per 90 days. 500 posts a year is about 125 per window: at 0.5% FPR, P(>= 1 false warning) = 47% and P(>= 2, a false timeout) = 13%; at 0.1%, 12% and 0.7%.
- Errors are not independent across one person's posts. Formulaic, polished or non-native writers get flagged repeatedly (Liang), so risk concentrates on specific people and the ladder could walk them to step 5. The table understates it for them.
- The true pi is unknown. If it is 1–5% (a human-first network), 1 in 3 flags at pi=1% is wrong even for the best option. Step 1 must stay a harmless warning; later steps need a stricter bar.
- Levers: higher threshold, longer minimum length, scanning only a share of posts (25% sampling cuts exposure 4x), one strike per 24h, exemption after an upheld appeal.

## Recommendation
**Provider.** Pangram as primary, behind an adapter: `detect(text) -> { score: number /* 0..1, higher = more AI */, model: string /* "pangram:pangram-4" */, raw: unknown }` (optionally `words`, `costUsd`, `label`). Pangram maps `score = fraction_ai`, `label = prediction_short`; pin the `model` param (v3 was deprecated 2026-09-30, so versions churn). Why: the only option with near-zero independent FPR on short text at pay-per-use pricing, cheapest per true positive in Chicago, and Chicago, Epoch and Russell agree it ranks first or tied. Fallback: GPTZero behind the same interface, built and tested during evaluation; enable if Pangram is down more than 24h, changes terms, or once volume (about 1,000+ members) justifies its plan, then use it as a second opinion before any timeout. Rejected: Originality (API only $179/mo), Sapling alone (no evidence), Copyleaks/Winston/Hive (unverified), self-hosting (no Workers AI path).

**What gets judged.** Clean text first: strip quotes, code, URLs, @mentions, emoji, markdown and zero-width characters; map look-alike (Cyrillic/Greek) letters back to Latin before scoring, since homoglyphs wreck some detectors; require English (cheap language-id; skip otherwise).
| Type | Minimum to score | Notes |
|---|---|---|
| Blog post | 150 words (~900 chars) | score one 300-word window (hash-chosen, unpredictable) to cap cost at $0.15 |
| Forum thread opener / comment | 100 words (~600 chars) | same cap |
| Friends' Comment | 100 words (~600 chars) | rarely qualifies |
| Status (<= 500 chars, <= ~85 words) | never alone | below Pangram's 50-word floor and below any length with solid evidence |
Optional phase 2 for short-form: weekly score of a member's last statuses/comments joined to >= 150 words, feeding a moderator queue only (no auto strike) until evaluated.

**Threshold and strikes (starting values, the evaluation overrides them).** Strike only if `label == "AI"` and `fraction_ai >= 0.95`. "Mixed" and "AI-Assisted" never strike (Grammarly, translation, LLM-polished ESL writing). A strike is one per 24h incident (several flagged items in 24h count once). Only scan within 7 days of posting; never re-scan old posts after a model upgrade; allow 3 rescans per edited post. Notice and appeal view show the flagged text, a coarse label ("very likely AI") and the score, with wording that this is an estimate. Upheld appeal: strike deleted, 180-day "verified human" exemption from auto-strikes (scores still logged), text added to our human test set with consent.

**Caching, async, failure.**
- `ai_scan(text_hash PK, provider, model, score, label, raw_json, words, cost_usd, created_at)`; hash = SHA-256 of cleaned, NFKC-normalised, whitespace-collapsed text. Reuse a hit for 90 days or until the model version changes. Saves edits that leave cleaned text unchanged, cross-posts and quote-replies (a few percent; assumption).
- Never block posting. Publish, insert a D1 `scan_job`, drain with a Cron Trigger (or Queue). 10 s timeout; retry at 1m, 5m, 30m, 6h, then give up at 24h.
- Fail open. Any 4xx/5xx, timeout, 402 (no credits) or 429 leaves the post live and the job `deferred`; circuit breaker after 5 straight failures pauses 10 min. No strike ever comes from a failed, partial or stale scan.
- Budget guard `AI_SCAN_BUDGET_USD` per month in D1: at 80% raise the sampling threshold, at 100% pause scanning, alert the owner.
- Sampling by `hash(post_id) mod 100`: new accounts (< 30 days) 100%, others 50%, long-clean members (>= 20 clean scans, no strike for 180 days) 20%. Members cannot tell which posts are scanned. Scores are shown only in strike/appeal notices; limit rescans to 20/day/member to blunt probing.
- Optional cost lever: Sapling as a triage filter ahead of Pangram, only if the evaluation shows >= 95% recall at <= 30% flag rate.

**Monthly cost** (assumptions: 30% of members active; ~300 eligible words per active member per month after the 300-word cap, so 90 words per registered member; Pangram at list price, no volume discount; GPTZero $45 plan + $0.15/1k over 300k; Sapling at 6 chars/word; Workers/D1/R2 excluded; volume uncertainty about 3x either way).
| Members | Eligible words/mo | Pangram 100% | Pangram 25% sampled | GPTZero 100% | Sapling 100% |
|---|---|---|---|---|---|
| 300 | 27k | $13.50 | $3.38 | $45 (plan min) | $0.81 |
| 3,000 | 270k | $135 | $33.75 | $45 | $8.10 |
| 30,000 | 2.7M | $1,350 | $337 (about $68 at 5%; ask for volume pricing) | $405 | $73 |
Budget reality: [004](004-cloudflare-limits-and-costs.md) already puts Workers Paid at $5 and the whole site near $5.84 at 100 active members, so detection fits about $3.40/month at launch: 25% coverage at 300 members, spent on new accounts and blogs first. Full coverage needs about $13.50/month. Either raise the budget, accept partial coverage, or scan long-form only.

**Privacy-policy wording (draft, needs counsel).** "To enforce our rule against AI-generated content, blog posts, forum posts and comments, and Friends' Comments of [100]+ words may be sent, without your username or other identifiers, to a third-party AI-detection service (currently Pangram Labs, Inc., United States). It returns a likelihood score. We store the score, a hash of the text, and the provider and model version; if a strike is issued we also keep a copy of the flagged text for [N] days so you and moderators can review it. We never send private messages or chat. Our provider may not use your text to train models [confirm in a DPA]. Scores are estimates and can be wrong; automatic action never exceeds a one-month posting timeout, every strike can be appealed to a human, and strikes expire after 90 clean days. Members aged 13–17 are treated the same way." Before launch: written confirmation from Pangram on API retention, zero-retention option and minors' text; a DPIA-style note for EU/UK members (Art. 22 automated decisions: we keep a human appeal); update ToS to define the rule and say detection is not a guarantee.

## Evaluation plan before launch
Run every set through the exact Worker pipeline (cleaning, length buckets 50–99 / 100–199 / 200–499 / 500+ words), for Pangram and GPTZero.
| Set | n | Source |
|---|---|---|
| H-own | owner's two essays | known human; chunked, but only 2 authors, so a sanity check, not a statistic |
| H-pre22 | >= 1,500 | public human text written before 2022 matched to post types (blogs, forum/Q&A comments, reviews, essays); check licences; overlap with vendor training data possible |
| H-nn | >= 300 | non-native English: TOEFL/ICNALE/ELLIPSE learner corpora plus fresh 100–300-word posts from 20–30 consenting non-native volunteers |
| H-fresh | >= 300 | posts written in 2026 by 50+ real people with no AI, casual register (modern humans have absorbed LLM style) |
| A-plain | >= 600 | AI posts from >= 5 current models (closed and open-weight) x 3 prompt styles (plain, casual with typos, "teen on a social network") |
| A-evade | >= 300 | self-"humanize" prompts, style imitation from 5 samples, second-LLM paraphrase, 2–3 commercial humanizers (StealthGPT, Undetectable.ai, QuillBot), human-edited AI drafts |
| A-assist | ~100 | human drafts polished by an LLM or Grammarly, to see how "assisted" scores |
- Metrics, per length bucket and group: FPR with Clopper-Pearson 95% CI (the upper bound is what counts), TPR with CI, ROC, PPV at pi = 1/5/20%, score histograms, and whether the two vendors' false positives overlap (decides if two-detector confirmation helps).
- Sample size: with 0 false positives in n human texts the 95% upper bound is about 3/n: 300 texts prove <= 1%, 3,000 prove <= 0.1%. So plan >= 300 human texts per bucket.
- **Pass bar** (all at the chosen threshold): FPR upper bound <= 1% in every strike-eligible bucket on H-pre22 + H-fresh, <= 2% on H-nn alone; point FPR <= 0.2%; zero flags on H-own; TPR >= 80% on A-plain, and publish the A-evade rate (if < 50%, say publicly it is a deterrent). A bucket that fails gets a higher minimum length or leaves enforcement.
- Cost: about 3,100 passages x 150 words = 465k words, about $230 for Pangram at list price (one $65 Pro month bundling $200 credits may cover it; rollover unverified) and about $70 for GPTZero. Ask both for research or trial credits.
- After launch: 2–4 weeks in shadow mode (score everything, no strikes); moderators blind-review the 100 top-scored and 100 random unflagged items to estimate live pi and FPR; only then enable the ladder. Then a monthly audit, and a kill switch if more than 10% of strikes are overturned on appeal. Re-run the evaluation on every provider model change.

## Open questions for the owner
1. Is AI-assisted writing (Grammarly, translation, LLM-polished drafts by non-native speakers) allowed? My default: only fully AI text earns a strike.
2. Statuses (<= 500 chars) and most comments cannot be judged alone by any tool I found. Accept that, or fund the phase-2 aggregate scoring?
3. Budget: about $3.40/month buys 25% coverage at 300 members; about $13.50 buys all of it. Which? Or long-form only?
4. Even in the best case, heavy posters will sometimes get a wrong warning (tables above). Is a wrong first warning acceptable if appeals are fast? Who staffs them, and what is the response time?
5. Exemptions: moderators, long-tenured members, anyone with an upheld appeal?
6. Is bot spam the real problem? Rate limits and new-account throttles have zero false positives and may do most of the work.
7. Show members a coarse label only, or the numeric score? A number helps appeals and also helps evaders tune.
8. Legal: members 13–17 and EU/UK members have text processed by a US vendor; is counsel review before launch agreed?
9. Publish the aggregate appeal-overturn rate for transparency?
