// Group chats and DMs. D1 holds the conversations, who is in them and every message; sending is an HTTP write here,
// and then the room's Durable Object (src/live/room.js, through shared/live.js) tells whoever is connected. A DM is the
// one conversation between two people (dm_policy and blocks decide whether it may start, as for the old inbox). A group
// holds 2–50 people: friends join at once, anybody else gets an invite (a group_invite notification) and sees nothing
// until they accept. Between two members with a block, neither sees the other's messages (left out of every read and
// every broadcast). The suggestions for a new group come from the interaction score (shared/affinity.js).
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText, clip } from '../shared/text.js';
import { REF_COLS, ref, refOf, visibleUser, userByName, areFriends, blockedBy, blockedEither, limit, isOnline, NOT_BLOCKED } from '../shared/db.js';
import { CHAT_OPEN, CHAT_LISTED, UNREAD_IN, HANDOVER } from '../shared/chat.js';
import { ADD, DECAYED, CLOSENESS, W, GROUP_CAP } from '../shared/affinity.js';
import { tell, kick } from '../shared/live.js';
import { BODY_MAX, MSG_SHOWN, messagePage, blockedIds } from './messages.js';

export const MAX_MEMBERS = 50;
const TITLE_MAX = 60;
const DM_LIMITS = [[15, 60000], [400, 86400000]];          // messages, in DMs and groups together
const SUGGESTED = 30;
const DECLINED_GROUP_MS = 30 * 86400000;       // after a decline, that group can't invite them again for 30 days,
const DECLINED_INVITER_MS = 7 * 86400000;      // and whoever asked can't invite them into any group for 7

/* -------------------------------------------------------------- reading */

// My conversations (joined or invited, newest first, 200 at most), or just conversation `id`: the rows and their
// members, read in one batch.
async function loadChats(c, id = null) {
  const DB = c.env.DB;
  const one = id != null;
  const MINE = `WITH mine AS (
    SELECT v.id, v.kind, v.title, v.created, v.last_message_at, cm.status, cm.role, cm.last_read_id, cm.invited_by,
      (SELECT COUNT(*) FROM conversation_members k WHERE k.conversation_id = v.id AND k.status = 'joined') AS joined_count,
      (SELECT COUNT(*) FROM (${UNREAD_IN('cm')} LIMIT 99)) AS unread,
      (SELECT m.id FROM chat_messages m JOIN users a ON a.id = m.author_id WHERE m.conversation_id = v.id AND ${MSG_SHOWN}
        ORDER BY m.id DESC LIMIT 1) AS last_id
    FROM conversation_members cm JOIN conversations v ON v.id = cm.conversation_id
    WHERE cm.user_id = ?1 AND cm.status IN ('joined', 'invited') AND ${CHAT_OPEN} AND ${one ? 'v.id = ?2' : CHAT_LISTED}
    ORDER BY COALESCE(v.last_message_at, v.created) DESC, v.id DESC LIMIT 200)`;
  const binds = one ? [c.user.id, id] : [c.user.id];
  const [rows, people] = await DB.batch([
    DB.prepare(`${MINE} SELECT mine.*, ${REF_COLS('ib', 'ib_')}, m.body AS m_body, m.created AS m_created, ${REF_COLS('a', 'a_')}
      FROM mine LEFT JOIN users ib ON ib.id = mine.invited_by
      LEFT JOIN chat_messages m ON m.id = mine.last_id LEFT JOIN users a ON a.id = m.author_id
      ORDER BY COALESCE(mine.last_message_at, mine.created) DESC, mine.id DESC`).bind(...binds),
    DB.prepare(`${MINE} SELECT cm.conversation_id AS cid, cm.status, cm.role, cm.last_read_id, ${REF_COLS('x', '')}
      FROM mine JOIN conversation_members cm ON cm.conversation_id = mine.id JOIN users x ON x.id = cm.user_id
      WHERE mine.status = 'joined' AND cm.status IN ('joined', 'invited') AND x.banned = 0 AND ${NOT_BLOCKED('x.id')}
      ORDER BY cm.joined, x.id`).bind(...binds),
  ]);
  return { rows: rows.results, people: people.results };
}

