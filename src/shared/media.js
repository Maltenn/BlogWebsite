// Photos as the other features need them (the upload, serving and moderation routes are src/media/): the photos of a
// page of posts in one read, checking and attaching a member's uploads in a post's write batch, a picture of their own,
// and taking the files out of R2 when their rows go. Like notify.js, it's here because several features share it.
import { fail } from './http.js';
import { text } from './text.js';

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

// SQL: photo row `media` is held as evidence: a moderator hid it, or the post it's on. Nothing its owner does deletes
// a held photo (deleting the post or the account, changing the picture), nor does the cron; only a moderator's remove.
export const HELD = '(media.hidden = 1 OR EXISTS (SELECT 1 FROM posts held WHERE held.id = media.post_id AND held.hidden = 1))';

// SQL statements for a batch that takes away the photos matching `where` (SQL on `media`, with the batch's own binds
// `binds`): the ones not held are deleted, answering their keys (RETURNING key) for dropObjects; the held ones leave
// their post as hidden photos, kept until a moderator removes them. The first statement is the DELETE.
export function releaseMedia(DB, where, ...binds) {
  return [
    DB.prepare(`DELETE FROM media WHERE (${where}) AND NOT ${HELD} RETURNING key`).bind(...binds),
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
  const { results } = await c.env.DB.prepare('SELECT id, owner_id, purpose, attached, created FROM media WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(want.map(x => x.id))).all();
  const byId = new Map(results.map(r => [r.id, r]));
  for (const x of want) {
    const m = byId.get(x.id);
    if (!m || m.owner_id !== c.user.id) fail(400, 'that isn\'t a photo you uploaded.');
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
// for a preset) if it really is the picture now, and delete every picture they uploaded that no longer is (unless a
// moderator hid it: that one is held as evidence), answering their keys (RETURNING key) for dropObjects. Whatever ran
// before, the member ends with one uploaded picture at most, besides held ones.
export function avatarStatements(DB, userId, now, id) {
  const current = '(SELECT avatar FROM users WHERE id = ?1)';
  return [
    id && DB.prepare(`UPDATE media SET attached = ?2 WHERE id = ?3 AND owner_id = ?1 AND attached IS NULL AND '/media/' || key = ${current}`).bind(userId, now, id),
    DB.prepare(`DELETE FROM media WHERE owner_id = ?1 AND purpose = 'avatar' AND attached IS NOT NULL AND hidden = 0 AND '/media/' || key IS NOT ${current}
      RETURNING key`).bind(userId),
  ].filter(Boolean);
}
