/* widgets/threaddialog.js — the New Thread window: a Win98 dialog with a title (120 characters) and the words (10,000). */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';

export const SUBJECT_MAX = 120;
export const THREAD_MAX = 10000;

// board: { slug, name, icon }. Resolves to the new thread (an item), or null if it was cancelled.
export function threadDialog({ board }) {
  return new Promise(resolve => {
    const title = `New thread in ${board.name}`;
    const subject = h('input', { class: 'os-input', maxLength: SUBJECT_MAX, placeholder: 'title', 'aria-label': 'thread title' });
    const ta = h('textarea', { class: 'ms-compose-text', maxLength: THREAD_MAX, rows: 8, placeholder: 'what do you want to talk about?', 'aria-label': 'thread text' });
    const count = h('span', { class: 'ms-compose-count', text: `0/${THREAD_MAX}` });
    const send = h('button', { class: 'btn98 go', type: 'button', text: 'Post thread', disabled: true });
    const cancel = h('button', { class: 'btn98', type: 'button', text: 'Cancel' });
    const modal = h('div', { class: 'ms-modal' },
      h('div', { class: 'ms-dialog ms-postdialog bd-threaddialog win98', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'title-bar' }, h('span', { text: title }), h('button', { class: 'btn98', type: 'button', 'aria-label': 'close', text: '✕', onclick: () => done(null) })),
        h('div', { class: 'ms-postdialog-body' }, subject, ta, h('div', { class: 'ms-postdialog-count' }, count),
          h('div', { class: 'os-hint', text: 'threads and comments in boards are public: everybody can read them, even if your page is private. @name and #tag link.' })),
        h('div', { class: 'ms-dialog-btns' }, send, cancel)));
    let busy = false;
    const done = v => { if (busy) return; modal.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape') done(null); };
    const sync = () => {
      count.textContent = `${ta.value.length}/${THREAD_MAX}`;
      count.classList.toggle('hot', ta.value.length >= THREAD_MAX - 200);
      send.disabled = busy || !ta.value.trim() || !subject.value.trim();
    };
    const submit = async () => {
      if (busy || send.disabled) return;
      busy = true;
      sync();
      try {
        const r = await api.post(`/boards/${board.slug}/threads`, { subject: subject.value.trim(), body: ta.value.trim() });
        busy = false;
        done(r.thread);
      } catch (e) { busy = false; oops(e); sync(); }
    };
    subject.addEventListener('input', sync);
    ta.addEventListener('input', sync);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    send.addEventListener('click', submit);
    cancel.addEventListener('click', () => done(null));
    modal.addEventListener('mousedown', e => { if (e.target === modal && !ta.value.trim() && !subject.value.trim()) done(null); });
    document.addEventListener('keydown', key);
    document.body.append(modal);
    subject.focus();
  });
}
