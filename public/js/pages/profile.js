/* pages/profile.js — someone's page, their friends and their blog. */

import { h, $, enc, userPath, poss } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago } from '../core/format.js';
import { toast, oops, dialog, skin, pageTitle } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { go, route, needLogin } from '../core/router.js';
import { avatar, personCard } from '../widgets/people.js';
import { postActions, reportDialog, blockUser } from '../widgets/safety.js';
import { topSongs } from '../widgets/songs.js';

export async function renderProfile(root, name) {
  const d = await api.get('/users/' + enc(name));
  const u = d.user, p = d.profile, rel = d.relation;
  if (d.self && u.name !== name) history.replaceState(null, '', userPath(u.name));
  if (rel && rel.blockedByMe) {
    root.append(h('div', { class: 'ms-blocked-card' }, h('p', null, h('b', { text: `you blocked ${u.name}.` }), ' you won\'t see their posts and they can\'t contact you.'),
      h('button', { class: 'btn98', type: 'button', text: 'unblock', onclick: async () => { try { await api.del('/blocks/' + enc(u.name)); toast('unblocked.'); route(); } catch (e) { oops(e); } } })));
    return;
  }
  if (u.banned) root.append(h('div', { class: 'ms-error', text: 'this account is suspended. only moderators can see this page.' }));

  const prof = h('div', { class: 'ms-profile' + (d.self ? ' is-me' : '') });
  skin(prof, p);

  /* ---- left column ---- */
  const left = h('div', { class: 'ms-left' });
  const stack = h('div', { class: 'ms-idstack' },
    p.gender ? h('div', { text: p.gender }) : null,
    d.age != null ? h('div', { text: d.age + ' years old' }) : null,
    d.sign ? h('div', null, h('a', { class: 'ms-signlink', href: '/horoscope/' + d.sign.key, text: `${d.sign.glyph} ${d.sign.name}` })) : null,
    p.hometown ? h('div', { text: p.hometown }) : null,
    h('div', { class: 'ms-lastlogin', text: 'Last Login: ' + (u.lastSeen ? ago(u.lastSeen) : 'never') }),
    h('div', { class: 'ms-lastlogin', text: 'Member since: ' + when(u.joined).split(' ').slice(0, 3).join(' ') }));
  left.append(h('div', { class: 'ms-idcard' },
    h('div', { class: 'ms-name', text: u.name }),
    h('img', { class: 'ms-bigavatar', src: u.avatar, alt: u.name }),
    d.self ? h('a', { class: 'btn98 ms-editbig', href: '/edit', text: '🎨 Edit My Page' }) : null,
    stack,
    u.online ? h('div', { class: 'online-dot on', text: '🟢 ONLINE NOW!' }) : h('div', { class: 'online-dot off', text: '⚪ offline' }),
    h('div', { class: 'ms-viewmy' }, 'View My: ', h('a', { href: userPath(u.name) + '/friends', text: 'Friends' }), ' | ', h('a', { href: userPath(u.name) + '/blog', text: 'Blog' })),
    p.mood ? h('div', { class: 'ms-moodline', text: 'Mood: ' + p.mood }) : null,
    p.tag ? h('div', { class: 'ms-tagline', text: '"' + p.tag + '"' }) : null));
  const decor = (p.decor || []).filter(Boolean);
  if (decor.length) left.append(h('div', { class: 'ms-decor' }, decor.map(src => h('img', { src, alt: '' }))));

  // Contacting box
  const grid = h('div', { class: 'ms-contactgrid' });
  const link = (icon, label, fn, cls = '') => grid.append(h('a', { class: 'ms-clink ' + cls, href: '#', onclick: e => { e.preventDefault(); fn(); } },
    h('span', { class: 'ms-cicon', text: icon }), label));
  const off = (icon, label, why) => grid.append(h('span', { class: 'ms-clink off', title: why }, h('span', { class: 'ms-cicon', text: icon }), label));
  if (d.self) {
    link('🎨', 'Edit My Page', () => go('/edit'));
    link('✏', 'Update Status', () => go('/'));
    link('📁', 'My Blog', () => go(userPath(u.name) + '/blog'));
    link('⚙', 'Settings', () => go('/settings'));
  } else if (!S.me) {
    [['✉', 'Send Message'], ['👤', 'Add to Friends'], ['💬', 'Add Comment'], ['🚫', 'Block User'], ['⚑', 'Report User']].forEach(([icon, label]) => link(icon, label, needLogin));
  } else {
    if (rel.canMessage) link('✉', 'Send Message', () => go('/inbox/' + enc(u.name)));
    else off('✉', 'Send Message', `${u.name} only takes messages from friends`);
    const f = rel.friend;
    if (f === 'friends') link('👤', 'Your Friend ✔', async () => {
      if (!await dialog({ title: 'Unfriend', text: `Remove ${u.name} from your friends?`, icon: '💔', ok: 'Unfriend' })) return;
      try { await api.del('/friends/' + enc(u.name)); route(); } catch (e) { oops(e); }
    });
    else if (f === 'requested') link('👤', 'Request sent (cancel)', async () => { try { await api.del('/friends/' + enc(u.name)); route(); } catch (e) { oops(e); } });
    else if (f === 'incoming') link('👤', 'Accept Friend Request', async () => { try { await api.post('/friends/' + enc(u.name)); toast(`you and ${u.name} are friends!`); await loadMe(); route(); } catch (e) { oops(e); } });
    else link('👤', 'Add to Friends', async () => {
      try { await api.post('/friends/' + enc(u.name)); toast(`friend request sent to ${u.name}.`); route(); } catch (e) { oops(e); }
    });
    if (rel.canComment) link('💬', 'Add Comment', () => { const t = $('#wall-input'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } });
    else off('💬', 'Add Comment', `${u.name} only takes comments from friends`);
    link('🚫', 'Block User', async () => { if (await blockUser(u.name)) route(); }, 'warn');
    link('⚑', 'Report User', () => reportDialog({ type: 'user', name: u.name, what: u.name }), 'warn');
  }
  left.append(h('div', { class: 'ms-contactbox' }, h('div', { class: 'ms-boxtitle', text: 'Contacting ' + u.name }), grid));
  left.append(h('div', { class: 'ms-urlbox' }, h('div', { class: 'ms-boxtitle', text: 'OurSpace URL:' }), h('div', { class: 'ms-urltext', text: location.origin + userPath(u.name) })));

  const ints = p.interests || {};
  const intRows = Object.keys(ints).filter(k => ints[k]).map(k => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: ints[k] })));
  if (intRows.length) left.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Interests' }), h('table', { class: 'ms-interests' }, intRows)));
  const det = [['Status', p.status], ['Here for', p.hereFor], ['Hometown', p.hometown], ['Sign', d.sign ? `${d.sign.glyph} ${d.sign.name}` : '']].filter(r => r[1]);
  if (det.length) left.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Details' }),
    h('table', { class: 'ms-interests' }, det.map(([k, v]) => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: v }))))));

  /* ---- right column ---- */
  const right = h('div', { class: 'ms-right' });
  const bannerText = d.self ? 'this is your page. everyone can see it.'
    : rel && rel.friend === 'friends' ? `${u.name} is your friend.`
    : `${u.name} is in your extended network.`;
  right.append(h('div', { class: 'ms-banner', text: bannerText }));

  // Top Songs, from their own Spotify
  if (d.spotify) {
    right.append(h('div', { class: 'ms-section sp-box' }, h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Top Songs ', h('span', { class: 'ms-boxsub', text: `[on Spotify, ${d.spotify.range}]` })), topSongs(d.spotify)));
  } else if (d.self && S.providers.spotify) {
    right.append(h('div', { class: 'ms-section sp-box' }, h('div', { class: 'ms-boxtitle', text: 'Your Top Songs' }),
      h('div', { class: 'sp-empty' }, h('p', { text: 'connect your Spotify and your top songs show up here, for everyone who visits.' }),
        h('a', { class: 'btn98 go', href: '/api/oauth/spotify/start?mode=spotify', text: '♫ connect Spotify' }))));
  }

  if (d.latestBlog) {
    const b = d.latestBlog;
    right.append(h('div', { class: 'ms-section' },
      h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Latest Blog Entry ', h('span', { class: 'ms-boxsub' }, '[', h('a', { href: userPath(u.name) + '/blog', text: `view all ${d.blogCount}` }), ']')),
      h('div', { class: 'ms-blogentry' }, h('a', { href: userPath(u.name) + '/blog', text: b.title }), h('div', { class: 'ms-blogexcerpt', text: b.body + (b.body.length >= 400 ? '…' : '') }),
        h('div', { class: 'ms-time', text: when(b.created) }))));
  }
  const blurbs = h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Blurbs' }));
  blurbs.append(h('div', { class: 'ms-abouthead', text: 'About me:' }), h('p', { text: p.about || '…' }));
  if (p.meet) blurbs.append(h('div', { class: 'ms-abouthead', text: 'Who I\'d like to meet:' }), h('p', { text: p.meet }));
  right.append(blurbs);
  if ((p.badges || []).length) right.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Buttons' }),
    h('div', { class: 'ms-badgewall' }, p.badges.map(src => h('img', { src, alt: '' })))));

  right.append(h('div', { class: 'ms-section' },
    h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Friend Space' }),
    h('div', { class: 'ms-friendcount' }, h('b', { text: u.name }), ` has ${d.friendCount} friend${d.friendCount === 1 ? '' : 's'}.`),
    d.top8.length ? h('div', { class: 'top8-grid' }, d.top8.map(f => h('div', { class: 'friend' },
      avatar(f, 66), h('a', { class: 'fname', href: userPath(f.name), text: f.name })))) : h('div', { class: 'ms-empty', text: d.self ? 'no friends yet. go Browse and say hi!' : 'no friends yet. be the first!' }),
    d.friendCount > d.top8.length ? h('a', { class: 'ms-viewall', href: userPath(u.name) + '/friends', text: `View all of ${poss(u.name)} friends` }) : null));

  // Friends Comments (the wall)
  const wall = h('div', { class: 'ms-section ms-commentbox' }, h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Friends Comments ',
    h('span', { class: 'ms-boxsub', text: `Displaying ${d.wall.length}` })));
  if (S.me && (d.self || (rel && rel.canComment))) {
    const ta = h('textarea', { id: 'wall-input', maxLength: 500, rows: 2, placeholder: d.self ? 'write on your own wall…' : `leave ${u.name} a comment…`, 'aria-label': 'comment' });
    wall.append(h('form', { class: 'ms-commentform', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      try { await api.post(`/users/${enc(u.name)}/wall`, { body: ta.value }); toast('comment posted!'); route(); } catch (err) { oops(err); }
    } }, ta, h('button', { class: 'btn98', type: 'submit', text: 'Post' })));
  } else if (!S.me) {
    wall.append(h('div', { class: 'ms-empty' }, h('a', { href: '/login?next=' + enc(location.pathname), text: 'log in' }), ' to leave a comment.'));
  } else if (rel && !rel.canComment) {
    wall.append(h('div', { class: 'ms-empty', text: `${u.name} only takes comments from friends.` }));
  }
  if (!d.wall.length) wall.append(h('div', { class: 'ms-empty', text: 'no comments yet.' }));
  d.wall.forEach(c => {
    const item = { ...c, kind: 'wall' };
    const row = h('div', { class: 'ms-comment' },
      h('div', { class: 'ms-comment-who' }, avatar(c.author, 50), h('a', { class: 'ms-name-link', href: userPath(c.author.name), text: c.author.name })),
      h('div', { class: 'ms-comment-col' }, h('span', { class: 'ms-time', text: when(c.created) }), postActions(item, () => row.remove()),
        h('div', { class: 'ms-comment-body', text: c.body })));
    wall.append(row);
  });
  right.append(wall);

  prof.append(left, right);
  root.append(prof);
}

