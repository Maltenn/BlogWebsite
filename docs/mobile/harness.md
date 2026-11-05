# The plate harness

`docs/mobile/contract.md` says the apps bundle `public/` byte for byte, so the aesthetic is identical by
construction. The harness is what turns that sentence into a number. It photographs every client route in both
engines the apps will run on, freezes everything that moves, and keeps the pictures (the **plates**) in git. Anything
an app shell later renders is diffed against them, pixel by pixel.

| engine | stands in for |
| --- | --- |
| `chromium` | the Android WebView |
| `webkit` | iOS WKWebView |

Four viewports: `390x844` (phone), `430x932` (large phone), `768x1024` (tablet), `1280x900` (desktop). The three small
ones are emulated as touch phones (`isMobile`), at device scale factor 1.

## Running it

```
npm run plates                  capture all plates into plates/, then capture them all again to prove they repeat
npm run plates:check            capture the current web build NOW, the same way, and diff it against the plates
npm run plates:check -- --candidate DIR     diff PNGs an app shell produced against the plates

npm run tabbar:check            the OTHER harness: the native tab bar's spec against the web bar, at 0 pixels
                                (see "The other instrument" below; runs in CI, unlike the plates)
```

Both need Chromium and WebKit installed once: `npx playwright install chromium webkit`.

**The plates are in Git LFS** (`.gitattributes`: `plates/**/*.png filter=lfs diff=lfs merge=lfs -text`; 464 PNGs, about 74 MB).
A fresh clone needs the LFS client (`git lfs install` once per machine) and then `git lfs pull` before `plates:check` can work.
The failure to recognise: **every plate looks corrupt**. A clone without the LFS objects has ~130-byte text pointer files
(`version https://git-lfs.github.com/spec/v1`, an `oid sha256:` line and a `size` line) where the PNGs should be, so `pngjs`
throws "Invalid file signature" on the first plate it reads, and a CI checkout without `lfs: true` fails the same way. It is not
a pixel problem and nothing is missing from the manifest: run `git lfs pull`. Only `plates/**/*.png` is in LFS; `manifest.json`
is ordinary text, and `plates/diff/` is git-ignored. **No CI job runs the plates today**, deliberately: the baseline was
rendered on Windows with its fonts and engine builds, so a Linux runner would fail every plate; a run takes about 11 minutes
with both engines installed; and each run would pull 74 MB of LFS bandwidth. Any job that is ever added must use
`actions/checkout` with `lfs: true` (the note is in `.github/workflows/mobile.yml` too). Until then, run `npm run plates:check`
on a machine before merging anything that touches `public/`.

`npm run plates` is slow on purpose (two full passes). Slices for day-to-day work:

```
node tools/plates.mjs --engines webkit --viewports 390x844 --routes home,login --no-verify
```

A slice updates only its own entries in `plates/manifest.json`. Options: `--engines`, `--viewports`, `--routes`,
`--states` (`out`, `in`, `admin`), `--jobs N` (parallel browser contexts), `--scale N` (device scale factor),
`--max-height PX`, `--url URL` (use a site that is already running), `--reuse` (use one at 127.0.0.1:8787 if there is
one), `--no-verify`, `--headed`.

### The site it photographs

Not your `.demo/`. The harness makes a pristine seed once (`.plates-work/seed/`, the same sample people and posts as
`npm run demo`), and every pass runs a **throwaway copy** of it. Visiting pages and signing in changes a database
(read markers, last seen), so a baseline cannot be allowed to depend on what you clicked yesterday. Delete
`.plates-work/` to make a new seed; that is a re-baseline (see below). `--url` points it at any running site instead;
the repeat run is skipped then, because a live database cannot be reset.

Parameterised routes (`/u/:name`, `/u/:name/post/:id`, `/boards/:slug/:id`, `/tags/:tag`, `/messages/:id`,
`/horoscope/:sign`, the blog) get their values from the API by rule (the best-dressed member, the busiest status, the
busiest board and thread…), so the harness survives a reseed. The chosen values are in `manifest.json` under
`params`. The route table is checked against `ROUTES` in `public/app.js` on every run: a route added or removed there
fails the harness loudly instead of going unmeasured.

## What is frozen

