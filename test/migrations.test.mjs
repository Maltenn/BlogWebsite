// Migration tests: `npm test`. Builds a database the way 0001_init.sql left it (friend requests, blocks, "became friends"
// and "joined" lines in the feed), applies 0002_follows.sql on top, and checks what became of everything; then adds posts
// and applies 0003_interactions.sql, then adds bulletins and applies 0004_boards.sql, then 0005_media.sql (photos: the
// attach-once trigger and what happens to photos when their post or owner goes), then 0006 and 0007_chat.sql (the 1:1
// messages become DMs; the 50-member cap of a group), then 0008_browse.sql (the launch boards' interest terms), then 0009_trust.sql (everyone there counts as verified). Uses wrangler's local D1 (run through
// node, like the API tests) on a throwaway folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hot } from '../src/shared/ranking.js';
import { validTerm } from '../src/browse/score.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-migrate-'));

const d1 = args => JSON.parse(execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'ourspace-social-db', '--local', '--persist-to', STATE, '--json', ...args],
  { cwd: ROOT, stdio: 'pipe' }).toString());
const apply = file => d1(['--file', path.join(ROOT, 'migrations', file)]);
// several statements in one go (every wrangler start takes a couple of seconds): the rows each one returned
const sql = (...statements) => d1(['--command', statements.join(';\n')]).map(r => r.results);

after(async () => {
  // Windows lets go of the database files a moment after wrangler ends
  for (let i = 0; ; i++) {
    try { fs.rmSync(STATE, { recursive: true, force: true }); break; } catch (e) {
      if (i === 20) { console.warn(`could not remove ${STATE}: ${e.code}`); break; }
      await new Promise(r => setTimeout(r, 250));
    }
  }
});

test('0002 turns friendships into follows (not between people who block each other), drops the wall setting and clears the old feed lines', () => {
  apply('0001_init.sql');
  sql(`INSERT INTO users (id, name, name_key, email, avatar, birthdate, wall_policy, created) VALUES
      (1, 'ann', 'ann', 'ann@example.com', '/a.png', '1990-01-01', 'friends', 1000),
      (2, 'ben', 'ben', 'ben@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (3, 'cat', 'cat', 'cat@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (4, 'dan', 'dan', 'dan@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (5, 'eve', 'eve', 'eve@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (6, 'fay', 'fay', 'fay@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (7, 'gus', 'gus', 'gus@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (8, 'hal', 'hal', 'hal@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (9, 'ivy', 'ivy', 'ivy@example.com', '/a.png', '1990-01-01', 'everyone', 1000),
      (10, 'jon', 'jon', 'jon@example.com', '/a.png', '1990-01-01', 'everyone', 1000)`,
    `INSERT INTO friendships (a, b, status, requested_by, created, accepted) VALUES
      (1, 2, 'accepted', 2, 2000, 2500),
      (1, 3, 'pending', 3, 3000, NULL),
      (2, 4, 'pending', 2, 4000, NULL),
      (5, 6, 'accepted', 5, 5000, 5500),
      (7, 8, 'accepted', 7, 6000, 6500),
      (9, 10, 'pending', 10, 7000, NULL)`,
    `INSERT INTO blocks (blocker_id, blocked_id, created) VALUES
      (5, 6, 8000),
      (8, 7, 8000),
      (9, 10, 8000)`,
    `INSERT INTO posts (id, kind, author_id, target_id, body, created) VALUES
      (1, 'joined', 1, NULL, '', 1000), (2, 'friends', 2, 1, '', 2500), (3, 'status', 1, NULL, 'hello', 2600),
      (4, 'wall', 2, 1, 'hi ann', 2700), (5, 'friends', 4, 3, '', 2800)`);

  apply('0002_follows.sql');

  const [follows, tables, posts, userCols, policies, postCols] = sql(
    'SELECT follower_id, followee_id, status, created, accepted FROM follows ORDER BY follower_id, followee_id',
    'SELECT COUNT(*) AS n FROM sqlite_master WHERE name = \'friendships\'',
    'SELECT id, kind FROM posts ORDER BY id',
    'SELECT name FROM pragma_table_info(\'users\')',
    'SELECT DISTINCT follow_policy AS p FROM users',
    'SELECT name FROM pragma_table_info(\'posts\')');
  assert.deepEqual(follows, [
    { follower_id: 1, followee_id: 2, status: 'accepted', created: 2000, accepted: 2500 },   // friends follow each other,
    { follower_id: 2, followee_id: 1, status: 'accepted', created: 2000, accepted: 2500 },   // keeping when they became friends
    { follower_id: 2, followee_id: 4, status: 'accepted', created: 4000, accepted: 4000 },   // a waiting request: the asker follows
    { follower_id: 3, followee_id: 1, status: 'accepted', created: 3000, accepted: 3000 },
  ], 'and nothing for friends or a waiting request with a block between them, whichever way it points (5-6, 7-8, 9-10)');
  assert.equal(tables[0].n, 0, 'friendships is gone');
  assert.deepEqual(posts, [{ id: 3, kind: 'status' }, { id: 4, kind: 'wall' }], 'no "friends" or "joined" lines');
  assert.ok(userCols.some(r => r.name === 'follow_policy') && !userCols.some(r => r.name === 'wall_policy'));
  assert.deepEqual(policies, [{ p: 'open' }], 'everybody starts open');
  assert.ok(postCols.some(r => r.name === 'subtitle'));

  assert.throws(() => sql('INSERT INTO follows (follower_id, followee_id, status, created) VALUES (2, 2, \'accepted\', 5000)'), 'nobody follows themselves');
  const [, , , follows1, markers] = sql(
    'INSERT INTO markers (user_id, name, last_created, last_id, updated) VALUES (1, \'feed\', 2600, 3, 5000)',
    'DELETE FROM posts WHERE author_id = 1 OR target_id = 1',
    'DELETE FROM users WHERE id = 1',
    'SELECT COUNT(*) AS n FROM follows WHERE 1 IN (follower_id, followee_id)',
    'SELECT COUNT(*) AS n FROM markers');
  assert.equal(follows1[0].n, 0, 'an account\'s follows go with it');
  assert.equal(markers[0].n, 0, 'and its markers');
});

