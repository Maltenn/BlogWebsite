/* pages/requests.js — follow requests: people asking to follow you (private pages only), and your own requests still waiting. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { toast, oops, pageTitle } from '../core/ui.js';
import { loadMe } from '../core/state.js';
import { route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';

export async function renderRequests(root) {
  const d = await api.get('/requests');
  const act = (fn, then) => async () => { try { await fn(); await loadMe(); if (then) toast(then); route(); } catch (e) { oops(e); } };
  root.append(pageTitle('Follow Requests'));
  root.append(h('div', { class: 'ms-subhead', text: `asking to follow you (${d.incoming.length})` }));
  if (!d.incoming.length) root.append(h('div', { class: 'ms-empty', text: 'no new requests. (people only have to ask if your page is private. Settings → privacy.)' }));
  d.incoming.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'asked ' + when(r.created) })),
    h('button', { class: 'btn98 go', type: 'button', text: '✔ Accept', onclick: act(() => api.post('/followers/' + enc(r.user.name)), `${r.user.name} follows you now.`) }),
    h('button', { class: 'btn98', type: 'button', text: 'Decline', onclick: act(() => api.del('/followers/' + enc(r.user.name))) }))));
  root.append(h('div', { class: 'ms-subhead', text: `your requests waiting on others (${d.outgoing.length})` }));
  if (!d.outgoing.length) root.append(h('div', { class: 'ms-empty', text: 'none.' }));
  d.outgoing.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'asked ' + when(r.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Cancel', onclick: act(() => api.del('/follows/' + enc(r.user.name)), 'request cancelled.') }))));
}
