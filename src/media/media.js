// Photos: uploading one (checked, its metadata taken out, stored in R2 under a random key), serving /media/<key> to
// whoever may see it, a member taking back an upload they didn't use, moderators hiding or removing a photo at once, and
// the cron's sweep of loose uploads. Attaching photos to posts and pictures is in src/shared/media.js, with the features
// that write them. The owner dropped video: photos only. See docs/architecture.md, "Photos".
import { fail, json, int, readBody } from '../shared/http.js';
import { text } from '../shared/text.js';
import { limit, followOf, blockedEither, NOT_BLOCKED, REACHABLE, REF_COLS, ref } from '../shared/db.js';
import { mediaUrl, dropObjects, keysIn, LOOSE_MS } from '../shared/media.js';
import { AVATARS } from '../catalog/avatars.js';
import { sniff, BadImage } from './sniff.js';
import { strip } from './strip.js';

export const MAX_BYTES = 2 * 1024 * 1024;        // per file, as uploaded (it only shrinks when stripped)
export const MAX_SIDE = 4096;                    // pixels per side
export const MAX_MOVING = 800;                   // an animated GIF (or WebP) is at most 800 × 800
export const AVATAR_SIDE = 300;                  // a profile picture is square, at most 300 × 300
export const STORAGE_CAP = 200 * 1024 * 1024;    // what one member may keep in all
export const UPLOAD_LIMITS = [[30, 3600000], [150, 86400000]];
const PURPOSES = ['post', 'cover', 'avatar'];
// the types an upload may say it is (image/jpg: what some browsers and tools call a JPEG)
const MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const sameType = (declared, mime) => declared === mime || (declared === 'image/jpg' && mime === 'image/jpeg');

// The uploaded file's bytes: the raw body (Content-Type: the image's type) or the one file of a multipart form. Refuses
// anything over MAX_BYTES before reading more of it than that.
async function fileBytes(req) {
  const type = (req.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  const declared = Number(req.headers.get('Content-Length') || 0);
  const tooBig = () => fail(413, 'that photo is too big: 2 MB at most.');
  if (type === 'multipart/form-data') {
    if (!declared || declared > MAX_BYTES + 64 * 1024) tooBig();
    let form;
    try { form = await req.formData(); } catch { fail(400, 'that upload didn\'t arrive in one piece.'); }
    const files = [...form.values()].filter(v => typeof v === 'object' && v && typeof v.arrayBuffer === 'function');
    if (files.length !== 1) fail(400, 'send one photo at a time.');
    // (a part typed application/octet-stream, or not typed at all, declares nothing: the bytes say what it is)
    const part = (files[0].type || '').toLowerCase().split(';')[0].trim();
    const said = part === 'application/octet-stream' ? '' : part;
    if (said && !MIMES.has(said)) fail(415, 'photos only: JPEG, PNG, GIF or WebP.');
    if (files[0].size > MAX_BYTES) tooBig();
    return { bytes: new Uint8Array(await files[0].arrayBuffer()), declared: said };
  }
  if (!MIMES.has(type)) fail(415, 'photos only: JPEG, PNG, GIF or WebP.');
  if (declared > MAX_BYTES) tooBig();
  if (!req.body) fail(400, 'there\'s no photo in that upload.');
  const parts = [];
  let n = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { await reader.cancel().catch(() => {}); tooBig(); }
    parts.push(value);
  }
  const bytes = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { bytes.set(p, i); i += p.length; }
  return { bytes, declared: type };
}

// 128 random bits as 32 hex digits
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');

