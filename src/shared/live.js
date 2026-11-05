// Live events: how the features reach the Durable Object `Room` (src/live/room.js), one per room: 'ourspace' for
// #ourspace, 'c:<id>' for each group chat or DM. D1 owns the data; the room only carries events to the sockets that are
// connected (and knows who they are). Everything here is best effort: a message is stored before it is told, and a page
// whose socket failed polls the history instead, so a room that can't be reached never fails a write.

import { sha256Hex } from './http.js';
import { randomToken } from './seal.js';
import { ticketProtocol } from './app.js';

export const OURSPACE = 'ourspace';

/* ------------------------------------------------- the pass a cookieless client opens a socket with

A browser WebSocket can set no headers, so the apps have to put their credential in the subprotocol — and a handshake
publishes the subprotocol it selects on the live socket as `socket.protocol`. That is why it is a ticket and not the
session token (docs/mobile/redteam.md R8, docs/mobile/contract.md §7, migrations/0013_live_tickets.sql): hashed at rest,
single use, one room, half a minute. */

// A ticket's life. The only thing between POST /api/live/ticket and the handshake it is for is one more round trip from
// the same page, so this is already generous; it is this short because the window is all an attacker who reads the
// ticket gets, and all they can do in it is open a socket to a room they are in already.
export const TICKET_MS = 30000;

// Mints one for `room` ('ourspace' or a conversation id), for the session this request is on. The caller has already
// checked that this member may open that room (src/chats/live.js). → the raw ticket, which is never stored.
export async function mintTicket(c, room) {
  const ticket = randomToken();
  await c.env.DB.prepare('INSERT INTO live_tickets (ticket_hash, room, user_id, token_hash, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(ticket), String(room), c.user.id, c.user.tokenHash, c.now, c.now + TICKET_MS).run();
  return { ticket, expires: c.now + TICKET_MS };
}

// The one address a ticket is a credential at. Everything else — every other route, /media/*, the ticket route itself —
// takes a session and nothing else, so a stolen ticket is worth one room's socket and NOT one request as its owner.
// (Without this, any route at all would accept it from a request that simply added an `Upgrade: websocket` header.)
const SOCKET_PATH = '/api/live/';

// The ticket this upgrade offers, spent: → { room, user_id, token_hash } or null. Single use whatever happens next —
// the row is DELETEd and only the request that removed it may go on, so a replay, or whoever read the ticket off
// `socket.protocol` racing the page that minted it, finds nothing. An expired one is consumed and refused.
// `room` is not checked here: the caller compares it with the room actually asked for (src/chats/live.js).
export async function claimTicket(c) {
  if (!c.url.pathname.startsWith(SOCKET_PATH)) return null;
  const raw = ticketProtocol(c.req);
  if (!raw || raw.length > 100) return null;
  const hash = await sha256Hex(raw);
  const row = await c.env.DB.prepare('SELECT room, user_id, token_hash, expires FROM live_tickets WHERE ticket_hash = ?').bind(hash).first();
  if (!row) return null;
  const claimed = (await c.env.DB.prepare('DELETE FROM live_tickets WHERE ticket_hash = ?').bind(hash).run()).meta.changes === 1;
  return claimed && row.expires > c.now ? row : null;
}

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