// A conversation as every answer has it. An invite shows only its title, who invited me and how many are in it.
function chatOut(c, r, people) {
  const me = c.user.id;
  const joined = r.status === 'joined';
  const here = joined ? people.filter(p => p.cid === r.id && p.id !== me) : [];
  const owner = people.find(p => p.cid === r.id && p.role === 'owner' && p.status === 'joined');
  return {
    id: r.id, kind: r.kind, title: r.title || null, status: r.status, role: r.role, created: r.created,
    memberCount: r.joined_count,
    owner: joined && r.kind === 'group' && owner ? ref(owner) : null,
    members: here.filter(p => p.status === 'joined').map(p => ref(p)),
    invited: here.filter(p => p.status === 'invited').map(p => ref(p)),
    lastMessage: joined && r.last_id ? { id: r.last_id, body: clip(r.m_body, 140) ?? r.m_body, author: ref(r, 'a_'), created: r.m_created } : null,
    unread: joined ? r.unread : 0,
    invitedBy: r.status === 'invited' ? ref(r, 'ib_') : null,
  };
}

async function chatById(c, id) {
  const { rows, people } = await loadChats(c, id);
  if (!rows.length) fail(404, 'that chat isn\'t there.');
  return { row: rows[0], people, chat: chatOut(c, rows[0], people) };
}

// GET /api/chats — { items: [chat] }: my DMs and groups, newest first, and the group invites waiting for me
export async function chatList(c) {
  const { rows, people } = await loadChats(c);
  return json({ items: rows.map(r => chatOut(c, r, people)) });
}

// GET /api/chats/:id — { chat }
export async function oneChat(c) {
  return json({ chat: (await chatById(c, int(c.params.id, 0))).chat });
}

// May I write in this DM (null = yes, else why not)? As for the old inbox: no blocks, and their dm_policy.
async function dmProblem(c, otherId) {
  const u = otherId && await c.env.DB.prepare('SELECT id, name, dm_policy FROM users WHERE id = ?').bind(otherId).first();
  if (!u) return 'that account is gone.';
  if (await blockedBy(c.env, c.user.id, u.id)) return 'you blocked this person. unblock them to send a message.';
  if (await blockedEither(c.env, c.user.id, u.id)) return 'you can\'t message this person.';
  if (u.dm_policy === 'friends' && !await areFriends(c.env, c.user.id, u.id)) return `${u.name} only takes messages from friends.`;
  return null;
}

// GET /api/chats/:id/messages?before=&after= — { chat, messages, next, reads, canMessage, reason }: 50 a page, oldest
// first (before=<id>: older; after=<id>: newer, 100 at most, for catching up). reads: where the other members have read
// up to ([{ user, id }]). An invite is 403 until it's accepted.
export async function chatMessages(c) {
  const { row, people, chat } = await chatById(c, int(c.params.id, 0));
  if (row.status !== 'joined') fail(403, 'accept the invite first.');
  const page = await messagePage(c, 'm.conversation_id = ?3', [row.id]);
  const problem = row.kind === 'dm' ? await dmProblem(c, (people.find(p => p.cid === row.id && p.id !== c.user.id) || {}).id) : null;
  return json({
    chat, ...page,
    reads: people.filter(p => p.cid === row.id && p.id !== c.user.id && p.status === 'joined').map(p => ({ user: ref(p), id: p.last_read_id })),
    canMessage: !problem, reason: problem,
  });
}

/* -------------------------------------------------------------- writing */

// My membership of conversation `id` (with its kind, and for a DM the other person): 404 when I'm not in it (or it's a
// DM hidden by a block); `joined`: 403 while it's only an invite.
async function membership(c, id, joined = true) {
  const m = await c.env.DB.prepare(`SELECT v.id, v.kind, v.title, cm.status, cm.role,
      (SELECT o.user_id FROM conversation_members o WHERE o.conversation_id = v.id AND o.user_id != ?1 LIMIT 1) AS other
    FROM conversations v JOIN conversation_members cm ON cm.conversation_id = v.id AND cm.user_id = ?1
    WHERE v.id = ?2 AND ${CHAT_OPEN}`).bind(c.user.id, id).first();
  if (!m || m.status === 'left') fail(404, 'that chat isn\'t there.');
  if (joined && m.status !== 'joined') fail(403, 'accept the invite first.');
  return m;
}

