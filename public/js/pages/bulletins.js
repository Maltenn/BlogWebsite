/* pages/bulletins.js — the Bulletin Board. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when } from '../core/format.js';
import { toast, oops, pageTitle, paged } from '../core/ui.js';
import { S } from '../core/state.js';
import { route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { postActions } from '../widgets/safety.js';

export async function renderBulletins(root) {
  root.append(pageTitle('Bulletin Board'));
  if (S.me) {
    const subject = h('input', { class: 'os-input', maxLength: 80, placeholder: 'subject', 'aria-label': 'subject' });
    const body = h('textarea', { class: 'os-input', maxLength: 2000, placeholder: 'tell everybody something…', 'aria-label': 'bulletin' });
    root.append(h('details', { class: 'os-panel' }, h('summary', { class: 'ms-boxtitle', text: '📌 post a bulletin' }),
      h('form', { class: 'os-form', onsubmit: async e => {
        e.preventDefault();
        try { await api.post('/bulletins', { subject: subject.value, body: body.value }); toast('bulletin posted!'); route(); } catch (err) { oops(err); }
      } }, subject, body, h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Post bulletin' })))));
  }
  await paged(root, cur => api.get('/bulletins' + (cur ? '?before=' + enc(cur) : '')), b => {
    const card = h('div', { class: 'ms-bulletin' },
      h('div', { class: 'ms-bulletin-head' }, avatar(b.author, 32), h('span', null, 'from ', nameLink(b.author)), h('span', { class: 'ms-time', text: when(b.created) }), postActions(b, () => card.remove())),
      h('div', { class: 'ms-bulletin-subj', text: b.subject }),
      h('div', { class: 'ms-bulletin-body', text: b.body }));
    return card;
  }, 'no bulletins yet.');
}
