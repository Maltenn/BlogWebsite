// Private messages between two people (or a person and a bot).
import { fail, json, readBody } from './http.js';
import { longText } from './text.js';
import { REF_COLS, ref, refOf, visibleUser, areFriends, blockedEither, blockedBy, limit } from './db.js';
import { botAnswersMessage } from './bots.js';

// GET /api/inbox — one row per conversation, newest first
export async function inbox(c) {
  const me = c.user.id;
  const { results } = await c.env.DB.prepare(`
    WITH m AS (
      SELECT id, from_id, body, created, read_at, CASE WHEN from_id = ?1 THEN to_id ELSE from_id END AS other,
             ROW_NUMBER() OVER (PARTITION BY CASE WHEN from_id = ?1 THEN to_id ELSE from_id END ORDER BY created DESC, id DESC) AS rn
      FROM messages WHERE (from_id = ?1 OR to_id = ?1) AND hidden = 0 AND created <= ?2
    )
    SELECT m.other, m.body, m.created, m.from_id,
           (SELECT COUNT(*) FROM m AS u WHERE u.other = m.other AND u.from_id != ?1 AND u.read_at IS NULL) AS unread,
           ${REF_COLS('x', 'x_')}
    FROM m JOIN users x ON x.id = m.other
    WHERE m.rn = 1 AND x.banned = 0
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ?1 AND bl.blocked_id = x.id) OR (bl.blocked_id = ?1 AND bl.blocker_id = x.id))
    ORDER BY m.created DESC LIMIT 100`).bind(me, c.now).all();
  return json({
    threads: results.map(r => ({
      with: ref(r, 'x_'), last: { body: r.body.slice(0, 140), created: r.created, mine: r.from_id === me }, unread: r.unread,
    })),
  });
}

// can I message this person right now? (null = yes, else the reason)
async function messageProblem(c, u) {
  if (u.id === c.user.id) return 'talking to yourself is free. no message needed.';
  if (await blockedBy(c.env, c.user.id, u.id)) return 'you blocked this person. unblock them to send a message.';
  if (await blockedEither(c.env, c.user.id, u.id)) return 'you can\'t message this person.';
  if (u.dm_policy === 'friends' && !await areFriends(c.env, c.user.id, u.id)) return `${u.name} only takes messages from friends.`;
  return null;
}

// GET /api/inbox/:name — the conversation with one person (marks their messages read)
export async function thread(c) {
  const u = await visibleUser(c, c.params.name);
  const me = c.user.id;
  if (u.id === me) fail(400, 'that\'s you!');
  const { results } = await c.env.DB.prepare(`
    SELECT id, from_id, body, created FROM messages
    WHERE ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)) AND hidden = 0 AND created <= ?3
    ORDER BY created DESC, id DESC LIMIT 200`).bind(me, u.id, c.now).all();
  await c.env.DB.prepare('UPDATE messages SET read_at = ?3 WHERE from_id = ?2 AND to_id = ?1 AND read_at IS NULL AND created <= ?3')
    .bind(me, u.id, c.now).run();
  // a bot reply that is still "being typed" — the page shows "… is typing" until it lands
  const pending = u.is_bot ? await c.env.DB.prepare('SELECT MIN(created) AS at FROM messages WHERE from_id = ? AND to_id = ? AND created > ?')
    .bind(u.id, me, c.now).first() : null;
  const problem = await messageProblem(c, u);
  return json({
    with: refOf(u),
    messages: results.reverse().map(m => ({ id: m.id, mine: m.from_id === me, body: m.body, created: m.created })),
    canMessage: !problem, reason: problem,
    typingUntil: pending && pending.at ? pending.at : null,
  });
}

// POST /api/inbox/:name { body }
export async function sendMessage(c) {
  const u = await visibleUser(c, c.params.name);
  const b = await readBody(c.req);
  const body = longText(b.body, 1000);
  if (!body) fail(400, 'type a message first.');
  const problem = await messageProblem(c, u);
  if (problem) fail(403, problem);
  await limit(c, 'dm:' + c.user.id, [[15, 60000], [400, 86400000]]);
  const row = await c.env.DB.prepare('INSERT INTO messages (from_id, to_id, body, created) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(c.user.id, u.id, body, c.now).first();
  if (u.is_bot) await botAnswersMessage(c, u, body);
  return json({ id: row.id, body, created: c.now }, 201);
}
