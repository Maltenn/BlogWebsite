// The interaction score's math (src/shared/affinity.js, decisions/001 "Interaction score"): a 30-day half-life, adding
// to a decayed score, and closeness = eff + min(eff, back). `npm test`. The SQL twins are checked end to end by the
// group-suggestion test in api.test.mjs, against fixed scores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HALF_LIFE, W, GROUP_CAP, decay, bumped, closeness, DECAYED, CLOSENESS, ADD } from '../src/shared/affinity.js';

const DAY = 86400000;
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('a score halves every 30 days', () => {
  assert.equal(HALF_LIFE, 30 * DAY);
  near(decay(8, 0, 0), 8);
  near(decay(8, 0, 30 * DAY), 4);
  near(decay(8, 0, 60 * DAY), 2);
  near(decay(8, 0, 90 * DAY), 1);
  near(decay(1, 0, 15 * DAY), Math.SQRT1_2);
  near(decay(10, 1000, 1000 + 7 * DAY), 10 * 0.5 ** (7 / 30));
  near(decay(5, 2000, 1000), 5, 0);           // a clock that runs backwards never grows a score
});

test('adding decays what was there first, so a quiet month counts for less than a busy week', () => {
  near(bumped(4, 0, 3, 30 * DAY), 5);          // 4 halved, plus a reply
  near(bumped(0, 0, 2, 5 * DAY), 2);
  // one reply a day for a week, read a week later
  let eff = 0, at = 0;
  for (let d = 0; d < 7; d++) { eff = bumped(eff, at, W.reply, d * DAY); at = d * DAY; }
  const week = decay(eff, at, 13 * DAY);
  near(week, Array.from({ length: 7 }, (_, d) => 3 * 0.5 ** ((13 - d) / 30)).reduce((x, y) => x + y));
  assert.ok(week > decay(30, 0, 60 * DAY), 'seven replies lately beat thirty two months ago');
});

test('closeness counts the other side only as far as it matches mine', () => {
  assert.equal(closeness(4, 0), 4);
  assert.equal(closeness(5, 5), 10);
  assert.equal(closeness(3, 100), 6, 'a stranger who spams me can\'t climb my list');
  assert.equal(closeness(0, 9), 0, 'and with nothing from me, they aren\'t on it at all');
  assert.equal(closeness(2, 1), 3);
});

test('the weights and the group cap are decisions/001\'s', () => {
  assert.deepEqual(W, { reply: 3, comment: 3, dm: 2, mention: 2, quote: 2, like: 1, repost: 1, group: 0.5 });
  assert.equal(GROUP_CAP, 8);
});

test('the SQL says the same as the JS', () => {
  assert.equal(DECAYED('eff', 'updated', '?2'), `(eff * pow(0.5, max(0, ?2 - updated) / ${HALF_LIFE}.0))`);
  assert.equal(CLOSENESS('a', 'b'), '(a + min(a, b))');
  assert.match(ADD('SELECT 1, 2, 3, 4 WHERE 1'), /^INSERT INTO affinity \(from_id, to_id, eff, updated\) SELECT 1, 2, 3, 4 WHERE 1\s+ON CONFLICT \(from_id, to_id\) DO UPDATE SET eff = \(affinity\.eff \* pow\(0\.5, max\(0, excluded\.updated - affinity\.updated\) \/ 2592000000\.0\)\) \+ excluded\.eff/);
});
