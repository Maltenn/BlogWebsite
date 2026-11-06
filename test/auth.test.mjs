// Unit tests for the pure helpers in src/accounts/auth.js: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipGroup } from '../src/accounts/auth.js';

test('rate limits group IPv6 by /64, so rotating addresses on one line does not dodge them', () => {
  const home = ['2001:db8:85a3:12::1', '2001:db8:85a3:12:ffff:ffff:ffff:fffe', '2001:0db8:85a3:0012:0:0:0:abcd', '2001:DB8:85A3:12::9%eth0'];
  assert.deepEqual(new Set(home.map(ipGroup)), new Set(['2001:db8:85a3:12::/64']));
  assert.notEqual(ipGroup('2001:db8:85a3:13::1'), ipGroup('2001:db8:85a3:12::1'), 'the next /64 is a different line');
  assert.equal(ipGroup('::1'), '0:0:0:0::/64');
  assert.equal(ipGroup('fe80::'), 'fe80:0:0:0::/64');
});

test('IPv4 (and IPv4-mapped IPv6) is grouped by the full address', () => {
  assert.equal(ipGroup('203.0.113.7'), '203.0.113.7');
  assert.equal(ipGroup('::ffff:203.0.113.7'), '203.0.113.7');
  assert.notEqual(ipGroup('::ffff:203.0.113.7'), ipGroup('::ffff:203.0.113.8'));
  assert.equal(ipGroup(null), '0.0.0.0');
});
