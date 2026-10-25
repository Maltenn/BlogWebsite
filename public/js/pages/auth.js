/* pages/auth.js — sign up, finish a provider sign-up, log in, forgot / reset password. */

import { h, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast } from '../core/ui.js';
import { S, loadMe, options } from '../core/state.js';
import { go } from '../core/router.js';
import { authTabs, providerButtons, profileFields, FINE_PRINT, LOGIN_ERRORS } from '../widgets/auth-forms.js';

export async function renderJoin(root) {
  if (S.me) { go(userPath(S.me.name), true); return; }
  const opts = await options();
  const f = profileFields(opts);
  const email = h('input', { class: 'su-name', type: 'email', maxLength: 254, placeholder: 'you@example.com', 'aria-label': 'email', autocomplete: 'email' });
  const pw = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'password (8+ characters)', 'aria-label': 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'type it again', 'aria-label': 'password again', autocomplete: 'new-password' });
  const err = h('div', { class: 'su-err', role: 'alert' });
  const goBtn = h('button', { class: 'btn98 su-go', type: 'submit', text: '★ make my page' });
  const emailForm = h('form', { class: 'su-form', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    if (pw.value !== pw2.value) { err.textContent = 'the two passwords don\'t match.'; return; }
    goBtn.disabled = true;
    try {
      const r = await api.post('/signup', { email: email.value, password: pw.value, name: f.name.value.trim(), birthday: f.birthday.value, avatar: f.pic, rulesOk: f.rules.checked });
      S.me = r.user;
      await loadMe();
      toast(`welcome to ourspace, ${r.user.name}!`);
      go(userPath(r.user.name));
    } catch (ex) { err.textContent = ex.message; goBtn.disabled = false; }
  } },
  h('label', { class: 'su-label', text: 'email' }), email,
  h('label', { class: 'su-label', text: 'password' }), pw, pw2,
  f.el, err,
  h('div', { class: 'su-btns' }, goBtn, h('span', null, 'already have a page? ', h('a', { href: '/login', text: 'log in' }))));
  const other = h('div', { class: 'su-other' },
    h('p', { class: 'su-lead', text: 'sign up with an account you already have. you\'ll still pick a screen name and enter your birthday on the next page.' }),
    providerButtons('login'),
    h('p', { class: 'su-hint', text: 'we only ask those sites for your name, email and an id. we never see your password there, and we never post anything.' }));
  root.append(h('div', { class: 'ms-signup win98' },
    h('div', { class: 'title-bar' }, h('span', { text: '★ join ourspace' })),
    h('div', { class: 'su-body' },
      h('p', { class: 'su-lead', text: 'make your page in about a minute. you can decorate everything afterwards.' }),
      authTabs([['✉ Email', emailForm], ['🌐 Other options', other]]),
      h('p', { class: 'su-fine', text: FINE_PRINT }))));
  email.focus();
}

// someone came back from Google & co. for the first time: screen name + birthday, then they're in
export async function renderFinish(root) {
  let pend;
  try { pend = await api.get('/signup/pending'); } catch (e) {
    root.append(h('div', { class: 'ms-error', text: e.message }), h('p', { class: 'ms-empty' }, h('a', { href: '/join', text: 'back to join' })));
    return;
  }
  const opts = await options();
  const f = profileFields(opts, { nameHint: pend.nameHint });
  const err = h('div', { class: 'su-err', role: 'alert' });
  const goBtn = h('button', { class: 'btn98 su-go', type: 'submit', text: '★ make my page' });
  root.append(h('form', { class: 'ms-signup win98', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    goBtn.disabled = true;
    try {
      const r = await api.post('/signup/finish', { name: f.name.value.trim(), birthday: f.birthday.value, avatar: f.pic, rulesOk: f.rules.checked });
      S.me = r.user;
      await loadMe();
      toast(`welcome to ourspace, ${r.user.name}!`);
      go(userPath(r.user.name));
    } catch (ex) { err.textContent = ex.message; goBtn.disabled = false; }
  } },
  h('div', { class: 'title-bar' }, h('span', { text: '★ almost there' })),
  h('div', { class: 'su-body' },
    h('p', { class: 'su-lead' }, `signing up with ${pend.label}`, pend.email ? ` (${pend.email})` : '', '. just a couple more things:'),
    f.el, err,
    h('div', { class: 'su-btns' }, goBtn, h('a', { href: '/join', text: 'cancel' })),
    h('p', { class: 'su-fine', text: FINE_PRINT }))));
  f.name.focus();
}

