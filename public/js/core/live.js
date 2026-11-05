/* core/live.js — a live room: one WebSocket (GET /api/live/:room) with the rest of the work around it.
     openRoom(room, { onEvent, onState, sync }) → { send(obj), reconnect(), close(), state }
   · onEvent(event) gets every JSON frame the room sends (not the pongs). Some endings are for good (no retry, no polling):
     close code 4001 or a 401 from sync → onEvent({ type: 'signedout' }) (logged out, banned, account gone);
     close code 4003 or a 403/404 from sync → onEvent({ type: 'removed' }) (not in the chat any more);
     close code 4002 → onEvent({ type: 'elsewhere' }) (the room is open in too many tabs: this one gave way).
     The room says { type: 'bye', code } just before such a close, and that frame ends it already.
   · A lost socket comes back by itself, waiting 1 s, 2 s, 4 s … up to 30 s between tries. A ping every 25 s keeps it open.
   · sync() is the caller's way to ask the history endpoint for what it missed (`?after=<last id>`). It runs after every
     reconnect, and, once the socket has failed three times in a row, every few seconds as a fallback (state 'polling')
     until it comes back (once a minute while the tab is hidden). state: 'connecting' | 'live' | 'polling' | 'closed';
     onState(state) hears the changes.
   · The room is closed when the page is left (onLeave).
   · useLiveTickets(fn) — a client that can't send our cookie (the iOS / Android shells, core/native.js) registers a
     function here, and every connect waits for `await fn(room)` to hand back the subprotocols to offer. That is where
     the one-room pass comes from (POST /api/live/ticket, docs/mobile/contract.md §7). In a browser nothing is
     registered, nothing is awaited, and the socket opens exactly as it always did. */

import { enc } from './dom.js';
import { onLeave } from './router.js';

// close codes from the room (src/live/room.js) that end it for good, and what the page hears
const FINAL = { 4001: 'signedout', 4002: 'elsewhere', 4003: 'removed' };
// history answers that end it for good
const FINAL_STATUS = { 401: 'signedout', 403: 'removed', 404: 'removed' };
const PING_MS = 25000;
const FAILS_BEFORE_POLLING = 3;
const HIDDEN_POLL_MS = 60000;   // polling while the tab is hidden: once a minute
const open = new Set();     // the rooms that are open right now (dropSockets uses it)

// How a cookieless client gets into a room: async (room) => [subprotocols]. null in a browser (see the header).
// A rejection with `status` 401/403/404 ends the room for good, the same way a rejected history fetch does.
let ticketFor = null;
export function useLiveTickets(fn) { ticketFor = typeof fn === 'function' ? fn : null; }

export function liveUrl(room, loc = location) {
  return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + '/api/live/' + enc(room);
}

export function openRoom(room, { onEvent = () => {}, onState = () => {}, sync = null, pollMs = 4000, WS = globalThis.WebSocket } = {}) {
  let ws = null, closed = false, fails = 0, everOpen = false, state = 'connecting';
  let retry = null, ping = null, poll = null, syncing = false, lastSync = 0, gen = 0;
  const set = s => { if (s !== state) { state = s; onState(s); } };
  // the end, for good: nothing more is tried, and the page hears why
  const finish = why => { if (closed) return; close(); onEvent({ type: why }); };
  const runSync = async () => {
    if (!sync || syncing || closed) return;
    syncing = true;
    lastSync = Date.now();
    try { await sync(); } catch (e) {
      const why = e && FINAL_STATUS[e.status];
      if (why) finish(why);                     // else: the next try will do
    } finally { syncing = false; }
  };
  // a polling round: every few seconds, or once a minute while nobody is looking
  const pollTick = () => { if (!document.hidden || Date.now() - lastSync >= HIDDEN_POLL_MS) runSync(); };
  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  // Without a ticket function the socket opens in this tick, as it always has. With one, this connect waits for the
  // pass for this room — a single-use one, so every attempt asks again — and a refusal that means "not you, not here"
  // ends the room instead of retrying.
  const connect = () => {
    if (closed) return;
    clearTimeout(retry);
    if (!ticketFor) { start([]); return; }
    const mine = ++gen;                       // a pass that arrives after another attempt started is thrown away
    let got;
    try { got = ticketFor(room); } catch (e) { refused(e, mine); return; }
    Promise.resolve(got).then(list => { if (!closed && mine === gen) start(Array.isArray(list) ? list : []); }, e => refused(e, mine));
  };
  const refused = (e, mine) => {
    if (closed || mine !== gen) return;
    const why = e && FINAL_STATUS[e.status];
    if (why) finish(why); else lost();
  };
  const start = protocols => {
    let sock;
    try { sock = protocols.length ? new WS(liveUrl(room), protocols) : new WS(liveUrl(room)); } catch { lost(); return; }
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      const catchUp = everOpen || state === 'polling';
      fails = 0;
      stopPoll();
      set('live');
      clearInterval(ping);
      ping = setInterval(() => { try { sock.send('{"type":"ping"}'); } catch { /* closing */ } }, PING_MS);
      if (catchUp) runSync();
      everOpen = true;
    };
    sock.onmessage = e => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev && ev.type === 'bye') { if (FINAL[ev.code]) finish(FINAL[ev.code]); return; }   // (the close itself may lag)
      if (ev && ev.type && ev.type !== 'pong') onEvent(ev);
    };
    sock.onclose = e => {
      if (sock !== ws) return;
      clearInterval(ping);
      ws = null;
      if (closed) return;
      if (e && FINAL[e.code]) { finish(FINAL[e.code]); return; }
      lost();
    };
    sock.onerror = () => { /* onclose follows */ };
  };
  const lost = () => {
    fails++;
    if (fails >= FAILS_BEFORE_POLLING) {
      set('polling');
      if (!poll) { poll = setInterval(pollTick, pollMs); runSync(); }
    } else set('connecting');
    retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** (fails - 1)) + Math.floor(Math.random() * 300));
  };
  const visible = () => { if (!document.hidden && state !== 'live' && !closed) { fails = 0; reconnect(); } };
  const reconnect = () => {
    if (closed) return;
    clearTimeout(retry);
    if (ws) { const old = ws; ws = null; clearInterval(ping); try { old.close(4000); } catch { /* gone */ } }
    connect();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(retry); clearInterval(ping); stopPoll();
    document.removeEventListener('visibilitychange', visible);
    open.delete(handle);
    if (ws) { const old = ws; ws = null; try { old.close(1000); } catch { /* gone */ } }
    set('closed');
  };
  const handle = {
    send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch { /* closing */ } } return false; },
    reconnect, close,
    // knocks the socket over without closing the room: it reconnects and catches up (for trying it out)
    drop() { if (ws) try { ws.close(4000); } catch { /* gone */ } },
    get state() { return state; },
  };
  open.add(handle);
  document.addEventListener('visibilitychange', visible);
  onLeave(close);
  connect();
  return handle;
}

// every open room loses its socket at once and has to come back (from the console: (await import('/js/core/live.js')).dropSockets())
export function dropSockets() { open.forEach(r => r.drop()); return open.size; }
