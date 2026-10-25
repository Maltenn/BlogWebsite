// Migration tests: `npm test`. Builds a database the way 0001_init.sql left it (friend requests, blocks, "became friends"
// and "joined" lines in the feed), applies 0002_follows.sql on top, and checks what became of everything; then adds posts
// and applies 0003_interactions.sql. Uses wrangler's local D1 (run through node, like the API tests) on a throwaway folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
