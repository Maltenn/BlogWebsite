// `npm run plates`: captures the REFERENCE PLATE SET, the pictures every app shell is measured against.
//
// Why it exists: the apps bundle public/ byte for byte (docs/mobile/contract.md), so "the aesthetic is the same" is
// true by construction. This turns that claim into a measurement: every client route, in chromium (what the Android
// WebView is) and webkit (what iOS WKWebView is), at four viewports, signed in and out, frozen so a repeat run is
// pixel-identical. tools/pixeldiff.mjs then compares any candidate capture against these.
//
//   node tools/plates.mjs                     capture everything into plates/, then capture it all AGAIN from a fresh
//                                             database and assert a 0-pixel diff (that is the determinism proof)
//   node tools/plates.mjs --no-verify         capture once, skip the repeat run
//   node tools/plates.mjs --engines webkit --viewports 390x844 --routes home,login     a slice (merged into the manifest)
//   node tools/plates.mjs --url http://127.0.0.1:8787     use a site that is already running instead of starting one
//   node tools/plates.mjs --reuse             use 127.0.0.1:8787 if a demo is up there, otherwise start our own
//
// The site it captures is a THROWAWAY COPY of a pristine demo seed (.plates-work/), never your own .demo/, because
// visiting pages and signing in changes a database (read markers, last seen) and a baseline must not depend on what
// you clicked yesterday. Writes from the pages are blocked for the same reason.
//
// Everything a candidate capture needs to be comparable (the clock, the GIF stripper, the request filter) is exported
// from here, so an app shell's capture script freezes the world exactly as this one does.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { PNG } from 'pngjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = path.join(ROOT, '.plates-work');
export const PLATES = path.join(ROOT, 'plates');
export const DEMO_PASSWORD = 'ourspace-demo';                          // tools/demo.mjs
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';            // test/helpers/human.mjs (the demo accepts it)
const IDENTITIES = { in: 'you@example.com', admin: 'malten@example.com' };   // the demo's regular member and its moderator

/* Answers the Worker works out from ITS OWN clock, served from a fixture instead.
   context.clock below freezes the browser's clock; it cannot touch the server's, and these routes read it:
     - the horoscope's day (src/horoscope/horoscope.js, dayOf -> localDay(..., c.now)). The page does send the frozen
       date, but localDay discards a client date more than 2.5 days from the server's own, as a guard against nonsense
       input, so the frozen date was silently dropped.
     - #ourspace's rolling window (src/chats/ourspace.js, WINDOW: m.created > c.now - KEEP_MS, 24 hours), which hides
       the seeded messages once they are a day old. Its scroll pane has a fixed height, so the page did not even change
       size when the messages went.
     - Browse's "For you" (GET /api/browse/discover, src/browse/score.js WINDOW: only posts from the last 7 days), which
       says "nothing to suggest right now" once the seed is a week old, and "Who to follow" on the home page (GET
       /api/browse/people: when you have fewer than three mutuals it falls back to people seen in the last 30 days, ACTIVE).
       Those two answer differently signed out and signed in, so they are pinned per identity (byIdentity in the fixture).
   So a baseline stopped matching within days of being taken, with nothing in the code changed: on 2026-11-05, 48 of
   464 plates failed against a 2026-10-31 baseline (horoscope, horoscope-sign, home--in for its horoscope teaser, and
   ourspace--in), and on 2026-11-07 the 16 browse plates, the seed's 7th day. This list was once "two routes": it was
   wrong, and it will be wrong again, so the fixture also carries a `reads` table of every clock read that reaches a plate
   (pinned or not, with its window), test/static.test.mjs keeps that table honest, and capturePass warns, naming the
   routes, about an unpinned one the seed has outgrown. A gate that goes red on its own is worse than no gate, so these
   answers are pinned. The cost: those plates test the pages' layout, not that the astrology, the chat query or the
   ranking is right. Regenerating the fixture means deliberately re-baselining exactly those plates
   (tools/pin-server-clock.mjs for the per-identity ones). docs/mobile/harness.md. */
const CLOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'server-clock.json'), 'utf8'));
const FROZEN_API = CLOCK.responses;
const BY_IDENTITY = CLOCK.byIdentity || {};                                // path -> { out, in, admin }: one answer per viewer
const MEDIA_DIR = path.join(ROOT, 'tools', 'fixtures', 'server-clock-media');   // the photos those answers point at (tools/pin-server-clock.mjs)
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const CLOCK_READS = CLOCK.reads || [];

/** Epoch-millisecond fields moved by `by`, so a pinned answer's "3m ago" is the same on any seed (the page counts from the frozen clock, which follows the seed). */
const shifted = (v, by) => Array.isArray(v) ? v.map(x => shifted(x, by))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shifted(x, by)]))
  : typeof v === 'number' && v > 1e12 ? v + by : v;

/** What a seed this old gets wrong, among the clock reads that are NOT pinned: a window it has outgrown ('expires') or one it has not yet reached ('matures'). */
export function clockWarnings(seedAgeMs) {
  return CLOCK_READS.filter(r => r.plated !== false && !r.pinned && r.ms && (r.kind === 'matures' ? seedAgeMs < r.ms : seedAgeMs > r.ms))
    .map(r => `the seed is ${Math.round(seedAgeMs / 60000)} min old and ${r.what} (${r.file}, ${r.kind === 'matures' ? 'needs a seed older than' : 'only holds for'} ${r.ms / 60000} min), which changes: ${r.routes.join(', ')}`);
}

/* The capture server's port is printed on the page, so it has to be made constant.
   The profile's "OurSpace URL:" box renders location.origin + the path (public/js/pages/profile.js:124), and
   startSite() takes the first free port from 8810 -- so a second capture, a dev server, or another person working on
   the same machine moves it to 8811 and one digit of one glyph changes. That is 11-26 px, roughly 100x inside the
   0.1% bar, so for weeks every `profile*` plate was "within threshold" and the run still said 0 over threshold. "464
   plates pass" and "464 plates are identical" are different claims and only the second means nothing moved. */
