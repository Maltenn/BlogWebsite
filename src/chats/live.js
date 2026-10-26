// GET /api/live/:room — the WebSocket for a room: `ourspace` (any member) or a chat id (its joined members). Everything
// is checked here, before the upgrade reaches the room's Durable Object: the session (the route is AUTH), the Origin
// (the router's cross-site check skips GETs, and a WebSocket handshake is a GET any site's page could start with our
// cookie, so it must come from our own pages), how often this member opens sockets, and the membership. The room then
// only carries events (src/live/room.js), and keeps each member to 5 sockets in it.
import { fail, int } from '../shared/http.js';
import { refOf, limit } from '../shared/db.js';
import { CHAT_OPEN } from '../shared/chat.js';
import { connect, OURSPACE } from '../shared/live.js';
import { blockedIds } from './messages.js';

const MAX_BLOCKS = 120;                        // carried with the socket (the attachment holds 2 KB; blocks made later are added to it)
const UPGRADES = [[30, 60000], [600, 86400000]];   // sockets opened per member (a page opens one per room it shows)

export async function liveRoom(c) {
  if ((c.req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') fail(426, 'this address is for WebSockets.');
  if (c.req.headers.get('Origin') !== c.url.origin) fail(403, 'cross-site request refused');
  await limit(c, 'live:' + c.user.id, UPGRADES, 'too many connections. wait a minute and reload.');
  let room = c.params.room;
  if (room !== OURSPACE) {
    const id = int(room, 0);
    const m = id > 0 && await c.env.DB.prepare(`SELECT 1 AS x FROM conversation_members cm JOIN conversations v ON v.id = cm.conversation_id
      WHERE cm.conversation_id = ?2 AND cm.user_id = ?1 AND cm.status = 'joined' AND ${CHAT_OPEN}`).bind(c.user.id, id).first();
    if (!m) fail(404, 'that chat isn\'t there.');
    room = id;
  }
  const blocks = (await blockedIds(c)).slice(0, MAX_BLOCKS);
  return connect(c.env, room, c.req, { ...refOf(c.user), blocks, sid: c.user.tokenHash, exp: c.user.expires });
}
