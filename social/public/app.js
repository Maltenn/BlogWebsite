/* ============================================================
   app.js — OurSpace, the social network: the whole page.
   Talks to the API (/api/*, the Worker in src/). No desktop, no
   windows: just OurSpace and the blog. Everything people wrote is
   put on the page with textContent (never innerHTML), and every
   name or picture that belongs to a bot carries a BOT tag.
   ============================================================ */
'use strict';

/* ------------------------------------------------------------ helpers */

// h('div', { class: 'x', text: 'hi', onclick: fn }, child, 'text', [more]) → element
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (['value', 'checked', 'disabled', 'selected', 'maxLength', 'rows', 'loading'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (sel, root = document) => root.querySelector(sel);
const content = () => $('#ms-content');
const enc = encodeURIComponent;
const userPath = name => '/u/' + enc(name);
const poss = name => name + (/s$/i.test(name) ? "'" : "'s");

const api = {
  async call(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || `something went wrong (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  },
  get: p => api.call('GET', p),
  post: (p, b = {}) => api.call('POST', p, b),
  put: (p, b) => api.call('PUT', p, b),
  del: (p, b) => api.call('DELETE', p, b),
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Oct 23 2026 7:14 PM" — the way the real thing printed it
function when(ms) {
  const d = new Date(ms);
  let hr = d.getHours();
  const ap = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} ${hr}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
  return when(ms);
}

function toast(text, bad = false, onclick = null) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status', text });
  if (onclick) { t.style.cursor = 'pointer'; t.addEventListener('click', () => { onclick(); t.remove(); }); }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 5000);
}
const oops = e => toast(e && e.message ? e.message : String(e), true);

// a Win98 message box. Resolves true (OK) / false (Cancel). opts.body = extra element(s) inside.
function dialog({ title, text, icon = '❔', ok = 'OK', cancel = 'Cancel', danger = false, body = null }) {
  return new Promise(resolve => {
    const okBtn = h('button', { class: 'btn98' + (danger ? ' danger' : ''), type: 'button', text: ok });
    const cancelBtn = cancel ? h('button', { class: 'btn98', type: 'button', text: cancel }) : null;
    const modal = h('div', { class: 'ms-modal' },
      h('div', { class: 'ms-dialog win98', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'title-bar' }, h('span', { text: title }), h('button', { class: 'btn98', type: 'button', 'aria-label': 'close', text: '✕', onclick: () => done(false) })),
        h('div', { class: 'ms-dialog-body' }, h('div', { class: 'ms-dialog-icon', text: icon }), h('div', null, text ? h('p', { text }) : null, body)),
        h('div', { class: 'ms-dialog-btns' }, okBtn, cancelBtn)));
    const done = v => { modal.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape') done(false); };
    okBtn.addEventListener('click', () => done(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => done(false));
    modal.addEventListener('click', e => { if (e.target === modal) done(false); });
    document.addEventListener('keydown', key);
    document.body.append(modal);
    okBtn.focus();
  });
}

/* ------------------------------------------------------------ state */

const S = {
  me: null,                       // { id, name, avatar, isAdmin } or null
  counts: { requests: 0, unread: 0, reports: 0 },
  settings: null,
  minAge: 13,
  options: null,                  // GET /api/options (lazy)
  timers: [],                     // cleared on every page change
  audio: null,                    // a bot's profile song, if playing
};

async function loadMe() {
  const r = await api.get('/me');
  const before = S.counts.unread;
  S.me = r.user;
  S.minAge = r.minAge || 13;
  S.counts = r.counts || { requests: 0, unread: 0, reports: 0 };
  S.settings = r.settings || null;
  paintChrome();
  return before;
}
async function options() {
  if (!S.options) S.options = await api.get('/options');
  return S.options;
}

/* ------------------------------------------------------- bits of UI */

const BOT_TITLE = 'this account is a bot: a fictional character run by OurSpace, not a real person';
const botTag = () => h('span', { class: 'bot-tag', title: BOT_TITLE, text: 'BOT' });

function avatar(u, size = 44) {
  const img = h('img', { class: 'ms-avatar', src: u.avatar, alt: u.name + (u.isBot ? ' (bot)' : ''), loading: 'lazy', width: size, height: size });
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  img.addEventListener('click', e => { e.stopPropagation(); go(userPath(u.name)); });
  return h('span', { class: 'av-wrap' + (u.isBot ? ' is-bot' : ''), title: u.isBot ? BOT_TITLE : null }, img);
}
function nameLink(u, cls = 'ms-name-link') {
  return h('span', null, h('a', { class: cls, href: userPath(u.name), text: u.name }), u.isBot ? botTag() : null);
}

// "⚑ report" (and "delete" when it's yours) under a post
function postActions(item, onDeleted) {
  const box = h('span', { class: 'ms-actions' });
  if (item.canDelete) {
    box.append(h('a', { href: '#', text: 'delete', onclick: async e => {
      e.preventDefault();
      if (!await dialog({ title: 'Delete', text: 'Delete this for good?', icon: '🗑', ok: 'Delete', danger: true })) return;
      try { await api.del('/posts/' + item.id); toast('deleted.'); onDeleted && onDeleted(); } catch (err) { oops(err); }
    } }));
  }
  if (S.me && item.author && item.author.id !== S.me.id && ['status', 'wall', 'bulletin', 'blog'].includes(item.kind)) {
    box.append(h('a', { href: '#', text: '⚑ report', title: 'report this to the moderators', onclick: e => { e.preventDefault(); reportDialog({ type: 'post', id: item.id, what: 'this post' }); } }));
  }
  return box;
}

// the report form: reason + details → POST /api/reports
async function reportDialog({ type, id, name, what }) {
  if (!S.me) { needLogin(); return; }
  const opts = await options();
  const select = h('select', { 'aria-label': 'reason' }, h('option', { value: '', text: '— pick a reason —' }),
    opts.reportReasons.map(r => h('option', { value: r.v, text: r.label })));
  const details = h('textarea', { maxLength: 1000, placeholder: 'anything the moderators should know (optional)' });
  const body = h('div', null,
    h('label', null, 'Why are you reporting ' + what + '?', select),
    h('label', null, 'Details', details),
    h('p', { class: 'os-hint', text: 'reports are private. the person you report isn\'t told who sent it. if you just don\'t want to see someone, Block them too.' }));
  while (true) {
    if (!await dialog({ title: 'Report', icon: '⚑', ok: 'Send report', body })) return;
    if (!select.value) { toast('pick a reason first.', true); continue; }
    try {
      await api.post('/reports', { type, id, name, reason: select.value, details: details.value });
      toast('thanks. a moderator will take a look.');
    } catch (e) { oops(e); }
    return;
  }
}

async function blockUser(name, isBot) {
  const ok = await dialog({
    title: 'Block ' + name, icon: '🚫', ok: 'Block', danger: true,
    text: `${name} won't be able to message you, comment on your wall, friend you or see your page, and you'll stop seeing each other's posts. ${isBot ? 'The bot will stop talking to you.' : 'They won\'t be told.'} You can unblock them later in Settings.`,
  });
  if (!ok) return false;
  try { await api.post('/blocks/' + enc(name)); toast(name + ' is blocked.'); return true; } catch (e) { oops(e); return false; }
}

function needLogin() {
  toast('log in (or join) first!');
  go('/login?next=' + enc(location.pathname));
}

// a profile's colors / background tile / font, with a translucent plate under the boxes so tiles stay readable
function skin(el, p) {
  const th = p.theme || { bg: '#ffffff', fg: '#000000', accent: '#6699cc' };
  el.style.backgroundColor = th.bg;
  if (p.bgTile) { el.style.backgroundImage = `url("${p.bgTile}")`; el.style.backgroundRepeat = 'repeat'; }
  el.style.color = th.fg;
  el.style.setProperty('--ms-accent', th.accent);
  const hex = String(th.bg || '#000').replace('#', '');
  const lum = hex.length >= 6 ? parseInt(hex.slice(0, 2), 16) * 0.299 + parseInt(hex.slice(2, 4), 16) * 0.587 + parseInt(hex.slice(4, 6), 16) * 0.114 : 0;
  el.style.setProperty('--ms-panel', lum < 128 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.88)');
  if (p.font) el.style.fontFamily = p.font;
}

function pageTitle(text, ...tools) {
  return h('div', { class: 'ms-pagetitle' }, h('span', { text }), tools.length ? h('span', { class: 'ms-right-tools' }, tools) : null);
}
function errorCard(e) {
  return h('div', { class: 'ms-error', text: e.status === 404 ? 'nobody by that name lives here (or they\'ve moved away).' : e.message });
}
// "show more" paging: load(cursor) → { items, next }; draw(item) → element
async function paged(root, load, draw, empty) {
  const list = h('div');
  root.append(list);
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more ▾' });
  let cursor = null;
  const step = async () => {
    more.disabled = true;
    try {
      const r = await load(cursor);
      r.items.forEach(i => list.append(draw(i)));
      cursor = r.next;
      if (!list.children.length) list.append(h('div', { class: 'ms-empty', text: empty }));
      more.hidden = !cursor;
    } catch (e) { list.append(errorCard(e)); more.hidden = true; }
    more.disabled = false;
  };
  more.addEventListener('click', step);
  root.append(more);
  await step();
}

/* ---------------------------------------------------- header + tabs */

function paintChrome() {
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
    label, badge ? h('span', { class: 'ms-badge', text: String(badge) }) : null);
  const mine = S.me && (path === userPath(S.me.name) || path.toLowerCase().startsWith(userPath(S.me.name).toLowerCase() + '/'));
  const tabs = [
    tab('Home', '/', 0, path === '/'),
    S.me ? tab('My Page', userPath(S.me.name), 0, mine) : null,
    tab('Browse', '/browse', 0, path === '/browse'),
    S.me ? tab('Requests', '/requests', S.counts.requests, path === '/requests') : null,
    S.me ? tab('Inbox', '/inbox', S.counts.unread, path.startsWith('/inbox')) : null,
    tab('Bulletins', '/bulletins', 0, path === '/bulletins'),
    h('a', { class: 'ms-tab', href: '/blog/', text: 'Blog' }),
    S.me && S.me.isAdmin ? tab('Moderation', '/admin', S.counts.reports, path === '/admin') : null,
    !S.me ? tab('Join', '/join', 0, path === '/join') : null,
  ];
  $('#tabs').replaceChildren(...tabs.filter(Boolean));
}

async function logout() {
  try { await api.post('/logout'); } catch { /* logged out either way */ }
  S.me = null;
  S.counts = { requests: 0, unread: 0, reports: 0 };
  toast('logged out. come back soon!');
  go('/');
}

/* ------------------------------------------------------------ router */

const ROUTES = [
  [/^\/$/, renderHome],
  [/^\/join$/, renderJoin],
  [/^\/login$/, renderLogin],
  [/^\/u\/([^/]+)$/, renderProfile],
  [/^\/u\/([^/]+)\/friends$/, renderFriends],
  [/^\/u\/([^/]+)\/blog$/, renderUserBlog],
  [/^\/browse$/, renderBrowse],
  [/^\/requests$/, renderRequests, true],
  [/^\/inbox$/, renderInbox, true],
  [/^\/inbox\/([^/]+)$/, renderThread, true],
  [/^\/bulletins$/, renderBulletins],
  [/^\/edit$/, renderEdit, true],
  [/^\/settings$/, renderSettings, true],
  [/^\/admin$/, renderAdmin, true],
  [/^\/rules$/, renderRules],
];

function go(path, replace = false) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  S.timers.forEach(t => clearInterval(t));
  S.timers = [];
  stopSong();
  paintChrome();
  const root = content();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const found = ROUTES.map(([re, fn, auth]) => ({ m: re.exec(path), fn, auth })).find(r => r.m);
  root.replaceChildren(h('div', { class: 'os-loading', text: 'loading…' }));
  window.scrollTo(0, 0);
  if (!found) { root.replaceChildren(pageTitle('404'), h('div', { class: 'ms-empty', text: 'this page wandered off. try the tabs up top.' })); return; }
  if (found.auth && !S.me) { needLogin(); return; }
  const page = h('div');
  try {
    let arg = found.m[1];
    if (arg) { try { arg = decodeURIComponent(arg); } catch { /* use as is */ } }
    await found.fn(page, arg);
  } catch (e) {
    if (e.status === 401) { S.me = null; needLogin(); return; }
    page.append(errorCard(e));
  }
  if (seq === routeSeq) root.replaceChildren(page);   // a newer navigation wins
}

// in-app links: every same-origin <a href="/…"> except the static blog pages and files
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/blog/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/api/')) return;
  e.preventDefault();
  go(url.pathname + url.search);
});
window.addEventListener('popstate', route);

/* =============================================================== pages */

/* -------------------------------------------------------- home / feed */

function feedLine(item) {
  const a = item.author, t = item.target;
  const head = h('div', null, nameLink(a));
  let text = null;
  if (item.kind === 'status') { head.append(' updated their status'); text = item.body; }
  else if (item.kind === 'wall') { head.append(' ➜ ', t ? h('a', { class: 'ms-name-link', href: userPath(t.name), text: poss(t.name) + ' wall' }) : 'a wall', t && t.isBot ? botTag() : null); text = item.body; }
  else if (item.kind === 'bulletin') { head.append(' posted a bulletin'); text = h('span', null, h('a', { class: 'ms-feedsubject', href: '/bulletins', text: item.subject }), ' — ', item.body); }
  else if (item.kind === 'blog') { head.append(' wrote a blog entry'); text = h('span', null, h('a', { class: 'ms-feedsubject', href: userPath(a.name) + '/blog', text: item.subject }), ' — ', item.body); }
  else if (item.kind === 'friends') { head.append(' and ', t ? nameLink(t) : 'someone', ' are now friends!'); }
  else if (item.kind === 'joined') { head.append(' joined OurSpace! go say hi ★'); }
  const row = h('div', { class: 'ms-feeditem' + (a.isBot ? ' by-bot' : '') },
    avatar(a, 40),
    h('div', { class: 'ms-feedmid' }, head, text != null ? h('div', { class: 'ms-feedtext' }, text) : null,
      h('div', null, h('span', { class: 'ms-time', text: when(item.created) }), postActions(item, () => row.remove()))));
  return row;
}

let feedScope = 'all';
async function renderHome(root) {
  if (!S.me) {
    root.append(h('div', { class: 'ms-welcome' },
      h('img', { src: '/assets/deco_welcome_banner.gif', alt: 'welcome', height: 70 }),
      h('div', null,
        h('h1', { text: 'welcome to ourspace.' }),
        h('p', { text: 'a place for friends. make a page, decorate it like it\'s 2006 (glitter is encouraged), write on walls, post bulletins, and actually talk to people. a handful of the residents are bots from the old site — they always wear a BOT tag. everyone else is a real person.' }),
        h('a', { class: 'btn98 go', href: '/join', text: '★ make your page' }), h('a', { class: 'btn98', href: '/login', text: 'log in' }), h('a', { class: 'btn98', href: '/browse', text: 'look around first' }))));
  }
  root.append(pageTitle('The Feed — what everyone is up to', h('button', { class: 'btn98', type: 'button', text: '↻ refresh', onclick: () => route() })));
  if (S.me) {
    const inp = h('input', { maxLength: 200, placeholder: 'update your status… what\'s on your mind?', 'aria-label': 'status' });
    const share = async () => {
      if (!inp.value.trim()) return;
      try { await api.post('/status', { body: inp.value }); inp.value = ''; route(); } catch (e) { oops(e); }
    };
    root.append(h('form', { class: 'ms-commentform', onsubmit: e => { e.preventDefault(); share(); } }, inp, h('button', { class: 'btn98', type: 'submit', text: 'Share' })));
  }
  const chips = [['all', 'everything'], ['people', '👤 people only'], S.me ? ['friends', '💛 my friends'] : null].filter(Boolean);
  if (!chips.some(c => c[0] === feedScope)) feedScope = 'all';
  root.append(h('div', { class: 'ms-feedbar' }, chips.map(([k, label]) =>
    h('button', { class: 'btn98' + (feedScope === k ? ' on' : ''), type: 'button', text: label, onclick: () => { feedScope = k; route(); } }))));
  await paged(root, cur => api.get(`/feed?scope=${feedScope}${cur ? '&before=' + enc(cur) : ''}`), feedLine,
    feedScope === 'friends' ? 'nothing from your friends yet. go add some people!' : 'it\'s quiet in here. say something!');
}

/* ----------------------------------------------------------- profile */

async function renderProfile(root, name) {
  const d = await api.get('/users/' + enc(name));
  const u = d.user, p = d.profile, rel = d.relation;
  if (d.self && u.name !== name) history.replaceState(null, '', userPath(u.name));
  if (u.isBot) {
    root.append(h('div', { class: 'bot-banner' }, botTag(),
      h('span', null, h('b', { text: u.name }), ' is a bot — a fictional character from the old OurSpace, run by the site. not a real person. its replies were written ahead of time.')));
  }
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
    p.age ? h('div', { text: /^\d+$/.test(p.age) ? p.age + ' years old' : p.age }) : null,
    p.hometown ? h('div', { text: p.hometown }) : null,
    u.isBot ? null : h('div', { class: 'ms-lastlogin', text: 'Last Login: ' + (u.lastSeen ? ago(u.lastSeen) : 'never') }),
    h('div', { class: 'ms-lastlogin', text: 'Member since: ' + when(u.joined).split(' ').slice(0, 3).join(' ') }));
  const big = h('img', { class: 'ms-bigavatar', src: u.avatar, alt: u.name });
  left.append(h('div', { class: 'ms-idcard' },
    h('div', { class: 'ms-name' }, u.name, u.isBot ? botTag() : null),
    h('span', { class: 'av-wrap' + (u.isBot ? ' is-bot' : ''), title: u.isBot ? BOT_TITLE : null }, big),
    d.self ? h('a', { class: 'btn98 ms-editbig', href: '/edit', text: '🎨 Edit My Page' }) : null,
    stack,
    u.isBot ? h('div', { class: 'online-dot off', text: '🤖 bot (always here, never really online)' })
      : u.online ? h('div', { class: 'online-dot on', text: '🟢 ONLINE NOW!' }) : h('div', { class: 'online-dot off', text: '⚪ offline' }),
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
    else if (f === 'incoming') link('👤', 'Accept Friend Request', async () => { try { await api.post('/friends/' + enc(u.name)); toast(`you and ${u.name} are friends!`); route(); } catch (e) { oops(e); } });
    else link('👤', 'Add to Friends', async () => {
      try {
        const r = await api.post('/friends/' + enc(u.name));
        toast(r.status === 'friends' ? `you and ${u.name} are friends!` : `friend request sent to ${u.name}.`);
        route();
      } catch (e) { oops(e); }
    });
    if (rel.canComment) link('💬', 'Add Comment', () => { const t = $('#wall-input'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } });
    else off('💬', 'Add Comment', `${u.name} only takes comments from friends`);
    link('🚫', 'Block User', async () => { if (await blockUser(u.name, u.isBot)) route(); }, 'warn');
    link('⚑', 'Report User', () => reportDialog({ type: 'user', name: u.name, what: u.name }), 'warn');
  }
  left.append(h('div', { class: 'ms-contactbox' }, h('div', { class: 'ms-boxtitle', text: 'Contacting ' + u.name }), grid));
  left.append(h('div', { class: 'ms-urlbox' }, h('div', { class: 'ms-boxtitle', text: 'OurSpace URL:' }), h('div', { class: 'ms-urltext', text: location.origin + userPath(u.name) })));

  if (p.song && p.song.name) {
    const label = p.song.artist ? `${p.song.name} — ${p.song.artist}` : p.song.name;
    const btn = h('button', { class: 'btn98 ms-songbtn', type: 'button', text: '▶ ' + label });
    btn.addEventListener('click', () => {
      if (S.audio) { stopSong(); btn.textContent = '▶ ' + label; return; }
      if (!p.song.url) { toast('this song has no preview. imagine it.'); return; }
      S.audio = new Audio(p.song.url);
      S.audio.volume = 0.25;
      S.audio.loop = true;
      S.audio.play().catch(() => { toast('the song won\'t play right now.', true); stopSong(); btn.textContent = '▶ ' + label; });
      btn.textContent = '⏹ ' + label;
    });
    left.append(h('div', { class: 'ms-section ms-musicbox' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Music Player' }), btn,
      h('div', { class: 'ms-songnote', text: '30-second preview from iTunes. doesn\'t autoplay (we have manners).' })));
  }

  const ints = p.interests || {};
  const intRows = Object.keys(ints).filter(k => ints[k]).map(k => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: ints[k] })));
  if (intRows.length) left.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Interests' }), h('table', { class: 'ms-interests' }, intRows)));
  const det = [['Status', p.status], ['Here for', p.hereFor], ['Hometown', p.hometown], ['Zodiac', p.zodiac]].filter(r => r[1]);
  if (det.length) left.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Details' }),
    h('table', { class: 'ms-interests' }, det.map(([k, v]) => h('tr', null, h('td', { class: 'ms-int-k', text: k }), h('td', { text: v }))))));

  /* ---- right column ---- */
  const right = h('div', { class: 'ms-right' });
  const bannerText = d.self ? 'this is your page. everyone can see it.'
    : u.isBot ? `${u.name} is a bot. friendly, fictional, and labeled.`
    : rel && rel.friend === 'friends' ? `${u.name} is your friend.`
    : `${u.name} is in your extended network.`;
  right.append(h('div', { class: 'ms-banner', text: bannerText }));

  if (d.latestBlog) {
    const b = d.latestBlog;
    right.append(h('div', { class: 'ms-section' },
      h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Latest Blog Entry ', h('span', { class: 'ms-boxsub' }, '[', h('a', { href: userPath(u.name) + '/blog', text: `view all ${d.blogCount}` }), ']')),
      h('div', { class: 'ms-blogentry' }, h('a', { href: userPath(u.name) + '/blog', text: b.title }), h('div', { class: 'ms-blogexcerpt', text: b.body + (b.body.length >= 400 ? '…' : '') }),
        h('div', { class: 'ms-time', text: when(b.created) }))));
  }
  const blurbs = h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Blurbs' }));
  blurbs.append(h('div', { class: 'ms-abouthead', text: 'About me:' }), h('p', { text: p.about || '…' }));
  if (p.aboutMore) blurbs.append(h('p', { text: p.aboutMore }));
  if (p.meet) blurbs.append(h('div', { class: 'ms-abouthead', text: 'Who I\'d like to meet:' }), h('p', { text: p.meet }));
  right.append(blurbs);
  if (p.survey && Array.isArray(p.survey.qa)) {
    right.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: p.survey.title || 'survey' }),
      h('table', { class: 'ms-interests' }, p.survey.qa.map(([q, a]) => h('tr', null, h('td', { class: 'ms-survey-q', text: q }), h('td', { text: a }))))));
  }
  if ((p.badges || []).length) right.append(h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Buttons' }),
    h('div', { class: 'ms-badgewall' }, p.badges.map(src => h('img', { src, alt: '' })))));

  right.append(h('div', { class: 'ms-section' },
    h('div', { class: 'ms-boxtitle', text: poss(u.name) + ' Friend Space' }),
    h('div', { class: 'ms-friendcount' }, h('b', { text: u.name }), ` has ${d.friendCount} friend${d.friendCount === 1 ? '' : 's'}.`),
    d.top8.length ? h('div', { class: 'top8-grid' }, d.top8.map(f => h('div', { class: 'friend' },
      avatar(f, 66), h('a', { class: 'fname', href: userPath(f.name), text: f.name }), f.isBot ? botTag() : null))) : h('div', { class: 'ms-empty', text: 'no friends yet. be the first!' }),
    d.friendCount > d.top8.length ? h('a', { class: 'ms-viewall', href: userPath(u.name) + '/friends', text: `View all of ${poss(u.name)} friends` }) : null));

  // Friends Comments (the wall)
  const wall = h('div', { class: 'ms-section ms-commentbox' }, h('div', { class: 'ms-boxtitle' }, poss(u.name) + ' Friends Comments ',
    h('span', { class: 'ms-boxsub', text: `Displaying ${d.wall.length}` })));
  if (S.me && (d.self || (rel && rel.canComment))) {
    const ta = h('textarea', { id: 'wall-input', maxLength: 500, rows: 2, placeholder: d.self ? 'write on your own wall…' : `leave ${u.name} a comment…`, 'aria-label': 'comment' });
    wall.append(h('form', { class: 'ms-commentform', onsubmit: async e => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      try {
        await api.post(`/users/${enc(u.name)}/wall`, { body: ta.value });
        toast(u.isBot ? `comment posted! ${u.name} might answer on your wall.` : 'comment posted!');
        route();
      } catch (err) { oops(err); }
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
      h('div', { class: 'ms-comment-who' }, avatar(c.author, 50), h('a', { class: 'ms-name-link', href: userPath(c.author.name), text: c.author.name }), c.author.isBot ? botTag() : null),
      h('div', { class: 'ms-comment-col' }, h('span', { class: 'ms-time', text: when(c.created) }), postActions(item, () => row.remove()),
        h('div', { class: 'ms-comment-body', text: c.body })));
    wall.append(row);
  });
  right.append(wall);

  prof.append(left, right);
  root.append(prof);
}

function stopSong() {
  if (S.audio) { S.audio.pause(); S.audio = null; }
}

async function renderFriends(root, name) {
  const d = await api.get(`/users/${enc(name)}/friends`);
  root.append(pageTitle(`${poss(d.user.name)} friends (${d.friends.length})`, h('a', { class: 'btn98', href: userPath(d.user.name), text: '← back to their page' })));
  if (!d.friends.length) root.append(h('div', { class: 'ms-empty', text: 'no friends yet.' }));
  root.append(h('div', { class: 'ms-browsegrid' }, d.friends.map(personCard)));
}

async function renderUserBlog(root, name) {
  const d = await api.get(`/users/${enc(name)}/blog`);
  const u = d.user;
  const self = S.me && S.me.id === u.id;
  root.append(pageTitle(`${poss(u.name)} Blog`, h('a', { class: 'btn98', href: userPath(u.name), text: '← back to their page' })));
  if (u.isBot) root.append(h('div', { class: 'bot-banner' }, botTag(), h('span', { text: `${u.name} is a bot. these entries were written for the character.` })));
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

/* ------------------------------------------------------------ browse */

function personCard(u) {
  return h('div', { class: 'ms-browsecard' + (u.isBot ? ' is-bot' : ''), onclick: e => { if (!e.target.closest('a')) go(userPath(u.name)); } },
    avatar(u, 80),
    h('div', null, h('a', { class: 'ms-name-link', href: userPath(u.name), text: u.name }), u.isBot ? botTag() : null, u.online ? h('span', { class: 'online-pip', title: 'online now' }) : null),
    u.tag ? h('div', { class: 'ms-tagline', text: u.tag }) : null);
}

async function renderBrowse(root) {
  const params = new URLSearchParams(location.search);
  const kind = ['people', 'bots'].includes(params.get('kind')) ? params.get('kind') : 'all';
  const q = params.get('q') || '';
  root.append(pageTitle('Browse — find people'));
  const set = (k, v) => { const p = new URLSearchParams(location.search); if (v) p.set(k, v); else p.delete(k); go('/browse' + (p.toString() ? '?' + p : ''), true); };
  const search = h('input', { value: q, placeholder: 'search by screen name', maxLength: 30, 'aria-label': 'search' });
  root.append(h('form', { class: 'ms-filterbar', onsubmit: e => { e.preventDefault(); set('q', search.value.trim()); } },
    [['all', 'everyone'], ['people', '👤 people'], ['bots', '🤖 bots']].map(([k, label]) =>
      h('button', { class: 'btn98' + (kind === k ? ' on' : ''), type: 'button', text: label, onclick: () => set('kind', k === 'all' ? '' : k) })),
    search, h('button', { class: 'btn98', type: 'submit', text: 'Search' })));
  if (kind === 'bots') root.append(h('div', { class: 'ms-note', text: 'the bots are ten residents from the original OurSpace. they post a little on their own, answer when you talk to them, and that\'s it. they never start conversations (except Todd\'s one welcome message).' }));
  const grid = h('div', { class: 'ms-browsegrid' });
  root.append(grid);
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more ▾' });
  let page = 0;
  const load = async () => {
    const r = await api.get(`/users?kind=${kind}&page=${page}${q ? '&q=' + enc(q) : ''}`);
    r.users.forEach(u => grid.append(personCard(u)));
    if (!grid.children.length) grid.append(h('div', { class: 'ms-empty', text: 'nobody matches that.' }));
    more.hidden = !r.more;
    page++;
  };
  more.addEventListener('click', () => load().catch(oops));
  root.append(more);
  await load();
}

/* ---------------------------------------------------------- requests */

async function renderRequests(root) {
  const d = await api.get('/requests');
  root.append(pageTitle('Friend Requests'));
  root.append(h('div', { class: 'ms-subhead', text: `waiting on you (${d.incoming.length})` }));
  if (!d.incoming.length) root.append(h('div', { class: 'ms-empty', text: 'no new requests.' }));
  d.incoming.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'sent ' + when(r.created) })),
    h('button', { class: 'btn98 go', type: 'button', text: '✔ Approve', onclick: async () => { try { await api.post('/friends/' + enc(r.user.name)); toast(`you and ${r.user.name} are friends!`); await loadMe(); route(); } catch (e) { oops(e); } } }),
    h('button', { class: 'btn98', type: 'button', text: 'Deny', onclick: async () => { try { await api.del('/friends/' + enc(r.user.name)); await loadMe(); route(); } catch (e) { oops(e); } } }))));
  root.append(h('div', { class: 'ms-subhead', text: `your requests waiting on others (${d.outgoing.length})` }));
  if (!d.outgoing.length) root.append(h('div', { class: 'ms-empty', text: 'none.' }));
  d.outgoing.forEach(r => root.append(h('div', { class: 'ms-reqrow' }, avatar(r.user),
    h('div', { class: 'ms-reqmid' }, nameLink(r.user), h('div', { class: 'ms-time', text: 'sent ' + when(r.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Cancel', onclick: async () => { try { await api.del('/friends/' + enc(r.user.name)); route(); } catch (e) { oops(e); } } }))));
}

/* ------------------------------------------------------------- inbox */

async function renderInbox(root) {
  const d = await api.get('/inbox');
  root.append(pageTitle('Inbox', h('a', { class: 'btn98', href: '/browse', text: '✉ new message (pick someone)' })));
  if (!d.threads.length) root.append(h('div', { class: 'ms-empty', text: 'no messages yet. visit someone\'s page and hit Send Message.' }));
  d.threads.forEach(t => root.append(h('div', { class: 'ms-reqrow ms-clickable' + (t.unread ? ' unread' : ''), onclick: e => { if (!e.target.closest('a')) go('/inbox/' + enc(t.with.name)); } },
    avatar(t.with),
    h('div', { class: 'ms-reqmid' }, nameLink(t.with), t.unread ? h('span', { class: 'ms-badge', text: String(t.unread) }) : null,
      h('div', { class: 'ms-preview', text: (t.last.mine ? 'you: ' : '') + t.last.body })),
    h('span', { class: 'ms-time', text: when(t.last.created) }))));
}

async function renderThread(root, name) {
  const d = await api.get('/inbox/' + enc(name));
  const u = d.with;
  root.append(pageTitle('', h('a', { class: 'btn98', href: '/inbox', text: '← Inbox' }),
    h('button', { class: 'btn98', type: 'button', text: '🚫 block', onclick: async () => { if (await blockUser(u.name, u.isBot)) go('/inbox'); } })));
  root.firstChild.firstChild.replaceWith(h('span', null, 'conversation with ', nameLink(u)));
  if (u.isBot) root.append(h('div', { class: 'bot-banner' }, botTag(), h('span', { text: `${u.name} is a bot. it answers in character with lines written ahead of time. it is not a person and can't read between the lines.` })));
  const box = h('div', { class: 'ms-thread', 'aria-live': 'polite' });
  root.append(box);
  let shown = -1;
  const paint = msgs => {
    if (msgs.length === shown && !box.querySelector('.ms-typing')) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.replaceChildren(...msgs.map(m => h('div', { class: 'ms-dm ' + (m.mine ? 'me' : 'them') },
      h('b', { text: m.mine ? S.me.name : u.name }), u.isBot && !m.mine ? botTag() : null,
      h('div', { text: m.body }),
      h('span', { class: 'ms-time', text: when(m.created) }),
      m.mine ? null : h('span', { class: 'ms-actions' }, h('a', { href: '#', text: '⚑ report', onclick: e => { e.preventDefault(); reportDialog({ type: 'message', id: m.id, what: 'this message' }); } })))));
    if (!msgs.length) box.append(h('div', { class: 'ms-empty', text: `say hi to ${u.name}!` }));
    shown = msgs.length;
    if (stick || shown) box.scrollTop = box.scrollHeight;
  };
  const typing = until => {
    box.querySelectorAll('.ms-typing').forEach(t => t.remove());
    if (until && until > Date.now()) { box.append(h('div', { class: 'ms-typing', text: `${u.name} is typing…` })); box.scrollTop = box.scrollHeight; }
  };
  paint(d.messages);
  typing(d.typingUntil);
  const refresh = async () => {
    try { const r = await api.get('/inbox/' + enc(u.name)); paint(r.messages); typing(r.typingUntil); } catch { /* try again next tick */ }
  };
  S.timers.push(setInterval(refresh, 4000));
  if (!d.canMessage) { root.append(h('div', { class: 'ms-empty', text: d.reason })); return; }
  const ta = h('textarea', { maxLength: 1000, rows: 2, placeholder: `message ${u.name}…`, 'aria-label': 'message' });
  const send = async () => {
    if (!ta.value.trim()) return;
    try {
      await api.post('/inbox/' + enc(u.name), { body: ta.value });
      ta.value = '';
      await refresh();
      if (u.isBot) setTimeout(refresh, 1500);
    } catch (e) { oops(e); }
  };
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  root.append(h('form', { class: 'ms-commentform', onsubmit: e => { e.preventDefault(); send(); } }, ta, h('button', { class: 'btn98', type: 'submit', text: 'Send' })));
  setTimeout(() => ta.focus(), 50);
  loadMe().catch(() => {});                                  // the Inbox badge drops now that it's read
}

/* --------------------------------------------------------- bulletins */

async function renderBulletins(root) {
  root.append(pageTitle('Bulletin Board'));
  if (S.me) {
    const subject = h('input', { class: 'os-input', maxLength: 80, placeholder: 'subject', 'aria-label': 'subject' });
    const body = h('textarea', { class: 'os-input', maxLength: 2000, placeholder: 'tell everybody something…', 'aria-label': 'bulletin' });
    root.append(h('details', { class: 'os-panel' }, h('summary', { class: 'ms-boxtitle', text: '📌 post a bulletin' }),
      h('form', { class: 'os-form', onsubmit: async e => {
        e.preventDefault();
        try { await api.post('/bulletins', { subject: subject.value, body: body.value }); toast('bulletin posted!'); route(); } catch (err) { oops(err); }
      } }, subject, body, h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Post bulletin' })))));
  }
  await paged(root, cur => api.get('/bulletins' + (cur ? '?before=' + enc(cur) : '')), b => {
    const card = h('div', { class: 'ms-bulletin' + (b.author.isBot ? ' by-bot' : '') },
      h('div', { class: 'ms-bulletin-head' }, avatar(b.author, 32), h('span', null, 'from ', nameLink(b.author)), h('span', { class: 'ms-time', text: when(b.created) }), postActions(b, () => card.remove())),
      h('div', { class: 'ms-bulletin-subj', text: b.subject }),
      h('div', { class: 'ms-bulletin-body', text: b.body }));
    return card;
  }, 'no bulletins yet.');
}

/* ----------------------------------------------------- sign up / in */

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

function avatarGallery(avatars, selected, onPick) {
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

async function renderJoin(root) {
  if (S.me) { go(userPath(S.me.name), true); return; }
  const opts = await options();
  let pic = opts.avatars[0].file;
  const name = h('input', { class: 'su-name', maxLength: 20, placeholder: 'pick a screen name', 'aria-label': 'screen name', autocomplete: 'username' });
  const pw = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'password (8+ characters)', 'aria-label': 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'type it again', 'aria-label': 'password again', autocomplete: 'new-password' });
  const age = h('input', { type: 'checkbox' });
  const rules = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'su-err', role: 'alert' });
  const go_ = h('button', { class: 'btn98 su-go', type: 'submit', text: '★ make my page' });
  root.append(h('form', { class: 'ms-signup win98', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    if (pw.value !== pw2.value) { err.textContent = 'the two passwords don\'t match.'; return; }
    go_.disabled = true;
    try {
      const r = await api.post('/signup', { name: name.value.trim(), password: pw.value, avatar: pic, ageOk: age.checked, rulesOk: rules.checked });
      S.me = r.user;
      await loadMe();
      toast(`welcome to ourspace, ${r.user.name}! Todd left you a message.`);
      go(userPath(r.user.name));
    } catch (ex) { err.textContent = ex.message; go_.disabled = false; }
  } },
  h('div', { class: 'title-bar' }, h('span', { text: '★ join ourspace' })),
  h('div', { class: 'su-body' },
    h('p', { class: 'su-lead', text: 'make your page in about a minute. your screen name is how everyone will know you (it can\'t be changed yet, so choose wisely). you can decorate everything else afterwards.' }),
    h('label', { class: 'su-label', text: 'screen name' }),
    h('div', { class: 'su-namerow' }, name, h('button', { class: 'btn98', type: 'button', text: '🎲', title: 'random 2006 name', onclick: () => { name.value = randomName(); } })),
    h('div', { class: 'su-hint', text: '3–20 characters: letters, numbers, _ ~ * . - (no spaces)' }),
    h('label', { class: 'su-label', text: 'password' }), pw, pw2,
    h('label', { class: 'su-label', text: 'pick a picture' }),
    avatarGallery(opts.avatars, pic, f => { pic = f; }),
    h('div', { class: 'su-checks' },
      h('label', null, age, h('span', { text: `I am ${S.minAge} or older.` })),
      h('label', null, rules, h('span', null, 'I\'ve read the ', h('a', { href: '/rules', target: '_blank', text: 'house rules' }), ' and I\'ll be nice.'))),
    err,
    h('div', { class: 'su-btns' }, go_, h('span', null, 'already have a page? ', h('a', { href: '/login', text: 'log in' }))),
    h('p', { class: 'su-fine', text: 'we keep your screen name, a scrambled copy of your password, what you post, and a scrambled copy of your IP address for spam limits. no email, no ads, no tracking. delete your account any time in Settings and it\'s gone.' }))));
  name.focus();
}

async function renderLogin(root) {
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && /^\/(?![\/\\])[^\\]*$/.test(next) ? next : null;   // a path on this site only
  if (S.me) { go(safeNext || '/', true); return; }
  const name = h('input', { class: 'su-name', maxLength: 40, placeholder: 'screen name', 'aria-label': 'screen name', autocomplete: 'username' });
  const pw = h('input', { class: 'su-name', type: 'password', maxLength: 200, placeholder: 'password', 'aria-label': 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'su-err', role: 'alert' });
  root.append(h('form', { class: 'ms-signup win98', onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    try {
      const r = await api.post('/login', { name: name.value.trim(), password: pw.value });
      S.me = r.user;
      await loadMe();
      toast(`welcome back, ${r.user.name}!`);
      go(safeNext || '/');
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'title-bar' }, h('span', { text: '🔑 log in to ourspace' })),
  h('div', { class: 'su-body' },
    h('label', { class: 'su-label', text: 'screen name' }), name,
    h('label', { class: 'su-label', text: 'password' }), pw, err,
    h('div', { class: 'su-btns' }, h('button', { class: 'btn98 su-go', type: 'submit', text: 'Log in' }),
      h('span', null, 'new here? ', h('a', { href: '/join', text: 'make a page' }))),
    h('p', { class: 'su-fine', text: 'forgot your password? there\'s no email on file (on purpose), so ask a moderator for help.' }))));
  name.focus();
}

/* ------------------------------------------------------ Edit My Page */

async function renderEdit(root) {
  const [opts, d, fr] = await Promise.all([options(), api.get('/users/' + enc(S.me.name)), api.get(`/users/${enc(S.me.name)}/friends`)]);
  const p = d.profile;
  const draft = {
    avatar: d.user.avatar, tag: p.tag, mood: p.mood, gender: p.gender, age: p.age, hometown: p.hometown, zodiac: p.zodiac, status: p.status,
    hereFor: p.hereFor, about: p.about, meet: p.meet, blogTitle: p.blogTitle, interests: { ...p.interests },
    theme: p.themeKey, bgTile: p.bgTile || '', font: p.font || '', decor: [...(p.decor || [])], badges: [...(p.badges || [])],
    top8: d.top8.map(f => f.id),
  };
  const sec = (title, note, ...kids) => h('div', { class: 'cz-block' }, h('div', { class: 'cz-h' }, title, note ? h('span', { class: 'cz-hnote', text: note }) : null), kids);
  const field = (label, key, { max = 60, list = null, area = false } = {}) => {
    const id = 'cz-' + key;
    const inp = area ? h('textarea', { id, maxLength: max, value: draft[key] || '' }) : h('input', { id, maxLength: max, value: draft[key] || '', list: list ? id + '-list' : null });
    inp.addEventListener('input', () => { draft[key] = inp.value; });
    return h('label', { for: id }, label, inp, list ? h('datalist', { id: id + '-list' }, list.map(v => h('option', { value: v }))) : null);
  };

  const avNow = h('img', { class: 'cz-avnow', src: draft.avatar, alt: 'your picture' });
  const picSec = sec('📷 picture', 'pick one of the presets',
    h('div', { class: 'cz-avrow' }, avNow, h('div', { class: 'cz-avside' },
      avatarGallery(opts.avatars, draft.avatar, f => { draft.avatar = f; avNow.src = f; }))));

  const aboutSec = sec('👤 about you', 'all optional',
    h('div', { class: 'cz-fields' },
      field('tagline', 'tag', { max: 90 }), field('mood', 'mood', { max: 40, list: opts.moods }),
      field('gender', 'gender', { max: 30, list: opts.genders }), field(`age (${S.minAge}+, or leave blank)`, 'age', { max: 3 }),
      field('hometown', 'hometown', { max: 60 }), field('zodiac', 'zodiac', { max: 40, list: opts.zodiac }),
      field('status', 'status', { max: 50, list: opts.statuses }), field('here for', 'hereFor', { max: 80, list: opts.hereFor }),
      field('blog title', 'blogTitle', { max: 60 })),
    h('div', { class: 'cz-fields cz-wide' }, field('about me', 'about', { max: 2000, area: true }), field('who I\'d like to meet', 'meet', { max: 800, area: true })),
    h('div', { class: 'cz-lbl', text: 'interests' }),
    h('div', { class: 'cz-fields' }, opts.interestKeys.map(k => {
      const inp = h('textarea', { maxLength: 400, rows: 2, value: draft.interests[k] || '' });
      inp.addEventListener('input', () => { draft.interests[k] = inp.value; });
      return h('label', null, k, inp);
    })));

  const swatches = h('div', { class: 'cz-swatches' }, opts.themes.map(t => {
    const b = h('button', { class: 'cz-swatch' + (t.key === draft.theme ? ' sel' : ''), type: 'button', text: t.name, dataset: { key: t.key } });
    b.style.background = t.bg; b.style.color = t.fg; b.style.borderColor = t.accent;
    b.addEventListener('click', () => { draft.theme = t.key; swatches.querySelectorAll('.cz-swatch').forEach(x => x.classList.toggle('sel', x.dataset.key === t.key)); });
    return b;
  }));
  const tiles = h('div', { class: 'cz-tiles' }, opts.tiles.map(t => {
    const r = h('input', { type: 'radio', name: 'cz-tile', checked: t.v === draft.bgTile });
    r.addEventListener('change', () => { draft.bgTile = t.v; });
    const prev = h('span', { class: 'cz-tileprev' });
    if (t.v) prev.style.backgroundImage = `url("${t.v}")`;
    return h('label', null, r, prev, t.label);
  }));
  const font = h('select', { 'aria-label': 'font' }, opts.fonts.map(f => h('option', { value: f.v, text: f.label, selected: f.v === draft.font })));
  font.addEventListener('change', () => { draft.font = font.value; });
  const picker = (list, key, max, cls) => {
    const count = h('span', { class: 'cz-count' });
    const paintCount = () => { count.textContent = ` (${draft[key].length}/${max})`; };
    const grid = h('div', { class: 'cz-gifgrid ' + cls }, list.map(src => h('button', {
      class: 'cz-gif' + (draft[key].includes(src) ? ' sel' : ''), type: 'button', 'aria-label': src.split('/').pop(),
      onclick: e => {
        const b = e.currentTarget;
        if (draft[key].includes(src)) draft[key] = draft[key].filter(x => x !== src);
        else if (draft[key].length >= max) { toast(`up to ${max}. unpick one first.`); return; }
        else draft[key].push(src);
        b.classList.toggle('sel', draft[key].includes(src));
        paintCount();
      },
    }, h('img', { src, alt: '', loading: 'lazy' }))));
    paintCount();
    return [count, grid];
  };
  const [decorCount, decorGrid] = picker(opts.decor, 'decor', 3, '');
  const [badgeCount, badgeGrid] = picker(opts.badges, 'badges', 12, 'cz-badges');
  const lookSec = sec('🎨 the look', 'colors, background, font, glitter',
    h('div', { class: 'cz-lbl', text: 'color theme' }), swatches,
    h('div', { class: 'cz-lbl', text: 'background' }), tiles,
    h('div', { class: 'cz-lbl', text: 'font' }), h('div', { class: 'cz-fields' }, h('label', null, font)),
    h('div', { class: 'cz-lbl' }, 'decorations under your picture', decorCount), decorGrid,
    h('div', { class: 'cz-lbl' }, '88x31 buttons', badgeCount), badgeGrid);

  const top8 = h('div', { class: 'cz-top8' });
  const paintTop8 = () => {
    top8.replaceChildren(...fr.friends.map(f => {
      const pos = draft.top8.indexOf(f.id);
      const cb = h('input', { type: 'checkbox', checked: pos >= 0 });
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (draft.top8.length >= 8) { cb.checked = false; toast('top 8 means 8. unpick someone first.'); return; }
          draft.top8.push(f.id);
        } else draft.top8 = draft.top8.filter(x => x !== f.id);
        paintTop8();
      });
      return h('label', null, cb, h('img', { src: f.avatar, alt: '' }), (pos >= 0 ? `#${pos + 1} ` : '') + f.name, f.isBot ? botTag() : null);
    }));
  };
  paintTop8();
  const friendsSec = sec('⭐ top 8', 'tick them in the order you want them shown',
    fr.friends.length ? top8 : h('div', { class: 'ms-empty', text: 'add some friends first!' }));

  const save = h('button', { class: 'btn98 go', type: 'button', text: '💾 save my page' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api.put('/me/profile', draft);
      S.me.avatar = r.avatar;
      toast('saved! looking good.');
      go(userPath(S.me.name));
    } catch (e) { oops(e); save.disabled = false; }
  });
  root.append(pageTitle('Edit My Page', h('a', { class: 'btn98', href: userPath(S.me.name), text: '← my page (without saving)' })),
    h('div', { class: 'cz' }, picSec, aboutSec, lookSec, friendsSec,
      h('div', { class: 'cz-foot' }, save, h('span', { class: 'os-hint', text: 'your screen name can\'t be changed yet.' }))));
}

