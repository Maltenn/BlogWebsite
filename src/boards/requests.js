// Asking for a new board. Boards are curated: a member asks (a name and why), a moderator approves it (which makes the
// board, at the end of the index) or declines it, and the member is told either way.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText, line } from '../shared/text.js';
import { REF_COLS, ref, limit, NOT_BLOCKED } from '../shared/db.js';
import { boardOut } from './boards.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;          // a board's address: /boards/<slug>
const RESERVED = ['requests'];                                   // (POST /api/boards/requests)
const ICON = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const DEFAULT_ICON = '💬';

const out = r => ({ id: r.id, name: r.name, reason: r.reason, status: r.status, created: r.created, decided: r.decided });
// a board's address made from its name: "Movies & TV" → movies-tv
const slugOf = name => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

// POST /api/boards/requests { name, reason } — ask for a board: a name up to 40 characters and why, up to 500.
// 3 a day. Answers 201 { request }.
export async function requestBoard(c) {
  const b = await readBody(c.req);
  const name = text(b.name, 40);
  const reason = longText(b.reason, 500);
  if (!name) fail(400, 'what should the board be called?');
  await limit(c, 'board_request:' + c.user.id, [[3, 86400000]], 'you\'ve asked for plenty of boards today.');
  const r = await c.env.DB.prepare('INSERT INTO board_requests (user_id, name, reason, created) VALUES (?, ?, ?, ?) RETURNING *')
    .bind(c.user.id, name, reason, c.now).first();
  return json({ request: out(r) }, 201);
}

// GET /api/admin/board-requests?status=open|closed — waiting requests (oldest first), or the last 100 decided (newest
// first): { requests: [{ id, name, reason, status, created, decided, user, decidedBy, board }] }
export async function boardRequests(c) {
  const open = c.url.searchParams.get('status') !== 'closed';
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, ${REF_COLS('u', 'u_')}, d.name AS decider, b.slug AS b_slug, b.name AS b_name, b.icon AS b_icon
    FROM board_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN boards b ON b.id = r.board_id
    WHERE ${open ? 'r.status = \'pending\' ORDER BY r.created ASC, r.id ASC' : 'r.status != \'pending\' ORDER BY r.decided DESC, r.id DESC'} LIMIT 100`).all();
  return json({
    requests: results.map(r => ({
      ...out(r), user: ref(r, 'u_'), decidedBy: r.decider || null,
      board: r.b_slug ? { slug: r.b_slug, name: r.b_name, icon: r.b_icon } : null,
    })),
  });
}

// POST /api/admin/board-requests/:id { action: approve | decline, slug?, name?, icon?, description? } — approving makes
// the board: `name` (default: the one asked for), `slug` (default: made from the name; 1–30 lower-case letters, digits
// and dashes), `icon` (an emoji, default 💬) and `description` (up to 140). The member who asked is told. Answers
// { request, board } (board null when declined).
export async function decideBoardRequest(c) {
  const b = await readBody(c.req);
  const DB = c.env.DB;
  const r = await DB.prepare('SELECT * FROM board_requests WHERE id = ?').bind(int(c.params.id, 0)).first();
  if (!r) fail(404, 'no such request.');
  if (!['approve', 'decline'].includes(b.action)) fail(400, 'approve or decline?');
  if (r.status !== 'pending') fail(409, 'that request was already decided.');
  const approve = b.action === 'approve';
  const made = {};
  if (approve) {
    made.name = text(b.name, 40) || r.name;
    made.slug = b.slug == null || b.slug === '' ? slugOf(made.name) : String(b.slug).trim().toLowerCase();
    if (!SLUG.test(made.slug) || RESERVED.includes(made.slug)) fail(400, 'the address can be up to 30 lower-case letters, numbers and dashes.');
    made.icon = b.icon == null || b.icon === '' ? DEFAULT_ICON : line(b.icon, 8);
    if (!ICON.test(made.icon)) fail(400, 'the icon has to be an emoji.');
    made.description = text(b.description, 140);
    if (await DB.prepare('SELECT 1 AS x FROM boards WHERE slug = ?').bind(made.slug).first()) fail(409, 'there\'s already a board at that address.');
  }
  // all of it only while the request is still waiting, so two moderators deciding at once decide it once
  const status = approve ? 'approved' : 'declined';
  const pending = 'EXISTS (SELECT 1 FROM board_requests WHERE id = ?1 AND status = \'pending\')';
  let res;
  try {
    res = await DB.batch([
      approve && DB.prepare(`INSERT INTO boards (slug, name, description, icon, position, created)
        SELECT ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position), 0) + 1 FROM boards), ?6 WHERE ${pending}`)
        .bind(r.id, made.slug, made.name, made.description, made.icon, c.now),
      DB.prepare(`UPDATE board_requests SET status = ?2, decided_by = ?3, decided = ?4, board_id = (SELECT id FROM boards WHERE slug = ?5)
        WHERE id = ?1 AND status = 'pending'`).bind(r.id, status, c.user.id, c.now, made.slug ?? null),
      DB.prepare(`INSERT INTO notifications (user_id, kind, actor_id, request_id, created)
        SELECT user_id, ?2, ?3, id, ?4 FROM board_requests WHERE id = ?1 AND status = ?5 AND decided_by = ?3 AND decided = ?4
          AND user_id != ?3 AND ${NOT_BLOCKED('user_id', '?3')}`).bind(r.id, approve ? 'board_approved' : 'board_declined', c.user.id, c.now, status),
      DB.prepare('SELECT * FROM board_requests WHERE id = ?').bind(r.id),
      DB.prepare('SELECT slug, name, description, icon, archived FROM boards WHERE id = (SELECT board_id FROM board_requests WHERE id = ?)').bind(r.id),
    ].filter(Boolean));
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) fail(409, 'there\'s already a board at that address.');
    throw e;
  }
  const [after, board] = res.slice(-2).map(x => x.results[0]);
  if (after.decided_by !== c.user.id || after.decided !== c.now) fail(409, 'that request was already decided.');
  await DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, created) VALUES (?, ?, \'board_request\', ?, ?)')
    .bind(c.user.id, approve ? 'approve_board' : 'decline_board', r.id, c.now).run();
  return json({ request: out(after), board: board ? boardOut(board) : null });
}