// POST /api/media?purpose=post|cover|avatar — one photo, as the raw body (Content-Type: image/jpeg, png, gif or webp)
// or the one file of a multipart form. The server reads what it really is (JPEG, PNG, GIF or WebP; never SVG, HTML or
// anything else), checks its size (2 MB, 4096 px a side, an animated one 800; a picture 300px square), takes out its
// metadata and stores it under a random key. 30 an hour, 150 a day, 200 MB per member in all. It's loose until it's
// attached (a post's `media`, a blog post's cover, PUT /api/me/profile { avatar: url }) and gone after a day if it never
// is. Answers 201 { media: { id, url, width, height, mime } }.
export async function uploadMedia(c) {
  const purpose = c.url.searchParams.get('purpose') || 'post';
  if (!PURPOSES.includes(purpose)) fail(400, 'purpose is post, cover or avatar.');
  await limit(c, 'upload:' + c.user.id, UPLOAD_LIMITS, 'that\'s a lot of photos. try again in a while.');
  const { bytes, declared } = await fileBytes(c.req);
  if (!bytes.length) fail(400, 'there\'s no photo in that upload.');
  let info, clean;
  try {
    info = sniff(bytes);
    clean = strip(bytes);
    const again = sniff(clean);                                // what's stored must still be a whole picture of the same size
    if (again.width !== info.width || again.height !== info.height) throw new BadImage('broken', 'changed size');
  } catch (e) {
    if (!(e instanceof BadImage)) throw e;
    if (e.reason === 'type') fail(415, /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 64))) ? 'pictures only: SVG and web pages can\'t be uploaded.'
      : 'photos only: JPEG, PNG, GIF or WebP. (iPhone HEIC photos: export them as JPEG first.)');
    fail(400, 'that picture looks broken or cut off. try saving it again.');
  }
  if (declared && !sameType(declared, info.mime)) fail(415, 'that file isn\'t the kind of picture it says it is.');
  if (info.width > MAX_SIDE || info.height > MAX_SIDE) fail(400, `that picture is too large: ${MAX_SIDE} pixels a side at most.`);
  if (info.animated && (info.width > MAX_MOVING || info.height > MAX_MOVING)) fail(400, `animated pictures can be ${MAX_MOVING} × ${MAX_MOVING} at most.`);
  if (purpose === 'avatar' && (info.width !== info.height || info.width > AVATAR_SIDE)) fail(400, `a profile picture is square, ${AVATAR_SIDE} × ${AVATAR_SIDE} at most.`);
  const used = await c.env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM media WHERE owner_id = ?').bind(c.user.id).first();
  if (used.n + clean.length > STORAGE_CAP) fail(413, 'you\'ve used all 200 MB of your photo space. delete some posts with photos to make room.');
  const key = `${randomKey()}.${info.ext}`;
  await c.env.MEDIA.put(key, clean, { httpMetadata: { contentType: info.mime } });
  let row;
  try {
    row = await c.env.DB.prepare(`INSERT INTO media (key, owner_id, purpose, mime, bytes, width, height, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`).bind(key, c.user.id, purpose, info.mime, clean.length, info.width, info.height, c.now).first();
  } catch (e) {
    await dropObjects(c.env, [key]);
    throw e;
  }
  return json({ media: { id: row.id, url: mediaUrl(key), width: info.width, height: info.height, mime: info.mime } }, 201);
}

// DELETE /api/media/:id — take back an upload of mine that isn't on anything yet (the ✕ in a composer). Answers { ok }.
export async function deleteUpload(c) {
  const gone = await c.env.DB.prepare('DELETE FROM media WHERE id = ? AND owner_id = ? AND attached IS NULL AND hidden = 0 RETURNING key')
    .bind(int(c.params.id, 0), c.user.id).first();
  if (!gone) fail(404, 'that upload is gone (or already on a post).');
  await dropObjects(c.env, [gone.key]);
  return json({ ok: true });
}

/* ----------------------------------------------------------- serving */

