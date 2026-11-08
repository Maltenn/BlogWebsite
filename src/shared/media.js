// Photos as the other features need them (the upload, serving and moderation routes are src/media/): the photos of a
// page of posts in one read, checking and attaching a member's uploads in a post's write batch, a picture of their own,
// and taking the files out of R2 when their rows go. Like notify.js, it's here because several features share it.
import { fail } from './http.js';
import { text } from './text.js';
import { followOf, blockedEither, NOT_BLOCKED, REACHABLE } from './db.js';

export const ALT_MAX = 200;                      // characters of alt text
export const LOOSE_MS = 86400000;                // an upload not attached within a day is deleted by the cron
const CLAIM_MS = 23 * 3600000;                   // (so attaching one never races the cron)

// how many photos each kind of post carries, and what they are for
export const MEDIA_LIMITS = {
  status: { max: 4, purpose: 'post' }, reply: { max: 4, purpose: 'post' }, quote: { max: 4, purpose: 'post' },
  thread: { max: 4, purpose: 'post' }, comment: { max: 1, purpose: 'post' }, blog: { max: 1, purpose: 'cover' },
};

export const mediaUrl = key => `/media/${key}`;
const KEY_RE = /^\/media\/([0-9a-f]{32}\.(?:jpg|png|gif|webp))$/;
// the R2 key in a /media/<key> address, or null
export const keyOf = url => (KEY_RE.exec(String(url ?? '')) || [])[1] || null;

// a photo as every answer shows it
export const mediaOut = r => ({ id: r.id, url: mediaUrl(r.key), width: r.width, height: r.height, alt: r.alt });

// SQL: the photos (not hidden by a moderator) on the posts in the JSON list ?1, in their order
export const MEDIA_OF = `SELECT post_id, purpose, id, key, width, height, alt FROM media
  WHERE post_id IN (SELECT value FROM json_each(?1)) AND hidden = 0 ORDER BY post_id, position`;
// SQL: the same with the hidden ones too, for a report's snapshot (only moderators read those)
export const ALL_MEDIA_OF = MEDIA_OF.replace(' AND hidden = 0', '');

// SQL: photo row `media` is held already: it's hidden (by a moderator, or a child-safety report: media.hold_hidden), or
// a moderator hid the post it's on.
const ALREADY_HELD = '(media.hidden = 1 OR EXISTS (SELECT 1 FROM posts held WHERE held.id = media.post_id AND held.hidden = 1))';
// SQL: its owner is under a child-safety hold (the view held_accounts, migrations/0014). Never NULL: a photo whose owner
// is gone must stay a plain false here, or NOT HELD would quietly keep it.
const OWNER_HELD = '(media.owner_id IS NOT NULL AND media.owner_id IN (SELECT user_id FROM held_accounts))';
// SQL: photo row `media` is held as evidence: hidden, on a post a moderator hid, its owner is under a child-safety hold
// (one a moderator confirmed), or a csam report lists it. Nothing its owner does deletes a held photo (deleting the post or the account,
// changing the picture, taking back an upload), nor does the cron; only a moderator, or the report or hold ending.
// SQL: a csam report lists it (open or confirmed), or a confirmed hold keeps it: the view held_photos
const LISTED = 'media.id IN (SELECT media_id FROM held_photos)';
export const HELD = `(${ALREADY_HELD} OR ${OWNER_HELD} OR ${LISTED})`;

