/* pages/notifications.js — the Notifications tab: follow requests waiting on you (Accept / Decline) at the top, then what
   happened, newest first: likes, replies, reposts, quotes, @mentions, comments on your page, follows. Unread ones are
   highlighted; likes or reposts of the same post that come one after another are one line ("kat and 3 others liked your
   post"). Opening the page moves your notifications marker to the newest one shown, which clears the badge. */

import { h, enc, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { ago, when } from '../core/format.js';
import { toast, oops, pageTitle, errorCard } from '../core/ui.js';
import { loadMe } from '../core/state.js';
import { go } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { postPath } from '../widgets/postlinks.js';
import { boardPath, threadPath } from '../widgets/boardlinks.js';

const GROUPED = ['like', 'repost'];                       // one after another about the same post: one line

// a post's kind as "your ___"
const what = p => (!p ? 'post' : p.kind === 'blog' ? 'blog post' : p.kind === 'reply' ? 'reply' : p.kind === 'quote' ? 'quote' : p.kind === 'thread' ? 'thread' : p.kind === 'comment' ? 'comment' : 'post');
const snippet = (p, max = 140) => {
  if (!p) return '';
  const text = p.kind === 'blog' || p.kind === 'thread' ? p.subject || '' : p.body || '';
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() + '…' : chars.join('');
};

// where a notification leads: the post, the page it's on, or the person
function target(n) {
  const p = n.post;
  if (n.kind === 'follow_request') return '/requests';
  if (n.kind === 'board_approved') return n.request && n.request.board ? boardPath(n.request.board.slug) : '/boards';
  if (n.kind === 'board_declined') return '/boards';
  if (p && p.board) return threadPath(p.board.slug, p.threadId);              // a board thread or comment: the thread it is in
  if (!p) return userPath(n.actor.name);
  if (p.kind === 'wall') return userPath(p.page ? p.page.name : n.actor.name) + '/comments';
  return postPath(p);
}

// "kat", "kat and jules", "kat and 3 others"
function names(actors) {
  const first = nameLink(actors[0]);
  if (actors.length === 1) return [first];
  if (actors.length === 2) return [first, ' and ', nameLink(actors[1])];
  return [first, ` and ${actors.length - 1} others`];
}

// what the line says after the names
function verb(g) {
  const n = g.items[0], p = n.post;
  switch (n.kind) {
    case 'like': return `liked your ${what(p)}`;
    case 'repost': return `reposted your ${what(p)}`;
    case 'reply': return p && p.board ? `replied to you in ${p.board.name}` : 'replied to your post';
    case 'quote': return 'quoted your post';
    case 'board_approved': return `approved your board request: ${n.request ? n.request.name : 'a new board'}`;
    case 'board_declined': return `declined your board request: ${n.request ? n.request.name : ''}`;
    case 'mention': return p && p.board ? `mentioned you in ${p.board.name}` : p && p.kind === 'wall' ? `mentioned you in a comment${p.page ? ` on ${p.page.name}'s page` : ''}` : p && p.kind === 'blog' ? 'mentioned you in a blog post' : 'mentioned you';
    case 'comment': return 'left a comment on your page';
    case 'follow': return 'followed you';
    case 'follow_request': return 'asked to follow you';
    case 'follow_accepted': return 'accepted your follow request';
    default: return 'did something';
  }
}

// one line (a group of one or more notifications)
function line(g) {
  const newest = g.items[0];
  const actors = [];
  for (const n of g.items) if (!actors.some(a => a.id === n.actor.id)) actors.push(n.actor);
  const unread = g.items.some(n => n.unread);
  const path = target(newest);
  const row = h('div', { class: 'ms-note-row ms-clickable' + (unread ? ' unread' : ''), dataset: { kind: newest.kind },
    onclick: e => { if (!e.target.closest('a')) go(path); } },
  h('div', { class: 'ms-note-av' }, actors.slice(0, 5).map(a => avatar(a, actors.length > 1 ? 28 : 40))),
  h('div', { class: 'ms-note-mid' },
    h('div', { class: 'ms-note-text' }, names(actors), ' ', h('a', { href: path, text: verb(g) }), unread ? h('span', { class: 'ms-chip ms-newchip', text: 'new' }) : null),
    newest.post ? h('div', { class: 'ms-preview ms-note-snippet', text: snippet(newest.post) }) : null),
  h('span', { class: 'ms-time', title: when(newest.created), text: ago(newest.created) }));
  return row;
}

export async function renderNotifications(root) {
  const [d, q] = await Promise.all([api.get('/notifications'), api.get('/requests').catch(() => ({ incoming: [] }))]);
  root.append(pageTitle('Notifications', h('a', { class: 'btn98', href: '/requests', text: 'follow requests' })));

  /* ---- follow requests waiting on you ---- */
  const waiting = new Set(q.incoming.map(r => r.user.id));
  if (q.incoming.length) {
    const title = h('div', { class: 'ms-boxtitle' });
    const box = h('div', { class: 'ms-section ms-reqbox' }, title);
    const count = () => {
      const n = box.querySelectorAll('.ms-reqrow').length;
      if (!n) box.remove();
      title.replaceChildren(`👋 Follow requests (${n}) `, h('span', { class: 'ms-boxsub' }, '[', h('a', { href: '/requests', text: 'see all' }), ']'));
    };
    q.incoming.forEach(r => {
      const act = (fn, then) => async () => {
        try { await fn(); row.remove(); count(); toast(then); await loadMe(); } catch (e) { oops(e); }
      };
      const row = h('div', { class: 'ms-reqrow' }, avatar(r.user),
        h('div', { class: 'ms-reqmid' }, nameLink(r.user), ' asked to follow you', h('div', { class: 'ms-time', text: ago(r.created) })),
        h('button', { class: 'btn98 go', type: 'button', text: '✔ Accept', onclick: act(() => api.post('/followers/' + enc(r.user.name)), `${r.user.name} follows you now.`) }),
        h('button', { class: 'btn98', type: 'button', text: 'Decline', onclick: act(() => api.del('/followers/' + enc(r.user.name)), 'request declined.') }));
      box.append(row);
    });
    count();
    root.append(box);
  }

  /* ---- what happened ---- */
  const list = h('div', { class: 'ms-notes' });
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more ▾', hidden: true });
  root.append(list, more);
  const groups = [];                                       // { items: [notification, newest first], el }
  let next = d.next;

  const add = items => {
    for (const n of items) {
      if (n.kind === 'follow_request' && waiting.has(n.actor.id)) continue;      // it's up there with Accept and Decline
      const last = groups[groups.length - 1];
      if (last && GROUPED.includes(n.kind) && last.items[0].kind === n.kind && last.items[0].post && n.post && last.items[0].post.id === n.post.id) {
        last.items.push(n);
        const el = line(last);
        last.el.replaceWith(el);
        last.el = el;
        continue;
      }
      const g = { items: [n] };
      g.el = line(g);
      groups.push(g);
      list.append(g.el);
    }
    if (!groups.length) list.replaceChildren(h('div', { class: 'ms-empty', text: waiting.size ? 'nothing else yet.' : 'nothing yet. likes, replies, reposts, @mentions, comments and new followers show up here.' }));
  };
  add(d.items);
  more.hidden = !next;
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const r = await api.get('/notifications?before=' + enc(next));
      next = r.next;
      add(r.items);
      more.hidden = !next;
    } catch (e) { list.append(errorCard(e)); more.hidden = true; }
    more.disabled = false;
  });

  /* ---- you've seen them now ---- */
  const newest = d.items[0];
  if (newest && (newest.unread || d.unread)) {
    api.put('/me/markers/notifications', { created: newest.created, id: newest.id }).then(() => loadMe()).catch(() => { /* try again next visit */ });
  }
}
