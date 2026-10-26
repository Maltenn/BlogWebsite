// Live events: how the features reach the Durable Object `Room` (src/live/room.js), one per room: 'ourspace' for
// #ourspace, 'c:<id>' for each group chat or DM. D1 owns the data; the room only carries events to the sockets that are
// connected (and knows who they are). Everything here is best effort: a message is stored before it is told, and a page
// whose socket failed polls the history instead, so a room that can't be reached never fails a write.

export const OURSPACE = 'ourspace';

const stub = (env, room) => env.ROOMS.get(env.ROOMS.idFromName(room === OURSPACE ? OURSPACE : 'c:' + room));

// Sends `event` (an object: { type, … }) to everyone connected to `room` but the users in `skip` (ids: blocks either way
// with whoever the event is about).
export async function tell(env, room, event, skip = []) {
  if (!env.ROOMS) return;
  try { await stub(env, room).broadcast(event, skip); } catch (e) { console.error('live: telling', room, 'failed:', (e && e.stack) || e); }
}

// Closes the sockets of these users in `room` (they left or were removed), with close code 4003.
export async function kick(env, room, userIds) {
  if (!env.ROOMS || !userIds.length) return;
  try { await stub(env, room).kick(userIds); } catch (e) { console.error('live: kick in', room, 'failed:', (e && e.stack) || e); }
}

// The rooms a member may have open: #ourspace and the conversations they have joined (the most recently active 500:
// a room past those still closes a dead session's sockets the next time it carries an event, src/live/room.js)
export async function roomsOf(env, userId) {
  const { results } = await env.DB.prepare(`SELECT cm.conversation_id AS id FROM conversation_members cm JOIN conversations v ON v.id = cm.conversation_id
    WHERE cm.user_id = ? AND cm.status = 'joined' ORDER BY COALESCE(v.last_message_at, v.created) DESC LIMIT 500`).bind(userId).all();
  return [OURSPACE, ...results.map(r => r.id)];
}

// A member's session ended (logged out, password changed or reset, banned, account deleted): their sockets in every
// room they may have open close with code 4001, and the page stops reconnecting. `only`: that session's sockets
// (a token hash); `except`: all but that session's; `rooms`: when the memberships are about to go, read them first.
export async function signOut(env, userId, { only = null, except = null, rooms = null } = {}) {
  if (!env.ROOMS) return;
  try {
    const list = rooms || await roomsOf(env, userId);
    await Promise.all(list.map(room => stub(env, room).signOut(userId, { only, except })
      .catch(e => console.error('live: sign-out in', room, 'failed:', (e && e.stack) || e))));
  } catch (e) { console.error('live: sign-out failed:', (e && e.stack) || e); }
}

// A block between a and b was made (`on`) or lifted (no block left either way): the rooms both may have open (#ourspace
// and the groups they share) update their sockets at once, for typing and presence.
export async function setApart(env, a, b, on) {
  if (!env.ROOMS) return;
  try {
    const { results } = await env.DB.prepare(`SELECT x.conversation_id AS id FROM conversation_members x
      JOIN conversation_members y ON y.conversation_id = x.conversation_id AND y.user_id = ?2 AND y.status = 'joined'
      WHERE x.user_id = ?1 AND x.status = 'joined' LIMIT 500`).bind(a, b).all();
    await Promise.all([OURSPACE, ...results.map(r => r.id)].map(room => stub(env, room).setApart(a, b, on)
      .catch(e => console.error('live: block in', room, 'failed:', (e && e.stack) || e))));
  } catch (e) { console.error('live: block failed:', (e && e.stack) || e); }
}

// Who is connected to `room` right now: [{ id, name, avatar }], each once ([] if the room can't be reached).
export async function online(env, room) {
  if (!env.ROOMS) return [];
  try { return await stub(env, room).online(); } catch (e) { console.error('live: who is in', room, 'failed:', (e && e.stack) || e); return []; }
}

// Hands a WebSocket upgrade request to the room. `who` ({ id, name, avatar, blocks: [user ids blocked either way], sid:
// the session's token hash, exp: when the session runs out }) is kept with the socket (Hibernation API attachment), so
// the room can name people, keep blocked ones apart and close the socket once its session is over.
export function connect(env, room, request, who) {
  const headers = new Headers(request.headers);
  headers.set('X-Live-User', JSON.stringify(who));
  return stub(env, room).fetch(request.url, { headers });
}
