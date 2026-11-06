-- Tweet-style interactions on statuses and blog posts: replies, likes, reposts and quotes, bookmarks, @mentions and
-- #hashtags, plus the Notifications tab. Friends' Comments only get @mentions; bulletins get nothing new.
-- Times are ms since the epoch, as in 0001.

-- posts.kind gains reply (up to 500 characters, answering reply_to), quote (up to 500, about quote_of) and repost (no
-- words, just quote_of; one per person per post). root_id is a reply's conversation: the first post of it (NULL on that
-- post itself and on everything that isn't a reply). The four counts are kept in the same batch as every write that
-- changes them. A deleted post that still has replies or quotes stays as a tombstone (deleted = 1, its words cleared),
-- so conversations and quotes keep their shape. reply_to and root_id are plain ids, not foreign keys: when a post goes
-- with its writer's account, the replies to it keep pointing at it, so they stay in their conversation and can say
-- they answer a deleted account.
ALTER TABLE posts ADD COLUMN reply_to INTEGER;
ALTER TABLE posts ADD COLUMN root_id INTEGER;
ALTER TABLE posts ADD COLUMN quote_of INTEGER REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;   -- replies that aren't deleted
ALTER TABLE posts ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN quote_count INTEGER NOT NULL DEFAULT 0;   -- quotes that aren't deleted
ALTER TABLE posts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX posts_repost ON posts (author_id, quote_of) WHERE kind = 'repost';
CREATE INDEX posts_root ON posts (root_id, created) WHERE root_id IS NOT NULL;          -- a conversation, oldest first
CREATE INDEX posts_reply_to ON posts (reply_to) WHERE reply_to IS NOT NULL;             -- the replies under a reply
CREATE INDEX posts_quote_of ON posts (quote_of, kind) WHERE quote_of IS NOT NULL;       -- a post's reposts and quotes
CREATE INDEX posts_stream ON posts (author_id, created) WHERE kind IN ('status', 'quote', 'repost');   -- a Posts tab
-- (a person's replies are read through posts_author: author_id, kind, created)

-- likes (there are no dislikes)
CREATE TABLE likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX likes_post ON likes (post_id);

-- bookmarks: private to the person who saved them
CREATE TABLE bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX bookmarks_user ON bookmarks (user_id, created DESC, post_id DESC);
CREATE INDEX bookmarks_post ON bookmarks (post_id);

-- the people a post @mentions, resolved when it was written (statuses, replies, quotes, blog posts, Friends' Comments)
CREATE TABLE mentions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX mentions_user ON mentions (user_id);

-- #hashtags, lower case (statuses, replies, quotes, blog posts). created is the post's, so a tag's page reads newest
-- first straight from the index.
CREATE TABLE post_tags (
  tag     TEXT    NOT NULL,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (tag, post_id)
);
CREATE INDEX post_tags_tag ON post_tags (tag, created DESC, post_id DESC);
CREATE INDEX post_tags_post ON post_tags (post_id);

-- the Notifications tab. kind: like | reply | repost | quote | mention | comment (a Friends' Comment on your page) |
-- follow | follow_request | follow_accepted. post_id is what it's about: the post that was liked or reposted, or the
-- reply, quote, mention or comment itself; NULL for follows. How far someone has read is their 'notifications' marker.
CREATE TABLE notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id  INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  created  INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications (user_id, id DESC);
CREATE INDEX notifications_post ON notifications (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX notifications_actor ON notifications (actor_id, user_id);
