// `npm run tabbar:check`: proves that the native tab bar's SPEC is a lossless description of the web `.ms-tabs`.
//
// Why this exists. The apps draw a native tab bar (deviations.md D3) instead of the web one, and the site's look must
// not change. The bar's metrics therefore come from public/js/core/tabspec.js, which MEASURES the live `.ms-tabs` in
// the web view it is running in. That turns "does the native bar match the site?" into two separate questions:
//
//   1. Is the spec enough?  Does a bar rebuilt from nothing but the spec's rectangles, colours, strings and baselines
//      come out pixel-identical to the real `.ms-tabs`?   ← THIS TOOL ANSWERS THAT, here, with no device.
//   2. Do Swift and Java place those rectangles and strings where the spec says?   ← a device only; see harness.md.
//
// Question 1 is the one that used to be a guess. It is now a measurement: for every engine (chromium = the Android
// WebView, webkit = iOS WKWebView), every plate viewport, and every item set chrome.js can paint (signed out, signed
// in with badges, moderator, and the odd ones: no badge, a 99+ badge, one tab), this captures the real bar, rebuilds
// it from its spec with absolutely-positioned boxes and left-aligned text on the spec's baselines, and requires a
// ZERO pixel difference. Anything above zero is printed with a diff PNG and the run fails.
//
//   node tools/tabbar-check.mjs                     every engine, viewport and case
//   node tools/tabbar-check.mjs --engines webkit --viewports 390x844 --cases in
//   node tools/tabbar-check.mjs --out DIR           where the PNGs go (default .tabbar-work/)
//   node tools/tabbar-check.mjs --keep              write the PNGs and the spec JSON for every case, and keep them
//
// Exit status: 0 every case at 0 pixels; 1 anything differs, or the run failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = { chromium, webkit };
const VIEWPORTS = ['390x844', '430x932', '768x1024', '1280x900'];

/* The item sets. These are chrome.js's own `tabs` array, rendered as markup: the three it really paints (signed out,
   signed in, moderator) plus the shapes that are easy to get wrong. Keeping them as markup rather than importing
   chrome.js is deliberate — chrome.js needs the whole app running, and what is under test here is the geometry of the
   bar, not who gets which tab. coverage.test checks this list still matches chrome.js. */
const tab = (label, { on = false, badge = null, href = '/x' } = {}) =>
  `<a class="ms-tab${on ? ' on' : ''}" href="${href}">${label}${badge == null ? '' : `<span class="ms-badge">${badge}</span>`}</a>`;

const CASES = {
  // signed out: Home, Browse, Boards, #ourspace, Horoscope, Blog, Join
  out: [tab('Home', { on: true, href: '/' }), tab('Browse'), tab('Boards'), tab('#ourspace'),
    tab('🔮 Horoscope'), tab('Blog'), tab('Join')].join(''),
  // signed in, on the feed, with unread counts: the everyday bar
  in: [tab('Feed', { on: true, href: '/' }), tab('My Page'), tab('Browse'), tab('Notifications', { badge: 3 }),
    tab('Messages', { badge: 12 }), tab('🔖 Bookmarks'), tab('Boards'), tab('#ourspace'),
    tab('🔮 Horoscope'), tab('Blog')].join(''),
  // the moderator: 11 tabs, which is the MOST chrome.js ever paints (its array has 12 entries, but `Join` only
  // appears signed out and `Moderation` only for a moderator), and the badge on the ACTIVE tab, which is a
  // different pink (.ms-tab.on .ms-badge)
  admin: [tab('Feed'), tab('My Page'), tab('Browse'), tab('Notifications', { badge: 99 }),
    tab('Messages', { badge: '99+' }), tab('🔖 Bookmarks'), tab('Boards'), tab('#ourspace'),
    tab('🔮 Horoscope'), tab('Blog'), tab('Moderation', { on: true, badge: 7 })].join(''),
  // the edges: a badge on the active tab on its own, the widest badge, one tab, and a long screen name
  quiet: [tab('Feed', { on: true, href: '/' }), tab('Browse'), tab('Boards'), tab('Blog')].join(''),
  wide: [tab('Notifications', { on: true, badge: '99+' }), tab('Messages', { badge: '99+' }),
    tab('My Page', { href: '/u/xXx_sparklemotion_xXx' })].join(''),
  one: tab('Home', { on: true, href: '/' }),
};

/* ------------------------------------------------------------------ the two documents */

const css = () => fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
const specSrc = () => fs.readFileSync(path.join(ROOT, 'public', 'js', 'core', 'tabspec.js'), 'utf8');

