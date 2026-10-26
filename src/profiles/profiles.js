// Profiles: what a page holds, how edits are validated, and the profile answer anybody can read.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText } from '../shared/text.js';
import { REF_COLS, ref, refOf, visibleUser, canSeePosts, relationTo, NOT_BLOCKED, VISIBLE, REPOSTED, REPOST_OK, LISTS, isOnline, profileData } from '../shared/db.js';
import { THEMES, TILES, FONTS, DECOR, BADGES, STATUSES, HERE_FOR, GENDERS, MOODS, INTEREST_KEYS, REPORT_REASONS } from '../catalog/options.js';
import { AVATARS } from '../catalog/avatars.js';
import { ageOn } from '../shared/dates.js';
import { sunSign } from '../shared/astro.js';
import { profileSpotify } from '../music/spotify.js';
import { ownAvatar, avatarStatements, dropObjects, keysIn } from '../shared/media.js';

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
    tag: 'new here. be nice.', mood: 'curious', gender: '', hometown: '', status: 'Single', hereFor: 'Friends',
    showAge: true, showSign: true,                 // age and star sign come from the (private) birthday
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
    statuses: STATUSES, hereFor: HERE_FOR, genders: GENDERS, moods: MOODS, interestKeys: INTEREST_KEYS,
    reportReasons: REPORT_REASONS,
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// Validate an edit against the current profile. Only fields present in `input` change; anything not on the lists in
// options.js is refused, so a profile can never carry arbitrary CSS, fonts or image URLs.
export function applyProfileEdit(current, input) {
  const p = { ...defaultProfile(), ...current };
  delete p.age; delete p.zodiac;                   // (free-text fields from before birthdays; both are computed now)
  const has = k => Object.prototype.hasOwnProperty.call(input, k);
  const short = { tag: 90, mood: 40, gender: 30, hometown: 60, status: 50, hereFor: 80, blogTitle: 60 };
  for (const [k, max] of Object.entries(short)) if (has(k)) p[k] = text(input[k], max);
  if (has('about')) p.about = longText(input.about, 2000);
  if (has('meet')) p.meet = longText(input.meet, 800);
  for (const k of ['showAge', 'showSign']) if (has(k)) p[k] = input[k] !== false;
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

// the profile as the page draws it: theme key → colors
export function presentProfile(data) {
  const t = THEME_BY_KEY.get(data.theme) || THEMES[0];
  const p = { ...data, themeKey: t.key, theme: { bg: t.bg, fg: t.fg, accent: t.accent } };
  delete p.age; delete p.zodiac;
  return p;
}

// PUT /api/me/profile
export async function saveProfile(c) {
  const input = await readBody(c.req);
  const current = await profileData(c.env, c.user.id);
  const next = applyProfileEdit(current, input);
  if (next.top8.length && Object.prototype.hasOwnProperty.call(input, 'top8')) {
    // the Top 8 holds friends only
    const { results } = await c.env.DB.prepare(`SELECT x.id FROM ${LISTS.friends.from} AND x.id IN (SELECT value FROM json_each(?3))`)
      .bind(c.user.id, c.user.id, JSON.stringify(next.top8)).all();
    const friends = new Set(results.map(r => r.id));
    next.top8 = next.top8.filter(id => friends.has(id));
  }
  // the picture: one of the presets, or one I uploaded as a picture (POST /api/media?purpose=avatar); the one I uploaded
  // before goes, out of R2 too
  let avatar = c.user.avatar;
  let upload = null;
  const changing = Object.prototype.hasOwnProperty.call(input, 'avatar') && input.avatar !== c.user.avatar;
  if (changing) {
    if (!isAvatar(input.avatar)) {
      upload = await ownAvatar(c, input.avatar);
      if (!upload) fail(400, 'pick one of the pictures, or upload your own.');
    }
    avatar = input.avatar;
  }
  const DB = c.env.DB;
  const res = await DB.batch([
    DB.prepare('UPDATE profiles SET data = ?, updated = ? WHERE user_id = ?').bind(JSON.stringify(next), c.now, c.user.id),
    // (an upload taken back or removed in the meantime leaves the picture as it was)
    DB.prepare('UPDATE users SET avatar = ?1 WHERE id = ?2 AND (?3 = 0 OR EXISTS (SELECT 1 FROM media WHERE id = ?3 AND owner_id = ?2 AND hidden = 0))')
      .bind(avatar, c.user.id, upload ? upload.id : 0),
    ...(changing ? avatarStatements(DB, c.user.id, c.now, upload ? upload.id : 0) : []),
    DB.prepare('SELECT avatar FROM users WHERE id = ?').bind(c.user.id),
  ]);
  if (changing) await dropObjects(c.env, keysIn(...res.slice(2, -1)));
  return json({ ok: true, avatar: res.at(-1).results[0].avatar, profile: presentProfile(next) });
}

// PUT /api/me/settings — who may follow me (anyone at once, or only people I approve) and who may message me
export async function saveSettings(c) {
  const input = await readBody(c.req);
  const follow = input.followPolicy ?? c.user.follow_policy;
  const dm = input.dmPolicy ?? c.user.dm_policy;
  if (follow !== 'open' && follow !== 'approve') fail(400, 'choose open or approve.');
  if (dm !== 'everyone' && dm !== 'friends') fail(400, 'choose everyone or friends.');
  const DB = c.env.DB;
  const stmts = [DB.prepare('UPDATE users SET follow_policy = ?, dm_policy = ? WHERE id = ?').bind(follow, dm, c.user.id)];
  // an open profile takes follows at once, so going open lets in everyone still waiting
  if (follow === 'open') {
    stmts.push(DB.prepare('UPDATE follows SET status = \'accepted\', accepted = ? WHERE followee_id = ? AND status = \'pending\'').bind(c.now, c.user.id));
  }
  await DB.batch(stmts);
  return json({ ok: true, settings: { followPolicy: follow, dmPolicy: dm } });
}

// The top 8 as shown: the owner's chosen friends in order first, then their newest friends, up to 8. Somebody who may
// not see the owner's posts (seePosts false) gets only the friends the owner chose, never the newest-friends fill, so a
// private profile's friends aren't given away.
async function topFriends(c, owner, chosen, seePosts) {
  const { results } = await c.env.DB.prepare(`SELECT ${REF_COLS('x', '')} FROM ${LISTS.friends.from} ORDER BY ${LISTS.friends.since} DESC LIMIT 200`)
    .bind(c.user ? c.user.id : 0, owner.id).all();
  const byId = new Map(results.map(r => [r.id, r]));
  const order = [...(chosen || []).filter(id => byId.has(id)), ...(seePosts ? results.map(r => r.id) : [])];
  return [...new Set(order)].slice(0, 8).map(id => ref(byId.get(id)));
}

// GET /api/users/:name — a profile page. Anybody can read the page itself (logged in or not); a private profile's
// posts (statuses, quotes and reposts), replies, blog and Friends' Comments are only for its accepted followers, the
// owner and moderators (canSeePosts), and so are their totals in `counts`. The comments themselves come from
// GET /api/users/:name/comments.
export async function profile(c) {
  const u = await visibleUser(c, c.params.name);
  const viewer = c.user ? c.user.id : 0;
  const self = viewer === u.id;
  const DB = c.env.DB;
  const data = await profileData(c.env, u.id);
  const seePosts = await canSeePosts(c, u);
  const counts = await DB.prepare(`SELECT
      (SELECT COUNT(*) FROM ${LISTS.followers.from}) AS followers,
      (SELECT COUNT(*) FROM ${LISTS.following.from}) AS following,
      (SELECT COUNT(*) FROM ${LISTS.friends.from}) AS friends`).bind(viewer, u.id).first();
  let totals = {}, status = null, blog = [];
  if (seePosts) {
    totals = await DB.prepare(`SELECT COALESCE(SUM(p.kind IN ('status', 'quote', 'repost')), 0) AS statuses, COALESCE(SUM(p.kind = 'reply'), 0) AS replies,
        COALESCE(SUM(p.kind = 'blog'), 0) AS blog, COALESCE(SUM(p.kind = 'wall'), 0) AS comments
      FROM posts p JOIN users a ON a.id = p.author_id ${REPOSTED}
      WHERE ${VISIBLE} AND ${REPOST_OK}
        AND ((p.kind IN ('status', 'quote', 'repost', 'reply', 'blog') AND p.author_id = ?3) OR (p.kind = 'wall' AND p.target_id = ?3))`).bind(viewer, c.now, u.id).first();
    status = await DB.prepare(`SELECT id, body, created FROM posts WHERE author_id = ?1 AND kind = 'status' AND hidden = 0 AND deleted = 0 AND created <= ?2
      ORDER BY created DESC, id DESC LIMIT 1`).bind(u.id, c.now).first();
    ({ results: blog } = await DB.prepare(`SELECT id, subject AS title, subtitle, created FROM posts
      WHERE author_id = ?1 AND kind = 'blog' AND hidden = 0 AND deleted = 0 AND created <= ?2 ORDER BY created DESC, id DESC LIMIT 3`).bind(u.id, c.now).all());
  }
  const sign = sunSign(u.birthdate);
  return json({
    user: { ...refOf(u), online: isOnline(u, c.now), lastSeen: u.last_seen, joined: u.created, banned: !!u.banned },
    profile: presentProfile(data),
    age: data.showAge === false ? null : ageOn(u.birthdate, c.now),
    sign: data.showSign === false ? null : { key: sign.key, name: sign.name, glyph: sign.glyph },
    spotify: await profileSpotify(c, u.id),
    counts: { followers: counts.followers, following: counts.following, friends: counts.friends, ...totals },
    top8: await topFriends(c, u, data.top8, seePosts),
    private: u.follow_policy === 'approve',
    canSeePosts: seePosts,
    latestStatus: status ? { id: status.id, body: status.body, created: status.created } : null,
    blog: blog.map(b => ({ id: b.id, title: b.title, subtitle: b.subtitle || null, created: b.created })),
    self,
    relation: await relationTo(c, u),
    policies: { follow: u.follow_policy, dm: u.dm_policy },
  });
}

// GET /api/users?q=&page= — the Browse directory
export async function browse(c) {
  const q = (c.url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 30);
  const page = Math.max(0, int(c.url.searchParams.get('page'), 0));
  const per = 24;
  const viewer = c.user ? c.user.id : 0;
  const where = ['u.banned = 0', NOT_BLOCKED('u.id')];
  const binds = [viewer];
  if (q) {
    binds.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%');
    where.push(`u.name_key LIKE ?${binds.length} ESCAPE '\\'`);
  }
  binds.push(per + 1, page * per);
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('u', '')}, u.created, u.last_seen, json_extract(p.data, '$.tag') AS tag
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(u.last_seen, u.created) DESC, u.id DESC
    LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`).bind(...binds).all();
  return json({
    users: results.slice(0, per).map(r => ({ ...ref(r), tag: r.tag || '', joined: r.created, online: isOnline(r, c.now) })),
    more: results.length > per,
  });
}