// (continues with the database the test above left: ann is gone, ben, cat, dan and the rest are still there)
test('0003 adds replies, quotes, reposts, likes, bookmarks, mentions, tags and notifications to the posts already there', () => {
  sql(`INSERT INTO posts (id, kind, author_id, target_id, subject, body, created) VALUES
    (10, 'status', 2, NULL, NULL, 'from before 0003', 9000), (11, 'blog', 3, NULL, 'a title', 'a blog post', 9100), (12, 'wall', 3, 2, NULL, 'hi ben', 9200)`);

  apply('0003_interactions.sql');

  const [posts, tables] = sql(
    'SELECT id, kind, body, reply_to, root_id, quote_of, like_count, reply_count, repost_count, quote_count, deleted FROM posts ORDER BY id',
    'SELECT name FROM sqlite_master WHERE type = \'table\' AND name IN (\'likes\', \'bookmarks\', \'mentions\', \'post_tags\', \'notifications\') ORDER BY name');
  const fresh = { reply_to: null, root_id: null, quote_of: null, like_count: 0, reply_count: 0, repost_count: 0, quote_count: 0, deleted: 0 };
  assert.deepEqual(posts, [
    { id: 10, kind: 'status', body: 'from before 0003', ...fresh },
    { id: 11, kind: 'blog', body: 'a blog post', ...fresh },
    { id: 12, kind: 'wall', body: 'hi ben', ...fresh },
  ], 'every post stays, with nothing counted yet');
  assert.deepEqual(tables.map(t => t.name), ['bookmarks', 'likes', 'mentions', 'notifications', 'post_tags']);

  sql(`INSERT INTO posts (id, kind, author_id, body, reply_to, root_id, quote_of, created) VALUES
      (20, 'reply', 3, 'a reply', 10, 10, NULL, 9500), (21, 'reply', 4, 'a reply to the reply', 20, 10, NULL, 9600),
      (22, 'repost', 3, '', NULL, NULL, 10, 9700), (23, 'quote', 4, 'look', NULL, NULL, 10, 9800)`,
    'INSERT INTO likes (user_id, post_id, created) VALUES (3, 10, 9900), (4, 10, 9900)',
    'INSERT INTO bookmarks (user_id, post_id, created) VALUES (3, 10, 9900)',
    'INSERT INTO mentions (post_id, user_id) VALUES (10, 3), (20, 2)',
    'INSERT INTO post_tags (tag, post_id, created) VALUES (\'y2k\', 10, 9000)',
    'INSERT INTO notifications (user_id, kind, actor_id, post_id, created) VALUES (2, \'like\', 3, 10, 9900), (2, \'follow\', 4, NULL, 9900)');
  assert.throws(() => sql('INSERT INTO posts (kind, author_id, quote_of, created) VALUES (\'repost\', 3, 10, 9950)'), 'one repost per person per post');
  assert.throws(() => sql('INSERT INTO likes (user_id, post_id, created) VALUES (3, 10, 9950)'), 'and one like');

  // deleting a post outright (as deleting its writer's account does; the API's delete keeps a tombstone while it has
  // replies) takes everything about it along, and its quotes and reposts let go of it; its replies keep pointing at it
  // (reply_to and root_id aren't foreign keys), so they stay in their conversation. Deleting an account takes its likes,
  // bookmarks and mentions
  const [, after, gone, , , left] = sql(
    'DELETE FROM posts WHERE id = 10',
    'SELECT id, reply_to, root_id, quote_of FROM posts WHERE id >= 20 ORDER BY id',
    `SELECT (SELECT COUNT(*) FROM likes) + (SELECT COUNT(*) FROM bookmarks) + (SELECT COUNT(*) FROM post_tags)
      + (SELECT COUNT(*) FROM notifications WHERE post_id IS NOT NULL) + (SELECT COUNT(*) FROM mentions WHERE post_id = 10) AS n`,
    'DELETE FROM posts WHERE author_id = 4',
    'DELETE FROM users WHERE id = 4',
    'SELECT COUNT(*) AS n FROM notifications');
  assert.deepEqual(after, [
    { id: 20, reply_to: 10, root_id: 10, quote_of: null }, { id: 21, reply_to: 20, root_id: 10, quote_of: null },
    { id: 22, reply_to: null, root_id: null, quote_of: null }, { id: 23, reply_to: null, root_id: null, quote_of: null },
  ]);
  assert.equal(gone[0].n, 0);
  assert.equal(left[0].n, 0, 'the follow notification from the account went with it');
});

