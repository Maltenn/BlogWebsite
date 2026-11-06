/* pages/post.js — a conversation (/u/name/post/123): the posts it answers above, the post itself enlarged, the reply box,
   and the replies below as flat cards. Statuses, replies and quotes have one; a blog post has its own page, with the same
   replies under "Discussion". */

import { h, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { pageTitle } from '../core/ui.js';
import { go } from '../core/router.js';
import { postCard } from '../widgets/postcard.js';
import { repliesBlock } from '../widgets/replies.js';
import { postPath } from '../widgets/postlinks.js';

export async function renderPost(root, name, idText) {
  const id = Number(idText);
  let d;
  try { d = await api.get('/posts/' + id); } catch (e) {
    if (e.status !== 404) throw e;
    root.append(pageTitle('Conversation', h('a', { class: 'btn98', href: userPath(name), text: '← ' + name })),
      h('div', { class: 'ms-error', text: e.message }));
    return;
  }
  const post = d.post;
  if (post.id !== id || post.author.name !== name || post.kind === 'blog') { go(postPath(post), true); return; }   // a repost's id opens its original; a blog post has its page

  root.append(pageTitle('Conversation', h('a', { class: 'btn98', href: userPath(post.author.name), text: '← ' + post.author.name })));
  const thread = h('div', { class: 'ms-thread-page' });
  if (d.ancestors.length) thread.append(h('div', { class: 'ms-ancestors' }, d.ancestors.map(a => postCard(a, { compact: true }))));
  let card = null;
  const replies = repliesBlock(post, d, { onCount: n => { const row = card.querySelector('.ms-acts'); if (row) row.bump('replies', n); } });
  card = postCard(post, {
    big: true,
    onReply: post.deleted ? undefined : replies.focus,
    onDeleted: (p, tombstone) => { if (tombstone) replies.closeBox(); else go(userPath(post.author.name)); },   // with replies or quotes it stays as a tombstone
  });
  thread.append(card, replies.el);
  root.append(h('div', { class: 'os-shell os-solo' }, h('div', { class: 'os-main' }, thread)));
  if (location.search.includes('reply')) setTimeout(replies.focus, 50);
}
