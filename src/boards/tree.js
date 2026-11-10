// A thread's comments as a tree, from one flat read of the whole thread (every comment's id, parent, time, best key,
// whether it's a tombstone and whether the viewer may see it). Siblings are sorted within their parent; the tree is cut
// at CAP comments and DEPTH levels, and replies (below the top level) at SIBLINGS per parent. What's cut becomes a stub,
// { more, parent, after }: `more` comments under `parent` (the thread or a comment) that come after the sibling the
// cursor `after` names (null: from the first), which GET /api/threads/:id/comments/:parent?after= brings back. The
// cursor is the last shown sibling's place in the sort, not a position, so comments written or deleted in between
// neither repeat nor skip any.

export const CAP = 200;                          // comments in one answer
export const DEPTH = 8;                          // levels in one answer
export const SIBLINGS = 10;                      // replies to one comment in one answer (the top level takes the rest of CAP)

// siblings: best (ties: older first, so replies read in order), new, old
const ORDERS = {
  best: (x, y) => y.best - x.best || x.created - y.created || x.id - y.id,
  new: (x, y) => y.created - x.created || y.id - x.id,
  old: (x, y) => x.created - y.created || x.id - y.id,
};

// a comment's place in `sort`, as a stub's cursor: "<best>:<created>:<id>" for best, "<created>:<id>" for new and old
export const cursorOf = (r, sort) => (sort === 'best' ? `${r.best}:${r.created}:${r.id}` : `${r.created}:${r.id}`);

// a cursor back into { best, created, id } (what ORDERS compares), or null when it isn't one
export function readCursor(s, sort) {
  const parts = String(s ?? '').split(':').map(Number);
  if (parts.length !== (sort === 'best' ? 3 : 2) || !parts.every(Number.isFinite)) return null;
  const [best, created, id] = sort === 'best' ? parts : [0, ...parts];
  return { best, created, id };
}

// `rows`: the thread's comments ({ id, reply_to, created, best, deleted, ok }), in any order. Answers { found, nodes,
// ids }: whether `parent` (the thread `thread` or one of its comments) shows, its children after the cursor `after`
// (readCursor's; null: from the first) as nodes ({ item: comment id, children: [...] } or stubs), and the ids of the
// comments in them. A comment the viewer may not see (`ok` false: hidden by a moderator, its writer banned, a block
// either way) is left out with everything under it; a tombstone shows only while something under it does. (A comment
// always answers one that's there: deleting an account moves the replies to its comments up. One that didn't would
// sit at the top level.)
export function growTree(rows, thread, parent, sort, after = null) {
  const known = new Set(rows.map(r => r.id));
  const up = r => (known.has(r.reply_to) ? r.reply_to : thread);
  const byId = [...rows].sort((x, y) => x.id - y.id);              // a reply is always newer than what it answers
  const reached = new Set([thread]);
  for (const r of byId) if (r.ok && reached.has(up(r))) reached.add(r.id);
  // what shows under each comment reached from the thread (sorted), and how many that is however deep
  const under = new Map([...reached].map(id => [id, []])), count = new Map([...reached].map(id => [id, 0]));
  for (const r of byId.reverse()) {                                 // replies first, then what they answer
    if (!reached.has(r.id) || (r.deleted && !count.get(r.id))) continue;
    under.get(up(r)).push(r);
    count.set(up(r), count.get(up(r)) + 1 + count.get(r.id));
  }
  for (const list of under.values()) list.sort(ORDERS[sort]);

  let budget = CAP;
  const ids = [];
  function grow(id, depth, from) {
    const list = under.get(id);
    const room = depth === 0 ? Infinity : SIBLINGS;
    let start = from ? list.findIndex(r => ORDERS[sort](from, r) < 0) : 0;
    if (start < 0) start = list.length;
    const out = [];
    for (let i = start; i < list.length; i++) {
      if (!budget || i - start === room) {
        out.push({ more: list.slice(i).reduce((n, r) => n + 1 + count.get(r.id), 0), parent: id, after: i ? cursorOf(list[i - 1], sort) : null });
        break;
      }
      const r = list[i];
      budget--;
      ids.push(r.id);
      const deeper = !under.get(r.id).length ? [] : depth + 1 < DEPTH ? grow(r.id, depth + 1, null) : [{ more: count.get(r.id), parent: r.id, after: null }];
      out.push({ item: r.id, children: deeper });
    }
    return out;
  }
  const found = under.has(parent);
  return { found, nodes: found ? grow(parent, 0, after) : [], ids };
}
