/* widgets/composer.js — the "What's on your mind?" window: a status box with a live counter (500 characters).
   Used on Home and on your own page. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';

const STATUS_MAX = 500;

// opts.onPosted({ id, body }) runs after a status is posted
export function composer(opts = {}) {
  const ta = h('textarea', { class: 'ms-compose-text', maxLength: STATUS_MAX, rows: 2, placeholder: 'update your status…', 'aria-label': 'status' });
  const count = h('span', { class: 'ms-compose-count', text: `0/${STATUS_MAX}` });
  const post = h('button', { class: 'btn98 go', type: 'submit', text: 'Post', disabled: true });
  const sync = () => {
    count.textContent = `${ta.value.length}/${STATUS_MAX}`;
    count.classList.toggle('hot', ta.value.length >= STATUS_MAX - 40);
    post.disabled = !ta.value.trim();
  };
  const send = async () => {
    const body = ta.value.trim();
    if (!body) return;
    post.disabled = true;
    try {
      const r = await api.post('/status', { body });
      ta.value = '';
      sync();
      toast('posted!');
      if (opts.onPosted) opts.onPosted(r);
    } catch (e) { oops(e); sync(); }
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  const form = h('form', { class: 'ms-compose win98', id: 'composer', onsubmit: e => { e.preventDefault(); send(); } },
    h('div', { class: 'title-bar' }, h('span', { text: '✏ What\'s on your mind?' }), count),
    h('div', { class: 'ms-compose-body' }, ta, post));
  form.focusText = () => { form.scrollIntoView({ block: 'center' }); ta.focus(); };
  return form;
}
