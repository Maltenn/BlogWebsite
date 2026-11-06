/* pages/verify.js — /verify#token=…: the link in the confirmation email. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { S, loadMe } from '../core/state.js';
import { resendVerification } from '../core/chrome.js';

export async function renderVerify(root) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  const box = (title, ...body) => h('div', { class: 'ms-signup win98' }, h('div', { class: 'title-bar' }, h('span', { text: title })), h('div', { class: 'su-body' }, body));
  if (!token) { root.append(box('✉ confirm your email', h('div', { class: 'ms-error', text: 'that link is incomplete. copy the whole link from the email.' }))); return; }
  try {
    const r = await api.post('/verify', { token });
    history.replaceState(null, '', '/verify');                 // the token is spent: drop it from the address bar
    if (S.me) await loadMe().catch(() => {});                  // the bar at the top goes away
    root.append(box('✔ email confirmed', h('p', { class: 'su-lead', text: `thanks${r.name ? ', ' + r.name : ''}! your email is confirmed.` }),
      h('div', { class: 'su-btns' }, h('a', { class: 'btn98 su-go', href: S.me ? '/' : '/login', text: S.me ? '★ go to my feed' : 'Log in' }))));
  } catch (e) {
    const again = S.me && !S.account.verified ? h('button', { class: 'btn98', type: 'button', text: 'send me a new link', onclick: resendVerification }) : null;
    root.append(box('✉ confirm your email',
      h('div', { class: 'ms-error', text: e.code === 'verify_link' ? 'that link has expired, was already used, or was for an old address.' : e.message }),
      h('div', { class: 'su-btns' }, again, S.me ? null : h('a', { class: 'btn98', href: '/login', text: 'Log in to get a new link' }))));
  }
}