function ownGroup(m) {
  if (m.kind !== 'group') fail(400, 'that\'s a DM, not a group.');
  if (m.role !== 'owner') fail(403, 'only the group\'s owner can do that.');
}

// SQL: member ?1 is still the owner of group ?3 (for every owner's write: ownership can move in the meantime)
const STILL_OWNER = 'EXISTS (SELECT 1 FROM conversation_members so WHERE so.conversation_id = ?3 AND so.user_id = ?1 AND so.role = \'owner\' AND so.status = \'joined\')';

// POST /api/chats/:id/messages { body } — up to 2,000 characters (links removed) → 201 { message }. Everyone connected
// hears it, except members with a block with me.
export async function sendChatMessage(c) {
  const id = int(c.params.id, 0);
  const b = await readBody(c.req);
  const body = longText(b.body, BODY_MAX);
  if (!body) fail(400, 'type a message first.');
  const m = await membership(c, id);
  if (m.kind === 'dm') {
    const problem = await dmProblem(c, m.other);
    if (problem) fail(403, problem);
  }
  await limit(c, 'dm:' + c.user.id, DM_LIMITS);
  const DB = c.env.DB;
  // the write happens only while I'm still a member (and, in a DM, no block came between us)
  const still = `EXISTS (SELECT 1 FROM conversation_members s WHERE s.conversation_id = ?3 AND s.user_id = ?1 AND s.status = 'joined')
    ${m.kind === 'dm' ? `AND NOT EXISTS (SELECT 1 FROM conversation_members o WHERE o.conversation_id = ?3 AND o.user_id != ?1 AND NOT ${NOT_BLOCKED('o.user_id')})` : ''}`;
  const small = m.kind === 'dm' ? '1' : `(SELECT COUNT(*) FROM conversation_members g WHERE g.conversation_id = ?3 AND g.status = 'joined') <= ${GROUP_CAP}`;
  const [made] = await DB.batch([
    DB.prepare(`INSERT INTO chat_messages (conversation_id, author_id, body, created) SELECT ?3, ?1, ?4, ?2 WHERE ${still} RETURNING id`)
      .bind(c.user.id, c.now, id, body),
    DB.prepare(`UPDATE conversations SET last_message_at = ?2 WHERE id = ?3 AND ${still}`).bind(c.user.id, c.now, id),
    // my own message is read
    DB.prepare(`UPDATE conversation_members SET last_read_id = (SELECT MAX(id) FROM chat_messages WHERE conversation_id = ?3 AND author_id = ?1)
      WHERE conversation_id = ?3 AND user_id = ?1 AND ${still}`).bind(c.user.id, c.now, id),
    // the interaction score toward the other members: a DM's 2, a group's 0.5 each (only in groups of 8 or fewer)
    DB.prepare(ADD(`SELECT ?1, k.user_id, ?4, ?2 FROM conversation_members k WHERE k.conversation_id = ?3 AND k.status = 'joined'
      AND k.user_id != ?1 AND ${NOT_BLOCKED('k.user_id')} AND ${small} AND ${still}`)).bind(c.user.id, c.now, id, m.kind === 'dm' ? W.dm : W.group),
  ]);
  if (!made.results.length) fail(404, 'that chat isn\'t there.');
  const message = { id: made.results[0].id, chatId: id, room: null, body, created: c.now, author: refOf(c.user) };
  await tell(c.env, id, { type: 'message', message }, await blockedIds(c));
  return json({ message: { ...message, mine: true } }, 201);
}

