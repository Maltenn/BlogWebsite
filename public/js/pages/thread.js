/* pages/thread.js — a thread (/boards/cooking/42): the post, ▲n ▼n, the comment box and the nested comments. With ?c=id it
   shows one comment and what's under it as the top of the view ("Continue this thread"). Moderators get Pin and Lock. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { oops, pageTitle, toast } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { postActions } from '../widgets/safety.js';
import { rich } from '../widgets/richtext.js';
import { voteBar } from '../widgets/votes.js';
import { commentBox } from '../widgets/commentbox.js';
import { commentTree } from '../widgets/comments.js';
import { boardPath, threadPath } from '../widgets/boardlinks.js';
import { photoGrid } from '../widgets/photogrid.js';

const SORTS = [['best', 'Best'], ['new', 'New'], ['old', 'Old']];

export async function renderBoardThread(root, slug, idText) {
  const id = Number(idText);
  const params = new URLSearchParams(location.search);
  const sort = SORTS.some(([k]) => k === params.get('sort')) ? params.get('sort') : 'best';
  const one = Number(params.get('c')) || null;                  // ?c=: one comment and its replies
  let d;
  try { d = await api.get(`/threads/${id}?sort=${sort}`); } catch (e) {
    if (e.status !== 404) throw e;
    root.append(pageTitle('Thread', h('a', { class: 'btn98', href: boardPath(slug), text: '← board' })), h('div', { class: 'ms-error', text: 'that thread isn\'t here (it was deleted, or you can\'t see it).' }));
    return;
  }
  const t = d.thread;
  const archived = !!t.board.archived;                          // an archived board: readable, nothing new
  const base = threadPath(t.board.slug, t.id);
  if (t.board.slug !== slug) { go(base + location.search, true); return; }
  if (one === t.id) { go(base, true); return; }
  let sub = null;
  if (one) {
    try { sub = await api.get(`/threads/${id}/comments/${one}?sort=${sort}`); } catch (e) {
      if (e.status !== 404) throw e;
      root.append(pageTitle(`${t.board.icon} ${t.board.name}`, h('a', { class: 'btn98', href: base, text: '← the thread' })), h('div', { class: 'ms-error', text: 'that comment isn\'t here (it was deleted, or you can\'t see it).' }));
      return;
    }
  }

  root.append(pageTitle(`${t.board.icon} ${t.board.name}`, h('a', { class: 'btn98', href: boardPath(t.board.slug), text: '← ' + t.board.name })));
  const page = h('div', { class: 'ms-thread-page bt-page' });
  const countText = h('span', { class: 'bt-count' });
  const paintCount = () => { countText.textContent = `💬 ${t.counts.comments} comment${t.counts.comments === 1 ? '' : 's'}`; };
  paintCount();

  /* ---- the post ---- */
  const post = h('div', { class: 'bt-thread' });
  if (t.deleted) {
    post.append(h('h1', { class: 'bt-title ms-gone', text: '[deleted]' }), h('div', { class: 'bt-body ms-gone', text: 'this thread was deleted. the comments stay.' }));
  } else {
    post.append(
      h('h1', { class: 'bt-title' }, t.sticky ? h('span', { class: 'bt-flag', title: 'pinned by a moderator', text: '📌 ' }) : null, t.locked ? h('span', { class: 'bt-flag', title: 'locked', text: '🔒 ' }) : null, t.subject),
      h('div', { class: 'bt-by' }, avatar(t.author, 32), h('span', null, nameLink(t.author), h('div', { class: 'ms-time', text: when(t.created) }))),
      ...[t.body ? h('div', { class: 'bt-body' }, rich(t.body, t.mentions)) : null, photoGrid(t.media)].filter(Boolean),
      h('div', { class: 'bt-acts' }, voteBar(t, { locked: t.locked || archived, archived }), countText,
        postActions(t, r => { if (r.tombstone) route(); else go(boardPath(t.board.slug)); })));
    if (S.me && S.me.isAdmin) {
      const mod = async (body, said) => { try { await api.post('/admin/threads/' + t.id, body); toast(said); route(); } catch (e) { oops(e); } };
      post.append(h('div', { class: 'bt-mod' }, h('b', { text: 'moderator: ' }),
        h('button', { class: 'btn98', type: 'button', text: t.sticky ? '📌 Unpin' : '📌 Pin to top', onclick: () => mod({ sticky: !t.sticky }, t.sticky ? 'unpinned.' : 'pinned.') }),
        h('button', { class: 'btn98', type: 'button', text: t.locked ? '🔓 Unlock' : '🔒 Lock', onclick: () => mod({ locked: !t.locked }, t.locked ? 'unlocked.' : 'locked.') })));
    }
  }
  page.append(post);
  if (archived && !t.deleted) page.append(h('div', { class: 'ms-note bt-locked', text: '🗄️ this board is archived: you can read it, but no new comments or votes.' }));
  else if (t.locked && !t.deleted) page.append(h('div', { class: 'ms-note bt-locked', text: '🔒 this thread is locked: no new comments or votes.' }));

  /* ---- the comments ---- */
  const tree = commentTree(t, sub ? [] : d.comments, { sort, onCount: n => { t.counts.comments += n; paintCount(); } });
  const bar = h('div', { class: 'bt-bar' },
    h('h2', { class: 'bt-h2', text: sub ? 'one comment' : 'Comments' }),
    sub ? h('a', { class: 'btn98', href: base + (sort === 'best' ? '' : '?sort=' + sort), text: '← all comments' }) : h('div', { class: 'ms-feedbar bt-sorts', role: 'group', 'aria-label': 'sort comments' },
      SORTS.map(([k, label]) => h('a', { class: 'btn98' + (k === sort ? ' on' : ''), href: `${base}?sort=${k}`, 'aria-current': k === sort ? 'true' : null, text: label }))));

  let box = null;
  if (!sub) {
    if (t.deleted) box = h('div', { class: 'ms-note', text: 'this thread was deleted, so there\'s nothing to comment on.' });
    else if (!t.locked && !archived) {
      box = S.me
        ? commentBox({ threadId: t.id, title: `💬 Comment on this thread`, button: 'Comment', onPosted: made => tree.addTop(made) })
        : h('div', { class: 'ms-note' }, h('a', { href: '/login?next=' + encodeURIComponent(location.pathname), text: 'log in' }), ' (or ', h('a', { href: '/join', text: 'join' }), ') to comment and vote.');
    }
  }
  page.append(bar);
  if (box) page.append(h('div', { class: 'bt-boxwrap' }, box));
  if (sub) {
    tree.root(sub.parent, sub.comments);
    page.append(h('div', { class: 'ms-note', text: 'you are looking at one comment and the replies under it.' }));
  }
  page.append(tree.el);
  root.append(h('div', { class: 'os-shell os-solo' }, h('div', { class: 'os-main' }, page)));
}