/* ---------------------------------------------------------- settings */

async function renderSettings(root) {
  const blocks = await api.get('/blocks');
  root.append(pageTitle('Settings'));

  const radio = (name, value, current) => {
    const r = h('input', { type: 'radio', name, value, checked: value === current });
    return h('label', null, r, value === 'everyone' ? 'everyone' : 'friends only');
  };
  const privacy = h('form', { class: 'os-form', onsubmit: async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { const r = await api.put('/me/settings', { wallPolicy: fd.get('wall'), dmPolicy: fd.get('dm') }); S.settings = r.settings; toast('saved.'); } catch (err) { oops(err); }
  } },
  h('label', null, 'who can comment on my wall', h('div', { class: 'os-radio' }, radio('wall', 'everyone', S.settings.wallPolicy), radio('wall', 'friends', S.settings.wallPolicy))),
  h('label', null, 'who can send me messages', h('div', { class: 'os-radio' }, radio('dm', 'everyone', S.settings.dmPolicy), radio('dm', 'friends', S.settings.dmPolicy))),
  h('p', { class: 'os-hint', text: 'your page itself is always public: anyone with the link can see it. blocked people can\'t.' }),
  h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Save' })));
  root.append(h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: '🔒 privacy' }), privacy));

  const blockedBox = h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: `🚫 blocked (${blocks.blocked.length})` }));
  if (!blocks.blocked.length) blockedBox.append(h('div', { class: 'ms-empty', text: 'you haven\'t blocked anyone. to block someone, use Block User on their page.' }));
  blocks.blocked.forEach(b => blockedBox.append(h('div', { class: 'ms-reqrow' },
    h('img', { class: 'ms-avatar', src: b.user.avatar, alt: '' }),
    h('div', { class: 'ms-reqmid' }, h('b', { text: b.user.name }), b.user.isBot ? botTag() : null, h('div', { class: 'ms-time', text: 'blocked ' + when(b.created) })),
    h('button', { class: 'btn98', type: 'button', text: 'Unblock', onclick: async () => { try { await api.del('/blocks/' + enc(b.user.name)); toast('unblocked.'); route(); } catch (e) { oops(e); } } }))));
  root.append(blockedBox);

  const cur = h('input', { class: 'os-input', type: 'password', autocomplete: 'current-password', maxLength: 200 });
  const next = h('input', { class: 'os-input', type: 'password', autocomplete: 'new-password', maxLength: 200 });
  root.append(h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: '🔑 change password' }),
    h('form', { class: 'os-form', onsubmit: async e => {
      e.preventDefault();
      try { await api.post('/me/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('password changed. other devices were logged out.'); } catch (err) { oops(err); }
    } }, h('label', null, 'current password', cur), h('label', null, 'new password (8+ characters)', next), h('div', null, h('button', { class: 'btn98', type: 'submit', text: 'Change password' })))));

  const delPw = h('input', { class: 'os-input', type: 'password', autocomplete: 'current-password', maxLength: 200 });
  root.append(h('div', { class: 'os-panel danger' }, h('div', { class: 'ms-boxtitle', text: '💀 delete my account' }),
    h('form', { class: 'os-form', onsubmit: async e => {
      e.preventDefault();
      if (!await dialog({ title: 'Delete account', icon: '⚠', danger: true, ok: 'Delete everything',
        text: 'This deletes your page, everything you posted, your messages and your friends list. It can\'t be undone.' })) return;
      try { await api.del('/me', { password: delPw.value }); S.me = null; toast('your account is gone. take care out there.'); go('/'); } catch (err) { oops(err); }
    } }, h('p', { class: 'os-hint', text: 'everything you wrote, your messages and your friendships are deleted for good.' }),
    h('label', null, 'type your password to confirm', delPw), h('div', null, h('button', { class: 'btn98 danger', type: 'submit', text: 'Delete my account' })))));

  root.append(h('div', { class: 'os-form' }, h('div', null, h('button', { class: 'btn98', type: 'button', text: 'Log out', onclick: logout }))));
}

