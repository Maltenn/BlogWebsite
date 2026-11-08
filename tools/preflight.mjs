// `npm run preflight`: is the repo ready for its first (or next) deploy? Read-only: it changes nothing on your
// computer except its own temp folder, and nothing on Cloudflare. Prints one line per check:
//
//   PASS   checked and fine
//   FAIL   wrong; do not deploy until fixed
//   TODO   not done yet, or can't be checked yet (a placeholder, no login, no Worker yet): fine before the first deploy
//
//   node tools/preflight.mjs                 every check
//   node tools/preflight.mjs --offline       skip the Cloudflare ones (login, secrets)
//   node tools/preflight.mjs --strict        count TODO as FAIL (the last run before going live)
//
// Exit status: 0 no FAIL; 1 any FAIL (with --strict, any FAIL or TODO).
//
// What it runs: `wrangler deploy --dry-run --outdir <temp>` (bundles, uploads nothing), `wrangler d1 migrations apply
// --local --persist-to <temp>` (a throwaway local database), and, only when logged in, `wrangler whoami` and
// `wrangler secret list --name <worker>` (names only; values are never shown by Wrangler and never read here).
// It never runs deploy without --dry-run, d1 create, migrations --remote, r2 create or secret put. docs/deploy.md#preflight.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contactEmail } from '../src/shared/contact.js';   // the Worker's own test for a usable address: one rule, not two

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// Limits from docs/decisions/004 (re-checked against Cloudflare's docs 2026-11-07): only the uncompressed bundle counts,
// and the same 64 MiB applies to Free and Paid. Static assets: 20,000 files and 25 MiB each on Free (Paid: 100,000).
export const BUNDLE_LIMIT = 64 * 1024 * 1024;
export const ASSET_FILES_FREE = 20000;
export const ASSET_FILE_BYTES = 25 * 1024 * 1024;

export const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
// Settings that exist only so the tests and the demo can run offline (docs/deploy.md: never on a real deployment).
export const TEST_ONLY_VARS = ['TEST_PROVIDER_BASE', 'TEST_PUSH_BASE', 'TEST_SIGNALS', 'TEST_SECRETS', 'TURNSTILE_VERIFY_URL', 'DOH_URL'];
// The youngest the site may be set to: a social network open from 13 (the Worker reads MIN_AGE, and defaults to 13).
export const LOWEST_MIN_AGE = 13;
// Secrets the Worker cannot run without, and ones without which sign-ups are refused (docs/deploy.md).
export const REQUIRED_SECRETS = ['IP_SALT', 'TOKEN_KEY'];
export const SIGNUP_SECRETS = ['TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'MAIL_FROM'];

/* ------------------------------------------------------------- pure helpers (tested in test/preflight.test.mjs) */

// wrangler.jsonc: JSON with comments and trailing commas. Strips them without touching text inside strings.
export function parseJsonc(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
    } else if (ch === '"') { inString = true; out += ch; i++; }
    else if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
    else { out += ch; i++; }
  }
  // trailing commas, again outside strings
  let res = '', s = false;
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (s) { res += ch; if (ch === '\\') { res += out[++k] ?? ''; } else if (ch === '"') s = false; continue; }
    if (ch === '"') { s = true; res += ch; continue; }
    if (ch === ',') { let j = k + 1; while (/\s/.test(out[j] || '')) j++; if (out[j] === '}' || out[j] === ']') continue; }
    res += ch;
  }
  return JSON.parse(res);
}

// Cloudflare's published Turnstile test keys: 1x/2x/3x + 0s + two letters (…AA, …AB, …BB, …FF) for site keys, …AA for secrets.
export const isTurnstileTestKey = key => /^[0-9]x0{20,}[A-Z]{2}$/.test(String(key || '').trim());

// Every var the config sets, top level and inside any `env.<name>` block.
export function allVars(config) {
  const sets = [['vars', config.vars || {}]];
  for (const [name, e] of Object.entries(config.env || {})) sets.push([`env.${name}.vars`, (e && e.vars) || {}]);
  return sets;
}

