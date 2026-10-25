// The Notifications tab: likes, replies, reposts, quotes, @mentions, Friends' Comments on your page, and follows. They
// are written where those things happen (notify() in shared/notify.js); this reads them. How far you've read is your
// 'notifications' marker (PUT /api/me/markers/notifications, in social.js).
import { json, int } from '../shared/http.js';
import { REF_COLS, ref, lite } from '../shared/db.js';
import { SHOWN, UNREAD } from '../shared/notify.js';

const PER = 30;

// GET /api/notifications?before= — newest first, 30 a page. Each says who did it (actor), the post it's about in brief
// (a Friends' Comment's also says whose page it's on), and whether it's newer than my marker (unread). `unread` is how
// many are, up to 99. The cursor is "<created>:<id>".
export async function notifications(c) {
  const before = int(String(c.url.searchParams.get('before') || '').split(':').pop(), Number.MAX_SAFE_INTEGER);
  const DB = c.env.DB;
  const [rows, count] = await DB.batch([
    DB.prepare(`SELECT n.id, n.kind, n.created, ${UNREAD} AS unread, ${REF_COLS('x', 'x_')}, p.id AS p_id, p.kind AS p_kind,
        p.created AS p_created, p.subject AS p_subject, p.subtitle AS p_subtitle, p.body AS p_body, p.deleted AS p_deleted, ${REF_COLS('a', 'p_a_')}, ${REF_COLS('o', 'o_')}
      FROM ${SHOWN} AND n.id < ?2 ORDER BY n.id DESC LIMIT ${PER + 1}`).bind(c.user.id, before),
    DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${SHOWN} AND ${UNREAD} LIMIT 99)`).bind(c.user.id),
  ]);
  const shown = rows.results.slice(0, PER);
  const last = shown[shown.length - 1];
  return json({
    items: shown.map(r => ({
      id: r.id, kind: r.kind, created: r.created, actor: ref(r, 'x_'),
      post: r.p_id == null ? null : { ...lite(r, 'p_'), ...(r.p_kind === 'wall' ? { page: ref(r, 'o_') } : {}) },
      unread: !!r.unread,
    })),
    next: rows.results.length > PER ? `${last.created}:${last.id}` : null,
    unread: count.results[0].n,
  });
}
