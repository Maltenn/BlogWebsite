// Profiles: what a page holds, how edits are validated, and the public profile answer anybody can read.
import { fail, json, readBody, int } from './http.js';
import { text, longText } from './text.js';
import { REF_COLS, ref, refOf, visibleUser, friendship, blockedBy, NOT_BLOCKED, isOnline, profileData } from './db.js';
import { THEMES, TILES, FONTS, DECOR, BADGES, ZODIAC, STATUSES, HERE_FOR, GENDERS, MOODS, INTEREST_KEYS, REPORT_REASONS } from './options.js';
import { AVATARS } from './generated/avatars.js';

const AVATAR_SET = new Set(AVATARS.map(a => a.file));
const TILE_SET = new Set(TILES.map(t => t.v));
const FONT_SET = new Set(FONTS.map(f => f.v));
const DECOR_SET = new Set(DECOR);
const BADGE_SET = new Set(BADGES);
const THEME_BY_KEY = new Map(THEMES.map(t => [t.key, t]));

export const DEFAULT_AVATAR = AVATARS[0].file;
export const isAvatar = v => AVATAR_SET.has(v);

export function defaultProfile() {
  return {
    tag: 'new here. be nice.', mood: 'curious', gender: '', age: '', hometown: '', zodiac: '', status: 'Single', hereFor: 'Friends',
    about: 'i just got here. still figuring out where all the buttons are. say hi!',
    meet: 'anyone who says hi first.',
    interests: Object.fromEntries(INTEREST_KEYS.map(k => [k, ''])),
    blogTitle: '', theme: 'ourspace-blue', bgTile: '', font: '',
    decor: ['/assets/deco_new.gif'], badges: ['/assets/badge_best_viewed_with_eyes.gif', '/assets/badge_aim.gif'],
    top8: [],
  };
}

