// Child-safety holds, end to end: `npm test`. What docs/operations.md promises a moderator, checked against a real
// `wrangler dev` on a throwaway local database and bucket: a member's `csam` report hides the reported thing's own photos
// and nothing else, the server refuses to destroy or republish what is held without a logged override,
// only a moderator's confirmation holds an account (and bans it in the same moment), what a hold keeps survives the
// account being deleted while an ordinary deletion still deletes everything, and the Take It Down path stays a plain Remove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './helpers/mock-providers.mjs';
import { png } from './helpers/images.mjs';
import { fillForm, randomIp, verifyTokenIn, TURNSTILE_TEST_TOKEN, BROWSER } from './helpers/human.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PORT = 9100 + Math.floor(Math.random() * 200);       // (above the range test/api.test.mjs picks from)
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER = `ourspace-social-safety-${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-safety-'));
const OLD_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-safety-old-'));
const DAY = 86400000;
const PW = 'correct-horse-9';
let server, mock, serverLog = '';

const d1 = (state, args) => JSON.parse(execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'ourspace-social-db', '--local', '--persist-to', state, '--json', ...args],
  { cwd: ROOT, stdio: 'pipe' }).toString());
const sql = command => d1(STATE, ['--command', command])[0].results;

before(async () => {
  mock = await startMock();
  const vars = {
    SIGNUPS_PER_IP_PER_HOUR: '1000', SIGNUPS_PER_DAY: '1000', TEST_PROVIDER_BASE: mock.base, TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_VERIFY_URL: mock.base + '/turnstile/v0/siteverify', DOH_URL: mock.base + '/dns-query',
    POW_BITS: '8', SIGNUP_MIN_MS: '100', SIGNUP_SOFT_MS: '200', TEST_SIGNALS: '1', AI_DETECTOR: 'mock', AI_ENFORCEMENT: 'shadow',
  };
  execFileSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'ourspace-social-db', '--local', '--persist-to', STATE], { cwd: ROOT, stdio: 'pipe' });
  server = spawn(process.execPath, [WRANGLER, 'dev', '--name', WORKER, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE,
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: ROOT, stdio: 'pipe' });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/options')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + serverLog);
});

after(async () => {
  // end wrangler and its workerd child and wait for them: only then may the folders go (Windows holds the files open)
  if (server && server.exitCode === null) {
    const exited = new Promise(res => server.once('exit', res));
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
    await exited;
  }
  if (mock) await mock.close();
  for (const dir of [STATE, OLD_STATE]) {
    for (let i = 0; ; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
        if (i === 20) { console.warn(`could not remove ${dir}: ${e.code}`); break; }
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }
});

// a tiny browser, as in test/api.test.mjs: cookies, JSON, the sign-up form's proof of work and Turnstile token
function client() {
  const jar = new Map();
  const raw = async (method, url, { body, headers = {} } = {}) => {
    const h = { ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body instanceof Uint8Array) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
  const ip = randomIp();
  const call = async (method, url, body) => {
    let headers;
    if (url === '/api/signup') {
      const form = await (await raw('GET', '/api/form/signup', { headers: { 'X-Test-Ip': ip } })).json();
      body = await fillForm(form, body, { fetchedAt: Date.now(), extraMs: 120, turnstile: TURNSTILE_TEST_TOKEN });
      headers = { ...BROWSER, 'X-Test-Ip': ip };
    } else if (url === '/api/login') body = { ...body, turnstile: TURNSTILE_TEST_TOKEN };
    const res = await raw(method, url, { body, headers });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { raw, get: u => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}

let n = 0;
const uniq = () => `${Date.now().toString(36).slice(-4)}${n++}`;
async function verifyToken(email) {
  for (let i = 0; i < 500; i++) {
    const t = verifyTokenIn(serverLog, email);
    if (t) return t;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`no confirmation email for ${email}`);
}
async function newUser(prefix = 'user') {
  const c = client();
  const id = uniq();
  const name = `${prefix}_${id}`, email = `${prefix}.${id}@example.com`;
  const r = await c.post('/api/signup', { email, password: PW, name, birthday: '1995-08-15', rulesOk: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  Object.assign(c, { name, email, id: r.data.user.id });
  assert.equal((await c.post('/api/verify', { token: await verifyToken(email) })).status, 200);
  return c;
}
async function moderator(prefix = 'mod') {
  const m = await newUser(prefix);
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${m.id}`);
  return m;
}
async function photo(who, purpose) {
  const res = await who.raw('POST', '/api/media' + (purpose ? `?purpose=${purpose}` : ''), { body: png({ width: 40, height: 40 }), headers: { 'Content-Type': 'image/png' } });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data.media;
}
const fetchStatus = async (who, url) => (await who.raw('GET', url)).status;
const keyOf = url => url.replace('/media/', '');
// wrangler's local explorer is shared by every `wrangler dev` on the machine, and with another one running (a demo) it
// sometimes drops the connection (ECONNRESET): a dev-tool hiccup, not an answer, so only that is tried again. A real
// answer, an error status included, is returned as it is.
async function explorer(url) {
  for (let i = 0; ; i++) {
    try { return await fetch(url); } catch (e) {
      if (i === 4 || !/ECONNRESET|ECONNREFUSED|socket hang up/.test(String(e && e.cause && e.cause.code || e && e.cause || e))) throw e;
      console.warn(`local explorer dropped the connection (${(e.cause && e.cause.code) || e.message}); trying again`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
async function bucket() {
  const keys = new Set();
  let cursor = '';
  for (;;) {
    const r = await explorer(`${BASE}/cdn-cgi/local/explorer/api/r2/buckets/ourspace-social-media/objects?per_page=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    assert.equal(r.status, 200, 'the local explorer lists the bucket');
    const j = await r.json();
    for (const o of j.result) keys.add(o.key);
    cursor = j.result_info && j.result_info.cursor;
    if (!cursor) return keys;
  }
}
const inBucket = async m => (await bucket()).has(keyOf(m.url));
const post = async (who, body, media) => {
  const r = await who.post('/api/status', { body, ...(media ? { media } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
};
// (ids of posts, members and messages overlap: a report is found by both)
const reportOf = async (mod, type, targetId, status = 'open') => (await mod.get('/api/admin/reports?status=' + status)).data.reports.find(r => r.type === type && r.targetId === targetId);
const logOf = async (mod, id) => (await mod.get('/api/admin/log')).data.log.filter(l => l.targetType === 'media' && l.targetId === id);
// a csam report on a post by someone with no other report to dedupe against
const rep2Report = async (mod, id) => (await newUser('quoterep')).post('/api/reports', { type: 'post', id, reason: 'csam' });
// the DM between two members, with a line from each: { chat, a, b } (the messages)
async function dm(x, y, wordsX, wordsY) {
  const made = await x.post('/api/chats', { dm: y.name });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const chat = made.data.chat.id;
  const say = async (who, body) => {
    const r = await who.post(`/api/chats/${chat}/messages`, { body });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.message;
  };
  return { chat, a: await say(x, wordsX), b: await say(y, wordsY) };
}
async function runCron(done) {
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=${WORKER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: '*/30 * * * *' }) });
  assert.equal(res.status, 200, await res.text());
  for (let i = 0; i < 24 && !(await done()); i++) await new Promise(r => setTimeout(r, 250));
}
// Is this text still anywhere it could be read back from? (The live messages and posts, or a preserved copy. The second
// is looked up by name, so this asks about the data, whatever the code did to keep it.)
function kept(words) {
  const evidence = sql('SELECT 1 AS x FROM sqlite_master WHERE type = \'table\' AND name = \'evidence\'').length > 0;
  const like = `'%${words}%'`;
  return sql(`SELECT (SELECT COUNT(*) FROM chat_messages WHERE body LIKE ${like}) + (SELECT COUNT(*) FROM posts WHERE body LIKE ${like})
    ${evidence ? `+ (SELECT COUNT(*) FROM evidence WHERE data LIKE ${like})` : ''} AS n`)[0].n > 0;
}

/* ------------------------------------------------------------------ more helpers */

// a member who signed up and never confirmed their email (a new account may still report)
async function unverified(prefix) {
  const c = client();
  const id = uniq();
  const name = `${prefix}_${id}`, email = `${prefix}.${id}@example.com`;
  const r = await c.post('/api/signup', { email, password: PW, name, birthday: '1995-08-15', rulesOk: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return Object.assign(c, { name, email, id: r.data.user.id });
}
const befriend = async (a, b) => { await a.post('/api/follows/' + b.name); await b.post('/api/follows/' + a.name); };
const heldNow = id => sql(`SELECT COUNT(*) AS n FROM held_accounts WHERE user_id = ${id}`)[0].n > 0;
// a moderator confirms report `r` as apparent CSAM
const confirm = async (mod, r, note = 'NCMEC 12345') => {
  const res = await mod.post(`/api/admin/reports/${r.id}`, { action: 'confirm', note });
  assert.equal(res.status, 200, JSON.stringify(res.data));
};
// A member under a confirmed hold who can still act. Confirming bans them, so they can't notice anything, and the site
// refuses to unban a held account (tested below); this lifts the ban in the database instead, to check that even then
// nothing they do destroys what the hold keeps. Answers { held, mod, report }.
async function heldMember(prefix) {
  const held = await newUser(prefix), rep = await newUser(prefix + 'rep'), mod = await moderator(prefix + 'mod');
  const words = await post(held, 'the reported post, no photos');
  assert.equal((await rep.post('/api/reports', { type: 'post', id: words, reason: 'csam' })).status, 201);
  const report = await reportOf(mod, 'post', words);
  await confirm(mod, report);
  assert.ok(heldNow(held.id), 'confirmed: held');
  sql(`UPDATE users SET banned = 0 WHERE id = ${held.id}`);
  assert.equal((await held.post('/api/login', { login: held.email, password: PW })).status, 200);
  return { held, mod, report };
}

/* --------------------------------------------- H1: what a member's report hides: its own photos, nothing more */

test('H1: a csam report on a profile hides its uploaded picture at once: public 404, changing it doesn\'t delete it, the report lists it, and no account is held', async () => {
  const me = await newUser('h1pic'), rep = await newUser('h1rep'), mod = await moderator('h1mod');
  const pic = await photo(me, 'avatar');
  assert.equal((await me.put('/api/me/profile', { avatar: pic.url })).status, 200);
  assert.equal(await fetchStatus(client(), pic.url), 200, 'public before the report');
  assert.equal((await rep.post('/api/reports', { type: 'user', name: me.name, reason: 'csam' })).status, 201);
  assert.equal(await fetchStatus(client(), pic.url), 404, 'the public can\'t see it');
  assert.equal(await fetchStatus(mod, pic.url), 200, 'a moderator can');
  const preset = (await client().get('/api/options')).data.avatars[2].file;
  assert.equal((await me.put('/api/me/profile', { avatar: preset })).status, 200);
  assert.ok(await inBucket(pic), 'changing the picture left it in storage');
  const r = await reportOf(mod, 'user', me.id);
  assert.deepEqual(r.snapshot.media.map(m => [m.id, m.hidden, m.held]), [[pic.id, true, true]], 'the report shows it, and that it is held');
  assert.ok(!heldNow(me.id), 'a member\'s report holds no account');
});

test('H1: a report that isn\'t csam hides nothing, and a preset picture gives a csam report nothing to hide', async () => {
  const me = await newUser('h1plain'), rep = await newUser('h1rep2'), mod = await moderator('h1mod2');
  const pic = await photo(me, 'avatar');
  await me.put('/api/me/profile', { avatar: pic.url });
  await rep.post('/api/reports', { type: 'user', name: me.name, reason: 'spam' });
  assert.equal(await fetchStatus(client(), pic.url), 200, 'spam hides nothing');
  const other = await newUser('h1preset');
  assert.equal((await rep.post('/api/reports', { type: 'user', name: other.name, reason: 'csam' })).status, 201);
  assert.deepEqual((await reportOf(mod, 'user', other.id)).snapshot.media, []);
});

test('H1: a csam report on a quote or a repost hides the quote\'s own photos only, never the quoted member\'s', async () => {
  const author = await newUser('h1author'), quoter = await newUser('h1quoter'), rep = await newUser('h1rep3'), mod = await moderator('h1mod3');
  const orig = await photo(author), own = await photo(quoter);
  const p = await post(author, 'the original', [orig.id]);
  const q = await quoter.post(`/api/posts/${p}/quote`, { body: 'look at this', media: [own.id] });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  const quoteId = (q.data.post || q.data).id;
  assert.equal((await rep.post('/api/reports', { type: 'post', id: quoteId, reason: 'csam' })).status, 201);
  assert.equal(await fetchStatus(client(), own.url), 404, 'the quote\'s own photo is hidden');
  assert.equal(await fetchStatus(client(), orig.url), 200, 'the quoted member\'s is not touched');
  assert.deepEqual((await reportOf(mod, 'post', quoteId)).snapshot.media.map(m => m.id), [own.id], 'nor listed');
  const a2 = await photo(author);
  const p2 = await post(author, 'another', [a2.id]);
  assert.ok((await quoter.post(`/api/posts/${p2}/repost`)).status < 300);
  const repost = sql(`SELECT id FROM posts WHERE kind = 'repost' AND quote_of = ${p2}`)[0].id;
  assert.equal((await rep.post('/api/reports', { type: 'post', id: repost, reason: 'csam' })).status, 201);
  assert.equal(await fetchStatus(client(), a2.url), 200, 'a repost has no photos of its own to hide');
  assert.ok(!heldNow(author.id) && !heldNow(quoter.id));
  assert.equal((await author.del('/api/posts/' + p)).status, 200);
  assert.ok(!(await inBucket(orig)), 'the quoted member deletes their own post as ever');
});

test('H1: someone who already reported a post as spam can still report it as csam: the report exists, it isn\'t only a silent hide', async () => {
  const me = await newUser('h1twice'), rep = await newUser('h1rep4'), mod = await moderator('h1mod4');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'spam' });
  assert.equal((await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' })).status, 201);
  const list = (await mod.get('/api/admin/reports')).data.reports.filter(r => r.type === 'post' && r.targetId === p);
  assert.ok(list.some(r => r.reason === 'csam'), 'a csam report is in the queue');
  assert.equal(list.find(r => r.reason === 'csam').deadline, list.find(r => r.reason === 'csam').created + 48 * 3600000);
});

test('F1: anyone may report, but a new or review-held account\'s report hides nothing, nor does one about a photo its reporter can\'t see', async () => {
  const author = await newUser('f1a'), mod = await moderator('f1mod');
  const m = await photo(author);
  const p = await post(author, 'x', [m.id]);
  const newbie = await unverified('f1new');
  assert.equal((await newbie.post('/api/reports', { type: 'post', id: p, reason: 'csam' })).status, 201, 'a new account can still report');
  const review = await newUser('f1held');
  sql(`UPDATE users SET held = 1 WHERE id = ${review.id}`);
  assert.equal((await review.post('/api/reports', { type: 'post', id: p, reason: 'csam' })).status, 201, 'so can one waiting for review');
  assert.equal(await fetchStatus(client(), m.url), 200, 'neither hid anything');
  // a private profile's post, reported by a stranger it blocked, who can't see it
  const priv = await newUser('f1priv'), fan = await newUser('f1fan'), stranger = await newUser('f1str');
  await priv.put('/api/me/settings', { followPolicy: 'approve' });
  await fan.post('/api/follows/' + priv.name);
  await priv.post('/api/followers/' + fan.name);
  const pm = await photo(priv);
  const pp = await post(priv, 'friends only', [pm.id]);
  await priv.post('/api/blocks/' + stranger.name);
  assert.equal(await fetchStatus(stranger, pm.url), 404);
  assert.equal((await stranger.post('/api/reports', { type: 'post', id: pp, reason: 'csam' })).status, 201, 'a victim who was blocked can still report');
  assert.equal(await fetchStatus(fan, pm.url), 200, 'but hides nothing they can\'t see');
  const queue = (await mod.get('/api/admin/reports')).data.reports;
  assert.equal(queue.filter(r => r.type === 'post' && r.targetId === p && r.reason === 'csam').length, 2, 'both reach the moderators');
  assert.ok(queue.some(r => r.type === 'post' && r.targetId === pp && r.reason === 'csam'));
});

test('F1: a repeat report changes nothing (its snapshot stays what it hid), and a report is never refused for repeating', async () => {
  const me = await newUser('f1rep'), rep = await newUser('f1reprep'), mod = await moderator('f1repmod');
  const a = await photo(me, 'avatar'), b = await photo(me, 'avatar');
  await me.put('/api/me/profile', { avatar: a.url });
  await rep.post('/api/reports', { type: 'user', name: me.name, reason: 'csam' });
  await me.put('/api/me/profile', { avatar: b.url });
  assert.equal((await rep.post('/api/reports', { type: 'user', name: me.name, reason: 'csam' })).status, 201);
  assert.equal(await fetchStatus(client(), b.url), 200, 'the new picture isn\'t hidden by a repeat');
  assert.deepEqual((await reportOf(mod, 'user', me.id)).snapshot.media.map(m => m.id), [a.id]);
  const target = await newUser('f1cap');
  for (let i = 0; i < 3; i++) {
    assert.equal((await rep.post('/api/reports', { type: 'user', name: target.name, reason: 'spam' })).status, 201);
    await mod.post(`/api/admin/reports/${(await reportOf(mod, 'user', target.id)).id}`, { action: 'dismiss' });
  }
  assert.equal((await rep.post('/api/reports', { type: 'user', name: target.name, reason: 'spam' })).status, 201, 'a fourth in 30 days is still filed');
});

test('F1: a hide or ban decided on another report about the same post leaves the csam report open', async () => {
  const me = await newUser('f1d'), rep = await newUser('f1drep'), rep2 = await newUser('f1drep2'), mod = await moderator('f1dmod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  await rep2.post('/api/reports', { type: 'post', id: p, reason: 'spam' });
  const all = (await mod.get('/api/admin/reports')).data.reports.filter(r => r.type === 'post' && r.targetId === p);
  assert.equal((await mod.post(`/api/admin/reports/${all.find(r => r.reason === 'spam').id}`, { action: 'hide_ban', note: 'spammer' })).status, 200);
  const csam = (await mod.get('/api/admin/reports')).data.reports.find(r => r.type === 'post' && r.targetId === p && r.reason === 'csam');
  assert.equal(csam && csam.status, 'open', 'only its own decision closes it');
  assert.ok(!heldNow(me.id), 'and a ban is not a hold');
});

/* ------------------------------------------------------ H2: what a moderator can do to it, and undo */

test('H2: Remove and Unhide are refused on a photo a csam report holds; an override needs a note and is logged', async () => {
  const me = await newUser('h2'), rep = await newUser('h2rep'), mod = await moderator('h2mod');
  const m = await photo(me), loose = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const before = await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', note: 'cleaning up' });
  assert.equal(before.status, 409, 'Remove is refused');
  assert.equal(before.data.code, 'child_safety_hold');
  assert.ok(await inBucket(m), 'still in storage');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'unhide' })).status, 409, 'Unhide is refused');
  assert.equal(await fetchStatus(client(), m.url), 404, 'not republished');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', override: true })).status, 400, 'an override without a note');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', override: true, note: '   ' })).status, 400, 'a blank note isn\'t a note');
  assert.ok(await inBucket(m));
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'hide' })).status, 200, 'hiding is always allowed');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'reviewed' })).status, 200, 'so is marking it seen');
  assert.deepEqual((await mod.post(`/api/admin/media/${m.id}`, { action: 'unhide', override: true, note: 'court order 12' })).data, { ok: true });
  assert.equal(await fetchStatus(client(), m.url), 200, 'an override does what it says');
  assert.deepEqual((await logOf(mod, m.id)).filter(l => /override/.test(l.action)).map(l => [l.action, /court order 12/.test(l.note)]), [['unhide_override', true]]);
  await mod.post(`/api/admin/media/${m.id}`, { action: 'hide' });
  assert.deepEqual((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', override: true, note: 'counsel said to' })).data, { ok: true });
  assert.ok(!(await inBucket(m)));
  assert.ok((await logOf(mod, m.id)).some(l => l.action === 'remove_media_override' && /counsel said to/.test(l.note)));
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove' })).status, 404, 'gone, not "held"');
  assert.equal((await mod.post(`/api/admin/media/${loose.id}`, { action: 'hide' })).status, 200);
  assert.equal((await mod.post(`/api/admin/media/${loose.id}`, { action: 'remove' })).status, 200, 'a photo no report holds is removed as ever');
  assert.deepEqual((await logOf(mod, loose.id)).map(l => l.action).sort(), ['hide', 'remove_media'], 'and logged plainly');
});

test('F3/F5: a csam report is decided by itself, with a note: dismissal shows its photos again once no other report holds them, and each is logged', async () => {
  const me = await newUser('f5'), a = await newUser('f5a'), b = await newUser('f5b'), rep2 = await newUser('f5c'), mod = await moderator('f5mod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await a.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  await b.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const [ra, rb] = (await mod.get('/api/admin/reports')).data.reports.filter(r => r.type === 'post' && r.targetId === p).sort((x, y) => x.id - y.id);
  for (const action of ['hide', 'ban', 'hide_ban', 'intimate', 'csam']) assert.equal((await mod.post(`/api/admin/reports/${ra.id}`, { action, note: 'x' })).status, 409, `${action} isn't a decision on a csam report`);
  assert.equal((await mod.post(`/api/admin/reports/${ra.id}`, { action: 'dismiss' })).status, 400, 'a dismissal needs a note');
  assert.equal((await mod.post(`/api/admin/reports/${ra.id}`, { action: 'dismiss', note: 'a sunset' })).status, 200);
  assert.equal(await fetchStatus(client(), m.url), 404, 'the other reporter\'s report still holds it');
  assert.ok((await mod.get('/api/admin/reports')).data.reports.some(r => r.id === rb.id), 'and is still open, unread');
  assert.equal((await mod.post(`/api/admin/reports/${ra.id}`, { action: 'dismiss', note: 'again' })).status, 409, 'a closed report takes no decision');
  assert.equal((await mod.post(`/api/admin/reports/${rb.id}`, { action: 'dismiss', note: 'still a sunset' })).status, 200);
  assert.equal(await fetchStatus(client(), m.url), 200, 'both dismissed: shown again');
  const lines = (await mod.get('/api/admin/log')).data.log.filter(l => l.action === 'dismiss' && [ra.id, rb.id].includes(l.targetId));
  assert.equal(lines.length, 2, 'one log line per report');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM report_holds WHERE report_id IN (${ra.id}, ${rb.id})`)[0].n, 0, 'nothing left in report_holds');
  // a profile has nothing to hide
  await rep2.post('/api/reports', { type: 'user', name: me.name, reason: 'spam' });
  const rs = await reportOf(mod, 'user', me.id);
  assert.equal((await mod.post(`/api/admin/reports/${rs.id}`, { action: 'hide', note: 'x' })).status, 400);
  assert.equal((await reportOf(mod, 'user', me.id)).id, rs.id, 'and it stays open');
});

test('F3: a report nobody confirms holds nothing for the account: deleting it keeps no copy, and dismissal lets the hidden photo go from storage', async () => {
  const me = await newUser('f3'), rep = await newUser('f3rep'), mod = await moderator('f3mod');
  const tag = uniq();
  const m = await photo(me);
  const p = await post(me, `unconfirmed-${tag}`, [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const r = await reportOf(mod, 'post', p);
  assert.equal((await me.del('/api/me', { password: PW })).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${me.id}`)[0].n, 0, 'no copy of anything');
  assert.ok(!kept(`unconfirmed-${tag}`), 'its posts went');
  assert.ok(await inBucket(m), 'the reported photo itself stays hidden, for a moderator to decide');
  await runCron(async () => false);
  assert.ok(await inBucket(m), 'nobody decided: it stays');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'dismiss', note: 'nothing wrong with it' })).status, 200);
  await runCron(async () => !(await inBucket(m)));
  assert.ok(!(await inBucket(m)), 'dismissed: the deletion finishes');
});