const CANONICAL_ORIGIN = 'http://127.0.0.1:8810';

const PW_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8')).version;
export const ENGINES = { chromium, webkit };
export const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, mobile: true },           // phone
  { name: '430x932', width: 430, height: 932, mobile: true },           // large phone
  { name: '768x1024', width: 768, height: 1024, mobile: true },         // tablet
  { name: '1280x900', width: 1280, height: 900, mobile: false },        // desktop
];

/* ------------------------------------------------------------------ the route table */
// One entry per client route in public/app.js (coverage is asserted against that file at run time, so a new route
// there fails this harness loudly instead of silently going unmeasured). `states`: out = signed out, in = the demo
// member, admin = the demo moderator. A route that needs an account is captured signed in only; one that is for
// guests is captured signed out only; everything else both ways. `url(d)` gets the values discovered from the API.
const both = ['out', 'in'];
export const ROUTE_SPECS = [
  { key: 'home', states: both, url: () => '/' },
  { key: 'join', states: ['out'], url: () => '/join' },
  { key: 'join-finish', states: ['out'], url: () => '/join/finish' },
  { key: 'login', states: ['out'], url: () => '/login' },
  { key: 'forgot', states: ['out'], url: () => '/forgot' },
  { key: 'reset', states: ['out'], url: () => '/reset#token=plates' },
  { key: 'profile', states: both, url: d => d.profile && `/u/${enc(d.profile)}`, need: 'a member with a page' },
  { key: 'profile-replies', states: both, url: d => d.profile && `/u/${enc(d.profile)}/replies`, need: 'a member with a page' },
  { key: 'profile-blog', states: both, url: d => d.blogUser && `/u/${enc(d.blogUser)}/blog`, need: 'a member with a blog entry' },
  { key: 'profile-blog-post', states: both, url: d => d.blogUser && `/u/${enc(d.blogUser)}/blog/${d.blogId}`, need: 'a member with a blog entry' },
  { key: 'profile-post', states: both, url: d => d.post && `/u/${enc(d.post.author)}/post/${d.post.id}`, need: 'a status post' },
  { key: 'profile-comments', states: both, url: d => d.profile && `/u/${enc(d.profile)}/comments`, need: 'a member with a page' },
  { key: 'profile-followers', states: both, url: d => d.profile && `/u/${enc(d.profile)}/followers`, need: 'a member with a page' },
  { key: 'profile-following', states: both, url: d => d.profile && `/u/${enc(d.profile)}/following`, need: 'a member with a page' },
  { key: 'profile-friends', states: both, url: d => d.profile && `/u/${enc(d.profile)}/friends`, need: 'a member with a page' },
  { key: 'browse', states: both, url: () => '/browse' },
  { key: 'notifications', states: ['in'], url: () => '/notifications' },
  { key: 'bookmarks', states: ['in'], url: () => '/bookmarks' },
  { key: 'tag', states: both, url: d => d.tag && `/tags/${enc(d.tag)}`, need: 'a tagged post' },
  { key: 'requests', states: ['in'], url: () => '/requests' },
  { key: 'messages', states: ['in'], url: () => '/messages' },
  { key: 'messages-chat', states: ['in'], url: d => d.chatId && `/messages/${d.chatId}`, need: 'a conversation the member is in' },
  { key: 'inbox', states: ['in'], url: () => '/inbox' },
  { key: 'inbox-dm', states: ['in'], url: d => d.dmName && `/inbox/${enc(d.dmName)}`, need: 'a direct message partner' },
  { key: 'ourspace', states: both, url: () => '/ourspace' },
  { key: 'boards', states: both, url: () => '/boards' },
  { key: 'boards-board', states: both, url: d => d.board && `/boards/${enc(d.board)}`, need: 'a board' },
  { key: 'boards-thread', states: both, url: d => d.board && d.thread && `/boards/${enc(d.board)}/${d.thread}`, need: 'a board thread' },
  { key: 'bulletins', states: both, url: () => '/bulletins' },
  { key: 'horoscope', states: both, url: () => '/horoscope' },
  { key: 'horoscope-sign', states: both, url: d => d.sign && `/horoscope/${enc(d.sign)}`, need: 'a zodiac sign' },
  { key: 'edit', states: ['in'], url: () => '/edit' },
  { key: 'settings', states: ['in'], url: () => '/settings' },
  { key: 'me-strikes', states: ['in'], url: () => '/me/strikes' },
  { key: 'verify', states: both, url: () => '/verify' },
  { key: 'admin', states: ['admin'], url: () => '/admin' },
  { key: 'rules', states: both, url: () => '/rules' },
  { key: 'terms', states: both, url: () => '/terms' },
  { key: 'privacy', states: both, url: () => '/privacy' },
];
const enc = encodeURIComponent;
export const plateKey = (route, state) => `${route}--${state}`;       // the file name (minus .png) and the manifest key

