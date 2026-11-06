// Ranking for boards (docs/decisions/001-ranking.md): the constants and the three sort keys a thread or comment
// stores. Each comes twice, as a JS function (unit-tested, and what a new thread starts with) and as SQL for the UPDATE
// that changes what it's made of, so the stored key is computed from the very row the counts land in, in the same
// batch: no read-then-write race can leave it stale. (D1 has ln, sqrt and abs but not log10, hence ln(x) / ln(10).)

export const EPOCH = 1767225600;                 // s: 2026-01-01 UTC, where hot's clock starts
export const UNIT = 172800;                      // s: 2 days of freshness = 10x the net votes
export const REPLY_CAP = 5;                      // hot: the most comments from others that count
export const WILSON_Z = 1.2816;                  // best: Reddit's 80% confidence

// top: net votes
export const score = (up, down) => up - down;

// hot: s = up - down + min(comments by others, 5); sign(s)·log10(1 + |s|) + (created - EPOCH) / UNIT. `created` in ms.
// It doesn't depend on "now", so it can be stored.
export function hot(up, down, replies, created) {
  const s = up - down + Math.min(replies, REPLY_CAP);
  return Math.sign(s) * Math.log10(1 + Math.abs(s)) + (created / 1000 - EPOCH) / UNIT;
}

// best: the Wilson score lower bound of the likes among all votes (0 with no votes)
export function wilson(up, down) {
  const n = up + down;
  if (!n) return 0;
  const p = up / n, z = WILSON_Z;
  return Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n));
}

/* the same in SQL: the arguments are SQL expressions */

const sign = s => `(CASE WHEN ${s} > 0 THEN 1 WHEN ${s} < 0 THEN -1 ELSE 0 END)`;

export function hotSql(up, down, replies, created) {
  const s = `(${up} - ${down} + min(${replies}, ${REPLY_CAP}))`;
  return `(${sign(s)} * ln(1 + abs(${s})) / ln(10) + (${created} / 1000.0 - ${EPOCH}) / ${UNIT}.0)`;
}

export function wilsonSql(up, down) {
  const n = `(${up} + ${down})`, p = `(1.0 * ${up} / ${n})`, z2 = WILSON_Z * WILSON_Z;
  return `(CASE WHEN ${n} = 0 THEN 0.0 ELSE max(0.0, (${p} + ${z2} / (2.0 * ${n}) - ${WILSON_Z} * sqrt(${p} * (1 - ${p}) / ${n} + ${z2} / (4.0 * ${n} * ${n})))
    / (1 + ${z2} / ${n})) END)`;
}

// SQL: a thread's comments from anyone but its writer (deleted ones don't count), inside an UPDATE of posts
const OTHERS = `(SELECT COUNT(*) FROM posts oc WHERE oc.root_id = posts.id AND oc.kind = 'comment' AND oc.deleted = 0 AND oc.author_id != posts.author_id)`;

// SQL: the SET clause (for UPDATE posts) that recomputes a thread's or comment's stored keys from its own row: hot for
// threads (comments are sorted by best, new or old), best and score for both. Recomputing is idempotent, so a batch runs
// it after whatever changed the counts, whether or not that change happened.
export const RESORT = `hot = CASE WHEN kind = 'thread' THEN ${hotSql('up_count', 'down_count', OTHERS, 'created')} ELSE 0 END,
  best = ${wilsonSql('up_count', 'down_count')}, score = up_count - down_count`;
