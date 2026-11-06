/* widgets/votes.js — ▲n ▼n under a thread or a comment: both counts shown, your vote pressed. A click changes the numbers
   at once and asks the server; if the server says no (self-vote, locked, rate limit) only the vote goes back, with the
   server's message. Clicking your current vote takes it back. Logged out, it asks you to log in. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';
import { S } from '../core/state.js';
import { needLogin } from '../core/router.js';

const short = n => (n >= 10000 ? Math.floor(n / 1000) + 'k' : n >= 1000 ? (Math.floor(n / 100) / 10) + 'k' : String(n));

// item: a thread or comment as the API sends it. opts.locked: the thread takes no votes; opts.archived: because its board
// is archived (it says so). Returns the element; el.state is { vote, up, down } (for tests).
export function voteBar(item, opts = {}) {
  const st = { vote: item.viewer ? item.viewer.vote : 0, up: item.counts.up, down: item.counts.down };
  const mine = !!(S.me && item.author && item.author.id === S.me.id);
  const off = opts.archived ? 'this board is archived: no more votes here' : opts.locked ? 'locked: no more votes here'
    : mine ? 'you can\'t vote on your own post' : '';
  let busy = false;
  const mk = (cls, glyph, value) => {
    const n = h('span', { class: 'bv-n' });
    const btn = h('button', { class: 'bv-btn ' + cls, type: 'button', onclick: () => cast(value) }, h('span', { class: 'bv-glyph', text: glyph, 'aria-hidden': 'true' }), n);
    return { btn, n, value };
  };
  const up = mk('up', '▲', 1);
  const down = mk('down', '▼', -1);

  function paint() {
    for (const b of [up, down]) {
      const on = st.vote === b.value;
      const count = b === up ? st.up : st.down;
      b.n.textContent = short(count);
      b.btn.classList.toggle('on', on);
      b.btn.setAttribute('aria-pressed', String(on));
      const verb = b === up ? 'like' : 'dislike';
      b.btn.setAttribute('aria-label', `${on ? 'undo ' : ''}${verb}, ${count}`);
      b.btn.title = off || (on ? `take back your ${verb}` : verb);
      b.btn.classList.toggle('is-off', !!off);
    }
  }

  async function cast(value) {
    if (!S.me) { needLogin(); return; }
    if (off) { oops(new Error(off)); return; }
    if (busy) return;
    busy = true;
    const next = st.vote === value ? 0 : value;
    const before = { ...st };
    st.up += (next === 1 ? 1 : 0) - (st.vote === 1 ? 1 : 0);
    st.down += (next === -1 ? 1 : 0) - (st.vote === -1 ? 1 : 0);
    st.vote = next;
    paint();
    try {
      const r = await api.put(`/posts/${item.id}/vote`, { value: next });
      st.vote = r.vote; st.up = r.up; st.down = r.down;
    } catch (e) {
      Object.assign(st, before);                 // only this vote goes back
      oops(e);
    }
    busy = false;
    paint();
  }

  paint();
  const el = h('span', { class: 'bv', role: 'group', 'aria-label': 'like or dislike' }, up.btn, down.btn);
  el.state = st;
  return el;
}
