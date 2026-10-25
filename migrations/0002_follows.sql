-- Following replaces friend requests. Following is one-way; two people who follow each other (both accepted) are
-- friends. A profile is open (a follow is accepted at once) or approves its followers ("private").
-- Times are ms since the epoch, as in 0001.

-- one row per follow. status: accepted | pending (waiting for a profile that approves its followers)
CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL,
  created     INTEGER NOT NULL,
  accepted    INTEGER,                           -- NULL while pending
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON follows (followee_id, status);

-- friendships become follows: friends follow each other (keeping when they became friends), and whoever sent a
-- request that was still waiting simply follows the other person (every profile starts open). Two people with a block
-- between them (either way) get no follows at all: a block hides them from each other.
WITH unblocked AS (
  SELECT * FROM friendships
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a))
)
INSERT INTO follows (follower_id, followee_id, status, created, accepted)
  SELECT a, b, 'accepted', created, COALESCE(accepted, created) FROM unblocked WHERE status = 'accepted'
  UNION ALL
  SELECT b, a, 'accepted', created, COALESCE(accepted, created) FROM unblocked WHERE status = 'accepted'
  UNION ALL
  SELECT requested_by, CASE WHEN requested_by = a THEN b ELSE a END, 'accepted', created, created
    FROM unblocked WHERE status = 'pending';
DROP TABLE friendships;

-- who may follow me: open (anyone, at once) | approve (I accept each one; my posts are for my followers only).
-- Friends' Comments are always friends-only, so the wall setting goes.
ALTER TABLE users ADD COLUMN follow_policy TEXT NOT NULL DEFAULT 'open';
ALTER TABLE users DROP COLUMN wall_policy;

-- posts.kind is now status | blog | wall (a Friends' Comment) | bulletin. Blog posts get an optional subtitle, and the
-- feed no longer shows "became friends" or "joined" lines.
ALTER TABLE posts ADD COLUMN subtitle TEXT;
DELETE FROM posts WHERE kind IN ('friends', 'joined');

-- read positions, like Mastodon's markers: the last post someone has seen. name: feed (later: notifications)
CREATE TABLE markers (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  last_created INTEGER NOT NULL,
  last_id      INTEGER NOT NULL,
  updated      INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);
