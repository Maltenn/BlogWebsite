# The AI-writing detector's evaluation corpus

`tools/eval-detector.mjs` runs the configured detector (`AI_DETECTOR`) over every text here and decides whether
`AI_ENFORCEMENT=enforce` may be switched on: the upper end of the 95% interval of the false-positive rate on human
text must be at or under 1% (docs/deploy.md).

```bash
AI_DETECTOR=mock node tools/eval-detector.mjs            # the pipeline, with the pretend detector
AI_DETECTOR=gptzero GPTZERO_API_KEY=… node tools/eval-detector.mjs
node tools/eval-detector.mjs --json                      # every text's score, for a spreadsheet
```

One text per file, plain UTF-8. Each goes through the same cleaning and length rule as a post on the site
(`src/ai/clean.js`): 100 words at least, 150 for files whose name starts with `blog-`; shorter ones are listed as
skipped.

## What's here (the starter corpus)

| Folder | Files | Source | Licence |
|---|---|---|---|
| `human/owner-*` | 28 | malten's two essays (`public/blog/`), cut into ~150-word chunks at sentence ends | the owner's own writing, used with his permission for this purpose |
| `human/pd-*` | 3 | the Gettysburg Address (1863), the opening of the Declaration of Independence (1776), a passage of Thoreau's *Walden* (1854) | public domain |
| `ai/*` | 10 | written by an AI model (Claude, October 2026) for this corpus, in several registers: a formal essay, forum advice, a product review, an explainer, a reflective blog post, a listicle, casual and teen-voice statuses, a forum comment, and a "humanized" casual one without the usual tells | AI output, no rights claimed |

That's a sanity check, not a statistic: two human authors, and old public-domain text a vendor may have trained on.
With 31 human texts the false-positive interval can't get under about 11%, so the harness **always fails** on this
corpus. It's here so the pipeline runs end to end.

## Growing it to a real test (decision 002's plan)

- **300+ human texts per length bucket** prove ≤ 1% with zero false positives (the upper bound is about 3/n); 3,000
  prove ≤ 0.1%. Prefer writing like OurSpace's: casual posts, forum comments, reviews, short blog posts.
- **Fresh human writing** from 2026 (people who've absorbed LLM style), and **non-native English** writers (learner
  corpora such as ICNALE or ELLIPSE where the licence allows, or volunteers), since detectors misfire most on them.
  Only with the writers' consent; never members' posts without it.
- **AI texts from several current models** and prompt styles (plain, casual with typos, "a teen on a social network"),
  and evasion attempts (paraphrased, "humanized", human-edited AI drafts): file them under `ai/` with a prefix saying
  which (`evade-…`), and report their catch rate separately.
- Keep each file's origin and licence in this table (or a `SOURCES.md` beside it). Don't commit texts you may not
  redistribute: keep a private corpus outside the repo and run `node tools/eval-detector.mjs --dir <folder>`.
