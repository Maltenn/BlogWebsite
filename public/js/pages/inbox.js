/* pages/inbox.js — the Inbox and a conversation (which refreshes while it's open). */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { oops, pageTitle } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { onLeave, go } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { reportDialog, blockUser } from '../widgets/safety.js';

export async function renderInbox(root) {
  const d = await api.get('/inbox');
  root.append(pageTitle('Inbox', h('a', { class: 'btn98', href: '/browse', text: '✉ new message (pick someone)' })));
  if (!d.threads.length) root.append(h('div', { class: 'ms-empty', text: 'no messages yet. visit someone\'s page and hit Send Message.' }));
  d.threads.forEach(t => root.append(h('div', { class: 'ms-reqrow ms-clickable' + (t.unread ? ' unread' : ''), onclick: e => { if (!e.target.closest('a')) go('/inbox/' + enc(t.with.name)); } },
    avatar(t.with),
    h('div', { class: 'ms-reqmid' }, nameLink(t.with), t.unread ? h('span', { class: 'ms-badge', text: String(t.unread) }) : null,
      h('div', { class: 'ms-preview', text: (t.last.mine ? 'you: ' : '') + t.last.body })),
    h('span', { class: 'ms-time', text: when(t.last.created) }))));
}

export async function renderThread(root, name) {
  const d = await api.get('/inbox/' + enc(name));
  const u = d.with;
  root.append(h('div', { class: 'ms-pagetitle' }, h('span', null, 'conversation with ', nameLink(u)),
    h('span', { class: 'ms-right-tools' }, h('a', { class: 'btn98', href: '/inbox', text: '← Inbox' }),
      h('button', { class: 'btn98', type: 'button', text: '🚫 block', onclick: async () => { if (await blockUser(u.name)) go('/inbox'); } }))));
  const box = h('div', { class: 'ms-thread', 'aria-live': 'polite' });
  root.append(box);
  let shown = -1;
  const paint = msgs => {
    if (msgs.length === shown) return;
    box.replaceChildren(...msgs.map(m => h('div', { class: 'ms-dm ' + (m.mine ? 'me' : 'them') },
      h('b', { text: m.mine ? S.me.name : u.name }),
      h('div', { text: m.body }),
      h('span', { class: 'ms-time', text: when(m.created) }),
      m.mine ? null : h('span', { class: 'ms-actions' }, h('a', { href: '#', text: '⚑ report', onclick: e => { e.preventDefault(); reportDialog({ type: 'message', id: m.id, what: 'this message' }); } })))));
    if (!msgs.length) box.append(h('div', { class: 'ms-empty', text: `say hi to ${u.name}!` }));
    shown = msgs.length;
    box.scrollTop = box.scrollHeight;
  };
  paint(d.messages);
  const refresh = async () => {
    try { const r = await api.get('/inbox/' + enc(u.name)); paint(r.messages); } catch { /* try again next tick */ }
  };
  const timer = setInterval(refresh, 5000);
  onLeave(() => clearInterval(timer));                       // stops when you leave the page
  if (!d.canMessage) { root.append(h('div', { class: 'ms-empty', text: d.reason })); return; }
  const ta = h('textarea', { maxLength: 1000, rows: 2, placeholder: `message ${u.name}…`, 'aria-label': 'message' });
  const send = async () => {
    if (!ta.value.trim()) return;
    try { await api.post('/inbox/' + enc(u.name), { body: ta.value }); ta.value = ''; await refresh(); } catch (e) { oops(e); }
  };
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  root.append(h('form', { class: 'ms-commentform', onsubmit: e => { e.preventDefault(); send(); } }, ta, h('button', { class: 'btn98', type: 'submit', text: 'Send' })));
  setTimeout(() => ta.focus(), 50);
  loadMe().catch(() => {});                                  // the Inbox badge drops now that it's read
}
