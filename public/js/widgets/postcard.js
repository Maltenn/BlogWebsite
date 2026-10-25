/* widgets/postcard.js — one status or blog post as a row, in the feed and on a profile's Statuses tab.
   (Friends' Comments and the blog's own page have their own looks.) */

import { h, userPath } from '../core/dom.js';
import { when, ago, clock } from '../core/format.js';
import { avatar, nameLink } from './people.js';
import { postActions } from './safety.js';
import { teaser } from './blogtext.js';

export const blogPath = (name, id) => userPath(name) + '/blog/' + id;

// opts.time: 'ago' ("3 hours ago", the default) or 'clock' ("9:12 PM", under a day heading). opts.onDeleted: after "delete".
export function postCard(item, opts = {}) {
  const a = item.author;
  const stamp = h('span', { class: 'ms-time', title: when(item.created), text: opts.time === 'clock' ? clock(item.created) : ago(item.created) });
  let mid;
  if (item.kind === 'blog') {
    mid = [
      h('div', null, nameLink(a), ' wrote a blog post'),
      h('a', { class: 'ms-feedtitle', href: blogPath(a.name, item.id), text: item.subject }),
      item.subtitle ? h('div', { class: 'ms-feedsub', text: item.subtitle }) : null,
      h('div', { class: 'ms-feedtext', text: teaser(item.body) }),
      h('a', { class: 'ms-readon', href: blogPath(a.name, item.id), text: 'Continue reading →' }),
    ];
  } else {
    mid = [h('div', null, nameLink(a)), h('div', { class: 'ms-feedtext', text: item.body })];
  }
  const row = h('div', { class: 'ms-feeditem', dataset: { id: item.id, created: item.created } },
    avatar(a, 40),
    h('div', { class: 'ms-feedmid' }, mid, h('div', null, stamp, postActions(item, () => { row.remove(); if (opts.onDeleted) opts.onDeleted(item); }))));
  return row;
}