// Each check answers [status, name, detail]. These take the parsed config.

// CONTACT_EMAIL: the address the legal pages show and the Take It Down notice relies on. Empty is a TODO (fine before the
// first deploy, a FAIL with --strict); set but not a usable address is a FAIL, because the pages then show none.
export function checkContact(config) {
  const out = [];
  for (const [where, vars] of allVars(config)) {
    const v = String(vars.CONTACT_EMAIL ?? '').trim();
    const n = `CONTACT_EMAIL (${where})`;
    if (!v) { if (where === 'vars') out.push(['TODO', n, 'empty: /rules, /terms and /privacy show no contact address, and nobody without an account can ask for an image to come down (docs/launch.md)']); }
    else if (!contactEmail({ CONTACT_EMAIL: v })) out.push(['FAIL', n, 'is not a usable email address, so the pages show none: ' + v]);
    else out.push(['PASS', n, 'set to a usable address']);
  }
  return out;
}

// MIN_AGE: the Worker's default is 13 when it is unset. Under 13, or not a number, is a FAIL.
export function checkMinAge(config) {
  const out = [];
  for (const [where, vars] of allVars(config)) {
    if (vars.MIN_AGE === undefined && where !== 'vars') continue;
    const raw = String(vars.MIN_AGE ?? '').trim();
    const n = `MIN_AGE (${where})`;
    const age = raw === '' ? LOWEST_MIN_AGE : Number(raw);
    if (!Number.isFinite(age)) out.push(['FAIL', n, `"${raw}" is not a number`]);
    else if (age < LOWEST_MIN_AGE) out.push(['FAIL', n, `${age} is under ${LOWEST_MIN_AGE}: the site is for people ${LOWEST_MIN_AGE} and older`]);
    else out.push(['PASS', n, `${age}`]);
  }
  return out;
}
export function checkD1(config) {
  const dbs = config.d1_databases || [];
  if (!dbs.length) return ['FAIL', 'D1 database', 'no d1_databases in wrangler.jsonc'];
  const out = [];
  for (const d of dbs) {
    const id = String(d.database_id || '');
    const n = `D1 id (${d.database_name})`;
    if (!id || id === PLACEHOLDER_D1_ID) out.push(['TODO', n, 'still the all-zeros placeholder: `npx wrangler d1 create ' + d.database_name + '`, paste its id']);
    else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) out.push(['FAIL', n, 'not a UUID: ' + id]);
    else out.push(['PASS', n, 'set']);
  }
  return out;
}

export function checkTestOnly(config) {
  const found = [];
  for (const [where, vars] of allVars(config)) {
    for (const k of Object.keys(vars)) if (TEST_ONLY_VARS.includes(k) || /^TEST_/.test(k)) found.push(`${where}.${k}`);
    if (vars.AI_DETECTOR === 'mock') found.push(`${where}.AI_DETECTOR=mock`);
  }
  return found.length
    ? ['FAIL', 'no test-only settings', `set in wrangler.jsonc, never on a real deployment: ${found.join(', ')}`]
    : ['PASS', 'no test-only settings', `none of ${TEST_ONLY_VARS.join(', ')} (or any TEST_*, AI_DETECTOR=mock) in wrangler.jsonc`];
}

export function checkTurnstileKey(config) {
  const out = [];
  for (const [where, vars] of allVars(config)) {
    const key = String(vars.TURNSTILE_SITE_KEY ?? '').trim();
    const n = `TURNSTILE_SITE_KEY (${where})`;
    if (!key) { if (where === 'vars') out.push(['TODO', n, 'empty: sign-ups and password resets are refused until the Turnstile widget exists (docs/deploy.md)']); }
    else if (isTurnstileTestKey(key)) out.push(['FAIL', n, `${key} is one of Cloudflare's published test keys: it passes every bot`]);
    else out.push(['PASS', n, 'set, and not a published test key']);
  }
  return out;
}