// The real thing: app.css, the body font, and `.ms-tabs` exactly as public/index.html has it.
const webDoc = (items, style) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${style}</style>
<style>html,body{margin:0;padding:0;background:#fff}</style></head>
<body><nav class="ms-tabs" id="tabs" aria-label="OurSpace">${items}</nav></body></html>`;

/* The replica: the bar drawn from NOTHING BUT THE SPEC. No app.css, no `.ms-tab`, no flexbox — one absolutely
   positioned box per rectangle the spec names, and each string placed by its left edge and its baseline, which is
   what UIView.draw / Canvas.drawText are given on the two phones. `alphabetic` dominant-baseline on an inline box is
   the browser's own default, so `top: baseline - <ascent>` would re-introduce a font assumption; instead each run is
   put in a zero-height line box at the baseline (`line-height:0`), which places the glyphs on it by definition. */
const replicaDoc = spec => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;padding:0;background:#fff}
#bar{position:relative;overflow:hidden}
#bar div,#bar span{position:absolute;box-sizing:border-box}
.t{line-height:0;white-space:pre}
</style></head><body><div id="bar"></div><script>
const spec = ${JSON.stringify(spec)};
const bar = document.getElementById('bar');
const px = n => n + 'px';
bar.style.width = px(spec.w);
bar.style.height = px(spec.h + (spec.rule ? spec.rule.h : 0));
// A bar that scrolls is a real scroller with the bar's background on the scroller itself, as it is on the page and in
// the shells (a scroll view over the bar's colour). Without that background chromium draws a badge's curved corners a few
// levels differently from the page, at some x positions only, so the check failed or passed by where the fonts put a badge.
if (spec.scrolls) Object.assign(bar.style, { overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', background: spec.bg });
// the generic keywords must NOT be quoted: "sans-serif" in quotes asks for a family with that name, which changes
// which font the engine falls back to (and therefore where an emoji glyph lands). The \`font\` shorthand also resets
// line-height, so line-height is forced back to 0 after it, in the probe and in the run alike — with a zero-height
// line box the baseline's position no longer depends on which fonts the run happens to use.
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);
const face = f => ({
  font: (f.italic ? 'italic ' : '') + f.weight + ' ' + f.size + 'px '
    + f.families.map(n => (GENERIC.has(n.toLowerCase()) ? n : JSON.stringify(n))).join(', '),
  lineHeight: '0',
});
const box = (o, css) => { const d = document.createElement('div'); Object.assign(d.style, css); bar.appendChild(d); return d; };
// the bar's own background, the width of its scrollable content (what the shell's scroll view holds)
box(0, { left: 0, top: 0, width: px(Math.max(spec.w, spec.contentW)), height: px(spec.h), background: spec.bg });
if (spec.rule) box(0, { left: 0, top: px(spec.h), width: px(Math.max(spec.w, spec.contentW)), height: px(spec.rule.h), background: spec.rule.color });
// CSS has no "put this baseline here", so the replica measures, once per font, how far a zero-height line box's
// baseline sits below its own top edge, and offsets by that. (Canvas.drawText and CoreText take the baseline
// directly, so the two phones need no such step: this is a CSS artefact, not something the spec is missing.)
const kCache = new Map();
const kFor = f => {
  const key = JSON.stringify(f);
  if (kCache.has(key)) return kCache.get(key);
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;left:-9999px;top:0;line-height:0;white-space:pre;';
  Object.assign(d.style, face(f));
  d.textContent = 'Hg';
  const i = document.createElement('i');
  i.setAttribute('style', 'display:inline-block;width:0;height:0;overflow:hidden');
  d.appendChild(i);
  document.body.appendChild(d);
  const k = i.getBoundingClientRect().top - d.getBoundingClientRect().top;
  d.remove();
  kCache.set(key, k);
  return k;
};
const run = (s, x, baseline, f, fg) => {
  const el = document.createElement('span');
  el.className = 't';
  el.textContent = s;
  // CSS stores a length in 1/64px, and webkit centres a badge's text in finer steps than that, so \`left\` alone would
  // round the spec's x down. The shells take x as a double, so the replica must too: the remainder goes in a transform.
  // Dropping it moved the \`+\` of a \`99+\` across a quarter-pixel boundary while the digits before it stayed put.
  const grid = Math.floor(x * 64) / 64;
  Object.assign(el.style, { left: px(grid), top: px(baseline - kFor(f)), color: fg, ...face(f) });
  if (x > grid) el.style.transform = 'translateX(' + (x - grid) + 'px)';
  bar.appendChild(el);
};
for (const it of spec.items) {
  box(0, { left: px(it.x), top: px(it.y), width: px(it.w), height: px(it.h), background: it.bg });
  run(it.label, it.textX, it.baseline, it.font, it.fg);
  if (it.badge) {
    const b = it.badge;
    box(0, { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), background: b.bg, borderRadius: px(b.r) });
    run(b.s, b.textX, b.baseline, b.font, b.fg);
  }
}
window.__ready = true;
</script></body></html>`;

/* ------------------------------------------------------------------ running it */

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    a[k] = k === 'keep' || k === 'help' ? true : inline ?? argv[++i];
  }
  return a;
}
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null);

async function shoot(page, selector) {
  const el = await page.$(selector);
  return PNG.sync.read(await el.screenshot({ animations: 'disabled' }));
}