test('H2: Take It Down: an adult\'s intimate image is removed with a plain Remove, out of storage at once, with no override', async () => {
  const me = await newUser('h2tid'), rep = await newUser('h2tidrep'), mod = await moderator('h2tidmod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'other', details: 'this is me without my consent' });
  const r = await reportOf(mod, 'post', p);
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'intimate' })).status, 200);
  assert.equal((await reportOf(mod, 'post', p)).deadline, r.created + 48 * 3600000, 'the 48-hour clock runs');
  assert.deepEqual((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', note: 'Take It Down request' })).data, { ok: true });
  assert.ok(!(await inBucket(m)), 'removed, not merely hidden');
  assert.equal(await fetchStatus(mod, m.url), 404);
});

test('H2: the report and the Photos queue say whether a photo is hidden and held, as it is now, not as it was when reported', async () => {
  const me = await newUser('h2label'), rep = await newUser('h2labelrep'), mod = await moderator('h2labelmod');
  const a = await photo(me), b = await photo(me);
  const p = await post(me, 'x', [a.id, b.id]);
  await mod.post(`/api/admin/media/${a.id}`, { action: 'hide' });
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'spam' });
  await mod.post(`/api/admin/media/${b.id}`, { action: 'hide' });
  await mod.post(`/api/admin/media/${a.id}`, { action: 'unhide' });
  assert.deepEqual((await reportOf(mod, 'post', p)).snapshot.media.map(m => [m.id, m.hidden, m.held]), [[a.id, false, false], [b.id, true, false]]);
  await mod.post(`/api/admin/media/${b.id}`, { action: 'remove' });
  assert.equal((await reportOf(mod, 'post', p)).snapshot.media.find(m => m.id === b.id).gone, true);
  await (await newUser('h2labelrep2')).post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  assert.equal((await mod.get('/api/admin/media?filter=all')).data.media.find(m => m.id === a.id).held, true);
});