// Migration file names: NNNN_snake_case.sql, in sequence from 0001, nothing missing or doubled.
export function checkMigrationNames(files) {
  const bad = files.filter(f => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f));
  if (bad.length) return ['FAIL', 'migration names', `not NNNN_snake_case.sql: ${bad.join(', ')}`];
  const nums = files.map(f => Number(f.slice(0, 4)));
  const gap = nums.findIndex((n, i) => n !== i + 1);
  if (gap >= 0) return ['FAIL', 'migration names', `sequence broken at ${files[gap]} (expected ${String(gap + 1).padStart(4, '0')})`];
  return ['PASS', 'migration names', `${files.length} files, 0001 to ${files[files.length - 1].slice(0, 4)}, in sequence`];
}

// Test switches stored as SECRETS (`wrangler secret put TEST_SIGNALS` works as well as a var) are as bad as ones in the
// config. Names only: a secret's value is never read here, so AI_DETECTOR=mock stored as a secret cannot be seen.
export function checkTestSecrets(names) {
  const bad = names.filter(k => TEST_ONLY_VARS.includes(k) || /^TEST_/.test(k));
  return bad.length
    ? ['FAIL', 'no test-only secrets', `stored as secrets, never on a real deployment (remove each with wrangler secret delete): ${bad.join(', ')}`]
    : ['PASS', 'no test-only secrets', 'none of the secret names is a test switch (names only; values are never read)'];
}

// Secret names from `wrangler secret list --format json` ([{ name, type }]).
export function checkSecrets(names) {
  const have = new Set(names);
  const out = [];
  const missing = REQUIRED_SECRETS.filter(s => !have.has(s));
  out.push(missing.length ? ['FAIL', 'required secrets', `missing: ${missing.join(', ')}`] : ['PASS', 'required secrets', REQUIRED_SECRETS.join(', ') + ' are set']);
  const need = SIGNUP_SECRETS.filter(s => !have.has(s));
  out.push(need.length ? ['TODO', 'sign-up secrets', `not set yet (sign-ups are refused without them): ${need.join(', ')}`] : ['PASS', 'sign-up secrets', SIGNUP_SECRETS.join(', ') + ' are set']);
  return out;
}

/* ------------------------------------------------------------------------------------------------ running Wrangler */

function wrangler(args, { cwd = ROOT, timeout = 180000 } = {}) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
  });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  return { ok: r.status === 0, text, error: r.error };
}
const tail = (text, n = 6) => text.split('\n').map(l => l.trim()).filter(Boolean).slice(-n).join(' | ').slice(0, 600);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const kib = b => (b / 1024).toFixed(1) + ' KiB';

function checkMigrationsApply(tmp, config) {
  const dir = path.join(ROOT, config.d1_databases?.[0]?.migrations_dir || 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const out = [checkMigrationNames(files)];
  if (out[0][0] === 'FAIL') return out;
  const db = config.d1_databases[0].database_name;
  const r = wrangler(['d1', 'migrations', 'apply', db, '--local', '--persist-to', path.join(tmp, 'd1-state')]);
  out.push(r.ok && !/ERROR/.test(r.text)
    ? ['PASS', 'migrations apply', `${files.length} files applied cleanly to a fresh local database`]
    : ['FAIL', 'migrations apply', tail(r.text)]);
  return out;
}

function checkBundle(tmp) {
  const outdir = path.join(tmp, 'bundle');
  const r = wrangler(['deploy', '--dry-run', '--outdir', outdir]);
  if (!r.ok) return [['FAIL', 'Worker bundles', tail(r.text)]];
  const out = [['PASS', 'Worker bundles', '`wrangler deploy --dry-run` succeeded (nothing uploaded)']];
  const js = fs.existsSync(outdir) ? walk(outdir).filter(f => /\.(m?js|wasm)$/.test(f)) : [];
  const bytes = js.reduce((n, f) => n + fs.statSync(f).size, 0);
  const gz = js.filter(f => /\.m?js$/.test(f)).reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(f)).length, 0);
  out.push(!js.length ? ['FAIL', 'bundle size', 'no bundle found in the dry run output']
    : bytes > BUNDLE_LIMIT ? ['FAIL', 'bundle size', `${kib(bytes)} is over the ${BUNDLE_LIMIT / 1048576} MiB limit`]
    : ['PASS', 'bundle size', `${kib(bytes)} uncompressed (${kib(gz)} gzip) of the ${BUNDLE_LIMIT / 1048576} MiB limit (Free and Paid alike; only uncompressed counts)`]);
  return out;
}