// SQL statements for a batch, ahead of whatever deletes the photos matching `where` (SQL on `media`, with the batch's
// own binds `binds`): the ones kept because their owner is under a child-safety hold are listed in `evidence` and
// hidden, and the ones kept because a csam report lists them are hidden, both marked as the hold's or report's own hide
// (hold_hidden), so that its end lets exactly those go (sweepEvidence, and a dismissal, in src/safety/safety.js). The
// second and third answer their ids. For a photo nothing holds, and one already hidden, they change nothing. The member
// sees what anyone would: the photo is gone from wherever it was.
export function keepForHold(DB, where, ...binds) {
  const owner = `(${where}) AND ${OWNER_HELD} AND NOT ${ALREADY_HELD}`;
  return [
    DB.prepare(`INSERT OR IGNORE INTO evidence (user_id, source, source_id, data, created)
      SELECT owner_id, 'photo', id, json_object('key', key, 'purpose', purpose, 'post_id', post_id, 'alt', alt, 'created', created), unixepoch() * 1000
      FROM media WHERE ${owner}`).bind(...binds),
    DB.prepare(`UPDATE media SET hidden = 1, hold_hidden = 1 WHERE ${owner} RETURNING id`).bind(...binds),
    DB.prepare(`UPDATE media SET hidden = 1, hold_hidden = 1 WHERE (${where}) AND ${LISTED} AND NOT ${ALREADY_HELD} RETURNING id`).bind(...binds),
  ];
}

// SQL: a photo row with what photoAccess needs (its post's and people's columns); add the WHERE.
export const PHOTO_ROWS = `SELECT m.id, m.owner_id, m.purpose, m.mime, m.attached, m.post_id, m.hidden, m.hold_hidden, o.banned AS owner_banned,
      p.id AS p_id, p.kind AS p_kind, p.author_id AS p_author, p.deleted AS p_deleted, p.hidden AS p_hidden, p.created AS p_created,
      p.board_id AS p_board, a.banned AS a_banned, o.avatar AS owner_avatar, m.key,
      po.id AS po_id, po.banned AS po_banned, po.follow_policy AS po_policy
    FROM media m LEFT JOIN users o ON o.id = m.owner_id LEFT JOIN posts p ON p.id = m.post_id LEFT JOIN users a ON a.id = p.author_id
    LEFT JOIN users po ON po.id = COALESCE(p.target_id, p.author_id)`;

// SQL: board comment ?3 shows to viewer ?1 at ?2: its thread is there (not deleted or hidden, writer not banned, no
// block either way: the boards' THREAD_SHOWN) and so is every comment above it (REACHABLE: none hidden by a moderator,
// by someone banned or across a block)
const COMMENT_SHOWN = `SELECT 1 AS ok FROM posts p WHERE p.id = ?3 AND EXISTS (SELECT 1 FROM posts st JOIN users sa ON sa.id = st.author_id
    WHERE st.id = p.root_id AND st.deleted = 0 AND st.hidden = 0 AND sa.banned = 0 AND ${NOT_BLOCKED('st.author_id')})
  AND ${REACHABLE('p.id')}`;

