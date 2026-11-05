// The chat rooms' WebSocket, and the pass a cookieless client needs to open one.
//
// GET /api/live/:room — the WebSocket for a room: `ourspace` (any member) or a chat id (its joined members). Everything
// is checked here, before the upgrade reaches the room's Durable Object: the session (the route is AUTH), the Origin
// (the router's cross-site check skips GETs, and a WebSocket handshake is a GET any site's page could start with our
// cookie, so it must come from our own pages), how often this member opens sockets, and the membership. The room then
// only carries events (src/live/room.js), and keeps each member to 5 sockets in it.
//
// POST /api/live/ticket — a pass for one room, because a browser WebSocket can set no headers. Our own pages don't need
// it (the cookie rides the handshake); the apps do, and what they used to put in the subprotocol instead was the raw
// session token, which the handshake echoed and the browser then published as `socket.protocol` — readable by any
// script in the page, which is exactly what keeping the token in the Keychain was for (docs/mobile/redteam.md R8,
// docs/mobile/contract.md §7). A ticket is hashed at rest, single use, worth one room and 30 seconds
// (migrations/0013_live_tickets.sql, src/shared/live.js).
import { fail, int, json, readBody } from '../shared/http.js';
import { refOf, limit } from '../shared/db.js';
import { CHAT_OPEN } from '../shared/chat.js';
import { connect, mintTicket, OURSPACE, TICKET_MS } from '../shared/live.js';
import { blockedIds } from './messages.js';
import { hasSessionCookie } from '../shared/app.js';

const MAX_BLOCKS = 120;                        // carried with the socket (the attachment holds 2 KB; blocks made later are added to it)
const UPGRADES = [[30, 60000], [600, 86400000]];   // sockets opened per member (a page opens one per room it shows)
// Tickets minted per member. One socket needs one, so this is the budget above with room to spare: a socket that keeps
// failing asks again on every retry, and the retries are backed off (public/js/core/live.js) but the rooms are not — a
// page showing several asks for one each.
const TICKETS = [[90, 60000], [1800, 86400000]];

// The room this member may open, as the DO names it ('ourspace' or the conversation's id), or a 404. The same check for
// the pass and for the socket: a ticket is never minted for a room its holder could not open anyway.
async function roomFor(c, raw) {
  if (raw === OURSPACE) return OURSPACE;
  const id = int(raw, 0);
  const m = id > 0 && await c.env.DB.prepare(`SELECT 1 AS x FROM conversation_members cm JOIN conversations v ON v.id = cm.conversation_id
    WHERE cm.conversation_id = ?2 AND cm.user_id = ?1 AND cm.status = 'joined' AND ${CHAT_OPEN}`).bind(c.user.id, id).first();
  if (!m) fail(404, 'that chat isn\'t there.');
  return id;
}

// POST /api/live/ticket { room } → 200 { ticket, expires }. The ticket then travels as the subprotocol
// `ourspace.bearer.<ticket>` on the handshake for that one room, and is spent by it.
export async function liveTicket(c) {
  const b = await readBody(c.req);
  await limit(c, 'ticket:' + c.user.id, TICKETS, 'too many connections. wait a minute and reload.');
  const room = await roomFor(c, String(b.room ?? ''));
  const { ticket, expires } = await mintTicket(c, room);
  return json({ ticket, expires, ms: TICKET_MS });
}

export async function liveRoom(c) {
  if ((c.req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') fail(426, 'this address is for WebSockets.');
  // (an app has no page of ours to come from: the room ticket it offers as a subprotocol is the proof, and a hostile
  // page can't get one — minting it is a POST, which the router's cross-site check does cover. With a cookie in play
  // the Origin must still be ours.)
  if (!(c.viaBearer && !hasSessionCookie(c.req)) && c.req.headers.get('Origin') !== c.url.origin) fail(403, 'cross-site request refused');
  await limit(c, 'live:' + c.user.id, UPGRADES, 'too many connections. wait a minute and reload.');
  const room = await roomFor(c, c.params.room);
  // one room, and this is it: a ticket for #ourspace opens no group chat, and one for a group opens no other
  if (c.liveTicket && c.liveTicket.room !== String(room)) fail(403, 'that pass is for another chat.');
  const blocks = (await blockedIds(c)).slice(0, MAX_BLOCKS);
  return connect(c.env, room, c.req, { ...refOf(c.user), blocks, sid: c.user.tokenHash, exp: c.user.expires });
}
