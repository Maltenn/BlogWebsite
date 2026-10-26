// The same text pushed by several new accounts (docs/decisions/003, layer 2, with the owner's rule): every public post
// of 8 words or more gets a fingerprint (minhash.js; no text kept, 7 days). When a new account (under 30 days old)
// posts something that 2 or more other new accounts posted in the last 24 hours, the threshold is crossed: the
// moderators get a `duplicate` alert listing the copies. The post that crosses it (and every later copy) is held
// (posts.hidden = 2, "waiting for a moderator") only when the accounts look related (`related` below); the copies
// written before the threshold are never held, so nobody can get a stranger's original taken down by copying it twice.
// A hold is its own state, not a moderator's hide (hidden = 1): the alert records which posts it held, a release shows
// only those again, and a post a moderator hid (a report, CSAM, intimate images) stays hidden whatever the alert says.
// Nothing else happens to the accounts. Older accounts quoting a meme together are never held (the nightly check still
// notices: clusters.js).
import { sha256Hex } from '../shared/http.js';
import { words, minhash, bands, nearDuplicate, MIN_WORDS } from './minhash.js';

export const NEW_ACCOUNT_MS = 30 * 86400000;
export const DUP_OTHERS = 2;            // other new accounts with the same text before the alert (and maybe a hold)
export const YOUNG_MS = 3 * 86400000;   // "all young": every account in the group signed up in the last 3 days
export const HELD = 2;                  // posts.hidden for a post held as duplicate text (1: hidden by a moderator)
const WINDOW = 86400000;

// The fingerprint of `text` for the post the logged-in member is about to write, and what to do about it:
// { sig, bands, textHash, words, matches: [{ post_id, user_id }], alert, hold }, or null for a short text. Matches are
// other new accounts' copies from the last 24 hours that are still up or held (never deleted ones, never posts a
// moderator hid). alert: the threshold is crossed with this post; hold: and the accounts look related.
export async function screenPost(c, text) {
  const ws = words(text);
  if (ws.length < MIN_WORDS) return null;
  const fp = { sig: minhash(ws), textHash: (await sha256Hex(ws.join(' '))).slice(0, 32), words: ws.length };
  fp.bands = bands(fp.sig);
  const { results } = await c.env.DB.prepare(`SELECT f.post_id, f.user_id, f.simhash AS signature, f.text_hash, f.words, u.created AS u_created
    FROM post_fingerprints f JOIN users u ON u.id = f.user_id JOIN posts p ON p.id = f.post_id
    WHERE f.created > ?2 AND f.user_id != ?1 AND (f.text_hash = ?3 OR f.b0 = ?4 OR f.b1 = ?5 OR f.b2 = ?6 OR f.b3 = ?7)
      AND p.deleted = 0 AND p.hidden IN (0, ${HELD}) LIMIT 300`)
    .bind(c.user.id, c.now - WINDOW, fp.textHash, ...fp.bands).all();
  fp.matches = results
    .filter(r => r.u_created > c.now - NEW_ACCOUNT_MS && nearDuplicate(fp, { sig: r.signature, textHash: r.text_hash }))
    .map(r => ({ post_id: r.post_id, user_id: r.user_id }));
  const others = [...new Set(fp.matches.map(m => m.user_id))];
  fp.alert = !c.user.is_admin && c.user.created > c.now - NEW_ACCOUNT_MS && others.length >= DUP_OTHERS;
  fp.hold = fp.alert && await related(c, others);
  return fp;
}

// Do the writer and the other accounts with the same text look like one operator? Yes when the writer signed up from
// the same network (IPv4 address, IPv6 /64) or the same provider (ASN) as DUP_OTHERS or more of them, or when every one
// of them (the writer too) signed up in the last YOUNG_MS. Otherwise strangers happen to share a text (a meme, a
// chain post, somebody copied): a moderator gets the alert and nothing is held.
export async function related(c, others) {
  const ids = [c.user.id, ...others];
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.created, s.ip_group_hash, s.asn FROM users u
    LEFT JOIN signup_signals s ON s.user_id = u.id WHERE u.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  const me = results.find(r => r.id === c.user.id);
  const rest = results.filter(r => r.id !== c.user.id);
  if (results.length === ids.length && results.every(r => r.created > c.now - YOUNG_MS)) return true;
  if (!me) return false;
  const near = rest.filter(r => (me.ip_group_hash && r.ip_group_hash === me.ip_group_hash) || (me.asn && r.asn === me.asn));
  return near.length >= DUP_OTHERS;
}

// the statement (for writePost's batch) that keeps the new post's fingerprint. `post`: SQL for its id; `still`: SQL
// that must hold for the post to be written at all.
export function fingerprintStatement(c, fp, post, still) {
  return c.env.DB.prepare(`INSERT INTO post_fingerprints (post_id, user_id, simhash, b0, b1, b2, b3, text_hash, words, created)
    SELECT ${post}, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?2 WHERE ${still}`)
    .bind(c.user.id, c.now, fp.sig, ...fp.bands, fp.textHash, fp.words);
}

// After a post that crossed the threshold is written (held already when fp.hold: writePost wrote it with hidden =
// HELD): the moderators' alert lists it and the earlier copies, and `held` records exactly the posts this alert held
// (only ever the post just written, never an earlier copy). An open alert about any of the same posts grows instead
// of a new one starting.
export async function holdCopies(c, postId, fp) {
  const DB = c.env.DB;
  const posts = [postId, ...fp.matches.map(m => m.post_id)];
  const users = [...new Set([c.user.id, ...fp.matches.map(m => m.user_id)])];
  const held = fp.hold ? [postId] : [];
  const open = await DB.prepare(`SELECT id, payload FROM mod_alerts WHERE kind = 'duplicate' AND resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM json_each(mod_alerts.payload, '$.posts') j WHERE j.value IN (SELECT value FROM json_each(?))) LIMIT 1`)
    .bind(JSON.stringify(posts)).first();
  if (open) {
    let p = {};
    try { p = JSON.parse(open.payload); } catch { /* start over */ }
    const merged = {
      posts: [...new Set([...(p.posts || []), ...posts])], users: [...new Set([...(p.users || []), ...users])],
      held: [...new Set([...(p.held || []), ...held])],
    };
    await DB.prepare('UPDATE mod_alerts SET payload = ? WHERE id = ?').bind(JSON.stringify(merged), open.id).run();
  } else {
    await DB.prepare('INSERT OR IGNORE INTO mod_alerts (kind, key, payload, created) VALUES (\'duplicate\', ?, ?, ?)')
      .bind('post:' + postId, JSON.stringify({ posts, users, held }), c.now).run();
  }
}

// A moderator's release of a duplicate alert: shows again exactly the posts it held that are still held (never one a
// moderator hid since, never a post it didn't hold). → the ids shown again
export async function releaseHeld(env, alertPayload) {
  const ids = Array.isArray(alertPayload.held) ? alertPayload.held : [];
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`UPDATE posts SET hidden = 0 WHERE hidden = ${HELD} AND id IN (SELECT value FROM json_each(?)) RETURNING id`)
    .bind(JSON.stringify(ids)).all();
  return results.map(r => r.id);
}