test('H2: the orphan the review found: a held photo whose post is gone can\'t be unhidden into the cron\'s hands', async () => {
  const me = await newUser('h2orphan'), rep = await newUser('h2orphanrep'), mod = await moderator('h2orphanmod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  assert.equal((await me.del('/api/posts/' + p)).status, 200);
  assert.deepEqual(sql(`SELECT post_id, hidden FROM media WHERE id = ${m.id}`), [{ post_id: null, hidden: 1 }], 'an orphan, still hidden');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'unhide' })).status, 409);
  await runCron(async () => false);
  assert.ok(await inBucket(m), 'the cron has no way to it');
  assert.equal(await fetchStatus(mod, m.url), 200);
});

/* --------------------------------------------- H3: a hold, which only a moderator's confirmation starts */

test('H3: confirming needs a csam report and a note; it bans the account at once and starts the hold; releasing it deletes the confirmed photo', async () => {
  const me = await newUser('h3c'), rep = await newUser('h3crep'), rep2 = await newUser('h3crep2'), mod = await moderator('h3cmod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep2.post('/api/reports', { type: 'post', id: p, reason: 'spam' });
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const all = (await mod.get('/api/admin/reports')).data.reports.filter(r => r.type === 'post' && r.targetId === p);
  const r = all.find(x => x.reason === 'csam'), spam = all.find(x => x.reason === 'spam');
  assert.equal((await mod.post(`/api/admin/reports/${spam.id}`, { action: 'confirm', note: 'x' })).status, 409, 'only a csam report can be confirmed');
  assert.equal((await rep.post(`/api/admin/reports/${r.id}`, { action: 'confirm', note: 'x' })).status, 403, 'moderators only');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'confirm' })).status, 400, 'a confirmation needs a note');
  assert.ok(!heldNow(me.id));
  await confirm(mod, r, 'NCMEC 98765');
  assert.ok(heldNow(me.id), 'held from the confirmation');
  assert.equal((await me.get('/api/me')).data.user, null, 'and banned in the same moment: signed out');
  assert.equal((await client().post('/api/login', { login: me.email, password: PW })).status, 403, 'as for any ban');
  assert.equal((await reportOf(mod, 'post', p, 'closed')).status, 'confirmed');
  assert.equal((await mod.get('/api/admin/reports?status=closed')).data.reports.find(x => x.id === spam.id).status, 'actioned', 'the other report closes with it');
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'confirm_csam' && l.targetId === r.id && /98765/.test(l.note)));
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove' })).status, 409);
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'dismiss', note: 'x' })).status, 409, 'a confirmed report is not dismissed');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'release' })).status, 400, 'a release needs a note');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'release', note: 'a year on, NCMEC 98765' })).status, 200);
  assert.ok(!(await inBucket(m)), 'the confirmed photo is deleted, never shown again');
  assert.ok(!heldNow(me.id));
  assert.equal((await reportOf(mod, 'post', p, 'closed')).status, 'released');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM report_holds WHERE report_id = ${r.id}`)[0].n, 0);
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'release', note: 'again' })).status, 409);
});

test('H3: a held account whose ban is lifted (in the database: the site refuses), which then deletes itself, is gone from its own side like any account, and its data stays until released', async () => {
  const suspect = await newUser('h3s'), victim = await newUser('h3v'), mod = await moderator('h3mod');
  const tag = uniq();
  const pic = await photo(suspect, 'avatar'), other = await photo(suspect);
  await suspect.put('/api/me/profile', { avatar: pic.url, about: `about-${tag}` });
  await post(suspect, `public-${tag}`, [other.id]);
  const d = await dm(suspect, victim, `meet-me-${tag}`, `who-are-you-${tag}`);
  const cleared = await suspect.post(`/api/chats/${d.chat}/messages`, { body: `then-cleared-${tag}` });
  assert.equal(cleared.status, 201, JSON.stringify(cleared.data));
  assert.equal((await victim.post('/api/reports', { type: 'message', id: d.a.id, reason: 'csam' })).status, 201);
  const r = await reportOf(mod, 'message', d.a.id);
  await confirm(mod, r);
  sql(`UPDATE users SET banned = 0 WHERE id = ${suspect.id}`);
  assert.equal((await suspect.post('/api/login', { login: suspect.email, password: PW })).status, 200);
  assert.equal((await suspect.del('/api/chat-messages/' + cleared.data.message.id)).status, 200);
  const gone = await suspect.del('/api/me', { password: PW });
  assert.deepEqual([gone.status, gone.data], [200, { ok: true }], 'the same answer as any deletion');
  assert.equal((await suspect.get('/api/me')).data.user, null);
  assert.equal((await client().get('/api/users/' + suspect.name)).status, 404);
  const login = await client().post('/api/login', { login: suspect.email, password: PW });
  assert.deepEqual([login.status, login.data.error], [401, 'wrong email, screen name or password.']);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM users WHERE id = ${suspect.id}`)[0].n, 0, 'the account really is gone');
  assert.equal((await client().post('/api/signup', { email: suspect.email, password: PW, name: suspect.name, birthday: '1995-08-15', rulesOk: true })).status, 201, 'they can sign up again like anyone');
  for (const words of [`meet-me-${tag}`, `who-are-you-${tag}`, `then-cleared-${tag}`, `public-${tag}`, `about-${tag}`]) assert.ok(kept(words), `kept: ${words}`);
  assert.ok(sql(`SELECT COUNT(*) AS n FROM evidence WHERE source = 'account' AND data LIKE '%${suspect.email}%'`)[0].n, 'the account');
  assert.equal(sql('SELECT COUNT(*) AS n FROM evidence WHERE data LIKE \'%pbkdf2%\'')[0].n, 0, 'never its password');
  assert.ok(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${suspect.id} AND source = 'signal'`)[0].n, 'its sign-up signals');
  assert.ok((await inBucket(pic)) && (await inBucket(other)), 'its photos');
  assert.equal(await fetchStatus(client(), other.url), 404, 'shown to nobody');
  await runCron(async () => false);
  assert.ok(await inBucket(other), 'the cron leaves it');
  assert.equal((await mod.post(`/api/admin/media/${other.id}`, { action: 'remove' })).status, 409, 'a kept photo is held');
  assert.ok((await reportOf(mod, 'message', d.a.id, 'closed')).preserved > 0, 'the report says something was preserved');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'release', note: 'a year on' })).status, 200);
  await runCron(async () => sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${suspect.id}`)[0].n === 0 && !(await inBucket(other)));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${suspect.id}`)[0].n, 0, 'the copies go once the hold is released');
  assert.ok(!kept(`then-cleared-${tag}`));
  assert.ok(!(await inBucket(other)) && !(await inBucket(pic)), 'and the photos it alone was keeping');
});

test('H3: the victim deleting their own account keeps the DM with a held account, and nothing else of theirs', async () => {
  const suspect = await newUser('h3ds'), victim = await newUser('h3dv'), rep = await newUser('h3drep'), mod = await moderator('h3dmod');
  const tag = uniq();
  await dm(suspect, victim, `suspect-line-${tag}`, `victim-line-${tag}`);
  await post(victim, `victim-post-${tag}`);
  await rep.post('/api/reports', { type: 'user', name: suspect.name, reason: 'csam' });
  await confirm(mod, await reportOf(mod, 'user', suspect.id));
  assert.equal((await victim.del('/api/me', { password: PW })).status, 200);
  assert.ok(kept(`suspect-line-${tag}`) && kept(`victim-line-${tag}`), 'both sides of the DM');
  assert.ok(!kept(`victim-post-${tag}`), 'their posts still go');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${victim.id}`)[0].n, 0, 'nothing is filed under the victim');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE source = 'account' AND data LIKE '%${victim.email}%'`)[0].n, 0, 'nor their account');
});

test('H3: an ordinary deletion deletes everything it always did, whoever it was talking to, and keeps no copy', async () => {
  const a = await newUser('h3oa'), b = await newUser('h3ob'), rep = await newUser('h3orep'), mod = await moderator('h3omod');
  const tag = uniq();
  const m = await photo(a), pic = await photo(a, 'avatar');
  await a.put('/api/me/profile', { avatar: pic.url, about: `plain-about-${tag}` });
  const p = await post(a, `plain-post-${tag}`, [m.id]);
  await dm(a, b, `plain-a-${tag}`, `plain-b-${tag}`);
  await rep.post('/api/reports', { type: 'user', name: a.name, reason: 'spam' });
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  await mod.post(`/api/admin/reports/${(await reportOf(mod, 'post', p)).id}`, { action: 'dismiss', note: 'nothing wrong with it' });
  assert.equal((await a.del('/api/me', { password: PW })).status, 200);
  for (const words of [`plain-post-${tag}`, `plain-a-${tag}`, `plain-b-${tag}`, `plain-about-${tag}`]) assert.ok(!kept(words), `gone: ${words}`);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${a.id}`)[0].n, 0);
  assert.equal(sql(`SELECT (SELECT COUNT(*) FROM users WHERE id = ${a.id}) + (SELECT COUNT(*) FROM profiles WHERE user_id = ${a.id})
    + (SELECT COUNT(*) FROM signup_signals WHERE user_id = ${a.id}) + (SELECT COUNT(*) FROM media WHERE owner_id = ${a.id}) AS n`)[0].n, 0);
  assert.ok(!(await inBucket(m)) && !(await inBucket(pic)), 'its photos left storage');
});

