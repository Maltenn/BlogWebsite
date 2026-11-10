/* widgets/newgroup.js — the New group window: a name (optional) and the people picker. Resolves the new chat, or null
   if it was cancelled. Friends join at once; anybody else gets an invite, which the picker says. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops, dialog } from '../core/ui.js';
import { peoplePicker } from './peoplepicker.js';

export async function newGroupDialog() {
  const picker = peoplePicker();
  const title = h('input', { class: 'ms-pp-search', maxLength: 60, placeholder: 'group name (optional)', 'aria-label': 'group name' });
  const body = h('div', { class: 'ms-newgroup' },
    h('label', null, 'Group name', title),
    picker.el,
    h('p', { class: 'os-hint', text: 'friends join right away. anyone else gets an invite to accept first. up to 50 people.' }));
  while (true) {
    if (!await dialog({ title: 'New group', icon: '👥', ok: 'Create group', body })) return null;
    const members = picker.names();
    if (!members.length) { toast('pick at least one person.', true); continue; }
    try {
      const r = await api.post('/chats', { members, title: title.value.trim() || undefined });
      return r.chat;
    } catch (e) { oops(e); }
  }
}
