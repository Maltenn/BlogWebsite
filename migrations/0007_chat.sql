-- Live chat (phase 5): #ourspace, group chats and DMs. D1 owns every message; the Durable Object `Room` (src/live/)
-- only carries events to the sockets that are connected. The 1:1 `messages` of 0001 become DM conversations, keeping
-- their ids, times and read state, and the reports about them keep pointing at the same ids. Then `messages` goes.
-- Times are ms since the epoch, as in 0001.

-- a DM (exactly two members, one per pair: dm_key is '<smaller id>:<larger id>') or a group (2–50 members, a title)
CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('dm', 'group')),
  title           TEXT,                          -- groups only (NULL: the page names it after its members)
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created         INTEGER NOT NULL,
  last_message_at INTEGER,                       -- NULL until somebody writes
  dm_key          TEXT    UNIQUE,                -- DMs only
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
);
CREATE INDEX conversations_recent ON conversations (last_message_at DESC);

-- who is in a conversation. status: joined | invited (a non-friend asked into a group: sees nothing until they accept)
-- | left (left, removed, or declined; kept so the row can come back). joined: when they joined (an invite: when they
-- were invited, until they accept). last_read_id: the newest message they have read. declined: when they last declined
-- an invite to it (invited_by is who asked): for 30 days the group can't ask again, for 7 days that person can't ask
-- them into any group.
CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status          TEXT    NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'invited', 'left')),
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined          INTEGER NOT NULL,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  declined        INTEGER,
  PRIMARY KEY (conversation_id, user_id)
) WITHOUT ROWID;
CREATE INDEX conversation_members_user ON conversation_members (user_id, status);

-- A group holds 50 people at most, joined and invited together. Checked by the database, so two adds at once can't
-- both squeeze past the limit (the losing write batch fails as a whole).
CREATE TRIGGER conversation_members_cap BEFORE INSERT ON conversation_members
  WHEN NEW.status != 'left' AND (SELECT COUNT(*) FROM conversation_members
    WHERE conversation_id = NEW.conversation_id AND status != 'left') >= 50
BEGIN SELECT RAISE(ABORT, 'group full'); END;
CREATE TRIGGER conversation_members_cap_back BEFORE UPDATE OF status ON conversation_members
  WHEN OLD.status = 'left' AND NEW.status != 'left' AND (SELECT COUNT(*) FROM conversation_members
    WHERE conversation_id = NEW.conversation_id AND status != 'left') >= 50
BEGIN SELECT RAISE(ABORT, 'group full'); END;

-- every chat message: in a conversation, or in the room #ourspace (room = 'ourspace', conversation_id NULL).
-- hidden: a moderator took it down (kept as evidence, shown to nobody). deleted: its writer deleted it (words cleared).
CREATE TABLE chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  room            TEXT    CHECK (room IN ('ourspace')),
  author_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT    NOT NULL,
  created         INTEGER NOT NULL,
  hidden          INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  CHECK ((conversation_id IS NULL) != (room IS NULL))
);
CREATE INDEX chat_messages_conversation ON chat_messages (conversation_id, id DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX chat_messages_room ON chat_messages (room, id DESC) WHERE room IS NOT NULL;
CREATE INDEX chat_messages_author ON chat_messages (author_id, created DESC);

-- #ourspace mutes, set by a moderator: no writing in the room until `until`. (The cron clears the expired ones.)
CREATE TABLE chat_mutes (
  user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until    INTEGER NOT NULL,
  muted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason   TEXT    NOT NULL DEFAULT '',
  created  INTEGER NOT NULL
);

-- The interaction score of decisions/001: what from_id did toward to_id (replies, likes, Friends' Comments, mentions,
-- quotes, reposts, board comment replies, DMs, group messages), as `eff` at the time `updated`. It halves every 30 days:
-- added to on write (decayed first), decayed again on read (src/shared/affinity.js).
CREATE TABLE affinity (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eff     REAL    NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
) WITHOUT ROWID;
CREATE INDEX affinity_to ON affinity (to_id, from_id);
CREATE INDEX affinity_updated ON affinity (updated);

-- notifications.kind gains group_invite (about conversation_id) and chat_mention (an @mention in #ourspace: message_id)
ALTER TABLE notifications ADD COLUMN conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE;

-- ---- the 1:1 messages of 0001 become DMs

-- one DM per pair that wrote to each other, started by whoever wrote first, when they did
INSERT INTO conversations (kind, created_by, created, last_message_at, dm_key)
  SELECT 'dm',
    (SELECT f.from_id FROM messages f WHERE MIN(f.from_id, f.to_id) = p.a AND MAX(f.from_id, f.to_id) = p.b ORDER BY f.created, f.id LIMIT 1),
    p.first, p.last, p.a || ':' || p.b
  FROM (SELECT MIN(from_id, to_id) AS a, MAX(from_id, to_id) AS b, MIN(created) AS first, MAX(created) AS last
        FROM messages GROUP BY MIN(from_id, to_id), MAX(from_id, to_id)) p
  ORDER BY p.first;

-- both people, joined since the first message. What they had read stays read: last_read_id is just before the oldest
-- message to them they hadn't read (or the newest message, if they had read them all).
INSERT INTO conversation_members (conversation_id, user_id, role, status, joined, last_read_id)
  SELECT k.id, k.uid, 'member', 'joined', k.created,
    COALESCE((SELECT MIN(m.id) - 1 FROM messages m WHERE m.to_id = k.uid AND m.from_id = k.other AND m.read_at IS NULL),
             (SELECT MAX(m.id) FROM messages m WHERE (m.from_id = k.uid AND m.to_id = k.other) OR (m.from_id = k.other AND m.to_id = k.uid)), 0)
  FROM (SELECT id, created, CAST(substr(dm_key, 1, instr(dm_key, ':') - 1) AS INTEGER) AS uid,
               CAST(substr(dm_key, instr(dm_key, ':') + 1) AS INTEGER) AS other FROM conversations WHERE kind = 'dm'
        UNION ALL
        SELECT id, created, CAST(substr(dm_key, instr(dm_key, ':') + 1) AS INTEGER),
               CAST(substr(dm_key, 1, instr(dm_key, ':') - 1) AS INTEGER) FROM conversations WHERE kind = 'dm') k;

-- every message, with its id, writer, words, time and whether a moderator hid it
INSERT INTO chat_messages (id, conversation_id, room, author_id, body, created, hidden)
  SELECT m.id, v.id, NULL, m.from_id, m.body, m.created, m.hidden
  FROM messages m JOIN conversations v ON v.dm_key = MIN(m.from_id, m.to_id) || ':' || MAX(m.from_id, m.to_id)
  ORDER BY m.id;

-- New messages must never take an id a message of 0001 once had: a report of a message that is gone (deleted with its
-- writer's account) still names its id, and would otherwise come to point at somebody else's new message. So
-- chat_messages' AUTOINCREMENT counter carries on from where messages' stood, not from the highest id that survived.
INSERT INTO sqlite_sequence (name, seq) SELECT 'chat_messages', 0
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'chat_messages');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT s.seq FROM sqlite_sequence s WHERE s.name = 'messages'), 0),
    COALESCE((SELECT MAX(r.target_id) FROM reports r WHERE r.target_type = 'message'), 0))
  WHERE name = 'chat_messages';

-- (reports of messages keep target_type 'message' and their target_id: the ids above are the same, so they point at
-- the new rows, or at nothing if the message is gone; their snapshots are untouched)
DROP TABLE messages;