test('H3: the 90-day sweeps skip a confirmed hold, and still clear everyone else\'s, an unconfirmed report\'s included', async () => {
  const held = await newUser('h3b'), plain = await newUser('h3p'), open = await newUser('h3u'), rep = await newUser('h3prep'), mod = await moderator('h3pmod');
  await rep.post('/api/reports', { type: 'user', name: held.name, reason: 'csam' });
  await confirm(mod, await reportOf(mod, 'user', held.id));
  await rep.post('/api/reports', { type: 'user', name: open.name, reason: 'csam' });
  const old = Date.now() - 91 * DAY;
  const ids = [held.id, plain.id, open.id].join(', ');
  sql(`UPDATE signup_signals SET created = ${old} WHERE user_id IN (${ids});
    INSERT INTO ai_scans (user_id, kind, words, decision, created) VALUES (${held.id}, 'status', 80, 'clear', ${old}), (${plain.id}, 'status', 80, 'clear', ${old}), (${open.id}, 'status', 80, 'clear', ${old})`);
  const rows = id => sql(`SELECT (SELECT COUNT(*) FROM signup_signals WHERE user_id = ${id}) AS signals, (SELECT COUNT(*) FROM ai_scans WHERE user_id = ${id}) AS scans`)[0];
  await runCron(async () => rows(plain.id).signals === 0 && rows(open.id).signals === 0);
  assert.deepEqual(rows(plain.id), { signals: 0, scans: 0 }, 'an ordinary account\'s go at 90 days');
  assert.deepEqual(rows(open.id), { signals: 0, scans: 0 }, 'so does one with an unconfirmed report');
  assert.deepEqual(rows(held.id), { signals: 1, scans: 1 }, 'a held account\'s stay');
});