// PUT /api/chats/:id/read { id } — I've read up to message `id` (forward only, never past the newest) → { ok, lastReadId }.
// The others connected see { type: 'read' }.
export async function readChat(c) {
  const id = int(c.params.id, 0);
  const b = await readBody(c.req);
  const upto = int(b.id, 0);
  await membership(c, id);
  await limit(c, 'chatread:' + c.user.id, [[120, 60000]]);
  const top = `MIN(?3, (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE conversation_id = ?2))`;
  const r = await c.env.DB.prepare(`UPDATE conversation_members SET last_read_id = ${top}
    WHERE conversation_id = ?2 AND user_id = ?1 AND status = 'joined' AND last_read_id < ${top} RETURNING last_read_id`).bind(c.user.id, id, upto).first();
  if (r) await tell(c.env, id, { type: 'read', user: refOf(c.user), id: r.last_read_id }, await blockedIds(c));
  const now = r || await c.env.DB.prepare('SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(id, c.user.id).first();
  return json({ ok: true, lastReadId: now ? now.last_read_id : 0 });
}

// The people named for a group (screen names, any case; me left out), checked: each must exist and not be banned, have
// no block with me either way, and, unless we're friends (who join at once), take messages from everyone (an invite
// is a message). One read for all of them. → [{ id, name, avatar, friend }]
async function resolvePeople(c, names) {
  if (!Array.isArray(names)) fail(400, 'pick some people.');
  const mine = c.user.name.toLowerCase();
  const keys = [...new Set(names.map(n => String(n ?? '').trim().toLowerCase()).filter(k => k && k !== mine))];
  if (keys.length >= MAX_MEMBERS) fail(400, `a group holds ${MAX_MEMBERS} people at most.`);
  if (!keys.length) return [];
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.name, u.name_key, u.avatar, u.banned, u.held, u.dm_policy,
      EXISTS (SELECT 1 FROM blocks WHERE blocker_id = u.id AND blocked_id = ?1) AS blocks_me,
      EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = u.id) AS blocked,
      (SELECT COUNT(*) FROM follows f WHERE ((f.follower_id = ?1 AND f.followee_id = u.id) OR (f.follower_id = u.id AND f.followee_id = ?1))
        AND f.status = 'accepted') = 2 AS friend
    FROM users u WHERE u.name_key IN (SELECT value FROM json_each(?2))`).bind(c.user.id, JSON.stringify(keys)).all();
  const byKey = new Map(results.map(u => [u.name_key, u]));
  return keys.map(k => {
    const u = byKey.get(k);
    if (!u || u.banned || u.held || u.blocks_me) fail(404, `nobody called "${k}" lives here.`);
    if (u.blocked) fail(403, `you blocked ${u.name}. unblock them first.`);
    if (!u.friend && u.dm_policy === 'friends') fail(403, `${u.name} only takes messages from friends.`);
    return { id: u.id, name: u.name, avatar: u.avatar, friend: !!u.friend };
  });
}

const groupFull = e => {
  if (/group full/.test(String(e && e.message))) fail(409, `a group holds ${MAX_MEMBERS} people at most.`);
  throw e;
};

// SQL: tell each person in the JSON list ?4 (user ids) that ?1 invited them into conversation `conv` (SQL), at ?2
const INVITE_NOTES = conv => `INSERT INTO notifications (user_id, kind, actor_id, conversation_id, created)
  SELECT t.value, 'group_invite', ?1, ${conv}, ?2 FROM json_each(?4) t WHERE ${NOT_BLOCKED('t.value')}`;

// Refuses invites to people who said no lately: to this group (`groupId`, null for a new one) in the last 30 days, or
// to any group of mine in the last 7. `ids`: the people to be invited (not friends, who join at once).
async function declinedLately(c, ids, groupId) {
  if (!ids.length) return;
  const r = await c.env.DB.prepare(`SELECT u.name FROM conversation_members d JOIN users u ON u.id = d.user_id
    WHERE d.user_id IN (SELECT value FROM json_each(?2)) AND d.status = 'left' AND d.declined IS NOT NULL
      AND ((d.conversation_id = ?3 AND d.declined > ?4 - ${DECLINED_GROUP_MS}) OR (d.invited_by = ?1 AND d.declined > ?4 - ${DECLINED_INVITER_MS}))
    LIMIT 1`).bind(c.user.id, JSON.stringify(ids), groupId ?? 0, c.now).first();
  if (r) fail(403, `${r.name} said no to an invite lately. give them some time before asking again.`);
}

// POST /api/chats { dm: name } → the DM with that person (made if there's none yet: 201; else 200) → { chat }
// POST /api/chats { members: [names], title? } → a new group with me as its owner → 201 { chat }. Friends join at once;
// anybody else is invited. Groups: 10 a day; invites: 30 an hour.
export async function createChat(c) {
  const b = await readBody(c.req);
  const DB = c.env.DB;
  const me = c.user.id;
  if (b.dm != null) {
    const u = await visibleUser(c, b.dm);
    if (u.id === me) fail(400, 'talking to yourself is free. no message needed.');
    const key = `${Math.min(me, u.id)}:${Math.max(me, u.id)}`;
    const had = await DB.prepare('SELECT id FROM conversations WHERE dm_key = ?').bind(key).first();
    if (had) {
      if (await blockedBy(c.env, me, u.id)) fail(403, 'you blocked this person. unblock them to send a message.');
      return json({ chat: (await chatById(c, had.id)).chat });
    }
    const problem = await dmProblem(c, u.id);
    if (problem) fail(403, problem);
    await limit(c, 'dmopen:' + me, [[30, 3600000]], 'that\'s a lot of new conversations. try again in a bit.');
    const [, , got] = await DB.batch([
      DB.prepare('INSERT INTO conversations (kind, created_by, created, dm_key) VALUES (\'dm\', ?1, ?2, ?3) ON CONFLICT (dm_key) DO NOTHING').bind(me, c.now, key),
      DB.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, status, joined)
        SELECT v.id, t.value, 'member', 'joined', ?2 FROM conversations v, json_each(?4) t WHERE v.dm_key = ?3`).bind(me, c.now, key, JSON.stringify([me, u.id])),
      DB.prepare('SELECT id FROM conversations WHERE dm_key = ?').bind(key),
    ]);
    return json({ chat: (await chatById(c, got.results[0].id)).chat }, 201);
  }

  const people = await resolvePeople(c, b.members);
  if (!people.length) fail(400, 'a group needs at least one other person.');
  if (people.length + 1 > MAX_MEMBERS) fail(400, `a group holds ${MAX_MEMBERS} people at most.`);
  const title = text(b.title, TITLE_MAX) || null;
  await limit(c, 'group:' + me, [[10, 86400000]], 'that\'s a lot of new groups for one day.');
  const invites = people.filter(p => !p.friend).map(p => p.id);
  await declinedLately(c, invites, null);
  if (invites.length) await limit(c, 'invite:' + me, [[30, 3600000]], 'that\'s a lot of invites. try again in a bit.', invites.length);
  const NEW = '(SELECT MAX(id) FROM conversations WHERE created_by = ?1 AND kind = \'group\' AND created = ?2)';
  const res = await DB.batch([
    DB.prepare('INSERT INTO conversations (kind, title, created_by, created) VALUES (\'group\', ?3, ?1, ?2)').bind(me, c.now, title),
    DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, status, joined) VALUES (${NEW}, ?1, 'owner', 'joined', ?2)`).bind(me, c.now),
    DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, status, invited_by, joined)
      SELECT ${NEW}, json_extract(t.value, '$[0]'), 'member', CASE WHEN json_extract(t.value, '$[1]') THEN 'joined' ELSE 'invited' END, ?1, ?2
      FROM json_each(?3) t WHERE 1`).bind(me, c.now, JSON.stringify(people.map(p => [p.id, p.friend ? 1 : 0]))),
    invites.length && DB.prepare(INVITE_NOTES(NEW)).bind(me, c.now, null, JSON.stringify(invites)),
    DB.prepare(`SELECT ${NEW} AS id`).bind(me, c.now),
  ].filter(Boolean)).catch(groupFull);
  return json({ chat: (await chatById(c, res.at(-1).results[0].id)).chat }, 201);
}