| thing | how |
| --- | --- |
| the clock | `Date` is fixed at the instant of the seed plus five minutes, derived from the data, so "3m ago" and the horoscope's date read the same in any seeded database. Timezone UTC, locale en-US. |
| animated GIFs | every `.gif` response is cut down to its first frame before the page sees it (avatars, badges, CSS background tiles alike) |
| CSS animations and transitions | paused at their first frame, transitions off, text caret hidden |
| `Math.random` | a fixed-seed generator |
| the layout | the settled page is put through a fixed two-step re-layout (see "Load sensitivity"), so WebKit's image-arrival-order layouts cannot differ between runs |
| the photograph itself | taken repeatedly until three in a row are identical, 350 ms apart; a page that never agrees is retried, then recorded as an error |
| live rooms | the `/api/live/*` WebSocket is answered by the harness (one presence frame naming the viewer, then silence); no real room is contacted |
| writes | every non-GET request is refused with a 403 except two idempotent ones (`POST /api/verify`, `POST /api/chats` for an existing DM), so no plate changes the database |
| third parties | any request that leaves the site is aborted. Cloudflare's Turnstile script is replaced by a stub that draws nothing and answers at once, and the sign-up form's proof-of-work solver (`/js/widgets/pow.js`) by one that answers at once, so the "checking you're a person…" line settles on "✓ checked" instead of a percentage (WebKit on Windows takes a minute to count). The words and layout are the page's own. |
| lazy images, fonts, loading states | the capture waits for them |

Each plate is the whole page, capped at 4000 px tall, saved as a PNG whose bytes depend only on its pixels (so
`sha256` in the manifest changes only when a pixel does).

`out` = signed out, `in` = the demo member `the_reviewer`, `admin` = the demo moderator `malten` (only for `/admin`).
A route that needs an account is captured signed in only; a guest-only route (Join, Log in…) signed out only.
Plates are named `plates/<engine>/<viewport>/<route>--<state>.png`; that name without `.png`, plus engine and
viewport, is the key a candidate is matched by.

### Determinism is checked, not assumed

After the capture, the whole thing runs a second time against a fresh copy of the database and every plate is
compared exactly (any channel of any pixel). The per-engine result goes into `manifest.json` under `determinism`. If
anything differs the run prints a loud banner with per-route pixel counts, puts diff images in
`plates/diff/determinism/`, and exits with status 2. **Do not commit a baseline that failed that check**; a flaky
baseline makes every later failure meaningless.

## Comparing: `pixeldiff`

```
node tools/pixeldiff.mjs [--candidate DIR] [--threshold 0.1] [--engine E] [--viewport V] [--route R] [--all]
```

Candidates are matched to plates by the manifest's keys:

```
DIR/<engine>/<viewport>/<route>--<state>.png          e.g.  DIR/webkit/390x844/home--in.png
DIR/<viewport>/<route>--<state>.png                   with  --engine webkit
```

An app shell's capture should navigate to `path` for that key (in `manifest.json`), freeze the world the same way
(`freezeContext()` and `settle()` are exported from `tools/plates.mjs` for scripts that drive a browser; a shell
driving a simulator must at least pin the clock to `freeze.now`, strip GIF animation and stop CSS animation), and save
the full page as a PNG at the same CSS width.

The table lists every plate that differs, with pixel count and percentage of the canvas; `--all` lists the rest.
Diff images (changed pixels in red) go to `plates/diff/<engine>/<viewport>/…` (git-ignored); `plates/diff/report.json`
has the numbers.

**Thresholds.** `--threshold N` is the percentage of the canvas that may differ before a plate fails (default
`0.1`, one pixel in a thousand). It is deliberately small. A plate of two different sizes compares the union of both
canvases, so a page that is a few rows taller fails on the extra rows. A missing candidate is a failure unless
`--allow-missing`. `--sensitivity N` (default `0.1`) is pixelmatch's separate per-pixel colour tolerance, which
forgives imperceptible colour noise and, by default, anti-aliased edges; `--strict` sets it to 0 and counts
anti-aliasing. Exit status 0 means every plate is within threshold; 1 means something is over, missing, or the run
failed.

What a non-zero number means: the bundled `public/` is the same bytes, so a difference means the shell changed how
it is rendered (a viewport meta, safe-area padding, a different font, a status bar covering the header, a missing
resource). Those are real findings. Each one is either fixed or recorded in `docs/mobile/deviations.md`, never
silently accepted by raising the threshold.

