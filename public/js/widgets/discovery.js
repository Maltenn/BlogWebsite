/* widgets/discovery.js — a card in "For you": the post or thread, a line on top that says why it's here, and quick
   buttons (Follow, View board, ✕ not interested). */

import { h } from '../core/dom.js';
import { S } from '../core/state.js';
import { postCard } from './postcard.js';
import { followButton } from './followbutton.js';
import { hideButton } from './hide.js';
import { boardPath } from './boardlinks.js';

export const REASON_ICON = { replied: '💬', friends: '👥', interest: '✨', popular: '🔥' };

// entry: { item, reason, why, relation }
export function discoveryCard(entry) {
  const it = entry.item;
  const box = h('div', { class: 'ms-disc' });
  const top = h('div', { class: 'ms-discwhy' },
    h('span', { class: 'ms-whytext', text: `${REASON_ICON[entry.reason] || '✨'} ${entry.why}` }), hideButton('post', it.id, box));
  const acts = h('div', { class: 'ms-discacts' });
  if (!S.me || it.author.id !== S.me.id) acts.append(followButton(it.author, entry.relation));
  if (it.kind === 'thread' && it.board) acts.append(h('a', { class: 'btn98', href: boardPath(it.board.slug), text: `${it.board.icon} View board` }));
  box.append(top, postCard(it), acts);
  return box;
}