// POST /api/chats/:id/members { names } — the owner adds people: friends join at once, anybody else is invited. People
// already in it (or invited) are left as they are. → { chat }
export async function addMembers(c) {
  const id = int(c.params.id, 0);
  const b = await readBody(c.req);
  const m = await membership(c, id);
  ownGroup(m);
  const DB = c.env.DB;
  const people = await resolvePeople(c, b.names);
  const { results: there } = await DB.prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ? AND status != 'left'`).bind(id).all();
  const fresh = people.filter(p => !there.some(t => t.user_id === p.id));
  if (!fresh.length) fail(400, people.length ? 'they\'re all in it already.' : 'pick someone to add.');
  if (there.length + fresh.length > MAX_MEMBERS) fail(409, `a group holds ${MAX_MEMBERS} people at most.`);
  const invites = fresh.filter(p => !p.friend).map(p => p.id);
  await declinedLately(c, invites, id);
  if (invites.length) await limit(c, 'invite:' + c.user.id, [[30, 3600000]], 'that\'s a lot of invites. try again in a bit.', invites.length);
  await DB.batch([
    // (someone who left comes back; newcomers start with everything so far read)
    DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, status, invited_by, joined, last_read_id)
      SELECT ?3, json_extract(t.value, '$[0]'), 'member', CASE WHEN json_extract(t.value, '$[1]') THEN 'joined' ELSE 'invited' END, ?1, ?2,
        (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE conversation_id = ?3)
      FROM json_each(?4) t WHERE ${STILL_OWNER}
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = excluded.status, role = 'member', invited_by = excluded.invited_by,
        joined = excluded.joined, last_read_id = MAX(conversation_members.last_read_id, excluded.last_read_id), declined = NULL
      WHERE conversation_members.status = 'left'`).bind(c.user.id, c.now, id, JSON.stringify(fresh.map(p => [p.id, p.friend ? 1 : 0]))),
    // one group_invite notification per person and group: an earlier one goes when a new invite takes its place
    invites.length && DB.prepare(`DELETE FROM notifications WHERE kind = 'group_invite' AND conversation_id = ?3
      AND user_id IN (SELECT value FROM json_each(?4)) AND EXISTS (SELECT 1 FROM conversation_members i WHERE i.conversation_id = ?3
      AND i.user_id = notifications.user_id AND i.status = 'invited' AND i.invited_by = ?1 AND i.joined = ?2)`).bind(c.user.id, c.now, id, JSON.stringify(invites)),
    invites.length && DB.prepare(`${INVITE_NOTES('?3')} AND EXISTS (SELECT 1 FROM conversation_members i WHERE i.conversation_id = ?3
      AND i.user_id = t.value AND i.status = 'invited' AND i.invited_by = ?1 AND i.joined = ?2)`).bind(c.user.id, c.now, id, JSON.stringify(invites)),
  ].filter(Boolean)).catch(groupFull);
  await tell(c.env, id, { type: 'changed' });
  return json({ chat: (await chatById(c, id)).chat });
}

