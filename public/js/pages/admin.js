/* pages/admin.js — Moderation (moderators only). */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago, timeLeft } from '../core/format.js';
import { toast, oops, pageTitle, dialog } from '../core/ui.js';
import { photoGrid } from '../widgets/photogrid.js';
import { S, loadMe } from '../core/state.js';
import { route } from '../core/router.js';
import { nameLink } from '../widgets/people.js';
import { boardRequests } from '../widgets/boardrequests.js';
import { photoQueue } from '../widgets/photoqueue.js';
import { modQueues } from '../widgets/modqueues.js';

const KIND_LABEL = { wall: 'Friends\' Comment', status: 'status', blog: 'blog post', bulletin: 'bulletin', thread: 'board thread', comment: 'board comment' };   // what a report's post is called

// A reported post's photos, each with Remove photo (deleted from storage now: for Take It Down requests and anything that
// must go at once) and Hide photo / Unhide photo (kept as evidence, shown nowhere). A moderator may open them whatever the
// writer's privacy.
function modPhotos(media) {
  if (!media.length) return null;
  const cell = m => {
    const note = h('span', { class: 'os-hint', text: m.alt ? `description: ${m.alt}` : 'no description' });
    const row = h('div', { class: 'mod-photo' }, photoGrid([m], { small: true }), h('div', { class: 'mod-photo-side' }, note));
    const act = async (action, said) => {
      const why = action === 'unhide' ? '' : (prompt('note for the log (optional):') || '');
      try { await api.post('/admin/media/' + m.id, { action, note: why }); toast(said); } catch (e) { oops(e); return false; }
      return true;
    };
    const remove = h('button', { class: 'btn98 danger', type: 'button', text: '🗑 Remove photo', title: 'delete the file now', onclick: async () => {
      if (!await dialog({ title: 'Remove photo', text: 'Delete this photo from storage right now? This can\'t be undone.', icon: '⚠', ok: 'Remove', danger: true })) return;
      if (await act('remove', 'photo removed.')) row.replaceChildren(h('div', { class: 'ms-gone', text: 'photo removed.' }));
    } });
    const hide = h('button', { class: 'btn98', type: 'button', text: '🙈 Hide photo', onclick: async () => {
      const hidden = hide.dataset.hidden === '1';
      if (await act(hidden ? 'unhide' : 'hide', hidden ? 'photo visible again.' : 'photo hidden.')) {
        hide.dataset.hidden = hidden ? '0' : '1';
        hide.textContent = hidden ? '🙈 Hide photo' : '👁 Unhide photo';
      }
    } });
    row.lastChild.append(remove, hide);
    return row;
  };
  return h('div', { class: 'mod-photos' }, media.map(cell));
}
const REASON_LABEL = { csam: 'child sexual abuse material' };   // (the rest read fine with the underscore taken out)

