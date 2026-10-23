// The bots: ten of the original OurSpace residents, living on the server so everybody sees the same ones. They are
// ordinary accounts with is_bot = 1, and every answer the API gives carries isBot, so the page labels them everywhere.
// What they do, and no more:
//   · post a few statuses / wall comments / bulletins / blog entries a day, all together (BOT_POSTS_PER_DAY, cron)
//   · accept friend requests and say thanks on your wall
//   · answer a message or a wall comment, in character, after a short "typing" delay
//   · Todd welcomes each new person (a friend, a wall comment and one message)
// They never start conversations with people otherwise. Their lines come from the original site's content
// (src/generated/bots.js, built by tools/build.mjs).
import { BOTS, BOTS_VERSION } from './generated/bots.js';
import { kvGet, kvSet, pair } from './db.js';

const BY_KEY = new Map(BOTS.map(b => [b.key, b]));
export const BOT_NAME_KEYS = [...new Set(BOTS.flatMap(b => [b.name.toLowerCase(), b.key.toLowerCase()]))];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const scale = env => Number(env.BOT_DELAY_SCALE ?? 1);
const delay = (env, minS, maxS) => Math.round((minS + Math.random() * (maxS - minS)) * 1000 * scale(env));
const hours = h => h * 3600000;

/* ------------------------------------------------------------ setup */

let ready = false;                                   // per isolate: the version check runs once, not per request

// Make sure the bot accounts exist and match the content; seed a little history the first time ever.
export async function ensureBots(c) {
  if (ready) return;
  if (await kvGet(c.env, 'bots:version') !== BOTS_VERSION) await syncBots(c);
  const claim = await c.env.DB.prepare('INSERT INTO kv (k, v) VALUES (\'bots:seeded\', ?) ON CONFLICT(k) DO NOTHING RETURNING k')
    .bind(String(c.now)).first();
  if (claim) await seedWorld(c);
  ready = true;
}

