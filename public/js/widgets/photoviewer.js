/* widgets/photoviewer.js — the picture viewer: a Win98 window with one photo, its description underneath, ◀ ▶ between a
   post's photos (the arrow keys too, or a swipe) and Esc to close. */

import { h } from '../core/dom.js';

// media: [{ url, width, height, alt }]. start: the one to show first.
export function openViewer(media, start = 0) {
  const list = media.filter(m => m && m.url);
  if (!list.length) return null;
  let i = Math.min(Math.max(0, start), list.length - 1);
  const many = list.length > 1;
  const img = h('img', { class: 'pv-img', alt: '' });
  const caption = h('div', { class: 'pv-caption' });
  const title = h('span', { class: 'pv-title' });
  const prev = h('button', { class: 'btn98', type: 'button', text: '◀ Back', 'aria-label': 'previous photo', onclick: () => step(-1) });
  const next = h('button', { class: 'btn98', type: 'button', text: 'Next ▶', 'aria-label': 'next photo', onclick: () => step(1) });
  const close = h('button', { class: 'btn98', type: 'button', text: 'Close', onclick: () => finish() });
  const stage = h('div', { class: 'pv-stage' }, img);
  const modal = h('div', { class: 'ms-modal pv-modal' },
    h('div', { class: 'ms-dialog pv-window win98', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'photo viewer' },
      h('div', { class: 'title-bar' }, title, h('button', { class: 'btn98', type: 'button', 'aria-label': 'close', text: '✕', onclick: () => finish() })),
      stage, caption,
      h('div', { class: 'ms-dialog-btns' }, many ? prev : null, many ? next : null, close)));

  const paint = () => {
    const m = list[i];
    img.setAttribute('src', m.url);
    img.setAttribute('alt', m.alt || 'photo');
    if (m.width && m.height) { img.setAttribute('width', m.width); img.setAttribute('height', m.height); }
    title.textContent = many ? `Photo ${i + 1} of ${list.length}` : 'Photo';
    caption.textContent = m.alt || '';
    caption.hidden = !m.alt;
  };
  const step = d => { i = (i + d + list.length) % list.length; paint(); };
  function finish() { modal.remove(); document.removeEventListener('keydown', key, true); }
  function key(e) {
    if (e.key === 'Escape') { e.stopImmediatePropagation?.(); e.preventDefault(); finish(); }       // not the window under us as well
    else if (many && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (many && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }
  let x0 = null;
  stage.addEventListener('touchstart', e => { x0 = e.touches && e.touches[0] ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', e => {
    const x1 = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : null;
    if (many && x0 != null && x1 != null && Math.abs(x1 - x0) > 40) step(x1 < x0 ? 1 : -1);
    x0 = null;
  });
  modal.addEventListener('click', e => { if (e.target === modal) finish(); });
  document.addEventListener('keydown', key, true);
  paint();
  document.body.append(modal);
  (many ? next : close).focus();
  return { close: finish, step, el: modal };
}
