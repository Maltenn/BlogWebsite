/* widgets/photoqueue.js — the Photos section of the Moderation page: every upload, newest first, as a grid of thumbnails
   (unreviewed ones by default). Each says who uploaded it (and how old the account is), where it is, and has Mark
   reviewed, Hide / Unhide and Remove. GET /api/admin/media pages with `next`. The server refuses Remove and Unhide on a photo
   a child-safety report holds: moderatePhoto shows why and takes the override, which the Moderation page shares. */

import { h, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { ago, when } from '../core/format.js';
import { toast, oops, dialog } from '../core/ui.js';
import { openViewer } from './photoviewer.js';
import { blogPath, postPath } from './postlinks.js';
import { threadPath } from './boardlinks.js';

// where a queue photo is: [label, address or null] (m.where from the API)
export function whereIs(m) {
  const w = m.where;
  if (!w) return ['not on anything yet', null];
  const by = { name: w.author || '?' };
  if (w.type === 'avatar') return ['profile picture', userPath(by.name)];
  if (w.type === 'cover') return ['blog cover', blogPath(by.name, w.id)];
  if (w.type === 'thread') return ['board thread', w.board ? threadPath(w.board, w.thread) : null];
  if (w.type === 'comment') return ['board comment', w.board ? threadPath(w.board, w.thread) : null];
  if (w.type === 'gone') return ['a deleted post (held)', null];
  return ['post', postPath({ id: w.id, kind: 'status', author: by })];
}

// POST /admin/media/:id with `body`. Answers whether it went through. A photo under a child-safety hold is refused (409
// child_safety_hold): the moderator is told why, and may override it with a note, which the moderation log keeps.
export async function moderatePhoto(id, body) {
  const send = extra => api.post('/admin/media/' + id, { ...body, ...extra });
  try {
    try {
      await send();
      return true;
    } catch (e) {
      if (e.code !== 'child_safety_hold') throw e;
    }
    const why = h('textarea', { class: 'os-input', rows: 3, maxLength: 300, 'aria-label': 'why, and on whose word' });
    const go = await dialog({ title: 'Held for a child-safety report', icon: '⛔', ok: 'Override', danger: true, body: why,
      text: `This photo is held for a child-safety report and must stay held. ${body.action === 'remove' ? 'Removing it destroys it for good.' : 'Unhiding it can put it back in public, or let the cron delete it.'} Only override it if a lawyer or law enforcement told you to, or for an adult's Take It Down request. Say why, and on whose word: the moderation log keeps it.` });
    if (!go) return false;
    const note = why.value.trim();
    if (!note) { toast('an override needs a note. nothing changed.'); return false; }
    await send({ note, override: true });
    return true;
  } catch (e) {
    oops(e);
    return false;
  }
}

// Returns an element that loads and pages itself.
export function photoQueue() {
  let filter = 'unreviewed';
  const toggles = ['unreviewed', 'all'].map(f => h('button', { class: 'btn98', type: 'button', text: f, onclick: () => { filter = f; load(false); } }));
  const grid = h('div', { class: 'mod-pq-grid' });
  const more = h('button', { class: 'btn98', type: 'button', text: 'show older photos' });
  const empty = h('div', { class: 'ms-empty' });
  const box = h('div', { class: 'os-panel mod-pq' }, h('div', { class: 'ms-boxtitle', text: '📷 photos' }),
    h('div', { class: 'mod-pq-bar' }, h('span', { class: 'os-hint', text: 'newest uploads first. skim these every day.' }), ...toggles), empty, grid, h('div', { class: 'mod-btns' }, more));
  let next = null, busy = false;

  const card = m => {
    const [label, href] = whereIs(m);
    const state = h('span', { class: 'mod-pq-state' });
    const paint = () => {
      state.textContent = [m.held ? 'HELD: child safety' : '', m.hidden ? 'HIDDEN' : '', m.reviewed ? `reviewed by ${m.reviewedBy || '?'} ${ago(m.reviewedAt)}` : 'not reviewed'].filter(Boolean).join(' · ');
      el.classList.toggle('is-hidden', m.hidden);
      el.classList.toggle('is-reviewed', m.reviewed);
    };
    const act = async (action, said) => {
      if (!await moderatePhoto(m.id, { action })) return false;
      toast(said);
      return true;
    };
    const gone = text => el.replaceChildren(h('div', { class: 'ms-gone', text }));
    const reviewed = h('button', { class: 'btn98 go', type: 'button', text: '✔ Mark reviewed', onclick: async () => {
      if (!await act('reviewed', 'marked reviewed.')) return;
      m.reviewed = true; m.reviewedBy = 'you'; m.reviewedAt = Date.now();
      if (filter === 'unreviewed') { el.remove(); check(); } else { paint(); reviewed.remove(); }
    } });
    const hide = h('button', { class: 'btn98', type: 'button', text: m.hidden ? '👁 Unhide' : '🙈 Hide', onclick: async () => {
      if (!await act(m.hidden ? 'unhide' : 'hide', m.hidden ? 'photo visible again.' : 'photo hidden.')) return;
      m.hidden = !m.hidden;
      hide.textContent = m.hidden ? '👁 Unhide' : '🙈 Hide';
      paint();
    } });
    const remove = h('button', { class: 'btn98 danger', type: 'button', text: '🗑 Remove', title: 'delete the file now', onclick: async () => {
      if (!await dialog({ title: 'Remove photo', text: 'Delete this photo from storage right now? This can\'t be undone.', icon: '⚠', ok: 'Remove', danger: true })) return;
      if (await act('remove', 'photo removed.')) { gone('photo removed.'); }
    } });
    const el = h('div', { class: 'mod-pq-card', dataset: { id: m.id } },
      h('button', { class: 'mod-pq-thumb', type: 'button', title: m.alt || 'open photo', 'aria-label': 'open photo', onclick: () => openViewer([m], 0) },
        h('img', { src: m.url, alt: m.alt || 'photo', loading: 'lazy', decoding: 'async' })),
      h('div', { class: 'mod-pq-meta' },
        m.uploader ? h('a', { href: userPath(m.uploader.name), text: '@' + m.uploader.name }) : h('span', { text: '(deleted account)' }),
        m.uploader ? h('span', { class: 'os-hint', text: ` joined ${ago(m.uploader.created)}` }) : null,
        h('div', null, href ? h('a', { href, text: label }) : label, ` · uploaded ${ago(m.created)}`),
        state),
      h('div', { class: 'mod-btns' }, m.reviewed ? null : reviewed, hide, remove));
    paint();
    return el;
  };

  const check = () => {
    if (!grid.children.length && next != null) { load(true); return; }     // everything on this page is dealt with: the next one
    empty.textContent = grid.children.length ? '' : filter === 'unreviewed' ? 'nothing waiting for review. ✨' : 'no photos yet.';
    more.hidden = next == null;
  };
  async function load(append) {
    if (busy) return;
    busy = true;
    toggles.forEach((b, i) => b.classList.toggle('pressed', ['unreviewed', 'all'][i] === filter));
    try {
      const d = await api.get(`/admin/media?filter=${filter}${append && next != null ? '&before=' + next : ''}`);
      if (!append) grid.replaceChildren();
      grid.append(...d.media.map(card));
      next = d.next;
    } catch (e) { oops(e); } finally { busy = false; }
    check();
  }
  more.addEventListener('click', () => load(true));
  load(false);
  return box;
}
