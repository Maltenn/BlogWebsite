/* pages/chat.js — one conversation (/messages/:id): a DM or a group chat, in an AIM / MSN window. It streams live over
   the room's socket (core/live.js): new messages, "kat is typing…", who has the window open, how far each person has
   read, and (for a group) changes to its name and members. Sending is a plain POST; the message also comes back on the
   socket and is drawn once. An invite you haven't answered shows its Accept / Decline card instead. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, clock, dayHeading, sameDay } from '../core/format.js';
import { toast, oops, pageTitle, dialog } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { go, onLeave } from '../core/router.js';
import { openRoom } from '../core/live.js';
import { avatar, nameLink } from '../widgets/people.js';
import { reportDialog, blockUser } from '../widgets/safety.js';
import { chatTitle, chatIcon, chatPath } from '../widgets/chatparts.js';
import { groupSettings } from '../widgets/groupsettings.js';

const MAX = 2000;
const GROUP_WITHIN = 3 * 60 * 1000;          // a run of lines from one person inside this shares one name and picture
const uid = r => (r.user && r.user.id != null ? r.user.id : r.user);

// the invite you haven't answered: who asked, how many are in, Accept / Decline
function inviteCard(root, chat) {
  root.append(pageTitle('Group invite', h('a', { class: 'btn98', href: '/messages', text: '← Messages' })));
  const answer = action => async () => {
    try {
      await api.post('/chats/' + enc(chat.id) + '/invite', { action });
      loadMe().catch(() => {});
      if (action === 'accept') go(chatPath(chat.id), true); else { toast('invite declined.'); go('/messages', true); }
    } catch (e) { oops(e); }
  };
  root.append(h('div', { class: 'ms-section ms-invitecard' }, chatIcon(chat, 56),
    h('div', { class: 'ms-reqmid' },
      h('div', null, chat.invitedBy ? nameLink(chat.invitedBy) : 'someone', ' invited you to ', h('b', { text: chatTitle(chat) })),
      h('div', { class: 'ms-time', text: `${chat.memberCount} in the group so far. you can't see the chat until you accept.` })),
    h('button', { class: 'btn98 go', type: 'button', text: '✔ Accept', onclick: answer('accept') }),
    h('button', { class: 'btn98', type: 'button', text: 'Decline', onclick: answer('decline') })));
}

export async function renderChat(root, id) {
  let d;
  try { d = await api.get(`/chats/${enc(id)}/messages`); } catch (e) {
    if (e.status === 403) {                                    // only an invite so far
      const c = (await api.get('/chats/' + enc(id))).chat;
      if (c.status === 'invited') { inviteCard(root, c); return; }
    }
    if (e.status === 404) {
      root.append(pageTitle('Messages', h('a', { class: 'btn98', href: '/messages', text: '← Messages' })),
        h('div', { class: 'ms-empty', text: 'that conversation isn\'t here (or you\'re not in it any more).' }));
      return;
    }
    throw e;
  }
  const me = S.me;
  const cid = d.chat.id;
  let chat = d.chat, canMessage = d.canMessage, reason = d.reason, older = d.next;
  const msgs = [];                                             // oldest first
  const have = new Set();
  const reads = new Map((d.reads || []).map(r => [uid(r), r.id]));
  const online = new Set();
  const typing = new Map();                                    // name → timer
  let readSent = 0, readTimer = null, lastTyping = 0, firstPaint = true;

  /* ---- the window ---- */
  const log = h('div', { class: 'ms-chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'messages' });
  const typingEl = h('div', { class: 'ms-chat-typing', 'aria-live': 'polite' });
  const netEl = h('div', { class: 'ms-chat-net', hidden: true });
  const titleText = h('span', { class: 'ms-chat-title' });
  const buddies = h('div', { class: 'ms-buddies' });
  const tools = h('span', { class: 'ms-right-tools' });
  const settings = chat.kind === 'group' ? groupSettings({ onChange: c => { chat = c; paintHead(); }, onLeft: () => go('/messages') }) : null;
  if (settings) { settings.update(chat); settings.el.hidden = true; }
  const composer = h('div', { class: 'ms-chat-composer' });
  const win = h('div', { class: 'win98 ms-chatwin' },
    h('div', { class: 'title-bar' }, titleText, tools),
    buddies, settings ? settings.el : null, netEl, log, typingEl, composer);
  root.append(win);

  function paintHead() {
    const title = chatTitle(chat);
    titleText.textContent = chat.kind === 'dm' ? `${title} - Instant Message` : `${title} - Group Chat`;
    document.title = title + ' — OurSpace';
    tools.replaceChildren(...[
      chat.kind === 'group' ? h('button', { class: 'btn98', type: 'button', title: 'members and settings', 'aria-label': 'group settings', text: '⚙', onclick: () => { settings.el.hidden = !settings.el.hidden; } }) : null,
      chat.kind === 'dm' && chat.members[0] ? h('button', { class: 'btn98', type: 'button', title: 'block ' + chat.members[0].name, 'aria-label': 'block', text: '🚫', onclick: async () => { if (await blockUser(chat.members[0].name)) go('/messages'); } }) : null,
      h('a', { class: 'btn98', href: '/messages', 'aria-label': 'back to Messages', text: '✕' })].filter(Boolean));
    buddies.replaceChildren(...[...chat.members.map(u => h('span', { class: 'ms-buddy' + (online.has(u.id) ? ' on' : '') },
      avatar(u, 28), h('span', { class: 'ms-buddy-name' }, nameLink(u)), h('span', { class: 'ms-buddy-state', text: online.has(u.id) ? '🟢' : '⚪', title: online.has(u.id) ? 'here now' : 'not in this window' }))),
    chat.invited && chat.invited.length ? h('span', { class: 'ms-time', text: `invited: ${chat.invited.map(u => u.name).join(', ')}` }) : null].filter(Boolean));
    if (settings) settings.update(chat);
  }

  const line = (m, joined, seen) => {
    const mine = m.author.id === me.id;
    return h('div', { class: 'ms-chatmsg' + (mine ? ' me' : ' them') + (joined ? ' cont' : ''), dataset: { id: String(m.id) } },
      joined ? h('span', { class: 'ms-chat-gap', title: when(m.created) }) : avatar(m.author, 32),
      h('div', { class: 'ms-chat-mid' },
        joined ? null : h('div', { class: 'ms-chat-who' }, h('a', { class: 'ms-aim-name ' + (mine ? 'me' : 'them'), href: '/u/' + enc(m.author.name), text: mine ? me.name : m.author.name }),
          h('span', { class: 'ms-time', title: when(m.created), text: clock(m.created) })),
        h('div', { class: 'ms-chat-text', text: m.body }),
        seen ? h('div', { class: 'ms-chat-seen', text: seen }) : null),
      h('span', { class: 'ms-actions' },
        mine || me.isAdmin ? h('a', { href: '#', text: 'delete', onclick: e => { e.preventDefault(); remove(m); } }) : null,
        mine ? null : h('a', { href: '#', text: '⚑ report', onclick: e => { e.preventDefault(); reportDialog({ type: 'message', id: m.id, what: 'this message' }); } })));
  };

  // under my newest line: ✓ sent, or who has read it
  function seenText() {
    const last = [...msgs].reverse().find(m => m.author.id === me.id);
    if (!last) return null;
    const who = chat.members.filter(u => (reads.get(u.id) || 0) >= last.id);
    if (chat.kind === 'dm') return { id: last.id, text: who.length ? '✓✓ read' : '✓ sent' };
    return { id: last.id, text: who.length ? 'seen by ' + who.map(u => u.name).join(', ') : '✓ sent' };
  }

  function paintLog(stick) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const keepFrom = log.scrollHeight;
    const seen = seenText();
    const kids = [];
    if (older) kids.push(h('button', { class: 'btn98 ms-more', type: 'button', text: '▴ earlier messages', onclick: loadOlder }));
    let prev = null;
    for (const m of msgs) {
      if (!prev || !sameDay(prev.created, m.created)) kids.push(h('div', { class: 'ms-day', text: dayHeading(m.created) }));
      const joined = prev && sameDay(prev.created, m.created) && prev.author.id === m.author.id && m.created - prev.created < GROUP_WITHIN;
      kids.push(line(m, joined, seen && seen.id === m.id ? seen.text : null));
      prev = m;
    }
    if (!msgs.length) kids.push(h('div', { class: 'ms-empty', text: chat.kind === 'dm' ? `say hi to ${chatTitle(chat)}!` : 'nobody has said anything yet. be first!' }));
    log.replaceChildren(...kids);
    if (stick === 'keep') log.scrollTop += log.scrollHeight - keepFrom;
    else if (stick || near || firstPaint) log.scrollTop = log.scrollHeight;
    firstPaint = false;
  }

  function paintTyping() {
    const names = [...typing.keys()];
    typingEl.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'several people are typing…';
  }

  function paintComposer() {
    if (!canMessage) { composer.replaceChildren(h('div', { class: 'ms-empty', text: reason || 'you can\'t message this conversation.' })); return; }
    if (composer.querySelector('textarea')) return;
    const ta = h('textarea', { maxLength: MAX, rows: 2, placeholder: `message ${chatTitle(chat)}…`, 'aria-label': 'message' });
    const count = h('span', { class: 'ms-chat-count', text: `0/${MAX}` });
    const btn = h('button', { class: 'btn98 go', type: 'submit', text: 'Send' });
    const send = async () => {
      const body = ta.value.trim();
      if (!body || btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await api.post(`/chats/${enc(cid)}/messages`, { body });
        ta.value = '';
        count.textContent = `0/${MAX}`;
        add([r.message], true);
        readSent = Math.max(readSent, r.message.id);
      } catch (e) { oops(e); }
      btn.disabled = false;
      ta.focus();
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    ta.addEventListener('input', () => {
      count.textContent = `${ta.value.length}/${MAX}`;
      if (ta.value && Date.now() - lastTyping > 2000) { lastTyping = Date.now(); live.send({ type: 'typing' }); }
    });
    composer.replaceChildren(h('form', { class: 'ms-chat-form', onsubmit: e => { e.preventDefault(); send(); } }, ta, h('div', { class: 'ms-chat-formside' }, btn, count)));
    setTimeout(() => ta.focus(), 50);
  }

  /* ---- messages in ---- */
  function add(list, stick = false) {
    let any = false;
    for (const m of list) {
      if (have.has(m.id)) continue;
      have.add(m.id);
      msgs.push(m);
      any = true;
      const t = typing.get(m.author.name);
      if (t) { clearTimeout(t); typing.delete(m.author.name); paintTyping(); }
    }
    if (!any) return;
    msgs.sort((a, b) => a.id - b.id);
    paintLog(stick);
    markRead();
  }
  function drop(mid) {
    const at = msgs.findIndex(m => m.id === mid);
    if (at >= 0) { msgs.splice(at, 1); paintLog(); }
  }
  async function remove(m) {
    if (!await dialog({ title: 'Delete', text: 'Delete this message for everyone?', icon: '🗑', ok: 'Delete', danger: true })) return;
    try { await api.del('/chat-messages/' + m.id); drop(m.id); } catch (e) { oops(e); }
  }
  async function loadOlder() {
    if (!older) return;
    try {
      const r = await api.get(`/chats/${enc(cid)}/messages?before=${older}`);
      older = r.next;
      r.messages.forEach(m => { if (!have.has(m.id)) { have.add(m.id); msgs.push(m); } });
      msgs.sort((a, b) => a.id - b.id);
      paintLog('keep');
    } catch (e) { oops(e); }
  }

  // what the socket missed (after a reconnect, or every few seconds while it can't connect)
  async function sync() {
    for (let i = 0; i < 5; i++) {
      const last = msgs.length ? msgs[msgs.length - 1].id : 0;
      const r = await api.get(`/chats/${enc(cid)}/messages?after=${last}`);
      (r.reads || []).forEach(x => reads.set(uid(x), x.id));
      chat = r.chat || chat;
      if (canMessage !== r.canMessage || reason !== r.reason) { canMessage = r.canMessage; reason = r.reason; composer.replaceChildren(); paintComposer(); }
      add(r.messages);
      if (!r.next || !r.messages.length) break;
    }
    paintHead();
    paintLog();
  }

  // my read position moves to the newest line once the window is in view
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(async () => {
      if (document.hidden || !msgs.length) return;
      const top = msgs[msgs.length - 1].id;
      if (top <= readSent) return;
      const was = readSent;
      readSent = top;
      try { await api.put(`/chats/${enc(cid)}/read`, { id: top }); loadMe().catch(() => {}); } catch { readSent = was; }
    }, 400);
  }
  document.addEventListener('visibilitychange', markRead);

  const live = openRoom(cid, {
    sync,
    onState: s => {
      netEl.hidden = s === 'live' || s === 'connecting';
      netEl.textContent = s === 'polling' ? 'live updates are down. checking for new messages every few seconds…' : '';
    },
    onEvent: ev => {
      if (ev.type === 'message') add([{ ...ev.message, mine: ev.message.author.id === me.id }]);
      else if (ev.type === 'deleted') drop(ev.id);
      else if (ev.type === 'typing') {
        if (!ev.user || ev.user.id === me.id) return;
        clearTimeout(typing.get(ev.user.name));
        typing.set(ev.user.name, setTimeout(() => { typing.delete(ev.user.name); paintTyping(); }, 4000));
        paintTyping();
      } else if (ev.type === 'presence') {
        online.clear();
        (ev.online || []).forEach(u => online.add(u.id));
        paintHead();
      } else if (ev.type === 'read') { reads.set(uid(ev), ev.id); paintLog(); }
      else if (ev.type === 'changed') {
        api.get('/chats/' + enc(cid)).then(r => { chat = r.chat; paintHead(); }).catch(() => {});
      } else if (ev.type === 'removed') { toast('you\'re not in that conversation any more.', true); go('/messages'); }
      else if (ev.type === 'signedout' || ev.type === 'elsewhere') {
        netEl.hidden = false;
        netEl.textContent = ev.type === 'signedout' ? 'you\'ve been signed out. log in again to keep chatting.'
          : 'this chat is open in too many other tabs, so live updates stopped here. reload to bring them back.';
        if (ev.type === 'signedout') toast('you\'ve been signed out.', true);
      }
    },
  });
  const pageTitleBefore = document.title;
  onLeave(() => {
    document.title = pageTitleBefore;
    clearTimeout(readTimer);
    typing.forEach(t => clearTimeout(t));
    document.removeEventListener('visibilitychange', markRead);
  });

  paintHead();
  paintComposer();
  d.messages.forEach(m => { have.add(m.id); msgs.push(m); });
  msgs.sort((a, b) => a.id - b.id);
  paintLog(true);
  const top = msgs.length ? msgs[msgs.length - 1].id : 0;
  if (chat.unread > 0 && top) markRead(); else readSent = top;
}
