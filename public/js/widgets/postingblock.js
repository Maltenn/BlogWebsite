/* widgets/postingblock.js — what a box for public posting shows while a posting timeout (an AI-writing strike) runs: the
   time it ends, in place of the box. Reading, liking and chat go on. */

import { h } from '../core/dom.js';
import { S } from '../core/state.js';
import { when } from '../core/format.js';

// → an element to show instead of a composer, or null when nothing is stopping the member from posting
export function postingBlock() {
  const until = S.me && S.account && S.account.timeoutUntil;
  if (!until || until <= Date.now()) return null;
  const note = h('div', { class: 'ms-note ms-timeout', dataset: { kind: 'timeout' } },
    h('b', { text: '⏸ posting is paused until ' + when(until) + '. ' }),
    'a post of yours was flagged as likely written by an AI. you can still read, like, follow and chat. ',
    h('a', { href: '/me/strikes', text: 'see what happened (and appeal)' }), '.');
  note.focusText = () => {};
  return note;
}