test('H3: #ourspace\'s rolling window doesn\'t take what a held account said', async () => {
  const s = await newUser('h3room'), plain = await newUser('h3roomp'), rep = await newUser('h3roomr'), mod = await moderator('h3roommod');
  const tag = uniq();
  const line = async (who, body) => { const r = await who.post('/api/ourspace/messages', { body }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.message || r.data; };
  const a = await line(s, `room-held-${tag}`), b = await line(plain, `room-plain-${tag}`);
  await rep.post('/api/reports', { type: 'user', name: s.name, reason: 'csam' });
  await confirm(mod, await reportOf(mod, 'user', s.id));
  sql(`UPDATE chat_messages SET created = ${Date.now() - 2 * DAY} WHERE id IN (${a.id}, ${b.id})`);
  await runCron(async () => !kept(`room-plain-${tag}`));
  assert.ok(!kept(`room-plain-${tag}`), 'the window ran');
  assert.ok(kept(`room-held-${tag}`), 'a held account\'s line is kept');
});

test('F7: only a held account\'s own words are kept: a friend\'s comment on its page, deleted by that friend, goes as ever', async () => {
  const { held } = await heldMember('f7');
  const friend = await newUser('f7f');
  await befriend(held, friend);
  const tag = uniq();
  const c = await friend.post(`/api/users/${held.name}/comments`, { body: `friend-wall-${tag}` });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const own = await post(held, `held-own-${tag}`);
  assert.equal((await friend.del('/api/posts/' + (c.data.id || c.data.comment?.id || c.data.post?.id))).status, 200);
  assert.equal((await held.del('/api/posts/' + own)).status, 200);
  assert.ok(!kept(`friend-wall-${tag}`), 'the friend\'s own deletion deletes');
  assert.ok(kept(`held-own-${tag}`), 'the held account\'s is kept');
});

/* ------------------------------------- H5 and F2: a held member's own actions, and what they can see */

test('H5: a held member who deletes a post, changes their picture or takes back an upload gets the usual answers, and loses nothing the hold keeps', async () => {
  const { held, mod, report } = await heldMember('h5');
  const onPost = await photo(held), pic1 = await photo(held, 'avatar'), pic2 = await photo(held, 'avatar'), loose = await photo(held);
  await held.put('/api/me/profile', { avatar: pic1.url });
  const p = await post(held, 'with a photo', [onPost.id]);
  assert.deepEqual((await held.del('/api/posts/' + p)).data, { ok: true, tombstone: false });
  const changed = await held.put('/api/me/profile', { avatar: pic2.url });
  assert.deepEqual([changed.status, changed.data.avatar], [200, pic2.url]);
  assert.deepEqual((await held.del('/api/media/' + loose.id)).data, { ok: true });
  assert.equal((await held.del('/api/media/' + loose.id)).status, 404, 'taken back twice: gone, as for anyone');
  for (const m of [onPost, pic1, loose]) {
    assert.ok(await inBucket(m), `kept: ${m.id}`);
    assert.equal(await fetchStatus(client(), m.url), 404);
    assert.equal(await fetchStatus(held, m.url), 404, 'not even to its owner');
    assert.equal(await fetchStatus(mod, m.url), 200);
  }
  assert.equal(await fetchStatus(client(), pic2.url), 200, 'the new picture is public as usual');
  await mod.post(`/api/admin/reports/${report.id}`, { action: 'release', note: 'checked: released' });
  await runCron(async () => !(await inBucket(onPost)) && !(await inBucket(pic1)) && !(await inBucket(loose)));
  for (const m of [onPost, pic1, loose]) assert.ok(!(await inBucket(m)), `released: ${m.id}`);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${held.id}`)[0].n, 0);
  assert.ok(await inBucket(pic2));
  assert.equal(await fetchStatus(client(), pic2.url), 200);
});

test('H5: nobody outside a hold is touched: the same three actions by an ordinary member delete at once, as they always did', async () => {
  const me = await newUser('h5plain');
  const onPost = await photo(me), pic1 = await photo(me, 'avatar'), pic2 = await photo(me, 'avatar'), loose = await photo(me);
  await me.put('/api/me/profile', { avatar: pic1.url });
  const p = await post(me, 'x', [onPost.id]);
  await me.del('/api/posts/' + p);
  await me.put('/api/me/profile', { avatar: pic2.url });
  await me.del('/api/media/' + loose.id);
  for (const m of [onPost, pic1, loose]) assert.ok(!(await inBucket(m)), `deleted at once: ${m.id}`);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM media WHERE id IN (${onPost.id}, ${pic1.id}, ${loose.id})`)[0].n, 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${me.id}`)[0].n, 0);
});

test('F2: what a held member can see stays what anyone sees: an expired upload is gone to them and uncounted; a taken-back one can\'t be posted', async () => {
  const { held } = await heldMember('f2');
  const plain = await newUser('f2plain');
  const old = await photo(held), plainOld = await photo(plain), back = await photo(held), plainBack = await photo(plain);
  sql(`UPDATE media SET created = created - ${2 * DAY} WHERE id IN (${old.id}, ${plainOld.id})`);
  await runCron(async () => !(await inBucket(plainOld)));
  assert.equal(await fetchStatus(plain, plainOld.url), 404, 'an ordinary member\'s expired upload is gone');
  assert.equal(await fetchStatus(held, old.url), 404, 'and so is the held member\'s, to them');
  assert.ok(await inBucket(old), 'though it is kept');
  assert.ok(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${held.id} AND source = 'photo' AND source_id = ${old.id}`)[0].n, 'and not counted against them');
  await held.del('/api/media/' + back.id);
  await plain.del('/api/media/' + plainBack.id);
  const tried = await held.post('/api/status', { body: 'x', media: [back.id] });
  const plainTried = await plain.post('/api/status', { body: 'x', media: [plainBack.id] });
  assert.deepEqual([tried.status, tried.data.error], [plainTried.status, plainTried.data.error], 'the same refusal as anyone gets');
  assert.equal(tried.status, 400);
});

