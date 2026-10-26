/* pages/profile.js — someone's page: the card on the left, the boxes on the right, and under them four tabs, each its
   own address: Posts (/u/name: statuses, quotes and reposts), Replies (/u/name/replies), Blog (/u/name/blog) and
   Friends' Comments (/u/name/comments). */

import { h, $, enc, userPath, poss } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago } from '../core/format.js';
import { toast, oops, skin, paged, errorCard } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, route, needLogin } from '../core/router.js';
import { avatar } from '../widgets/people.js';
import { postActions, reportDialog, blockUser } from '../widgets/safety.js';
import { topSongs } from '../widgets/songs.js';
import { followButton } from '../widgets/followbutton.js';
import { privateCard } from '../widgets/privatecard.js';
import { composer } from '../widgets/composer.js';
import { postCard } from '../widgets/postcard.js';
import { blogPath } from '../widgets/postlinks.js';
import { rich } from '../widgets/richtext.js';
import { blogIndex } from '../widgets/blogindex.js';

/* The page's data is kept for 30 seconds so that clicking between the tabs doesn't fetch it again. Only a click on a
   tab asks for that; anything else loads fresh, and anything that changes the page throws the copy away. */
const FRESH_MS = 30000;
let cache = null;                 // { key, at, d }
let reuseNext = false;
const forget = () => { cache = null; };

async function loadProfile(name) {
  const key = (S.me ? S.me.id : 0) + ':' + name.toLowerCase();
  const hit = reuseNext && cache && cache.key === key && Date.now() - cache.at < FRESH_MS;
  reuseNext = false;
  if (hit) return cache.d;
  const d = await api.get('/users/' + enc(name));
  cache = { key, at: Date.now(), d };
  return d;
}

// [key (also the name of its count in the profile's counts), path after /u/name, label]
const TABS = [['statuses', '', 'Posts'], ['replies', '/replies', 'Replies'], ['blog', '/blog', 'Blog'], ['comments', '/comments', 'Friends\' Comments']];

export const renderProfile = (root, name) => drawProfile(root, name, 'statuses');
export const renderProfileReplies = (root, name) => drawProfile(root, name, 'replies');
export const renderProfileBlog = (root, name) => drawProfile(root, name, 'blog');
export const renderProfileComments = (root, name) => drawProfile(root, name, 'comments');