export async function renderFriends(root, name) {
  const d = await api.get(`/users/${enc(name)}/friends`);
  root.append(pageTitle(`${poss(d.user.name)} friends (${d.friends.length})`, h('a', { class: 'btn98', href: userPath(d.user.name), text: '← back to their page' })));
  if (!d.friends.length) root.append(h('div', { class: 'ms-empty', text: 'no friends yet.' }));
  root.append(h('div', { class: 'ms-browsegrid' }, d.friends.map(personCard)));
}

export async function renderUserBlog(root, name) {
  const d = await api.get(`/users/${enc(name)}/blog`);
  const u = d.user;
  const self = S.me && S.me.id === u.id;
  root.append(pageTitle(`${poss(u.name)} Blog`, h('a', { class: 'btn98', href: userPath(u.name), text: '← back to their page' })));
  const page = h('div', { class: 'ms-blogpage' });
  if (self) {
    const title = h('input', { class: 'os-input', maxLength: 80, placeholder: 'title', 'aria-label': 'title' });
    const mood = h('input', { class: 'os-input', maxLength: 40, placeholder: 'current mood (optional)', 'aria-label': 'mood' });
    const body = h('textarea', { class: 'os-input', maxLength: 8000, placeholder: 'dear diary…', 'aria-label': 'entry' });
    page.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: '✏ write a new entry' }),
      h('form', { class: 'os-form', onsubmit: async e => {
        e.preventDefault();
        try { await api.post('/blog', { title: title.value, mood: mood.value, body: body.value }); toast('posted!'); route(); } catch (err) { oops(err); }
      } }, h('div', { class: 'row' }, title, mood), body, h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Post entry' })))));
  }
  if (!d.entries.length) page.append(h('div', { class: 'ms-empty', text: self ? 'no entries yet. the first one is the hardest.' : 'no blog entries yet.' }));
  d.entries.forEach(b => {
    const card = h('div', { class: 'ms-section' },
      h('div', { class: 'ms-blogpost-title', text: b.subject }),
      b.mood ? h('div', { class: 'ms-blogpost-mood', text: 'mood: ' + b.mood }) : null,
      h('div', { class: 'ms-blogpost-body', text: b.body }),
      h('div', { class: 'ms-blogpost-foot' }, h('span', { text: when(b.created) }), postActions(b, () => card.remove())));
    page.append(card);
  });
  root.append(page);
}