/* -------------------------------------------------------- moderation */

let modView = 'open';
async function renderAdmin(root) {
  if (!S.me.isAdmin) { root.append(pageTitle('Moderation'), h('div', { class: 'ms-empty', text: 'moderators only.' })); return; }
  const [d, log] = await Promise.all([api.get('/admin/reports?status=' + modView), api.get('/admin/log')]);
  root.append(pageTitle('Moderation',
    h('button', { class: 'btn98' + (modView === 'open' ? ' pressed' : ''), type: 'button', text: 'open', onclick: () => { modView = 'open'; route(); } }),
    h('button', { class: 'btn98' + (modView === 'closed' ? ' pressed' : ''), type: 'button', text: 'closed', onclick: () => { modView = 'closed'; route(); } })));
  root.append(h('div', { class: 'ms-note', text: 'hide = nobody sees the post or message any more (it stays in the database as evidence). ban = the account is logged out, can\'t log in, and everything it wrote disappears from the site. both can be undone.' }));
  if (!d.reports.length) root.append(h('div', { class: 'ms-empty', text: modView === 'open' ? 'no open reports. ✨' : 'nothing closed yet.' }));
  const act = async (r, action) => {
    const note = action === 'dismiss' ? '' : (prompt('note for the log (optional):') || '');
    try { await api.post('/admin/reports/' + r.id, { action, note }); toast('done.'); await loadMe(); route(); } catch (e) { oops(e); }
  };
  d.reports.forEach(r => {
    const s = r.snapshot || {};
    const what = r.type === 'user' ? `profile of ${s.name || '?'}` : r.type === 'message' ? `private message from ${s.author || '?'}` : `${s.kind || 'post'} by ${s.author || '?'}`;
    const snapText = r.type === 'user' ? [s.tag, s.mood, s.about, s.meet].filter(Boolean).join('\n—\n') : [s.subject, s.body].filter(Boolean).join('\n');
    const state = r.type === 'user' ? '' : r.targetHidden == null ? ' (deleted by its author)' : r.targetHidden ? ' (hidden)' : '';
    root.append(h('div', { class: 'mod-report' + (r.status === 'open' ? '' : ' closed') },
      h('div', { class: 'mod-head' }, h('span', { class: 'mod-reason', text: r.reason.replace('_', ' ') }), h('span', { text: what + state }),
        h('span', { class: 'ms-time', text: when(r.created) })),
      h('div', { class: 'mod-snap', text: snapText || '(empty)' }),
      r.details ? h('div', { class: 'mod-meta' }, h('b', { text: 'reporter says: ' }), r.details) : null,
      h('div', { class: 'mod-meta' }, 'reported by ', r.reporter ? nameLink(r.reporter) : '(deleted account)', ' · about ',
        r.target ? nameLink(r.target) : '(deleted account)', r.targetBanned ? ' (banned)' : '', ` · ${r.targetReports} report(s) about this account in total`,
        r.status !== 'open' ? ` · ${r.status} (${r.resolution}) by ${r.resolver || '?'} ${r.resolvedAt ? when(r.resolvedAt) : ''}` : ''),
      h('div', { class: 'mod-btns' },
        r.status === 'open' && r.type !== 'user' ? h('button', { class: 'btn98', type: 'button', text: '🙈 hide it', onclick: () => act(r, 'hide') }) : null,
        r.status === 'open' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: '⛔ ban the account', onclick: () => act(r, 'ban') }) : null,
        r.status === 'open' && r.type !== 'user' && r.target && !r.targetBanned ? h('button', { class: 'btn98 danger', type: 'button', text: 'hide + ban', onclick: () => act(r, 'hide_ban') }) : null,
        r.status === 'open' ? h('button', { class: 'btn98', type: 'button', text: '✔ dismiss (no problem)', onclick: () => act(r, 'dismiss') }) : null,
        r.target && r.targetBanned ? h('button', { class: 'btn98', type: 'button', text: 'unban', onclick: async () => { try { await api.post('/admin/users/' + enc(r.target.name), { banned: false }); toast('unbanned.'); route(); } catch (e) { oops(e); } } }) : null,
        r.type !== 'user' && r.targetHidden ? h('button', { class: 'btn98', type: 'button', text: 'unhide', onclick: async () => { try { await api.post('/admin/content', { type: r.type, id: r.targetId, hidden: false }); toast('visible again.'); route(); } catch (e) { oops(e); } } }) : null)));
  });
  root.append(h('div', { class: 'os-panel' }, h('div', { class: 'ms-boxtitle', text: '📜 moderation log' }),
    h('div', { class: 'mod-log' }, log.log.length ? log.log.map(l => h('div', { text: `${when(l.created)} · ${l.actor || '?'} · ${l.action} ${l.targetType} #${l.targetId}${l.note ? ' — ' + l.note : ''}` })) : h('div', { text: 'nothing yet.' }))));
}

