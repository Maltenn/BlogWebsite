// The Durable Object `Room`: one per chat room (#ourspace, each group chat, each DM). It carries events between the
// sockets connected to it and owns no data: messages are written to D1 by the Worker, which then asks the room to
// broadcast them. It uses the WebSocket Hibernation API (ctx.acceptWebSocket), so a room with nobody talking costs
// nothing: between events the object is evicted and the sockets stay open. Who each socket belongs to (whom they have a
// block with, either way, and which session opened it) rides on the socket itself (serializeAttachment), so it survives
// hibernation.
//
// Server → client (JSON text frames):
//   { type: 'message', message }    a new message (the same shape the history endpoint gives, without `mine`)
//   { type: 'deleted', id }         a message was deleted by its writer or taken down by a moderator
//   { type: 'typing', user }        someone is typing (at most every 2 s per person; never between people with a block)
//   { type: 'presence', online }    everyone connected, each once, as { id, name, avatar } (minus people with a block):
//                                   to a newcomer at once, to everyone else at most once a second
//   { type: 'read', user, id }      a member of a group or DM read up to message `id`
//   { type: 'changed' }             the conversation's title or members changed: fetch it again
//   { type: 'pong' }                the answer to a ping
//   { type: 'bye', code }           the room is closing this socket for good (code 4001–4003 below); the close follows
// Client → server: { type: 'typing' } and { type: 'ping' } (exactly '{"type":"ping"}', answered without waking the
// room). Anything else is ignored.
// Close codes the room sends (the page stops for good on 4001–4003, and reconnects after anything else):
//   4001 signed out: logged out, password changed or reset elsewhere, banned, account deleted, or the session ran out
//   4002 opened in too many places: a member has 5 sockets at most in one room, and the oldest goes
//   4003 not a member any more: left or removed
//   1008 too many frames: more than about one a second, sustained (pings that the auto-response answers don't count)
import { DurableObject } from 'cloudflare:workers';
import { echoProtocol } from '../shared/app.js';

export const SIGNED_OUT = 4001, TOO_MANY = 4002, REMOVED = 4003, FLOOD = 1008;
const TYPING_MS = 2000;
const PER_USER = 5;                            // sockets per member per room
const BURST = 10, REFILL_MS = 1000;            // frames: a bucket of 10, one more each second
const PRESENCE_MS = 1000;                      // presence to everyone at most this often
const CHECK_MS = 60000;                        // sessions are checked against D1 at least this often while events flow
const OPEN = 1;

