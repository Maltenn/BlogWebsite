/* widgets/composer.js — the "What's on your mind?" window: a box with a live counter (500 characters) and a 📷 button
   (up to 4 photos). Posts a status on Home and on your own page; with opts.url it is the reply box under a post instead. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';
import { photoPicker } from './photos.js';

export const STATUS_MAX = 500;

// opts.onPosted(answer) runs after a post. By default it posts a status ({ id, body }); the reply box sets
// opts.url ('/posts/12/replies', answer { post }), opts.title, opts.placeholder, opts.label, opts.button, opts.done
// (the toast), opts.id (the form's id) and opts.hint (a line under the box). A post may be photos alone.
export function composer(opts = {}) {
  const ta = h('textarea', { class: 'ms-compose-text', maxLength: STATUS_MAX, rows: 2, placeholder: opts.placeholder || 'update your status…', 'aria-label': opts.label || 'status' });
  const count = h('span', { class: 'ms-compose-count', text: `0/${STATUS_MAX}` });
  const post = h('button', { class: 'btn98 go', type: 'submit', text: opts.button || 'Post', disabled: true });
  const pick = photoPicker({ max: 4, onChange: () => sync() });
  const sync = () => {
    count.textContent = `${ta.value.length}/${STATUS_MAX}`;
    count.classList.toggle('hot', ta.value.length >= STATUS_MAX - 40);
    post.disabled = !(ta.value.trim() || pick.count()) || pick.busy();
  };
  const send = async () => {
    const body = ta.value.trim();
    const media = pick.media();
    if ((!body && !media.length) || pick.busy()) return;
    post.disabled = true;
    try {
      const r = await api.post(opts.url || '/status', media.length ? { body, media } : { body });
      ta.value = '';
      pick.reset();
      sync();
      toast(opts.done || 'posted!');
      if (opts.onPosted) opts.onPosted(r);
    } catch (e) { oops(e); sync(); }
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  const form = h('form', { class: 'ms-compose win98', id: opts.id || 'composer', onsubmit: e => { e.preventDefault(); send(); } },
    h('div', { class: 'title-bar' }, h('span', { text: opts.title || '✏ What\'s on your mind?' }), count),
    h('div', { class: 'ms-compose-body' }, ta, post),
    h('div', { class: 'ms-compose-photos' }, pick.el),
    opts.hint ? h('div', { class: 'os-hint ms-compose-hint', text: opts.hint }) : null);
  form.focusText = () => { form.scrollIntoView({ block: 'center' }); ta.focus(); };
  return form;
}
