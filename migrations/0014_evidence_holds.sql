-- Child-safety reports and holds. A member's report with reason `csam` hides at once the reported thing's own photos that
-- its reporter can see, and nothing else; a moderator dismissing it shows them again. Only a moderator confirming it
-- (`confirm`, with the NCMEC report number) starts a hold on the account, and bans it in the same moment. A hold ends only
-- when a moderator releases it. docs/operations.md, "Holds and preservation", is the procedure; a lawyer has not read it.
-- Times are ms since the epoch, as in 0001.

-- What one report holds. kind 'media' (media.id): a photo the report lists, the reported thing's own. Every csam report
-- lists them, whoever filed it; it hides them only when it may (src/safety/safety.js). While the report is open or
-- confirmed the server refuses Remove and Unhide on them, and nothing their owner does deletes them (HELD in
-- src/shared/media.js): a photo its owner lets go meanwhile is only hidden, until a moderator decides. kind 'user' (users.id): the account a
-- confirmation holds, the report's target only. `target` has no foreign key on purpose: a hold outlives the account, and
-- users.id never comes back (AUTOINCREMENT), so a deleted account's hold can't land on somebody who signs up later. A
-- report's rows go when it is dismissed or released.
CREATE TABLE report_holds (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL CHECK (kind IN ('user', 'media')),
  target    INTEGER NOT NULL,
  PRIMARY KEY (report_id, kind, target)
) WITHOUT ROWID;
CREATE INDEX report_holds_target ON report_holds (kind, target);

-- Who hid a hidden photo: 1 when a child-safety report or hold did (and so ending it may show or delete the photo
-- again), 0 when a moderator did, or anything else. A moderator's own hide or unhide sets it back to 0.
ALTER TABLE media ADD COLUMN hold_hidden INTEGER NOT NULL DEFAULT 0;

-- 1 once a moderator confirmed this photo as apparent CSAM. From then on nothing shows it again (no dismissal, no hold
-- ending) but an explicit, logged override; once nothing holds it any more the cron deletes it (sweepEvidence).
ALTER TABLE media ADD COLUMN csam_confirmed INTEGER NOT NULL DEFAULT 0;

-- The accounts under a hold right now: a csam report a moderator confirmed. A view, so that every feature's sweep can ask
-- without importing another feature.
CREATE VIEW held_accounts AS
  SELECT DISTINCT h.target AS user_id FROM report_holds h JOIN reports r ON r.id = h.report_id
  WHERE h.kind = 'user' AND r.reason = 'csam' AND r.status = 'confirmed';

-- A private copy of what a held account's deletion, or its own clearing of a post or message, would otherwise destroy:
-- one row per thing, JSON in `data`, filed under the held account. Nothing but SQL reads it. An account's deletion stays a
-- real deletion: the account row, its sign-in and its page all go at once, as for anybody, and this is what's left until
-- the hold ends, when the cron deletes it (sweepEvidence, src/safety/safety.js). Passwords and tokens are never copied.
-- source: account | profile | identity | signal | scan | post | message | photo; source_id: that row's id.
CREATE TABLE evidence (
  user_id   INTEGER NOT NULL,                    -- the held account (no foreign key: this outlives it)
  source    TEXT    NOT NULL,
  source_id INTEGER NOT NULL,
  data      TEXT    NOT NULL,
  created   INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, source_id)
) WITHOUT ROWID;

-- The photos under a hold right now: listed by an open or confirmed csam report (report_id), or kept for an account a
-- confirmed report holds (report_id NULL). The server refuses Remove and Unhide on these without a logged override.
CREATE VIEW held_photos AS
  SELECT h.target AS media_id, r.id AS report_id FROM report_holds h JOIN reports r ON r.id = h.report_id
    WHERE h.kind = 'media' AND r.reason = 'csam' AND r.status IN ('open', 'confirmed')
  UNION ALL
  SELECT e.source_id, NULL FROM evidence e WHERE e.source = 'photo' AND e.user_id IN (SELECT user_id FROM held_accounts);

-- A post a moderator hid holds its photos as evidence however it goes (0005): its hide is now the moderator's own, so a
-- child-safety report that had hidden one of them ending doesn't show it again.
DROP TRIGGER media_held_with_post;
CREATE TRIGGER media_held_with_post BEFORE DELETE ON posts
  WHEN OLD.hidden = 1
BEGIN
  UPDATE media SET hidden = 1, hold_hidden = 0 WHERE post_id = OLD.id;
END;

-- Triggers, like media_held_with_post, so that every way a row can go is covered: the account's own deletion, a member
-- clearing a post or a message first, the DM going with the other member's account, #ourspace's rolling window. Only a
-- held account's own words are copied (and, for a DM, the other side of that one conversation). `OR IGNORE`: the first
-- copy wins, so a line cleared and later deleted keeps its words. They are no-ops unless a held account is involved, so
-- deleting anyone else's data works exactly as it did.
CREATE TRIGGER evidence_post_deleted BEFORE DELETE ON posts BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    SELECT h.user_id, 'post', OLD.id, json_object('kind', OLD.kind, 'author_id', OLD.author_id, 'target_id', OLD.target_id, 'reply_to', OLD.reply_to,
        'quote_of', OLD.quote_of, 'subject', OLD.subject, 'subtitle', OLD.subtitle, 'body', OLD.body, 'mood', OLD.mood, 'created', OLD.created, 'hidden', OLD.hidden),
      unixepoch() * 1000
    FROM held_accounts h WHERE h.user_id = OLD.author_id;
