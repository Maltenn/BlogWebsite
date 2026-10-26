/* pages/admin.js — Moderation (moderators only). */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { toast, oops, pageTitle } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { route } from '../core/router.js';
import { nameLink } from '../widgets/people.js';
import { boardRequests } from '../widgets/boardrequests.js';

const KIND_LABEL = { wall: 'Friends\' Comment', status: 'status', blog: 'blog post', bulletin: 'bulletin', thread: 'board thread', comment: 'board comment' };   // what a report's post is called

let modView = 'open';
export async function renderAdmin(root) {
  if (!S.me.isAdmin) { root.append(pageTitle('Moderation'), h('div', { class: 'ms-empty', text: 'moderators only.' })); return; }
  const [d, log, asked] = await Promise.all([api.get('/admin/reports?status=' + modView), api.get('/admin/log'), api.get('/admin/board-requests?status=' + modView)]);
  root.append(pageTitle('Moderation',
    h('button', { class: 'btn98' + (modView === 'open' ? ' pressed' : ''), type: 'button', text: 'open', onclick: () => { modView = 'open'; route(); } }),
    h('button', { class: 'btn98' + (modView === 'closed' ? ' pressed' : ''), type: 'button', text: 'closed', onclick: () => { modView = 'closed'; route(); } })));
  root.append(h('div', { class: 'ms-note', text: 'hide = nobody sees the post or message any more (it stays in the database as evidence). ban = the account is logged out, can\'t log in, and everything it wrote disappears from the site. both can be undone.' }));
  root.append(boardRequests(asked.requests, () => route()));
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
    root.append(h('div', { class: 'mod-report' + (r.status === 'open' ? '' : ' closed') },
      h('div', { class: 'mod-head' }, h('span', { class: 'mod-reason', text: r.reason.replace('_', ' ') }), h('span', { text: what + state }),
        h('span', { class: 'ms-time', text: when(r.created) })),
      h('div', { class: 'mod-snap', text: snapText || '(empty)' }),
      r.details ? h('div', { class: 'mod-meta' }, h('b', { text: 'reporter says: ' }), r.details) : null,
      h('div', { class: 'mod-meta' }, 'reported by ', r.reporter ? nameLink(r.reporter) : '(deleted account)', ' · about ',
        r.target ? nameLink(r.target) : '(deleted account)', r.targetBanned ? ' (banned)' : '', ` · ${r.targetReports} report(s) about this account in total`,
        r.status !== 'open' ? ` · ${r.status} (${r.resolution}) by ${r.resolver || '?'} ${r.resolvedAt ? when(r.resolvedAt) : ''}` : ''),
      h('div', { class: 'mod-btns' },
        r.status === 'open' && r.type !== 'user' ? h('button', { class: 'btn98', type: 'button', text: '🙈 hide it', onclick: () => act(r, 'hide') }) : null,
        r.status === 'open' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: '⛔ ban the account', onclick: () => act(r, 'ban') }) : null,
        r.status === 'open' && r.type !== 'user' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: 'hide + ban', onclick: () => act(r, 'hide_ban') }) : null,
        r.status === 'open' ? h('button', { class: 'btn98', type: 'button', text: '✔ dismiss (no problem)', onclick: () => act(r, 'dismiss') }) : null,
        r.target && r.targetBanned ? h('button', { class: 'btn98', type: 'button', text: 'unban', onclick: async () => { try { await api.post('/admin/users/' + enc(r.target.name), { banned: false }); toast('unbanned.'); route(); } catch (e) { oops(e); } } }) : null,
        r.type !== 'user' && r.targetHidden ? h('button', { class: 'btn98', type: 'button', text: 'unhide', onclick: async () => { try { await api.post('/admin/content', { type: r.type, id: r.targetId, hidden: false }); toast('visible again.'); route(); } catch (e) { oops(e); } } }) : null)));
  });
  root.append(h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: '📜 moderation log' }),
    h('div', { class: 'mod-log' }, log.log.length ? log.log.map(l => h('div', { text: `${when(l.created)} · ${l.actor || '?'} · ${l.action} ${l.targetType} #${l.targetId}${l.note ? ' — ' + l.note : ''}` })) : h('div', { text: 'nothing yet.' }))));
}