// (continues: ben, cat and the rest; posts 11 and 12 are still there)
test('0004 makes the boards, moves the bulletins into Random as threads, and adds votes and board requests', () => {
  sql(`INSERT INTO posts (id, kind, author_id, subject, body, created, hidden) VALUES
    (30, 'bulletin', 2, 'TAKE THIS SURVEY', 'copy and paste!!', 1767312000000, 0), (31, 'bulletin', 3, 'free layouts', 'ask me', 1700000000000, 1)`);

  apply('0004_boards.sql');

  const [boards, posts, cols] = sql(
    'SELECT slug, name, icon, position, archived FROM boards ORDER BY position',
    'SELECT id, kind, author_id, board_id, subject, body, created, hidden, sticky, locked, up_count, down_count, comment_count, hot, best, score FROM posts WHERE id IN (11, 12, 30, 31) ORDER BY id',
    "SELECT name FROM pragma_table_info('notifications') WHERE name = 'request_id'");
  assert.deepEqual(boards.map(b => b.slug), ['music', 'movies-tv', 'games', 'art-layouts', 'cooking', 'pets', 'sports', 'tech', 'fashion',
    'books-writing', 'astrology', 'school', 'advice', 'random'], 'the 14 curated boards, in order');
  assert.deepEqual(boards.find(b => b.slug === 'movies-tv'), { slug: 'movies-tv', name: 'Movies & TV', icon: '🎬', position: 2, archived: 0 });
  const random = sql("SELECT id FROM boards WHERE slug = 'random'")[0][0].id;
  const zero = { sticky: 0, locked: 0, up_count: 0, down_count: 0, comment_count: 0, best: 0, score: 0 };
  assert.deepEqual(posts, [
    { id: 11, kind: 'blog', author_id: 3, board_id: null, subject: 'a title', body: 'a blog post', created: 9100, hidden: 0, ...zero, hot: 0 },
    { id: 12, kind: 'wall', author_id: 3, board_id: null, subject: null, body: 'hi ben', created: 9200, hidden: 0, ...zero, hot: 0 },
    { id: 30, kind: 'thread', author_id: 2, board_id: random, subject: 'TAKE THIS SURVEY', body: 'copy and paste!!', created: 1767312000000, hidden: 0, ...zero, hot: 0.5 },
    { id: 31, kind: 'thread', author_id: 3, board_id: random, subject: 'free layouts', body: 'ask me', created: 1700000000000, hidden: 1, ...zero, hot: hot(0, 0, 0, 1700000000000) },
  ], 'the bulletins are threads in Random, keeping their ids, writers, times and words (and a hidden one stays hidden), sorted by how new they are');
  assert.equal(sql("SELECT COUNT(*) AS n FROM posts WHERE kind = 'bulletin'")[0][0].n, 0);
  assert.equal(cols.length, 1);

  sql(`INSERT INTO posts (id, kind, author_id, board_id, body, reply_to, root_id, created) VALUES (40, 'comment', 5, ${random}, 'me first', 30, 30, 1767400000000)`,
    'INSERT INTO votes (user_id, post_id, value, created) VALUES (3, 30, 1, 1767400000000), (5, 30, -1, 1767400000000), (2, 40, 1, 1767400000000)',
    "INSERT INTO board_requests (id, user_id, name, reason, created) VALUES (1, 6, 'Knitting', 'yarn!!', 1767400000000)",
    "INSERT INTO notifications (user_id, kind, actor_id, request_id, created) VALUES (6, 'board_declined', 2, 1, 1767400000000)");
  assert.throws(() => sql('INSERT INTO votes (user_id, post_id, value, created) VALUES (3, 30, -1, 1)'), 'one vote per person per post');
  assert.throws(() => sql('INSERT INTO votes (user_id, post_id, value, created) VALUES (6, 30, 2, 1)'), 'a vote is +1 or -1');
  const [, , , left] = sql(
    'DELETE FROM posts WHERE id = 40',
    'DELETE FROM users WHERE id = 6',
    'DELETE FROM users WHERE id = 3',
    `SELECT (SELECT COUNT(*) FROM votes) AS votes, (SELECT COUNT(*) FROM board_requests) AS requests,
      (SELECT COUNT(*) FROM notifications WHERE request_id IS NOT NULL) AS told`);
  assert.deepEqual(left[0], { votes: 1, requests: 0, told: 0 }, 'votes go with their post or their voter (only eve\'s on 30 is left), requests and their answers with the member');
});

