// The interests → boards crosswalk (board_terms, migrations/0008_browse.sql): read once per Worker isolate and kept for
// 5 minutes (a few hundred rows), and the moderators' routes that look at and change a board's terms.
import { fail, json, readBody } from '../shared/http.js';
import { validTerm, termIndex } from './score.js';

const TTL = 5 * 60000;
let cached = null;                               // { at, rows }

// every stored term ([{ term, board_id, weight }]), from the isolate's copy when it's fresh
export async function termRows(c) {
  if (cached && c.now - cached.at < TTL && c.now >= cached.at) return cached.rows;
  const { results } = await c.env.DB.prepare('SELECT term, board_id, weight FROM board_terms').all();
  cached = { at: c.now, rows: results };
  return results;
}

// the lookup table for the boards (not archived) in `boards` ([{ id, slug, name, archived }])
export async function indexFor(c, boards) {
  return termIndex(boards.filter(b => !b.archived), await termRows(c));
}

async function boardOf(c) {
  const b = await c.env.DB.prepare('SELECT id, slug, name, icon, archived FROM boards WHERE slug = ?').bind(String(c.params.slug).toLowerCase()).first();
  if (!b) fail(404, 'no such board.');
  return b;
}

async function answer(c, b) {
  const { results } = await c.env.DB.prepare('SELECT term, weight FROM board_terms WHERE board_id = ? ORDER BY term').bind(b.id).all();
  return json({ board: { slug: b.slug, name: b.name, icon: b.icon, archived: !!b.archived }, terms: results });
}

// GET /api/admin/boards/:slug/terms — a board's stored terms, A to Z (its name counts as well, without being stored)
export async function boardTerms(c) {
  return answer(c, await boardOf(c));
}

// PUT /api/admin/boards/:slug/terms { add?: [term | { term, weight }], remove?: [term] } — up to 100 of each. A term is one to
// three words, 60 characters at most, stored cleaned (lower case, no accents or punctuation); weight 0.1–5 (default 1;
// adding a term that's there sets its weight). Logged. Answers the board's terms.
export async function saveBoardTerms(c) {
  const b = await boardOf(c);
  const x = await readBody(c.req);
  const add = Array.isArray(x.add) ? x.add : [], remove = Array.isArray(x.remove) ? x.remove : [];
  if (add.length > 100 || remove.length > 100) fail(400, 'at most 100 terms at a time.');
  const adds = add.map(a => {
    const raw = a && typeof a === 'object' ? a.term : a;
    const term = validTerm(raw);
    if (!term) fail(400, `"${String(raw ?? '').slice(0, 60)}" isn't a term: one to three words, 60 characters at most.`);
    const weight = a && typeof a === 'object' && a.weight != null ? Number(a.weight) : 1;
    if (!(weight >= 0.1 && weight <= 5)) fail(400, 'a weight is between 0.1 and 5.');
    return [term, weight];
  });
  const drops = remove.map(r => validTerm(r)).filter(Boolean);
  const DB = c.env.DB;
  await DB.batch([
    DB.prepare('DELETE FROM board_terms WHERE board_id = ?1 AND term IN (SELECT value FROM json_each(?2))').bind(b.id, JSON.stringify(drops)),
    DB.prepare(`INSERT INTO board_terms (term, board_id, weight) SELECT json_extract(t.value, '$[0]'), ?1, json_extract(t.value, '$[1]') FROM json_each(?2) t
      WHERE true ON CONFLICT (term, board_id) DO UPDATE SET weight = excluded.weight`).bind(b.id, JSON.stringify(adds)),
    DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, \'board_terms\', \'board\', ?, ?, ?)')
      .bind(c.user.id, b.id, JSON.stringify({ add: adds.map(a => a[0]), remove: drops }).slice(0, 2000), c.now),
  ]);
  cached = null;                                 // (this isolate at once; others within 5 minutes)
  return answer(c, b);
}