// GET /api/options — everything the editor can offer (cacheable: it only changes with a deploy)
export function options() {
  return json({
    avatars: AVATARS, themes: THEMES, tiles: TILES, fonts: FONTS, decor: DECOR, badges: BADGES,
    zodiac: ZODIAC, statuses: STATUSES, hereFor: HERE_FOR, genders: GENDERS, moods: MOODS, interestKeys: INTEREST_KEYS,
    reportReasons: REPORT_REASONS,
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// Validate an edit against the current profile. Only fields present in `input` change; anything not on the lists in
// options.js is refused, so a profile can never carry arbitrary CSS, fonts or image URLs.
export function applyProfileEdit(current, input, minAge) {
  const p = { ...defaultProfile(), ...current };
  const has = k => Object.prototype.hasOwnProperty.call(input, k);
  const short = { tag: 90, mood: 40, gender: 30, hometown: 60, zodiac: 40, status: 50, hereFor: 80, blogTitle: 60 };
  for (const [k, max] of Object.entries(short)) if (has(k)) p[k] = text(input[k], max);
  if (has('about')) p.about = longText(input.about, 2000);
  if (has('meet')) p.meet = longText(input.meet, 800);
  if (has('age')) {
    const raw = String(input.age ?? '').trim();
    if (raw === '') p.age = '';
    else {
      const n = int(raw);
      if (n == null || String(n) !== raw || n > 120) fail(400, 'age should be a number (or leave it blank).');
      if (n < minAge) fail(400, `ourspace is for people ${minAge} and up.`);
      p.age = String(n);
    }
  }
  if (has('interests')) {
    if (!input.interests || typeof input.interests !== 'object') fail(400, 'bad interests');
    p.interests = Object.fromEntries(INTEREST_KEYS.map(k => [k, longText(input.interests[k], 400)]));
  }
  if (has('theme')) {
    if (!THEME_BY_KEY.has(input.theme)) fail(400, 'pick one of the color themes.');
    p.theme = input.theme;
  }
  if (has('bgTile')) {
    if (!TILE_SET.has(input.bgTile)) fail(400, 'pick one of the backgrounds.');
    p.bgTile = input.bgTile;
  }
  if (has('font')) {
    if (!FONT_SET.has(input.font)) fail(400, 'pick one of the fonts.');
    p.font = input.font;
  }
  const pickList = (k, set, max, label) => {
    if (!has(k)) return;
    const v = input[k];
    if (!Array.isArray(v) || v.length > max || v.some(x => !set.has(x))) fail(400, `${label}: up to ${max}, from the list.`);
    p[k] = [...new Set(v)];
  };
  pickList('decor', DECOR_SET, 3, 'decorations');
  pickList('badges', BADGE_SET, 12, 'buttons');
  if (has('top8')) {
    const v = input.top8;
    if (!Array.isArray(v) || v.length > 8 || v.some(x => !Number.isInteger(x) || x < 1)) fail(400, 'top 8: up to 8 friends.');
    p.top8 = [...new Set(v)];
  }
  return p;
}

// the profile as the page draws it: theme key → colors (bots carry their own colors)
export function presentProfile(data, isBot) {
  const p = { ...data };
  if (isBot) {
    p.theme = data.theme || THEMES[0];
  } else {
    const t = THEME_BY_KEY.get(data.theme) || THEMES[0];
    p.themeKey = t.key;
    p.theme = { bg: t.bg, fg: t.fg, accent: t.accent };
  }
  return p;
}

// PUT /api/me/profile
export async function saveProfile(c) {
  const input = await readBody(c.req);
  const current = await profileData(c.env, c.user.id);
  const next = applyProfileEdit(current, input, Number(c.env.MIN_AGE || 13));
  let avatar = c.user.avatar;
  if (Object.prototype.hasOwnProperty.call(input, 'avatar')) {
    if (!isAvatar(input.avatar)) fail(400, 'pick one of the pictures.');
    avatar = input.avatar;
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE profiles SET data = ?, updated = ? WHERE user_id = ?').bind(JSON.stringify(next), c.now, c.user.id),
    c.env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, c.user.id),
  ]);
  return json({ ok: true, avatar, profile: presentProfile(next, false) });
}

// PUT /api/me/settings — who may comment on my wall / message me
export async function saveSettings(c) {
  const input = await readBody(c.req);
  const ok = v => v === 'everyone' || v === 'friends';
  const wall = input.wallPolicy ?? c.user.wall_policy;
  const dm = input.dmPolicy ?? c.user.dm_policy;
  if (!ok(wall) || !ok(dm)) fail(400, 'choose everyone or friends.');
  await c.env.DB.prepare('UPDATE users SET wall_policy = ?, dm_policy = ? WHERE id = ?').bind(wall, dm, c.user.id).run();
  return json({ ok: true, settings: { wallPolicy: wall, dmPolicy: dm } });
}

// The top 8 as shown: the owner's chosen order first, then their newest friends, up to 8
async function topFriends(c, owner, chosen) {
  const viewer = c.user ? c.user.id : 0;
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('u', '')}, f.accepted
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.a = ?2 THEN f.b ELSE f.a END
    WHERE (f.a = ?2 OR f.b = ?2) AND f.status = 'accepted' AND u.banned = 0 AND ${NOT_BLOCKED('u.id')}
    ORDER BY f.accepted DESC LIMIT 200`).bind(viewer, owner.id).all();
  const byId = new Map(results.map(r => [r.id, r]));
  const order = [...(chosen || []).filter(id => byId.has(id)), ...results.map(r => r.id)];
  return { count: results.length, top8: [...new Set(order)].slice(0, 8).map(id => ref(byId.get(id))) };
}

// GET /api/users/:name — a public profile page. Anybody can read it, logged in or not.
export async function profile(c) {
  const u = await visibleUser(c, c.params.name);
  const viewer = c.user ? c.user.id : 0;
  const data = await profileData(c.env, u.id);
  const friends = await topFriends(c, u, data.top8);
  const { results: wall } = await c.env.DB.prepare(`
    SELECT p.id, p.body, p.created, ${REF_COLS('a', 'a_')}
    FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.target_id = ?2 AND p.kind = 'wall' AND p.hidden = 0 AND p.created <= ?3 AND a.banned = 0 AND ${NOT_BLOCKED('a.id')}
    ORDER BY p.created DESC, p.id DESC LIMIT 50`).bind(viewer, u.id, c.now).all();
  const blog = await c.env.DB.prepare(`
    SELECT id, subject AS title, mood, body, created, (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND kind = 'blog' AND hidden = 0 AND created <= ?2) AS n
    FROM posts WHERE author_id = ?1 AND kind = 'blog' AND hidden = 0 AND created <= ?2 ORDER BY created DESC LIMIT 1`).bind(u.id, c.now).first();
  const self = viewer === u.id;
  const admin = !!(c.user && c.user.is_admin);

  let relation = null;
  if (c.user && !self) {
    const f = await friendship(c.env, viewer, u.id);
    const friend = !f ? 'none' : f.status === 'accepted' ? 'friends' : f.requested_by === viewer ? 'requested' : 'incoming';
    const blockedByMe = await blockedBy(c.env, viewer, u.id);
    relation = {
      friend, blockedByMe,
      canComment: !blockedByMe && (u.wall_policy === 'everyone' || friend === 'friends'),
      canMessage: !blockedByMe && (u.dm_policy === 'everyone' || friend === 'friends'),
    };
  }
  return json({
    user: { ...refOf(u), online: isOnline(u, c.now), lastSeen: u.is_bot ? null : u.last_seen, joined: u.created, banned: !!u.banned },
    profile: presentProfile(data, !!u.is_bot),
    friendCount: friends.count,
    top8: friends.top8,
    wall: wall.map(w => ({
      id: w.id, body: w.body, created: w.created, author: ref(w, 'a_'),
      canDelete: self || admin || (c.user && w.a_id === viewer),
    })),
    latestBlog: blog ? { id: blog.id, title: blog.title, mood: blog.mood, body: blog.body.slice(0, 400), created: blog.created } : null,
    blogCount: blog ? blog.n : 0,
    self,
    relation,
    policies: { wall: u.wall_policy, dm: u.dm_policy },
  });
}

// GET /api/users?kind=all|people|bots&q=&page= — the Browse directory
export async function browse(c) {
  const kind = c.url.searchParams.get('kind') || 'all';
  const q = (c.url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 30);
  const page = Math.max(0, int(c.url.searchParams.get('page'), 0));
  const per = 24;
  const viewer = c.user ? c.user.id : 0;
  const where = ['u.banned = 0', NOT_BLOCKED('u.id')];
  const binds = [viewer];
  if (kind === 'people') where.push('u.is_bot = 0');
  else if (kind === 'bots') where.push('u.is_bot = 1');
  if (q) {
    binds.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%');
    where.push(`u.name_key LIKE ?${binds.length} ESCAPE '\\'`);
  }
  binds.push(per + 1, page * per);
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('u', '')}, u.created, u.last_seen, u.is_bot, json_extract(p.data, '$.tag') AS tag
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY u.is_bot ASC, COALESCE(u.last_seen, u.created) DESC, u.id DESC
    LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`).bind(...binds).all();
  return json({
    users: results.slice(0, per).map(r => ({ ...ref(r), tag: r.tag || '', joined: r.created, online: isOnline(r, c.now) })),
    more: results.length > per,
  });
}

// GET /api/users/:name/friends — everyone on their friend list
export async function friendsOf(c) {
  const u = await visibleUser(c, c.params.name);
  const viewer = c.user ? c.user.id : 0;
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('x', '')}, x.last_seen, x.is_bot
    FROM friendships f JOIN users x ON x.id = CASE WHEN f.a = ?2 THEN f.b ELSE f.a END
    WHERE (f.a = ?2 OR f.b = ?2) AND f.status = 'accepted' AND x.banned = 0 AND ${NOT_BLOCKED('x.id')}
    ORDER BY f.accepted DESC LIMIT 500`).bind(viewer, u.id).all();
  return json({ user: refOf(u), friends: results.map(r => ({ ...ref(r), online: isOnline(r, c.now) })) });
}