test('0005 adds photos: an upload is attached once, a post or an owner that goes leaves them for the cron, and a hidden post holds them', () => {
  apply('0005_media.sql');
  const key = n => `${String(n).repeat(32)}.png`;
  sql("INSERT INTO users (id, name, name_key, email, avatar, birthdate, created) VALUES (52, 'kim', 'kim', 'kim@example.com', '/a.png', '1990-01-01', 1000), (54, 'lou', 'lou', 'lou@example.com', '/a.png', '1990-01-01', 1000)",
    "INSERT INTO posts (id, kind, author_id, body, created) VALUES (50, 'status', 52, 'look', 4000)",
    "INSERT INTO posts (id, kind, author_id, body, created, hidden) VALUES (51, 'status', 52, 'held', 4000, 1)");
  sql(`INSERT INTO media (id, key, owner_id, purpose, mime, bytes, width, height, created) VALUES
    (1, '${key(1)}', 52, 'post', 'image/png', 100, 10, 10, 5000), (2, '${key(2)}', 52, 'post', 'image/png', 100, 10, 10, 5000),
    (3, '${key(3)}', 54, 'avatar', 'image/png', 100, 300, 300, 5000), (4, '${key(4)}', 52, 'post', 'image/png', 100, 10, 10, 5000)`);
  assert.throws(() => sql(`INSERT INTO media (key, owner_id, purpose, mime, bytes, width, height, created) VALUES ('x.png', 52, 'video', 'video/mp4', 1, 1, 1, 1)`),
    'photos only: a purpose is post, cover or avatar');
  sql('UPDATE media SET post_id = 50, attached = 6000, position = 0 WHERE id = 1');
  assert.throws(() => sql('UPDATE media SET post_id = 50, attached = 7000 WHERE id = 1'), e => /media already attached/.test(String(e.stdout)), 'an upload is attached once');
  sql('UPDATE media SET alt = \'a cat\' WHERE id = 1', 'UPDATE media SET hidden = 1 WHERE id = 1', 'UPDATE media SET post_id = 51, attached = 6000 WHERE id = 4');
  const [, , , rows] = sql('DELETE FROM posts WHERE id = 50', 'DELETE FROM posts WHERE id = 51', 'DELETE FROM users WHERE id = 54',
    'SELECT id, owner_id, post_id, attached, alt, hidden FROM media ORDER BY id');
  assert.deepEqual(rows, [
    { id: 1, owner_id: 52, post_id: null, attached: 6000, alt: 'a cat', hidden: 1 },
    { id: 2, owner_id: 52, post_id: null, attached: null, alt: '', hidden: 0 },
    { id: 3, owner_id: null, post_id: null, attached: null, alt: '', hidden: 0 },
    { id: 4, owner_id: 52, post_id: null, attached: 6000, alt: '', hidden: 1 },
  ], 'post 50 went without taking its photo: post_id falls to NULL (the cron then deletes it); the avatar outlives its owner '
    + 'only until the cron; the photo on post 51, which a moderator hid, is held as a hidden photo');
});