// Public photos are cached for 5 minutes, then revalidated (ETag → 304): long enough to spare the Worker repeat reads,
// short enough that a profile going private, a block, a ban or a moderator's hide reaches browsers within minutes. (A
// year's immutable caching would keep serving a photo from the browser's cache after its access was taken away.)
const PUBLIC = 'public, max-age=300';
const PRIVATE = 'private, no-store';
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'default-src \'none\'; sandbox',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};
const notFound = () => new Response('not found', { status: 404, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// SQL: board comment ?3 shows to viewer ?1 at ?2: its thread is there (not deleted or hidden, writer not banned, no
// block either way: the boards' THREAD_SHOWN) and so is every comment above it (REACHABLE: none hidden by a moderator,
// by someone banned or across a block)
const COMMENT_SHOWN = `SELECT 1 AS ok FROM posts p WHERE p.id = ?3 AND EXISTS (SELECT 1 FROM posts st JOIN users sa ON sa.id = st.author_id
    WHERE st.id = p.root_id AND st.deleted = 0 AND st.hidden = 0 AND sa.banned = 0 AND ${NOT_BLOCKED('st.author_id')})
  AND ${REACHABLE('p.id')}`;

// Who may see photo row `m` (with its post's and people's columns): 'public' (anyone, cacheable for a few minutes),
// 'private' (this viewer only: no-store) or null (404, exactly like a photo that doesn't exist). Moderators see
// everything (privately), held evidence included. Loose uploads: their owner only. A picture: anyone while it's
// somebody's current picture (below). A post's photo: whoever may see the post (not hidden, not deleted, not dated ahead,
// writer and page owner not banned, no block either way with either, and a private profile's only for its accepted
// followers; board posts are public spaces, but a board comment's also needs its thread and every comment above it to
// show to the viewer, so it's never cached), and not hidden on its own by a moderator.
//
// "The page owner" is `o = COALESCE(p.target_id, p.author_id)`, exactly as notify() and the Notifications rule (SHOWN)
// have it: a Friends' Comment on someone's page is written by one member but lives on another's, and whether the page is
// private is the page owner's setting, not the writer's. (This used to look at the writer alone, which would have served
// a photo on a private page to the world the day `wall` was added to MEDIA_LIMITS in src/shared/media.js.)
async function access(c, m) {
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

// GET (or HEAD) /media/:key — the photo, with the type the server read from it, nosniff, inline, and a CSP that lets
// nothing in it run. Public ones are cached for 5 minutes, then revalidated with their ETag (304 while the viewer may
// still see it); private ones never.
export async function serveMedia(c, key) {
  if (!/^[0-9a-f]{32}\.(jpg|png|gif|webp)$/.test(key)) return notFound();
  const m = await c.env.DB.prepare(`SELECT m.id, m.owner_id, m.purpose, m.mime, m.attached, m.post_id, m.hidden, o.banned AS owner_banned,
      p.id AS p_id, p.kind AS p_kind, p.author_id AS p_author, p.deleted AS p_deleted, p.hidden AS p_hidden, p.created AS p_created,
      p.board_id AS p_board, a.banned AS a_banned, o.avatar AS owner_avatar, m.key,
      po.id AS po_id, po.banned AS po_banned, po.follow_policy AS po_policy
    FROM media m LEFT JOIN users o ON o.id = m.owner_id LEFT JOIN posts p ON p.id = m.post_id LEFT JOIN users a ON a.id = p.author_id
    LEFT JOIN users po ON po.id = COALESCE(p.target_id, p.author_id)
    WHERE m.key = ?`).bind(key).first();
  const seen = m && await access(c, m);
  if (!seen) return notFound();
  const cache = seen === 'public' ? PUBLIC : PRIVATE;
  // A public photo is readable by anyone with no credentials at all, so keeping other sites from embedding it protects
  // nothing, and the apps (pages from capacitor://localhost, https://localhost) embed it: cross-origin. A private one (this
  // viewer's session decided) stays same-origin; an app reads those with fetch and its token, which CORP doesn't govern.
  const base = seen === 'public' ? { ...BASE_HEADERS, 'Cross-Origin-Resource-Policy': 'cross-origin' } : BASE_HEADERS;
  const asked = seen === 'public' && c.req.headers.get('If-None-Match');
  const obj = c.req.method === 'HEAD' || asked ? await c.env.MEDIA.head(key) : await c.env.MEDIA.get(key);
  if (!obj) return notFound();
  if (asked && asked.split(',').map(t => t.trim().replace(/^W\//, '')).includes(obj.httpEtag)) {
    return new Response(null, { status: 304, headers: { ...base, 'Cache-Control': cache, ETag: obj.httpEtag } });
  }
  const body = c.req.method === 'HEAD' ? null : asked ? (await c.env.MEDIA.get(key))?.body : obj.body;
  if (body === undefined) return notFound();
  return new Response(body, {
    headers: {
      ...base,
      'Content-Type': m.mime,
      'Content-Length': String(obj.size),
      'Content-Disposition': 'inline',
      'Cache-Control': cache,
      ETag: obj.httpEtag,
    },
  });
}

/* -------------------------------------------------------- moderators */

const QUEUE_PAGE = 30;

// GET /api/admin/media?before=<id>&filter=unreviewed|all — the photo review queue: every upload, attached or loose,
// newest first, 30 a page (`next`: the `before` for the following page, or null). Each is { id, url, width, height, alt,
// purpose, created, hidden, reviewed, reviewedAt, reviewedBy, uploader: { id, name, avatar, created } | null (the
// account is gone), where } with `created` the upload's time and the uploader's the account's (its age). `where`: null
// for a loose upload, else { type: avatar | cover | post | thread | comment | gone, id, author, board, thread }: the post
// (its author's name, and for board posts the board's slug and the thread's id), or `gone` for a held photo whose post
// was deleted. The default filter is unreviewed.
export async function adminMedia(c) {
  const all = c.url.searchParams.get('filter') === 'all';
  const before = int(c.url.searchParams.get('before'), 0);
  const { results } = await c.env.DB.prepare(`SELECT m.id, m.key, m.purpose, m.width, m.height, m.alt, m.created, m.hidden, m.attached, m.post_id,
      m.reviewed_at, rb.name AS reviewer, ${REF_COLS('o', 'o_')}, o.created AS o_created,
      p.kind AS p_kind, p.root_id AS p_root, pa.name AS p_author, b.slug AS b_slug
    FROM media m LEFT JOIN users o ON o.id = m.owner_id LEFT JOIN users rb ON rb.id = m.reviewed_by
    LEFT JOIN posts p ON p.id = m.post_id LEFT JOIN users pa ON pa.id = p.author_id LEFT JOIN boards b ON b.id = p.board_id
    WHERE (?1 = 0 OR m.id < ?1) AND (?2 = 0 OR m.reviewed_at IS NULL) ORDER BY m.id DESC LIMIT ?3`)
    .bind(before, all ? 0 : 1, QUEUE_PAGE + 1).all();
  const page = results.slice(0, QUEUE_PAGE);
  const where = m => {
    if (m.attached == null) return null;
    if (m.purpose === 'avatar') return { type: 'avatar', author: m.o_name };
    if (m.post_id == null || m.p_kind == null) return { type: 'gone' };
    const type = m.p_kind === 'blog' ? 'cover' : m.p_kind === 'thread' || m.p_kind === 'comment' ? m.p_kind : 'post';
    return { type, id: m.post_id, author: m.p_author, board: m.b_slug || null, thread: m.p_kind === 'comment' ? m.p_root : m.p_kind === 'thread' ? m.post_id : null };
  };
  return json({
    media: page.map(m => ({
      id: m.id, url: mediaUrl(m.key), width: m.width, height: m.height, alt: m.alt, purpose: m.purpose, created: m.created, hidden: !!m.hidden,
      reviewed: m.reviewed_at != null, reviewedAt: m.reviewed_at, reviewedBy: m.reviewer || null,
      uploader: m.o_id == null ? null : { ...ref(m, 'o_'), created: m.o_created }, where: where(m),
    })),
    next: results.length > QUEUE_PAGE ? page[page.length - 1].id : null,
  });
}

// POST /api/admin/media/:id { action: reviewed | remove | hide | unhide, note } — reviewed: a moderator has seen the photo
// (who and when are kept; marking one twice keeps the first; not in the moderation log, which is for what changes
// things). remove: the photo is deleted from R2 and its row at once (a Take It Down request, or anything that must not
// stay up a minute longer); if it was someone's picture, they're back to the default one. hide / unhide: it stops (or
// starts again) showing anywhere, kept as evidence. The last three land in the moderation log. Answers { ok }.
export async function moderateMedia(c) {
  const b = await readBody(c.req);
  const id = int(c.params.id, 0);
  const DB = c.env.DB;
  const action = b.action;
  if (!['reviewed', 'remove', 'hide', 'unhide'].includes(action)) fail(400, 'action is reviewed, remove, hide or unhide.');
  if (action === 'reviewed') {
    const seen = await DB.prepare('UPDATE media SET reviewed_by = ?, reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL RETURNING id').bind(c.user.id, c.now, id).first();
    if (!seen && !await DB.prepare('SELECT 1 AS x FROM media WHERE id = ?').bind(id).first()) fail(404, 'that photo is already gone.');
    return json({ ok: true });
  }
  // (logged only while the photo is there: the log goes first in each batch)
  const log = DB.prepare(`INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created)
    SELECT ?1, ?2, 'media', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM media WHERE id = ?3)`)
    .bind(c.user.id, action === 'remove' ? 'remove_media' : action, id, text(b.note, 300), c.now);
  if (action === 'remove') {
    const m = await DB.prepare('SELECT key, owner_id FROM media WHERE id = ?').bind(id).first();
    if (!m) fail(404, 'that photo is already gone.');
    const res = await DB.batch([
      log,
      DB.prepare('UPDATE users SET avatar = ? WHERE id = ? AND avatar = ?').bind(AVATARS[0].file, m.owner_id, mediaUrl(m.key)),
      DB.prepare('DELETE FROM media WHERE id = ? RETURNING key').bind(id),
    ]);
    const keys = keysIn(res[2]);
    if (!keys.length) fail(404, 'that photo is already gone.');
    await dropObjects(c.env, keys);
    return json({ ok: true });
  }
  const [, r] = await DB.batch([log, DB.prepare('UPDATE media SET hidden = ? WHERE id = ? RETURNING id').bind(action === 'hide' ? 1 : 0, id)]);
  if (!r.results.length) fail(404, 'that photo is already gone.');
  return json({ ok: true });
}

/* -------------------------------------------------------------- cron */

// The cron's part: uploads still loose after a day, photos whose post went without them (post_id fell to NULL) and
// photos whose owner's account went without them (owner_id fell to NULL) leave the table and R2. Hidden ones are held
// as evidence and stay until a moderator removes them (or unhides them, which lets them go here).
export async function sweepMedia(env, now) {
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM media WHERE attached IS NULL AND created < ? AND hidden = 0 RETURNING key').bind(now - LOOSE_MS),
    env.DB.prepare(`DELETE FROM media WHERE hidden = 0 AND ((attached IS NOT NULL AND post_id IS NULL AND purpose != 'avatar') OR owner_id IS NULL)
      RETURNING key`),
  ]);
  await dropObjects(env, keysIn(...res));
}
