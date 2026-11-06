// Unit tests for the board sort keys in src/shared/ranking.js (docs/decisions/001-ranking.md) and the comment tree in
// src/boards/tree.js: `npm test`. Pure functions: no server needed. (The SQL forms are checked against these by the
// count audit at the end of test/api.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EPOCH, UNIT, REPLY_CAP, WILSON_Z, hot, wilson, score } from '../src/shared/ranking.js';
import { growTree, cursorOf, readCursor, CAP, DEPTH, SIBLINGS } from '../src/boards/tree.js';

const near = (actual, expected, places, message) => assert.ok(Math.abs(actual - expected) < 0.5 * 10 ** -places, `${message}: ${actual} ≠ ${expected}`);
const at = s => s * 1000;                        // seconds since the epoch → the ms a post's created holds

test('the constants are the ones 001 settled on', () => {
  assert.deepEqual([EPOCH, UNIT, REPLY_CAP, WILSON_Z], [1767225600, 172800, 5, 1.2816]);
  assert.equal(new Date(at(EPOCH)).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('best: the Wilson lower bound at z = 1.2816, against the values worked out in 001', () => {
  assert.equal(wilson(0, 0), 0, 'no votes');
  near(wilson(1, 0), 1 / (1 + 1.2816 ** 2), 12, 'one like: p = 1 leaves 1 / (1 + z²)');
  assert.equal(wilson(0, 1), 0, 'one dislike');
  assert.equal(wilson(0, 7), 0, 'never below 0');
  for (const [up, down, want] of [[1, 0, 0.378], [5, 0, 0.753], [10, 2, 0.658], [100, 100, 0.455], [1, 1, 0.164]]) {
    near(wilson(up, down), want, 3, `${up} up, ${down} down`);
  }
  assert.ok(wilson(10, 2) < wilson(5, 0) && wilson(1, 0) < wilson(5, 0), 'more evidence beats a perfect but tiny record');
});

test('hot: sign(s)·log10(1 + |s|) + (created - EPOCH) / UNIT, with s = up - down + at most 5 comments from others', () => {
  assert.equal(hot(0, 0, 0, at(EPOCH)), 0, 'nothing, at the epoch');
  assert.equal(hot(9, 0, 0, at(EPOCH)), 1, '+9: log10(10)');
  assert.equal(hot(0, 9, 0, at(EPOCH)), -1, '-9');
  assert.equal(hot(99, 0, 0, at(EPOCH + UNIT)), 3, '+99, two days in: 2 + 1');
  assert.equal(hot(4, 4, 0, at(EPOCH + 2 * UNIT)), 2, 'a tie is worth nothing; four days in is 2');
  assert.equal(hot(0, 0, 5, at(EPOCH)), hot(0, 0, 50, at(EPOCH)), 'replies stop counting at 5');
  near(hot(0, 0, 5, at(EPOCH)), Math.log10(6), 12, 'five comments count as five likes');
  assert.equal(hot(1, 0, 0, at(EPOCH)), -hot(0, 1, 0, at(EPOCH)), '+1 and -1 are apart (1 + |s| fixes Reddit\'s tie)');
  near(hot(0, 0, 0, at(EPOCH + 86400)), 0.5, 12, 'a day is half a unit');
  near(hot(100, 0, 0, at(EPOCH)) - hot(0, 0, 0, at(EPOCH + 4 * 86400)), Math.log10(101) - 2, 12, '100 net votes ≈ 4 days of freshness');
  assert.equal(score(7, 3), 4);
});

/* the comment tree */

// a comment row as the thread read gives it
const row = (id, reply_to, { created = id, best = 0, deleted = 0, ok = 1 } = {}) => ({ id, reply_to, created, best, deleted, ok });
const shape = nodes => nodes.map(n => (n.more !== undefined ? `+${n.more}@${n.parent}:${n.after}` : n.children.length ? [n.item, shape(n.children)] : n.item));

test('the tree: siblings sorted best / new / old within their parent', () => {
  const rows = [row(1, 100, { best: 0.2 }), row(2, 100, { best: 0.5 }), row(3, 1), row(4, 1, { best: 0.9 }), row(5, 100, { best: 0.5 })];
  assert.deepEqual(shape(growTree(rows, 100, 100, 'best').nodes), [2, 5, [1, [4, 3]]], 'best, ties older first');
  assert.deepEqual(shape(growTree(rows, 100, 100, 'new').nodes), [5, 2, [1, [4, 3]]]);
  assert.deepEqual(shape(growTree(rows, 100, 100, 'old').nodes), [[1, [3, 4]], 2, 5]);
  const { found, nodes, ids } = growTree(rows, 100, 1, 'old');
  assert.deepEqual([found, shape(nodes), ids], [true, [3, 4], [3, 4]], 'under one comment');
  assert.equal(growTree(rows, 100, 99, 'old').found, false);
});

test('the tree: hidden comments go with their replies, tombstones stay while something under them shows, orphans go to the top', () => {
  const rows = [row(1, 100, { ok: 0 }), row(2, 1), row(3, 100, { deleted: 1 }), row(4, 3), row(5, 100, { deleted: 1 }), row(6, 5, { ok: 0 }), row(7, 55)];
  assert.deepEqual(shape(growTree(rows, 100, 100, 'old').nodes), [[3, [4]], 7]);
  assert.equal(growTree(rows, 100, 2, 'old').found, false, 'nothing under a hidden comment shows');
});

test('the tree: cut at DEPTH levels, SIBLINGS replies per comment and CAP comments, with stubs for the rest', () => {
  const chain = Array.from({ length: DEPTH + 3 }, (_, i) => row(i + 1, i || 100));         // 1 ← 2 ← … ← 11
  let n = growTree(chain, 100, 100, 'old').nodes;
  for (let d = 1; d < DEPTH; d++) n = n[0].children;
  assert.deepEqual(n[0].item, DEPTH);
  assert.deepEqual(n[0].children, [{ more: 3, parent: DEPTH, after: null }], 'what is deeper waits behind a stub');
  assert.deepEqual(shape(growTree(chain, 100, DEPTH, 'old').nodes), [[DEPTH + 1, [[DEPTH + 2, [DEPTH + 3]]]]], 'which loads it');

  const wide = [row(1, 100), ...Array.from({ length: SIBLINGS + 4 }, (_, i) => row(i + 2, 1)), row(50, 2)];
  const top = growTree(wide, 100, 100, 'old').nodes[0];
  assert.equal(top.children.length, SIBLINGS + 1);
  assert.deepEqual(top.children.at(-1), { more: 4, parent: 1, after: `${SIBLINGS + 1}:${SIBLINGS + 1}` }, 'replies past 10, after the 10th shown (row 11)');
  assert.deepEqual(shape(growTree(wide, 100, 1, 'old', readCursor(top.children.at(-1).after, 'old')).nodes), [12, 13, 14, 15], 'the rest of them');

  const many = Array.from({ length: CAP + 30 }, (_, i) => row(i + 1, 1000)).concat([row(1001, 3)]);
  const all = growTree(many, 1000, 1000, 'old');
  assert.deepEqual([all.ids.length, all.nodes.at(-1)], [CAP, { more: 31, parent: 1000, after: `${CAP - 1}:${CAP - 1}` }], 'CAP comments (a reply took one place)');
});

test('the tree: "load more" goes on from the last shown sibling\'s place in the sort, so comments written or deleted in between neither repeat nor go missing', () => {
  // 15 top-level comments, of which the first answer showed 3 (in each sort) and then a stub naming the third
  const rows = Array.from({ length: 15 }, (_, i) => row(i + 1, 100, { best: (15 - i) / 100 }));
  for (const sort of ['best', 'new', 'old']) {
    const shownTop = growTree(rows, 100, 100, sort).nodes.slice(0, 3).map(n => n.item);
    const after = cursorOf(rows.find(r => r.id === shownTop[2]), sort);
    // in between: a new top-level comment (first in new, last in best and old), and a shown one and an unshown one deleted
    const later = [...rows.filter(r => r.id !== shownTop[1] && r.id !== 9), row(16, 100, { created: 16, best: 0 })];
    const rest = growTree(later, 100, 100, sort, readCursor(after, sort)).nodes.map(n => n.item);
    const expected = { best: [4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16], new: [12, 11, 10, 8, 7, 6, 5, 4, 3, 2, 1], old: [4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16] }[sort];
    assert.deepEqual(rest, expected, `${sort}: nothing shown again, nothing skipped`);
  }
  assert.deepEqual(readCursor('0.25:1700000000000:42', 'best'), { best: 0.25, created: 1700000000000, id: 42 });
  assert.deepEqual(readCursor('1700000000000:42', 'new'), { best: 0, created: 1700000000000, id: 42 });
  for (const [s, sort] of [['1:2', 'best'], ['1:2:3', 'old'], ['x:1', 'new'], [null, 'old'], ['', 'best']]) assert.equal(readCursor(s, sort), null, String(s));
});