function checkAssets(config) {
  const dir = path.join(ROOT, config.assets?.directory || 'public');
  if (!fs.existsSync(dir)) return [['FAIL', 'static assets', `${dir} does not exist`]];
  const files = walk(dir);
  const big = files.filter(f => fs.statSync(f).size > ASSET_FILE_BYTES);
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  if (files.length > ASSET_FILES_FREE || big.length) {
    return [['FAIL', 'static assets', `${files.length} files (Free allows ${ASSET_FILES_FREE}), ${big.length} over 25 MiB`]];
  }
  return [['PASS', 'static assets', `${files.length} files, ${kib(total)}; within the Free plan's ${ASSET_FILES_FREE} files and 25 MiB each`]];
}

function checkCloud(config) {
  const who = wrangler(['whoami'], { timeout: 60000 });
  if (!who.ok || /not authenticated|not logged in|You are not/i.test(who.text)) {
    return [['TODO', 'Cloudflare login', 'not logged in (`npx wrangler login`), so the account and secrets are not checked']];
  }
  const out = [['PASS', 'Cloudflare login', 'logged in (account details not printed)']];
  const r = wrangler(['secret', 'list', '--name', config.name, '--format', 'json'], { timeout: 60000 });
  if (!r.ok) {
    if (/10007|does not exist|new Worker|wrangler deploy/i.test(r.text)) {
      out.push(['TODO', `Worker ${config.name}`, 'not on the account yet (first deploy not done), so its secrets are not checked']);
    } else out.push(['FAIL', 'secret list', tail(r.text)]);
    return out;
  }
  let names;
  try { names = JSON.parse(r.text.slice(r.text.indexOf('['), r.text.lastIndexOf(']') + 1)).map(s => s.name); }
  catch { return [...out, ['FAIL', 'secret list', 'could not read wrangler\'s answer']]; }
  return [...out, ['PASS', `Worker ${config.name}`, `exists, ${names.length} secrets (names only checked)`], ...checkSecrets(names), checkTestSecrets(names)];
}

/* ------------------------------------------------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const strict = argv.includes('--strict'), offline = argv.includes('--offline');
  const results = [];
  const add = r => results.push(...(Array.isArray(r[0]) ? r : [r]));
  let config;
  try { config = parseJsonc(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8')); add(['PASS', 'wrangler.jsonc', 'parses']); }
  catch (e) { add(['FAIL', 'wrangler.jsonc', 'does not parse: ' + e.message]); }
  if (config) {
    add(checkD1(config));
    add(checkTestOnly(config));
    add(checkTurnstileKey(config));
    add(checkContact(config));
    add(checkMinAge(config));
    add(checkAssets(config));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-preflight-'));
    try {
      add(checkMigrationsApply(tmp, config));
      add(checkBundle(tmp));
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows lets go a moment late */ }
    }
    if (offline) add(['TODO', 'Cloudflare checks', 'skipped (--offline)']);
    else add(checkCloud(config));
  }
  for (const [status, name, detail] of results) console.log(`${status.padEnd(4)}  ${name}: ${detail}`);
  const count = s => results.filter(r => r[0] === s).length;
  console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('TODO')} TODO${strict ? ' (strict: TODO counts as FAIL)' : ''}`);
  return count('FAIL') + (strict ? count('TODO') : 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
