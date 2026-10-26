/* widgets/comments.js — a thread's comments, nested the way a forum does it. Each reply sits 14px in under a 2px rail;
   the [−] (or a click on the rail) folds a comment and everything under it to [+n]. Below the depth cap (6 levels on a
   desktop, 3 on a phone) the replies are behind "Continue this thread →", which opens that comment as the top of its own
   view (?c=id). Where the server cut a list short there is "Load more replies (n)". A deleted comment that still has
   replies stays as [deleted]. Built with createElement and textContent only. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { ago, when } from '../core/format.js';
import { toast, oops } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, needLogin } from '../core/router.js';
import { avatar, nameLink } from './people.js';
import { postActions } from './safety.js';
import { rich } from './richtext.js';
import { voteBar } from './votes.js';
import { commentBox } from './commentbox.js';
import { threadPath } from './boardlinks.js';

export const depthCap = () => (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 760px)').matches ? 3 : 6);

// thread: the thread's item. nodes: the tree the API sent ([{ item, children } | { more, parent, after }]).
// opts.sort: best|new|old (for "load more"). opts.onCount(n): comments were added (+) or deleted (−) here. opts.max: the depth cap.
// Returns { el, addTop(comment), root(item, nodes) }. A comment already on the page is never drawn twice (a "load more"
// answer can hold your own new reply, already shown).
export function commentTree(thread, nodes, opts = {}) {
  const max = opts.max || depthCap();
  const locked = !!thread.locked || !!(thread.board && thread.board.archived);   // no comments, replies or votes
  const shown = new Set();                                                       // the comment ids on the page
  const sort = opts.sort || 'best';
  const base = threadPath(thread.board.slug, thread.id);
  const list = h('div', { class: 'bc-list' });
  const empty = h('div', { class: 'ms-empty', text: 'no comments yet. be the first!' });

  const bump = n => { if (opts.onCount) opts.onCount(n); };
  const sync = () => { empty.classList.toggle('is-hidden', !!list.children.length); };

  // the siblings under one parent go into `box`, at `depth`
  function fill(box, items, depth) {
    for (const n of items) {
      if (n.more == null && shown.has(n.item.id)) continue;
      box.append(n.more != null ? moreButton(n, depth) : comment(n, depth));
    }
  }

  function moreButton(n, depth) {
    const btn = h('button', { class: 'btn98 bc-more', type: 'button', text: `Load more replies (${n.more})`, dataset: { more: n.more } });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.get(`/threads/${thread.id}/comments/${n.parent}?sort=${sort}${n.after ? '&after=' + encodeURIComponent(n.after) : ''}`);
        const box = btn.parentNode;
        btn.remove();
        fill(box, r.comments, depth);
        sync();
      } catch (e) { oops(e); btn.disabled = false; }
    });
    return btn;
  }

  // a new comment goes to the top of its siblings (after the rail, if the box has one)
  function prependTo(box, el) {
    const all = [...box.children];
    const rail = all.find(k => k.classList.contains('bc-rail'));
    const rest = all.filter(k => k !== rail);
    box.replaceChildren(...[rail, el, ...rest].filter(Boolean));
  }

  function comment(node, depth) {
    const c = node.item;
    shown.add(c.id);
    const el = h('div', { class: 'bc-comment', dataset: { id: c.id } });
    const head = h('div', { class: 'bc-head' });
    const main = h('div', { class: 'bc-main' });
    const kids = h('div', { class: 'bc-kids' });
    const toggle = h('button', { class: 'bc-toggle', type: 'button' });
    const slot = h('div', { class: 'bc-slot' });
    kids.append(h('button', { class: 'bc-rail', type: 'button', 'aria-label': 'fold this comment and its replies', onclick: () => fold(true) }));

    const below = () => el.querySelectorAll('.bc-comment').length + [...el.querySelectorAll('.bc-more')].reduce((n, m) => n + Number(m.dataset.more || 0), 0);
    function fold(on) {
      el.classList.toggle('is-folded', on);
      const n = on ? below() : 0;
      toggle.textContent = on ? (n ? `[+${n}]` : '[+]') : '[−]';
      toggle.setAttribute('aria-expanded', String(!on));
      toggle.title = on ? 'unfold' : 'fold this comment and its replies';
    }
    toggle.addEventListener('click', () => fold(!el.classList.contains('is-folded')));

    const continueLink = () => {
      if (!kids.querySelector('.bc-continue')) kids.append(h('a', { class: 'bc-continue', href: `${base}?c=${c.id}`, text: 'Continue this thread →' }));
    };

    function draw() {
      const gone = c.deleted;
      const op = !gone && c.author && thread.author && c.author.id === thread.author.id;
      head.replaceChildren(...[toggle,
        gone ? h('span', { class: 'ms-gone', text: '[deleted]' }) : [avatar(c.author, 22), nameLink(c.author), op ? h('span', { class: 'ms-chip bc-op', title: 'started this thread', text: 'OP' }) : null],
        gone ? null : h('a', { class: 'ms-time', href: `${base}?c=${c.id}`, title: when(c.created), text: ago(c.created) })].flat().filter(Boolean));
      if (gone) { main.replaceChildren(); return; }
      main.replaceChildren(
        h('div', { class: 'bc-body' }, rich(c.body, c.mentions, { tags: false })),
        h('div', { class: 'bc-acts' }, voteBar(c, { locked, archived: !!(thread.board && thread.board.archived) }),
          locked ? null : h('a', { href: '#', class: 'bc-replylink', text: 'Reply', onclick: e => { e.preventDefault(); openReply(); } }),
          postActions(c, r => {
            bump(-1);
            if (r.tombstone) { c.deleted = true; slot.replaceChildren(); draw(); } else { el.remove(); sync(); }
          })),
        slot);
    }

    function openReply() {
      if (!S.me) { needLogin(); return; }
      if (slot.children.length) { slot.querySelector('textarea').focus(); return; }
      const box = commentBox({
        threadId: thread.id, parent: c.id, placeholder: `reply to ${c.author ? c.author.name : 'this comment'}…`, label: 'your reply', button: 'Reply',
        onCancel: () => slot.replaceChildren(),
        onPosted: made => {
          slot.replaceChildren();
          bump(1);
          fold(false);
          if (depth + 1 >= max) {                     // too deep to show here: it is one click away
            continueLink();
            toast('reply posted! (click to view)', false, () => go(`${base}?c=${c.id}`));
            return;
          }
          prependTo(kids, comment({ item: made, children: [] }, depth + 1));
        },
      });
      slot.append(box);
      box.focusText();
    }

    draw();
    if (depth + 1 >= max) { if ((node.children || []).length) continueLink(); }   // below the cap the replies are one click away
    else fill(kids, node.children || [], depth + 1);
    fold(false);
    el.append(head, main, kids);
    return el;
  }

  fill(list, nodes, 0);
  sync();
  const el = h('div', { class: 'bc-tree' }, list, empty);
  return {
    el,
    // your own new top-level comment goes first
    addTop(made) {
      bump(1);
      prependTo(list, comment({ item: made, children: [] }, 0));
      sync();
    },
    // one comment and its replies as the top of the view (the ?c= page)
    root(parentItem, kidsNodes) {
      list.replaceChildren(comment({ item: parentItem, children: kidsNodes }, 0));
      sync();
    },
  };
}
