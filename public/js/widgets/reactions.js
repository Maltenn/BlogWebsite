/* widgets/reactions.js — the row under a post: 💬 replies · ↻ reposts · ♥ likes · 🔖 bookmark. Glyph links in the Win98
   look. Like, repost and bookmark flip at once and roll back (with the server's message) if the server says no. ↻ opens a
   small menu: Repost / Undo repost, Quote. 💬 opens the Reply window (or whatever opts.onReply does). Logged out, every
   one of them asks you to log in. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, needLogin } from '../core/router.js';
import { postDialog } from './postdialog.js';
import { postPath } from './postlinks.js';

const short = n => (n >= 10000 ? Math.floor(n / 1000) + 'k' : n >= 1000 ? (Math.floor(n / 100) / 10) + 'k' : String(n));

// item: the post the row acts on (for a repost, the original). opts.onReply(): do this instead of opening the Reply
// window. opts.onBookmarkChange(bool) and opts.onUnrepost(): after those happen.
export function reactionRow(item, opts = {}) {
  const st = {
    liked: item.viewer.liked, reposted: item.viewer.reposted, bookmarked: item.viewer.bookmarked,
    likes: item.counts.likes, replies: item.counts.replies, reposts: item.counts.reposts, quotes: item.counts.quotes,
  };
  const url = what => `/posts/${item.id}/${what}`;
  const busy = new Set();

  const button = (cls, glyph, onclick) => {
    const n = h('span', { class: 'ms-actn' });
    const btn = h('button', { class: 'ms-act ' + cls, type: 'button', onclick }, h('span', { class: 'ms-actglyph', text: glyph, 'aria-hidden': 'true' }), n);
    return { btn, n };
  };
  const reply = button('reply', '💬', () => (!S.me ? needLogin() : opts.onReply ? opts.onReply() : answer()));
  const rep = button('repost', '↻', () => (!S.me ? needLogin() : menu ? closeMenu() : openMenu()));
  // (undoing a like or a repost of a post you may no longer see answers without the count: the row keeps its own)
  const like = button('like', '♥', () => flip('like', () => { st.liked = !st.liked; st.likes += st.liked ? 1 : -1; },
    () => (st.liked ? api.post(url('like')) : api.del(url('like'))), r => { st.liked = r.liked; st.likes = r.likes ?? st.likes; }));
  const mark = button('bookmark', '🔖', () => flip('bookmark', () => { st.bookmarked = !st.bookmarked; },
    () => (st.bookmarked ? api.post(url('bookmark')) : api.del(url('bookmark'))), r => {
      st.bookmarked = r.bookmarked;
      toast(r.bookmarked ? 'bookmarked. it\'s in your Bookmarks (only you can see them).' : 'bookmark removed.');
      if (opts.onBookmarkChange) opts.onBookmarkChange(r.bookmarked);
    }));
  const repWrap = h('span', { class: 'ms-actwrap' }, rep.btn);
  const row = h('div', { class: 'ms-acts', role: 'group', 'aria-label': 'reply, repost, like or bookmark this post' }, reply.btn, repWrap, like.btn, mark.btn);

  function paint() {
    const count = (b, n, label) => { b.n.textContent = n > 0 ? short(n) : ''; b.btn.setAttribute('aria-label', n > 0 ? `${label}, ${n}` : label); };
    count(reply, st.replies, 'reply');
    count(rep, st.reposts + st.quotes, 'repost or quote');
    count(like, st.likes, st.liked ? 'unlike' : 'like');
    reply.btn.title = st.replies === 1 ? '1 reply' : st.replies ? `${st.replies} replies` : 'reply';
    rep.btn.title = st.reposts + st.quotes ? `${st.reposts} repost${st.reposts === 1 ? '' : 's'}, ${st.quotes} quote${st.quotes === 1 ? '' : 's'}` : 'repost or quote';
    like.btn.title = st.liked ? 'unlike' : 'like';
    mark.btn.title = st.bookmarked ? 'remove bookmark' : 'bookmark (only you can see these)';
    mark.btn.setAttribute('aria-label', st.bookmarked ? 'remove bookmark' : 'bookmark');
    rep.btn.classList.toggle('on', st.reposted);
    like.btn.classList.toggle('on', st.liked);
    mark.btn.classList.toggle('on', st.bookmarked);
    rep.btn.setAttribute('aria-expanded', String(!!menu));
    like.btn.setAttribute('aria-pressed', String(st.liked));
    mark.btn.setAttribute('aria-pressed', String(st.bookmarked));
    rep.btn.setAttribute('aria-pressed', String(st.reposted));
  }

  // Change the row now, ask the server, and put it back (saying why) if the server refuses. Only what this change touched
  // goes back: a like that fails mustn't undo a bookmark that went through meanwhile.
  async function flip(key, optimistic, request, commit) {
    if (!S.me) { needLogin(); return; }
    if (busy.has(key)) return;
    busy.add(key);
    const before = { ...st };
    optimistic();
    const touched = Object.keys(st).filter(k => st[k] !== before[k]);
    paint();
    try { commit(await request()); } catch (e) { for (const k of touched) st[k] = before[k]; oops(e); }
    busy.delete(key);
    paint();
  }

  const toggleRepost = () => flip('repost', () => { st.reposted = !st.reposted; st.reposts += st.reposted ? 1 : -1; },
    () => (st.reposted ? api.post(url('repost')) : api.del(url('repost'))), r => {
      st.reposted = r.reposted;
      st.reposts = r.reposts ?? st.reposts;
      toast(r.reposted ? 'reposted. your followers will see it.' : 'repost removed.');
      if (!r.reposted && opts.onUnrepost) opts.onUnrepost();
    });

  async function answer() {
    const post = await postDialog({ mode: 'reply', target: item });
    if (!post) return;
    st.replies += 1;
    paint();
    toast('reply posted! (click to view)', false, () => go(postPath(post)));
  }
  async function quote() {
    const post = await postDialog({ mode: 'quote', target: item });
    if (!post) return;
    st.quotes += 1;
    paint();
    toast('quote posted! (click to view)', false, () => go(postPath(post)));
  }

  /* ---- the ↻ menu ---- */
  let menu = null;
  const away = e => { if (menu && !menu.contains(e.target) && !rep.btn.contains(e.target)) closeMenu(); };
  const esc = e => { if (e.key === 'Escape') { closeMenu(); rep.btn.focus(); } };
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', esc);
    paint();
  }
  function openMenu() {
    menu = h('div', { class: 'ms-menu win98', role: 'menu' },
      h('button', { class: 'ms-menuitem', role: 'menuitem', type: 'button', text: st.reposted ? '↺ Undo repost' : '↻ Repost', onclick: () => { closeMenu(); toggleRepost(); } }),
      h('button', { class: 'ms-menuitem', role: 'menuitem', type: 'button', text: '✎ Quote', onclick: () => { closeMenu(); quote(); } }));
    repWrap.append(menu);
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc);
    menu.firstChild.focus();
    paint();
  }

  paint();
  row.bump = (what, n) => { st[what] += n; paint(); };       // e.g. bump('replies', 1) after a reply is written elsewhere on the page
  return row;
}
