// tools/preflight.mjs's pure checks: `npm test`. No Wrangler and no network; the real run is `npm run preflight`.
// Covers the part that can be wrong silently: reading wrangler.jsonc, and recognising what must not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, isTurnstileTestKey, checkD1, checkTestOnly, checkTurnstileKey, checkMigrationNames, checkSecrets, checkTestSecrets, checkContact, checkMinAge, PLACEHOLDER_D1_ID } from '../tools/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = r => (Array.isArray(r[0]) ? r : [r]).map(x => x[0]);

test('parseJsonc reads the real wrangler.jsonc, comments, URLs in strings and all', () => {
  const c = parseJsonc(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  assert.equal(c.name, 'ourspace-social');
  assert.equal(c.vars.MIN_AGE, '13');
  assert.ok(c.triggers.crons.length >= 1);
  assert.deepEqual(parseJsonc('{ "a": "http://x // not a comment /* nor this */", /* c */ "b": [1, 2,], // end\n }'), { a: 'http://x // not a comment /* nor this */', b: [1, 2] });
});

test('the repo as it stands: placeholder D1 id is TODO, no test-only settings, empty Turnstile key is TODO', () => {
  const c = parseJsonc(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  assert.deepEqual(status(checkD1(c)), c.d1_databases[0].database_id === PLACEHOLDER_D1_ID ? ['TODO'] : ['PASS']);
  assert.equal(checkTestOnly(c)[0], 'PASS');
  assert.ok(!status(checkTurnstileKey(c)).includes('FAIL'));
});

test('a real D1 id passes; a malformed one fails', () => {
  const db = id => ({ d1_databases: [{ database_name: 'x', database_id: id }] });
  assert.deepEqual(status(checkD1(db('418bd332-428e-49e6-b6d9-68f49adf7f36'))), ['PASS']);
  assert.deepEqual(status(checkD1(db('not-an-id'))), ['FAIL']);
  assert.deepEqual(status(checkD1({})), ['FAIL']);
});

test('test-only settings fail, wherever they are set', () => {
  assert.equal(checkTestOnly({ vars: { TEST_SIGNALS: '1' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { TEST_PROVIDER_BASE: 'http://x' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { TURNSTILE_VERIFY_URL: 'http://x' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { DOH_URL: 'http://x' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { TEST_SOMETHING_NEW: '1' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { AI_DETECTOR: 'mock' } })[0], 'FAIL');
  assert.equal(checkTestOnly({ env: { staging: { vars: { TEST_SIGNALS: '1' } } } })[0], 'FAIL');
  assert.equal(checkTestOnly({ vars: { AI_DETECTOR: 'off', APNS_SANDBOX: '1' } })[0], 'PASS');
});

test('Cloudflare\'s published Turnstile test keys are recognised; real-looking ones are not', () => {
  for (const k of ['1x00000000000000000000AA', '2x00000000000000000000AB', '1x00000000000000000000BB', '2x00000000000000000000BB', '3x00000000000000000000FF', '1x0000000000000000000000000000000AA']) assert.ok(isTurnstileTestKey(k), k);
  for (const k of ['', '0x4AAAAAAABkMYinukE8nzYS', '0x4AAAAAAAAAAAAAAAAAAAAA']) assert.ok(!isTurnstileTestKey(k), k);
  assert.deepEqual(status(checkTurnstileKey({ vars: { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } })), ['FAIL']);
  assert.deepEqual(status(checkTurnstileKey({ vars: { TURNSTILE_SITE_KEY: '0x4AAAAAAABkMYinukE8nzYS' } })), ['PASS']);
  assert.deepEqual(status(checkTurnstileKey({ vars: { TURNSTILE_SITE_KEY: '' } })), ['TODO']);
});

test('migration files: the real ones are in sequence; gaps, doubles and odd names fail', () => {
  const real = fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  assert.equal(checkMigrationNames(real)[0], 'PASS');
  assert.equal(checkMigrationNames(['0001_a.sql', '0003_b.sql'])[0], 'FAIL');
  assert.equal(checkMigrationNames(['0001_a.sql', '0001_b.sql'])[0], 'FAIL');
  assert.equal(checkMigrationNames(['0001_A.sql'])[0], 'FAIL');
});

test('test switches stored as secrets fail, by name; the real secret names pass', () => {
  for (const k of ['TEST_SIGNALS', 'TEST_PROVIDER_BASE', 'TEST_SECRETS', 'TURNSTILE_VERIFY_URL', 'DOH_URL', 'TEST_SOMETHING_NEW']) {
    const r = checkTestSecrets(['IP_SALT', 'TOKEN_KEY', k]);
    assert.equal(r[0], 'FAIL', k);
    assert.ok(r[2].includes(k));
    assert.ok(!r[2].includes('TOKEN_KEY'), 'only the offending names are listed');
  }
  assert.equal(checkTestSecrets(['IP_SALT', 'TOKEN_KEY', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'MAIL_FROM'])[0], 'PASS');
  assert.equal(checkTestSecrets([])[0], 'PASS');
});

test('CONTACT_EMAIL: empty is a TODO, a bad address a FAIL, a usable one a PASS (also inside env blocks)', () => {
  assert.deepEqual(status(checkContact({ vars: { CONTACT_EMAIL: '' } })), ['TODO']);
  assert.deepEqual(status(checkContact({ vars: {} })), ['TODO']);
  assert.deepEqual(status(checkContact({ vars: { CONTACT_EMAIL: '   ' } })), ['TODO']);
  for (const bad of ['hello', 'a@b', 'two words@example.com', 'a@b@example.com', '<a@example.com>']) assert.deepEqual(status(checkContact({ vars: { CONTACT_EMAIL: bad } })), ['FAIL'], bad);
  assert.deepEqual(status(checkContact({ vars: { CONTACT_EMAIL: 'help@example.org' } })), ['PASS']);
  assert.deepEqual(status(checkContact({ vars: { CONTACT_EMAIL: 'help@example.org' }, env: { staging: { vars: { CONTACT_EMAIL: 'nope' } } } })), ['PASS', 'FAIL']);
});

test('MIN_AGE: under 13 or not a number fails; 13 and over pass; unset is the server default of 13', () => {
  for (const bad of ['12', '0', '-1', '9', 'abc', '12.9']) assert.deepEqual(status(checkMinAge({ vars: { MIN_AGE: bad } })), ['FAIL'], bad);
  for (const ok of ['13', '16', ' 18 ']) assert.deepEqual(status(checkMinAge({ vars: { MIN_AGE: ok } })), ['PASS'], ok);
  assert.deepEqual(status(checkMinAge({ vars: {} })), ['PASS']);
  assert.deepEqual(status(checkMinAge({ vars: { MIN_AGE: '13' }, env: { staging: { vars: { MIN_AGE: '10' } } } })), ['PASS', 'FAIL']);
  assert.deepEqual(status(checkMinAge({ vars: { MIN_AGE: '13' }, env: { staging: { vars: {} } } })), ['PASS']);
});

test('the real wrangler.jsonc has MIN_AGE of 13 or over and no unusable contact address', () => {
  const c = parseJsonc(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  assert.ok(!status(checkMinAge(c)).includes('FAIL'));
  assert.ok(!status(checkContact(c)).includes('FAIL'));
});

test('secrets: the two required ones fail when missing; sign-up ones are a TODO', () => {
  assert.deepEqual(status(checkSecrets([])), ['FAIL', 'TODO']);
  assert.deepEqual(status(checkSecrets(['IP_SALT', 'TOKEN_KEY'])), ['PASS', 'TODO']);
  assert.deepEqual(status(checkSecrets(['IP_SALT', 'TOKEN_KEY', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'MAIL_FROM'])), ['PASS', 'PASS']);
});
