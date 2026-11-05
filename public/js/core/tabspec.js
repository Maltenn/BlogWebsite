/* core/tabspec.js — turn the page's own `.ms-tabs` into numbers a native bar can be drawn from.

   Why it exists. The apps want a real native tab bar (App Store Guideline 4.2) and the site's look must not change
   (`app.css` has a zero-line diff, forever). Those two pull against each other only if the native bar's metrics are
   *invented*. They are not: this module MEASURES the live `.ms-tabs` — the web CSS's own output, in the web view that
   is actually running — and hands the shell a spec of rectangles, colours, strings and baselines. The shell draws
   exactly that. So the bar cannot drift from `app.css`: change the CSS and the measurement changes with it, with no
   Swift or Java touched. (deviations.md D3; docs/mobile/contract.md §11.)

   Everything here is measured, nothing is assumed. The numbers that were *checked* by hand (tools/tabbar-check.mjs
   diffs a bar rebuilt from a spec against the real `.ms-tabs`, at 0 pixels, in both engines) and that no amount of
   reading the CSS would have told you:
     · a tab is 24px tall, not 22. `.ms-tab`'s own line box is 14px + 8px padding = 22, but `.ms-tabs` is a flex row
       with the default `align-items: stretch`, and the two tabs whose label starts with an emoji ("🔖 Bookmarks",
       "🔮 Horoscope") have a 16px line box, because the emoji font's ascent is larger than Arial's. Every tab is
       stretched to those. Drop the emoji from the labels and the whole bar becomes 2px shorter.
     · a badge tab is 23px on its own: the badge is an inline-block on the text's baseline, and `line-height: 15px`
       on a 10px font puts its baseline 10.96px down, below the label's 10.86px, so the line box grows under it.
     · chromium and webkit disagree: the same 11 tabs are 863px wide in one and 929px in the other, and the badge sits
       half a pixel lower in webkit. A single hard-coded layout would be wrong in one of the two web views by
       construction — Android's WebView is chromium, iOS's WKWebView is webkit.
   That is the case for measuring. None of it is visible in the CSS.

   How the baselines are measured. An empty `display:inline-block; height:0` box has its baseline at its bottom margin
   edge, which for a zero-height box is its top edge: so such a box appended inside a tab reports, as the `top` of its
   rect, the exact baseline of the line box it joined. It would be rude to put one inside the live `#tabs`, so the
   whole bar is cloned off-screen at the same width, the struts go in the clone, and the clone's geometry is checked
   against the original tab by tab before it is believed (`measureTabs` returns null if they disagree).

   This file is pure measurement: no Capacitor, no network, nothing app-only. It runs in a plain browser, which is how
   tools/tabbar-check.mjs and mobile/test/ can test it. core/tabbar.js is the part that only runs in the app. */

export const SPEC_VERSION = 2;

/* ---------------------------------------------------------------- colours */

