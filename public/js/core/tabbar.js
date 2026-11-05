/* core/tabbar.js — the app's native tab bar: the page half.

   In a browser this file does nothing; core/native.js only calls it inside the app. There it:
     · takes `.ms-tabs` out of the page's flow (one inline style; `app.css` is never touched), so the page closes the
       28px the web bar occupied and the only navigation on screen is the native one;
     · measures the web bar anyway — it is still laid out, off-screen, at the width it would have had — with
       core/tabspec.js, and hands the shell the resulting spec (rectangles, colours, strings, baselines);
     · re-measures whenever chrome.js repaints the chrome (a sign-in, a new unread count, a page change) or the web
       view is resized, and pushes the new spec only when it is actually different;
     · turns a tap on a native item into a click on the web tab it was measured from, so the page decides what a tab
       does exactly once (see the listener below for why that matters more than it sounds).

   Why the web bar is moved rather than hidden. `display: none` would make it unmeasurable, and the whole point of
   deviations.md D3's rewrite is that the native bar's metrics are measured from the live CSS rather than guessed.
   `position: absolute; left: -20000px` keeps it fully laid out at its real width while removing it from the flow. The
   restore-measure-rehide below is synchronous, inside one task, so the bar is never painted on screen in between.

   What the shell is expected to provide (ios/App/App/TabBar.swift, android/.../TabBar.java):
     OurSpaceShell.setTabs({ spec })      draw this; `spec: null` means take the bar away
     OurSpaceShell.addListener('tabTap', ({ id, href }) => …)
   A shell that has neither is a shell from before this existed: `wireTabBar` then leaves the web bar exactly where it
   is and returns false, which is also what the app does if a measurement ever fails. */

import { measureTabs, sameSpec } from './tabspec.js';

const OFF_SCREEN = -20000;
const hiddenStyle = width => `position:absolute;left:${OFF_SCREEN}px;top:0;width:${width}px;max-width:none;visibility:hidden;pointer-events:none;`;

/**
 * @param {object} shell   the OurSpaceShell plugin proxy (must have setTabs); null/undefined → nothing happens
 * @param {Document} doc
 * @returns {false | { refresh(): void, stop(): void }}
 */
export function wireTabBar(shell, doc = document) {
  const bar = doc.getElementById('tabs');
  if (!bar || !shell || typeof shell.setTabs !== 'function') return false;

  const win = doc.defaultView;
  let last = null;            // the spec the shell is currently drawing
  let hidden = false;         // is the web bar out of the flow right now
  let timer = 0;
  let stopped = false;

  const show = () => { if (hidden) { bar.removeAttribute('style'); hidden = false; } };
  const hide = width => { bar.setAttribute('style', hiddenStyle(width)); hidden = true; };

  /* Put the bar back in the flow, measure it, and if it is already out of the flow put it straight back — all in one
     synchronous run, so a bar that is hidden is never painted visible in between. */
  function measure() {
    const wasHidden = hidden;
    show();
    let spec = null;
    try { spec = measureTabs(bar); } catch { spec = null; }
    if (wasHidden && spec) hide(spec.w);
    return spec;
  }

  /* The web bar is given back whenever the native one cannot be trusted: a measurement that failed, a shell that
     refused the spec, a spec version this build of the app does not draw. The site works either way, and a page with
     no navigation at all would be the one unacceptable outcome.
     `forGood` is for a shell that said no: that answer will not change on the next repaint of the chrome, so trying
     again every time one happens would be a warning per navigation for the life of the app. */
  function giveUp(why, forGood) {
    if (why) console.warn('native tab bar off:', why);
    if (forGood) stopped = true;
    show();
    last = null;
    if (!stopped) { try { Promise.resolve(shell.setTabs({ spec: null })).catch(() => {}); } catch { /* gone */ } }
  }

  function push(force) {
    if (stopped) return;
    // before chrome.js has painted for the first time the bar is empty; that is not a failure, it is "not yet"
    if (!bar.children.length) { show(); last = null; return; }
    const spec = measure();
    if (!spec) { giveUp('the page\'s own .ms-tabs could not be measured'); return; }
    if (!force && sameSpec(spec, last)) return;
    last = spec;
    // the web bar stays in the page until the shell has actually accepted a spec: an older shell, or one that cannot
    // decode this spec version, leaves the app with the navigation it has always had rather than with none
    let sent;
    try { sent = Promise.resolve(shell.setTabs({ spec })); } catch (e) { giveUp((e && e.message) || 'setTabs threw', true); return; }
    sent.then(() => { if (!stopped && last === spec) hide(spec.w); })
      .catch(e => { if (last === spec) giveUp((e && e.message) || 'the shell refused the spec', true); });
  }

  const soon = () => { if (!timer) timer = win.setTimeout(() => { timer = 0; push(false); }, 0); };

  // chrome.js calls replaceChildren on #tabs for every repaint of the chrome; attributes change when the active tab does
  const watch = new MutationObserver(soon);
  watch.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'href'] });
  win.addEventListener('resize', soon);
  win.addEventListener('orientationchange', soon);

  /* A tap on a native tab CLICKS THE WEB TAB it was measured from, rather than calling the router with its href.
     That is deliberate and not a detour: the page already decides what a tab does, in several places at once, and a
     second path would have to keep up with all of them. `go(href)` would be wrong for "Blog" alone — `/blog/` is one
     of the router's STATIC_PREFIXES, a real file in the bundle that the browser must load itself, and routing to it
     lands on the 404 page. native.js's own `wireClicks` also watches these clicks (external links, `/media/`, the
     provider sign-in). Clicking the element gets all of it, for free, for ever.

     A tap whose tab is no longer there — the chrome repainted between the draw and the finger — does nothing: a new
     spec is already on its way to the shell, and guessing what the member meant is worse than one lost tap. */
  if (typeof shell.addListener === 'function') {
    shell.addListener('tabTap', ev => {
      const i = ev && typeof ev.id === 'string' ? parseInt(ev.id, 10) : NaN;
      const el = Number.isInteger(i) ? bar.children[i] : null;
      if (el && el.getAttribute('href') === ev.href) el.click();
      else console.info('a tab tap arrived after the bar changed; ignored', ev && ev.id);
    });
  }

  // no web fonts here, but if one is ever added the first measurement must not be of the fallback
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => push(false)).catch(() => {});
  push(true);

  return {
    refresh: () => push(true),
    stop: () => {
      stopped = true;
      watch.disconnect();
      win.removeEventListener('resize', soon);
      win.removeEventListener('orientationchange', soon);
      if (hidden) bar.removeAttribute('style');
      try { shell.setTabs({ spec: null }); } catch { /* going away anyway */ }
    },
  };
}
