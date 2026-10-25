-- ourspace-social storage (Cloudflare D1 / SQLite).
-- Apply: `npm run db:local` (wrangler's local copy) / `npm run db:remote` (the real database).
-- Times are ms since the epoch.

-- people. name is shown as typed; name_key (lower case) keeps screen names unique. email and birthdate are private.
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,
  email       TEXT    UNIQUE,                    -- lower case. NULL when the account came from a sign-in provider without one
  avatar      TEXT    NOT NULL,                  -- a preset picture path (copied from the profile for cheap joins)
  pass_hash   TEXT,                              -- pbkdf2-sha256$<iterations>$<salt>$<hash>; NULL = signs in with Google/Apple/… only
  birthdate   TEXT    NOT NULL,                  -- YYYY-MM-DD: the age check and the star sign come from it
  is_admin    INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  wall_policy TEXT    NOT NULL DEFAULT 'everyone', -- who may comment on my wall: everyone | friends
  dm_policy   TEXT    NOT NULL DEFAULT 'everyone', -- who may message me: everyone | friends
  created     INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX users_seen ON users (last_seen DESC);

-- everything on a profile page (about me, interests, look, top 8 …) as one validated JSON object
CREATE TABLE profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT    NOT NULL,
  updated INTEGER NOT NULL
);

-- logins. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- "Sign in with Google / Apple / Microsoft / Discord / GitHub": which outside account belongs to which person
CREATE TABLE identities (
  provider TEXT    NOT NULL,
  subject  TEXT    NOT NULL,                     -- the provider's id for the person (never changes)
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email    TEXT,                                 -- what the provider said, for the Settings page only
  created  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);

-- a sign-in (or Spotify connection) in progress: the random `state` sent to the provider, hashed, plus the PKCE
-- verifier. Single use, ten minutes.
CREATE TABLE oauth_states (
  state_hash TEXT    PRIMARY KEY,
  provider   TEXT    NOT NULL,
  mode       TEXT    NOT NULL,                   -- login | link | spotify
  user_id    INTEGER,                            -- link / spotify: who started it
  verifier   TEXT,
  next       TEXT,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);

-- someone new came back from a provider: they still have to pick a screen name and give their birthday
CREATE TABLE oauth_signups (
  ticket_hash TEXT    PRIMARY KEY,
  provider    TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  email       TEXT,                              -- only when the provider says it's verified
  name_hint   TEXT,
  created     INTEGER NOT NULL,
  expires     INTEGER NOT NULL
);

-- "forgot my password" links (hashed, one hour, single use)
CREATE TABLE password_resets (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);

-- a person's Spotify connection. Tokens are encrypted with the TOKEN_KEY secret (AES-GCM).
CREATE TABLE spotify (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spotify_id     TEXT    NOT NULL,
  display_name   TEXT,
  refresh_enc    TEXT    NOT NULL,
  access_enc     TEXT,
  access_expires INTEGER,
  time_range     TEXT    NOT NULL DEFAULT 'short_term',   -- short_term (4 weeks) | medium_term (6 months) | long_term (all time)
  show           INTEGER NOT NULL DEFAULT 1,
  tracks         TEXT,                           -- JSON: the top tracks last fetched
  fetched        INTEGER,
  error          TEXT,                           -- why the last refresh failed (revoked, not_allowlisted …)
  created        INTEGER NOT NULL
);

-- one row per pair of people (a < b): a pending request or an accepted friendship
CREATE TABLE friendships (
  a            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL,                 -- pending | accepted
  requested_by INTEGER NOT NULL,
  created      INTEGER NOT NULL,
  accepted     INTEGER,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX friendships_b ON friendships (b, status);

-- everything that shows up in the feed: status | wall | bulletin | blog | friends (two people became friends) | joined
CREATE TABLE posts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT    NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- whose wall (wall) / the new friend (friends)
  subject   TEXT,                                -- bulletin subject / blog title
  body      TEXT    NOT NULL DEFAULT '',
  mood      TEXT,                                -- blog entries
  created   INTEGER NOT NULL,
  hidden    INTEGER NOT NULL DEFAULT 0           -- set by a moderator: kept as evidence, shown to nobody
);
CREATE INDEX posts_feed   ON posts (created DESC, id DESC);
CREATE INDEX posts_author ON posts (author_id, kind, created DESC);
CREATE INDEX posts_target ON posts (target_id, kind, created DESC);

-- private messages
CREATE TABLE messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body    TEXT    NOT NULL,
  created INTEGER NOT NULL,
  read_at INTEGER,
  hidden  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_to   ON messages (to_id, created DESC);
CREATE INDEX messages_from ON messages (from_id, created DESC);

-- blocking hides both people from each other and stops messages, wall comments and friend requests between them
CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks (blocked_id);

-- reports. snapshot = what the reported thing said when it was reported, so the evidence survives a delete.
CREATE TABLE reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type    TEXT    NOT NULL,               -- user | post | message
  target_id      INTEGER NOT NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT    NOT NULL,
  details        TEXT    NOT NULL DEFAULT '',
  snapshot       TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'open', -- open | dismissed | actioned
  created        INTEGER NOT NULL,
  resolved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    INTEGER,
  resolution     TEXT
);
CREATE INDEX reports_status ON reports (status, created DESC);
CREATE INDEX reports_reporter ON reports (reporter_id, target_type, target_id);

-- every moderator action, for accountability
CREATE TABLE mod_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL,
  target_id   INTEGER NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  created     INTEGER NOT NULL
);

-- rate limiting: one row per attempt, counted over a window (cleaned up by the cron)
CREATE TABLE attempts (
  k       TEXT    NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX attempts_k ON attempts (k, created);
