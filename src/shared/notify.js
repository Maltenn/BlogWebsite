// Notifications: written in the same batch as whatever they are about (by the features where things happen), and the
// rule for which ones still show (read by the Notifications tab and the badge in GET /api/me).
import { NOT_BLOCKED, SEES_POST, REACHABLE } from './db.js';

// The statement (for a batch) telling each of `to` (user ids) that the logged-in user did `kind`. `post` is what it's
// about: a post id, SQL for a post written earlier in the same batch (JUST_WRITTEN), or null. `when` is SQL that must
// hold too (?1 is the actor, ?5 a post id given as a number, t.value the person told). Nobody hears about their own
// doings, nothing crosses a block either way, and nobody hears about a post they may not see: one that's deleted or
// hidden, whose writer or page (`o`: a Friends' Comment's page owner, else the writer) has a block with them either way,
// or whose page is private to them (board threads and comments are public). null when `to` is empty.
export function notify(c, kind, to, post = null, when = '1') {
  if (!to.length) return null;
  const about = typeof post === 'number' ? '?5' : post;
  return c.env.DB.prepare(`INSERT INTO notifications (user_id, kind, actor_id, post_id, created)
    SELECT t.value, ?3, ?1, ${about ? 'p.id' : 'NULL'}, ?2 FROM json_each(?4) t
    ${about ? `JOIN posts p ON p.id = ${about} JOIN users o ON o.id = COALESCE(p.target_id, p.author_id)` : ''}
    WHERE t.value != ?1 AND ${NOT_BLOCKED('t.value')}
      ${about ? `AND p.deleted = 0 AND p.hidden = 0 AND o.banned = 0 AND ${NOT_BLOCKED('p.author_id', 't.value')} AND ${NOT_BLOCKED('o.id', 't.value')}
      AND ${SEES_POST('p', 'o', 't.value')}` : ''} AND (${when})`)
    .bind(c.user.id, c.now, kind, JSON.stringify(to), ...(typeof post === 'number' ? [post] : []));
}

// SQL: the notifications `n` to user ?1 that still show: the actor `x` isn't banned and has no block with them either
// way, and the post, if there is one (`p` by `a`, on the page of `o`: a Friends' Comment's page owner, else the author),
// is still there for them to see (neither its writer nor its page banned or blocked either way; a board comment's
// thread and the comments above it too, so hiding a thread or a comment silences what was told about the comments
// under it). Also joined: the
// post's board `pb`, and for a board request's answer the request `q` and the board it made `qb`. Everything after
// FROM; it ends inside the WHERE, so more conditions can follow.
export const SHOWN = `notifications n JOIN users x ON x.id = n.actor_id
  LEFT JOIN posts p ON p.id = n.post_id LEFT JOIN users a ON a.id = p.author_id
  LEFT JOIN users o ON o.id = COALESCE(p.target_id, p.author_id) LEFT JOIN boards pb ON pb.id = p.board_id
  LEFT JOIN board_requests q ON q.id = n.request_id LEFT JOIN boards qb ON qb.id = q.board_id
  WHERE n.user_id = ?1 AND x.banned = 0 AND ${NOT_BLOCKED('n.actor_id')}
    AND (n.post_id IS NULL OR (p.hidden = 0 AND p.deleted = 0 AND a.banned = 0 AND o.banned = 0
      AND ${NOT_BLOCKED('p.author_id')} AND ${NOT_BLOCKED('o.id')} AND ${SEES_POST('p', 'o')}
      AND (p.kind != 'comment' OR ${REACHABLE('p.id', '?1', null)})))`;

// SQL: user ?1 hasn't seen notification `n` yet (it's newer than their 'notifications' marker)
export const UNREAD = 'n.id > COALESCE((SELECT last_id FROM markers WHERE user_id = ?1 AND name = \'notifications\'), 0)';
