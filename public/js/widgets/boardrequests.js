/* widgets/boardrequests.js — the board requests on the Moderation page: who asked for what and why, and for a waiting one
   the form to approve it (slug, icon and description, with sensible defaults) or decline it. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { toast, oops } from '../core/ui.js';
import { nameLink } from './people.js';
import { boardPath } from './boardlinks.js';

// the slug the server would make from a name (src/boards/requests.js): lower-case letters, digits and dashes, up to 30,
// never ending in a dash
export const slugOf = name => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

// requests: GET /api/admin/board-requests' list. onDone(): after one is decided. Returns an element.
export function boardRequests(requests, onDone) {
  const box = h('div', { class: 'os-panel mod-boardreqs' }, h('div', { class: 'ms-boxtitle', text: `➕ board requests (${requests.length})` }));
  if (!requests.length) box.append(h('div', { class: 'ms-empty', text: 'no board requests.' }));
  for (const r of requests) {
    const row = h('div', { class: 'mod-report mod-boardreq' + (r.status === 'pending' ? '' : ' closed'), dataset: { id: r.id } },
      h('div', { class: 'mod-head' }, h('span', { class: 'mod-reason', text: r.name }), h('span', null, 'from ', r.user ? nameLink(r.user) : '(deleted account)'),
        h('span', { class: 'ms-time', text: when(r.created) })),
      h('div', { class: 'mod-snap', text: r.reason || '(no reason given)' }));
    if (r.status === 'pending') {
      const slug = h('input', { class: 'os-input', maxLength: 30, value: slugOf(r.name), 'aria-label': 'address (slug)' });
      const name = h('input', { class: 'os-input', maxLength: 40, value: r.name, 'aria-label': 'board name' });
      const icon = h('input', { class: 'os-input mod-icon', maxLength: 8, value: '💬', 'aria-label': 'icon (an emoji)' });
      const desc = h('input', { class: 'os-input', maxLength: 140, placeholder: 'one line about the board', 'aria-label': 'description' });
      const decide = async (action, extra) => {
        try {
          await api.post('/admin/board-requests/' + r.id, { action, ...extra });
          toast(action === 'approve' ? 'board made.' : 'declined.');
          onDone();
        } catch (e) { oops(e); }
      };
      row.append(h('form', { class: 'os-form mod-boardform', onsubmit: e => {
        e.preventDefault();
        decide('approve', { slug: slug.value.trim(), name: name.value.trim(), icon: icon.value.trim(), description: desc.value.trim() });
      } },
      h('div', { class: 'row' }, h('label', null, 'name', name), h('label', null, 'address /boards/…', slug), h('label', null, 'icon', icon)),
      h('label', null, 'description', desc),
      h('div', { class: 'mod-btns' },
        h('button', { class: 'btn98 go', type: 'submit', text: '✔ Approve and make the board' }),
        h('button', { class: 'btn98 danger', type: 'button', text: 'Decline', onclick: () => decide('decline', {}) }))));
    } else {
      row.append(h('div', { class: 'mod-meta' }, `${r.status} by ${r.decidedBy || '?'}${r.decided ? ' ' + when(r.decided) : ''}`,
        r.board ? [' · ', h('a', { href: boardPath(r.board.slug), text: `${r.board.icon || ''} ${r.board.name}` })] : null));
    }
    box.append(row);
  }
  return box;
}
