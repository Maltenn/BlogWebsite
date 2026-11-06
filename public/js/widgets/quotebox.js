/* widgets/quotebox.js — a post inside a box: under a quote, in the Reply and Quote windows. It works from the post in
   brief (an item-lite: id, kind, created, subject, subtitle, body, author) or a whole item, and from { unavailable: true }
   for a post that is deleted, hidden or not yours to see. */

import { h } from '../core/dom.js';
import { ago } from '../core/format.js';
import { go } from '../core/router.js';
import { avatar, nameLink } from './people.js';
import { teaser } from './blogtext.js';
import { rich } from './richtext.js';
import { postPath } from './postlinks.js';
import { photoGrid } from './photogrid.js';

const SHORT = 280;
const cut = (s, max) => { const c = Array.from(s); return c.length > max ? c.slice(0, max).join('').trimEnd() + '…' : s; };

// opts.plain: not a link (inside a window)
export function quoteBox(q, opts = {}) {
  if (!q || q.unavailable) return h('div', { class: 'ms-quotebox gone', text: 'this post is unavailable.' });
  if (q.deleted) return h('div', { class: 'ms-quotebox gone', text: 'this post was deleted.' });
  const blog = q.kind === 'blog';
  const box = h('div', { class: 'ms-quotebox' + (opts.plain ? '' : ' is-link') },
    h('div', { class: 'ms-quotehead' }, ...(opts.plain
      ? [h('img', { class: 'ms-avatar', src: q.author.avatar, alt: '', width: 20, height: 20 }), h('b', { text: q.author.name })]
      : [avatar(q.author, 20), nameLink(q.author)]), h('span', { class: 'ms-time', text: ago(q.created) })),
    blog ? h('div', { class: 'ms-quotetitle', text: q.subject }) : null,
    blog && q.subtitle ? h('div', { class: 'ms-feedsub', text: q.subtitle }) : null,
    blog && q.cover ? photoGrid([q.cover], { cover: true, small: true }) : null,
    q.body ? h('div', { class: 'ms-quotetext' }, blog ? teaser(q.body, 160) : opts.plain ? cut(q.body, SHORT) : rich(cut(q.body, SHORT), [])) : null,
    blog ? null : photoGrid(q.media, { small: true }));
  if (!opts.plain) {
    const path = postPath(q);
    box.addEventListener('click', e => { if (!e.target.closest('a, button')) go(path); });
  }
  return box;
}