function diff(a, b, out) {
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const pad = img => {
    if (img.width === w && img.height === h) return img;
    const o = new PNG({ width: w, height: h });
    for (let i = 0; i < o.data.length; i += 4) { o.data[i] = 255; o.data[i + 1] = 0; o.data[i + 2] = 255; o.data[i + 3] = 255; }
    PNG.bitblt(img, o, 0, 0, img.width, img.height, 0, 0);
    return o;
  };
  const A = pad(a), B = pad(b);
  const d = new PNG({ width: w, height: h });
  const n = pixelmatch(A.data, B.data, d.data, w, h, { threshold: 0, includeAA: true });
  if (n && out) fs.writeFileSync(out, PNG.sync.write(d));
  return { n, w, h, sizes: [`${a.width}x${a.height}`, `${b.width}x${b.height}`] };
}

async function main() {
  const A = parseArgs(process.argv.slice(2));
  if (A.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); return 0; }
  const engines = list(A.engines) || Object.keys(ENGINES);
  const viewports = list(A.viewports) || VIEWPORTS;
  const cases = list(A.cases) || Object.keys(CASES);
  const out = path.resolve(ROOT, A.out || '.tabbar-work');
  fs.mkdirSync(out, { recursive: true });

  const style = css();
  const module = specSrc();
  const rows = [];
  let worst = 0;

  for (const eng of engines) {
    if (!ENGINES[eng]) throw new Error(`unknown engine ${eng} (chromium, webkit)`);
    const browser = await ENGINES[eng].launch();
    try {
      for (const vp of viewports) {
        const [width, height] = vp.split('x').map(Number);
        for (const key of cases) {
          if (!CASES[key]) throw new Error(`unknown case ${key} (${Object.keys(CASES).join(', ')})`);
          const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
          const page = await ctx.newPage();
          await page.setContent(webDoc(CASES[key], style), { waitUntil: 'load' });
          await page.evaluate(() => document.fonts.ready);

          // measure with the real module, in the page, exactly as core/tabbar.js does in the app
          const spec = await page.evaluate(async src => {
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const { measureTabs } = await import(url);
            return measureTabs(document.getElementById('tabs'));
          }, module);
          if (!spec) { rows.push({ eng, vp, key, n: -1, note: 'measureTabs returned null' }); worst = Math.max(worst, 1); await ctx.close(); continue; }

          // the real bar: screenshot the element, but only the part the shell draws (the scrollable content is wider
          // than the element at phone widths, and a screenshot cannot see past the overflow) — so compare the visible
          // box of both, which is what a person sees, and separately assert the content width the spec claims.
          const web = await shoot(page, '#tabs');

          const rep = await ctx.newPage();
          await rep.setContent(replicaDoc(spec), { waitUntil: 'load' });
          await rep.evaluate(() => document.fonts.ready);
          await rep.waitForFunction(() => window.__ready === true);
          // clip the replica to the bar's visible box, as the element screenshot of #tabs is clipped
          await rep.evaluate(h => { const b = document.getElementById('bar'); b.style.height = h + 'px'; }, spec.h);
          const replica = await shoot(rep, '#bar');

          const file = path.join(out, `${eng}-${vp}-${key}.png`);
          const r = diff(web, replica, file.replace(/\.png$/, '-diff.png'));
          if (r.n || A.keep) {
            fs.writeFileSync(file.replace(/\.png$/, '-web.png'), PNG.sync.write(web));
            fs.writeFileSync(file.replace(/\.png$/, '-spec.png'), PNG.sync.write(replica));
            fs.writeFileSync(file.replace(/\.png$/, '-spec.json'), JSON.stringify(spec, null, 1));
          }
          rows.push({ eng, vp, key, ...r, items: spec.items.length, h: spec.h, contentW: spec.contentW, scrolls: spec.scrolls });
          worst = Math.max(worst, r.n);
          await rep.close();
          await ctx.close();
        }
      }
    } finally { await browser.close(); }
  }

  const bad = rows.filter(r => r.n !== 0);
  for (const r of rows) {
    const tag = r.n === 0 ? 'ok  ' : 'DIFF';
    console.log(`${tag} ${r.eng.padEnd(8)} ${r.vp.padEnd(9)} ${String(r.key).padEnd(6)} ${r.n < 0 ? r.note : `${r.n} px`}`
      + (r.n > 0 ? `  (${r.sizes.join(' vs ')})` : '')
      + (r.n === 0 ? `  h=${r.h} items=${r.items} contentW=${r.contentW}${r.scrolls ? ' scrolls' : ''}` : ''));
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} cases rebuilt from their spec at 0 pixels.`);
  if (bad.length) {
    console.log(`${bad.length} did not. PNGs (web / spec / diff) in ${out}`);
    return 1;
  }
  if (!A.keep) fs.rmSync(out, { recursive: true, force: true });
  return 0;
}

process.exit(await main());
