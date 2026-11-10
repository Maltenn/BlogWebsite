// #ourspace: the one chat room every member can read and write, like a Discord channel. Rolling scrollback: only the
// newest 500 messages from the last 24 hours show, and the cron deletes the rest (reported ones stay as evidence). Slow
// mode: one message every 3 seconds, 20 a minute. Links are removed as in posts, and @mentions notify. Moderators delete
// messages and mute members (1 hour, 24 hours or 7 days).
import { fail, json, readBody } from '../shared/http.js';
import { text, longText } from '../shared/text.js';
import { refOf, userByName, limit, NOT_BLOCKED } from '../shared/db.js';
import { bump, W, DECAYED, HALF_LIFE, PRUNE_BELOW } from '../shared/affinity.js';
import { tell, online, OURSPACE } from '../shared/live.js';
import { BODY_MAX, messagePage, blockedIds, mentionedIds } from './messages.js';

export const KEEP = 500;                       // messages
export const KEEP_MS = 24 * 3600000;
export const SLOW = { seconds: 3, perMinute: 20 };
const MUTE_HOURS = [1, 24, 168];

// SQL: message `m` is inside the rolling window at ?2 (now): from the last 24 hours, and among the newest 500
const WINDOW = `m.room = 'ourspace' AND m.created > ?2 - ${KEEP_MS}
  AND m.id >= COALESCE((SELECT w.id FROM chat_messages w WHERE w.room = 'ourspace' ORDER BY w.id DESC LIMIT 1 OFFSET ${KEEP - 1}), 0)`;

async function mutedUntil(c) {
  const r = await c.env.DB.prepare('SELECT until FROM chat_mutes WHERE user_id = ? AND until > ?').bind(c.user.id, c.now).first();
  return r ? r.until : null;
}

// GET /api/ourspace/messages?before=&after= — { messages, next, online, mutedUntil, slowMode }: 50 a page, oldest first
// (before=<id>: older; after=<id>: newer, for catching up). online: who has the room open (minus people with a block,
// and anybody banned whose socket hasn't closed yet).
export async function ourspaceMessages(c) {
  const page = await messagePage(c, WINDOW.replaceAll('?2', '?3'), [c.now]);   // (?2 is the page's cursor there)
  const [blocked, here, muted] = await Promise.all([blockedIds(c), online(c.env, OURSPACE), mutedUntil(c)]);
  const { results: ok } = here.length ? await c.env.DB.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND banned = 0')
    .bind(JSON.stringify(here.map(p => p.id))).all() : { results: [] };
  const allowed = new Set(ok.map(r => r.id));
  return json({ ...page, online: here.filter(p => allowed.has(p.id) && !blocked.includes(p.id)), mutedUntil: muted, slowMode: SLOW });
}

// POST /api/ourspace/messages { body } — up to 2,000 characters → 201 { message }. 403 while muted, 429 in slow mode.
export async function postOurspace(c) {
  const b = await readBody(c.req);
  const body = longText(b.body, BODY_MAX);
  if (!body) fail(400, 'type a message first.');
  const muted = await mutedUntil(c);
  if (muted) fail(403, `a moderator muted you in #ourspace until ${new Date(muted).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  await limit(c, 'ourspace:' + c.user.id, [[1, SLOW.seconds * 1000], [SLOW.perMinute, 60000]],
    `slow mode: one message every ${SLOW.seconds} seconds (${SLOW.perMinute} a minute).`);
  const people = await mentionedIds(c, body);
  const DB = c.env.DB;
  const JUST = '(SELECT MAX(id) FROM chat_messages WHERE room = \'ourspace\' AND author_id = ?1 AND created = ?2)';
  const [made] = await DB.batch([
    DB.prepare('INSERT INTO chat_messages (room, author_id, body, created) VALUES (\'ourspace\', ?1, ?3, ?2) RETURNING id').bind(c.user.id, c.now, body),
    people.length && DB.prepare(`INSERT INTO notifications (user_id, kind, actor_id, message_id, created)
      SELECT t.value, 'chat_mention', ?1, ${JUST}, ?2 FROM json_each(?3) t WHERE ${NOT_BLOCKED('t.value')}`).bind(c.user.id, c.now, JSON.stringify(people)),
    bump(c, people.map(id => [id, W.mention])),
  ].filter(Boolean));
  const message = { id: made.results[0].id, chatId: null, room: OURSPACE, body, created: c.now, author: refOf(c.user) };
  await tell(c.env, OURSPACE, { type: 'message', message }, await blockedIds(c));
  return json({ message: { ...message, mine: true } }, 201);
}

// POST /api/admin/mutes { name, hours: 1 | 24 | 168 (0 lifts it), reason } — no writing in #ourspace until then →
// { ok, until } (logged)
export async function muteMember(c) {
  const b = await readBody(c.req);
  const u = await userByName(c.env, b.name);
  if (!u) fail(404, 'nobody by that name.');
  if (u.is_admin) fail(400, 'moderators can\'t be muted.');
  const hours = Number(b.hours);
  if (hours !== 0 && !MUTE_HOURS.includes(hours)) fail(400, 'mute for 1, 24 or 168 hours (or 0 to lift it).');
  const reason = text(b.reason, 300);
  const until = hours ? c.now + hours * 3600000 : null;
  const DB = c.env.DB;
  await DB.batch([
    hours
      ? DB.prepare(`INSERT INTO chat_mutes (user_id, until, muted_by, reason, created) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT (user_id) DO UPDATE SET until = excluded.until, muted_by = excluded.muted_by, reason = excluded.reason, created = excluded.created`)
        .bind(u.id, until, c.user.id, reason, c.now)
      : DB.prepare('DELETE FROM chat_mutes WHERE user_id = ?').bind(u.id),
    DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, ?, \'user\', ?, ?, ?)')
      .bind(c.user.id, hours ? 'mute' : 'unmute', u.id, hours ? `${hours}h${reason ? ': ' + reason : ''}` : reason, c.now),
  ]);
  return json({ ok: true, until });
}

// The cron's chat housekeeping: #ourspace down to its rolling window (reported messages stay), expired mutes, and
// interaction scores that have faded below 0.05.
export async function sweepChat(env, now) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chat_messages WHERE room = 'ourspace'
      AND (created <= ?1 - ${KEEP_MS} OR id < COALESCE((SELECT w.id FROM chat_messages w WHERE w.room = 'ourspace' ORDER BY w.id DESC LIMIT 1 OFFSET ${KEEP - 1}), 0))
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'message' AND r.target_id = chat_messages.id)`).bind(now),
    env.DB.prepare('DELETE FROM chat_mutes WHERE until <= ?').bind(now),
    env.DB.prepare(`DELETE FROM affinity WHERE updated < ?1 - ${HALF_LIFE} AND ${DECAYED('eff', 'updated', '?1')} < ${PRUNE_BELOW}`).bind(now),
  ]);
}