// '#rrggbbaa' from anything getComputedStyle returns ('rgb(a)', a colour keyword resolved to rgb, 'transparent').
// Native sides parse 8-digit hex and nothing else, so every colour crossing the bridge goes through here.
export function hex(css) {
  const s = String(css || '').trim();
  if (s === '' || s === 'transparent' || s === 'none') return '#00000000';
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const b = n => Math.max(0, Math.min(255, Math.round(parseFloat(n) || 0)));
    const a = p.length > 3 ? Math.max(0, Math.min(1, parseFloat(p[3]) || 0)) : 1;
    return '#' + [b(p[0]), b(p[1]), b(p[2]), Math.round(a * 255)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return (s + 'ff').toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map(c => c + c).join('') + 'ff').toLowerCase();
  return '#00000000';
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// Six decimals: enough to strip float noise, fine enough to keep the number EXACT on both engines' layout grids
// (chromium lays out in 1/64px, webkit in 1/64px too). Rounding to two decimals looked harmless and was not: the flex
// row puts "Boards" at 145.359375px, and at 145.36px the same glyphs land on a different sub-pixel and antialias
// differently. tools/tabbar-check.mjs caught it as a 98-pixel difference in one word.
const r2 = n => Math.round(n * 1e6) / 1e6;

// the font-family list as names, quotes and spacing stripped. The shell tries them in order and falls back to its own
// bold system font — which is what the web view does too, so the fallback agrees by construction (deviations.md D4).
export function families(fontFamily) {
  return String(fontFamily || '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// '0 1px 0 rgba(0,0,0,.25)' → the hairline under the bar. Only the simple one-shadow, no-blur, no-spread form the site
// uses is understood; anything else returns null and the shell draws no rule rather than the wrong one.
export function ruleFromShadow(boxShadow) {
  const s = String(boxShadow || '').trim();
  if (!s || s === 'none') return null;
  if (s.includes(',')) {
    // getComputedStyle puts an rgba() colour first, so a comma inside rgba(...) is not a shadow separator
    const outside = s.replace(/rgba?\([^)]*\)/gi, '');
    if (outside.includes(',')) return null;
  }
  const colour = (/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i.exec(s) || [])[0];
  const lengths = s.replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi, '').trim().split(/\s+/).filter(Boolean);
  if (!colour || lengths.length < 2) return null;
  const [dx, dy, blur = '0', spread = '0'] = lengths.map(num);
  if (dx !== 0 || dy <= 0 || blur !== 0 || spread !== 0) return null;      // only the site's flat 1px line under the box
  return { dy: r2(dy), h: r2(dy), color: hex(colour) };
}

/* ---------------------------------------------------------------- measuring */

const STRUT = 'display:inline-block;width:0;height:0;overflow:hidden;padding:0;margin:0;border:0;';

/** The label text of a tab: its own text nodes only, with the badge's digits left out. */
function labelOf(el) {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
  return s;
}

/* A tab's parts, read from the off-screen clone:
     box      the tab's border box, in bar coordinates
     baseline the line box's baseline, in bar coordinates (from the strut)
     textX    where the label's first glyph starts (the content box's left edge)
     textW    the label's advance width, as this web view measures it                                   */
function partsOf(el, barRect, win) {
  const cs = win.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const strut = el.ownerDocument.createElement('i');
  strut.style.cssText = STRUT;
  el.appendChild(strut);
  const baseline = strut.getBoundingClientRect().top - barRect.top;
  strut.remove();

  // the label run on its own (a Range over the text nodes, so the badge is excluded)
  let textW = 0;
  const texts = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent !== '');
  if (texts.length) {
    const rg = el.ownerDocument.createRange();
    rg.setStartBefore(texts[0]);
    rg.setEndAfter(texts[texts.length - 1]);
    textW = rg.getBoundingClientRect().width;
    rg.detach?.();
  }
  return {
    cs,
    box: { x: r.left - barRect.left, y: r.top - barRect.top, w: r.width, h: r.height },
    baseline,
    textX: r.left - barRect.left + num(cs.paddingLeft) + num(cs.borderLeftWidth),
    textW,
  };
}

function badgeSpec(el, barRect, win) {
  const cs = win.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const strut = el.ownerDocument.createElement('i');
  strut.style.cssText = STRUT;
  el.appendChild(strut);
  const baseline = strut.getBoundingClientRect().top - barRect.top;
  strut.remove();
  const s = el.textContent || '';
  // the pill's own text is centred by `text-align: center`; the shell is given the x the web view really put it at, read
  // off the text itself, so it never has to measure a string to centre it (its own advance width could differ by a
  // fraction of a pixel)
  const rg = el.ownerDocument.createRange();
  rg.selectNodeContents(el);
  const text = rg.getBoundingClientRect();
  const textW = s ? text.width : 0;
  const textLeft = s ? text.left : r.left + r.width / 2;
  rg.detach?.();
  const radius = Math.min(num(cs.borderTopLeftRadius), r.height / 2);
  return {
    s,
    x: r2(r.left - barRect.left), y: r2(r.top - barRect.top), w: r2(r.width), h: r2(r.height), r: r2(radius),
    bg: hex(cs.backgroundColor), fg: hex(cs.color),
    font: { families: families(cs.fontFamily), size: r2(num(cs.fontSize)), weight: num(cs.fontWeight) || 400, italic: cs.fontStyle === 'italic' },
    textX: r2(textLeft - barRect.left),
    textW: r2(textW),
    baseline: r2(baseline),
  };
}

