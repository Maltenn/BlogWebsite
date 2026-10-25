/* widgets/readmarker.js — "pick up where I left off": which cards you've seen, and how far you've read.
   A card is seen after at least 60% of it has been on screen for 800ms, or once it scrolls out through the top after
   having been 60% on screen. The marker only moves past an unbroken run of seen cards from the start, so dragging the
   scrollbar down the page skips nothing: the cards in between stay unseen. The new position is written to the server
   (PUT /api/me/markers/feed) at most every 2 seconds, and straight away when the tab is hidden, the page is closed or
   you leave the page. The server only ever moves the marker forward. */

const SEEN_FRACTION = 0.6;
const SEEN_MS = 800;
const WRITE_MS = 2000;

// is position a (created, id) after position b? (null b = the beginning)
export const after = (a, b) => !b || a.created > b.created || (a.created === b.created && a.id > b.id);

// opts.marker: where the server says you are ({created, id} or null). opts.top / opts.bottom: pixels at the top and
// bottom of the window covered by the sticky header and the status bar. opts.onChange(seen, total) after the run of
// seen cards grows. opts.onSaved(marker) after a write. opts.onStop() when it stops.
export function readTracker(opts = {}) {
  const cards = [];                 // in reading order: { el, created, id, seen, reached, visible, timer }
  const byEl = new Map();
  let run = 0;                      // cards[0 .. run-1] are all seen
  let sent = opts.marker || null;   // the furthest position the server has
  let high = sent;                  // the furthest position written or on its way
  let writeTimer = 0;
  let stopped = false;

  const see = c => {
    if (c.seen) return;
    c.seen = true;
    clearTimeout(c.timer);
    c.timer = 0;
    io.unobserve(c.el);
    const was = run;
    while (run < cards.length && cards[run].seen) run++;
    if (run > was) {
      if (!writeTimer) writeTimer = setTimeout(flush, WRITE_MS);
      if (opts.onChange) opts.onChange(run, cards.length);
    }
  };

  const arm = c => {
    if (c.timer || c.seen) return;
    c.timer = setTimeout(() => {
      c.timer = 0;
      if (c.visible && !document.hidden) see(c);
    }, SEEN_MS);
  };

  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const c = byEl.get(e.target);
      if (!c || c.seen) continue;
      const root = e.rootBounds, box = e.boundingClientRect;
      const need = Math.min(box.height, root ? root.height : innerHeight) || 1;
      const fraction = e.isIntersecting ? e.intersectionRect.height / need : 0;
      if (fraction >= SEEN_FRACTION) {
        c.reached = c.visible = true;
        arm(c);
      } else {
        c.visible = false;
        clearTimeout(c.timer);
        c.timer = 0;
        if (c.reached && root && box.top < root.top) see(c);      // it left through the top
      }
    }
  }, {
    rootMargin: `-${opts.top || 0}px 0px -${opts.bottom || 0}px 0px`,
    threshold: Array.from({ length: 21 }, (_, i) => i / 20),
  });

  // write the furthest position of the seen run, if it is past what the server has. Resolves when it is done.
  function flush() {
    clearTimeout(writeTimer);
    writeTimer = 0;
    const last = run ? cards[run - 1] : null;
    if (!last || !after(last, high)) return Promise.resolve();
    const m = { created: last.created, id: last.id };
    high = m;
    return fetch('/api/me/markers/feed', {
      method: 'PUT', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m),
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error('marker not saved'))))
      .then(r => { sent = r.marker || m; if (opts.onSaved) opts.onSaved(sent); })
      .catch(() => { high = sent; });                              // not saved: the next card seen tries again
  }

  const onVisibility = () => {
    if (document.hidden) { flush(); return; }
    cards.forEach(c => { if (c.visible) arm(c); });                // back on the tab: cards still on screen count now
  };
  const onHide = () => { flush(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);

  return {
    // a card, in reading order. item is { created, id }.
    add(el, item) {
      if (stopped) return;
      const c = { el, created: item.created, id: item.id, seen: false, reached: false, visible: false, timer: 0 };
      cards.push(c);
      byEl.set(el, c);
      io.observe(el);
    },
    flush,
    // the card to scroll to for "first unseen"
    firstUnseen: () => (run < cards.length ? cards[run].el : null),
    counts: () => ({ seen: run, total: cards.length }),
    // stop watching and write what is left
    stop() {
      stopped = true;
      if (opts.onStop) opts.onStop();
      const done = flush();
      io.disconnect();
      cards.forEach(c => clearTimeout(c.timer));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      return done;
    },
  };
}
