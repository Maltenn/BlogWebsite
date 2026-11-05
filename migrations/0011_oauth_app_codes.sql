-- The mobile apps' sign-in with Google or Discord stops handing secrets to a custom scheme (docs/mobile/r1-fix.md,
-- docs/mobile/contract.md §6). `ourspace://` is a public, exported BROWSABLE intent filter on Android and an
-- unclaimed CFBundleURLType on iOS: any installed app can fire a URL at it, and on Android a co-installed app that
-- declares the same scheme is offered the OAuth return. So what travels on the scheme is now a one-time CODE that is
-- worthless on its own: redeeming it at POST /api/oauth/exchange needs the verifier the app minted before opening the
-- provider sheet and kept in memory only. Times are ms since the epoch, as everywhere.

-- The SHA-256 of that verifier, base64url, as the app sent it on
-- GET /api/oauth/:provider/start?client=app&challenge=… — carried from the start to the callback so the code can be
-- bound to it. NULL for every web sign-in, and an app sign-in without one is refused.
ALTER TABLE oauth_states ADD COLUMN challenge TEXT;

-- A finished app sign-in waiting for the app to collect it. Hashed (the same SHA-256 as sessions and tickets), single
-- use, and short-lived: the only thing between the callback's redirect and the app's POST is the operating system.
--   kind = 'session'  the code buys a device session for user_id (the session is not created until it is redeemed, so
--                     a code nobody collects leaves nothing behind)
--   kind = 'signup'   the code buys the sign-up ticket of an oauth_signups row; the raw ticket is minted at the
--                     exchange and the row's ticket_hash replaced, so the ticket never touches the scheme either
CREATE TABLE oauth_app_codes (
  code_hash   TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('session', 'signup')),
  challenge   TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ticket_hash TEXT,
  created     INTEGER NOT NULL,
  expires     INTEGER NOT NULL,
  CHECK ((kind = 'session') = (user_id IS NOT NULL)),
  CHECK ((kind = 'signup') = (ticket_hash IS NOT NULL))
);
CREATE INDEX oauth_app_codes_expires ON oauth_app_codes (expires);