**Fonts.** Plates are rendered by this machine's Chromium and WebKit with this machine's fonts. A device renders
with its own system fonts, so a candidate from a real iOS or Android device is not expected to match to 0.1%. Compare
shells against plates from the same engine and platform class, or set a per-shell threshold and write it down in the
deviation register; do not loosen the default.

## Load sensitivity: the instrument had a flake, and what it was

Symptom (the owner's run, with other work on the machine): `npm run plates:check` came back 462/464 identical, with
`webkit/430x932/edit--in` **failing at 0.161% (1,934 px)** and `webkit/1280x900/edit--in` at 0.091%, just under the line. Re-capturing
that plate alone, three times, gave 0 px every time. So: not a regression, a **load-sensitive capture**. The determinism check
(`npm run plates`) could not see it, because both of its passes run under the *same* load.

Reproduced on purpose by saturating the machine (14 busy-loop threads on 16 logical cores, plus ~200 MB of memory churn; CPU at 100%):
`plates:check` with the default 4 jobs came back 463/464 identical,
`webkit/1280x900/edit--in` differing by 1,519 px (0.066%). A 12-visit loop of the same page in one context, four viewports, found
12 odd captures in 48 visits (one in four), of several kinds.

**Cause: WebKit does not lay the page out the same way when its images arrive at different times.** In the decor picker on `/edit`
(`.cz-gif { height: 54px; display: flex }`, `.cz-gif img { max-width: 100%; max-height: 100% }`) the pictures end up at 46x46, 46x54 or
58x58 px depending on which images were already cached when the layout ran, which depends on machine load and on what the same
browser context loaded before it. The page was settled in every case (`img.complete`, decoded, eager, four identical polls); it is a
stable but different layout, not a half-drawn one. That is why waiting longer did not cure it and why a single re-capture was clean.
The 46x46 layout is the one a *from-scratch* layout does **not** produce (it gives 58x58) and an *incremental* one does, and it is
the one the plates were taken in and the one all but the odd captures show.

**The fix is in the instrument, not the threshold (still 0.1%):** `settle()` now

1. requires **8** identical 250 ms polls (was 4), and the signature includes the box of **every** image and the document width;
2. decodes every image twice and waits for fonts, then **normalises the layout**: drops the render tree and rebuilds it (a layout
   that forgets history), then takes every image out of layout and puts it back (an incremental layout, a deterministic function of
   the first) before the animations are frozen. From any starting layout this ends in the same one, the one in the plates;
3. waits 1 s untouched after the last thing it does to the page (WebKit redraws a scaled image smooth only after about 500 ms without
   a repaint, and under load that timer is late);
4. and `shoot()` now accepts a plate only after **3 identical photographs in a row**, 350 ms apart (was: two equal in a row, so two
   equal *rough* frames passed), and throws if 16 photographs never agree, so the capture is retried and in the end recorded as an
   error rather than as a flaky plate.

**The live rooms.** `context.route()` does not intercept WebSockets (`routeWebSocket` is a separate API), so `ourspace--in` and
`messages-chat--in` used to be photographed with a real socket to the throwaway Worker in them: the nick list and "x is typing"
arrived on one-second server timers (`PRESENCE_MS`, `TYPING_MS` in `src/live/room.js`), and the room allows only five sockets per
member (the oldest beyond that is closed with "open in too many tabs"), a limit that parallel contexts signed in as the same member,
plus retries, can reach. `freezeContext()` now routes the `/api/live/*` socket itself: it opens, hears one
`presence` frame naming the viewer (what the room sends a newcomer when nobody else is there, which is always so in a plate), and
then nothing. No real room is contacted. This changed **no pixel**: the new capture of both plates is identical to the plates that
were taken with the real socket (0 px under load), so nothing was re-baselined for it.

**Proof, under deliberate load** (CPU at 100% for the whole run; every run is the
full `npm run plates:check`, 464 plates, both engines, four viewports):

| run | code | result |
|---|---|---|
| 1 | before the fix, `--jobs 4`, CPU 100% | 463 identical, `webkit/1280x900/edit--in` **1,519 px (0.066%)**; 13 min |
| 2 | after the fix, `--jobs 4`, CPU 100% at the start (the load generator may have ended part-way) | **464 identical, 0 px everywhere**; 18 min |
| 3 | after the fix, `--jobs 6`, load restarted, CPU 100% at the start and at the end | **464 identical, 0 px everywhere**; 15.5 min |
| 4 | after the fix, quiet machine, default jobs | **464 identical, 0 px**; 10.8 min |

The sequence loop above (12 visits of `/edit` at each of four viewports, under the same load) gave 12 odd captures of 48 before and
**0 of 48** after, and every capture after the fix is byte-identical to the majority capture before it, i.e. to the plates.
The cost in time is small: a quiet run took 10.8 minutes (it was about 11), the loaded ones 13 (before) and 15.5-18 (after). Do not trade the
constants at the top of `settle()` for speed without repeating this test.

**What this does not prove.** It proves the capture is stable under load, not that the *page* is. The page itself renders in three
different layouts in WebKit depending on image arrival order, so a real iPhone can show any of them on any launch. The apps are
compared to the plates at 0.1% of the canvas, and this one region is 0.07-0.16% of it on a phone, so an app capture of `/edit` can
differ for this reason alone. The cure is in `public/app.css` (give `.cz-gif img` a definite size instead of percentage maximums);
it is not a harness problem, and `public/` is not touched here.

## The baseline used to expire by itself

Worth reading before you trust a green run, because this one was invisible from the browser.

On 2026-11-05 a full `plates:check` failed **48 of 464** against a baseline taken on 2026-10-31,
with nothing in the site changed. Six keys, across both engines and all four viewports:
`horoscope--in/out`, `horoscope-sign--in/out`, `home--in` and `ourspace--in`.

`context.clock.setFixedTime` freezes the **browser's** clock. It cannot touch the **Worker's**, and
two routes are computed from it:

- **The horoscope.** `dayOf` in `src/horoscope/horoscope.js` reads `c.now`. The page does send the
  frozen date (`/astro/sky?` + `today()`), but `localDay` in `src/shared/astro.js` throws away a
  client date more than **2.5 days** from the server's own — a fair guard against nonsense input.
  So the freeze worked, and then quietly stopped working two days later. `home--in` is in the list
  only because the home page carries a horoscope teaser (`home.js:39-43`) that calls `/astro/me`.
- **#ourspace.** `WINDOW` in `src/chats/ourspace.js` keeps `m.created > c.now - KEEP_MS` (24 hours).
  The seeded messages aged out of it. The log's scroll pane has a fixed height, so the page did not
  even change size when they went — which is why that plate showed ~6,000 changed pixels with
  identical dimensions.

A gate that turns red on its own is worse than no gate: the obvious response is to re-baseline,
which bakes in that day's content and breaks again tomorrow.

**The fix.** `tools/fixtures/server-clock.json` holds those 15 answers, captured once from a freshly
seeded demo, and `freezeContext` serves them from the catch-all route before anything reaches the
Worker (`FROZEN_API` in `tools/plates.mjs`). Shifting the seed's timestamps instead cannot work: the
server wants messages inside 24 hours of the *real* clock, while the browser renders their absolute
times, so the pixels drift whichever way you lean.

**What it costs.** Those plates now check the pages' **layout**, not that the astrology or the chat
query is right. Same trade the harness already makes for Turnstile and the proof of work. Changing
the fixture means deliberately re-baselining `home`, `horoscope`, `horoscope-sign` and `ourspace`.

### A fractional pane, and 26 pixels

Fixing the clock left one flake: `webkit/390x844/ourspace--in` differed by **26 px (0.008%)** between
two passes of the same run. The diff image was the clue — scattered single pixels down the message
rows, not a displaced block, which says *same layout, wrong subpixel origin*.

`.ms-irc-log` is `height: min(60vh, 540px)`. At 390x844 that is **506.4px**; every other viewport
clamps to a flat 540. Scrolling to the newest message therefore left the text on a fraction of a
pixel, and WebKit rasterised it differently from run to run — at that one viewport and no other.

`settle()` now rounds `scrollTop`/`scrollLeft` on anything that has scrolled, and leaves anything
that has not alone. `.ms-chat-log` (`min(56vh, 520px)` = 472.6px at that width) had the same trap.
The site keeps its fractional heights, which are fine for real people; the instrument absorbs it.

### And one more: the port was printed on the page

The clock fixes left 64 plates *within* threshold instead of identical — all eight `profile*` keys,
across both engines and all four viewports, at 0.003%. This document said, for a few hours, that
this was "cross-run text antialiasing while other work shares the machine". **That was wrong**, and
it was a guess rather than a measurement: the explanation was never checked against which plates
were actually in the set, and antialiasing scatters while these did not.

The real cause, found by measuring the diffs rather than reasoning about them: `startSite()` takes
the first free port from 8810, and the profile page prints its own address —
`location.origin + userPath(u.name)` in the "OurSpace URL:" box
([`public/js/pages/profile.js:124`](../../public/js/pages/profile.js)). When 8810 is busy — a second
capture, a dev server, another person on the machine — the run gets 8811, and **one digit of one
glyph** changes. The diff image is a single 5x6 cell, every time, at the same x. Eleven to twenty-six
pixels is about 100x inside the 0.1% bar, so it passed for weeks.

The lesson is worth more than the bug: **"0 over threshold" and "464 identical" are different
claims, and only the second one means nothing moved.** Read the `identical` column, not just the
exit code. A diff that is always the same tiny box is a constant leaking into the page; a diff that
scatters is the renderer.

`settle()` now rewrites the live origin to a canonical `http://127.0.0.1:8810` in every text node
before the shot. Both are four digits, so nothing reflows — and if the harness ever ran on a port of
a different width the text would change length, which would show up as a real diff instead of
hiding. The eight `profile*` keys were re-baselined once with that in place.

### Where it stands

464 plates, **464 identical**, 0 px, after the clock fixture, the scroll pinning and the canonical
origin. The same-run determinism check also reports 0 px.

## What the plates do not prove

"464 plates at 0 pixels" proves one thing: this harness, on this machine, photographs the **website** the same way twice. It says
nothing about the apps beyond that, and the limits below are real. They were found by a red-team pass
([redteam.md](redteam.md), "The pixel claim") and are recorded here so nobody reads the number as more than it is.

1. **`isApp === false` in every plate.** The harness loads the site in a plain browser, so `public/js/core/native.js` exports
   `isApp = false` and none of its app-only behaviour runs: `patchNetwork`, `patchMedia`, `wireClicks`, the viewport rewrite (D5)
   and, above all, **D21**: in the apps every `/media/` image is first a 1px transparent placeholder and then a `blob:` URL, with a
   40-blob / 24 MB cap and revocation on page leave. That is the largest rendering change the apps make, and it appears in **zero**
   plates. A regression in it (a photo that never swaps, a flash of empty boxes, a leaked blob) cannot show up here. It needs a
   test that runs `native.js` with `isApp === true` against the real site in WebKit and Chromium (the bridge tests do run it, but
   in Chromium only, against a fake API, and assert behaviour rather than pixels), or a simulator capture fed to
   `pixeldiff --candidate`.
2. **Anything below the 4000 px clip is never compared.** `shoot()` caps a plate at `--max-height` (default 4000). Routes taller
   than that, notably `boards-thread` (chosen as the *busiest* thread), `profile` and `ourspace`, are compared for their top 4000 px
   only; a broken footer, or the last 40 messages, can change freely. On a 390-wide plate 0.1% of 390x4000 is about 1,560 pixels,
   so a shifted line of 12 px text or a missing 1 px border can also hide under the threshold on a long page. The cap exists to keep
   the PNG set small; it is a coverage gap, not a feature.
3. **`ourspace--in` and `messages-chat--in` had a real socket in them.** Playwright's `context.route()` does **not** intercept
   WebSockets (`routeWebSocket` is a separate API), so the first harness let the page connect to the throwaway Worker for real: the
   nick list and "x is typing" arrived on one-second timers (`PRESENCE_MS`, `TYPING_MS` in `src/live/room.js`), racing the
   capture (and parallel contexts signed in as the same member share the room's five-sockets-per-member limit). Two clean passes were
   two samples of a race.
   **Fixed:** `freezeContext()` now routes the live-room socket itself (see "Load sensitivity", "The live rooms"), so those two plates
   no longer depend on a server timer; the new capture is pixel-identical to the old plates.
4. **The first screen a reviewer sees is partly absent.** Turnstile's script is replaced by a stub that draws nothing and the
   proof-of-work solver answers instantly (both listed under "What is frozen"), so the real Cloudflare widget's iframe is in no plate.
   A layout break caused by it, or by `frame-src https://challenges.cloudflare.com` behaving differently under the app's *meta*
   CSP than under the site's header CSP, is invisible by construction.
5. **The fonts are this machine's** (see "Fonts" above), so a device capture is never expected to match the plates to 0.1%.
6. **The throwaway server's port used to be baked into the plates — now fixed, and worth knowing about.** The profile
   page prints its own address in the "share this page" box, so whichever port `startSite()` landed on was captured
   into the 64 `profile*` plates; a collision on 8810 moved one digit and they came back not identical, but still
   passing, at ~100x inside the threshold. `settle()` now rewrites the origin to a canonical one before the shot (see
   "And one more: the port was printed on the page" above). Keep the habit it taught: **read the `identical` column,
   not just "0 over threshold"**, and treat a diff that is always the same small box as a constant leaking into the
   page rather than a rendering difference.

## The other instrument: `tabbar-check`

`npm run tabbar:check` (`tools/tabbar-check.mjs`) is a separate, smaller harness, and it answers a question the plates
cannot: **is the native tab bar the same bar as the web one?** (deviations.md D3, D22.)

The apps do not screenshot the web bar and they do not hard-code its metrics. `public/js/core/tabspec.js` measures the
live `.ms-tabs` — every rectangle, colour, font list, string, text origin and baseline — and the shells draw exactly
that. So "does the native bar match?" splits in two:

| Question | Instrument | Where it stands |
|---|---|---|
| Is the measurement a complete description of the web bar? | `tabbar-check`: rebuild a bar from nothing but the spec (absolutely positioned boxes, text on the spec's baselines) and pixel-diff it against the real `.ms-tabs` | **48/48 cases at 0 pixels** — chromium and webkit, the four plate viewports, six item sets |
| Does the shell put those rectangles and strings where the spec says? | a device. `UIControl.draw` with Core Text, `Canvas.drawText` with a `Paint` | **unverified.** Checklist 23 is where it gets checked |

Two things it does differently from the plates, both deliberate:

- **It is machine-independent.** It compares two renders made in the *same* browser on the *same* machine, seconds
  apart, so it does not depend on which fonts this Windows box has. That is why it runs in CI (the `bridge` job) and
  the plates do not.
- **The threshold is zero, not 0.1%.** There is no reason to allow any difference: both images come out of the same
  rasteriser. It has already earned that: rounding the measured positions to two decimals, which looked harmless,
  moved `Boards` from 145.359375px to 145.36px and changed its antialiasing — 98 differing pixels in one word, on one
  engine, at one viewport. Six decimals, and 0.

What `tabbar-check` does **not** prove, said plainly: that iOS and Android rasterise those glyphs the same way their
web views do. The layout cannot drift — every box position is measured, not computed natively — so a font mismatch
could only ever show up *inside* a measured box, as different glyph shapes, never as a shifted or wrongly sized bar.
That is the smallest version of the risk this design could leave behind, but it is not zero, and only a phone closes
it.

## Re-baselining on purpose

The plates are the artifact: they are tracked in git and `plates/diff/` is not. Re-baselining means saying "the
site now looks different and that is right". It must be a conscious, reviewable act:

1. Run `npm run plates:check` first and read what differs. If you cannot explain every diff, stop.
2. Change `public/` (or the demo seed) on purpose, in its own commit.
3. `npm run plates`, and confirm the determinism banner says OK.
4. Commit `plates/` **separately** from the code change, with a message that says what changed and why. Reviewers
   look at the PNG diff in that commit; it is the visual changelog.

Never re-baseline to make a red check green, never in the same commit as an unrelated feature, and never from a
failed determinism run. A baseline that follows the code is a mirror, and a mirror cannot find anything. Things that
legitimately force one: a deliberate redesign, new or removed client routes, new demo seed content, a Playwright
engine upgrade (versions are in the manifest; an engine bump moves anti-aliasing and text, so expect a full set).

When engines or the OS change, `manifest.json` records `engines`, `host` and `freeze`, so the cause of a wholesale
shift is visible at a glance.