// (continues: ben (2), eve (5), gus (7), hal (8) and the others are still there; 0001's messages table was never touched)
test('0007 turns the 1:1 messages into DMs, keeping ids, times, read state, hidden ones and reports, then drops them', () => {
  apply('0006_media_review.sql');
  sql(`INSERT INTO messages (id, from_id, to_id, body, created, read_at, hidden) VALUES
      (101, 2, 5, 'hi eve', 10000, 10500, 0),
      (102, 5, 2, 'hi ben', 11000, NULL, 0),
      (103, 2, 5, 'you there?', 12000, NULL, 0),
      (104, 7, 2, 'spam spam', 13000, NULL, 1),
      (105, 2, 7, 'stop', 14000, 14100, 0),
      (106, 8, 5, 'yo', 15000, 15500, 0),
      (107, 9, 5, 'evidence', 15800, NULL, 0),
      (108, 9, 2, 'more evidence', 15900, NULL, 0)`,
    `INSERT INTO reports (id, reporter_id, target_type, target_id, target_user_id, reason, snapshot, created) VALUES
      (1, 2, 'message', 104, 7, 'spam', '{"body":"spam spam"}', 13500),
      (2, 5, 'message', 107, 9, 'harassment', '{"body":"evidence"}', 15850),
      (3, 2, 'message', 108, 9, 'harassment', '{"body":"more evidence"}', 15950)`,
    // the newest messages go before the move (their writer's account was deleted): only the reports remember them
    'DELETE FROM messages WHERE id IN (107, 108)');

  apply('0007_chat.sql');

  // new messages get ids no old message ever had, so the reports of the gone ones still point at nothing
  const [made, reported] = sql("INSERT INTO chat_messages (room, author_id, body, created) VALUES ('ourspace', 2, 'brand new', 30000) RETURNING id",
    "SELECT r.id, m.id AS message FROM reports r LEFT JOIN chat_messages m ON m.id = r.target_id WHERE r.target_type = 'message' ORDER BY r.id");
  assert.equal(made[0].id, 109, 'the counter carries on from the old messages\' (108), not from the highest id left (106)');
  assert.deepEqual(reported, [{ id: 1, message: 104 }, { id: 2, message: null }, { id: 3, message: null }], 'reports of gone messages resolve to nothing');
  sql('DELETE FROM chat_messages WHERE id = 109');

  const [convs, members, msgs, gone, report] = sql(
    'SELECT id, kind, created_by, created, last_message_at, dm_key FROM conversations ORDER BY id',
    'SELECT conversation_id AS c, user_id AS u, role, status, joined, last_read_id AS r FROM conversation_members ORDER BY conversation_id, user_id',
    'SELECT id, conversation_id AS c, room, author_id AS a, body, created, hidden, deleted FROM chat_messages ORDER BY id',
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'messages'",
    "SELECT r.target_type, m.body FROM reports r JOIN chat_messages m ON m.id = r.target_id WHERE r.id = 1");
  assert.deepEqual(convs, [
    { id: 1, kind: 'dm', created_by: 2, created: 10000, last_message_at: 12000, dm_key: '2:5' },
    { id: 2, kind: 'dm', created_by: 7, created: 13000, last_message_at: 14000, dm_key: '2:7' },
    { id: 3, kind: 'dm', created_by: 8, created: 15000, last_message_at: 15000, dm_key: '5:8' },
  ], 'one DM per pair, started by whoever wrote first');
  const m = (c, u, r) => ({ c, u, role: 'member', status: 'joined', joined: convs[c - 1].created, r });
  assert.deepEqual(members, [
    m(1, 2, 101),               // ben never read eve's 102: what came before it is read
    m(1, 5, 102),               // eve read 101 but not 103 (her own 102 sits between)
    m(2, 2, 103),               // the hidden 104 was unread
    m(2, 7, 105),               // gus had read everything: up to the newest
    m(3, 5, 106), m(3, 8, 106),
  ], 'both people in each, and what they had read stays read');
  assert.deepEqual(msgs.map(x => [x.id, x.c, x.a, x.created, x.hidden]), [
    [101, 1, 2, 10000, 0], [102, 1, 5, 11000, 0], [103, 1, 2, 12000, 0], [104, 2, 7, 13000, 1], [105, 2, 2, 14000, 0], [106, 3, 8, 15000, 0],
  ], 'every message keeps its id, writer, time and hidden mark');
  assert.ok(msgs.every(x => x.room === null && x.deleted === 0));
  assert.equal(gone[0].n, 0, 'messages is gone');
  assert.deepEqual(report, [{ target_type: 'message', body: 'spam spam' }], 'the report points at the same message');

  // a group holds 50 at most (joined and invited together), however the rows come
  sql("INSERT INTO conversations (id, kind, created_by, created) VALUES (10, 'group', 2, 20000)",
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
      INSERT INTO users (id, name, name_key, avatar, birthdate, created) SELECT 1000 + i, 'f' || i, 'f' || i, '/a.png', '1990-01-01', 1 FROM n`,
    "INSERT INTO conversation_members (conversation_id, user_id, status, joined) SELECT 10, id, 'joined', 1 FROM users WHERE id > 1000",
    "INSERT INTO conversation_members (conversation_id, user_id, status, joined) VALUES (10, 2, 'left', 1)");
  assert.throws(() => sql("INSERT INTO conversation_members (conversation_id, user_id, status, joined) VALUES (10, 5, 'invited', 1)"),
    e => /group full/.test(String(e.stdout)), 'the 51st');
  assert.throws(() => sql("UPDATE conversation_members SET status = 'joined' WHERE conversation_id = 10 AND user_id = 2"),
    e => /group full/.test(String(e.stdout)), 'or someone coming back');
  assert.throws(() => sql("INSERT INTO chat_messages (conversation_id, room, author_id, body, created) VALUES (1, 'ourspace', 2, 'x', 1)"), 'a conversation or the room, not both');
  assert.throws(() => sql("INSERT INTO conversations (kind, created) VALUES ('dm', 1)"), 'a DM has its pair');

  // an account that goes takes its memberships, messages and scores
  sql('INSERT INTO affinity (from_id, to_id, eff, updated) VALUES (8, 5, 2, 1), (5, 8, 1, 1)', 'DELETE FROM users WHERE id = 8');
  const [left] = sql(`SELECT (SELECT COUNT(*) FROM conversation_members WHERE user_id = 8) + (SELECT COUNT(*) FROM chat_messages WHERE author_id = 8)
    + (SELECT COUNT(*) FROM affinity WHERE 8 IN (from_id, to_id)) AS n`);
  assert.equal(left[0].n, 0);
});

test('0008 gives each launch board its interest terms (each a term moderators could have typed), and a "not interested" list that goes with its member', () => {
  apply('0008_browse.sql');
  const [per, bad, total] = sql("SELECT b.slug, COUNT(t.term) AS n FROM boards b LEFT JOIN board_terms t ON t.board_id = b.id WHERE b.id <= 14 GROUP BY b.id ORDER BY b.position",
    'SELECT term FROM board_terms WHERE weight != 1', 'SELECT term FROM board_terms');
  assert.deepEqual(per.map(r => r.slug), ['music', 'movies-tv', 'games', 'art-layouts', 'cooking', 'pets', 'sports', 'tech', 'fashion', 'books-writing', 'astrology', 'school', 'advice', 'random']);
  assert.ok(per.every(r => r.n >= 7), JSON.stringify(per));
  assert.deepEqual(bad, [], 'all at weight 1');
  assert.deepEqual(total.filter(r => validTerm(r.term) !== r.term), [], 'stored the way the admin route stores them');
  sql("INSERT INTO browse_hidden (user_id, kind, ref_id, created) VALUES (2, 'person', 5, 1), (2, 'board', 1, 1), (5, 'post', 3, 1)");
  assert.throws(() => sql("INSERT INTO browse_hidden (user_id, kind, ref_id, created) VALUES (2, 'thing', 1, 1)"), 'person, board or post');
  sql('DELETE FROM users WHERE id = 2');
  assert.deepEqual(sql('SELECT user_id, kind, ref_id FROM browse_hidden')[0], [{ user_id: 5, kind: 'post', ref_id: 3 }]);
});

test('0009 counts everyone already there as verified and not held, and its tables go with their member', () => {
  apply('0009_trust.sql');
  const [users] = sql('SELECT id, created, email_verified_at, held, held_reason, ai_exempt_until FROM users ORDER BY id');
  assert.ok(users.length >= 5);
  assert.ok(users.every(u => u.email_verified_at === u.created && u.held === 0 && u.held_reason === null && u.ai_exempt_until === null), JSON.stringify(users));
  sql(`INSERT INTO signup_signals (user_id, ip_group_hash, asn, risk, reasons, created) VALUES (5, 'h', 16509, 4, '["hosting_network"]', 1)`,
    `INSERT INTO ai_strikes (user_id, level, text, score, created, expires) VALUES (5, 1, 'x', 0.99, 1, 2)`,
    'INSERT INTO posting_timeouts (user_id, strike_id, until) VALUES (5, 1, 3)',
    `INSERT INTO mod_alerts (kind, key, payload, created) VALUES ('held_signup', 'user:5', '{}', 1)`);
  assert.throws(() => sql(`INSERT INTO mod_alerts (kind, key, payload, created) VALUES ('held_signup', 'user:5', '{}', 2)`), 'one open alert per key');
  assert.throws(() => sql(`INSERT INTO ai_strikes (user_id, level, text, score, created, expires, status) VALUES (5, 1, 'x', 0.9, 1, 2, 'maybe')`));
  sql('DELETE FROM users WHERE id = 5');
  const [signals, strikes, timeouts] = sql('SELECT COUNT(*) AS n FROM signup_signals', 'SELECT COUNT(*) AS n FROM ai_strikes', 'SELECT COUNT(*) AS n FROM posting_timeouts');
  assert.deepEqual([signals[0].n, strikes[0].n, timeouts[0].n], [0, 0, 0]);
});
