/* core/chrome.js — the header (who's logged in), the tabs with their badges, and the bars under them: "confirm your
   email" until the address is confirmed, and the note on an account a moderator hasn't looked at yet. */

import { h, $, userPath } from './dom.js';
import { api } from './api.js';
import { toast, oops } from './ui.js';
import { S, loadMe } from './state.js';
import { go } from './router.js';

// "send it again": the confirmation email (POST /api/me/verify/resend). Resolves true when one went out.
export async function resendVerification() {
  try {
    await api.post('/me/verify/resend');
    toast('sent! it can take a minute. check your spam folder too.');
    return true;
  } catch (e) {
    if (e.code === 'verified') { toast('your email is already confirmed.'); loadMe().catch(() => {}); } else oops(e);
    return false;
  }
}

function paintBanners() {
  const box = $('#banners');
  if (!box) return;
  box.replaceChildren();
  if (!S.me) return;
  const a = S.account;
  if (!a.verified) {
    const send = h('button', { class: 'btn98', type: 'button', text: 'send it again', onclick: async () => { send.disabled = true; await resendVerification(); send.disabled = false; } });
    box.append(h('div', { class: 'os-banner', role: 'status', dataset: { kind: 'unverified' } },
      h('span', { text: '✉ confirm your email to post, comment and message. we sent you a link when you signed up. ' }), send));
  }
  if (a.held) box.append(h('div', { class: 'os-banner', role: 'status', dataset: { kind: 'held' } },
    h('span', { text: '⏳ a moderator will take a quick look at your new account, usually within a day. until then you can set up your page and look around.' })));
}

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
    S.me ? tab('Messages', '/messages', S.counts.unread, path.startsWith('/messages') || path.startsWith('/inbox')) : null,
    S.me ? tab('🔖 Bookmarks', '/bookmarks', 0, path === '/bookmarks') : null,
    tab('Boards', '/boards', 0, path === '/boards' || path.startsWith('/boards/')),
    tab('#ourspace', '/ourspace', 0, path === '/ourspace'),
    tab('🔮 Horoscope', '/horoscope', 0, path.startsWith('/horoscope')),
    h('a', { class: 'ms-tab', href: '/blog/', text: 'Blog' }),
    S.me && S.me.isAdmin ? tab('Moderation', '/admin', S.counts.reports, path === '/admin') : null,
    !S.me ? tab('Join', '/join', 0, path.startsWith('/join')) : null,
  ];
  $('#tabs').replaceChildren(...tabs.filter(Boolean));
  paintBanners();
}

export async function logout() {
  try { await api.post('/logout'); } catch { /* logged out either way */ }
  S.me = null;
  S.counts = { requests: 0, unread: 0, notifications: 0, reports: 0 };
  toast('logged out. come back soon!');
  go('/');
}
