/* core/chrome.js — the header (who's logged in) and the tabs with their badges. */

import { h, $, userPath } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { S } from './state.js';
import { go } from './router.js';

export function paintChrome() {
  const who = $('#who');
  who.replaceChildren();
  if (S.me) {
    who.append(
      h('img', { src: S.me.avatar, alt: '' }),
      h('a', { href: userPath(S.me.name), text: S.me.name }),
      h('a', { class: 'btn98', href: '/settings', text: 'Settings' }),
      h('button', { class: 'btn98', type: 'button', text: 'Log out', onclick: logout }));
  } else {
    who.append(h('a', { class: 'btn98', href: '/login', text: 'Log in' }), h('a', { class: 'btn98 go', href: '/join', text: 'Join!' }));
  }
  const path = location.pathname;
  const tab = (label, href, badge, on) => h('a', { class: 'ms-tab' + (on ? ' on' : ''), href },
    label, badge ? h('span', { class: 'ms-badge', text: badge >= 99 ? '99+' : String(badge) }) : null);   // the server stops counting at 99
  const mine = S.me && (path === userPath(S.me.name) || path.toLowerCase().startsWith(userPath(S.me.name).toLowerCase() + '/'));
  const tabs = [
    tab(S.me ? 'Feed' : 'Home', '/', 0, path === '/'),
    S.me ? tab('My Page', userPath(S.me.name), 0, mine) : null,
    tab('Browse', '/browse', 0, path === '/browse'),
    S.me ? tab('Notifications', '/notifications', S.counts.notifications, path === '/notifications' || path === '/requests') : null,
    S.me ? tab('Inbox', '/inbox', S.counts.unread, path.startsWith('/inbox')) : null,
    S.me ? tab('🔖 Bookmarks', '/bookmarks', 0, path === '/bookmarks') : null,
    tab('Boards', '/boards', 0, path === '/boards' || path.startsWith('/boards/')),
    tab('🔮 Horoscope', '/horoscope', 0, path.startsWith('/horoscope')),
    h('a', { class: 'ms-tab', href: '/blog/', text: 'Blog' }),
    S.me && S.me.isAdmin ? tab('Moderation', '/admin', S.counts.reports, path === '/admin') : null,
    !S.me ? tab('Join', '/join', 0, path.startsWith('/join')) : null,
  ];
  $('#tabs').replaceChildren(...tabs.filter(Boolean));
}

export async function logout() {
  try { await api.post('/logout'); } catch { /* logged out either way */ }
  S.me = null;
  S.counts = { requests: 0, unread: 0, notifications: 0, reports: 0 };
  toast('logged out. come back soon!');
  go('/');
}