// DELETE /api/chats/:id/members/:name — the owner removes someone (a member or an invite) → { chat }. Their socket closes.
export async function removeMember(c) {
  const id = int(c.params.id, 0);
  const m = await membership(c, id);
  ownGroup(m);
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'they aren\'t in this group.');
  if (u.id === c.user.id) fail(400, 'to go, leave the group instead.');
  const r = await c.env.DB.prepare(`UPDATE conversation_members SET status = 'left', role = 'member'
    WHERE conversation_id = ?3 AND user_id = ?2 AND status != 'left' AND ${STILL_OWNER}`).bind(c.user.id, u.id, id).run();
  if (!r.meta.changes) fail(404, 'they aren\'t in this group.');
  await kick(c.env, id, [u.id]);
  await tell(c.env, id, { type: 'changed' });
  return json({ chat: (await chatById(c, id)).chat });
}

// POST /api/chats/:id/leave — leave a group → { ok }. If I owned it, the member who has been in it longest takes over.
export async function leaveChat(c) {
  const id = int(c.params.id, 0);
  const m = await membership(c, id);
  if (m.kind !== 'group') fail(400, 'a DM can\'t be left. block the person if you need to.');
  const DB = c.env.DB;
  const [, gone] = await DB.batch([
    DB.prepare(HANDOVER('o.conversation_id = ?2')).bind(c.user.id, id),
    DB.prepare('UPDATE conversation_members SET status = \'left\', role = \'member\' WHERE conversation_id = ?2 AND user_id = ?1 AND status = \'joined\'').bind(c.user.id, id),
  ]);
  if (!gone.meta.changes) fail(404, 'that chat isn\'t there.');
  await kick(c.env, id, [c.user.id]);
  await tell(c.env, id, { type: 'changed' });
  return json({ ok: true });
}

