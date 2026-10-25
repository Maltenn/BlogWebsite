/* widgets/postdialog.js — the Reply and Quote windows: a Win98 dialog with a 500-character box and the post being
   answered (above the box) or quoted (below it). */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';
import { STATUS_MAX } from './composer.js';
import { quoteBox } from './quotebox.js';

// mode: 'reply' | 'quote'. target: the post being answered or quoted. Resolves to the new post, or null if it was cancelled.
export function postDialog({ mode, target }) {
  return new Promise(resolve => {
    const reply = mode === 'reply';
    const title = reply ? `Reply to ${target.author.name}` : 'Quote this post';
    const ta = h('textarea', { class: 'ms-compose-text', maxLength: STATUS_MAX, rows: 4, 'aria-label': reply ? 'your reply' : 'your comment',
      placeholder: reply ? 'write your reply…' : 'add your thoughts…' });
    const count = h('span', { class: 'ms-compose-count', text: `0/${STATUS_MAX}` });
    const send = h('button', { class: 'btn98 go', type: 'button', text: reply ? 'Reply' : 'Post quote', disabled: true });
    const cancel = h('button', { class: 'btn98', type: 'button', text: 'Cancel' });
    const context = h('div', { class: 'ms-postdialog-context' },
      h('div', { class: 'os-hint', text: reply ? `replying to ${target.author.name}:` : 'you are quoting:' }), quoteBox(target, { plain: true }));
    const modal = h('div', { class: 'ms-modal' },
      h('div', { class: 'ms-dialog ms-postdialog win98', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'title-bar' }, h('span', { text: title }), h('button', { class: 'btn98', type: 'button', 'aria-label': 'close', text: '✕', onclick: () => done(null) })),
        h('div', { class: 'ms-postdialog-body' }, reply ? context : null, ta, h('div', { class: 'ms-postdialog-count' }, count), reply ? null : context),
        h('div', { class: 'ms-dialog-btns' }, send, cancel)));
    let busy = false;
    const done = v => { if (busy) return; modal.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape') done(null); };
    const sync = () => {
      count.textContent = `${ta.value.length}/${STATUS_MAX}`;
      count.classList.toggle('hot', ta.value.length >= STATUS_MAX - 40);
      send.disabled = busy || !ta.value.trim();
    };
    const submit = async () => {
      const body = ta.value.trim();
      if (!body || busy) return;
      busy = true;
      sync();
      try {
        const r = await api.post(`/posts/${target.id}/${reply ? 'replies' : 'quote'}`, { body });
        busy = false;
        done(r.post);
      } catch (e) { busy = false; oops(e); sync(); }
    };
    ta.addEventListener('input', sync);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    send.addEventListener('click', submit);
    cancel.addEventListener('click', () => done(null));
    modal.addEventListener('mousedown', e => { if (e.target === modal && !ta.value.trim()) done(null); });
    document.addEventListener('keydown', key);
    document.body.append(modal);
    ta.focus();
  });
}
