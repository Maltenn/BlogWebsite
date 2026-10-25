/* widgets/auth-forms.js — what the join, finish-sign-up and log-in pages share,
   plus the picture gallery (Edit My Page) and the sign-in error texts (Settings). */

import { h, enc } from '../core/dom.js';
import { S } from '../core/state.js';

// Email | Other options
export function authTabs(panels) {
  const bar = h('div', { class: 'os-tabs2', role: 'tablist' });
  const holder = h('div');
  const show = i => {
    bar.querySelectorAll('button').forEach((b, j) => { b.classList.toggle('on', i === j); b.setAttribute('aria-selected', String(i === j)); });
    holder.replaceChildren(panels[i][1]);
  };
  panels.forEach(([label], i) => bar.append(h('button', { type: 'button', role: 'tab', text: label, onclick: () => show(i) })));
  show(0);
  return h('div', null, bar, holder);
}

// "Continue with Google" etc. — plain links: the Worker sends the browser on to the provider
export function providerButtons(mode, next) {
  const list = S.providers.signIn;
  if (!list.length) return h('p', { class: 'ms-empty', text: 'no other sign-in options are set up on this server yet. use your email for now.' });
  return h('div', { class: 'oauth-list' }, list.map(p => h('a', {
    class: 'btn98 oauth-btn oauth-' + p.id,
    href: `/api/oauth/${p.id}/start?mode=${mode}${next ? '&next=' + enc(next) : ''}`,
  }, h('span', { class: 'oauth-mark', text: { google: 'G', apple: 'A', microsoft: '⊞', discord: '◉', github: '⌥' }[p.id] || '→' }), `Continue with ${p.label}`)));
}

function randomName() {
  const a = ['sparkle', 'sk8r', 'emo', 'pixel', 'glitter', 'moon', 'ninja', 'pirate', 'kitty', 'punk', 'star', 'dream', 'rawr', 'cupcake', 'zombie',
    'angel', 'lil', 'dark', 'cosmic', 'bubble', 'dino', 'gamer', 'neon', 'midnight', 'cherry', 'vamp', 'frog', 'disco', 'cookie', 'storm'];
  const b = ['girl', 'boi', 'kid', 'heart', 'bunny', 'dude', 'princess', 'lord', 'queen', 'king', 'freak', 'monkey', 'wolf', 'panda', 'ghost',
    'pants', 'chick', 'master', 'fairy', 'pop', 'bear', 'tastic', 'face'];
  const nums = ['87', '89', '91', '93', '95', '4ever', '101', '2000', '13', '777', '247', '1337', '88', '42'];
  const r = arr => arr[Math.floor(Math.random() * arr.length)];
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const shapes = [(x, y) => `xX_${x}${cap(y)}_Xx`, (x, y) => `${x}${y}${r(nums)}`, (x, y) => `~*${x}${y}*~`, (x, y) => `${x}_${y}${r(nums)}`, (x, y) => `${cap(x)}${cap(y)}`];
  return r(shapes)(r(a), r(b)).slice(0, 20);
}

export function avatarGallery(avatars, selected, onPick) {
  const box = h('div', { class: 'av-gallery' });
  const groups = [...new Set(avatars.map(a => a.group))];
  groups.forEach(g => {
    const list = avatars.filter(a => a.group === g);
    box.append(h('div', { class: 'av-sec' }, h('div', { class: 'av-group', text: `${g} (${list.length})` }),
      h('div', { class: 'su-avatars' }, list.map(a => h('button', {
        class: 'su-av' + (a.file === selected ? ' sel' : ''), type: 'button', title: a.desc, 'aria-label': a.desc || 'picture', dataset: { src: a.file },
        onclick: () => { box.querySelectorAll('.su-av').forEach(x => x.classList.toggle('sel', x.dataset.src === a.file)); onPick(a.file); },
      }, h('img', { loading: 'lazy', src: a.file, alt: '' }))))));
  });
  return box;
}

// the fields every sign-up needs, whichever way you sign up: screen name, birthday, picture, house rules
export function profileFields(opts, { nameHint = '' } = {}) {
  const f = { pic: opts.avatars[0].file };
  f.name = h('input', { class: 'su-name', maxLength: 20, placeholder: 'pick a screen name', 'aria-label': 'screen name', autocomplete: 'nickname', value: nameHint });
  const now = new Date();
  f.birthday = h('input', { class: 'su-name su-date', type: 'date', 'aria-label': 'birthday', min: '1900-01-01', max: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` });
  f.rules = h('input', { type: 'checkbox' });
  f.el = h('div', null,
    h('label', { class: 'su-label', text: 'screen name' }),
    h('div', { class: 'su-namerow' }, f.name, h('button', { class: 'btn98', type: 'button', text: '🎲', title: 'random 2006 name', onclick: () => { f.name.value = randomName(); } })),
    h('div', { class: 'su-hint', text: '3–20 characters: letters, numbers, _ ~ * . - (no spaces). this is your page address, and it can\'t be changed yet.' }),
    h('label', { class: 'su-label', text: 'birthday' }), f.birthday,
    h('div', { class: 'su-hint', text: 'kept private. it confirms you\'re old enough to join, and it\'s where your star sign and daily horoscope come from. your page shows your age and sign (you can hide them).' }),
    h('label', { class: 'su-label', text: 'pick a picture' }),
    avatarGallery(opts.avatars, f.pic, x => { f.pic = x; }),
    h('div', { class: 'su-checks' },
      h('label', null, f.rules, h('span', null, 'I\'ve read the ', h('a', { href: '/rules', target: '_blank', text: 'house rules' }), ' and I\'ll be nice.'))));
  return f;
}

export const FINE_PRINT = 'we keep your email, your birthday, a scrambled copy of your password, what you post, and a scrambled copy of your IP address for spam limits. no ads, no tracking. delete your account any time in Settings and it\'s gone.';

export const LOGIN_ERRORS = {
  cancelled: 'sign-in was cancelled.',
  failed: 'that didn\'t work. try again, or use your email.',
  expired: 'that sign-in took too long or was already used. try again.',
  unavailable: 'that sign-in option isn\'t set up on this server.',
  suspended: 'this account has been suspended for breaking the house rules.',
  busy: 'too many tries. wait a few minutes.',
  email_in_use: 'there\'s already an OurSpace page with that email. log in with your password, then connect it in Settings → sign-in methods. (forgot your password? reset it below.)',
};