/** The client route regexes in public/app.js, in order. Throws if the table here and that file have drifted apart. */
export function clientRoutePatterns() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('const ROUTES = ['), src.indexOf('\n];', src.indexOf('const ROUTES = [')));
  return [...block.matchAll(/^\s*\[(\/.*\/),\s*(?:render|root)/gm)].map(m => ({ source: m[1], re: new Function('return ' + m[1])() }));
}
export function assertCoverage(urls) {
  const patterns = clientRoutePatterns();
  const uncovered = patterns.filter(p => !urls.some(u => p.re.test(u.split(/[?#]/)[0])));
  const orphans = urls.filter(u => !patterns.some(p => p.re.test(u.split(/[?#]/)[0])));
  if (uncovered.length || orphans.length) {
    throw new Error(`the plates route table and the ROUTES table in public/app.js disagree.\n  not covered: ${uncovered.map(p => p.source).join(' ') || 'none'}\n  matching nothing: ${orphans.join(' ') || 'none'}`);
  }
  return patterns.length;
}

/* ------------------------------------------------------------------ freezing the world */
// A GIF cut down to its first frame. 4 MB of animated avatars would otherwise be a different picture every time.
export function firstFrameGif(buf) {
  try {
    if (buf.length < 14 || buf.toString('latin1', 0, 3) !== 'GIF') return buf;
    let p = 13;
    if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
    const skipBlocks = at => { while (buf[at] !== 0) at += buf[at] + 1; return at + 1; };
    while (p < buf.length) {
      const b = buf[p];
      if (b === 0x21) p = skipBlocks(p + 2);                                   // extension (graphic control, loop, comment…)
      else if (b === 0x2c) {                                                   // the first image: copy through it, then stop
        let q = p + 10;
        if (buf[p + 9] & 0x80) q += 3 * (1 << ((buf[p + 9] & 7) + 1));
        q = skipBlocks(q + 1);                                                 // (+1: the LZW minimum code size)
        return Buffer.concat([buf.subarray(0, q), Buffer.from([0x3b])]);
      } else return buf;
    }
  } catch { /* an odd file: leave it alone */ }
  return buf;
}

// requests a page may make that change the server (everything else that is not a GET is refused): none of the
// plates should ever alter the database they are drawn from
const WRITES_ALLOWED = [['POST', '/api/verify'], ['POST', '/api/chats']];   // (idempotent: a bad token; opening an existing DM)

// Cloudflare's Turnstile widget cannot be captured (it is a cross-origin iframe with its own animation), so the script is
// replaced by one that draws nothing and answers at once with the demo's test token: the form's status line then
// settles on "checked" instead of whatever the proof-of-work progress happened to read
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_STUB = `window.turnstile={render:function(el,o){setTimeout(function(){o.callback('${TURNSTILE_TEST_TOKEN}')},0);return 'plates'},remove:function(){},reset:function(){},getResponse:function(){return '${TURNSTILE_TEST_TOKEN}'}};`;

// The sign-up form's proof of work counts up to 100% in however long this machine takes (and WebKit on Windows takes a
// minute), so the page's own solver is swapped for one that answers at once. Only the arithmetic changes; the status
// line, the layout and the words are the page's own.
export const POW_MODULE = '/js/widgets/pow.js';
export const POW_STUB = `export function zeroBits(bytes){let n=0;for(const b of bytes){if(b===0){n+=8;continue}return n+Math.clz32(b)-24}return n}
export async function solvePow(token,bits,o={}){if(o.onProgress)o.onProgress(1);return '0'}
`;

const FREEZE_CSS = `*,*::before,*::after{animation-play-state:paused!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

/**
 * Everything non-deterministic, switched off, on one browser context: the clock, Math.random, animations, GIF motion,
 * writes, and any request that leaves the site (Turnstile, fonts…). App shell capture scripts call this too.
 */
export async function freezeContext(context, { base, now, state }) {   // state: out | in | admin, which byIdentity answer to serve
  await context.clock.setFixedTime(now);                                     // Date.now() / new Date() stay put (timers still run).
  //                                                                        NOT the Worker's clock: see FROZEN_API above.
  await context.addInitScript(({ css, seed }) => {
    let s = seed >>> 0;                                                      // mulberry32: the same "random" numbers every load
    Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // (a constructed stylesheet: the site's Content-Security-Policy refuses an inline <style>, and bypassing the policy would
    // change what gets drawn)
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  }, { css: FREEZE_CSS, seed: 0x0b5eace });
  const origin = new URL(base).origin;
  const gifs = new Map();
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.href.startsWith(TURNSTILE_SCRIPT)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB });
    if (url.origin !== origin) return route.abort();                         // anything third-party
    if (url.pathname === POW_MODULE) return route.fulfill({ status: 200, contentType: 'text/javascript', body: POW_STUB });
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      if (WRITES_ALLOWED.some(([m, p]) => m === req.method() && p === url.pathname)) return route.continue();
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"plates: writes are blocked while capturing."}' });
    }
    if (FROZEN_API[url.pathname]) {                                          // the server's clock, kept out of the plates (above)
      return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(FROZEN_API[url.pathname]) });
    }
    const photo = url.pathname.startsWith('/media/') && path.join(MEDIA_DIR, path.basename(url.pathname));
    if (photo && fs.existsSync(photo)) {
      return route.fulfill({ status: 200, contentType: MEDIA_TYPES[path.extname(photo).slice(1)] || 'application/octet-stream', body: fs.readFileSync(photo) });
    }
    const mine = BY_IDENTITY[url.pathname] && BY_IDENTITY[url.pathname][state];   // the server's clock again, but this viewer's answer
    if (mine) {
      return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(shifted(mine, now - CLOCK.identityClock)) });
    }
    if (/\.gif$/i.test(url.pathname)) {
      if (!gifs.has(url.href)) {
        const res = await route.fetch();
        gifs.set(url.href, { status: res.status(), headers: res.headers(), body: firstFrameGif(await res.body()) });
      }
      const g = gifs.get(url.href);
      const headers = { ...g.headers, 'content-length': String(g.body.length) };
      return route.fulfill({ status: g.status, headers, body: g.body });
    }
    return route.continue();
  });

  // The live rooms (#ourspace, the chats) speak over a WebSocket, and context.route() does NOT see WebSockets (routeWebSocket is a
  // separate API), so a plate used to be photographed with a real socket to the throwaway Worker in it: the nick list and "x is
  // typing" arrived on one-second server timers, racing the capture, and four parallel contexts signed in as the same member were
  // each other's presence. Now the page's socket is answered here, by nobody: it opens, hears ONE presence frame naming the viewer
  // (what the room sends a newcomer when nobody else is there, which is always the case in a plate), and then silence. Nothing
  // reaches the real room, so nothing in it can change a plate.
  let viewer = null;
  const who = () => viewer || (viewer = context.request.get(origin + '/api/me').then(r => r.json()).then(j => (j && j.user ? { id: j.user.id, name: j.user.name, avatar: j.user.avatar } : null)).catch(() => null));
  await context.routeWebSocket(/\/api\/live\//, async ws => {
    const me = await who();
    ws.send(JSON.stringify({ type: 'presence', online: me ? [me] : [] }));
    ws.onMessage(() => {});                                                  // pings and "typing" go nowhere
  });
}

// What "finished" means, and how sure the harness insists on being. These numbers are the harness's answer to a loaded machine, and
// they are generous on purpose: a plate that took 3 seconds longer is free, a plate that was photographed half-settled is a false
// alarm that costs someone an afternoon (docs/mobile/harness.md, "Load sensitivity"). Do not trade them for speed.
const STABLE_POLLS = 8;          // consecutive 250 ms polls on which the page, and the box of every image on it, looked exactly the same
const QUIET_MS = 1000;           // untouched time after the last thing the harness does to the page, before the first photograph. WebKit draws a
                                 // scaled image rough and redraws it smooth only after ~500 ms without a repaint; on a busy machine that timer is late
const SHOTS_IN_A_ROW = 3;        // identical photographs in a row (two equal "rough" frames are one frame, photographed twice)
const SHOT_GAP_MS = 350;
const SHOTS_MAX = 16;

/** Every image on the page is in, decoded, and every web font loaded; then two frames have been presented. */
async function imagesAndFonts(page) {
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });    // (the avatar pickers: lazy images offscreen never load otherwise)
    const arrived = i => (i.complete ? null : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 15000); }));
    await Promise.all([...document.images].map(arrived));
    // decode() twice, with a frame between: the second pass catches an image whose first decode raced the layout it was decoded for
    for (let pass = 0; pass < 2; pass++) {
      await Promise.all([...document.images].map(i => i.decode().catch(() => {})));      // (webkit paints a scaled image rough, then again smooth)
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    await document.fonts.ready;
  }).catch(() => {});
}

/** Wait until the page has finished drawing, then hold every animation at its first frame. Returns notes if it never did. */
export async function settle(page) {
  const notes = [];
  await page.waitForLoadState('load').catch(() => {});
  // ready = the route's content is drawn, every image is in, the human-check line has finished counting, and the page (the
  // direct children of the content, the document height, the width of the document and the box of EVERY image) has looked exactly
  // the same on STABLE_POLLS polls in a row. A slow machine otherwise gets photographed half-drawn.
  await page.waitForFunction(need => {
    document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    const st = window.__platesStable || (window.__platesStable = { n: 0, last: '' });
    const c = document.querySelector('#ms-content');
    const imgs = [...document.images].filter(i => !i.complete).length;
    const hc = [...document.querySelectorAll('.hc-status')].every(x => !x.textContent || x.classList.contains('ok') || x.classList.contains('bad'));
    const ready = !!c && c.childElementCount > 0 && !c.querySelector('.os-loading') && hc;
    const boxes = [...document.images].map(i => { const b = i.getBoundingClientRect(); return (b.left | 0) + ',' + (b.top | 0) + ',' + (b.width | 0) + ',' + (b.height | 0); }).join(';');
    const sig = (c ? c.childElementCount : 0) + ':' + document.documentElement.scrollHeight + ':' + document.documentElement.scrollWidth + ':' + imgs + ':' + boxes;
    st.n = ready && imgs === 0 && sig === st.last ? st.n + 1 : 0;
    st.last = sig;
    return st.n >= need;
  }, STABLE_POLLS, { timeout: 90000, polling: 250 }).catch(() => notes.push('the page had not finished drawing after 90s'));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await imagesAndFonts(page);
  // One layout, whatever order things arrived in. WebKit does not lay a page out the same way when its images arrive at different
  // moments: the decor picker on /edit (`.cz-gif { height: 54px; display: flex } .cz-gif img { max-height: 100% }`) comes out with
  // its pictures at 46x46, 46x54 or 58x58 depending on which images were already cached when the layout ran, and that depended on
  // machine load and on what the same context had loaded before (docs/mobile/harness.md, "Load sensitivity"). So the settled page
  // is put through the same two steps every time, which ends in the same layout from any starting point:
  //   1. drop the whole render tree and build it again (body display none / back): a from-scratch layout, which forgets history;
  //   2. then take every image out of layout and put it back (display none / back): an incremental layout, which is the one the
  //      plates were taken in (the 46x46 state), and is a deterministic function of step 1's result.
  // This runs before the animations are frozen below, so the finish() calls are not undone.
  await page.evaluate(async () => {
    const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = document.body, was = b.style.display;
    b.style.display = 'none';
    void b.offsetHeight;
    b.style.display = was;
    await frames();
    const imgs = [...document.images], saved = imgs.map(i => i.style.display);
    imgs.forEach(i => { i.style.display = 'none'; });
    void b.offsetHeight;
    imgs.forEach((i, k) => { if (saved[k]) i.style.display = saved[k]; else i.style.removeProperty('display'); });
    if (!b.getAttribute('style') && !was) b.removeAttribute('style');
    await frames();
  }).catch(() => {});
  await imagesAndFonts(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try { if (a.effect.getComputedTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish(); } catch { /* gone */ }
    }
  }).catch(() => {});
  // The port, made constant (CANONICAL_ORIGIN above). Both are four digits, so nothing reflows; if the harness ever
  // ran on a port of a different width the text would change length, and that would show up as a real diff rather
  // than hide.
  await page.evaluate(canonical => {
    const live = location.origin;
    if (live === canonical) return;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue && n.nodeValue.includes(live)) hits.push(n);
    for (const n of hits) n.nodeValue = n.nodeValue.split(live).join(canonical);
  }, CANONICAL_ORIGIN).catch(() => {});

  // Every pane that has scrolled is pinned to a whole pixel. #ourspace's log is `height: min(60vh, 540px)`, which at
  // 390x844 works out to 506.4px -- a fractional box -- so scrolling to the newest message leaves the text on a
  // fraction of a pixel, and WebKit rasterises it a little differently from one run to the next: 26 scattered pixels
  // (0.008%), at that one viewport and no other, because every other viewport clamps the pane to a flat 540px. The
  // same trap is set for `.ms-chat-log` (`min(56vh, 520px)`, 472.6px at that width). Rounding moves what is shown by
  // less than a pixel and makes it the same every time. Elements that never scrolled are left alone.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollTop) el.scrollTop = Math.round(el.scrollTop);
      if (el.scrollLeft) el.scrollLeft = Math.round(el.scrollLeft);
    }
    const se = document.scrollingElement;
    if (se && se.scrollTop) se.scrollTop = Math.round(se.scrollTop);
  }).catch(() => {});
  await page.waitForTimeout(QUIET_MS);
  return notes;
}

/**
 * The screenshot: the whole page, up to maxHeight, as a PNG whose bytes depend only on its pixels. It is accepted only after
 * SHOTS_IN_A_ROW identical photographs in a row, SHOT_GAP_MS apart; a page that never stops changing throws (the caller
 * retries, and in the end records an error instead of a flaky plate).
 */
export async function shoot(page, { maxHeight }) {
  const dims = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }));
  const opts = { type: 'png', fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' };
  if (dims.h > maxHeight) opts.clip = { x: 0, y: 0, width: dims.w, height: maxHeight };
  let last = null, run = 0;
  for (let i = 0; i < SHOTS_MAX; i++) {
    if (i) await page.waitForTimeout(SHOT_GAP_MS);
    const next = await page.screenshot(opts);
    run = last && next.equals(last) ? run + 1 : 1;
    last = next;
    if (run >= SHOTS_IN_A_ROW) return canonicalPng(last);
  }
  throw new Error(`the page kept changing: no ${SHOTS_IN_A_ROW} identical photographs in a row after ${SHOTS_MAX}`);
}
export function canonicalPng(buf) {
  const img = PNG.sync.read(buf);
  return PNG.sync.write(img, { deflateLevel: 9, filterType: -1, colorType: 6 });   // same pixels, same bytes, fewer of them
}

/* ------------------------------------------------------------------ the site under test */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort(from) {
  for (let p = from; p < from + 100; p++) {
    const free = await new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    if (free) return p;
  }
  throw new Error('no free port near ' + from);
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
const up = async base => { try { return (await fetch(base + '/api/options')).ok; } catch { return false; } };

// run tools/demo.mjs with its database in `dir`; resolves with the address it prints once it is serving
async function runDemo(dir, extraArgs = []) {
  const port = await freePort(8810);
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'demo.mjs'), ...extraArgs], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    env: { ...process.env, DEMO_DIR: dir, PORT: String(port), FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  let log = '';
  let exited = false;
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 600; i++) {                                           // up to 5 minutes (a first seeding is slow)
    const m = /ourspace demo is running:\s+(http:\/\/\S+)/.exec(log);
    if (m) return { base: m[1], child, stop: () => killTree(child) };
    if (exited) break;
    await sleep(500);
  }
  killTree(child);
  throw new Error('the demo did not start:\n' + log.slice(-2000));
}

const cleanups = [];                                                        // throwaway databases, removed once the processes holding them are gone
process.on('exit', () => { for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* next run's tidy-up */ } } });

/** Start a throwaway copy of the pristine seed (making the seed first if this is the first run). */
export async function startSite({ url, reuse } = {}) {
  if (url) { if (!(await up(url))) throw new Error(`nothing is answering at ${url}`); return { base: url.replace(/\/$/, ''), stop() {}, owned: false }; }
  if (reuse && await up('http://127.0.0.1:8787')) return { base: 'http://127.0.0.1:8787', stop() {}, owned: false };
  const seed = path.join(WORK, 'seed');
  if (!fs.existsSync(path.join(seed, 'seeded'))) {
    console.log('  making the pristine demo seed (first run only, about a minute)…');
    fs.rmSync(seed, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    const seeding = await runDemo(seed, ['--fresh']);
    seeding.stop();
    await sleep(1500);                                                      // let the files be released before they are copied
  }
  for (const old of fs.existsSync(WORK) ? fs.readdirSync(WORK) : []) if (/^run-/.test(old)) { try { fs.rmSync(path.join(WORK, old), { recursive: true, force: true }); } catch { /* still in use */ } }
  const run = path.join(WORK, `run-${process.pid}-${Date.now()}`);
  fs.cpSync(seed, run, { recursive: true });
  const site = await runDemo(run);
  return { base: site.base, owned: true, stop() { site.stop(); cleanups.push(run); } };
}

/* ------------------------------------------------------------------ what the site has, found through its API */
async function jsonGet(base, p, cookie) {
  const res = await fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}
/** Sign in as a demo member the way the page does (the Turnstile test token is accepted by the demo). Returns the cookie value. */
export async function login(base, email) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD, turnstile: TURNSTILE_TEST_TOKEN }) });
  if (!res.ok) throw new Error(`signing in as ${email} failed: ${res.status} ${await res.text()}`);
  const pair = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('os_sid='));
  if (!pair) throw new Error('the site did not set a session cookie');
  return pair.slice('os_sid='.length);
}

/**
 * The values for the parameterised routes, chosen by rule from what the API says so a reseed does not break the
 * harness: the best-dressed member, the busiest status, the first blog entry, the busiest board and thread…
 */
export async function discover(base, cookie) {
  const c = 'os_sid=' + cookie;
  const d = {};
  const me = (await jsonGet(base, '/api/me', c)).user;
  d.viewer = me && me.name;
  const people = (await jsonGet(base, '/api/users')).users.filter(u => u.name !== d.viewer);
  const profiles = await Promise.all(people.map(async u => ({ u, p: await jsonGet(base, '/api/users/' + enc(u.name), c).catch(() => null) })));
  const dressed = x => { const p = (x.p && x.p.profile) || {}; return (p.bgTile ? 2 : 0) + (p.decor ? p.decor.length : 0) + (p.badges ? p.badges.length : 0) + (p.top8 ? p.top8.length : 0) + (x.p && x.p.spotify ? 2 : 0) + ((x.p && x.p.top8) ? x.p.top8.length : 0); };
  const best = profiles.filter(x => x.p).sort((a, b) => dressed(b) - dressed(a) || a.u.id - b.u.id)[0];
  d.profile = best && best.u.name;
  for (const { u } of profiles) {                                           // the first member with a blog entry
    const blog = await jsonGet(base, `/api/users/${enc(u.name)}/blog`).catch(() => null);
    if (blog && blog.entries && blog.entries.length) { d.blogUser = u.name; d.blogId = blog.entries[0].id; break; }
  }
  const feed = (await jsonGet(base, '/api/feed', c)).items.filter(i => i.kind === 'status');
  const score = i => i.counts.replies * 3 + i.counts.likes + (i.media ? i.media.length * 2 : 0);
  const pub = [];
  for (const i of feed) if ((await fetch(base + '/api/posts/' + i.id)).ok) pub.push(i);   // (one a signed-out visitor can read)
  const post = pub.sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
  if (post) d.post = { id: post.id, author: post.author.name };
  const tags = new Map();
  for (const i of feed) for (const t of i.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  d.tag = [...tags].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const boards = (await jsonGet(base, '/api/boards')).boards.sort((a, b) => b.threads - a.threads || (a.slug < b.slug ? -1 : 1));
  d.board = boards[0] && boards[0].slug;
  if (d.board) {
    const all = (await jsonGet(base, '/api/boards/' + enc(d.board))).items;
    const t = all.filter(x => !x.sticky).sort((a, b) => b.counts.comments - a.counts.comments || a.id - b.id)[0] || all[0];
    d.thread = t && t.id;
  }
  const chats = (await jsonGet(base, '/api/chats', c)).items;
  const joined = chats.filter(x => x.status === 'joined');
  const chat = joined.filter(x => x.kind !== 'dm')[0] || joined[0];
  d.chatId = chat && chat.id;
  const dm = joined.find(x => x.kind === 'dm');
  d.dmName = dm && dm.members[0] && dm.members[0].name;
  const sky = await jsonGet(base, '/api/astro/sky');
  d.sign = sky.signs[Math.floor(sky.signs.length / 2)].key;
  d.chatsNewest = Math.max(0, ...chats.map(x => (x.lastMessage && x.lastMessage.created) || 0));
  d.feedNewest = Math.max(0, ...(await jsonGet(base, '/api/feed', c)).items.map(i => i.created));
  return d;
}

/**
 * The moment the plates are taken at. The demo seeds its newest conversation message exactly two minutes before the
 * instant it seeded at, so five minutes after THAT is the same relative moment in any seeded database, and every
 * "3m ago" reads the same after a reseed. (Fallback for a database seeded some other way: the newest feed post.)
 */
export function frozenNow(d, override) {
  if (override) return Number.isNaN(Number(override)) ? Date.parse(override) : Number(override);
  const seededAt = d.chatsNewest ? d.chatsNewest + 120000 : d.feedNewest + 240000;
  return seededAt + 5 * 60000;
}

/* ------------------------------------------------------------------ one capture pass */
export function planFor(d, { routes, states } = {}) {
  const plan = [];
  const skipped = [];
  for (const spec of ROUTE_SPECS) {
    if (routes && !routes.includes(spec.key)) continue;
    const url = spec.url(d);
    if (!url) { skipped.push({ route: spec.key, reason: `the demo has no ${spec.need} to point this route at` }); continue; }
    for (const state of spec.states) if (!states || states.includes(state)) plan.push({ route: spec.key, state, path: url });
  }
  return { plan, skipped };
}

async function pool(items, jobs, fn) {
  let i = 0;
  const lane = async () => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane));
}

const fakeParams = { profile: 'x', blogUser: 'x', blogId: 1, post: { id: 1, author: 'x' }, tag: 'x', chatId: 1, dmName: 'x', board: 'x', thread: 1, sign: 'x' };
const stripInternal = d => { const { chatsNewest, feedNewest, ...rest } = d; return rest; };

/**
 * Capture a pass into `outDir/<engine>/<viewport>/<route>--<state>.png`. Starts its own site unless given one.
 * Returns { entries, skipped, params, now, versions } for the manifest.
 */
export async function capturePass(outDir, opts) {
  const { engines, viewports, routes, states, jobs, scale, maxHeight, headed, now: nowOverride, url, reuse, log = console.log } = opts;
  const site = await startSite({ url, reuse });
  try {
    const base = site.base;
    log(`  site: ${base}${site.owned ? ' (throwaway copy of the pristine seed)' : ' (existing instance)'}`);
    const cookies = { out: null };
    for (const [state, email] of Object.entries(IDENTITIES)) {
      cookies[state] = await login(base, email);
      await fetch(base + '/api/me', { headers: { Cookie: 'os_sid=' + cookies[state] } });          // (online from the very first shot)
    }
    const d = await discover(base, cookies.in);
    const now = frozenNow(d, nowOverride);
    for (const w of clockWarnings(Date.now() - (frozenNow(d) - 5 * 60000))) log('  WARNING: ' + w);   // (the demo seeds 2 min before the newest message, the plates are taken 5 min after)
    const { plan, skipped } = planFor(d, { routes, states });
    assertCoverage(ROUTE_SPECS.map(s => s.url(fakeParams)));
    log(`  clock frozen at ${new Date(now).toISOString()}; ${plan.length} captures per engine and viewport; ${skipped.length} route(s) skipped`);

    const entries = {};
    const versions = {};
    const units = [];                                                        // one browser context per (engine, viewport, signed-in state)
    for (const engine of engines) for (const vp of viewports) for (const state of ['out', 'in', 'admin']) {
      const items = plan.filter(p => p.state === state);
      if (items.length) units.push({ engine, vp, state, items });
    }
    const browsers = {};
    for (const engine of engines) {
      browsers[engine] = await ENGINES[engine].launch({ headless: !headed });
      versions[engine] = { version: browsers[engine].version(), build: (/(?:chromium|webkit)-(\d+)/.exec(ENGINES[engine].executablePath()) || [])[1], playwright: PW_VERSION };
    }
    try {
      await pool(units, jobs, async ({ engine, vp, state, items }) => {
        const context = await browsers[engine].newContext({
          viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: scale, isMobile: vp.mobile, hasTouch: vp.mobile,
          locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference', serviceWorkers: 'block', acceptDownloads: false,
        });
        if (cookies[state]) await context.addCookies([{ name: 'os_sid', value: cookies[state], url: base }]);
        await freezeContext(context, { base, now, state });
        fs.mkdirSync(path.join(outDir, engine, vp.name), { recursive: true });
        for (const item of items) {
          const key = plateKey(item.route, item.state);
          const entry = { engine, viewport: vp.name, route: item.route, state: item.state, path: item.path, url: base + item.path };
          for (let attempt = 1; attempt <= 3; attempt++) {                 // (a machine under load can leave a page half-drawn: try again)
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
            let notes = [];
            try {
              await page.goto(base + item.path, { waitUntil: 'load', timeout: 60000 });
              notes = await settle(page);
              if (notes.length && attempt < 3) { await page.close().catch(() => {}); continue; }
              const png = await shoot(page, { maxHeight });
              const final = new URL(page.url());
              entry.finalPath = final.pathname + final.search;
              entry.file = `${engine}/${vp.name}/${key}.png`;
              fs.writeFileSync(path.join(outDir, entry.file), png);
              const dim = PNG.sync.read(png);
              Object.assign(entry, { width: dim.width, height: dim.height, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') });
              delete entry.error;
              if (notes.length) entry.notes = notes;
            } catch (e) {
              entry.error = String(e.message || e).split('\n')[0];
            }
            if (errors.length) entry.pageErrors = errors;
            if (attempt > 1) entry.attempts = attempt;
            await page.close().catch(() => {});
            if (!entry.error) break;
          }
          entries[`${engine}/${vp.name}/${key}`] = entry;
        }
        await context.close();
        log(`  done ${engine} ${vp.name} ${state} (${items.length})`);
      });
    } finally {
      for (const b of Object.values(browsers)) await b.close().catch(() => {});
    }
    return { entries, skipped, params: stripInternal(d), now, versions, base };
  } finally {
    site.stop();
  }
}

/* ------------------------------------------------------------------ comparing two passes of the same thing */
export function readPng(file) { return PNG.sync.read(fs.readFileSync(file)); }
/** Pixels that differ at all (exact RGBA), on the union of both canvases. Also returns the diff image. */
export function exactDiff(a, b) {
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  let count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const ia = x < a.width && y < a.height ? (y * a.width + x) * 4 : -1;
    const ib = x < b.width && y < b.height ? (y * b.width + x) * 4 : -1;
    let same = ia >= 0 && ib >= 0;
    if (same) for (let k = 0; k < 4; k++) if (a.data[ia + k] !== b.data[ib + k]) { same = false; break; }
    if (same) { out.data[o] = out.data[o + 1] = out.data[o + 2] = 255; out.data[o + 3] = 40; }
    else { count++; out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 80; out.data[o + 3] = 255; }
  }
  return { count, total: w * h, image: out };
}

/* ------------------------------------------------------------------ main */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const [k, inline] = t.slice(2).split('=');
    const flag = ['no-verify', 'headed', 'reuse', 'help'].includes(k);
    a[k] = flag ? true : inline ?? argv[++i];
  }
  return a;
}
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : undefined);
export function resolveOptions(a) {
  const engines = list(a.engines) || Object.keys(ENGINES);
  for (const e of engines) if (!ENGINES[e]) throw new Error(`unknown engine "${e}" (chromium or webkit)`);
  const vpNames = list(a.viewports);
  const viewports = vpNames ? vpNames.map(n => VIEWPORTS.find(v => v.name === n) || (() => { throw new Error(`unknown viewport "${n}" (${VIEWPORTS.map(v => v.name).join(', ')})`); })()) : VIEWPORTS;
  return {
    engines, viewports, routes: list(a.routes), states: list(a.states), url: a.url, reuse: !!a.reuse, headed: !!a.headed, now: a.now,
    jobs: Number(a.jobs || Math.max(2, Math.min(4, os.cpus().length - 1))), scale: Number(a.scale || 1), maxHeight: Number(a['max-height'] || 4000),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const opts = resolveOptions(a);
  const out = path.resolve(ROOT, a.out || 'plates');
  const t0 = Date.now();
  const full = !opts.routes && !opts.states && opts.engines.length === Object.keys(ENGINES).length && opts.viewports.length === VIEWPORTS.length;
  console.log(`\nplates: ${opts.engines.join(' + ')} × ${opts.viewports.map(v => v.name).join(', ')}${full ? '' : ' (a slice)'}`);

  console.log('\n[1/2] capturing the plates');
  const staging = path.join(WORK, 'pass-a');
  fs.rmSync(staging, { recursive: true, force: true });
  const A = await capturePass(staging, opts);

  let determinism = { checked: false };
  if (!a['no-verify'] && !opts.url) {
    console.log('\n[2/2] capturing everything again from a fresh database, to prove the plates repeat exactly');
    const repeatDir = path.join(WORK, 'pass-b');
    fs.rmSync(repeatDir, { recursive: true, force: true });
    const B = await capturePass(repeatDir, opts);
    determinism = compareRepeat(A, B, staging, repeatDir, out);
  } else if (!a['no-verify']) {
    console.log('\n[2/2] skipped: a repeat run needs a fresh database, and --url points at one that keeps changing.');
  }

  // publish: replace what this run captured, keep the rest of an existing manifest
  const manifestFile = path.join(out, 'manifest.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  fs.mkdirSync(out, { recursive: true });
  const keep = full || !prev ? {} : prev.plates || {};
  if (full) for (const e of opts.engines) fs.rmSync(path.join(out, e), { recursive: true, force: true });
  for (const k of Object.keys(A.entries)) if (A.entries[k].file) {
    fs.mkdirSync(path.dirname(path.join(out, A.entries[k].file)), { recursive: true });
    fs.copyFileSync(path.join(staging, A.entries[k].file), path.join(out, A.entries[k].file));
  }
  const plates = { ...keep, ...A.entries };
  const sorted = Object.fromEntries(Object.keys(plates).sort().map(k => [k, plates[k]]));
  const routes = Object.fromEntries(ROUTE_SPECS.map(s => [s.key, { path: (s.url(A.params) || null), states: s.states }]));
  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
    engines: { ...(prev && !full ? prev.engines : {}), ...A.versions },
    viewports: VIEWPORTS,
    freeze: { now: A.now, nowISO: new Date(A.now).toISOString(), timezone: 'UTC', locale: 'en-US', colorScheme: 'light', deviceScaleFactor: opts.scale, maxHeight: opts.maxHeight,
      gifs: 'first frame only', animations: 'paused at their first frame', mathRandom: 'seeded', writes: 'blocked', thirdParty: 'blocked, Turnstile stubbed' },
    params: A.params,
    clientRoutes: clientRoutePatterns().length,
    routes,
    skipped: A.skipped,
    determinism: full || !prev ? determinism : { ...determinism, note: 'a slice run: ' + (prev.determinism && prev.determinism.note || '') },
    totals: totals(sorted),
    plates: sorted,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');

  const t = manifest.totals;
  const failed = Object.values(A.entries).filter(e => e.error);
  console.log(`\nplates written to ${path.relative(ROOT, out)}/: ${t.count} PNGs, ${(t.bytes / 1048576).toFixed(1)} MiB, in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`engines: ${Object.entries(A.versions).map(([k, v]) => `${k} ${v.version} (build ${v.build})`).join(', ')}`);
  if (A.skipped.length) console.log('skipped routes:\n' + A.skipped.map(s => `  ${s.route}: ${s.reason}`).join('\n'));
  if (failed.length) console.log('FAILED captures:\n' + failed.map(e => `  ${e.engine} ${e.viewport} ${e.route}--${e.state}: ${e.error}`).join('\n'));
  const odd = Object.values(A.entries).filter(e => e.notes || e.pageErrors || e.attempts);
  if (odd.length) console.log(`captures with notes, retries or page errors: ${odd.length} (see manifest.json)`);
  if (determinism.checked && !determinism.ok) process.exitCode = 2;
  else if (failed.length) process.exitCode = 1;
}

function totals(plates) {
  const e = Object.values(plates).filter(p => p.file);
  return { count: e.length, bytes: e.reduce((n, p) => n + p.bytes, 0) };
}

function compareRepeat(A, B, dirA, dirB, out) {
  const rows = [];
  let bad = 0;
  for (const [k, ea] of Object.entries(A.entries)) {
    const eb = B.entries[k];
    if (!ea.file || !eb || !eb.file) { rows.push({ k, count: -1, why: !ea.file ? 'first run failed' : 'repeat run failed' }); bad++; continue; }
    if (ea.sha256 === eb.sha256) { rows.push({ k, count: 0 }); continue; }
    const r = exactDiff(readPng(path.join(dirA, ea.file)), readPng(path.join(dirB, eb.file)));
    rows.push({ k, count: r.count, total: r.total });
    if (r.count) {
      bad++;
      const f = path.join(out, 'diff', 'determinism', k.replace(/\//g, '__') + '.png');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, PNG.sync.write(r.image));
    }
  }
  const perEngine = {};
  for (const r of rows) {
    const e = r.k.split('/')[0];
    const s = perEngine[e] ||= { captures: 0, identical: 0, differing: 0, differingPixels: 0 };
    s.captures++;
    if (r.count === 0) s.identical++; else { s.differing++; s.differingPixels += Math.max(0, r.count); }
  }
  const flaky = rows.filter(r => r.count !== 0);
  const ok = bad === 0;
  console.log('\n  determinism (run 1 vs run 2, exact pixels):');
  for (const [e, s] of Object.entries(perEngine)) console.log(`    ${e}: ${s.identical}/${s.captures} identical, ${s.differingPixels} differing pixels`);
  if (ok) console.log('    OK: every plate repeated with a 0-pixel diff.');
  else {
    console.log('\n  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log(`  !! THE BASELINE IS NOT DETERMINISTIC: ${flaky.length} capture(s) differ between two identical runs.`);
    console.log('  !! A flaky baseline is worse than none. Per-route numbers:');
    for (const r of flaky) console.log(`  !!   ${r.k}: ${r.count < 0 ? r.why : `${r.count} px of ${r.total} (${(100 * r.count / r.total).toFixed(3)}%)`}`);
    console.log('  !! (diff images: plates/diff/determinism/)');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  }
  return { checked: true, ok, runs: 2, captures: rows.length, perEngine, flaky: flaky.map(r => ({ plate: r.k, differingPixels: r.count, of: r.total })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('\nplates failed: ' + (e && e.stack || e)); process.exit(1); });
}
