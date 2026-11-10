/* widgets/people.js — a person's picture, name link and Browse card. */

import { h, userPath } from '../core/dom.js';
import { go } from '../core/router.js';

export function avatar(u, size = 44) {
  const img = h('img', { class: 'ms-avatar', src: u.avatar, alt: u.name, loading: 'lazy', width: size, height: size });
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  img.addEventListener('click', e => { e.stopPropagation(); go(userPath(u.name)); });
  return h('span', { class: 'av-wrap' }, img);
}
export function nameLink(u, cls = 'ms-name-link') {
  return h('a', { class: cls, href: userPath(u.name), text: u.name });
}

export function personCard(u) {
  return h('div', { class: 'ms-browsecard', onclick: e => { if (!e.target.closest('a')) go(userPath(u.name)); } },
    avatar(u, 80),
    h('div', null, h('a', { class: 'ms-name-link', href: userPath(u.name), text: u.name }), u.online ? h('span', { class: 'online-pip', title: 'online now' }) : null),
    u.tag ? h('div', { class: 'ms-tagline', text: u.tag }) : null);
}