// Who may see photo row `m` (a PHOTO_ROWS row): 'public' (anyone, cacheable for a few minutes), 'private' (this viewer
// only: no-store) or null (404, exactly like a photo that doesn't exist). Moderators see everything (privately), held
// evidence included. Loose uploads: their owner only. A picture: anyone while it's somebody's current picture (below). A
// post's photo: whoever may see the post (not hidden, not deleted, not dated ahead, writer and page owner not banned, no
// block either way with either, and a private profile's only for its accepted followers; board posts are public spaces,
// but a board comment's also needs its thread and every comment above it to show to the viewer, so it's never cached),
// and not hidden on its own. Serving a photo (src/media/) asks this, and so does a child-safety report, which may hide
// only what its reporter can see.
//
// "The page owner" is `o = COALESCE(p.target_id, p.author_id)`, exactly as notify() and the Notifications rule (SHOWN)
// have it: a Friends' Comment on someone's page is written by one member but lives on another's, and whether the page is
// private is the page owner's setting, not the writer's. (This used to look at the writer alone, which would have served
// a photo on a private page to the world the day `wall` was added to MEDIA_LIMITS.)
export async function photoAccess(c, m) {
  const viewer = c.user;
  if (viewer && viewer.is_admin) return 'private';
  if (m.hidden || m.owner_id == null || m.owner_banned) return null;
  if (m.attached == null) return viewer && viewer.id === m.owner_id ? 'private' : null;
  // A profile picture is PUBLIC ON PURPOSE, before any block or privacy check: it is the one photo the site shows to
  // people with no account and no relationship (GET /api/users/:name answers with it for every profile, a private one
  // too, and boards and lists show it). Serving it 'public' means anyone with the address may fetch it and, since the
  // apps' pages (capacitor://localhost) must embed it, that any website may too (CORP cross-origin, serveMedia). What that adds to "anyone may fetch it" is hotlinking
  // and the Spectre-era side channel, for an image that is already public and has a 128-bit unguessable name. What must
  // not stay public is a picture that is no longer the member's: changing it deletes the old file in the same batch
  // (avatarStatements), but this does not lean on that: only the picture that is the owner's avatar right now is served,
  // so a leftover is a 404 and cannot be hotlinked for ever. (docs/mobile/redteam.md R10)
  if (m.purpose === 'avatar') return m.owner_avatar === mediaUrl(m.key) ? 'public' : null;
  if (m.post_id == null || m.p_id == null || m.p_deleted || m.p_hidden || m.p_created > c.now || m.a_banned || m.po_banned) return null;
  if (viewer && viewer.id !== m.p_author && await blockedEither(c.env, viewer.id, m.p_author)) return null;
  if (viewer && m.po_id !== m.p_author && viewer.id !== m.po_id && await blockedEither(c.env, viewer.id, m.po_id)) return null;
  if (m.p_kind === 'comment') {
    const shown = await c.env.DB.prepare(COMMENT_SHOWN).bind(viewer ? viewer.id : 0, c.now, m.p_id).first();
    return shown ? 'private' : null;
  }
  if (m.p_board != null || m.po_policy !== 'approve') return 'public';
  if (!viewer) return null;
  if (viewer.id === m.p_author || viewer.id === m.po_id) return 'private';
  const f = await followOf(c.env, viewer.id, m.po_id);
  return f && f.status === 'accepted' ? 'private' : null;
}

// SQL statements for a batch that takes away the photos matching `where` (SQL on `media`, with the batch's own binds
// `binds`): the ones not held are deleted, answering their keys (RETURNING key) for dropObjects; the held ones leave
// their post as hidden photos, kept until a moderator removes them (or their owner's hold ends). The first statement is
// the DELETE.
export function releaseMedia(DB, where, ...binds) {
  return [
    DB.prepare(`DELETE FROM media WHERE (${where}) AND NOT ${HELD} RETURNING key`).bind(...binds),
    ...keepForHold(DB, where, ...binds),
    DB.prepare(`UPDATE media SET post_id = NULL, hidden = 1 WHERE ${where}`).bind(...binds),
  ];
}

// rows of MEDIA_OF → { media: Map(post id → [photo]), covers: Map(post id → photo) }
export function mediaByPost(rows) {
  const media = new Map(), covers = new Map();
  for (const r of rows) {
    if (r.purpose === 'cover') covers.set(r.post_id, mediaOut(r));
    else media.set(r.post_id, [...(media.get(r.post_id) || []), mediaOut(r)]);
  }
  return { media, covers };
}

