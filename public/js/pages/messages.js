/* pages/messages.js — the Messages tab (/messages): your DMs and group chats, newest first, unread in bold, the invites
   you haven't answered at the top (Accept / Decline), a search box and the New group window. It looks again every ten
   seconds while it's open (the open chat itself is live: pages/chat.js). /inbox, the old address, comes here too. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { ago } from '../core/format.js';
import { toast, oops, pageTitle, errorCard } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { onLeave, go } from '../core/router.js';
import { chatTitle, chatIcon, chatPath, unreadBadge, openDm } from '../widgets/chatparts.js';
import { newGroupDialog } from '../widgets/newgroup.js';

const REFRESH_MS = 10000;

// "you: hi", "kat: hi", or just the words in a DM from them
function preview(chat) {
  const m = chat.lastMessage;
  if (!m) return chat.kind === 'dm' ? 'no messages yet' : 'nobody has said anything yet';
  const mine = m.author && m.author.id === S.me.id;
  return (mine ? 'you: ' : chat.kind === 'group' && m.author ? m.author.name + ': ' : '') + m.body;
}

export async function renderMessages(root) {
  const group = h('button', { class: 'btn98 go', type: 'button', text: '👥 New group', onclick: async () => {
    const chat = await newGroupDialog();
    if (chat) { toast('group made.'); go(chatPath(chat.id)); }
  } });
  const search = h('input', { type: 'search', placeholder: 'search your conversations', 'aria-label': 'search your conversations', maxLength: 40 });
  root.append(pageTitle('Messages', group),
    h('div', { class: 'ms-filterbar' }, search),
    h('div', { class: 'os-hint ms-msghint', text: 'to message one person, open their page and hit Send Message.' }));
  const list = h('div', { class: 'ms-chatlist' });
  root.append(list);

  let items = [], shown = '';
  const answer = (chat, action) => async () => {
    try {
      await api.post('/chats/' + enc(chat.id) + '/invite', { action });
      loadMe().catch(() => {});
      if (action === 'accept') go(chatPath(chat.id)); else { toast('invite declined.'); await refresh(); }
    } catch (e) { oops(e); await refresh(); }
  };
  const row = chat => {
    if (chat.status === 'invited') {
      return h('div', { class: 'ms-reqrow ms-chatrow invite' }, chatIcon(chat),
        h('div', { class: 'ms-reqmid' },
          h('div', { class: 'ms-chat-rowtitle' }, h('b', { text: chatTitle(chat) }), h('span', { class: 'ms-chip ms-newchip', text: 'invite' })),
          h('div', { class: 'ms-preview', text: `${chat.invitedBy ? chat.invitedBy.name : 'someone'} invited you · ${chat.memberCount} in the group` })),
        h('button', { class: 'btn98 go', type: 'button', text: '✔ Accept', onclick: answer(chat, 'accept') }),
        h('button', { class: 'btn98', type: 'button', text: 'Decline', onclick: answer(chat, 'decline') }));
    }
    return h('div', { class: 'ms-reqrow ms-chatrow ms-clickable' + (chat.unread ? ' unread' : ''), onclick: e => { if (!e.target.closest('a')) go(chatPath(chat.id)); } },
      chatIcon(chat),
      h('div', { class: 'ms-reqmid' },
        h('div', { class: 'ms-chat-rowtitle' }, h('a', { class: 'ms-name-link', href: chatPath(chat.id), text: chatTitle(chat) }),
          chat.kind === 'group' ? h('span', { class: 'ms-chip', text: `${chat.memberCount} people` }) : null, unreadBadge(chat.unread)),
        h('div', { class: 'ms-preview', text: preview(chat) })),
      chat.lastMessage ? h('span', { class: 'ms-time', text: ago(chat.lastMessage.created) }) : null);
  };
  const paint = (onlyIfChanged = false) => {
    const q = search.value.trim().toLowerCase();
    const match = c => !q || chatTitle(c).toLowerCase().includes(q) || (c.members || []).some(m => m.name.toLowerCase().includes(q));
    const rows = items.filter(match);
    const key = JSON.stringify([q, rows.map(c => [c.id, c.title, c.status, c.unread, c.memberCount, c.lastMessage && c.lastMessage.id])]);
    if (onlyIfChanged && key === shown) return;
    shown = key;
    list.replaceChildren(...(rows.length ? rows.map(row)
      : [h('div', { class: 'ms-empty', text: items.length ? 'no conversations match.' : 'no messages yet. visit someone\'s page and hit Send Message, or start a group.' })]));
  };
  const refresh = async () => {
    try {
      const d = await api.get('/chats');
      const invites = d.items.filter(c => c.status === 'invited'), rest = d.items.filter(c => c.status !== 'invited');
      items = [...invites, ...rest];
      paint(true);
    } catch (e) { if (!items.length) list.replaceChildren(errorCard(e)); }
  };
  search.addEventListener('input', () => paint());
  await refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  onLeave(() => clearInterval(timer));
}

// the old /inbox and /inbox/name
export function renderInboxRedirect(root, name) {
  if (!name) { go('/messages', true); return; }
  return openDm(name);
}
