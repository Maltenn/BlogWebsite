/* widgets/replies.js — the replies under a post: the reply box (a Win98 window, 500 characters), the replies as flat
   cards oldest first with "Replying to @name", and "show more replies" while the server has more. Under a conversation's
   post, and under a blog post as its Discussion. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';
import { S } from '../core/state.js';
import { composer } from './composer.js';
import { postCard } from './postcard.js';

// post: the item the replies are under. first: GET /api/posts/:id's { replies, next }. opts.direct: leave out "Replying to"
// on direct replies (the blog's Discussion). opts.onCount(n): n replies were added by this person just now.
// Returns { el, focus() }.
export function repliesBlock(post, first, opts = {}) {
  const list = h('div', { class: 'ms-replylist' });
  const note = h('div', { class: 'ms-empty', text: 'no replies yet.' });
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more replies ▾', hidden: true });
  const seen = new Set();
  let next = first.next;

  const add = p => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    note.hidden = true;
    list.append(postCard(p, { directTo: opts.direct ? post.id : undefined }));
  };

  let box = null;
  if (post.deleted) box = h('div', { class: 'ms-note', text: 'this post was deleted, so there\'s nothing to reply to. the replies stay.' });
  else if (S.me) {
    box = composer({ id: 'reply-box', title: `💬 Reply to ${post.author.name}`, placeholder: 'write your reply…', label: 'your reply', button: 'Reply',
      url: `/posts/${post.id}/replies`, done: 'reply posted!', hint: 'replies and @mentions: @name links to their page, #tag to the tag.',
      onPosted: r => { add(r.post); if (opts.onCount) opts.onCount(1); } });
  } else {
    box = h('div', { class: 'ms-note' }, h('a', { href: '/login?next=' + enc(location.pathname), text: 'log in' }), ' (or ', h('a', { href: '/join', text: 'join' }), ') to reply.');
  }

  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const r = await api.get(`/posts/${post.id}?after=${enc(next)}`);
      r.replies.forEach(add);
      next = r.next;
      more.hidden = !next;
    } catch (e) { oops(e); }
    more.disabled = false;
  });

  first.replies.forEach(add);
  note.hidden = seen.size > 0;
  more.hidden = !next;
  const el = h('div', { class: 'ms-replies' }, box, list, note, more);
  return {
    el,
    focus: () => { if (box.focusText) box.focusText(); else box.scrollIntoView({ block: 'center' }); },
    // the post was just deleted (it stays as a tombstone, with its replies): nothing to answer any more
    closeBox: () => { const note = h('div', { class: 'ms-note', text: 'this post was deleted, so there\'s nothing to reply to. the replies stay.' }); box.replaceWith(note); box = note; },
  };
}