/* ------------------------------------------------------------- rules */

async function renderRules(root) {
  root.append(pageTitle('House Rules & Privacy'));
  const li = t => h('li', { text: t });
  root.append(h('div', { class: 'os-doc' },
    h('p', { text: 'OurSpace is a small, friendly place. Keep it that way.' }),
    h('h2', { text: 'the rules' }),
    h('ol', null,
      li(`You have to be ${S.minAge} or older to have a page.`),
      li('Be nice. No harassment, bullying, threats or hate.'),
      li('No sexual content, ever.'),
      li('No spam, scams or chain-letter nonsense (the bots get a pass on chain letters — it\'s their whole thing).'),
      li('Don\'t pretend to be someone you\'re not.'),
      li('Don\'t post anyone\'s private information.')),
    h('p', { text: 'Break them and a moderator can hide what you posted or suspend your account.' }),
    h('h2', { text: 'about the bots' }),
    h('p', { text: 'Ten residents of the original OurSpace live here as bots: Todd, xX_DarkAngel_Xx, sk8rboi_mike, vinyl_witch, wavedash_wes, herp, BANANA_PHONE, patrick, starxgazer and zorp_51. They\'re fictional characters run by the site, and they always wear a BOT tag. They post a little on their own and answer when you talk to them, using lines written ahead of time. They never start conversations, except Todd\'s one welcome message. If one bothers you, block it like anyone else.' }),
    h('h2', { text: 'blocking and reporting' }),
    h('ul', null,
      li('Block User (on every page): they can\'t message you, comment on your wall, friend you or see your page, and you stop seeing each other\'s posts. They aren\'t told. Unblock any time in Settings.'),
      li('Report (on every page, post, comment and message): sends it to the moderators with a copy of what it said. Reports are private.'),
      li('In Settings you can also limit wall comments and messages to friends only.')),
    h('h2', { text: 'what we keep' }),
    h('ul', null,
      li('Your screen name, a hashed password, your page, and what you post or send.'),
      li('A salted hash of your IP address, used only to stop spam (rate limits). We never store the address itself.'),
      li('No email address, no ads, no tracking scripts. Profile songs on bot pages stream from Apple only when you press play.'),
      li('Deleting your account (Settings) deletes your page, posts, messages and friendships. Reports other people made about you keep a copy of the reported text for the moderators.'))));
}

/* ----------------------------------------------------------- startup */

$('#search').addEventListener('submit', e => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  go('/browse' + (q ? '?q=' + enc(q) : ''));
});

async function poll() {
  if (!S.me || document.hidden) return;
  try {
    const before = await loadMe();
    if (S.counts.unread > before && !location.pathname.startsWith('/inbox')) toast('✉ you have a new message!', false, () => go('/inbox'));
  } catch { /* offline for a moment */ }
}

(async () => {
  try { await loadMe(); } catch (e) { toast('ourspace can\'t reach its server right now. try again in a minute.', true); }
  await route();
  setInterval(poll, 30000);
})();
