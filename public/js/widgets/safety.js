/* widgets/safety.js — report and block: under posts, on pages, in messages. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops, dialog } from '../core/ui.js';
import { S, options } from '../core/state.js';
import { needLogin } from '../core/router.js';

// "⚑ report" (and "delete" when it's yours) under a post. onDeleted(answer) after a delete: the server's { ok, tombstone }
// (tombstone: it stays as "this post was deleted", because it has replies or quotes).
export function postActions(item, onDeleted) {
  const box = h('span', { class: 'ms-actions' });
  if (item.canDelete) {
    box.append(h('a', { href: '#', text: 'delete', onclick: async e => {
      e.preventDefault();
      if (!await dialog({ title: 'Delete', text: 'Delete this for good?', icon: '🗑', ok: 'Delete', danger: true })) return;
      let r;
      try { r = await api.del('/posts/' + item.id); } catch (err) { oops(err); return; }
      toast('deleted.');
      if (onDeleted) onDeleted(r);
    } }));
  }
  if (S.me && item.author && item.author.id !== S.me.id && ['status', 'wall', 'bulletin', 'thread', 'comment', 'blog', 'reply', 'quote'].includes(item.kind)) {
    box.append(h('a', { href: '#', text: '⚑ report', title: 'report this to the moderators', onclick: e => { e.preventDefault(); reportDialog({ type: 'post', id: item.id, what: 'this post' }); } }));
  }
  return box;
}

// the report form: reason + details → POST /api/reports
export async function reportDialog({ type, id, name, what }) {
  if (!S.me) { needLogin(); return; }
  const opts = await options();
  const select = h('select', { 'aria-label': 'reason' }, h('option', { value: '', text: '— pick a reason —' }),
    opts.reportReasons.map(r => h('option', { value: r.v, text: r.label })));
  const details = h('textarea', { maxLength: 1000, placeholder: 'anything the moderators should know (optional)' });
  const body = h('div', null,
    h('label', null, 'Why are you reporting ' + what + '?', select),
    h('label', null, 'Details', details),
    h('p', { class: 'os-hint', text: 'reports are private. the person you report isn\'t told who sent it. if you just don\'t want to see someone, Block them too.' }));
  while (true) {
    if (!await dialog({ title: 'Report', icon: '⚑', ok: 'Send report', body })) return;
    if (!select.value) { toast('pick a reason first.', true); continue; }
    try {
      await api.post('/reports', { type, id, name, reason: select.value, details: details.value });
      toast('thanks. a moderator will take a look.');
    } catch (e) { oops(e); }
    return;
  }
}

export async function blockUser(name) {
  const ok = await dialog({
    title: 'Block ' + name, icon: '🚫', ok: 'Block', danger: true,
    text: `${name} won't be able to message you, follow you, comment on your page or see it, and you'll stop seeing each other's posts. Any follows between you end. They won't be told. You can unblock them later in Settings.`,
  });
  if (!ok) return false;
  try { await api.post('/blocks/' + enc(name)); toast(name + ' is blocked.'); return true; } catch (e) { oops(e); return false; }
}