const ref = a => ({ id: a.id, name: a.name, avatar: a.avatar });
// a block between the two people, whichever way it points
const apart = (a, b) => a.blocks.includes(b.id) || b.blocks.includes(a.id);
function send(ws, data) {
  try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch { /* it's closing */ }
}
// Closes a socket. For the codes that end it for good, a last frame { type: 'bye', code } says so first: a close made
// outside the socket's own events (an RPC from the Worker) can reach the page late (seconds, in wrangler dev), and the
// frame doesn't wait. Either way nothing more is sent to it: a closing socket is no longer OPEN.
function end(ws, code, reason) {
  if (code >= 4001 && code <= 4003) send(ws, { type: 'bye', code });
  try { ws.close(code, reason); } catch { /* already closing */ }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.checked = 0;                          // when the sessions were last checked (lost on eviction: then checked again)
  }

  // the open sockets with whose they are, leaving out `except`. A socket whose session has run out is closed here.
  people(except) {
    const out = [];
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== OPEN) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.id) continue;
      if (!a.exp || a.exp <= now) { end(ws, SIGNED_OUT, 'signed out'); continue; }
      out.push([ws, a]);
    }
    return out;
  }

  // Closes every socket whose session is gone (logged out, banned, account deleted: the Worker closes those itself, so
  // this only catches what that missed). One D1 read, at most once a minute unless `force`.
  async check(force = false) {
    const now = Date.now();
    if (!this.env.DB || (!force && now - this.checked < CHECK_MS)) return;
    this.checked = now;
    const all = this.people();
    const sids = [...new Set(all.map(([, a]) => a.sid).filter(Boolean))];
    let ok = new Set();
    try {
      for (let i = 0; i < sids.length; i += 500) {
        const { results } = await this.env.DB.prepare(`SELECT s.token_hash AS sid FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash IN (SELECT value FROM json_each(?1)) AND s.expires > ?2 AND u.banned = 0`).bind(JSON.stringify(sids.slice(i, i + 500)), now).all();
        results.forEach(r => ok.add(r.sid));
      }
    } catch (e) { console.error('room: checking sessions failed:', (e && e.stack) || e); return; }
    let any = false;
    for (const [ws, a] of all) if (!ok.has(a.sid)) { any = true; end(ws, SIGNED_OUT, 'signed out'); }
    if (any) this.soon();
  }

  // An upgrade, from the Worker (src/chats/live.js), which has already checked the session, the Origin and the
  // membership, and says who this is in X-Live-User.
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    let who = null;
    try { who = JSON.parse(request.headers.get('X-Live-User')); } catch { /* refused below */ }
    if (!who || !Number.isInteger(who.id) || typeof who.sid !== 'string' || !Number.isFinite(who.exp)) return new Response('who is this?', { status: 400 });
    // 5 sockets per member: the oldest beyond that go
    const mine = this.people().filter(([, a]) => a.id === who.id).sort((x, y) => (x[1].at || 0) - (y[1].at || 0));
    for (const [ws] of mine.slice(0, Math.max(0, mine.length - (PER_USER - 1)))) end(ws, TOO_MANY, 'open in too many places');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({
      id: who.id, name: who.name, avatar: who.avatar, blocks: Array.isArray(who.blocks) ? who.blocks : [],
      sid: who.sid, exp: who.exp, at: now, t: 0, tk: BURST, tt: now,
    });
    // the newcomer hears who's here at once; everybody else in the next presence round
    const me = server.deserializeAttachment();
    send(server, { type: 'presence', online: this.visibleTo(me, this.people()) });
    await this.soon();
    // A client with no cookie offered a room ticket as a subprotocol, and the fixed `ourspace.live` beside it: the
    // handshake selects THAT one. Whatever a handshake selects the browser publishes as `socket.protocol`, so echoing
    // the credential is what put the session token in reach of any script in the page (redteam R8, contract §7).
    const proto = echoProtocol(request);
    return new Response(null, { status: 101, webSocket: client, ...(proto ? { headers: { 'Sec-WebSocket-Protocol': proto } } : {}) });
  }

  // who `me` sees here: everyone connected, each once, minus people with a block
  visibleTo(me, all) {
    const seen = new Map();
    for (const [, a] of all) if (!seen.has(a.id) && (a.id === me.id || !apart(me, a))) seen.set(a.id, ref(a));
    return [...seen.values()];
  }

  // tells every socket who is here (each sees only people they have no block with)
  presence() {
    const all = this.people();
    for (const [ws, me] of all) send(ws, { type: 'presence', online: this.visibleTo(me, all) });
  }

  // a presence round within a second (connects and disconnects in a burst share one)
  async soon() {
    try {
      if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(Date.now() + PRESENCE_MS);
    } catch (e) { console.error('room: alarm failed:', (e && e.stack) || e); this.presence(); }
  }

  async alarm() {
    await this.check();
    this.presence();
  }

  /* called by the Worker (RPC, through src/shared/live.js) */

  async broadcast(event, skip = []) {
    await this.check();
    const data = JSON.stringify(event);
    for (const [ws, a] of this.people()) if (!skip.includes(a.id)) send(ws, data);
  }

  async kick(userIds) {
    let any = false;
    for (const [ws, a] of this.people()) {
      if (!userIds.includes(a.id)) continue;
      any = true;
      end(ws, REMOVED, 'not a member any more');
    }
    if (any) this.presence();
  }

  // A session ended (logged out, password changed or reset, banned, account deleted): its sockets close with 4001.
  // `only`: just that session's; `except`: every one of the member's but that one; neither: all of the member's.
  async signOut(userId, { only = null, except = null } = {}) {
    let any = false;
    for (const [ws, a] of this.people()) {
      if (a.id !== userId || (only && a.sid !== only) || (except && a.sid === except)) continue;
      any = true;
      end(ws, SIGNED_OUT, 'signed out');
    }
    if (any) this.presence();
  }

  // A block was made (`on`) or lifted between a and b: their open sockets take it into account at once (typing,
  // presence). Lifting it is only told when no block is left either way.
  async setApart(a, b, on) {
    for (const [ws, me] of this.people()) {
      const other = me.id === a ? b : me.id === b ? a : null;
      if (other == null) continue;
      const blocks = me.blocks.filter(x => x !== other);
      if (on) blocks.push(other);
      try { ws.serializeAttachment({ ...me, blocks }); } catch { end(ws, 4000, 'come back'); }   // (too long to carry: reconnect)
    }
    this.presence();
  }

  async online() {
    await this.check();
    const seen = new Map();
    for (const [, a] of this.people()) if (!seen.has(a.id)) seen.set(a.id, ref(a));
    return [...seen.values()];
  }

  /* the Hibernation API's handlers */

  async webSocketMessage(ws, data) {
    const me = ws.deserializeAttachment();
    if (!me || !me.id) return;
    // every frame that reaches here (the auto-answered pings don't) spends a token; a socket out of them is closed
    const now = Date.now();
    me.tk = Math.min(BURST, (me.tk ?? BURST) + (now - (me.tt || now)) / REFILL_MS);
    me.tt = now;
    if (me.tk < 1) { end(ws, FLOOD, 'too many frames'); return; }
    me.tk -= 1;
    ws.serializeAttachment(me);
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') return send(ws, { type: 'pong' });
    if (m.type !== 'typing') return;
    // typing: once every 2 s per person, however many sockets they have open
    const all = this.people();
    if (all.some(([, a]) => a.id === me.id && now - (a.t || 0) < TYPING_MS)) return;
    me.t = now;
    ws.serializeAttachment(me);
    // before telling anybody anything, the session must still be good
    if (!me.exp || me.exp <= now) { end(ws, SIGNED_OUT, 'signed out'); return; }
    if (this.env.DB) {
      try {
        const ok = await this.env.DB.prepare(`SELECT 1 AS x FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1 AND s.expires > ?2 AND u.banned = 0`).bind(me.sid, now).first();
        if (!ok) { end(ws, SIGNED_OUT, 'signed out'); this.soon(); return; }
      } catch (e) { console.error('room: checking a session failed:', (e && e.stack) || e); return; }
    }
    const fresh = ws.deserializeAttachment() || me;              // (a block may have come in meanwhile)
    const event = JSON.stringify({ type: 'typing', user: ref(fresh) });
    for (const [other, a] of this.people(ws)) if (a.id !== fresh.id && !apart(fresh, a)) send(other, event);
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { try { ws.close(); } catch { /* already closed */ } }
    await this.soon();
  }

  async webSocketError() {
    await this.soon();
  }
}
