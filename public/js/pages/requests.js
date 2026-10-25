/* pages/requests.js — friend requests, both ways. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { toast, oops, pageTitle } from '../core/ui.js';
import { loadMe } from '../core/state.js';
import { route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';

export async function renderRequests(root) {
  const d = await api.get('/requests');
  root.append(pageTitle('Friend Requests'));
  root.append(h('div', { class: 'ms-subhead', text: `waiting on you (${d.incoming.length})` }));
  if (!d.incoming.length) root.append(h('div', { class: 'ms-empty', text: 'no new requests.' }));
  d.incoming.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'sent ' + when(r.created) })),
    h('button', { class: 'btn98 go', type: 'button', text: '✔ Approve', onclick: async () => { try { await api.post('/friends/' + enc(r.user.name)); toast(`you and ${r.user.name} are friends!`); await loadMe(); route(); } catch (e) { oops(e); } } }),
    h('button', { class: 'btn98', type: 'button', text: 'Deny', onclick: async () => { try { await api.del('/friends/' + enc(r.user.name)); await loadMe(); route(); } catch (e) { oops(e); } } }))));
  root.append(h('div', { class: 'ms-subhead', text: `your requests waiting on others (${d.outgoing.length})` }));
  if (!d.outgoing.length) root.append(h('div', { class: 'ms-empty', text: 'none.' }));
  d.outgoing.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'sent ' + when(r.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Cancel', onclick: async () => { try { await api.del('/friends/' + enc(r.user.name)); route(); } catch (e) { oops(e); } } }))));
}
