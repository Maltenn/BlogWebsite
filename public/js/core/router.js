/* core/router.js — the page router. In-app links and back/forward go through
   route(), which looks the path up in the table the entry hands to start().
   A page that starts something (an interval, a song preview) registers its
   cleanup with onLeave(); it runs once, when the next page starts.
   A page gets render(root, arg, arg2…): one argument per (…) in its pattern. */

import { h, content, enc } from './dom.js';
import { toast, pageTitle, errorCard } from './ui.js';
import { S } from './state.js';

// real files and the API (sign-in redirects): the browser loads these itself
const STATIC_PREFIXES = ['/blog/', '/assets/', '/api/'];
let routes = [];                  // [regex, render(root, arg), needs login?], from start()
let beforeEach = null;            // runs at the start of every route(), from start()
const leaving = [];               // one-shot cleanups for the page being left

// fn() runs once, at the start of the next route()
export function onLeave(fn) { leaving.push(fn); }

export function go(path, replace = false) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}

let routeSeq = 0;
export async function route() {
  const seq = ++routeSeq;
  leaving.splice(0).forEach(fn => fn());   // the last page's cleanups: its intervals, a playing song preview
  if (beforeEach) beforeEach();            // the entry repaints the header and tabs
  const root = content();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const found = routes.map(([re, fn, auth]) => ({ m: re.exec(path), fn, auth })).find(r => r.m);
  root.replaceChildren(h('div', { class: 'os-loading', text: 'loading…' }));
  window.scrollTo(0, 0);
  if (!found) { root.replaceChildren(pageTitle('404'), h('div', { class: 'ms-empty', text: 'this page wandered off. try the tabs up top.' })); return; }
  if (found.auth && !S.me) { needLogin(); return; }
  const page = h('div');
  try {
    const args = found.m.slice(1).map(a => { try { return a && decodeURIComponent(a); } catch { return a; } });
    await found.fn(page, ...args);
  } catch (e) {
    if (e.status === 401) { S.me = null; needLogin(); return; }
    page.append(errorCard(e));
  }
  if (seq === routeSeq) root.replaceChildren(page);   // a newer navigation wins
}

export function needLogin() {
  toast('log in (or join) first!');
  go('/login?next=' + enc(location.pathname));
}

// installs the link interceptor and back/forward. The entry calls this once; its boot does the first route().
export function start(table, opts = {}) {
  routes = table;
  beforeEach = opts.beforeEach || null;
  // in-app links: every same-origin <a href="/…"> except the static blog pages, files and the API (sign-in redirects)
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || STATIC_PREFIXES.some(p => url.pathname.startsWith(p))) return;
    e.preventDefault();
    go(url.pathname + url.search + url.hash);
  });
  window.addEventListener('popstate', route);
}