test('H5: a held photo the uploader could see doesn\'t count against their 200 MB, so the limit can\'t tell them anything', async () => {
  const { held } = await heldMember('h5cap');
  const kept = await photo(held);
  const p = await post(held, 'x', [kept.id]);
  await held.del('/api/posts/' + p);
  const bytes = sql(`SELECT bytes FROM media WHERE id = ${kept.id}`)[0].bytes;
  sql(`INSERT INTO media (key, owner_id, purpose, mime, bytes, width, height, created) VALUES ('${'e'.repeat(32)}.png', ${held.id}, 'post', 'image/png', ${200 * 1024 * 1024 - bytes - 1000}, 1, 1, ${Date.now()})`);
  const res = await held.raw('POST', '/api/media', { body: png({ width: 10, height: 10 }), headers: { 'Content-Type': 'image/png' } });
  assert.equal(res.status, 201, 'the kept photo is not theirs to count');
});

test('F4/H5: a moderator\'s own hide survives the hold ending: on a post the moderator hid, or on a kept photo the moderator hid again', async () => {
  const { held, mod, report } = await heldMember('f4');
  const m = await photo(held), k = await photo(held);
  const p = await post(held, 'x', [m.id]);
  assert.equal((await mod.post('/api/admin/content', { type: 'post', id: p, hidden: true, note: 'keep this' })).status, 200);
  const q = await post(held, 'y', [k.id]);
  assert.equal((await held.del('/api/posts/' + q)).status, 200);          // kept for the hold
  assert.equal((await mod.post(`/api/admin/media/${k.id}`, { action: 'hide', note: 'my own reason' })).status, 200);
  assert.equal((await held.del('/api/me', { password: PW })).status, 200);
  await mod.post(`/api/admin/reports/${report.id}`, { action: 'release', note: 'released' });
  await runCron(async () => sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${held.id}`)[0].n === 0);
  await runCron(async () => false);
  assert.ok(await inBucket(m), 'the moderator hid its post: only a moderator removes it');
  assert.ok(await inBucket(k), 'the moderator hid it themselves: it stays theirs');
  assert.deepEqual(sql(`SELECT hidden FROM media WHERE id IN (${m.id}, ${k.id}) ORDER BY id`), [{ hidden: 1 }, { hidden: 1 }]);
});

/* ---------------------------------------------------- round 2: A, B, C, D and the unban */

test('A: once confirmed, a photo is never shown again but by an override: not by releasing it while another report lists it, nor by dismissing that report', async () => {
  const me = await newUser('ra'), r1 = await newUser('rar1'), r3 = await newUser('rar3'), mod = await moderator('ramod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await r1.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  await r3.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const [one, three] = (await mod.get('/api/admin/reports')).data.reports.filter(r => r.type === 'post' && r.targetId === p).sort((a, b) => a.id - b.id);
  await confirm(mod, one);
  assert.equal((await mod.post(`/api/admin/reports/${one.id}`, { action: 'release', note: 'a year on' })).status, 200);
  assert.ok(await inBucket(m), 'the other open report still lists it: kept');
  assert.equal((await mod.post(`/api/admin/reports/${three.id}`, { action: 'dismiss', note: 'not sure' })).status, 200);
  assert.deepEqual(sql(`SELECT hidden FROM media WHERE id = ${m.id}`), [{ hidden: 1 }], 'a dismissal can\'t show confirmed material');
  const tried = await mod.post(`/api/admin/media/${m.id}`, { action: 'unhide' });
  assert.deepEqual([tried.status, tried.data.code], [409, 'child_safety_hold'], 'nor can a plain Unhide');
  sql(`UPDATE users SET banned = 0 WHERE id = ${me.id}`);
  assert.equal(await fetchStatus(client(), m.url), 404, 'nor an unban');
  await runCron(async () => !(await inBucket(m)));
  assert.ok(!(await inBucket(m)), 'nothing holds it any more: released material is deleted');
});

test('B: every csam report lists its photos, whoever filed it, so the uploader deleting the account only hides them until a moderator decides; listing hides nothing', async () => {
  const me = await newUser('rb'), rep = await unverified('rbrep'), mod = await moderator('rbmod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  assert.equal(await fetchStatus(client(), m.url), 200, 'listed, not hidden');
  const r = await reportOf(mod, 'post', p);
  assert.deepEqual(r.snapshot.media.map(x => [x.id, x.hidden, x.held]), [[m.id, false, true]], 'the report shows it listed and still visible');
  assert.equal((await me.del('/api/me', { password: PW })).status, 200);
  assert.ok(await inBucket(m), 'the deletion can\'t destroy it');
  assert.equal(await fetchStatus(client(), m.url), 404, 'it only takes it out of sight');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM evidence WHERE user_id = ${me.id}`)[0].n, 0, 'and copies nothing else: no account hold');
  assert.equal((await mod.post(`/api/admin/reports/${r.id}`, { action: 'dismiss', note: 'nothing there' })).status, 200);
  await runCron(async () => !(await inBucket(m)));
  assert.ok(!(await inBucket(m)), 'dismissed: exactly what it listed goes, and the deletion finishes');
});

