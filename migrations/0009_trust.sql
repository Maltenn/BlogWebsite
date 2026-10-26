-- Phase 7: verifying humans, anti-spam and AI-writing strikes (docs/decisions/002 and 003, with the owner's decisions:
-- docs/architecture.md, "Trust and safety"). Nothing here stores a raw IP address or a full User-Agent: networks and
-- browsers are salted hashes. Sign-up signals, AI scan scores and resolved alerts are deleted by the cron after 90 days,
-- post fingerprints after 7. Times are ms since the epoch, as in 0001.

-- users: email_verified_at (NULL until the emailed link is confirmed; sign-ups through Google & co. count as verified),
-- held (1 = a moderator looks at this new account before it can post, comment, message or follow; held_reason: the
-- risk reason codes, for moderators only), ai_exempt_until (a strike removed on appeal: no automatic strikes until then;
-- scores are still recorded). Everyone who already had an account is treated as verified.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN held_reason TEXT;
ALTER TABLE users ADD COLUMN ai_exempt_until INTEGER;
UPDATE users SET email_verified_at = created WHERE email_verified_at IS NULL;
CREATE INDEX users_held ON users (created) WHERE held = 1;

-- what we knew about a sign-up, for held-account review and the nightly cluster check. ip_group_hash: the salted hash
-- of the network (IPv4 address, IPv6 /64), the same key the rate limits use; asn / as_org / country: from Cloudflare's
-- request.cf; ua_hash: a salted hash of the User-Agent; email_domain: the part after @; form_ms: how long the form was
-- open; risk + reasons: the score and its reason codes (src/trust/risk.js). Deleted after 90 days.
CREATE TABLE signup_signals (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ip_group_hash TEXT    NOT NULL,
  asn           INTEGER,
  as_org        TEXT,
  country       TEXT,
  ua_hash       TEXT,
  email_domain  TEXT,
  form_ms       INTEGER,
  risk          INTEGER NOT NULL DEFAULT 0,
  reasons       TEXT    NOT NULL DEFAULT '[]',
  created       INTEGER NOT NULL
);
CREATE INDEX signup_signals_net ON signup_signals (ip_group_hash, created);
CREATE INDEX signup_signals_asn ON signup_signals (asn, created);
CREATE INDEX signup_signals_domain ON signup_signals (email_domain, created);
CREATE INDEX signup_signals_created ON signup_signals (created);