export async function renderLogin(root) {
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  const safeNext = next && /^\/(?![/\\])[^\\]*$/.test(next) ? next : null;   // a path on this site only
  if (S.me) { go(safeNext || '/', true); return; }
  const login = h('input', { class: 'su-name', maxLength: 254, placeholder: 'email or screen name', 'aria-label': 'email or screen name', autocomplete: 'username' });
  const pw = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'password', 'aria-label': 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'su-err', role: 'alert', text: LOGIN_ERRORS[params.get('error')] || '' });
  const emailForm = h('form', { class: 'su-form', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    try {
      const r = await api.post('/login', { login: login.value.trim(), password: pw.value });
      S.me = r.user;
      await loadMe();
      toast(`welcome back, ${r.user.name}!`);
      go(safeNext || '/');
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('label', { class: 'su-label', text: 'email or screen name' }), login,
  h('label', { class: 'su-label', text: 'password' }), pw,
  h('div', { class: 'su-btns' }, h('button', { class: 'btn98 su-go', type: 'submit', text: 'Log in' }), h('a', { href: '/forgot', text: 'forgot your password?' })));
  root.append(h('div', { class: 'ms-signup win98' },
    h('div', { class: 'title-bar' }, h('span', { text: '🔑 log in to ourspace' })),
    h('div', { class: 'su-body' }, err,
      authTabs([['✉ Email', emailForm], ['🌐 Other options', h('div', { class: 'su-other' }, providerButtons('login', safeNext))]]),
      h('p', { class: 'su-fine' }, 'new here? ', h('a', { href: '/join', text: 'make a page' })))));
  login.focus();
}

export async function renderForgot(root) {
  const email = h('input', { class: 'su-name', type: 'email', maxLength: 254, placeholder: 'you@example.com', 'aria-label': 'email', autocomplete: 'email' });
  const msg = h('div', { class: 'su-err', role: 'alert' });
  root.append(h('form', { class: 'ms-signup win98', onsubmit: async e => {
    e.preventDefault();
    msg.textContent = '';
    try {
      await api.post('/password/forgot', { email: email.value });
      msg.classList.add('ok');
      msg.textContent = 'if that email has an OurSpace page, a reset link is on its way. it works for one hour.';
    } catch (ex) { msg.classList.remove('ok'); msg.textContent = ex.message; }
  } },
  h('div', { class: 'title-bar' }, h('span', { text: '🔑 forgot your password?' })),
  h('div', { class: 'su-body' },
    h('p', { class: 'su-lead', text: 'type the email you signed up with and we\'ll send you a link to pick a new password.' }),
    email, msg,
    h('div', { class: 'su-btns' }, h('button', { class: 'btn98 su-go', type: 'submit', text: 'Send the link' }), h('a', { href: '/login', text: 'back to log in' })))));
  email.focus();
}

export async function renderReset(root) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) { root.append(h('div', { class: 'ms-error', text: 'that reset link is incomplete. copy the whole link from the email.' })); return; }
  const pw = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'new password (8+ characters)', 'aria-label': 'new password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'type it again', 'aria-label': 'new password again', autocomplete: 'new-password' });
  const err = h('div', { class: 'su-err', role: 'alert' });
  root.append(h('form', { class: 'ms-signup win98', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    if (pw.value !== pw2.value) { err.textContent = 'the two passwords don\'t match.'; return; }
    try {
      const r = await api.post('/password/reset', { token, password: pw.value });
      history.replaceState(null, '', '/reset');                 // the token is spent: drop it from the address bar
      S.me = r.user;
      await loadMe();
      toast('new password saved. you\'re logged in (and logged out everywhere else).');
      go(userPath(r.user.name));
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'title-bar' }, h('span', { text: '🔑 pick a new password' })),
  h('div', { class: 'su-body' }, pw, pw2, err, h('div', { class: 'su-btns' }, h('button', { class: 'btn98 su-go', type: 'submit', text: 'Save password' })))));
  pw.focus();
}
