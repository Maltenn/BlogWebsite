/* widgets/peoplepicker.js — pick people for a group chat: a search box over the server's suggestions (friends first, then
   people you talk to), chips for who is chosen, and "add by name" for anyone else. Used by New group and by a group's
   Add people. peoplePicker({ exclude: [names already in] }) → { el, names(), clear() }. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';

export function peoplePicker({ exclude = [] } = {}) {
  const skip = () => new Set(exclude.map(n => n.toLowerCase()));
  const chosen = new Map();                  // lower-case name → { name, avatar }
  let people = [];                           // the last suggestions that arrived
  let seq = 0, timer = null;
  const input = h('input', { class: 'ms-pp-search', type: 'search', placeholder: 'search friends and people you talk to', maxLength: 30, 'aria-label': 'find people to add', autocomplete: 'off' });
  const chips = h('div', { class: 'ms-pp-chips', 'aria-live': 'polite' });
  const list = h('div', { class: 'ms-pp-list' });
  const el = h('div', { class: 'ms-picker' }, chips, input, list);

  const toggle = (name, pic) => {
    const key = name.toLowerCase();
    if (chosen.has(key)) chosen.delete(key); else chosen.set(key, { name, avatar: pic });
    paint();
  };
  const row = (u, note) => {
    const on = chosen.has(u.name.toLowerCase());
    return h('button', { class: 'ms-pp-row' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => toggle(u.name, u.avatar) },
      u.avatar ? h('img', { class: 'ms-avatar ms-pp-av', src: u.avatar, alt: '' }) : h('span', { class: 'ms-pp-noav', text: '@' }),
      h('span', { class: 'ms-pp-name', text: u.name }),
      u.online ? h('span', { class: 'online-pip', title: 'online now' }) : null,
      note ? h('span', { class: 'ms-pp-note', text: note }) : null,
      h('span', { class: 'ms-pp-tick', text: on ? '✔' : '+' }));
  };
  function paint() {
    chips.replaceChildren(...[...chosen.values()].map(c => h('span', { class: 'ms-chip ms-pp-chip' }, c.name,
      h('button', { class: 'ms-pp-x', type: 'button', 'aria-label': 'remove ' + c.name, text: '✕', onclick: () => toggle(c.name, c.avatar) }))));
    const gone = skip();
    const shown = people.filter(u => !gone.has(u.name.toLowerCase()));
    const friends = shown.filter(u => u.friend), others = shown.filter(u => !u.friend);
    const q = input.value.trim();
    const typed = q && !shown.some(u => u.name.toLowerCase() === q.toLowerCase()) && !gone.has(q.toLowerCase()) ? q : '';
    list.replaceChildren(...[
      friends.length ? h('div', { class: 'ms-pp-head', text: 'Friends' }) : null, ...friends.map(u => row(u)),
      others.length ? h('div', { class: 'ms-pp-head', text: 'People you talk to' }) : null, ...others.map(u => row(u, 'gets an invite')),
      typed ? h('div', { class: 'ms-pp-head', text: 'Someone else' }) : null,
      typed ? row({ name: typed }, 'by name') : null,
      !shown.length && !typed ? h('div', { class: 'ms-empty', text: q ? 'nobody by that name.' : 'no suggestions yet. type a screen name.' }) : null].filter(Boolean));
  }
  async function load() {
    const mine = ++seq;
    try {
      const r = await api.get('/chats/suggestions?q=' + enc(input.value.trim()));
      if (mine !== seq) return;
      people = r.people || [];
    } catch { if (mine !== seq) return; people = []; }
    paint();
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); paint(); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const hit = people.find(u => u.name.toLowerCase() === q.toLowerCase());
    if (!skip().has(q.toLowerCase())) toggle(hit ? hit.name : q, hit && hit.avatar);
    input.value = '';
    load();
  });
  paint();
  load();
  return {
    el,
    names: () => [...chosen.values()].map(c => c.name),
    clear() { chosen.clear(); input.value = ''; load(); },
  };
}