async function syncBots(c) {
  const DB = c.env.DB;
  for (const b of BOTS) {
    try {
      const u = await DB.prepare(`INSERT INTO users (name, name_key, avatar, is_bot, bot_key, created) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(bot_key) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, avatar = excluded.avatar
        RETURNING id`).bind(b.name, b.name.toLowerCase(), b.avatar, b.key, c.now - hours(24 * 60)).first();
      await DB.prepare(`INSERT INTO profiles (user_id, data, updated) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
        .bind(u.id, JSON.stringify({ ...b.profile, top8: [] }), c.now).run();
    } catch (e) {
      console.error(`bot ${b.key} could not be synced (is a person using the name "${b.name}"?):`, e && e.message);
    }
  }
  // bots taken out of BOT_IDS stay in the database (their conversations with people survive) but are retired
  const keys = BOTS.map(b => b.key);
  await DB.prepare(`UPDATE users SET banned = 1 WHERE is_bot = 1 AND bot_key NOT IN (${keys.map(() => '?').join(',')})`).bind(...keys).run();
  await kvSet(c.env, 'bots:version', BOTS_VERSION);
}

async function botIds(env) {
  const { results } = await env.DB.prepare('SELECT id, bot_key, banned FROM users WHERE is_bot = 1').all();
  return new Map(results.filter(r => !r.banned && BY_KEY.has(r.bot_key)).map(r => [r.bot_key, r.id]));
}

// The first boot: the bots are friends with each other and have a few days of history, so the site isn't empty.
async function seedWorld(c) {
  const ids = await botIds(c.env);
  const DB = c.env.DB;
  const stmts = [];
  const ago = (minH, maxH) => c.now - Math.round(hours(minH + Math.random() * (maxH - minH)));
  const used = {};
  const mark = (key, kind, i) => { ((used[key] = used[key] || {})[kind] = used[key][kind] || []).push(i); };
  const seen = new Set();
  for (const b of BOTS) {
    const me = ids.get(b.key);
    if (!me) continue;
    for (const f of b.friends) {
      const other = ids.get(f);
      if (!other) continue;
      const [x, y] = pair(me, other);
      if (seen.has(x + ':' + y)) continue;
      seen.add(x + ':' + y);
      const t = ago(24 * 20, 24 * 40);
      stmts.push(DB.prepare('INSERT OR IGNORE INTO friendships (a, b, status, requested_by, created, accepted) VALUES (?, ?, \'accepted\', ?, ?, ?)')
        .bind(x, y, me, t, t));
    }
    if (b.lines.statuses.length) {
      stmts.push(DB.prepare('INSERT INTO posts (kind, author_id, body, created) VALUES (\'status\', ?, ?, ?)').bind(me, b.lines.statuses[0], ago(1, 72)));
      mark(b.key, 'statuses', 0);
    }
    b.wallSeeds.slice(0, 2).forEach((w, i) => {
      if (!ids.get(w.from)) return;
      stmts.push(DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?)')
        .bind(ids.get(w.from), me, w.text, ago(2, 120)));
      mark(b.key, 'wall', i);
    });
    if (b.lines.bulletins.length) {
      const bl = b.lines.bulletins[0];
      stmts.push(DB.prepare('INSERT INTO posts (kind, author_id, subject, body, created) VALUES (\'bulletin\', ?, ?, ?, ?)')
        .bind(me, bl.subject || `bulletin from ${b.name}`, bl.body, ago(6, 160)));
      mark(b.key, 'bulletins', 0);
    }
    if (b.blog.length) {
      const e = b.blog[0];
      stmts.push(DB.prepare('INSERT INTO posts (kind, author_id, subject, mood, body, created) VALUES (\'blog\', ?, ?, ?, ?, ?)')
        .bind(me, e.title, e.mood, e.body, ago(24, 24 * 9)));
      mark(b.key, 'blog', 0);
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));
  await kvSet(c.env, 'bots:used', JSON.stringify(used));
}

/* --------------------------------------------------- scheduled posts */

const KINDS = [['statuses', 55], ['blog', 15], ['wall', 20], ['bulletins', 10]];
const poolOf = (b, kind) => kind === 'statuses' ? b.lines.statuses : kind === 'bulletins' ? b.lines.bulletins : kind === 'blog' ? b.blog : b.wallSeeds;

// cron: about BOT_POSTS_PER_DAY posts a day, spread over the 48 half-hour runs
export async function botTick(env, now) {
  const perRun = Number(env.BOT_POSTS_PER_DAY ?? 12) / 48;
  let n = Math.floor(perRun) + (Math.random() < perRun % 1 ? 1 : 0);
  if (!n) return 0;
  const ids = await botIds(env);
  if (!ids.size) return 0;
  let used = {};
  try { used = JSON.parse(await kvGet(env, 'bots:used') || '{}'); } catch { used = {}; }
  let posted = 0;
  while (n-- > 0) if (await postOnce(env, now, ids, used)) posted++;
  await kvSet(env, 'bots:used', JSON.stringify(used));
  return posted;
}

async function postOnce(env, now, ids, used) {
  const total = KINDS.reduce((s, k) => s + k[1], 0);
  let r = Math.random() * total;
  const kind = KINDS.find(k => (r -= k[1]) < 0)[0];
  const usedOf = key => ((used[key] = used[key] || {})[kind] = used[key][kind] || []);
  const options = b => poolOf(b, kind).map((x, i) => i)
    .filter(i => !usedOf(b.key).includes(i) && (kind !== 'wall' || ids.has(b.wallSeeds[i].from)));
  let bots = BOTS.filter(b => ids.has(b.key) && options(b).length);
  if (!bots.length) {
    // everything of this kind has been said once: start over (it takes weeks to get here)
    BOTS.forEach(b => { usedOf(b.key).length = 0; });
    bots = BOTS.filter(b => ids.has(b.key) && options(b).length);
    if (!bots.length) return false;
  }
  const b = pick(bots);
  const i = pick(options(b));
  usedOf(b.key).push(i);
  const me = ids.get(b.key);
  const DB = env.DB;
  if (kind === 'statuses') {
    await DB.prepare('INSERT INTO posts (kind, author_id, body, created) VALUES (\'status\', ?, ?, ?)').bind(me, b.lines.statuses[i], now).run();
  } else if (kind === 'bulletins') {
    const bl = b.lines.bulletins[i];
    await DB.prepare('INSERT INTO posts (kind, author_id, subject, body, created) VALUES (\'bulletin\', ?, ?, ?, ?)')
      .bind(me, bl.subject || `bulletin from ${b.name}`, bl.body, now).run();
  } else if (kind === 'blog') {
    const e = b.blog[i];
    await DB.prepare('INSERT INTO posts (kind, author_id, subject, mood, body, created) VALUES (\'blog\', ?, ?, ?, ?, ?)')
      .bind(me, e.title, e.mood, e.body, now).run();
  } else {
    const w = b.wallSeeds[i];
    await DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?)')
      .bind(ids.get(w.from), me, w.text, now).run();
  }
  return true;
}

/* ----------------------------------------------- answering people */

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An in-character answer: a keyword line if the person said one of the bot's words (whole words only), else one of
// its replies — never a line it already said to this person recently, until it has nothing new left.
export function replyLine(bot, said, userText, name) {
  const you = s => s.replace(/\{you\}/g, name).replace(/\{YOU\}/g, name.toUpperCase());
  const lower = String(userText || '').toLowerCase();
  for (const [k, line] of Object.entries(bot.lines.keywords)) {
    const re = new RegExp('(^|[^a-z0-9])' + escapeRe(k) + '(?:e?s)?(?=$|[^a-z0-9])');
    if (re.test(lower) && !said.has(you(line))) return you(line);
  }
  const all = bot.lines.replies.map(you);
  if (!all.length) return 'lol';
  const fresh = all.filter(l => !said.has(l));
  return pick(fresh.length ? fresh : all);
}

// One answer at a time per person and channel (a burst of messages gets one reply), and a daily ceiling.
async function mayAnswer(env, now, sql, botId, personId) {
  const r = await env.DB.prepare(sql).bind(botId, personId, now - 86400000).first();
  return !(r && ((r.last != null && r.last > now - 15000) || r.n >= 40));
}

const botOf = u => BY_KEY.get(u.bot_key);

// a person sent a friend request to a bot: accepted at once, and a thank-you lands on their wall a bit later
export async function botAcceptsFriend(c, botUser) {
  const bot = botOf(botUser);
  if (!bot) return;
  const [a, b] = pair(c.user.id, botUser.id);
  const stmts = [
    c.env.DB.prepare('UPDATE friendships SET status = \'accepted\', accepted = ? WHERE a = ? AND b = ?').bind(c.now, a, b),
    c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, created) VALUES (\'friends\', ?, ?, ?)').bind(c.user.id, botUser.id, c.now),
    // they're friends now, so either wall setting lets the thank-you through
    c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?)')
      .bind(botUser.id, c.user.id, bot.lines.thanksAdd.replace(/\{you\}/gi, c.user.name), c.now + delay(c.env, 8, 40)),
  ];
  await c.env.DB.batch(stmts);
}

// a person commented on a bot's wall: the bot answers on theirs (the way it worked on the real thing)
export async function botAnswersWall(c, botUser, userText) {
  const bot = botOf(botUser);
  if (!bot) return;
  if (c.user.wall_policy === 'friends') {
    const [a, b] = pair(c.user.id, botUser.id);
    const f = await c.env.DB.prepare('SELECT status FROM friendships WHERE a = ? AND b = ?').bind(a, b).first();
    if (!f || f.status !== 'accepted') return;               // their wall is friends-only and the bot isn't one
  }
  const ok = await mayAnswer(c.env, c.now, `SELECT MAX(created) AS last, COUNT(*) AS n FROM posts
    WHERE author_id = ?1 AND target_id = ?2 AND kind = 'wall' AND created > ?3`, botUser.id, c.user.id);
  if (!ok) return;
  const { results } = await c.env.DB.prepare('SELECT body FROM posts WHERE author_id = ? AND target_id = ? AND kind = \'wall\' ORDER BY created DESC LIMIT 30')
    .bind(botUser.id, c.user.id).all();
  const line = replyLine(bot, new Set(results.map(r => r.body)), userText, c.user.name);
  await c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?)')
    .bind(botUser.id, c.user.id, line, c.now + delay(c.env, 10, 35)).run();
}

// a person messaged a bot: it writes back after a few seconds of "typing"
export async function botAnswersMessage(c, botUser, userText) {
  const bot = botOf(botUser);
  if (!bot) return;
  const ok = await mayAnswer(c.env, c.now, `SELECT MAX(created) AS last, COUNT(*) AS n FROM messages
    WHERE from_id = ?1 AND to_id = ?2 AND created > ?3`, botUser.id, c.user.id);
  if (!ok) return;
  const { results } = await c.env.DB.prepare('SELECT body FROM messages WHERE from_id = ? AND to_id = ? ORDER BY created DESC LIMIT 40')
    .bind(botUser.id, c.user.id).all();
  const line = replyLine(bot, new Set(results.map(r => r.body)), userText, c.user.name);
  await c.env.DB.prepare('INSERT INTO messages (from_id, to_id, body, created) VALUES (?, ?, ?, ?)')
    .bind(botUser.id, c.user.id, line, c.now + delay(c.env, 4, 14)).run();
}

// Todd (a bot, and says so) is everyone's first friend: a friendship, a wall comment, and one welcome message
export async function welcome(c, user) {
  const todd = await c.env.DB.prepare('SELECT id FROM users WHERE bot_key = \'todd\' AND banned = 0').first();
  if (!todd) return;
  const [a, b] = pair(todd.id, user.id);
  const n = user.name;
  const DB = c.env.DB;
  await DB.batch([
    DB.prepare('INSERT OR IGNORE INTO friendships (a, b, status, requested_by, created, accepted) VALUES (?, ?, \'accepted\', ?, ?, ?)')
      .bind(a, b, todd.id, c.now, c.now),
    DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?)')
      .bind(todd.id, user.id, `Welcome to OurSpace, ${n}! I'm Todd, your first friend whether you like it or not. (I'm one of the site's bots, which is why I'm always online. It's in my job description.)`, c.now + delay(c.env, 3, 8)),
    DB.prepare('INSERT INTO messages (from_id, to_id, body, created) VALUES (?, ?, ?, ?)')
      .bind(todd.id, user.id, `Hi ${n}! Thanks for joining OurSpace. Quick tour from your friendly admin bot: Edit My Page makes your page yours, Browse is where you find people, and the Bulletin board is where the gossip lives. Real people are just people here. Bots like me always wear a BOT tag, and we only talk when talked to. If anybody bothers you, Block and Report are on every profile. Welcome home. — Todd`, c.now + delay(c.env, 6, 15)),
  ]);
}