// POST /api/chats/:id/invite { action: accept | decline } — answer an invite. accept → { chat }; decline → { ok }. After a
// decline this group can't invite them again for 30 days, nor the person who asked into any group for 7.
export async function answerInvite(c) {
  const id = int(c.params.id, 0);
  const b = await readBody(c.req);
  const action = b.action ?? (b.accept === true ? 'accept' : b.accept === false ? 'decline' : null);
  if (action !== 'accept' && action !== 'decline') fail(400, 'accept or decline?');
  const m = await membership(c, id, false);
  if (m.status !== 'invited') fail(409, 'you\'re already in it.');
  const r = await c.env.DB.prepare(action === 'accept'
    ? `UPDATE conversation_members SET status = 'joined', joined = ?3, last_read_id = (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE conversation_id = ?1)
       WHERE conversation_id = ?1 AND user_id = ?2 AND status = 'invited'`
    : 'UPDATE conversation_members SET status = \'left\', declined = ?3 WHERE conversation_id = ?1 AND user_id = ?2 AND status = \'invited\'')
    .bind(id, c.user.id, c.now).run().catch(groupFull);
  if (!r.meta.changes) fail(409, 'that invite was already answered.');
  await tell(c.env, id, { type: 'changed' });
  return json(action === 'accept' ? { chat: (await chatById(c, id)).chat } : { ok: true });
}

// PUT /api/chats/:id { title } — the owner renames a group (empty: no title) → { chat }
export async function renameChat(c) {
  const id = int(c.params.id, 0);
  const b = await readBody(c.req);
  const m = await membership(c, id);
  ownGroup(m);
  const title = text(b.title, TITLE_MAX) || null;
  await c.env.DB.prepare(`UPDATE conversations SET title = ?2 WHERE id = ?3 AND ${STILL_OWNER}`).bind(c.user.id, title, id).run();
  await tell(c.env, id, { type: 'changed' });
  return json({ chat: (await chatById(c, id)).chat });
}

/* ---------------------------------------------------------- suggestions */

// GET /api/chats/suggestions?q= — who to put in a new group: { people: [{ id, name, avatar, friend, online }] }. My
// friends first, closest first (the interaction score's closeness, then whoever we interacted with last, then name);
// then people I've interacted with who aren't friends yet (closeness above 0, taking messages from everyone). Nobody
// banned or with a block either way. 30 at most; q keeps the names that contain it.
export async function chatSuggestions(c) {
  const q = String(c.url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 20);
  const { results } = await c.env.DB.prepare(`
    WITH fr AS (SELECT f.followee_id AS id FROM follows f JOIN follows g ON g.follower_id = f.followee_id AND g.followee_id = ?1 AND g.status = 'accepted'
                WHERE f.follower_id = ?1 AND f.status = 'accepted'),
      given AS (SELECT to_id AS id, ${DECAYED('eff', 'updated', '?2')} AS eff, updated FROM affinity WHERE from_id = ?1),
      cand AS (SELECT id FROM fr UNION SELECT id FROM given),
      scored AS (
        SELECT ${REF_COLS('u', '')}, u.last_seen, u.dm_policy, u.name_key, cand.id IN (SELECT id FROM fr) AS friend,
          ${CLOSENESS('COALESCE(o.eff, 0)', `COALESCE(${DECAYED('y.eff', 'y.updated', '?2')}, 0)`)} AS closeness,
          MAX(COALESCE(o.updated, 0), COALESCE(y.updated, 0)) AS recent
        FROM cand JOIN users u ON u.id = cand.id LEFT JOIN given o ON o.id = u.id LEFT JOIN affinity y ON y.from_id = u.id AND y.to_id = ?1
        WHERE u.id != ?1 AND u.banned = 0 AND u.held = 0 AND ${NOT_BLOCKED('u.id')} AND (?3 = '' OR instr(u.name_key, ?3) > 0))
    SELECT * FROM scored WHERE friend OR (closeness > 0 AND dm_policy = 'everyone')
    ORDER BY friend DESC, closeness DESC, recent DESC, name_key LIMIT ${SUGGESTED}`).bind(c.user.id, c.now, q).all();
  return json({ people: results.map(r => ({ ...ref(r), friend: !!r.friend, online: isOnline(r, c.now) })) });
}
