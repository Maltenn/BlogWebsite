/* widgets/groupsettings.js — a group chat's settings, under the chat window's title bar: the name (the owner can change
   it), who is in (the owner removes), who has been invited and hasn't answered, Add people (the owner), and Leave.
     groupSettings({ onChange(chat), onLeft() }) → { el, update(chat) }
   update(chat) redraws it from a chat as the API gives it. The window calls it again when the room says `changed`. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops, dialog } from '../core/ui.js';
import { S } from '../core/state.js';
import { avatar, nameLink } from './people.js';
import { peoplePicker } from './peoplepicker.js';

export function groupSettings({ onChange, onLeft }) {
  const el = h('div', { class: 'ms-groupset' });
  let chat = null, picker = null, drawn = '';

  const rename = async input => {
    try { const r = await api.put('/chats/' + chat.id, { title: input.value.trim() }); toast('renamed.'); onChange(r.chat); } catch (e) { oops(e); }
  };
  const remove = async u => {
    if (!await dialog({ title: 'Remove ' + u.name, icon: '🚪', text: `Take ${u.name} out of this group?`, ok: 'Remove', danger: true })) return;
    try { const r = await api.del('/chats/' + chat.id + '/members/' + encodeURIComponent(u.name)); toast(u.name + ' is out.'); onChange(r.chat); } catch (e) { oops(e); }
  };
  const add = async () => {
    const names = picker.names();
    if (!names.length) { toast('pick someone first.', true); return; }
    try {
      const r = await api.post('/chats/' + chat.id + '/members', { names });
      toast('added. friends are in; anyone else has been invited.');
      picker.clear();
      onChange(r.chat);
    } catch (e) { oops(e); }
  };
  const leave = async () => {
    if (!await dialog({ title: 'Leave group', icon: '🚪', text: 'Leave this group? You\'ll stop getting its messages.', ok: 'Leave', danger: true })) return;
    try { await api.post('/chats/' + chat.id + '/leave'); toast('you left the group.'); onLeft(); } catch (e) { oops(e); }
  };

  function update(next) {
    chat = next;
    // only when something about the group changed: a redraw would lose the names ticked in Add people
    const key = JSON.stringify([chat.title, chat.role, chat.owner && chat.owner.id, chat.members.map(m => m.id), (chat.invited || []).map(m => m.id)]);
    if (key === drawn) return;
    drawn = key;
    const owner = chat.role === 'owner';
    const name = h('input', { class: 'ms-pp-search', maxLength: 60, value: chat.title || '', placeholder: 'group name', 'aria-label': 'group name', disabled: !owner });
    const person = (u, extra) => h('div', { class: 'ms-gs-row' }, avatar(u, 28), h('span', { class: 'ms-pp-name' }, nameLink(u)), extra);
    const ownerId = chat.owner ? chat.owner.id : null;
    const rows = [
      h('div', { class: 'ms-gs-row' }, h('img', { class: 'ms-avatar ms-pp-av', src: S.me.avatar, alt: '' }), h('span', { class: 'ms-pp-name', text: S.me.name + ' (you)' }), owner ? h('span', { class: 'ms-chip', text: 'owner' }) : null),
      ...chat.members.map(u => person(u, [
        ownerId === u.id ? h('span', { class: 'ms-chip', text: 'owner' }) : null,
        owner && ownerId !== u.id ? h('button', { class: 'btn98', type: 'button', text: 'Remove', onclick: () => remove(u) }) : null])),
      ...(chat.invited || []).map(u => person(u, h('span', { class: 'ms-chip', text: 'invited' }))),
    ];
    picker = owner ? peoplePicker({ exclude: [S.me.name, ...chat.members.map(m => m.name), ...(chat.invited || []).map(m => m.name)] }) : null;
    el.replaceChildren(
      h('div', { class: 'ms-subhead', text: `Group settings · ${chat.memberCount} in` }),
      h('div', { class: 'ms-gs-body' },
        owner ? h('div', { class: 'ms-gs-name' }, name, h('button', { class: 'btn98', type: 'button', text: 'Rename', onclick: () => rename(name) })) : null,
        h('div', { class: 'ms-gs-people' }, rows),
        owner ? h('div', { class: 'ms-gs-add' }, h('b', { text: 'Add people' }), picker.el, h('button', { class: 'btn98 go', type: 'button', text: 'Add to group', onclick: add })) : null,
        h('div', { class: 'ms-gs-leave' }, h('button', { class: 'btn98 danger', type: 'button', text: 'Leave group', onclick: leave }))));
  }
  return { el, update };
}
