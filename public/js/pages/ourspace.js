/* pages/ourspace.js — #ourspace (/ourspace): the one room every member can use, drawn like mIRC: [19:14] <nick> words,
   a nick list of who has the room open (from the live presence), a topic line. Slow mode (one message every few seconds)
   counts down on the Send button; a muted member sees the notice instead of the box; moderators get [del] and [mute] on
   each line. Live over the room's socket (core/live.js). Logged out: a prompt to log in. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { hm, when } from '../core/format.js';
import { toast, oops, pageTitle, dialog } from '../core/ui.js';
import { S } from '../core/state.js';
import { onLeave } from '../core/router.js';
import { openRoom } from '../core/live.js';
import { rich } from '../widgets/richtext.js';
import { reportDialog } from '../widgets/safety.js';

const MAX = 2000;
const KEEP = 600;                              // lines kept on the page; older ones scroll away for good

function loginPrompt(root) {
  root.append(pageTitle('#ourspace'), h('div', { class: 'ms-section ms-loginprompt' },
    h('p', { text: '#ourspace is the room everybody hangs out in. log in (or join) to read and chat.' }),
    h('a', { class: 'btn98 go', href: '/login?next=%2Fourspace', text: 'Log in' }), ' ', h('a', { class: 'btn98', href: '/join', text: 'Join!' })));
}

// the mute window (moderators): how long, and why
async function muteDialog(name) {
  const hours = h('select', { 'aria-label': 'how long' }, h('option', { value: '1', text: '1 hour' }), h('option', { value: '24', text: '24 hours' }), h('option', { value: '168', text: '7 days' }));
  const why = h('input', { maxLength: 300, placeholder: 'why (the log keeps it)', 'aria-label': 'reason' });
  if (!await dialog({ title: 'Mute ' + name, icon: '🔇', text: `${name} won't be able to write in #ourspace for a while.`, ok: 'Mute', danger: true,
    body: h('div', null, h('label', null, 'For', hours), h('label', null, 'Reason', why)) })) return;
  try { await api.post('/admin/mutes', { name, hours: Number(hours.value), reason: why.value.trim() }); toast(`${name} is muted.`); } catch (e) { oops(e); }
}

export async function renderOurspace(root) {
  if (!S.me) { loginPrompt(root); return; }
  const me = S.me;
  const d = await api.get('/ourspace/messages');
  const msgs = [];                             // oldest first
  const have = new Set();
  const sys = [];                              // join / quit lines: { afterId, text }
  let older = d.next, online = [], mutedUntil = d.mutedUntil || 0, slow = d.slowMode || { seconds: 3, perMinute: 20 };
  let nextOk = 0, tick = null, muteTimer = null, firstPresence = true;

  /* ---- the window ---- */
  const log = h('div', { class: 'ms-irc-log', role: 'log', 'aria-live': 'polite', 'aria-label': '#ourspace' });
  const nicks = h('div', { class: 'ms-irc-nicks', 'aria-label': 'who is here' });
  const netEl = h('div', { class: 'ms-chat-net', hidden: true });
  const form = h('div', { class: 'ms-irc-form' });
  const count = h('button', { class: 'btn98 ms-irc-toggle', type: 'button', 'aria-label': 'who is here', onclick: () => win.classList.toggle('nicks-open') });
  const win = h('div', { class: 'win98 ms-irc' },
    h('div', { class: 'title-bar' }, h('span', { text: '#ourspace' }), h('span', { class: 'ms-right-tools' }, count)),
    h('div', { class: 'ms-irc-topic', text: `Topic: be kind, be yourself. slow mode: one message every ${slow.seconds} seconds.` }),
    netEl,
    h('div', { class: 'ms-irc-main' }, log, nicks),
    form);
  root.append(win);

  const known = () => [...new Map([...online, ...msgs.map(m => m.author)].map(u => [u.name.toLowerCase(), u])).values()];
  const mentionsMe = body => new RegExp('(^|[^A-Za-z0-9_~*.\\-@])@' + me.name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(?![A-Za-z0-9_])', 'i').test(body);

  const lineEl = (m, names) => {
    const mine = m.author.id === me.id;
    return h('div', { class: 'ms-irc-line' + (mine ? ' me' : '') + (mentionsMe(m.body) ? ' hl' : ''), dataset: { id: String(m.id) } },
      h('span', { class: 'ms-irc-time', title: when(m.created), text: `[${hm(m.created)}]` }), ' ',
      h('a', { class: 'ms-irc-nick', href: '/u/' + enc(m.author.name), text: `<${m.author.name}>` }), ' ',
      h('span', { class: 'ms-irc-text' }, rich(m.body, names, { tags: false })),
      h('span', { class: 'ms-irc-acts' },
        mine || me.isAdmin ? h('a', { href: '#', title: 'delete this line', text: '[del]', onclick: e => { e.preventDefault(); del(m); } }) : null,
        me.isAdmin && !mine ? h('a', { href: '#', title: 'mute ' + m.author.name, text: '[mute]', onclick: e => { e.preventDefault(); muteDialog(m.author.name); } }) : null,
        !mine ? h('a', { href: '#', title: 'report to the moderators', text: '[report]', onclick: e => { e.preventDefault(); reportDialog({ type: 'message', id: m.id, what: 'this message' }); } }) : null));
  };
  const sysEl = s => h('div', { class: 'ms-irc-line ms-irc-sys', text: '* ' + s.text });
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

  function paintLog(stick = true, keep = false) {
    const keepFrom = log.scrollHeight, near = atBottom();
    const names = known();
    const kids = [];
    if (older) kids.push(h('button', { class: 'btn98 ms-more', type: 'button', text: '▴ earlier messages', onclick: loadOlder }));
    sys.filter(s => s.afterId === 0).forEach(s => kids.push(sysEl(s)));
    for (const m of msgs) {
      kids.push(lineEl(m, names));
      sys.filter(s => s.afterId === m.id).forEach(s => kids.push(sysEl(s)));
    }
    if (!msgs.length) kids.push(h('div', { class: 'ms-empty', text: 'quiet in here. say something!' }));
    log.replaceChildren(...kids);
    if (keep) log.scrollTop += log.scrollHeight - keepFrom;
    else if (stick || near) log.scrollTop = log.scrollHeight;
  }

  function paintNicks() {
    const list = [...online].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    count.textContent = `👥 ${list.length}`;
    nicks.replaceChildren(h('div', { class: 'ms-irc-nickhead', text: `${list.length} here now` }),
      ...list.map(u => h('button', { class: 'ms-irc-nickbtn' + (u.id === me.id ? ' me' : ''), type: 'button', title: u.id === me.id ? 'you' : 'say something to ' + u.name,
        onclick: () => { const i = form.querySelector('input'); if (i) { i.value += (i.value && !/\s$/.test(i.value) ? ' ' : '') + '@' + u.name + ' '; i.focus(); } }, text: u.name })));
  }

  /* ---- the box: a form, a countdown, or the muted notice ---- */
  const wait = () => Math.max(0, Math.ceil((nextOk - Date.now()) / 1000));
  function paintForm() {
    clearTimeout(muteTimer);
    if (mutedUntil > Date.now()) {
      form.replaceChildren(h('div', { class: 'ms-empty ms-irc-muted', text: `you're muted in #ourspace until ${when(mutedUntil)}. you can still read it.` }));
      muteTimer = setTimeout(paintForm, Math.min(mutedUntil - Date.now() + 500, 2 ** 30));
      return;
    }
    if (form.querySelector('input')) return;
    const input = h('input', { type: 'text', maxLength: MAX, placeholder: 'say something to #ourspace…', 'aria-label': 'message', autocomplete: 'off' });
    const btn = h('button', { class: 'btn98 go', type: 'submit', text: 'Send' });
    const paintBtn = () => {
      const w = wait();
      btn.disabled = w > 0;
      btn.textContent = w > 0 ? `wait ${w}s` : 'Send';
      if (w <= 0 && tick) { clearInterval(tick); tick = null; }
    };
    const cool = seconds => {
      nextOk = Date.now() + seconds * 1000;
      paintBtn();
      if (!tick) tick = setInterval(paintBtn, 250);
    };
    const send = async () => {
      const body = input.value.trim();
      if (!body || btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await api.post('/ourspace/messages', { body });
        input.value = '';
        add([r.message], true);
      } catch (e) {
        oops(e);
        if (e.status === 403) sync().catch(() => {});                     // muted since we looked
      }
      cool(slow.seconds);
      input.focus();
    };
    form.replaceChildren(h('form', { class: 'ms-irc-send', onsubmit: e => { e.preventDefault(); send(); } }, input, btn));
    if (wait() > 0) cool(wait());
    setTimeout(() => input.focus(), 50);
  }

  /* ---- messages in ---- */
  function add(list, stick = false) {
    const last = msgs.length ? msgs[msgs.length - 1].id : 0;
    const fresh = list.filter(m => !have.has(m.id));
    if (!fresh.length) return;
    fresh.forEach(m => { have.add(m.id); msgs.push(m); });
    msgs.sort((a, b) => a.id - b.id);
    if (msgs.length > KEEP) msgs.splice(0, msgs.length - KEEP).forEach(m => have.delete(m.id));
    const tail = fresh.every(m => m.id > last) && fresh.length === 1;
    if (tail && !log.querySelector('.ms-empty')) {
      const near = atBottom();
      log.append(lineEl(fresh[0], known()));
      while (log.children.length > KEEP + 20) log.firstChild.remove();
      if (stick || near) log.scrollTop = log.scrollHeight;
    } else paintLog(stick);
  }
  function drop(id) {
    const at = msgs.findIndex(m => m.id === id);
    if (at < 0) return;
    msgs.splice(at, 1);
    have.delete(id);
    const el = [...log.children].find(k => k.dataset && k.dataset.id === String(id));
    if (el) el.remove(); else paintLog(false);
  }
  async function del(m) {
    if (!await dialog({ title: 'Delete', text: m.author.id === me.id ? 'Delete your message?' : `Take down ${m.author.name}'s message? It stays with the reports for the moderators.`, icon: '🗑', ok: 'Delete', danger: true })) return;
    try { await api.del('/chat-messages/' + m.id); drop(m.id); } catch (e) { oops(e); }
  }
  async function loadOlder() {
    if (!older) return;
    try {
      const r = await api.get('/ourspace/messages?before=' + older);
      older = r.next;
      r.messages.forEach(m => { if (!have.has(m.id)) { have.add(m.id); msgs.push(m); } });
      msgs.sort((a, b) => a.id - b.id);
      paintLog(false, true);
    } catch (e) { oops(e); }
  }
  async function sync() {
    for (let i = 0; i < 5; i++) {
      const last = msgs.length ? msgs[msgs.length - 1].id : 0;
      const r = await api.get('/ourspace/messages?after=' + last);
      mutedUntil = r.mutedUntil || 0;
      slow = r.slowMode || slow;
      add(r.messages);
      if (!r.next || !r.messages.length) break;
    }
    paintForm();
  }

  openRoom('ourspace', {
    sync,
    onState: s => {
      netEl.hidden = s === 'live' || s === 'connecting';
      netEl.textContent = s === 'polling' ? 'live updates are down. checking for new messages every few seconds…' : '';
    },
    onEvent: ev => {
      if (ev.type === 'message') add([{ ...ev.message, mine: ev.message.author.id === me.id }]);
      else if (ev.type === 'deleted') drop(ev.id);
      else if (ev.type === 'presence') {
        const before = new Set(online.map(u => u.id)), now = new Set((ev.online || []).map(u => u.id));
        const afterId = msgs.length ? msgs[msgs.length - 1].id : 0, from = sys.length;
        if (!firstPresence) {
          (ev.online || []).filter(u => !before.has(u.id) && u.id !== me.id).forEach(u => sys.push({ afterId, text: `${u.name} has joined #ourspace` }));
          online.filter(u => !now.has(u.id)).forEach(u => sys.push({ afterId, text: `${u.name} has quit` }));
        }
        firstPresence = false;
        online = ev.online || [];
        paintNicks();
        const near = atBottom();
        sys.slice(from).forEach(x => log.append(sysEl(x)));
        if (sys.length > 40) sys.splice(0, sys.length - 40);
        if (near) log.scrollTop = log.scrollHeight;
      } else if (ev.type === 'removed') toast('that room is closed to you.', true);
      else if (ev.type === 'signedout' || ev.type === 'elsewhere') {
        netEl.hidden = false;
        netEl.textContent = ev.type === 'signedout' ? 'you\'ve been signed out. log in again to keep chatting.'
          : '#ourspace is open in too many other tabs, so live updates stopped here. reload to bring them back.';
        if (ev.type === 'signedout') toast('you\'ve been signed out.', true);
      }
    },
  });
  onLeave(() => { clearInterval(tick); clearTimeout(muteTimer); });

  online = d.online || [];
  d.messages.forEach(m => { have.add(m.id); msgs.push(m); });
  msgs.sort((a, b) => a.id - b.id);
  paintNicks();
  paintLog(true);
  paintForm();
}
