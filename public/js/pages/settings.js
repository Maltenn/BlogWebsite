/* pages/settings.js — Settings: account, sign-in methods, Spotify, privacy, blocks, delete. */

import { h, $, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago } from '../core/format.js';
import { toast, oops, dialog, pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, route } from '../core/router.js';
import { logout } from '../core/chrome.js';
import { LOGIN_ERRORS } from '../widgets/auth-forms.js';
import { topSongs } from '../widgets/songs.js';

const SPOTIFY_ERRORS = {
  not_allowlisted: 'Spotify said no: this site\'s Spotify app is in development mode, which only lets people the site owner adds by hand connect (five at most). ask a moderator to add the email on your Spotify account.',
  revoked: 'Spotify stopped letting us read your top songs (access was removed on Spotify\'s side). connect again to fix it.',
  failed: 'that Spotify connection didn\'t work. try again in a minute.',
  busy: 'Spotify is busy right now. we\'ll try again later.',
};
const providerName = id => ({ google: 'Google', apple: 'Apple', microsoft: 'Microsoft', discord: 'Discord', github: 'GitHub', spotify: 'Spotify' })[id] || id;

export async function renderSettings(root) {
  const params = new URLSearchParams(location.search);
  if (params.get('linked')) toast(`connected! you can now log in with ${providerName(params.get('linked'))}.`);
  if (params.get('spotify') === 'connected') toast('Spotify connected! your top songs are on your page.');
  if (params.get('error') === 'identity_taken') toast(`that ${providerName(params.get('provider'))} account is already connected to a different OurSpace page.`, true);
  else if (params.get('error')) toast(LOGIN_ERRORS[params.get('error')] || 'that didn\'t work.', true);
  const spotifyResult = params.get('spotify');
  if (params.toString()) history.replaceState(null, '', '/settings' + location.hash);

  const [acct, blocks] = await Promise.all([api.get('/me/account'), api.get('/blocks')]);
  root.append(pageTitle('Settings'));
  const panel = (title, ...kids) => h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: title }), kids);

  // account
  const bday = new Date(acct.birthday + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  root.append(panel('👤 your account', h('div', { class: 'os-form' },
    h('div', null, h('b', { text: 'email: ' }), acct.email || `(none: you signed up with ${acct.identities[0] ? acct.identities[0].label : 'another site'})`),
    h('div', null, h('b', { text: 'birthday: ' }), `${bday} · ${acct.sign.glyph} ${acct.sign.name}`, h('span', { class: 'os-hint', text: ' (private. if it\'s wrong, ask a moderator.)' })))));

  // how you sign in
  const methods = h('div', { class: 'os-form' });
  const cur = h('input', { class: 'os-input', type: 'password', autocomplete: 'current-password', maxLength: 200 });
  const next = h('input', { class: 'os-input', type: 'password', autocomplete: 'new-password', maxLength: 200 });
  methods.append(h('form', { class: 'os-sub', onsubmit: async e => {
    e.preventDefault();
    try { await api.post('/me/password', { current: cur.value, next: next.value }); toast(acct.hasPassword ? 'password changed. other devices were logged out.' : 'password set.'); route(); } catch (err) { oops(err); }
  } },
  h('b', { text: acct.hasPassword ? '🔑 change your password' : `🔑 set a password (so you can also log in with your ${acct.email ? 'email' : 'screen name'})` }),
  acct.hasPassword ? h('label', null, 'current password', cur) : null,
  h('label', null, 'new password (8+ characters)', next),
  h('div', null, h('button', { class: 'btn98', type: 'submit', text: acct.hasPassword ? 'Change password' : 'Set password' }))));
  const linked = new Set(acct.identities.map(i => i.provider));
  methods.append(h('b', { text: '🌐 other sign-in options' }));
  acct.identities.forEach(i => methods.append(h('div', { class: 'ms-reqrow' },
    h('div', { class: 'ms-reqmid' }, h('b', { text: i.label }), i.email ? ` · ${i.email}` : '', h('div', { class: 'ms-time', text: 'connected ' + when(i.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Disconnect', onclick: async () => {
      if (!await dialog({ title: 'Disconnect', text: `Stop using ${i.label} to log in?`, icon: '🔌', ok: 'Disconnect' })) return;
      try { await api.del('/me/identities/' + i.provider); toast('disconnected.'); route(); } catch (e) { oops(e); }
    } }))));
  const addable = acct.available.filter(p => !linked.has(p.id));
  if (addable.length) {
    methods.append(h('div', { class: 'oauth-list' }, addable.map(p => h('a', { class: 'btn98 oauth-btn oauth-' + p.id, href: `/api/oauth/${p.id}/start?mode=link` }, `Connect ${p.label}`))));
  } else if (!acct.identities.length) methods.append(h('div', { class: 'os-hint', text: 'no other sign-in options are set up on this server yet.' }));
  root.append(panel('🔐 sign-in methods', methods));

  // Spotify
  const sp = acct.spotify;
  const spBox = h('div', { class: 'os-form', id: 'spotify' });
  if (!sp.ready) spBox.append(h('p', { class: 'os-hint', text: 'Spotify connections aren\'t set up on this server yet.' }));
  else if (!sp.connected) {
    spBox.append(h('p', { text: 'connect your Spotify account and your top songs show up on your page. we only ask Spotify for your top tracks: we can\'t see your playlists, play anything, or change anything.' }),
      h('div', null, h('a', { class: 'btn98 go', href: '/api/oauth/spotify/start?mode=spotify', text: '♫ connect Spotify' })));
    if (SPOTIFY_ERRORS[spotifyResult]) spBox.append(h('div', { class: 'ms-error', text: SPOTIFY_ERRORS[spotifyResult] }));
  } else {
    const range = h('select', { 'aria-label': 'time range' }, [['short_term', 'the last 4 weeks'], ['medium_term', 'the last 6 months'], ['long_term', 'all time']]
      .map(([v, l]) => h('option', { value: v, text: l, selected: v === sp.timeRange })));
    const show = h('input', { type: 'checkbox', checked: sp.show });
    const save = async () => { try { await api.put('/me/spotify', { timeRange: range.value, show: show.checked }); toast('saved.'); route(); } catch (e) { oops(e); } };
    range.addEventListener('change', save);
    show.addEventListener('change', save);
    spBox.append(
      h('div', null, h('b', { text: 'connected as ' }), sp.displayName || 'you', sp.fetched ? h('span', { class: 'ms-time', text: ` · updated ${ago(sp.fetched)}` }) : null),
      sp.error ? h('div', { class: 'ms-error', text: SPOTIFY_ERRORS[sp.error] || 'the last update didn\'t work.' }) : null,
      h('label', null, 'show my top songs from', range),
      h('label', { class: 'check' }, show, 'show them on my page'),
      sp.tracks.length ? topSongs({ tracks: sp.tracks.slice(0, 5), range: range.selectedOptions[0].text }) : h('div', { class: 'os-hint', text: 'no songs yet: Spotify needs a little listening history first.' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn98', type: 'button', text: '↻ update now', onclick: async () => { try { await api.post('/me/spotify/refresh'); toast('updated.'); route(); } catch (e) { oops(e); } } }),
        h('button', { class: 'btn98', type: 'button', text: 'Disconnect', onclick: async () => {
          if (!await dialog({ title: 'Disconnect Spotify', text: 'Remove your top songs and forget the connection? (To revoke it on Spotify\'s side too: spotify.com → Account → Apps.)', icon: '🔌', ok: 'Disconnect' })) return;
          try { await api.del('/me/spotify'); toast('Spotify disconnected.'); route(); } catch (e) { oops(e); }
        } })));
  }
  root.append(panel('♫ Spotify', spBox));

  // privacy
  const radio = (name, value, current, label) => h('label', null, h('input', { type: 'radio', name, value, checked: value === current }), label);
  root.append(panel('🔒 privacy', h('form', { class: 'os-form', onsubmit: async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { const r = await api.put('/me/settings', { followPolicy: fd.get('follow'), dmPolicy: fd.get('dm') }); S.settings = r.settings; toast('saved.'); } catch (err) { oops(err); }
  } },
  h('label', null, 'who can follow me', h('div', { class: 'os-radio' },
    radio('follow', 'open', S.settings.followPolicy, 'anyone (they follow right away)'), radio('follow', 'approve', S.settings.followPolicy, 'I approve each follower (private page)'))),
  h('p', { class: 'os-hint', text: 'a private page shows its statuses, blog and comments only to the people who follow you. your picture, name, details, Top 8 and counts stay visible. people who already follow you keep following. when you go back to anyone, everyone waiting is let in. comments you write on other people\'s pages are seen by whoever can see those pages. boards are public spaces: your threads and comments there are seen by everyone, even when your page is private.' }),
  h('label', null, 'who can send me messages', h('div', { class: 'os-radio' }, radio('dm', 'everyone', S.settings.dmPolicy, 'everyone'), radio('dm', 'friends', S.settings.dmPolicy, 'friends only'))),
  h('p', { class: 'os-hint', text: 'friends are people who follow each other. only your friends can write on your Friends\' Comments. blocked people can\'t see your page at all. your age and star sign can be hidden in Edit My Page.' }),
  h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Save' })))));

  // blocked
  const blockedBox = h('div');
  if (!blocks.blocked.length) blockedBox.append(h('div', { class: 'ms-empty', text: 'you haven\'t blocked anyone. to block someone, use Block User on their page.' }));
  blocks.blocked.forEach(b => blockedBox.append(h('div', { class: 'ms-reqrow' },
    h('img', { class: 'ms-avatar', src: b.user.avatar, alt: '' }),
    h('div', { class: 'ms-reqmid' }, h('b', { text: b.user.name }), h('div', { class: 'ms-time', text: 'blocked ' + when(b.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Unblock', onclick: async () => { try { await api.del('/blocks/' + enc(b.user.name)); toast('unblocked.'); route(); } catch (e) { oops(e); } } }))));
  root.append(panel(`🚫 blocked (${blocks.blocked.length})`, blockedBox));

  // delete
  const confirmBox = acct.hasPassword
    ? h('input', { class: 'os-input', type: 'password', autocomplete: 'current-password', maxLength: 200 })
    : h('input', { class: 'os-input', maxLength: 40, placeholder: S.me.name });
  root.append(h('div', { class: 'os-panel danger' }, h('div', { class: 'ms-boxtitle', text: '💀 delete my account' }),
    h('form', { class: 'os-form', onsubmit: async e => {
      e.preventDefault();
      if (!await dialog({ title: 'Delete account', icon: '⚠', danger: true, ok: 'Delete everything',
        text: 'This deletes your page, everything you posted, your messages, your followers and the people you follow, and your Spotify connection. It can\'t be undone.' })) return;
      try {
        await api.del('/me', acct.hasPassword ? { password: confirmBox.value } : { confirm: confirmBox.value });
        S.me = null; toast('your account is gone. take care out there.'); go('/');
      } catch (err) { oops(err); }
    } }, h('p', { class: 'os-hint', text: 'everything you wrote, your messages and your follows are deleted for good.' }),
    h('label', null, acct.hasPassword ? 'type your password to confirm' : 'type your screen name to confirm', confirmBox),
    h('div', null, h('button', { class: 'btn98 danger', type: 'submit', text: 'Delete my account' })))));

  root.append(h('div', { class: 'os-form' }, h('div', null, h('button', { class: 'btn98', type: 'button', text: 'Log out', onclick: logout }))));
  if (location.hash === '#spotify') setTimeout(() => { const s = $('#spotify'); if (s) s.scrollIntoView({ block: 'start' }); }, 50);
}