END;
CREATE TRIGGER evidence_post_cleared BEFORE UPDATE OF deleted ON posts WHEN NEW.deleted = 1 AND OLD.deleted = 0 BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    SELECT h.user_id, 'post', OLD.id, json_object('kind', OLD.kind, 'author_id', OLD.author_id, 'target_id', OLD.target_id, 'reply_to', OLD.reply_to,
        'quote_of', OLD.quote_of, 'subject', OLD.subject, 'subtitle', OLD.subtitle, 'body', OLD.body, 'mood', OLD.mood, 'created', OLD.created, 'hidden', OLD.hidden),
      unixepoch() * 1000
    FROM held_accounts h WHERE h.user_id = OLD.author_id;
END;

CREATE TRIGGER evidence_message_deleted BEFORE DELETE ON chat_messages BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    SELECT h.user_id, 'message', OLD.id, json_object('conversation_id', OLD.conversation_id, 'room', OLD.room, 'author_id', OLD.author_id, 'body', OLD.body,
        'created', OLD.created, 'hidden', OLD.hidden, 'deleted', OLD.deleted), unixepoch() * 1000
    FROM held_accounts h WHERE h.user_id = OLD.author_id;
END;
CREATE TRIGGER evidence_message_cleared BEFORE UPDATE OF deleted ON chat_messages WHEN NEW.deleted = 1 AND OLD.deleted = 0 BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    SELECT h.user_id, 'message', OLD.id, json_object('conversation_id', OLD.conversation_id, 'room', OLD.room, 'author_id', OLD.author_id, 'body', OLD.body,
        'created', OLD.created, 'hidden', OLD.hidden, 'deleted', OLD.deleted), unixepoch() * 1000
    FROM held_accounts h WHERE h.user_id = OLD.author_id;
END;
-- A DM goes whole with either member's account, so the victim leaving would take the held account's conversation with it.
-- Both sides of that one DM are copied, filed under the held account; the other member's id is all that is kept of them.
CREATE TRIGGER evidence_dm_deleted BEFORE DELETE ON conversations WHEN OLD.kind = 'dm' BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    SELECT cm.user_id, 'message', m.id, json_object('conversation_id', m.conversation_id, 'dm_key', OLD.dm_key, 'author_id', m.author_id, 'body', m.body,
        'created', m.created, 'hidden', m.hidden, 'deleted', m.deleted), unixepoch() * 1000
    FROM conversation_members cm JOIN chat_messages m ON m.conversation_id = cm.conversation_id
    WHERE cm.conversation_id = OLD.id AND cm.user_id IN (SELECT user_id FROM held_accounts);
END;

CREATE TRIGGER evidence_account_deleted BEFORE DELETE ON users WHEN OLD.id IN (SELECT user_id FROM held_accounts) BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    VALUES (OLD.id, 'account', OLD.id, json_object('name', OLD.name, 'email', OLD.email, 'avatar', OLD.avatar, 'birthdate', OLD.birthdate, 'created', OLD.created,
      'last_seen', OLD.last_seen, 'banned', OLD.banned, 'held', OLD.held, 'held_reason', OLD.held_reason, 'email_verified_at', OLD.email_verified_at), unixepoch() * 1000);
END;
CREATE TRIGGER evidence_profile_deleted BEFORE DELETE ON profiles WHEN OLD.user_id IN (SELECT user_id FROM held_accounts) BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    VALUES (OLD.user_id, 'profile', OLD.user_id, json_object('data', OLD.data, 'updated', OLD.updated), unixepoch() * 1000);
END;
CREATE TRIGGER evidence_identity_deleted BEFORE DELETE ON identities WHEN OLD.user_id IN (SELECT user_id FROM held_accounts) BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    VALUES (OLD.user_id, 'identity', OLD.rowid, json_object('provider', OLD.provider, 'subject', OLD.subject, 'email', OLD.email, 'created', OLD.created), unixepoch() * 1000);
END;
CREATE TRIGGER evidence_signal_deleted BEFORE DELETE ON signup_signals WHEN OLD.user_id IN (SELECT user_id FROM held_accounts) BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    VALUES (OLD.user_id, 'signal', OLD.user_id, json_object('ip_group_hash', OLD.ip_group_hash, 'asn', OLD.asn, 'as_org', OLD.as_org, 'country', OLD.country, 'ua_hash', OLD.ua_hash,
      'email_domain', OLD.email_domain, 'form_ms', OLD.form_ms, 'risk', OLD.risk, 'reasons', OLD.reasons, 'created', OLD.created), unixepoch() * 1000);
END;
CREATE TRIGGER evidence_scan_deleted BEFORE DELETE ON ai_scans WHEN OLD.user_id IN (SELECT user_id FROM held_accounts) BEGIN
  INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
    VALUES (OLD.user_id, 'scan', OLD.id, json_object('post_id', OLD.post_id, 'kind', OLD.kind, 'words', OLD.words, 'score', OLD.score, 'label', OLD.label, 'model', OLD.model,
      'text_hash', OLD.text_hash, 'decision', OLD.decision, 'created', OLD.created), unixepoch() * 1000);
END;

-- csam reports still open list what their snapshot listed, so the server keeps refusing Remove and Unhide on those
-- photos until a moderator decides (hold_hidden stays 0: who hid them isn't known, so ending the report leaves them as
-- they are). No account is held: nothing was ever confirmed. A snapshot that isn't a list of photos lists nothing.
INSERT OR IGNORE INTO report_holds (report_id, kind, target)
  SELECT r.id, 'media', json_extract(j.value, '$.id')
  FROM reports r, json_each(CASE WHEN json_valid(r.snapshot) AND json_type(r.snapshot, '$.media') = 'array' THEN json_extract(r.snapshot, '$.media') ELSE '[]' END) j
  WHERE r.reason = 'csam' AND r.status = 'open' AND j.type = 'object' AND json_type(j.value, '$.id') = 'integer';