-- "confirm your email" links: single use, 24 hours, only the SHA-256 of the token is kept (the link carries it in the
-- URL fragment, /verify#token=…, like password resets). email: the address it was sent to (a link for an old address
-- doesn't verify a new one).
CREATE TABLE email_tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens (user_id);
CREATE INDEX email_tokens_expires ON email_tokens (expires);

-- sign-up forms are stateless signed tokens (they carry the honeypot's name, the time and the proof-of-work challenge);
-- each one's nonce lands here when it's used, so a form (and its proof of work) works once. Kept until it would have
-- expired anyway.
CREATE TABLE spent_nonces (
  nonce   TEXT    PRIMARY KEY,
  expires INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX spent_nonces_expires ON spent_nonces (expires);

-- near-duplicate content (src/trust/minhash.js): a MinHash signature of each public post's normalised words (16 values
-- of 8 hex digits: two texts agree on each with a probability equal to how many 3-word runs they share), its first four
-- values again as lookup bands b0..b3, and the SHA-256 of the normalised text. No text is kept. Deleted after 7 days.
CREATE TABLE post_fingerprints (
  post_id   INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  simhash   TEXT    NOT NULL,      -- the MinHash signature (the column kept the name of the first draft, already applied to a demo)
  b0        TEXT    NOT NULL,
  b1        TEXT    NOT NULL,
  b2        TEXT    NOT NULL,
  b3        TEXT    NOT NULL,
  text_hash TEXT    NOT NULL,
  words     INTEGER NOT NULL,
  created   INTEGER NOT NULL
);
CREATE INDEX post_fingerprints_b0 ON post_fingerprints (b0, created);
CREATE INDEX post_fingerprints_b1 ON post_fingerprints (b1, created);
CREATE INDEX post_fingerprints_b2 ON post_fingerprints (b2, created);
CREATE INDEX post_fingerprints_b3 ON post_fingerprints (b3, created);
CREATE INDEX post_fingerprints_text ON post_fingerprints (text_hash, created);
CREATE INDEX post_fingerprints_created ON post_fingerprints (created);

-- every AI-writing score (src/ai/): the post, its writer, the detector's score (0..1, higher = more likely AI), label
-- and model, and what was decided: clear | would_strike (shadow mode) | strike | same_incident (one strike per 24 h) |
-- exempt (a strike was removed on appeal lately) | error (the detector failed: nothing happens). Deleted after 90 days.
CREATE TABLE ai_scans (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id   INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL,
  words     INTEGER NOT NULL,
  score     REAL,
  label     TEXT,
  model     TEXT,
  text_hash TEXT,
  decision  TEXT    NOT NULL,
  created   INTEGER NOT NULL
);
CREATE INDEX ai_scans_created ON ai_scans (created DESC);
CREATE INDEX ai_scans_user ON ai_scans (user_id, created);

-- strikes for AI-written posts (the owner's ladder: 1 warning, 2 a day's posting timeout, 3 a week, 4 a month, 5 a
-- moderator decides on a ban). text: the flagged words as they were scanned (kept so the member and moderators can
-- see them; cleared 30 days after the strike stops counting). expires: 90 days after the member's latest strike
-- ("90 clean days"). status: active | appealed (the member asked a moderator) | removed (a moderator took it back) |
-- expired. appeal_result: upheld | removed, once a moderator decided.
CREATE TABLE ai_strikes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id       INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  scan_id       INTEGER REFERENCES ai_scans(id) ON DELETE SET NULL,
  level         INTEGER NOT NULL,
  text          TEXT    NOT NULL DEFAULT '',
  score         REAL    NOT NULL,
  label         TEXT,
  model         TEXT,
  created       INTEGER NOT NULL,
  expires       INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'appealed', 'removed', 'expired')),
  appeal_note   TEXT,
  appealed_at   INTEGER,
  appeal_result TEXT,
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    INTEGER,
  decision_note TEXT
);
CREATE INDEX ai_strikes_user ON ai_strikes (user_id, status, created);
CREATE INDEX ai_strikes_appealed ON ai_strikes (status, appealed_at);

-- a strike's posting timeout: no public posting or commenting (DMs, chat, reading and likes still work) until `until`,
-- while the strike that caused it still counts. Removing the strike on appeal deletes its row.
CREATE TABLE posting_timeouts (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strike_id INTEGER NOT NULL REFERENCES ai_strikes(id) ON DELETE CASCADE,
  until     INTEGER NOT NULL,
  PRIMARY KEY (user_id, strike_id)
);
CREATE INDEX posting_timeouts_until ON posting_timeouts (until);

-- what moderators are asked to look at. kind: cluster (the nightly check: several accounts from one network, hosting
-- provider, email domain or moment, or pushing the same text) | duplicate (the same text from several new accounts:
-- the copies are held) | held_signup (a sign-up held for review) | ban_review (a 5th AI strike). key: what makes it the
-- same alert (one open alert per key). payload: JSON (user ids, post ids, counts; never addresses; a duplicate alert's
-- `held`: exactly the post ids it held, the only ones its release shows again). Never acts by itself: nobody is banned
-- by an alert. Resolved ones are deleted after 90 days.
--
-- posts.hidden (0001) gains a third value: 2 = held as duplicate text, waiting for a moderator (src/trust/duplicates.js).
-- 1 stays "hidden by a moderator" (a report, CSAM, intimate images, POST /api/admin/content). Everything that shows
-- posts asks for hidden = 0, so a held post shows nowhere; a release sets 2 back to 0 and never touches a 1.
CREATE TABLE mod_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('cluster', 'duplicate', 'held_signup', 'ban_review')),
  key         TEXT    NOT NULL,
  payload     TEXT    NOT NULL DEFAULT '{}',
  created     INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  resolution  TEXT
);
CREATE UNIQUE INDEX mod_alerts_open ON mod_alerts (kind, key) WHERE resolved_at IS NULL;
CREATE INDEX mod_alerts_list ON mod_alerts (resolved_at, created);

-- notifications.kind gains ai_strike (a strike was given) and ai_appeal (a moderator decided an appeal), about the
-- strike in strike_id
ALTER TABLE notifications ADD COLUMN strike_id INTEGER REFERENCES ai_strikes(id) ON DELETE CASCADE;
