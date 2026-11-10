-- Photos (phase 4; the owner dropped video): statuses, replies, quotes and board threads carry up to 4, a board comment
-- 1, a blog post an optional cover, and a member may upload their own profile picture. The files live in the R2 bucket
-- bound as MEDIA (wrangler.jsonc), under a random key; this table says whose each one is and what it's on.
-- Times are ms since the epoch, as in 0001.

-- One row per uploaded photo. `key` is its R2 object key (32 random hex digits and the extension: never the uploaded
-- file's name) and its address is /media/<key>. mime, bytes, width and height are the server's own reading of the
-- file after it took the metadata out (src/media/). purpose: post (a status, reply, quote, thread or comment), cover (a
-- blog post's) or avatar (a profile picture, 300px square). An upload is loose until it's attached: `attached` is when
-- it went on its post (post_id, in `position` order, with its alt text) or became its owner's picture; loose ones are
-- deleted by the cron after a day. `hidden`: a moderator hid this one photo (a hidden or deleted post hides all of its
-- photos anyway). A hidden photo is held as evidence: nothing its owner does deletes it (deleting the post, changing
-- the picture, deleting the account), only a moderator's remove. The photos of a post a moderator hid become hidden
-- photos when the post goes (the trigger below, and the code itself). post_id falls to NULL if a post ever goes without
-- taking its photos along, and owner_id when the account goes; the cron then deletes them unless they're held.
-- Every path that deletes rows here answers their keys (RETURNING), so the files leave R2 with them.
CREATE TABLE media (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT    NOT NULL UNIQUE,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose  TEXT    NOT NULL CHECK (purpose IN ('post', 'cover', 'avatar')),
  mime     TEXT    NOT NULL,
  bytes    INTEGER NOT NULL,
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  alt      TEXT    NOT NULL DEFAULT '',
  created  INTEGER NOT NULL,
  attached INTEGER,
  post_id  INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_post ON media (post_id, position) WHERE post_id IS NOT NULL;   -- a page of items' photos, in one read
CREATE INDEX media_owner ON media (owner_id, purpose);                           -- the storage cap, the picture, leaving
CREATE INDEX media_loose ON media (created) WHERE attached IS NULL;               -- the cron: loose uploads
CREATE INDEX media_orphaned ON media (id) WHERE hidden = 0 AND ((attached IS NOT NULL AND post_id IS NULL AND purpose != 'avatar') OR owner_id IS NULL);

-- An upload is attached once: two posts racing for the same photo can't both get it. The batch writing the second post
-- fails as a whole (its post, counts and notifications with it).
CREATE TRIGGER media_attach_once BEFORE UPDATE OF attached ON media
  WHEN OLD.attached IS NOT NULL AND NEW.attached IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'media already attached');
END;

-- A post a moderator hid holds its photos as evidence, however it goes (its author deleting it, their account going,
-- a tombstone being cleared): they become hidden photos, which only a moderator's remove deletes.
CREATE TRIGGER media_held_with_post BEFORE DELETE ON posts
  WHEN OLD.hidden = 1
BEGIN
  UPDATE media SET hidden = 1 WHERE post_id = OLD.id;
END;