test('C: releasing one confirmed report spares its photos while another confirmed report still holds the account; the cron deletes them once nothing does', async () => {
  const me = await newUser('rc'), ra = await newUser('rcra'), rb = await newUser('rcrb'), mod = await moderator('rcmod');
  const m = await photo(me);
  const pa = await post(me, 'a', [m.id]);
  const pb = await post(me, 'b');
  await ra.post('/api/reports', { type: 'post', id: pa, reason: 'csam' });
  await rb.post('/api/reports', { type: 'post', id: pb, reason: 'csam' });
  const a = await reportOf(mod, 'post', pa), b = await reportOf(mod, 'post', pb);
  await confirm(mod, a);
  await confirm(mod, b);
  await mod.post(`/api/admin/reports/${a.id}`, { action: 'release', note: 'a year on' });
  assert.ok(await inBucket(m), 'report B still holds its owner');
  await runCron(async () => false);
  assert.ok(await inBucket(m), 'and the cron agrees');
  await mod.post(`/api/admin/reports/${b.id}`, { action: 'release', note: 'a year on too' });
  await runCron(async () => !(await inBucket(m)));
  assert.ok(!(await inBucket(m)), 'both released: deleted');
});

test('D: a dismissal sticks for 30 days: the same photo isn\'t auto-hidden again, and the dismissed reporter auto-hides nothing; reports still go through, to the top', async () => {
  const me = await newUser('rd1'), x = await newUser('rd1x'), y = await newUser('rd1y'), other = await newUser('rd1o'), mod = await moderator('rd1mod');
  const m = await photo(me), mo = await photo(other);
  const p = await post(me, 'x', [m.id]), po = await post(other, 'y', [mo.id]);
  await x.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  await mod.post(`/api/admin/reports/${(await reportOf(mod, 'post', p)).id}`, { action: 'dismiss', note: 'a sunset' });
  assert.equal(await fetchStatus(client(), m.url), 200);
  assert.equal((await y.post('/api/reports', { type: 'post', id: p, reason: 'csam' })).status, 201, 'a second account\'s report is filed');
  assert.equal(await fetchStatus(client(), m.url), 200, 'but doesn\'t hide it again');
  const queue = (await mod.get('/api/admin/reports')).data.reports;
  assert.equal(queue[0].reason, 'csam', 'and goes to the top of the queue');
  assert.ok(queue.some(r => r.type === 'post' && r.targetId === p && r.reason === 'csam'));
  assert.equal((await x.post('/api/reports', { type: 'post', id: po, reason: 'csam' })).status, 201);
  assert.equal(await fetchStatus(client(), mo.url), 200, 'the dismissed reporter hides nothing elsewhere either');
});

