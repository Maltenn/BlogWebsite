/* widgets/chatparts.js — what the Messages list, the chat window and the profile buttons share about a chat: its name,
   its picture, the unread badge, and "open (or make) the DM with someone". */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops } from '../core/ui.js';
import { go } from '../core/router.js';
import { avatar } from './people.js';

// a chat's name: a group's title, else who is in it; a DM is the other person
export function chatTitle(chat) {
  if (chat.title) return chat.title;
  const others = chat.members || [];
  if (chat.kind === 'dm') return others[0] ? others[0].name : 'a conversation';
  if (!others.length) return chat.status === 'invited' ? 'a group chat' : 'just you';
  return others.slice(0, 3).map(m => m.name).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '');
}

// a DM wears the other person's picture; a group a little crowd
export function chatIcon(chat, size = 44) {
  if (chat.kind === 'dm' && chat.members && chat.members[0]) return avatar(chat.members[0], size);
  const box = h('span', { class: 'ms-gicon', 'aria-hidden': 'true', text: '👥' });
  box.style.width = size + 'px';
  box.style.height = size + 'px';
  return box;
}

export const unreadBadge = n => (n ? h('span', { class: 'ms-badge', text: n >= 99 ? '99+' : String(n) }) : null);

// where a chat lives
export const chatPath = id => '/messages/' + enc(id);

// "Send Message": the DM with that person (made if it isn't there yet), then open it
export async function openDm(name) {
  try {
    const r = await api.post('/chats', { dm: name });
    go(chatPath(r.chat.id));
  } catch (e) { oops(e); }
}
