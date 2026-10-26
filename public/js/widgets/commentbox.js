/* widgets/commentbox.js — the box you write a comment in: a thread's comment box at the top (a Win98 window) or the small
   reply box that opens under a comment. Up to 10,000 characters. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';

export const COMMENT_MAX = 10000;

// opts: threadId, parent (a comment id; none = top level), onPosted(comment), onCancel() (a reply box has Cancel),
// title (a window title: the top-level box), placeholder, label, button
export function commentBox(opts) {
  const ta = h('textarea', { class: 'ms-compose-text', maxLength: COMMENT_MAX, rows: opts.parent ? 3 : 4, placeholder: opts.placeholder || 'what do you think?', 'aria-label': opts.label || 'your comment' });
  const count = h('span', { class: 'ms-compose-count', text: `0/${COMMENT_MAX}` });
  const send = h('button', { class: 'btn98 go', type: 'submit', text: opts.button || 'Comment', disabled: true });
  const cancel = opts.onCancel ? h('button', { class: 'btn98', type: 'button', text: 'Cancel', onclick: () => opts.onCancel() }) : null;
  let busy = false;
  const sync = () => {
    count.textContent = `${ta.value.length}/${COMMENT_MAX}`;
    count.classList.toggle('hot', ta.value.length >= COMMENT_MAX - 200);
    send.disabled = busy || !ta.value.trim();
  };
  const submit = async () => {
    const body = ta.value.trim();
    if (!body || busy) return;
    busy = true;
    sync();
    try {
      const r = await api.post(`/threads/${opts.threadId}/comments`, opts.parent ? { body, parent: opts.parent } : { body });
      ta.value = '';
      busy = false;
      sync();
      if (opts.onPosted) opts.onPosted(r.comment);
    } catch (e) { busy = false; oops(e); sync(); }
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
  const form = h('form', { class: 'bc-box' + (opts.title ? ' ms-compose win98' : ''), onsubmit: e => { e.preventDefault(); submit(); } },
    opts.title ? h('div', { class: 'title-bar' }, h('span', { text: opts.title }), count) : null,
    h('div', { class: opts.title ? 'ms-compose-body bc-box-body' : 'bc-box-body' }, ta,
      h('div', { class: 'bc-box-btns' }, opts.title ? null : count, send, cancel)));
  form.focusText = () => { form.scrollIntoView({ block: 'center' }); ta.focus(); };
  return form;
}