test('D: one reporter auto-hides 3 things a day at most; the fourth report is filed and lists its photo, but hides nothing', async () => {
  const x = await newUser('rd3x'), mod = await moderator('rd3mod');
  const shown = [];
  let last;
  for (let i = 0; i < 4; i++) {
    const u = await newUser('rd3u');
    const m = await photo(u);
    last = { p: await post(u, 'x', [m.id]), m };
    assert.equal((await x.post('/api/reports', { type: 'post', id: last.p, reason: 'csam' })).status, 201);
    shown.push(await fetchStatus(client(), m.url));
  }
  assert.deepEqual(shown, [404, 404, 404, 200]);
  assert.equal((await reportOf(mod, 'post', last.p)).snapshot.media[0].held, true, 'the fourth still lists it');
});

test('U: a held account can\'t be unbanned until its hold is released; then it can', async () => {
  const me = await newUser('ru'), rep = await newUser('rurep'), mod = await moderator('rumod');
  const p = await post(me, 'x');
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'csam' });
  const r = await reportOf(mod, 'post', p);
  await confirm(mod, r);
  const un = await mod.post('/api/admin/users/' + me.name, { banned: false });
  assert.equal(un.status, 409);
  assert.match(un.data.error, /release/);
  assert.equal((await client().post('/api/login', { login: me.email, password: PW })).status, 403, 'still banned');
  await mod.post(`/api/admin/reports/${r.id}`, { action: 'release', note: 'released' });
  assert.equal((await mod.post('/api/admin/users/' + me.name, { banned: false })).status, 200, 'released: the ban is an ordinary ban again');
});

/* ----------------------------------------- H4: an image of someone under 18 */

test('H4: a report marked intimate can be turned into a child-safety report: its photos are hidden and held at once; the hold on the account waits for a confirmation', async () => {
  const me = await newUser('h4'), rep = await newUser('h4rep'), mod = await moderator('h4mod');
  const m = await photo(me);
  const p = await post(me, 'x', [m.id]);
  await rep.post('/api/reports', { type: 'post', id: p, reason: 'other' });
  const r = await reportOf(mod, 'post', p);
  await mod.post(`/api/admin/reports/${r.id}`, { action: 'intimate' });
  assert.equal((await rep.post(`/api/admin/reports/${r.id}`, { action: 'csam' })).status, 403, 'moderators only');
  assert.deepEqual((await mod.post(`/api/admin/reports/${r.id}`, { action: 'csam', note: 'looks under 18' })).data, { ok: true });
  const after = await reportOf(mod, 'post', p);
  assert.deepEqual([after.reason, after.intimate, after.status, after.deadline], ['csam', false, 'open', r.created + 48 * 3600000]);
  assert.equal(await fetchStatus(client(), m.url), 404, 'hidden at once');
  assert.equal((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove' })).status, 409, 'and can\'t be removed by the Take It Down habit');
  assert.ok(!heldNow(me.id), 'no account hold yet');
  await confirm(mod, after);
  assert.ok(heldNow(me.id), 'until a moderator confirms it');
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'mark_csam' && l.targetId === r.id));
});

/* ------------------------------------------------------------ the migration */

test('0014 keeps listing the photos of csam reports still open, holds no account, and survives a snapshot that isn\'t a list', () => {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const earlier = path.join(OLD_STATE, 'earlier.sql');
  fs.writeFileSync(earlier, files.filter(f => f < '0014').map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'));
  d1(OLD_STATE, ['--file', earlier]);
  d1(OLD_STATE, ['--command', `INSERT INTO users (id, name, name_key, avatar, birthdate, created) VALUES (1, 'a', 'a', '/a.png', '1990-01-01', 1), (2, 'b', 'b', '/b.png', '1990-01-01', 1);
    INSERT INTO reports (id, reporter_id, target_type, target_id, target_user_id, reason, snapshot, status, created) VALUES
      (1, 2, 'post', 9, 1, 'csam', '{"media":[{"id":5},{"id":6},"oops",{"id":"x"}]}', 'open', 1),
      (2, 2, 'post', 9, 1, 'spam', '{"media":[{"id":5}]}', 'open', 1),
      (3, 2, 'user', 2, 2, 'csam', '{"media":[{"id":7}]}', 'actioned', 1),
      (4, 2, 'post', 8, 1, 'csam', '{"media":"oops"}', 'open', 1),
      (5, 2, 'post', 7, 1, 'csam', 'not json', 'open', 1)`]);
  d1(OLD_STATE, ['--file', path.join(dir, files.find(f => f.startsWith('0014')))]);
  const q = command => d1(OLD_STATE, ['--command', command])[0].results;
  assert.deepEqual(q('SELECT report_id, kind, target FROM report_holds ORDER BY report_id, kind, target'),
    [{ report_id: 1, kind: 'media', target: 5 }, { report_id: 1, kind: 'media', target: 6 }]);
  assert.deepEqual(q('SELECT user_id FROM held_accounts'), [], 'nothing was ever confirmed');
});
