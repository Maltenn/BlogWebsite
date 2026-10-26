// What every chat message shares, in #ourspace, group chats and DMs: its shape, which ones a reader may see, the people
// a reader has a block with (left out of what they see, and of what the room sends them), and deleting one.
import { fail, json, int } from '../shared/http.js';
import { REF_COLS, ref, NOT_BLOCKED } from '../shared/db.js';
import { mentionsIn } from '../shared/text.js';
import { tell, OURSPACE } from '../shared/live.js';

export const BODY_MAX = 2000;
export const PER = 50;                         // messages a page
export const AFTER_MAX = 100;                  // messages per catch-up (?after=)

// SELECT MSG_COLS FROM MSG_FROM: the message `m` and its writer `a`
export const MSG_COLS = `m.id, m.conversation_id, m.room, m.body, m.created, ${REF_COLS('a', 'a_')}`;
export const MSG_FROM = 'chat_messages m JOIN users a ON a.id = m.author_id';

// SQL: message `m` (by `a`) shows to the reader ?1: not deleted, not taken down, its writer not banned, no block between
// them either way
export const MSG_SHOWN = `m.hidden = 0 AND m.deleted = 0 AND a.banned = 0 AND ${NOT_BLOCKED('m.author_id')}`;

// a message as every answer and every live event has it (`mine` is added for the reader in answers, not in events)
export const msgOut = r => ({
  id: r.id, chatId: r.conversation_id ?? null, room: r.room ?? null, body: r.body, created: r.created, author: ref(r, 'a_'),
});

// The rows of a page of messages, asked for with ?before=<id> (older, default: the newest) or ?after=<id> (newer, for
// catching up after a reconnect or while polling), and the answer: { messages (oldest first), next }. `next` is the
// cursor for the same direction (before= the oldest shown, or after= the newest shown), or null when there's no more.
export async function messagePage(c, where, binds) {
  const before = int(c.url.searchParams.get('before'));
  const after = int(c.url.searchParams.get('after'));
  const me = c.user.id;
  const newer = after != null && before == null;
  const per = newer ? AFTER_MAX : PER;
  const { results } = await c.env.DB.prepare(`SELECT ${MSG_COLS} FROM ${MSG_FROM} WHERE ${where} AND ${MSG_SHOWN}
    AND m.id ${newer ? '>' : '<'} ?2 ORDER BY m.id ${newer ? 'ASC' : 'DESC'} LIMIT ${per + 1}`)
    .bind(me, newer ? after : (before ?? Number.MAX_SAFE_INTEGER), ...binds).all();
  const shown = results.slice(0, per);
  if (!newer) shown.reverse();
  const more = results.length > per;
  return {
    messages: shown.map(r => ({ ...msgOut(r), mine: r.a_id === me })),
    next: more && shown.length ? (newer ? shown[shown.length - 1].id : shown[0].id) : null,
  };
}

// the people the logged-in user has a block with, either way (user ids)
export async function blockedIds(c) {
  const { results } = await c.env.DB.prepare(
    'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?1 UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?1').bind(c.user.id).all();
  return results.map(r => r.id);
}

// The people a text @mentions: up to 10 who exist, aren't the writer or banned, and have no block with them either way
// (user ids, in order). Of the names a mention could be, the longest that exists counts.
export async function mentionedIds(c, s) {
  const found = mentionsIn(s);
  if (!found.length) return [];
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.name_key, (u.banned = 0 AND u.id != ?1 AND ${NOT_BLOCKED('u.id')}) AS ok
    FROM users u WHERE u.name_key IN (SELECT value FROM json_each(?2))`).bind(c.user.id, JSON.stringify(found.flat())).all();
  const byKey = new Map(results.map(u => [u.name_key, u]));
  const ids = [];
  for (const tries of found) {
    const u = tries.map(k => byKey.get(k)).find(Boolean);
    if (u && u.ok && !ids.includes(u.id)) ids.push(u.id);
  }
  return ids.slice(0, 10);
}

// DELETE /api/chat-messages/:id — your own message (in #ourspace, a group or a DM: its words are cleared), or, for a
// moderator, anybody's (taken down: kept as evidence, shown to nobody, logged). Everyone connected sees it go.
// → { ok }. 404 when it's gone, 403 when it isn't yours.
export async function deleteChatMessage(c) {
  const id = int(c.params.id, 0);
  const DB = c.env.DB;
  const m = await DB.prepare('SELECT id, author_id, conversation_id, room, hidden, deleted FROM chat_messages WHERE id = ?').bind(id).first();
  if (!m || m.deleted || (m.hidden && !c.user.is_admin)) fail(404, 'that message is gone.');
  if (m.author_id === c.user.id) {
    const r = await DB.prepare('UPDATE chat_messages SET deleted = 1, body = \'\' WHERE id = ? AND author_id = ? AND deleted = 0').bind(id, c.user.id).run();
    if (!r.meta.changes) fail(404, 'that message is gone.');
  } else if (c.user.is_admin) {
    await DB.batch([
      DB.prepare('UPDATE chat_messages SET hidden = 1 WHERE id = ?').bind(id),
      DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, \'hide\', \'message\', ?, \'\', ?)').bind(c.user.id, id, c.now),
    ]);
  } else fail(403, 'that\'s not your message.');
  await tell(c.env, m.room ? OURSPACE : m.conversation_id, { type: 'deleted', id });
  return json({ ok: true });
}