async function drawProfile(root, name, tab) {
  const d = await loadProfile(name);
  const u = d.user, p = d.profile, rel = d.relation;
  const suffix = TABS.find(t => t[0] === tab)[1];
  if (d.self && u.name !== name) history.replaceState(null, '', userPath(u.name) + suffix);
  if (rel && rel.blockedByMe) {
    root.append(h('div', { class: 'ms-blocked-card' }, h('p', null, h('b', { text: `you blocked ${u.name}.` }), ' you won\'t see their posts and they can\'t contact you.'),
      h('button', { class: 'btn98', type: 'button', text: 'unblock', onclick: async () => { try { await api.del('/blocks/' + enc(u.name)); toast('unblocked.'); forget(); route(); } catch (e) { oops(e); } } })));
    return;
  }
  if (u.banned) root.append(h('div', { class: 'ms-error', text: 'this account is suspended. only moderators can see this page.' }));

  const locked = d.private && !d.canSeePosts;               // a private page you haven't been let into
  const changed = () => { forget(); route(); };             // a follow changed: counts, banner and what you may see all move
  const prof = h('div', { class: 'ms-profile' + (d.self ? ' is-me' : '') });
  skin(prof, p);

  /* ---- left column ---- */
  const left = h('div', { class: 'ms-left' });
  const count = (n, label, which) => {
    const inner = [h('b', { text: String(n) }), ' ' + label];
    return locked ? h('span', null, inner) : h('a', { href: userPath(u.name) + '/' + which }, inner);
  };
  const stack = h('div', { class: 'ms-idstack' },
    p.gender ? h('div', { text: p.gender }) : null,
    d.age != null ? h('div', { text: d.age + ' years old' }) : null,
    d.sign ? h('div', null, h('a', { class: 'ms-signlink', href: '/horoscope/' + d.sign.key, text: `${d.sign.glyph} ${d.sign.name}` })) : null,
    p.hometown ? h('div', { text: p.hometown }) : null,
    h('div', { class: 'ms-lastlogin', text: 'Last Login: ' + (u.lastSeen ? ago(u.lastSeen) : 'never') }),
    h('div', { class: 'ms-lastlogin', text: 'Member since: ' + when(u.joined).split(' ').slice(0, 3).join(' ') }));
  const actions = h('div', { class: 'ms-followrow' });
  if (d.self) actions.append(h('a', { class: 'btn98 ms-editbig', href: '/edit', text: '🎨 Edit My Page' }));
  else {
    actions.append(followButton(u, rel, { isPrivate: d.private, onChange: changed }));
    if (S.me && rel.canMessage) actions.append(h('a', { class: 'btn98', href: '/inbox/' + enc(u.name), text: '✉ Message' }));
  }
  left.append(h('div', { class: 'ms-idcard' },
    h('div', { class: 'ms-idhead' }, h('span', { class: 'ms-name', text: u.name }), rel && rel.followsMe ? h('span', { class: 'ms-chip', text: 'Follows you' }) : null),
    h('img', { class: 'ms-bigavatar', src: u.avatar, alt: u.name }),
    h('div', { class: 'ms-counts' }, count(d.counts.followers, 'Followers', 'followers'), ' · ', count(d.counts.following, 'Following', 'following'), ' · ', count(d.counts.friends, 'Friends', 'friends')),
    actions,
    stack,
    u.online ? h('div', { class: 'online-dot on', text: '🟢 ONLINE NOW!' }) : h('div', { class: 'online-dot off', text: '⚪ offline' }),
    p.mood ? h('div', { class: 'ms-moodline', text: 'Mood: ' + p.mood }) : null,
    p.tag ? h('div', { class: 'ms-tagline', text: '"' + p.tag + '"' }) : null,
    d.latestStatus ? h('div', { class: 'ms-latest' }, h('div', { class: 'ms-latest-label', text: 'Latest status' }),
      h('div', { class: 'ms-latest-body', text: d.latestStatus.body || '📷 photo' }), h('div', { class: 'ms-time', text: ago(d.latestStatus.created) })) : null));
  const decor = (p.decor || []).filter(Boolean);
  if (decor.length) left.append(h('div', { class: 'ms-decor ms-about' }, decor.map(src => h('img', { src, alt: '' }))));

  // Contacting box
  const grid = h('div', { class: 'ms-contactgrid' });
  const link = (icon, label, fn, cls = '') => grid.append(h('a', { class: 'ms-clink ' + cls, href: '#', onclick: e => { e.preventDefault(); fn(); } },
    h('span', { class: 'ms-cicon', text: icon }), label));
  const off = (icon, label, why) => grid.append(h('span', { class: 'ms-clink off', title: why }, h('span', { class: 'ms-cicon', text: icon }), label));
  const addComment = () => {
    const focus = () => { const t = $('#wall-input'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } };
    if ($('#wall-input')) focus(); else { go(userPath(u.name) + '/comments'); setTimeout(focus, 400); }
  };
  if (d.self) {
    link('🎨', 'Edit My Page', () => go('/edit'));
    link('✏', 'Update Status', () => go('/'));
    link('📁', 'My Blog', () => go(userPath(u.name) + '/blog'));
    link('🔖', 'My Bookmarks', () => go('/bookmarks'));
    link('⚙', 'Settings', () => go('/settings'));
  } else if (!S.me) {
    [['✉', 'Send Message'], ['💬', 'Add Comment'], ['🚫', 'Block User'], ['⚑', 'Report User']].forEach(([icon, label]) => link(icon, label, needLogin));
  } else {
    if (rel.canMessage) link('✉', 'Send Message', () => go('/inbox/' + enc(u.name)));
    else off('✉', 'Send Message', `${u.name} only takes messages from friends`);
    if (rel.canComment && !locked) link('💬', 'Add Comment', addComment);
    else off('💬', 'Add Comment', `${u.name} only takes comments from friends`);
    link('🚫', 'Block User', async () => { if (await blockUser(u.name)) { forget(); route(); } }, 'warn');
    link('⚑', 'Report User', () => reportDialog({ type: 'user', name: u.name, what: u.name }), 'warn');
  }
  left.append(h('div', { class: 'ms-contactbox ms-about' }, h('div', { class: 'ms-boxtitle', text: 'Contacting ' + u.name }), grid));
  left.append(h('div', { class: 'ms-urlbox ms-about' }, h('div', { class: 'ms-boxtitle', text: 'OurSpace URL:' }), h('div', { class: 'ms-urltext', text: location.origin + userPath(u.name) })));

  const ints = p.interests || {};
  const intRows = Object.keys(ints).filter(k => ints[k]).map(k => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: ints[k] })));
  if (intRows.length) left.append(h('div', { class: 'ms-section ms-about' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Interests' }), h('table', { class: 'ms-interests' }, intRows)));
  const det = [['Status', p.status], ['Here for', p.hereFor], ['Hometown', p.hometown], ['Sign', d.sign ? `${d.sign.glyph} ${d.sign.name}` : '']].filter(r => r[1]);
  if (det.length) left.append(h('div', { class: 'ms-section ms-about' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Details' }),
    h('table', { class: 'ms-interests' }, det.map(([k, v]) => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: v }))))));

  /* ---- right column ---- */
  const right = h('div', { class: 'ms-right' });
  const st = rel ? (rel.friends ? 'friends' : rel.following) : 'none';
  const bannerText = d.self ? (d.private ? 'this is your page. your posts are only for your followers.' : 'this is your page. everyone can see it.')
    : st === 'friends' ? `${u.name} is your friend.`
    : st === 'accepted' ? `you follow ${u.name}.`
    : st === 'pending' ? `you asked to follow ${u.name}.`
    : rel && rel.followsMe ? `${u.name} follows you.`
    : `${u.name} is in your extended network.`;
  right.append(h('div', { class: 'ms-banner', text: bannerText }));

  // Top Songs, from their own Spotify
  if (d.spotify) {
    right.append(h('div', { class: 'ms-section sp-box ms-about' }, h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Top Songs ', h('span', { class: 'ms-boxsub', text: `[on Spotify, ${d.spotify.range}]` })), topSongs(d.spotify)));
  } else if (d.self && S.providers.spotify) {
    right.append(h('div', { class: 'ms-section sp-box ms-about' }, h('div', { class: 'ms-boxtitle', text: 'Your Top Songs' }),
      h('div', { class: 'sp-empty' }, h('p', { text: 'connect your Spotify and your top songs show up here, for everyone who visits.' }),
        h('a', { class: 'btn98 go', href: '/api/oauth/spotify/start?mode=spotify', text: '♫ connect Spotify' }))));
  }

  if (d.blog.length && tab !== 'blog') {
    right.append(h('div', { class: 'ms-section ms-about' },
      h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Latest Blog Posts ', h('span', { class: 'ms-boxsub' }, '[', h('a', { href: userPath(u.name) + '/blog', text: 'view all' }), ']')),
      d.blog.map(b => h('div', { class: 'ms-blogentry' },
        h('a', { href: blogPath(u.name, b.id), text: b.title }),
        b.subtitle ? h('div', { class: 'ms-blogexcerpt', text: b.subtitle }) : null,
        h('div', { class: 'ms-time', text: when(b.created) })))));
  }
  const blurbs = h('div', { class: 'ms-section ms-about' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Blurbs' }));
  blurbs.append(h('div', { class: 'ms-abouthead', text: 'About me:' }), h('p', { text: p.about || '…' }));
  if (p.meet) blurbs.append(h('div', { class: 'ms-abouthead', text: 'Who I\'d like to meet:' }), h('p', { text: p.meet }));
  right.append(blurbs);
  if ((p.badges || []).length) right.append(h('div', { class: 'ms-section ms-about' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Buttons' }),
    h('div', { class: 'ms-badgewall' }, p.badges.map(src => h('img', { src, alt: '' })))));

  const nFriends = d.counts.friends;
  right.append(h('div', { class: 'ms-section ms-about' },
    h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Friend Space' }),
    h('div', { class: 'ms-friendcount' }, h('b', { text: u.name }), ` has ${nFriends} friend${nFriends === 1 ? '' : 's'}.`),
    d.top8.length ? h('div', { class: 'top8-grid' }, d.top8.map(f => h('div', { class: 'friend' },
      avatar(f, 66), h('a', { class: 'fname', href: userPath(f.name), text: f.name })))) : h('div', { class: 'ms-empty', text: d.self ? 'no friends yet. follow people, and when they follow you back they\'re friends.' : 'no friends yet.' }),
    nFriends > d.top8.length && !locked ? h('a', { class: 'ms-viewall', href: userPath(u.name) + '/friends', text: `View all of ${poss(u.name)} friends` }) : null));

  // the tabs: Statuses | Blog | Friends' Comments
  const stream = h('div', { class: 'ms-stream' });
  if (locked) stream.append(privateCard(u, rel, { onChange: changed }));
  else {
    // each label carries its total; posting or deleting on this page moves it without asking for the counts again
    const text = i => `${TABS[i][2]} (${d.counts[TABS[i][0]]})`;
    const links = TABS.map(([key, path], i) =>
      h('a', { class: key === tab ? 'on' : '', href: userPath(u.name) + path, 'aria-current': key === tab ? 'page' : null, onclick: e => { if (e.button === 0 && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) reuseNext = true; } }, text(i)));
    const recount = (key, n) => { d.counts[key] = n; const i = TABS.findIndex(t => t[0] === key); links[i].textContent = text(i); };
    const deleted = key => () => { forget(); recount(key, d.counts[key] - 1); };
    stream.append(h('nav', { class: 'os-tabs2 ms-ptabs', 'aria-label': 'sections of this page' }, links));
    const body = h('div', { class: 'ms-streambody' });
    stream.append(body);
    if (tab === 'statuses') await postsTab(body, d, deleted('statuses'));
    else if (tab === 'replies') await repliesTab(body, d, deleted('replies'));
    else if (tab === 'blog') await blogIndex(body, u, { self: d.self, onPosted: id => { forget(); go(blogPath(u.name, id)); }, onDeleted: deleted('blog') });
    else await commentsTab(body, d, changed, n => recount('comments', n));
  }
  right.append(stream);
  right.append(h('button', { class: 'ms-aboutbar', type: 'button', 'aria-expanded': 'true', text: `▾ About ${u.name}`, onclick: e => {
    const closed = prof.classList.toggle('about-closed');
    e.currentTarget.textContent = `${closed ? '▸' : '▾'} About ${u.name}`;
    e.currentTarget.setAttribute('aria-expanded', String(!closed));
  } }));

  prof.append(left, right);
  root.append(prof);
}

/* ---- Posts: statuses, quotes and reposts ---- */
async function postsTab(body, d, onDeleted) {
  const u = d.user;
  if (d.self) body.append(composer({ onPosted: () => { forget(); route(); } }));
  const list = h('div');
  body.append(list);
  await paged(list, cur => api.get(`/users/${enc(u.name)}/statuses${cur ? '?before=' + enc(cur) : ''}`),
    item => postCard(item, { onDeleted }), d.self ? 'nothing here yet. what\'s on your mind?' : `${u.name} hasn't posted yet.`);
}

/* ---- Replies ---- */
async function repliesTab(body, d, onDeleted) {
  const u = d.user;
  const list = h('div');
  body.append(list);
  await paged(list, cur => api.get(`/users/${enc(u.name)}/replies${cur ? '?before=' + enc(cur) : ''}`),
    item => postCard(item, { onDeleted }), d.self ? 'no replies yet. answer someone from their post.' : `${u.name} hasn't replied to anyone yet.`);
}

/* ---- Friends' Comments ---- */
const COMMENTS_PER_PAGE = 10;

// One numbered page at a time from GET /users/:name/comments?page=N. recount(total) moves the tab's label.
async function commentsTab(body, d, changed, recount) {
  const u = d.user, rel = d.relation;
  const head = h('div', { class: 'ms-subhead' });
  const list = h('div');
  const pager = h('div', { class: 'ms-pager' });
  let page = 1, latest = 0;

  // who may write: the owner and friends (people who follow each other)
  if (d.self || (rel && rel.canComment)) {
    const ta = h('textarea', { id: 'wall-input', maxLength: 500, rows: 2, placeholder: d.self ? 'reply on your own page…' : `leave ${u.name} a comment…`, 'aria-label': 'comment' });
    const count = h('span', { class: 'ms-compose-count', text: '0/500' });
    ta.addEventListener('input', () => { count.textContent = `${ta.value.length}/500`; });
    body.append(h('form', { class: 'ms-commentform ms-commentcompose', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      try {
        await api.post(`/users/${enc(u.name)}/comments`, { body: ta.value.trim() });
        toast('comment posted!');
        ta.value = '';
        count.textContent = '0/500';
        forget();
        load(1);                                      // the newest comment is on the first page
      } catch (err) { oops(err); }
    } }, ta, h('div', { class: 'ms-commentbtns' }, h('button', { class: 'btn98', type: 'submit', text: 'Post' }), count)));
  } else if (!S.me) {
    body.append(h('div', { class: 'ms-note' }, h('a', { href: '/login?next=' + enc(location.pathname), text: 'log in' }), ` to follow ${u.name}. only their friends can write here.`));
  } else {
    const how = rel.following === 'accepted' ? `you follow ${u.name}; you'll be friends when they follow you back.`
      : rel.following === 'pending' ? `you've asked to follow ${u.name}.`
      : rel.followsMe ? `${u.name} follows you: follow back and you're friends.`
      : `friends are people who follow each other. follow ${u.name} to start.`;
    body.append(h('div', { class: 'ms-note ms-commentnote' }, h('span', { text: `Only ${poss(u.name)} friends can write here. ${how}` }),
      rel.following === 'accepted' ? null : followButton(u, rel, { isPrivate: d.private, onChange: changed })));
  }
  body.append(head, list, pager);

  const draw = r => {
    const from = (r.page - 1) * COMMENTS_PER_PAGE + 1, to = from + r.comments.length - 1;
    head.textContent = r.total ? `Displaying ${from === to ? from : `${from}–${to}`} of ${r.total} comment${r.total === 1 ? '' : 's'}` : 'Friends\' Comments';
    list.replaceChildren();
    if (!r.total) list.append(h('div', { class: 'ms-empty', text: 'no comments yet.' }));
    r.comments.forEach(c => {
      const item = { ...c, kind: 'wall' };
      list.append(h('div', { class: 'ms-comment' },
        h('div', { class: 'ms-comment-who' }, avatar(c.author, 50), h('a', { class: 'ms-name-link', href: userPath(c.author.name), text: c.author.name })),
        h('div', { class: 'ms-comment-col' }, h('span', { class: 'ms-time', text: when(c.created) }), postActions(item, () => { forget(); load(page); }),
          h('div', { class: 'ms-comment-body' }, rich(c.body, c.mentions, { tags: false })))));   // (comments' #tags aren't kept, so they don't link)
    });
    // « 1 2 3 »; a long run keeps the first, the last and two either side of this page
    pager.replaceChildren();
    if (r.pages > 1) {
      const btn = (label, n, on = false, off = false) => h('button', { class: 'btn98' + (on ? ' pressed' : ''), type: 'button', text: label, disabled: off, 'aria-current': on ? 'page' : null, onclick: () => { load(n); head.scrollIntoView({ block: 'nearest' }); } });
      const near = i => i === 1 || i === r.pages || Math.abs(i - r.page) <= 2;
      pager.append(btn('«', r.page - 1, false, r.page === 1));
      for (let i = 1; i <= r.pages; i++) {
        if (near(i)) pager.append(btn(String(i), i, i === r.page));
        else if (near(i - 1)) pager.append(h('span', { text: '…' }));
      }
      pager.append(btn('»', r.page + 1, false, r.page === r.pages));
    }
  };

  // (a slow answer must not paint over a newer one; a page past the end comes back as the last page)
  const load = async n => {
    const mine = ++latest;
    try {
      const r = await api.get(`/users/${enc(u.name)}/comments?page=${n}`);
      if (mine !== latest) return;
      page = r.page;
      recount(r.total);
      draw(r);
    } catch (e) { if (mine === latest) list.replaceChildren(errorCard(e)); }
  };
  await load(1);
}