/**
 * Measure a live `.ms-tabs` element into a spec the native shells draw from, or null if it cannot be trusted.
 *
 * Null (and the shell then keeps whatever it had, and tabbar.js leaves the web bar visible) when: the bar is empty,
 * it is not displayed, or the off-screen clone did not lay out identically to the original — which is the one way
 * this could silently lie, so it is checked rather than assumed.
 */
export function measureTabs(bar, { win = bar && bar.ownerDocument.defaultView, epsilon = 0.5 } = {}) {
  if (!bar || !win) return null;
  const doc = bar.ownerDocument;
  const tabs = [...bar.children].filter(el => el.nodeType === 1);
  if (!tabs.length) return null;
  const live = bar.getBoundingClientRect();
  if (!live.width || !live.height) return null;
  const barStyle = win.getComputedStyle(bar);

  // the clone: same classes, same width, laid out off-screen where a strut can be put inside a tab without the live
  // page ever containing one. `visibility: hidden` still lays out; `left: -20000px` keeps it off any scrollable area.
  const clone = bar.cloneNode(true);
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.style.cssText = `position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none;width:${live.width}px;height:auto;max-height:none;`;
  doc.body.appendChild(clone);
  try {
    const cloneRect = clone.getBoundingClientRect();
    const cloneTabs = [...clone.children].filter(el => el.nodeType === 1);
    if (cloneTabs.length !== tabs.length) return null;

    // believe the clone only where it agrees with the real thing, tab by tab, in the bar's own coordinates
    for (let i = 0; i < tabs.length; i++) {
      const a = tabs[i].getBoundingClientRect();
      const b = cloneTabs[i].getBoundingClientRect();
      // the live bar may be scrolled sideways; compare positions relative to the first tab, and sizes absolutely
      const liveX = a.left - tabs[0].getBoundingClientRect().left;
      const cloneX = b.left - cloneTabs[0].getBoundingClientRect().left;
      if (Math.abs(a.width - b.width) > epsilon || Math.abs(a.height - b.height) > epsilon
        || Math.abs(liveX - cloneX) > epsilon
        || Math.abs((a.top - live.top) - (b.top - cloneRect.top)) > epsilon) return null;
    }

    const items = cloneTabs.map((el, i) => {
      const p = partsOf(el, cloneRect, win);
      const badgeEl = el.querySelector('.ms-badge');
      const href = tabs[i].getAttribute('href');
      return {
        id: `${i}:${href || ''}`,
        href: href || null,
        label: labelOf(el),
        on: tabs[i].classList.contains('on'),
        x: r2(p.box.x), y: r2(p.box.y), w: r2(p.box.w), h: r2(p.box.h),
        bg: hex(p.cs.backgroundColor), fg: hex(p.cs.color),
        font: {
          families: families(p.cs.fontFamily), size: r2(num(p.cs.fontSize)),
          weight: num(p.cs.fontWeight) || 400, italic: p.cs.fontStyle === 'italic',
        },
        textX: r2(p.textX), textW: r2(p.textW), baseline: r2(p.baseline),
        badge: badgeEl ? badgeSpec(badgeEl, cloneRect, win) : null,
      };
    });

    const contentW = Math.max(clone.scrollWidth, ...items.map(it => it.x + it.w + num(barStyle.paddingRight)));
    return {
      v: SPEC_VERSION,
      w: r2(live.width),
      h: r2(clone.getBoundingClientRect().height),
      contentW: r2(contentW),
      bg: hex(barStyle.backgroundColor),
      rule: ruleFromShadow(barStyle.boxShadow),
      scrolls: barStyle.flexWrap === 'nowrap' && contentW > live.width + epsilon,
      items,
    };
  } finally {
    clone.remove();
  }
}

/** Two specs are the same drawing. Used to avoid waking the native side on every re-render of the chrome. */
export function sameSpec(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}
