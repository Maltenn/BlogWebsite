-- Boards: the bulletin board becomes topic boards (Music, Cooking, Random …) with forum threads, nested comments and
-- votes (like and dislike, both counted). Statuses and blog posts keep their tweet-style replies and likes.
-- Times are ms since the epoch, as in 0001.

-- the boards, curated: moderators create them (from members' requests) and can archive one (it leaves the index and
-- takes no new threads, comments or votes; what's there stays readable). icon is an emoji; the index is in `position`.
CREATE TABLE boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,           -- its address: /boards/<slug>
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO boards (slug, name, description, icon, position, created) VALUES
  ('music', 'Music', 'bands, mixtapes, shows, and the song on your profile this week', '🎵', 1, 1792886400000),
  ('movies-tv', 'Movies & TV', 'what you rented, what you taped, and who should have won', '🎬', 2, 1792886400000),
  ('games', 'Games', 'cheat codes, high scores and LAN party plans', '🎮', 3, 1792886400000),
  ('art-layouts', 'Art & Layouts', 'drawings, pixel art, and making your page look amazing', '🎨', 4, 1792886400000),
  ('cooking', 'Cooking', 'recipes, kitchen disasters and midnight snacks', '🍳', 5, 1792886400000),
  ('pets', 'Pets', 'brag about your cat, dog, hamster or lizard', '🐾', 6, 1792886400000),
  ('sports', 'Sports', 'the big game, your team, and skate tricks', '⚽', 7, 1792886400000),
  ('tech', 'Tech & Computers', 'building PCs, fixing the family computer, and the internet', '💻', 8, 1792886400000),
  ('fashion', 'Fashion', 'outfits, thrift finds and band tees', '👗', 9, 1792886400000),
  ('books-writing', 'Books & Writing', 'what you''re reading, and the poems in your notebook margins', '📚', 10, 1792886400000),
  ('astrology', 'Astrology', 'signs, charts, and blaming it on Mercury', '🔮', 11, 1792886400000),
  ('school', 'School', 'homework help, teachers, and counting down to summer', '✏️', 12, 1792886400000),
  ('advice', 'Advice', 'crushes, friend drama, and what to do next', '💌', 13, 1792886400000),
  ('random', 'Random', 'surveys, chain posts and everything else', '🎲', 14, 1792886400000);

-- "please make a board for …": members ask, a moderator approves (making the board: board_id) or declines it
CREATE TABLE board_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | declined
  created    INTEGER NOT NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided    INTEGER,
  board_id   INTEGER REFERENCES boards(id)
);
CREATE INDEX board_requests_status ON board_requests (status, created);
CREATE INDEX board_requests_user ON board_requests (user_id);

-- posts.kind gains thread (a board's thread: title in `subject` up to 120 characters, a body up to 10,000) and comment
-- (in a thread, answering reply_to: the thread or another comment; root_id is the thread). Both carry board_id.
-- Threads can be sticky (first in every sort) or locked (no new comments or votes). up_count / down_count are the votes;
-- comment_count is a thread's comments that aren't deleted, however deep (reply_count stays the direct answers). hot,
-- best and score are the stored sort keys of docs/decisions/001-ranking.md, recomputed in the same batch as every write
-- that changes what they're made of (src/shared/ranking.js). Everything here is kept exact like 0003's counts.
ALTER TABLE posts ADD COLUMN board_id INTEGER REFERENCES boards(id);
ALTER TABLE posts ADD COLUMN sticky INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN up_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN down_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN hot REAL NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN best REAL NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN score REAL NOT NULL DEFAULT 0;
-- a board's threads in each sort (stickies are read apart, so sticky leads each one); every sort ties on newest first
CREATE INDEX posts_board_hot ON posts (board_id, sticky, hot DESC, created DESC, id DESC) WHERE kind = 'thread';
CREATE INDEX posts_board_new ON posts (board_id, sticky, created DESC, id DESC) WHERE kind = 'thread';
CREATE INDEX posts_board_top ON posts (board_id, sticky, score DESC, created DESC, id DESC) WHERE kind = 'thread';
CREATE INDEX posts_board_best ON posts (board_id, sticky, best DESC, created DESC, id DESC) WHERE kind = 'thread';
CREATE INDEX posts_board_last ON posts (board_id, created DESC) WHERE board_id IS NOT NULL;     -- a board's last post
-- (a thread's comments are read through posts_root: root_id, created; they're sorted into a tree in the Worker)

-- votes on threads and comments: one per person per post, up (+1) or down (-1). Never on your own post.
CREATE TABLE votes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  value   INTEGER NOT NULL CHECK (value IN (1, -1)),
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX votes_post ON votes (post_id);

-- notifications.kind gains board_approved and board_declined, about the request in request_id (a comment in a thread
-- is told as a reply, about the comment)
ALTER TABLE notifications ADD COLUMN request_id INTEGER REFERENCES board_requests(id) ON DELETE CASCADE;

-- the bulletins become threads in Random, keeping their ids, writers and times. With no votes or comments yet, hot is
-- just how new they are: (created in seconds - EPOCH) / UNIT, with 001's EPOCH 2026-01-01 and UNIT 2 days.
UPDATE posts SET kind = 'thread', board_id = (SELECT id FROM boards WHERE slug = 'random'),
  hot = (created / 1000.0 - 1767225600) / 172800.0
  WHERE kind = 'bulletin';
