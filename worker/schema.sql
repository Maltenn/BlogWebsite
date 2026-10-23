-- ourspace-api storage (Cloudflare D1 / SQLite). Apply with `npm run db:local` / `npm run db:remote`.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created     INTEGER NOT NULL,            -- ms since epoch (what the API reports as `id`, like the old msgserver)
  screen_name TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  timestamp   TEXT    NOT NULL,            -- ISO 8601
  ip_hash     TEXT    NOT NULL,            -- salted SHA-256 of the poster's IP, for rate limiting only
  hidden      INTEGER NOT NULL DEFAULT 0   -- set to 1 to moderate an entry away without deleting it
);
CREATE INDEX IF NOT EXISTS messages_created ON messages (created DESC);
CREATE INDEX IF NOT EXISTS messages_ip      ON messages (ip_hash, created);

-- small key/value table: Spotify token + top-tracks cache
CREATE TABLE IF NOT EXISTS kv (
  k       TEXT PRIMARY KEY,
  v       TEXT NOT NULL,
  expires INTEGER                          -- ms since epoch, NULL = never
);