// The photos a new post of `kind` asks for (`raw`: the body's `media`, a list of upload ids or { id, alt }), checked:
// at most the kind's limit, each the writer's own upload for that purpose, not attached to anything yet and not about
// to be cleaned up. Answers [{ id, alt }] in the order given ([] for none). The attach itself is attachStatements(), in
// the post's write batch, where the database makes sure an upload is attached only once.
export async function claimMedia(c, kind, raw) {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return [];
  const rule = MEDIA_LIMITS[kind];
  if (!rule) fail(400, 'photos can\'t go here.');
  if (!Array.isArray(raw) || raw.length > rule.max) fail(400, rule.max === 1 ? `one ${rule.purpose === 'cover' ? 'cover photo' : 'photo'} at most here.` : `up to ${rule.max} photos.`);
  const want = raw.map(x => (typeof x === 'object' && x ? { id: x.id, alt: x.alt } : { id: x, alt: '' }))
    .map(x => ({ id: Number.isSafeInteger(x.id) && x.id > 0 ? x.id : null, alt: text(x.alt, ALT_MAX) }));
  if (want.some(x => !x.id)) fail(400, 'that isn\'t a photo you uploaded.');
  if (new Set(want.map(x => x.id)).size !== want.length) fail(400, 'that photo is in there twice.');
  const { results } = await c.env.DB.prepare('SELECT id, owner_id, purpose, attached, created, hidden FROM media WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(want.map(x => x.id))).all();
  const byId = new Map(results.map(r => [r.id, r]));
  for (const x of want) {
    const m = byId.get(x.id);
    // (a hidden upload is held, or taken back and kept for a hold: for its owner it is as gone as a deleted one)
    if (!m || m.owner_id !== c.user.id || m.hidden) fail(400, 'that isn\'t a photo you uploaded.');
    if (m.purpose !== rule.purpose) fail(400, rule.purpose === 'cover' ? 'upload the cover as a cover photo.' : 'that upload isn\'t a post photo.');
    if (m.attached != null) fail(409, 'that photo is already on another post. upload it again.');
    if (m.created < c.now - CLAIM_MS) fail(410, 'that upload expired. upload the photo again.');
  }
  return want;
}

// SQL statements attaching `claimed` (from claimMedia) to the post that `userId` just wrote at `now` (`fresh`: the SQL
// for its id, which reads ?1 and ?2) while `still` holds, in its write batch. A second attach of the same upload makes
// the whole batch fail (the media_attach_once trigger): see attachFailed.
export function attachTo(DB, userId, now, claimed, fresh, still) {
  return claimed.map((x, i) => DB.prepare(`UPDATE media SET post_id = ${fresh}, attached = ?2, position = ?3, alt = ?4
    WHERE id = ?5 AND owner_id = ?1 AND ${still}`).bind(userId, now, i, x.alt, x.id));
}

// is this error a batch that tried to attach an upload twice?
export const attachFailed = e => /media already attached/.test(String(e && e.message));

// Takes these R2 objects out of the bucket (keys from a DELETE … RETURNING key). A failure is logged, not thrown: the
// rows are already gone, and the post or account with them. (Awaited, not left to waitUntil: the answer comes once
// the files are gone.)
export async function dropObjects(env, keys) {
  const list = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < list.length; i += 1000) {
    try { await env.MEDIA.delete(list.slice(i, i + 1000)); } catch (e) { console.error('R2 delete failed:', list.slice(i, i + 1000), (e && e.stack) || e); }
  }
}

// the keys answered by DELETE … RETURNING key statements, from their results in a batch
export const keysIn = (...results) => results.flatMap(r => (r && r.results ? r.results.map(x => x.key) : []));

// The member's own uploaded picture at `url` (a /media/ address), fit to be their profile picture: { id, key, attached }
// or null when it isn't one (someone else's, not uploaded as a picture, hidden by a moderator, gone).
export async function ownAvatar(c, url) {
  const key = keyOf(url);
  if (!key) return null;
  return c.env.DB.prepare('SELECT id, key, attached FROM media WHERE key = ? AND owner_id = ? AND purpose = \'avatar\' AND hidden = 0')
    .bind(key, c.user.id).first();
}

// SQL statements for the batch that sets a member's picture, after the UPDATE of users.avatar: attach upload `id` (none
// for a preset) if it really is the picture now, and delete every picture they uploaded that no longer is (unless it's
// held as evidence: a moderator hid it, or their child-safety hold keeps it), answering their keys (RETURNING key) for
// dropObjects. Whatever ran before, the member ends with one uploaded picture at most, besides held ones.
export function avatarStatements(DB, userId, now, id) {
  const current = '(SELECT avatar FROM users WHERE id = ?1)';
  const old = `media.owner_id = ?1 AND media.purpose = 'avatar' AND media.attached IS NOT NULL AND media.hidden = 0 AND '/media/' || media.key IS NOT ${current}`;
  return [
    id && DB.prepare(`UPDATE media SET attached = ?2 WHERE id = ?3 AND owner_id = ?1 AND attached IS NULL AND '/media/' || key = ${current}`).bind(userId, now, id),
    ...keepForHold(DB, old, userId),
    DB.prepare(`DELETE FROM media WHERE ${old} RETURNING key`).bind(userId),
  ].filter(Boolean);
}
