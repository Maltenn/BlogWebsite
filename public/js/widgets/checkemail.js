/* widgets/checkemail.js — the screen after sign-up: "check your email", with Send it again. The account is already
   signed in (and may be held for a moderator); the confirmation link opens /verify#token=… */

import { h, userPath } from '../core/dom.js';
import { go } from '../core/router.js';
import { resendVerification } from '../core/chrome.js';

// r: the answer of POST /api/signup ({ user, verification: 'sent' | 'failed', held }); email: where it went
export function checkEmail({ r, email }) {
  const resend = h('button', { class: 'btn98', type: 'button', text: 'send it again', onclick: async () => {
    resend.disabled = true;
    if (await resendVerification()) { note.textContent = 'sent again. it can take a minute.'; note.classList.add('ok'); }
    setTimeout(() => { resend.disabled = false; }, 15000);
  } });
  const note = h('div', { class: 'su-err ok', role: 'status', text: r.verification === 'failed' ? '' : 'we sent it just now.' });
  if (r.verification === 'failed') { note.classList.remove('ok'); note.textContent = 'we couldn\'t send the email just now. press "send it again" in a minute.'; }
  return h('div', { class: 'ms-signup win98 su-check', dataset: { screen: 'check-email' } },
    h('div', { class: 'title-bar' }, h('span', { text: '✉ check your email' })),
    h('div', { class: 'su-body' },
      h('p', { class: 'su-lead' }, `welcome to ourspace, ${r.user.name}! we sent a link to `, h('b', { text: email }), '. open it to confirm it\'s you: until then you can set up your page, but not post, comment or message.'),
      note,
      h('p', { class: 'su-hint', text: 'no email? check your spam folder, make sure the address is right, then send it again. the link works for 24 hours.' }),
      r.held ? h('div', { class: 'ms-note', text: '⏳ a moderator will take a quick look at your new account, usually within a day. until then you can set up your page and look around.' }) : null,
      h('div', { class: 'su-btns' }, h('button', { class: 'btn98 su-go', type: 'button', text: '★ go to my page', onclick: () => go(userPath(r.user.name)) }), resend)));
}
