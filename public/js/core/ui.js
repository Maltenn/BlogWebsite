/* core/ui.js — toasts, the Win98 message box, page titles, error cards,
   "show more" paging and profile skins. */

import { h, $ } from './dom.js';

export function toast(text, bad = false, onclick = null) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status', text });
  if (onclick) { t.style.cursor = 'pointer'; t.addEventListener('click', () => { onclick(); t.remove(); }); }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 5000);
}
export const oops = e => toast(e && e.message ? e.message : String(e), true);

// a Win98 message box. Resolves true (OK) / false (Cancel). opts.body = extra element(s) inside.
export function dialog({ title, text, icon = '❔', ok = 'OK', cancel = 'Cancel', danger = false, body = null }) {
  return new Promise(resolve => {
    const okBtn = h('button', { class: 'btn98' + (danger ? ' danger' : ''), type: 'button', text: ok });
    const cancelBtn = cancel ? h('button', { class: 'btn98', type: 'button', text: cancel }) : null;
    const modal = h('div', { class: 'ms-modal' },
      h('div', { class: 'ms-dialog win98', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'title-bar' }, h('span', { text: title }), h('button', { class: 'btn98', type: 'button', 'aria-label': 'close', text: '✕', onclick: () => done(false) })),
        h('div', { class: 'ms-dialog-body' }, h('div', { class: 'ms-dialog-icon', text: icon }), h('div', null, text ? h('p', { text }) : null, body)),
        h('div', { class: 'ms-dialog-btns' }, okBtn, cancelBtn)));
    const done = v => { modal.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape') done(false); };
    okBtn.addEventListener('click', () => done(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => done(false));
    modal.addEventListener('click', e => { if (e.target === modal) done(false); });
    document.addEventListener('keydown', key);
    document.body.append(modal);
    okBtn.focus();
  });
}

// a profile's colors / background tile / font, with a translucent plate under the boxes so tiles stay readable
export function skin(el, p) {
  const th = p.theme || { bg: '#ffffff', fg: '#000000', accent: '#6699cc' };
  el.style.backgroundColor = th.bg;
  if (p.bgTile) { el.style.backgroundImage = `url("${p.bgTile}")`; el.style.backgroundRepeat = 'repeat'; }
  el.style.color = th.fg;
  el.style.setProperty('--ms-accent', th.accent);
  const hex = String(th.bg || '#000').replace('#', '');
  const lum = hex.length >= 6 ? parseInt(hex.slice(0, 2), 16) * 0.299 + parseInt(hex.slice(2, 4), 16) * 0.587 + parseInt(hex.slice(4, 6), 16) * 0.114 : 0;
  el.style.setProperty('--ms-panel', lum < 128 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.88)');
  if (p.font) el.style.fontFamily = p.font;
}

export function pageTitle(text, ...tools) {
  return h('div', { class: 'ms-pagetitle' }, h('span', { text }), tools.length ? h('span', { class: 'ms-right-tools' }, tools) : null);
}
export function errorCard(e) {
  return h('div', { class: 'ms-error', text: e.status === 404 ? 'nobody by that name lives here (or they\'ve moved away).' : e.message });
}
// "show more" paging: load(cursor) → { items, next }; draw(item) → element
export async function paged(root, load, draw, empty) {
  const list = h('div');
  root.append(list);
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more ▾' });
  let cursor = null;
  const step = async () => {
    more.disabled = true;
    try {
      const r = await load(cursor);
      r.items.forEach(i => list.append(draw(i)));
      cursor = r.next;
      if (!list.children.length) list.append(h('div', { class: 'ms-empty', text: empty }));
      more.hidden = !cursor;
    } catch (e) { list.append(errorCard(e)); more.hidden = true; }
    more.disabled = false;
  };
  more.addEventListener('click', step);
  root.append(more);
  await step();
}