let modView = 'open';
export async function renderAdmin(root) {
  if (!S.me.isAdmin) { root.append(pageTitle('Moderation'), h('div', { class: 'ms-empty', text: 'moderators only.' })); return; }
  const [d, log, asked] = await Promise.all([api.get('/admin/reports?status=' + modView), api.get('/admin/log'), api.get('/admin/board-requests?status=' + modView)]);
  root.append(pageTitle('Moderation',
    h('button', { class: 'btn98' + (modView === 'open' ? ' pressed' : ''), type: 'button', text: 'open', onclick: () => { modView = 'open'; route(); } }),
    h('button', { class: 'btn98' + (modView === 'closed' ? ' pressed' : ''), type: 'button', text: 'closed', onclick: () => { modView = 'closed'; route(); } })));
  root.append(h('div', { class: 'ms-note', text: 'hide = nobody sees the post or message any more (it stays in the database as evidence). ban = the account is logged out, can\'t log in, and everything it wrote disappears from the site. both can be undone.' }));
  root.append(boardRequests(asked.requests, () => route()));
  root.append(modQueues());                                   // held sign-ups, alerts, strike appeals, AI scans (phase 7)
  if (!d.reports.length) root.append(h('div', { class: 'ms-empty', text: modView === 'open' ? 'no open reports. ✨' : 'nothing closed yet.' }));
  const act = async (r, action) => {
    const note = action === 'dismiss' ? '' : (prompt('note for the log (optional):') || '');
    try { await api.post('/admin/reports/' + r.id, { action, note }); toast('done.'); await loadMe(); route(); } catch (e) { oops(e); }
  };
  d.reports.forEach(r => {
    const s = r.snapshot || {};
    const what = r.type === 'user' ? `profile of ${s.name || '?'}` : r.type === 'message' ? `private message from ${s.author || '?'}` : `${KIND_LABEL[s.kind] || s.kind || 'post'} by ${s.author || '?'}`;
    const snapText = r.type === 'user' ? [s.tag, s.mood, s.about, s.meet].filter(Boolean).join('\n—\n') : [s.subject, s.body].filter(Boolean).join('\n');
    const state = r.type === 'user' ? '' : r.targetHidden == null ? ' (deleted by its author)' : r.targetHidden ? ' (hidden)' : '';
    // a child-safety report, or one marked "intimate image without consent": 48 hours from when it was filed (docs/operations.md)
    const clock = r.status === 'open' && r.deadline ? h('div', { class: 'mod-clock' + (r.deadline < Date.now() ? ' overdue' : '') },
      `⏱ filed ${ago(r.created)} · 48-hour deadline: ${timeLeft(r.deadline)}`,
      r.reason === 'csam' ? ' · its photos are held. don\'t download or share them; report to NCMEC, then remove.' : ' · remove the photo, don\'t just hide it.') : null;
    root.append(h('div', { class: 'mod-report' + (r.status === 'open' ? '' : ' closed') + (r.reason === 'csam' ? ' csam' : '') },
      h('div', { class: 'mod-head' }, h('span', { class: 'mod-reason', text: REASON_LABEL[r.reason] || r.reason.replace('_', ' ') }), h('span', { text: what + state }),
        r.intimate ? h('span', { class: 'mod-reason', text: 'intimate image without consent' }) : null,
        h('span', { class: 'ms-time', text: when(r.created) })),
      clock,
      h('div', { class: 'mod-snap', text: snapText || '(empty)' }),
      modPhotos(s.media || []),
      r.details ? h('div', { class: 'mod-meta' }, h('b', { text: 'reporter says: ' }), r.details) : null,
      h('div', { class: 'mod-meta' }, 'reported by ', r.reporter ? nameLink(r.reporter) : '(deleted account)', ' · about ',
        r.target ? nameLink(r.target) : '(deleted account)', r.targetBanned ? ' (banned)' : '', ` · ${r.targetReports} report(s) about this account in total`,
        r.status !== 'open' ? ` · ${r.status} (${r.resolution}) by ${r.resolver || '?'} ${r.resolvedAt ? when(r.resolvedAt) : ''}` : ''),
      h('div', { class: 'mod-btns' },
        r.status === 'open' && r.type !== 'user' ? h('button', { class: 'btn98', type: 'button', text: '🙈 hide it', onclick: () => act(r, 'hide') }) : null,
        r.status === 'open' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: '⛔ ban the account', onclick: () => act(r, 'ban') }) : null,
        r.status === 'open' && r.type !== 'user' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: 'hide + ban', onclick: () => act(r, 'hide_ban') }) : null,
        r.status === 'open' ? h('button', { class: 'btn98', type: 'button', text: '✔ dismiss (no problem)', onclick: () => act(r, 'dismiss') }) : null,
        r.status === 'open' && r.type !== 'user' && !r.intimate && r.reason !== 'csam' ? h('button', { class: 'btn98', type: 'button', text: '⏱ intimate image without consent', title: 'starts the 48-hour Take It Down clock',
          onclick: async () => { try { await api.post('/admin/reports/' + r.id, { action: 'intimate' }); toast('marked. the 48-hour clock is running.'); route(); } catch (e) { oops(e); } } }) : null,
        r.target && r.targetBanned ? h('button', { class: 'btn98', type: 'button', text: 'unban', onclick: async () => { try { await api.post('/admin/users/' + enc(r.target.name), { banned: false }); toast('unbanned.'); route(); } catch (e) { oops(e); } } }) : null,
        r.type !== 'user' && r.targetHidden ? h('button', { class: 'btn98', type: 'button', text: 'unhide', onclick: async () => { try { await api.post('/admin/content', { type: r.type, id: r.targetId, hidden: false }); toast('visible again.'); route(); } catch (e) { oops(e); } } }) : null)));
  });
  root.append(photoQueue());
  root.append(h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: '📜 moderation log' }),
    h('div', { class: 'mod-log' }, log.log.length ? log.log.map(l => h('div', { text: `${when(l.created)} · ${l.actor || '?'} · ${l.action} ${l.targetType} #${l.targetId}${l.note ? ' — ' + l.note : ''}` })) : h('div', { text: 'nothing yet.' }))));
}
