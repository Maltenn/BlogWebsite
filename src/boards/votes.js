// Votes on board threads and comments: like (+1) or dislike (-1), both counted and shown, one per person per post,
// switched or taken back at will. Never on your own post, never on a deleted or hidden one, in a locked thread or an
// archived board, or on one the voter can't reach in its thread (the thread or a comment above it hidden, by someone
// banned, or across a block: REACHABLE), and nobody is told. The counts and the stored sort keys move in the same batch as the vote, and only when the vote
// really changes, so they stay exact.
import { fail, json, readBody, int } from '../shared/http.js';
import { limit, VISIBLE, REACHABLE } from '../shared/db.js';
import { RESORT } from '../shared/ranking.js';
import { OPEN } from './boards.js';

// PUT /api/posts/:id/vote { value: 1 | -1 | 0 } — like, dislike, or take my vote back. Answers { vote, up, down }.
// 300 an hour (taking one back is free).
export async function votePost(c) {
  const { value } = await readBody(c.req);
  if (![1, -1, 0].includes(value)) fail(400, 'vote 1 (like), -1 (dislike) or 0 (take it back).');
  const me = c.user.id;
  const DB = c.env.DB;
  const p = await DB.prepare(`SELECT p.id, p.author_id, ${OPEN('p.id')} AS open, b.archived, COALESCE((SELECT value FROM votes WHERE user_id = ?1 AND post_id = p.id), 0) AS vote
    FROM posts p JOIN users a ON a.id = p.author_id JOIN boards b ON b.id = p.board_id
    WHERE p.id = ?3 AND p.kind IN ('thread', 'comment') AND ${VISIBLE} AND ${REACHABLE('p.id')}`).bind(me, c.now, int(c.params.id, 0)).first();
  if (!p) fail(404, 'that post is gone.');
  if (p.author_id === me) fail(400, 'you can\'t vote on your own post.');
  if (!p.open) fail(403, p.archived ? 'this board is archived.' : 'this thread is locked.');
  if (value) await limit(c, 'vote:' + me, [[300, 3600000]], 'that\'s a lot of voting. take a breather.');
  // Every statement holds only while my vote is still the one read above and the post still takes votes, so two votes
  // at once, or a delete or a lock at the same moment, can't move the counts without the vote (or the other way round).
  const still = `COALESCE((SELECT value FROM votes WHERE user_id = ?1 AND post_id = ?2), 0) = ?3 AND ${OPEN('?2')}`;
  const res = await DB.batch([
    value !== p.vote && DB.prepare(`UPDATE posts SET up_count = up_count + ?4, down_count = down_count + ?5 WHERE id = ?2 AND ${still}`)
      .bind(me, p.id, p.vote, (value === 1) - (p.vote === 1), (value === -1) - (p.vote === -1)),
    DB.prepare(`UPDATE posts SET ${RESORT} WHERE id = ?`).bind(p.id),
    value !== p.vote && (value
      ? DB.prepare(`INSERT INTO votes (user_id, post_id, value, created) SELECT ?1, ?2, ?4, ?5 WHERE ${still}
          ON CONFLICT (user_id, post_id) DO UPDATE SET value = excluded.value, created = excluded.created`).bind(me, p.id, p.vote, value, c.now)
      : DB.prepare(`DELETE FROM votes WHERE user_id = ?1 AND post_id = ?2 AND ${still}`).bind(me, p.id, p.vote)),
    DB.prepare(`SELECT up_count, down_count, deleted, hidden, COALESCE((SELECT value FROM votes WHERE user_id = ?1 AND post_id = ?2), 0) AS vote
      FROM posts WHERE id = ?2`).bind(me, p.id),
  ].filter(Boolean));
  const now = res.at(-1).results[0];
  if (!now || now.deleted || now.hidden) fail(404, 'that post is gone.');
  return json({ vote: now.vote, up: now.up_count, down: now.down_count });
}
