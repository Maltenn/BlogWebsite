// The interaction score of decisions/001 ("Interaction score"): a directed `affinity` row for what one member did toward
// another (replies, likes, Friends' Comments, mentions, quotes, reposts, board comment replies, DMs, group messages),
// halving every 30 days. Written in the same batch as the action (decayed first, then added to), decayed again on read.
// Closeness = eff + min(eff, back): the other person's activity counts only as far as it matches mine, so a stranger who
// spams me can't climb my list. Each piece comes as a JS function (unit-tested) and the SQL that does the same.
import { NOT_BLOCKED } from './db.js';

export const HALF_LIFE = 30 * 86400000;        // ms
export const W = { reply: 3, comment: 3, dm: 2, mention: 2, quote: 2, like: 1, repost: 1, group: 0.5 };
export const GROUP_CAP = 8;                    // a group message counts toward the other members only in groups this small
export const PRUNE_BELOW = 0.05;               // rows decayed below this are deleted by the cron

// `eff` written at `updated`, as it stands at `now`
export const decay = (eff, updated, now) => eff * Math.pow(0.5, Math.max(0, now - updated) / HALF_LIFE);
// a row after adding `w` at `now`
export const bumped = (eff, updated, w, now) => decay(eff, updated, now) + w;
export const closeness = (eff, back) => eff + Math.min(eff, back);

/* the same in SQL: the arguments are SQL expressions */

export const DECAYED = (eff, updated, now) => `(${eff} * pow(0.5, max(0, ${now} - ${updated}) / ${HALF_LIFE}.0))`;
export const CLOSENESS = (eff, back) => `(${eff} + min(${eff}, ${back}))`;

// SQL: adds the rows `select` gives (from_id, to_id, weight, now) to the scores, each decayed first
export const ADD = select => `INSERT INTO affinity (from_id, to_id, eff, updated) ${select}
  ON CONFLICT (from_id, to_id) DO UPDATE SET eff = ${DECAYED('affinity.eff', 'affinity.updated', 'excluded.updated')} + excluded.eff,
    updated = MAX(affinity.updated, excluded.updated)`;

// The statement (for a write batch) adding what the logged-in user (?1) just did toward each person in `to` ([[user id,
// weight], …]; the same person twice adds up), at ?2, when `when` holds (SQL: the write really happened; it may use ?4 …
// bound from `extra`). Never toward yourself or across a block. null when there's nobody.
export function bump(c, to, when = '1', ...extra) {
  const sum = new Map();
  for (const [id, w] of to) if (id && id !== c.user.id && w > 0) sum.set(id, (sum.get(id) || 0) + w);
  if (!sum.size) return null;
  const t = 'json_extract(t.value, \'$[0]\')';
  return c.env.DB.prepare(ADD(`SELECT ?1, ${t}, json_extract(t.value, '$[1]'), ?2 FROM json_each(?3) t
    WHERE ${NOT_BLOCKED(t)} AND (${when})`)).bind(c.user.id, c.now, JSON.stringify([...sum]), ...extra);
}
