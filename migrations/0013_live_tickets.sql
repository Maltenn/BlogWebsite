-- The chat WebSocket stops carrying the session token (docs/mobile/redteam.md R8, docs/mobile/contract.md §7). A browser
-- WebSocket cannot set an Authorization header, so the apps offered the raw session token as the subprotocol
-- `ourspace.bearer.<token>` — and a handshake selects one of the subprotocols the client offered, which the browser then
-- publishes on the live socket as `socket.protocol`. The token is kept in the iOS Keychain / Android Keystore precisely so
-- that no script in the page can read it; that handed it straight back. So what rides in the subprotocol is now a TICKET:
-- hashed at rest, single use, scoped to one room, and worth half a minute. Read out of `socket.protocol` it buys one room
-- the holder is already in, not an account. (The room's 101 no longer echoes it either: it selects the fixed
-- `ourspace.live` the client also offers, so `socket.protocol` holds no secret at all. The ticket is the floor, not the
-- only wall.) Times are ms since the epoch, as everywhere.

-- A pass for one room's WebSocket, minted by POST /api/live/ticket for a member who may open that room, and spent by the
-- handshake that follows (src/shared/live.js claims it: the row is deleted before anything is handed out, so a replay —
-- or whoever read the ticket off `socket.protocol` — finds nothing).
--   ticket_hash  the same SHA-256 as sessions, sign-up tickets and oauth_app_codes: the raw ticket is never stored
--   room         'ourspace', or a conversation id as text. One room only: a ticket for room A is refused on room B.
--   token_hash   the session that asked for it. The socket it opens IS that session's (src/accounts/auth.js loads the
--                user from here), so logging out, a password change, a ban or a deleted account take the pass with them.
CREATE TABLE live_tickets (
  ticket_hash TEXT    PRIMARY KEY,
  room        TEXT    NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  created     INTEGER NOT NULL,
  expires     INTEGER NOT NULL
);
CREATE INDEX live_tickets_expires ON live_tickets (expires);
-- the cascade above needs this one: without an index on the child key SQLite scans the table for every session it deletes
CREATE INDEX live_tickets_session ON live_tickets (token_hash);
