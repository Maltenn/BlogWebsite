// End-to-end API tests: `npm test`. Boots `wrangler dev` on a throwaway local database, with a stand-in for Google,
// Discord and Spotify (helpers/mock-providers.mjs), then drives the API like a browser does —
// cookies, redirects, JSON, photo uploads, the lot. The local R2 bucket is listed through wrangler's local explorer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './helpers/mock-providers.mjs';
import { hot, wilson, RESORT } from '../src/shared/ranking.js';
import { jpeg, png, gif, webp } from './helpers/images.mjs';
import { fillForm, randomIp, verifyTokenIn, TURNSTILE_TEST_TOKEN, BROWSER } from './helpers/human.mjs';
import { runBotSim } from '../tools/bot-sim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// run wrangler.js through node itself: node_modules/.bin/wrangler is a shell script, which Windows can't spawn
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER = `ourspace-social-test-${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-test-'));
let server, mock;
let serverLog = '';

const sql = command => JSON.parse(execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'ourspace-social-db', '--local', '--persist-to', STATE, '--json', '--command', command],
  { cwd: ROOT, stdio: 'pipe' }).toString())[0].results;

before(async () => {
  mock = await startMock();
  const vars = {
    SIGNUPS_PER_IP_PER_HOUR: '1000', SIGNUPS_PER_DAY: '1000', TEST_PROVIDER_BASE: mock.base, TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', DISCORD_CLIENT_ID: 'd-id', DISCORD_CLIENT_SECRET: 'd-secret',
    SPOTIFY_CLIENT_ID: 's-id', SPOTIFY_CLIENT_SECRET: 's-secret', SHOW_ROWS_READ: '1',
    // phase 7: Cloudflare's Turnstile test keys against the stand-in siteverify, MX lookups from the stand-in DoH, an
    // easy proof of work and short form times, request.cf from X-Test-Cf, the mock AI detector in shadow mode
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_VERIFY_URL: mock.base + '/turnstile/v0/siteverify', DOH_URL: mock.base + '/dns-query',
    POW_BITS: '8', SIGNUP_MIN_MS: '100', SIGNUP_SOFT_MS: '200', TEST_SIGNALS: '1', AI_DETECTOR: 'mock', AI_ENFORCEMENT: 'shadow',
  };
  execFileSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'ourspace-social-db', '--local', '--persist-to', STATE], { cwd: ROOT, stdio: 'pipe' });
  // a unique name: the local explorer is shared by every running `wrangler dev`
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
  // stop wrangler and wait for it. On Windows, killing it leaves its workerd child holding the database files, so end the whole tree
  if (server && server.exitCode === null) {
    const exited = new Promise(res => server.once('exit', res));
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
    await exited;
  }
  if (mock) await mock.close();
  // Windows lets go of the files a moment after the processes end
  for (let i = 0; ; i++) {
    try { fs.rmSync(STATE, { recursive: true, force: true }); break; } catch (e) {
      if (i === 20) { console.warn(`could not remove ${STATE}: ${e.code}`); break; }
      await new Promise(r => setTimeout(r, 250));
    }
  }
});

// the sign-up routes, which take a filled-in form (GET /api/form/:purpose), and the routes with the Turnstile check
const FORMS = { '/api/signup': 'signup', '/api/signup/finish': 'finish' };
const TURNSTILE = new Set(['/api/login', '/api/password/forgot']);

// a tiny browser: a cookie jar, JSON in and out, redirects left for the test to look at. Like the page, it fills in the
// sign-up form's token, proof of work and Turnstile token, and the log-in and reset Turnstile token, unless the test
// passes its own (any `form` or `turnstile` key, even undefined). Each one signs up from a network of its own.
function client() {
  const jar = new Map();
  const raw = async (method, url, { body, headers = {}, form } = {}) => {
    const h = { ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body instanceof FormData) payload = body;                       // (fetch sets the multipart type)
    else if (body instanceof Uint8Array) { h['Content-Type'] = h['Content-Type'] || 'application/octet-stream'; payload = body; }
    else if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
  const ip = randomIp();
  const call = async (method, url, body, headers) => {
    if (method === 'POST' && body && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof FormData)) {
      if (FORMS[url] && !('form' in body)) {
        const form = await (await raw('GET', '/api/form/' + FORMS[url], { headers: { 'X-Test-Ip': ip } })).json();
        const at = Date.now();                       // (counted from when the form arrived, as the server counts)
        // (past SIGNUP_SOFT_MS too, as a person is: a quicker form adds a risk point)
        body = await fillForm(form, body, { fetchedAt: at, extraMs: 120, turnstile: 'turnstile' in body ? body.turnstile : TURNSTILE_TEST_TOKEN });
        headers = { ...BROWSER, 'X-Test-Ip': ip, ...headers };
      } else if (TURNSTILE.has(url) && !('turnstile' in body)) body = { ...body, turnstile: TURNSTILE_TEST_TOKEN };
    }
    const res = await raw(method, url, { body, headers });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return {
    raw, jar, ip,
    get: u => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b),
  };
}

let n = 0;
const uniq = () => `${Date.now().toString(36).slice(-4)}${n++}`;
const PW = 'correct-horse-9';
// the confirmation link the server printed for `email` (waits for the log to catch up)
async function verifyToken(email) {
  for (let i = 0; i < 100; i++) {
    const t = verifyTokenIn(serverLog, email);
    if (t) return t;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('no confirmation email for ' + email);
}

// a member: signed up (through the form, the proof of work and Turnstile) and, unless { verify: false }, with the
// email confirmed, as a new member does before posting
async function newUser(prefix = 'user', extra = {}, { verify = true } = {}) {
  const c = client();
  const id = uniq();
  const name = `${prefix}_${id}`;
  const email = `${prefix}.${id}@example.com`;
  const r = await c.post('/api/signup', { email, password: PW, name, birthday: '1995-08-15', rulesOk: true, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.held, false, 'an ordinary sign-up is not held');
  Object.assign(c, { name, email, id: r.data.user.id });
  if (verify) assert.equal((await c.post('/api/verify', { token: await verifyToken(email) })).status, 200);
  return c;
}

// one trip through a sign-in provider: start → provider (approves at once) → our callback. Returns the final redirect.
async function viaProvider(c, provider, identity, mode = 'login') {
  if (identity) mock.next(provider, identity);
  const start = await c.raw('GET', `/api/oauth/${provider}/start?mode=${mode}`);
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get('location'));
  if (!authorize.href.startsWith(mock.base)) return { location: authorize.pathname + authorize.search, authorize };
  const a = await fetch(authorize, { redirect: 'manual' });
  const back = new URL(a.headers.get('location'));
  const done = await c.raw('GET', back.pathname + back.search);
  assert.equal(done.status, 303);
  return { location: done.headers.get('location').replace(BASE, ''), authorize };
}

/* ------------------------------------------------------------------ */

test('public pages work logged out, and there are no bots', async () => {
  const c = client();
  const opts = await c.get('/api/options');
  assert.ok(opts.data.avatars.length > 100 && opts.data.themes.length === 10);
  assert.ok(!opts.data.badges.some(b => /Guest/i.test(b)), 'the guestbook button is gone');
  const prov = await c.get('/api/auth/providers');
  assert.deepEqual(prov.data.signIn.map(p => p.id).sort(), ['discord', 'google']);
  assert.equal(prov.data.spotify, true);
  assert.equal((await c.get('/api/users')).data.users.length, 0, 'nobody lives here until people sign up');
  assert.equal((await c.get('/api/users/todd')).status, 404);
  assert.equal((await c.get('/api/feed')).status, 200);
  assert.equal((await c.get('/api/chats')).status, 401);
  assert.equal((await c.get('/api/inbox')).status, 404, 'the old inbox is gone');
  assert.equal((await c.get('/api/requests')).status, 401);
});

test('sign-up: email, password, screen name, birthday', async () => {
  const base = { email: 'fresh@example.com', password: PW, name: 'fresh_face', birthday: '2000-02-29', rulesOk: true };
  const c = client();
  assert.equal((await c.post('/api/signup', { ...base, rulesOk: false })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, email: 'not-an-email' })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, birthday: '' })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, birthday: '2001-02-29' })).status, 400, 'not a real date');
  assert.equal((await c.post('/api/signup', { ...base, birthday: '2999-01-01' })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, password: 'short' })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, password: 'fresh@example.com' })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, name: 'admin' })).status, 400);
  const ok = await c.post('/api/signup', base);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.user.sign.name, 'Pisces');
  assert.equal((await client().post('/api/signup', { ...base, name: 'FRESH_FACE', email: 'other@example.com' })).status, 409, 'names are unique ignoring case');
  assert.equal((await client().post('/api/signup', { ...base, name: 'other_face', email: 'FRESH@example.com' })).status, 409, 'emails too');
});

test('the age check: under 13 is refused, and the same browser can\'t just retry', async () => {
  const kid = client();
  const y = new Date().getUTCFullYear() - 12;
  const r = await kid.post('/api/signup', { email: 'kid@example.com', password: PW, name: 'lil_kid', birthday: `${y}-01-01`, rulesOk: true });
  assert.equal(r.status, 403);
  assert.ok(kid.jar.has('os_agegate'));
  const again = await kid.post('/api/signup', { email: 'kid@example.com', password: PW, name: 'lil_kid', birthday: '1990-01-01', rulesOk: true });
  assert.equal(again.status, 403);
  assert.equal((await client().post('/api/signup', { email: 'grownup@example.com', password: PW, name: 'grown_up', birthday: `${y - 2}-01-01`, rulesOk: true })).status, 201);
});

test('log in with email or screen name, log out', async () => {
  const c = await newUser('sess');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).data.user, null);
  assert.equal((await c.post('/api/login', { login: c.email, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/login', { login: c.email.toUpperCase(), password: PW })).status, 200);
  await c.post('/api/logout');
  assert.equal((await c.post('/api/login', { login: c.name, password: PW })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.name, c.name);
});

test('forgot password: an emailed link, single use, logs out other devices', async () => {
  const c = await newUser('forgetful');
  const other = client();
  await other.post('/api/login', { login: c.email, password: PW });
  assert.equal((await c.post('/api/password/forgot', { email: c.email })).status, 200);
  assert.equal((await c.post('/api/password/forgot', { email: 'nobody-at-all@example.com' })).status, 200, 'no account fishing');
  await new Promise(r => setTimeout(r, 500));
  const token = [...serverLog.matchAll(/\/reset#token=([\w-]+)/g)].map(m => m[1]).pop();
  assert.ok(token, 'the reset link was "emailed" (printed by the local dev server)');
  const fresh = client();
  assert.equal((await fresh.post('/api/password/reset', { token, password: 'short' })).status, 400);
  const r = await fresh.post('/api/password/reset', { token, password: 'brand-new-pass-1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, c.name);
  assert.equal((await fresh.post('/api/password/reset', { token, password: 'another-one-2' })).status, 400, 'single use');
  assert.equal((await other.get('/api/me')).data.user, null, 'other devices were logged out');
  assert.equal((await client().post('/api/login', { login: c.email, password: PW })).status, 401);
  assert.equal((await client().post('/api/login', { login: c.email, password: 'brand-new-pass-1' })).status, 200);
});

test('profiles show age and star sign from the birthday (and can hide them)', async () => {
  const c = await newUser('starry', { birthday: '2000-01-01' });
  let page = await client().get('/api/users/' + c.name);
  assert.equal(page.data.sign.name, 'Capricorn');
  assert.ok(page.data.age >= 26);
  assert.equal(JSON.stringify(page.data).includes('2000-01-01'), false, 'the birthday itself is never shown');
  assert.equal((await c.put('/api/me/profile', { showAge: false })).status, 200);
  page = await client().get('/api/users/' + c.name);
  assert.equal(page.data.age, null);
  assert.equal(page.data.sign.name, 'Capricorn');
  await c.put('/api/me/profile', { showSign: false });
  assert.equal((await client().get('/api/users/' + c.name)).data.sign, null);
});

test('editing a profile only accepts values from the lists', async () => {
  const c = await newUser('edit');
  const good = await c.put('/api/me/profile', {
    tag: 'hello world', about: 'i like https://spam.example and grapes', theme: 'midnight',
    bgTile: '/assets/tiles/tile_hearts.png', font: 'Georgia, serif', decor: ['/assets/deco_moon.gif'],
    avatar: '/assets/avatars/preset_05.png', interests: { Music: 'weezer', Bogus: 'x' }, zodiac: 'ignored', age: '99',
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.profile.about, 'i like [link removed] and grapes');
  assert.deepEqual(good.data.profile.theme, { bg: '#0a0a0a', fg: '#e0d5f5', accent: '#c3002f' });
  assert.equal(good.data.profile.interests.Bogus, undefined);
  assert.equal(good.data.profile.age, undefined, 'age comes from the birthday, not a text box');
  for (const bad of [{ theme: 'hotpink' }, { bgTile: 'https://evil.example/x.png' }, { font: 'x; background:url(evil)' },
    { avatar: 'https://evil.example/me.png' }, { decor: ['/assets/a.gif', '/assets/b.gif', '/assets/c.gif', '/assets/d.gif'] }, { top8: ['someone'] }]) {
    assert.equal((await c.put('/api/me/profile', bad)).status, 400, JSON.stringify(bad));
  }
});

const befriend = async (a, b) => { await a.post('/api/follows/' + b.name); await b.post('/api/follows/' + a.name); };

test('following: an open profile takes a follow at once, and two follows make friends', async () => {
  const a = await newUser('alice'); const b = await newUser('bob');
  assert.equal((await b.get('/api/me')).data.counts.requests, 0);
  assert.equal((await b.get('/api/chats')).data.items.length, 0, 'nobody writes to you unless a person does');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE author_id IN (${a.id}, ${b.id})`)[0].n, 0, 'joining posts nothing');
  assert.equal((await a.post('/api/follows/' + a.name)).status, 400);
  let r = await a.post('/api/follows/' + b.name);
  assert.deepEqual(r.data.relation, { following: 'accepted', followsMe: false, friends: false, blockedByMe: false, canComment: false, canMessage: true });
  assert.equal((await b.get('/api/me')).data.counts.requests, 0, 'nothing to approve on an open profile');
  assert.equal((await b.get('/api/users/' + a.name)).data.relation.followsMe, true, '"follows you"');
  r = await b.post('/api/follows/' + a.name);
  assert.equal(r.data.relation.friends, true);
  assert.equal(r.data.relation.canComment, true);
  const page = await client().get('/api/users/' + a.name);
  assert.deepEqual(page.data.counts, { followers: 1, following: 1, friends: 1, statuses: 0, replies: 0, blog: 0, comments: 0 });
  assert.equal(page.data.relation, null, 'logged out');
  assert.equal(page.data.private, false);
  assert.equal(page.data.canSeePosts, true);
  assert.equal((await a.get('/api/users/' + a.name)).data.relation.canComment, true, 'the owner may comment on their own page');
  for (const list of ['followers', 'following', 'friends']) {
    const l = await client().get(`/api/users/${a.name}/${list}`);
    assert.deepEqual(l.data.people.map(p => p.name), [b.name], list);
    assert.equal(l.data.user.name, a.name);
  }
  r = await a.del('/api/follows/' + b.name);
  assert.deepEqual([r.data.relation.following, r.data.relation.followsMe, r.data.relation.friends], ['none', true, false], 'unfollowing ends the friendship');
  r = await a.del('/api/followers/' + b.name);
  assert.equal(r.data.relation.followsMe, false, 'removed a follower');
  assert.deepEqual((await client().get('/api/users/' + a.name)).data.counts, { followers: 0, following: 0, friends: 0, statuses: 0, replies: 0, blog: 0, comments: 0 });
});

test('private profiles: follows become requests, and only followers see the posts', async () => {
  const p = await newUser('private'); const fan = await newUser('fan'); const old = await newUser('oldfan'); const nosy = await newUser('nosy');
  await old.post('/api/follows/' + p.name);                 // while the profile is still open
  await p.post('/api/status', { body: 'for followers only' });
  const diary = await p.post('/api/blog', { title: 'secret diary', body: 'shh' });
  assert.equal((await p.put('/api/me/settings', { followPolicy: 'sometimes' })).status, 400);
  assert.equal((await p.put('/api/me/settings', { followPolicy: 'approve' })).data.settings.followPolicy, 'approve');
  assert.deepEqual((await p.get('/api/me')).data.settings, { followPolicy: 'approve', dmPolicy: 'everyone' });

  let r = await fan.post('/api/follows/' + p.name);
  assert.equal(r.data.relation.following, 'pending');
  assert.equal((await p.get('/api/me')).data.counts.requests, 1);
  assert.deepEqual((await p.get('/api/requests')).data.incoming.map(x => x.user.name), [fan.name]);
  assert.deepEqual((await fan.get('/api/requests')).data.outgoing.map(x => x.user.name), [p.name]);

  // everyone sees the page itself, but only followers (and the owner) see the posts and lists
  for (const viewer of [client(), fan, nosy]) {
    const page = await viewer.get('/api/users/' + p.name);
    assert.equal(page.data.private, true);
    assert.equal(page.data.canSeePosts, false);
    assert.equal(page.data.latestStatus, null);
    assert.deepEqual(page.data.blog, []);
    assert.deepEqual(page.data.counts, { followers: 1, following: 0, friends: 0 }, 'the totals of what you can\'t see are left off');
    for (const sub of ['statuses', 'blog', 'comments', 'followers', 'following', 'friends']) {
      const res = await viewer.get(`/api/users/${p.name}/${sub}`);
      assert.deepEqual([res.status, res.data.error], [403, 'this profile is private.'], sub);
    }
    const hidden = await viewer.get('/api/posts/' + diary.data.id), missing = await viewer.get('/api/posts/99999999');
    assert.deepEqual([hidden.status, hidden.data.error], [404, 'that post is gone.']);
    assert.deepEqual([hidden.status, hidden.data.error], [missing.status, missing.data.error], 'a private post looks exactly like a missing one');
  }
  const oldView = await old.get('/api/users/' + p.name);
  assert.equal(oldView.data.canSeePosts, true, 'followers from before stay');
  assert.equal(oldView.data.latestStatus.body, 'for followers only');
  assert.deepEqual(oldView.data.blog.map(b => b.title), ['secret diary']);
  assert.equal((await old.get(`/api/users/${p.name}/statuses`)).data.items[0].body, 'for followers only');
  assert.equal((await old.get('/api/posts/' + diary.data.id)).data.post.body, 'shh');
  assert.deepEqual(oldView.data.counts, { followers: 1, following: 0, friends: 0, statuses: 1, replies: 0, blog: 1, comments: 0 });
  assert.equal((await old.get(`/api/users/${p.name}/comments`)).data.total, 0);
  assert.equal((await p.get(`/api/users/${p.name}/comments`)).status, 200, 'the owner sees their own');
  assert.equal((await p.get(`/api/users/${p.name}/blog`)).data.entries.length, 1, 'the owner sees their own');
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.author.id === p.id), 'not in the everyone feed');
  assert.ok((await old.get('/api/feed')).data.items.some(i => i.author.id === p.id), 'but in their followers\' feeds');

  assert.equal((await p.post('/api/followers/' + nosy.name)).status, 404, 'nosy never asked');
  assert.equal((await p.post('/api/followers/' + fan.name)).data.relation.followsMe, true, 'accepted');
  assert.equal((await fan.get('/api/users/' + p.name)).data.canSeePosts, true);
  await nosy.post('/api/follows/' + p.name);
  assert.equal((await p.del('/api/followers/' + nosy.name)).data.relation.followsMe, false, 'declined');
  assert.equal((await nosy.get('/api/requests')).data.outgoing.length, 0);
  await nosy.post('/api/follows/' + p.name);
  assert.equal((await nosy.del('/api/follows/' + p.name)).data.relation.following, 'none', 'took my request back');
  await nosy.post('/api/follows/' + p.name);
  await p.put('/api/me/settings', { followPolicy: 'open' });
  assert.equal((await nosy.get('/api/users/' + p.name)).data.relation.following, 'accepted', 'going open lets in whoever was waiting');
});

test('the Top 8 only holds friends', async () => {
  const a = await newUser('top'); const pal = await newUser('pal'); const idol = await newUser('idol');
  await befriend(a, pal);
  await a.post('/api/follows/' + idol.name);                // one-way: not a friend
  assert.deepEqual((await a.put('/api/me/profile', { top8: [idol.id, pal.id] })).data.profile.top8, [pal.id]);
  assert.deepEqual((await client().get('/api/users/' + a.name)).data.top8.map(p => p.name), [pal.name]);
});

test('a private profile\'s Top 8 shows strangers only the friends its owner chose', async () => {
  const p = await newUser('closed'); const x = await newUser('pal'); const y = await newUser('pal'); const z = await newUser('pal');
  const fan = await newUser('fan'); const nosy = await newUser('nosy');
  for (const pal of [x, y, z]) await befriend(p, pal);
  await fan.post('/api/follows/' + p.name);                 // while the profile is still open
  await p.put('/api/me/settings', { followPolicy: 'approve' });
  const names = async viewer => (await viewer.get('/api/users/' + p.name)).data.top8.map(f => f.name);
  for (const viewer of [client(), nosy]) assert.deepEqual(await names(viewer), [], 'no choice made, nothing given away');
  await p.put('/api/me/profile', { top8: [y.id] });
  for (const viewer of [client(), nosy]) assert.deepEqual(await names(viewer), [y.name], 'only the chosen friend');
  for (const viewer of [p, fan]) {
    const all = await names(viewer);
    assert.equal(all[0], y.name, 'the chosen friend first');
    assert.deepEqual(all.sort(), [x.name, y.name, z.name].sort(), 'followers and the owner still get the newest friends after it');
  }
});

test('Friends\' Comments: only friends (and the owner) write, and the owner may delete them', async () => {
  const a = await newUser('pageowner'); const b = await newUser('commenter'); const fan = await newUser('onewayfan');
  await fan.post('/api/follows/' + a.name);
  const no = await fan.post(`/api/users/${a.name}/comments`, { body: 'hi!' });
  assert.deepEqual([no.status, no.data.error], [403, `${a.name} only takes comments from friends.`]);
  assert.equal((await fan.get('/api/users/' + a.name)).data.relation.canComment, false);
  await befriend(a, b);
  const post = await b.post(`/api/users/${a.name}/comments`, { body: 'nice page!!' });
  assert.equal(post.status, 201);
  assert.equal((await a.post(`/api/users/${a.name}/comments`, { body: 'thanks!' })).status, 201, 'the owner replies');
  assert.deepEqual((await client().get(`/api/users/${a.name}/comments`)).data.comments.map(w => w.body), ['thanks!', 'nice page!!'], 'newest first');
  assert.ok(!(await a.get('/api/feed')).data.items.some(i => i.id === post.data.id), 'comments never go to a feed');
  assert.equal((await fan.del('/api/posts/' + post.data.id)).status, 403);
  assert.equal((await a.del('/api/posts/' + post.data.id)).status, 200, 'the owner may delete comments on their page');
  assert.equal((await b.post(`/api/users/${a.name}/wall`, { body: 'the old way' })).status, 404);
});

test('Friends\' Comments come ten to a page, newest first, and the profile counts them', async () => {
  const owner = await newUser('wall_owner'); const mod = await newUser('wall_mod'); const picky = await newUser('wall_picky');
  const pals = [await newUser('wall_a'), await newUser('wall_b'), await newUser('wall_c'), await newUser('wall_d')];
  for (const pal of pals) await befriend(owner, pal);
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${mod.id}`);
  await owner.post('/api/status', { body: 'one' }); await owner.post('/api/status', { body: 'two' });
  await owner.post('/api/blog', { title: 'a post', body: 'words' });
  // four friends write the 23 (each may post 6 a minute); comment i is by pals[i % 4]
  const ids = [];
  for (let i = 1; i <= 23; i++) {
    const r = await pals[i % 4].post(`/api/users/${owner.name}/comments`, { body: `comment ${i}` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ids[i] = r.data.id;
  }
  const said = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => `comment ${from - i}`);
  const bodies = res => res.data.comments.map(w => w.body);
  const list = (who, q = '') => who.get(`/api/users/${owner.name}/comments${q}`);

  let r = await list(client());
  assert.deepEqual([r.status, r.data.total, r.data.page, r.data.pages], [200, 23, 1, 3]);
  assert.deepEqual(bodies(r), said(23, 14), 'page 1 is the newest ten');
  assert.deepEqual(Object.keys(r.data.comments[0]).sort(), ['author', 'body', 'canDelete', 'created', 'id', 'mentions']);
  assert.equal(r.data.comments[0].author.name, pals[3].name);
  r = await list(client(), '?page=2');
  assert.deepEqual([r.data.page, r.data.comments.length], [2, 10]);
  assert.deepEqual(bodies(r), said(13, 4));
  r = await list(client(), '?page=3');
  assert.deepEqual([r.data.total, r.data.page, r.data.pages], [23, 3, 3]);
  assert.deepEqual(bodies(r), said(3, 1), 'the last page holds the three oldest');
  for (const q of ['?page=9', '?page=3.5x']) assert.equal((await list(client(), q)).data.page, 3, `${q}: a page past the end is the last`);
  for (const q of ['?page=0', '?page=-4', '?page=abc']) assert.equal((await list(client(), q)).data.page, 1, `${q}: anything else is the first`);

  // who may delete: the author, the owner, a moderator
  const flags = res => res.data.comments.slice(0, 4).map(w => w.canDelete);
  r = await list(pals[3]);                                     // wrote 23 and 19 (the first and fifth on page 1)
  assert.deepEqual([r.data.comments[0].canDelete, r.data.comments[1].canDelete, r.data.comments[4].canDelete], [true, false, true]);
  assert.deepEqual(flags(await list(client())), [false, false, false, false]);
  assert.deepEqual(flags(await list(owner)), [true, true, true, true]);
  assert.deepEqual(flags(await list(mod)), [true, true, true, true]);

  // the profile's totals are what the lists will show
  assert.deepEqual((await client().get('/api/users/' + owner.name)).data.counts, { followers: 4, following: 4, friends: 4, statuses: 2, replies: 0, blog: 1, comments: 23 });
  sql(`UPDATE posts SET hidden = 1 WHERE id = ${ids[23]}`);
  assert.equal((await list(client())).data.total, 22, 'a hidden comment is not counted or listed');
  assert.equal((await client().get('/api/users/' + owner.name)).data.counts.comments, 22);
  assert.equal((await picky.post('/api/blocks/' + pals[1].name)).status, 200);
  r = await list(picky, '?page=2');
  assert.deepEqual([r.data.total, r.data.pages, r.data.comments.length], [16, 2, 6], 'comments by someone I blocked are not counted or listed');
  assert.equal((await picky.get('/api/users/' + owner.name)).data.counts.comments, 16);
  assert.equal((await owner.del('/api/posts/' + ids[22])).status, 200);
  assert.deepEqual([(await list(client())).data.total, (await client().get('/api/users/' + owner.name)).data.counts.comments], [21, 21], 'a deleted comment is gone from both');
  sql(`UPDATE users SET banned = 1 WHERE id = ${pals[0].id}`);
  assert.equal((await list(client())).data.total, 16, 'a banned author\'s comments (5) are not listed');
  assert.equal((await list(client(), '?page=2')).data.comments.length, 6);
  assert.equal((await list(client(), '?page=9')).data.page, 2);
  assert.equal((await client().get(`/api/users/nobody_here_${uniq()}/comments`)).status, 404);
});

// the DM between two people (opened, or made, by `a`): its id
const dmOf = async (a, b) => {
  const r = await a.post('/api/chats', { dm: b.name });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data));
  return r.data.chat.id;
};

test('DMs: one per pair, unread and read, and "friends only" means both follow each other', async () => {
  const a = await newUser('dm_a'); const b = await newUser('dm_b');
  const opened = await a.post('/api/chats', { dm: b.name });
  assert.equal(opened.status, 201);
  const id = opened.data.chat.id;
  assert.deepEqual([opened.data.chat.kind, opened.data.chat.members.map(m => m.name), opened.data.chat.lastMessage], ['dm', [b.name], null]);
  assert.equal((await b.get('/api/chats')).data.items.length, 0, 'an empty DM shows only to whoever opened it');
  assert.equal((await b.post('/api/chats', { dm: a.name })).data.chat.id, id, 'one DM per pair, whoever opens it');
  assert.equal((await a.post('/api/chats', { dm: a.name })).status, 400);
  const sent = await a.post(`/api/chats/${id}/messages`, { body: 'hey! www.spam.example' });
  assert.equal(sent.status, 201);
  assert.deepEqual([sent.data.message.body, sent.data.message.mine, sent.data.message.chatId], ['hey! [link removed]', true, id]);
  assert.equal((await b.get('/api/me')).data.counts.unread, 1);
  assert.equal((await a.get('/api/me')).data.counts.unread, 0, 'my own message is read');
  const list = (await b.get('/api/chats')).data.items;
  assert.deepEqual([list[0].id, list[0].unread, list[0].lastMessage.body, list[0].lastMessage.author.name], [id, 1, 'hey! [link removed]', a.name]);
  const page = await b.get(`/api/chats/${id}/messages`);
  assert.deepEqual([page.data.messages.at(-1).body, page.data.messages.at(-1).mine, page.data.canMessage, page.data.next], ['hey! [link removed]', false, true, null]);
  assert.equal((await b.get('/api/me')).data.counts.unread, 1, 'reading the page doesn\'t mark it read');
  assert.deepEqual((await b.put(`/api/chats/${id}/read`, { id: sent.data.message.id + 1000 })).data, { ok: true, lastReadId: sent.data.message.id }, 'never past the newest');
  assert.equal((await b.get('/api/me')).data.counts.unread, 0);
  assert.equal((await b.put(`/api/chats/${id}/read`, { id: 0 })).data.lastReadId, sent.data.message.id, 'forward only');
  await b.put('/api/me/settings', { dmPolicy: 'friends' });
  assert.equal((await a.post(`/api/chats/${id}/messages`, { body: 'again' })).status, 403);
  assert.equal((await a.get(`/api/chats/${id}/messages`)).data.canMessage, false);
  await a.post('/api/follows/' + b.name);
  assert.equal((await a.post(`/api/chats/${id}/messages`, { body: 'again' })).status, 403, 'following them isn\'t enough');
  const c = await newUser('dm_c');
  assert.equal((await c.post('/api/chats', { dm: b.name })).status, 403, 'and nobody new may start one');
  await b.post('/api/follows/' + a.name);
  assert.equal((await a.get('/api/users/' + b.name)).data.relation.canMessage, true);
  assert.equal((await a.post(`/api/chats/${id}/messages`, { body: 'again' })).status, 201);
  assert.equal((await c.get(`/api/chats/${id}/messages`)).status, 404, 'outsiders see nothing');
  assert.equal((await c.post(`/api/chats/${id}/messages`, { body: 'me too' })).status, 404);
  assert.equal((await a.post(`/api/chats/${id}/messages`, { body: '   ' })).status, 400);
  assert.equal((await a.post(`/api/chats/${id}/leave`)).status, 400, 'a DM can\'t be left');
});

test('blocking hides both people from each other, ends their follows and stops contact', async () => {
  const a = await newUser('blocked'); const b = await newUser('blocker');
  await befriend(a, b);
  await a.post('/api/status', { body: 'status from the person who gets blocked' });
  assert.equal((await b.post('/api/blocks/' + a.name)).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM follows WHERE ${a.id} IN (follower_id, followee_id) AND ${b.id} IN (follower_id, followee_id)`)[0].n, 0,
    'both follows are gone');
  assert.equal((await a.get('/api/users/' + b.name)).status, 404);
  assert.equal((await a.post('/api/chats', { dm: b.name })).status, 404);
  assert.equal((await a.post(`/api/users/${b.name}/comments`, { body: 'hello?' })).status, 404);
  assert.equal((await a.post('/api/follows/' + b.name)).status, 404);
  assert.equal((await b.post('/api/follows/' + a.name)).status, 403, 'the blocker can\'t follow them either');
  const bView = await b.get('/api/users/' + a.name);
  assert.equal(bView.data.relation.blockedByMe, true);
  assert.deepEqual([bView.data.relation.following, bView.data.relation.followsMe], ['none', false]);
  assert.ok(!(await b.get('/api/feed?scope=everyone')).data.items.some(i => i.author.id === a.id));
  assert.ok((await client().get('/api/feed')).data.items.some(i => i.author.id === a.id));
  await b.del('/api/blocks/' + a.name);
  assert.equal((await a.get('/api/users/' + b.name)).status, 200);
});

test('reports reach moderators, who can hide posts and ban accounts', async () => {
  const victim = await newUser('victim'); const troll = await newUser('troll'); const mod = await newUser('mod');
  await befriend(victim, troll);
  const bad = await troll.post(`/api/users/${victim.name}/comments`, { body: 'a mean comment' });
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'harassment', details: 'again' })).status, 201);
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'nonsense' })).status, 400);
  assert.equal((await mod.get('/api/admin/reports')).status, 403);
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${mod.id}`);
  const rep = (await mod.get('/api/admin/reports')).data.reports.find(r => r.targetId === bad.data.id);
  assert.equal(rep.snapshot.body, 'a mean comment');
  assert.equal((await mod.post('/api/admin/reports/' + rep.id, { action: 'hide_ban', note: 'test' })).status, 200);
  assert.ok(!(await client().get(`/api/users/${victim.name}/comments`)).data.comments.some(w => w.id === bad.data.id));
  assert.equal((await troll.get('/api/me')).data.user, null);
  assert.equal((await troll.post('/api/login', { login: troll.email, password: PW })).status, 403);
  assert.equal((await mod.post('/api/admin/users/' + troll.name, { banned: false })).status, 200);
  assert.equal((await troll.post('/api/login', { login: troll.email, password: PW })).status, 200);
});

test('only someone who can read a message, and didn\'t write it, can report it; the report keeps its words', async () => {
  const a = await newUser('msg_a'); const b = await newUser('msg_b'); const c = await newUser('msg_c');
  const mod = await moderator('msgmod');
  const m = (await a.post(`/api/chats/${await dmOf(a, b)}/messages`, { body: 'buy my mixtape' })).data.message;
  assert.equal((await c.post('/api/reports', { type: 'message', id: m.id, reason: 'spam' })).status, 404, 'not in the DM');
  assert.equal((await a.post('/api/reports', { type: 'message', id: m.id, reason: 'spam' })).status, 404, 'its writer');
  assert.equal((await b.post('/api/reports', { type: 'message', id: m.id, reason: 'spam' })).status, 201);
  assert.equal((await a.del('/api/chat-messages/' + m.id)).status, 200, 'its writer deletes it');
  const rep = (await mod.get('/api/admin/reports')).data.reports.find(r => r.type === 'message' && r.targetId === m.id);
  assert.deepEqual([rep.snapshot.body, rep.snapshot.chatId, rep.targetHidden], ['buy my mixtape', m.chatId, false], 'the snapshot stays');
  assert.equal((await b.get(`/api/chats/${m.chatId}/messages`)).data.messages.length, 0, 'gone from the conversation');
  // a moderator takes one down: kept, shown to nobody
  const m2 = (await a.post(`/api/chats/${m.chatId}/messages`, { body: 'really, buy it' })).data.message;
  await b.post('/api/reports', { type: 'message', id: m2.id, reason: 'spam' });
  const rep2 = (await mod.get('/api/admin/reports')).data.reports.find(r => r.type === 'message' && r.targetId === m2.id);
  assert.equal((await mod.post('/api/admin/reports/' + rep2.id, { action: 'hide' })).status, 200);
  assert.equal(sql(`SELECT hidden, body FROM chat_messages WHERE id = ${m2.id}`)[0].body, 'really, buy it');
  assert.equal((await a.get(`/api/chats/${m.chatId}/messages`)).data.messages.length, 0, 'not even its writer sees it');
  assert.equal((await b.del('/api/chat-messages/' + m2.id)).status, 404);
});

test('cross-site and non-JSON writes are refused', async () => {
  const c = await newUser('csrf');
  assert.equal((await c.post('/api/status', { body: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.post('/api/status', { body: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await c.raw('POST', '/api/status', { body: '{"body":"x"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await c.post('/api/status', { body: 'same-origin is fine' }, { Origin: BASE })).status, 201);
});

test('posting too fast is rate limited', async () => {
  const c = await newUser('spammer');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c.post('/api/status', { body: 'spam ' + i })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 201, 429]);
});

test('statuses hold up to 500 characters, and a profile shows the latest', async () => {
  const c = await newUser('chatty');
  assert.equal((await c.post('/api/status', { body: 'y'.repeat(450) })).data.body.length, 450);
  assert.equal((await c.post('/api/status', { body: 'z'.repeat(600) })).data.body.length, 500);
  assert.equal((await c.post('/api/status', { body: '   ' })).status, 400);
  assert.equal((await client().get('/api/users/' + c.name)).data.latestStatus.body, 'z'.repeat(500));
});

test('blog posts with a subtitle, and a blog post\'s own page', async () => {
  const c = await newUser('writer');
  assert.equal((await c.post('/api/blog', { title: 'day one', mood: 'giddy', body: 'line one\n\n\n\nline two' })).status, 201);
  assert.equal((await client().get(`/api/users/${c.name}/blog`)).data.entries[0].body, 'line one\n\nline two');
  const long = 'word '.repeat(4000).trim();                 // 19,999 characters
  const made = await c.post('/api/blog', { title: 'the long one', subtitle: 'a subtitle, at last', mood: 'wordy', body: long });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const one = (await client().get('/api/posts/' + made.data.id)).data.post;
  assert.deepEqual([one.kind, one.subject, one.subtitle, one.mood, one.body, one.excerpt], ['blog', 'the long one', 'a subtitle, at last', 'wordy', long, false]);
  for (const cut of [(await client().get(`/api/users/${c.name}/blog`)).data.entries[0], (await client().get('/api/feed')).data.items.find(i => i.id === made.data.id)]) {
    assert.equal(cut.excerpt, true);
    assert.ok(cut.body.length <= 401 && long.startsWith(cut.body.slice(0, -1)));
    assert.equal(cut.subtitle, 'a subtitle, at last');
  }
  const latest = (await client().get('/api/users/' + c.name)).data.blog;
  assert.deepEqual(latest.map(b => [b.title, b.subtitle]), [['the long one', 'a subtitle, at last'], ['day one', null]]);
  assert.deepEqual(latest[0], { id: made.data.id, title: 'the long one', subtitle: 'a subtitle, at last', created: one.created });
  assert.equal((await client().get('/api/posts/99999999')).status, 404);
});

test('the feed: people I follow and me, newest first, 30 a page; everyone\'s when logged out', async () => {
  const me = await newUser('reader'); const pal = await newUser('pal'); const stranger = await newUser('stranger');
  await me.post('/api/follows/' + pal.name);
  const t = Date.now() - 3600000;                          // 35 statuses from pal over the past hour
  sql(`INSERT INTO posts (kind, author_id, body, created) VALUES ${Array.from({ length: 35 }, (_, i) => `('status', ${pal.id}, 'pal ${i}', ${t + i * 1000})`).join(', ')}`);
  await stranger.post('/api/status', { body: 'stranger danger' });
  await me.post('/api/status', { body: 'my own status' });
  const p1 = await me.get('/api/feed');
  assert.equal(p1.data.items.length, 30);
  assert.equal(p1.data.items[0].body, 'my own status');
  const p2 = await me.get('/api/feed?before=' + encodeURIComponent(p1.data.next));
  assert.equal(p2.data.next, null);
  assert.deepEqual([...p1.data.items, ...p2.data.items].slice(1).map(i => i.body), Array.from({ length: 35 }, (_, i) => `pal ${34 - i}`),
    'newest first, nothing twice, nobody I don\'t follow (and older posts from before I followed are fine here)');
  assert.ok((await me.get('/api/feed?scope=everyone')).data.items.some(i => i.body === 'stranger danger'));
  assert.ok((await client().get('/api/feed?scope=following')).data.items.some(i => i.body === 'stranger danger'), 'logged out it\'s everyone');
  const s1 = await client().get(`/api/users/${pal.name}/statuses`);
  const s2 = await client().get(`/api/users/${pal.name}/statuses?before=` + encodeURIComponent(s1.data.next));
  assert.deepEqual([s1.data.items.length, s2.data.items.length, s2.data.next], [30, 5, null]);

  // pick up where I left off, from three days back (no marker yet): oldest first, 30 a page, never my own posts
  sql(`UPDATE follows SET accepted = ${t - 1000} WHERE follower_id = ${me.id} AND followee_id = ${pal.id}`);
  const r1 = await me.get('/api/feed?mode=resume');
  assert.deepEqual([r1.data.items.length, r1.data.unseen, r1.data.marker], [30, 35, null]);
  const r2 = await me.get('/api/feed?mode=resume&after=' + encodeURIComponent(r1.data.next));
  assert.equal(r2.data.next, null);
  assert.deepEqual([...r1.data.items, ...r2.data.items].map(i => i.body), Array.from({ length: 35 }, (_, i) => `pal ${i}`));
});

test('pick up where I left off: from my marker, which only moves forward, and only posts since I followed', async () => {
  const me = await newUser('catchup'); const pal = await newUser('oldpal'); const newPal = await newUser('newpal');
  await me.post('/api/follows/' + pal.name); await me.post('/api/follows/' + newPal.name);
  const now = Date.now(), day = 86400000;
  sql(`UPDATE follows SET accepted = ${now - 10 * day} WHERE follower_id = ${me.id} AND followee_id = ${pal.id}`);   // followed long ago
  sql(`INSERT INTO posts (kind, author_id, body, created) VALUES ('status', ${pal.id}, 'too old', ${now - 4 * day}),
    ${[0, 1, 2, 3, 4].map(i => `('status', ${pal.id}, 'p${i}', ${now - day + i * 60000})`).join(', ')},
    ('status', ${newPal.id}, 'before I followed', ${now - 3600000})`);
  await me.post('/api/status', { body: 'mine' });
  let r = await me.get('/api/feed?mode=resume');
  assert.deepEqual(r.data.items.map(i => i.body), ['p0', 'p1', 'p2', 'p3', 'p4'], 'three days back, oldest first: not mine, nothing from before I followed');
  assert.deepEqual([r.data.unseen, r.data.marker, r.data.next], [5, null, null]);
  const latest = (await me.get('/api/feed')).data;
  assert.ok(latest.items.some(i => i.body === 'before I followed') && latest.items.some(i => i.body === 'mine'), 'newest first still has them');
  assert.equal(latest.unseen, 5, 'every feed answer says how many are waiting');

  const [p0, p1, , , p4] = r.data.items;
  assert.deepEqual((await me.put('/api/me/markers/feed', { created: p1.created, id: p1.id })).data.marker, { created: p1.created, id: p1.id });
  r = await me.get('/api/feed?mode=resume');
  assert.deepEqual(r.data.items.map(i => i.body), ['p2', 'p3', 'p4']);
  assert.deepEqual([r.data.unseen, r.data.marker], [3, { created: p1.created, id: p1.id }]);
  assert.deepEqual((await me.put('/api/me/markers/feed', { created: p0.created, id: p0.id })).data.marker, { created: p1.created, id: p1.id }, 'never moves back');
  assert.equal((await me.get('/api/feed?mode=resume')).data.unseen, 3);
  assert.equal((await me.put('/api/me/markers/feed', { created: now + day, id: p4.id })).status, 400, 'not from the future');
  assert.equal((await me.put('/api/me/markers/feed', { id: p4.id })).status, 400);
  assert.equal((await me.put('/api/me/markers/elsewhere', { created: p4.created, id: p4.id })).status, 404);
  assert.equal((await client().put('/api/me/markers/feed', { created: p4.created, id: p4.id })).status, 401);
  await me.put('/api/me/markers/feed', { created: p4.created, id: p4.id });
  r = await me.get('/api/feed?mode=resume');
  assert.deepEqual([r.data.items, r.data.unseen, r.data.next], [[], 0, null], 'all caught up');
  await pal.post('/api/status', { body: 'fresh' });
  r = await me.get('/api/feed?mode=resume');
  assert.deepEqual([r.data.items.map(i => i.body), r.data.unseen], [['fresh'], 1]);
});

/* ------------------- replies, likes, reposts, quotes, bookmarks, @mentions, #tags and notifications */

const kinds = items => items.map(i => i.kind);
const notes = async (who, q = '') => (await who.get('/api/notifications' + q)).data;
const NO_FLAGS = { liked: false, reposted: false, bookmarked: false };

test('replies: a conversation, oldest first, with the posts above it, in nobody\'s feed', async () => {
  const a = await newUser('conv_a'); const b = await newUser('conv_b'); const z = await newUser('conv_z');
  const root = (await a.post('/api/status', { body: 'what should i eat' })).data.id;
  const reply = (who, to, body) => who.post(`/api/posts/${to}/replies`, { body });
  const r1 = await reply(b, root, 'pizza');
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  const p1 = r1.data.post;
  assert.deepEqual([p1.kind, p1.body, p1.rootId, p1.replyTo.id, p1.replyTo.author.name, p1.canDelete], ['reply', 'pizza', root, root, a.name, true]);
  assert.deepEqual([p1.counts, p1.viewer, p1.quoted, p1.deleted, p1.mentions, p1.tags], [{ likes: 0, replies: 0, reposts: 0, quotes: 0 }, NO_FLAGS, null, false, [], []]);
  const p2 = (await reply(a, p1.id, 'pizza AGAIN?')).data.post;                // root ← p1 ← p2, a chain
  const p3 = (await reply(z, p1.id, 'tacos')).data.post;
  const p4 = (await reply(z, root, 'soup')).data.post;
  assert.deepEqual([p2.rootId, p2.replyTo.id, p2.replyTo.author.name], [root, p1.id, b.name], 'a reply to a reply stays in the conversation');

  let conv = (await client().get('/api/posts/' + root)).data;
  assert.deepEqual(Object.keys(conv).sort(), ['ancestors', 'next', 'post', 'replies']);
  assert.deepEqual([conv.post.id, conv.post.rootId, conv.post.replyTo, conv.ancestors, conv.next], [root, null, null, [], null]);
  assert.deepEqual(conv.replies.map(r => r.body), ['pizza', 'pizza AGAIN?', 'tacos', 'soup'], 'everything in the conversation, oldest first');
  assert.equal(conv.post.counts.replies, 2, 'direct replies');
  conv = (await client().get('/api/posts/' + p2.id)).data;
  assert.deepEqual([conv.ancestors.map(r => r.id), conv.replies], [[root, p1.id], []], 'the posts above it, oldest first');
  conv = (await client().get('/api/posts/' + p1.id)).data;
  assert.deepEqual([conv.post.counts.replies, conv.replies.map(r => r.id)], [2, [p2.id, p3.id]], 'and everything under it');

  // replies are never in a feed or on the Posts tab: they have their own tab and total
  assert.ok(!(await a.get('/api/feed')).data.items.some(i => i.kind === 'reply'));
  assert.deepEqual((await client().get(`/api/users/${z.name}/replies`)).data.items.map(r => r.id), [p4.id, p3.id]);
  assert.deepEqual((await client().get(`/api/users/${z.name}/statuses`)).data.items, []);
  assert.equal((await client().get('/api/users/' + z.name)).data.counts.replies, 2);

  assert.equal((await reply(b, root, '   ')).status, 400);
  assert.equal((await reply(b, 99999999, 'hello?')).status, 404);
  assert.equal((await client().post(`/api/posts/${root}/replies`, { body: 'hi' })).status, 401);
  const thread = (await a.post('/api/boards/random/threads', { subject: 'hi', body: 'a thread' })).data.thread.id;
  assert.equal((await reply(b, thread, 'nope')).status, 404, 'board threads take comments, not replies');

  // a reply from a private profile is for its followers
  const shy = await newUser('conv_shy'); const pal = await newUser('conv_pal');
  await pal.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  await reply(shy, p3.id, 'psst');
  for (const [who, want] of [[client(), []], [a, []], [pal, ['psst']], [shy, ['psst']]]) {
    assert.deepEqual((await who.get('/api/posts/' + p3.id)).data.replies.map(r => r.body), want);
  }

  // a long conversation comes 50 replies at a time
  const t = Date.now() - 60000;
  sql(`INSERT INTO posts (kind, author_id, body, reply_to, root_id, created) VALUES ${Array.from({ length: 52 }, (_, i) => `('reply', ${z.id}, 'r${i}', ${p4.id}, ${root}, ${t + i})`).join(', ')};
    UPDATE posts SET reply_count = reply_count + 52 WHERE id = ${p4.id}`);
  const c1 = (await client().get('/api/posts/' + p4.id)).data;
  assert.deepEqual([c1.post.counts.replies, c1.replies.length, c1.replies[0].body, c1.replies[49].body], [52, 50, 'r0', 'r49']);
  const c2 = (await client().get(`/api/posts/${p4.id}?after=${encodeURIComponent(c1.next)}`)).data;
  assert.deepEqual([c2.replies.map(r => r.body), c2.next, c2.post.id], [['r50', 'r51'], null, p4.id]);
  const whole = (await client().get('/api/posts/' + root)).data;
  const rest = (await client().get(`/api/posts/${root}?after=${encodeURIComponent(whole.next)}`)).data;
  assert.deepEqual(rest.replies.map(r => r.body), ['r50', 'r51', 'pizza', 'pizza AGAIN?', 'tacos', 'soup']);
});

test('likes: one per person, counted exactly, only on posts you can see, and taking one back always works', async () => {
  const author = await newUser('likee'); const fan = await newUser('liker'); const fan2 = await newUser('liker');
  await befriend(author, fan);
  const id = (await author.post('/api/status', { body: 'like me' })).data.id;
  const like = (who, method = 'post') => who[method](`/api/posts/${id}/like`);
  assert.deepEqual((await like(fan)).data, { liked: true, likes: 1 });
  assert.deepEqual((await like(fan)).data, { liked: true, likes: 1 }, 'liking twice is liking once');
  assert.deepEqual((await like(fan2)).data, { liked: true, likes: 2 });
  assert.deepEqual((await like(author)).data, { liked: true, likes: 3 }, 'you may like your own');
  const post = (await fan.get('/api/posts/' + id)).data.post;
  assert.deepEqual([post.counts.likes, post.viewer], [3, { liked: true, reposted: false, bookmarked: false }]);
  assert.deepEqual((await client().get('/api/posts/' + id)).data.post.viewer, NO_FLAGS, 'logged out');
  assert.equal((await fan.get('/api/feed')).data.items.find(i => i.id === id).viewer.liked, true, 'the flags are on every list');
  assert.deepEqual((await like(fan, 'del')).data, { liked: false, likes: 2 });
  assert.deepEqual((await like(fan, 'del')).data, { liked: false, likes: 2 }, 'unliking twice changes nothing');
  assert.equal((await client().post(`/api/posts/${id}/like`)).status, 401);
  assert.equal((await fan.post('/api/posts/99999999/like')).status, 404);
  const comment = (await fan.post(`/api/users/${author.name}/comments`, { body: 'hi!' })).data.id;
  assert.equal((await fan.post(`/api/posts/${comment}/like`)).status, 404, 'Friends\' Comments take no likes');
  await author.put('/api/me/settings', { followPolicy: 'approve' });
  assert.equal((await like(await newUser('liker'))).status, 404, 'a private profile\'s posts are for its followers');
  assert.equal((await like(fan)).status, 200, 'who may like them');
  // a like can be taken back by someone who can no longer see the post, but the answer doesn't say how the post is doing
  const gone = await fan2.del('/api/posts/99999999/like');
  assert.deepEqual([(await like(fan2, 'del')).status, (await like(fan2, 'del')).data], [gone.status, gone.data], 'the same as for a post that isn\'t there');
  assert.deepEqual(gone, { status: 200, data: { liked: false } });
  assert.deepEqual((await like(fan, 'del')).data, { liked: false, likes: 1 }, 'fan2\'s like went');
});

test('undoing a like, repost or bookmark of a post you can\'t see answers exactly as for a missing post, and still undoes it', async () => {
  const shy = await newUser('undo_shy'); const fan = await newUser('undo_fan'); const nosy = await newUser('undo_nosy');
  const id = (await shy.post('/api/status', { body: 'for my followers' })).data.id;
  const open = (await shy.post('/api/status', { body: 'for everyone' })).data.id;
  for (const what of ['like', 'repost', 'bookmark']) assert.equal((await fan.post(`/api/posts/${open}/${what}`)).status, 200, what);
  assert.equal((await fan.post(`/api/posts/${id}/like`)).status, 200);
  await nosy.post(`/api/posts/${open}/like`);
  await fan.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });           // fan follows (accepted before); nosy doesn't
  const answers = async (who, post) => Promise.all(['like', 'repost', 'bookmark'].map(async what => {
    const r = await who.del(`/api/posts/${post}/${what}`);
    return [r.status, r.data];
  }));
  const missing = await answers(nosy, 99999999);
  assert.deepEqual(missing, [[200, { liked: false }], [200, { reposted: false }], [200, { bookmarked: false }]]);
  assert.deepEqual(await answers(nosy, id), missing, 'a private post nosy never touched: no counts');
  // fan is removed from shy's followers, then takes everything back: it all goes, and the answers give nothing away
  await shy.del('/api/followers/' + fan.name);
  assert.deepEqual(await answers(fan, open), missing);
  assert.deepEqual(await answers(fan, id), missing);
  const seen = (await shy.get('/api/posts/' + open)).data.post.counts;
  assert.deepEqual([seen.likes, seen.reposts, (await shy.get('/api/posts/' + id)).data.post.counts.likes], [1, 0, 0], 'only nosy\'s like is left');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ${fan.id}`)[0].n, 0);
  const t = (await shy.post('/api/status', { body: 'soon a tombstone' })).data.id;
  await shy.post(`/api/posts/${t}/replies`, { body: 'keeps it' });
  await shy.del('/api/posts/' + t);
  assert.deepEqual(await answers(shy, t), missing, 'a tombstone');
  // a post you can see still says how it's doing; a hidden one doesn't
  await shy.put('/api/me/settings', { followPolicy: 'open' });
  await nosy.post(`/api/posts/${open}/repost`);
  assert.deepEqual(await answers(nosy, open), [[200, { liked: false, likes: 0 }], [200, { reposted: false, reposts: 0 }], [200, { bookmarked: false }]]);
  await nosy.post(`/api/posts/${open}/like`);
  sql(`UPDATE posts SET hidden = 1 WHERE id = ${open}`);
  assert.deepEqual(await answers(nosy, open), missing, 'a hidden post');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM likes WHERE user_id = ${nosy.id}`)[0].n, 0, 'nosy\'s like went anyway');
  sql(`UPDATE posts SET hidden = 0 WHERE id = ${open}`);
});

test('reposts and quotes: one repost each, a repost stands for its original, and private profiles can\'t be shared', async () => {
  const op = await newUser('op'); const fan = await newUser('reposter'); const reader = await newUser('reader');
  await reader.post('/api/follows/' + fan.name);
  const id = (await op.post('/api/status', { body: 'original thought ' + 'x'.repeat(400) })).data.id;
  const repost = (who, which = id, method = 'post') => who[method](`/api/posts/${which}/repost`);
  assert.deepEqual((await repost(fan)).data, { reposted: true, reposts: 1 });
  assert.deepEqual((await repost(fan)).data, { reposted: true, reposts: 1 }, 'one repost per person');

  // a repost is by whoever reposted it, with the whole original inside, and the original's counts and flags
  const rp = (await reader.get('/api/feed')).data.items.find(i => i.kind === 'repost');
  assert.deepEqual([rp.author.name, rp.body, rp.quoted.id, rp.quoted.author.name, rp.quoted.kind], [fan.name, '', id, op.name, 'status']);
  assert.equal(rp.quoted.body.length, 417, 'not cut short');
  assert.deepEqual([rp.counts, rp.quoted.counts], [{ likes: 0, replies: 0, reposts: 1, quotes: 0 }, { likes: 0, replies: 0, reposts: 1, quotes: 0 }]);
  const posts = (await fan.get(`/api/users/${fan.name}/statuses`)).data.items;
  assert.deepEqual([kinds(posts), posts[0].viewer.reposted, posts[0].quoted.viewer.reposted, posts[0].canDelete], [['repost'], true, true, true], 'on the Posts tab');

  // acting on a repost acts on its original
  assert.deepEqual((await repost(reader, rp.id)).data, { reposted: true, reposts: 2 }, 'reposting a repost reposts the original');
  assert.deepEqual((await reader.post(`/api/posts/${rp.id}/like`)).data, { liked: true, likes: 1 });
  assert.equal((await client().get('/api/posts/' + rp.id)).data.post.id, id, 'a repost\'s address opens the original');
  assert.deepEqual((await repost(op)).data, { reposted: true, reposts: 3 }, 'your own posts too');
  assert.deepEqual((await repost(op, id, 'del')).data, { reposted: false, reposts: 2 });
  assert.deepEqual((await repost(op, id, 'del')).data, { reposted: false, reposts: 2 }, 'undoing twice changes nothing');

  // a quote: my words, with the original in brief under them
  const q = await reader.post(`/api/posts/${id}/quote`, { body: 'so true' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  const quote = q.data.post;
  assert.deepEqual(Object.keys(quote.quoted).sort(), ['author', 'body', 'created', 'deleted', 'id', 'kind', 'media', 'subject', 'subtitle']);
  assert.deepEqual([quote.kind, quote.body, quote.quoted.id, quote.quoted.author.name, quote.quoted.body.length], ['quote', 'so true', id, op.name, 281], 'cut at 280 (and a …)');
  assert.equal((await reader.post(`/api/posts/${id}/quote`, { body: ' ' })).status, 400);
  const qq = (await fan.post(`/api/posts/${quote.id}/quote`, { body: 'quoting the quote' })).data.post;
  assert.deepEqual([qq.quoted.kind, qq.quoted.body], ['quote', 'so true']);
  assert.deepEqual((await client().get('/api/posts/' + id)).data.post.counts, { likes: 1, replies: 0, reposts: 2, quotes: 1 });
  assert.deepEqual((await client().get('/api/posts/' + quote.id)).data.post.counts.quotes, 1);

  // the feed has reposts and quotes, and "pick up where I left off" counts them
  const feed = (await reader.get('/api/feed')).data;
  assert.deepEqual(feed.items.map(i => [i.kind, i.author.name]), [['quote', fan.name], ['quote', reader.name], ['repost', reader.name], ['repost', fan.name]]);
  assert.equal(feed.unseen, 2, 'fan\'s repost and quote (my own never count)');
  assert.equal((await client().get('/api/users/' + fan.name)).data.counts.statuses, 2, 'the Posts total counts both');

  // private profiles: their followers may like the posts, but nobody may repost or quote them
  const shy = await newUser('shy');
  await reader.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const hush = (await shy.post('/api/status', { body: 'followers only' })).data.id;
  assert.deepEqual([(await repost(reader, hush)).status, (await reader.post(`/api/posts/${hush}/quote`, { body: 'look' })).status], [403, 403]);
  assert.equal((await repost(shy, hush)).status, 403, 'not even its owner');
  assert.equal((await reader.post(`/api/posts/${hush}/like`)).status, 200);
  assert.equal((await repost(fan, hush)).status, 404, 'and to everyone else it isn\'t there');

  // a profile that goes private after being reposted: reposts of it are left out for whoever can't see it, quotes say
  // it's unavailable
  await op.put('/api/me/settings', { followPolicy: 'approve' });
  assert.deepEqual(kinds((await reader.get('/api/feed')).data.items), ['status', 'quote', 'quote'], 'shy\'s status and the quotes, no reposts');
  assert.deepEqual((await reader.get('/api/posts/' + quote.id)).data.post.quoted, { unavailable: true });
  assert.deepEqual(kinds((await client().get(`/api/users/${fan.name}/statuses`)).data.items), ['quote']);
  assert.equal((await client().get('/api/users/' + fan.name)).data.counts.statuses, 1);
  assert.equal((await op.get('/api/posts/' + quote.id)).data.post.quoted.id, id, 'its owner still sees it');
});

test('deleting: a post with replies or quotes leaves a tombstone, and every count comes down', async () => {
  const a = await newUser('del_a'); const b = await newUser('del_b');
  const tag = 'gone' + uniq();
  const id = (await a.post('/api/status', { body: `hot take #${tag}` })).data.id;
  const reply = (await b.post(`/api/posts/${id}/replies`, { body: 'hmm' })).data.post.id;
  for (const what of ['like', 'bookmark', 'repost']) assert.equal((await b.post(`/api/posts/${id}/${what}`)).status, 200);
  const quote = (await b.post(`/api/posts/${id}/quote`, { body: 'see this' })).data.post.id;
  assert.deepEqual(kinds((await notes(a)).items), ['quote', 'repost', 'like', 'reply']);
  assert.deepEqual((await a.del('/api/posts/' + id)).data, { ok: true, tombstone: true }, 'it says it stayed as a tombstone');

  let conv = (await b.get('/api/posts/' + id)).data;
  assert.deepEqual([conv.post.deleted, conv.post.body, conv.post.canDelete, conv.post.tags, conv.post.viewer], [true, '', false, [], NO_FLAGS]);
  assert.deepEqual(conv.post.counts, { likes: 0, replies: 1, reposts: 0, quotes: 1 }, 'its likes and reposts went; the reply and the quote stay');
  assert.deepEqual(conv.replies.map(r => [r.id, r.replyTo.id]), [[reply, id]], 'the conversation keeps its shape');
  const q = (await b.get('/api/posts/' + quote)).data.post.quoted;
  assert.deepEqual(q, { id, kind: 'status', created: q.created, subject: null, subtitle: null, body: '', author: { id: a.id, name: a.name, avatar: q.author.avatar }, deleted: true, media: [] },
    'a quote says its original was deleted (not just unavailable)');
  assert.deepEqual(kinds((await b.get(`/api/users/${b.name}/statuses`)).data.items), ['quote'], 'the repost went');
  assert.deepEqual((await b.get('/api/me/bookmarks')).data.items, [], 'and the bookmark');
  assert.deepEqual((await client().get('/api/tags/' + tag)).data.items, [], 'and its tags');
  assert.deepEqual(kinds((await notes(a)).items), ['quote', 'reply'], 'and the notifications about it');
  assert.deepEqual((await client().get(`/api/users/${a.name}/statuses`)).data.items, [], 'a tombstone only shows in its conversation');
  assert.equal((await a.del('/api/posts/' + id)).status, 404, 'already gone');
  for (const what of ['like', 'replies', 'repost', 'quote', 'bookmark']) assert.equal((await b.post(`/api/posts/${id}/${what}`, { body: 'hi' })).status, 404, what);

  // deleting the reply brings the tombstone's counts down; once the quote goes too, nothing holds it and it goes as well
  assert.deepEqual((await b.del('/api/posts/' + reply)).data, { ok: true, tombstone: false });
  assert.deepEqual((await client().get('/api/posts/' + id)).data.post.counts, { likes: 0, replies: 0, reposts: 0, quotes: 1 });
  assert.deepEqual((await b.del('/api/posts/' + quote)).data, { ok: true, tombstone: false });
  assert.equal((await client().get('/api/posts/' + id)).status, 404, 'no empty tombstone is left behind');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id = ${id}`)[0].n, 0);
  // a post with nothing under it simply goes, with everything about it
  const oops = (await a.post('/api/status', { body: 'oops' })).data.id;
  await b.post(`/api/posts/${oops}/like`);
  assert.deepEqual((await a.del('/api/posts/' + oops)).data, { ok: true, tombstone: false });
  assert.equal((await client().get('/api/posts/' + oops)).status, 404);
  assert.equal(sql(`SELECT (SELECT COUNT(*) FROM likes WHERE post_id = ${oops}) + (SELECT COUNT(*) FROM notifications WHERE post_id = ${oops}) AS n`)[0].n, 0);
  // a reply in the middle of a chain stays as a tombstone, and the chain holds
  const x = (await a.post('/api/status', { body: 'x' })).data.id;
  const y = (await b.post(`/api/posts/${x}/replies`, { body: 'y' })).data.post.id;
  const z = (await a.post(`/api/posts/${y}/replies`, { body: 'z' })).data.post.id;
  await b.del('/api/posts/' + y);
  conv = (await client().get('/api/posts/' + z)).data;
  assert.deepEqual(conv.ancestors.map(p => [p.id, p.deleted]), [[x, false], [y, true]]);
  assert.equal(conv.ancestors[0].counts.replies, 0, 'a deleted reply no longer counts');
  assert.deepEqual((await client().get('/api/posts/' + x)).data.replies.map(p => [p.id, p.deleted]), [[y, true], [z, false]]);
  await a.del('/api/posts/' + z);
  assert.deepEqual((await client().get('/api/posts/' + x)).data.replies, [], 'the last reply under the tombstone takes it along');
  assert.equal((await client().get('/api/posts/' + y)).status, 404);
});

test('tombstones go once nothing holds them: up a chain of them, through quotes, and when an account goes', async () => {
  const a = await newUser('tomb_a'); const b = await newUser('tomb_b');
  const there = (...ids) => sql(`SELECT id, deleted FROM posts WHERE id IN (${ids.join(', ')}) ORDER BY id`).map(r => [r.id, r.deleted]);
  // root ← r1 ← r2 ← r3: the three above r3 deleted (tombstones), then r3, and every one of them goes
  const r0 = (await a.post('/api/status', { body: 'root' })).data.id;
  const r1 = (await b.post(`/api/posts/${r0}/replies`, { body: 'r1' })).data.post.id;
  const r2 = (await a.post(`/api/posts/${r1}/replies`, { body: 'r2' })).data.post.id;
  const r3 = (await b.post(`/api/posts/${r2}/replies`, { body: 'r3' })).data.post.id;
  const side = (await a.post(`/api/posts/${r0}/replies`, { body: 'another branch' })).data.post.id;
  for (const [who, p] of [[a, r2], [b, r1], [a, r0]]) assert.deepEqual((await who.del('/api/posts/' + p)).data, { ok: true, tombstone: true });
  assert.deepEqual((await b.del('/api/posts/' + r3)).data, { ok: true, tombstone: false });
  assert.deepEqual(there(r0, r1, r2, r3, side), [[r0, 1], [side, 0]], 'r2 and r1 went; the root is still held by the other branch');
  assert.deepEqual((await client().get('/api/posts/' + r0)).data.post.counts.replies, 1);
  await a.del('/api/posts/' + side);
  assert.deepEqual(there(r0, side), [], 'and then the root');

  // a quote holds the post it quotes; a deleted quote with replies holds nothing
  const q0 = (await a.post('/api/status', { body: 'q0' })).data.id;
  const q1 = (await b.post(`/api/posts/${q0}/quote`, { body: 'q1' })).data.post.id;
  const q1r = (await a.post(`/api/posts/${q1}/replies`, { body: 'a reply to the quote' })).data.post.id;
  assert.deepEqual((await a.del('/api/posts/' + q0)).data, { ok: true, tombstone: true }, 'held by the quote');
  assert.deepEqual((await b.del('/api/posts/' + q1)).data, { ok: true, tombstone: true }, 'held by its reply');
  assert.deepEqual(there(q0, q1, q1r), [[q1, 1], [q1r, 0]], 'q0 went: the quote that held it is deleted');

  // an account's replies were all that held someone else's tombstone
  const v = await newUser('tomb_v');
  const t0 = (await a.post('/api/status', { body: 't0' })).data.id;
  const vr = (await v.post(`/api/posts/${t0}/replies`, { body: 'from v' })).data.post.id;
  await a.del('/api/posts/' + t0);
  assert.deepEqual(there(t0, vr), [[t0, 1], [vr, 0]]);
  assert.equal((await v.del('/api/me', { password: PW })).status, 200);
  assert.deepEqual(there(t0, vr), [], 'the tombstone went with the account\'s reply');
});

test('@mentions: resolved when written, ignoring case and punctuation, up to 10, and only people who may see the post hear of it', async () => {
  const me = await newUser('mention'); const kat = await newUser('m_kat'); const mia = await newUser('m_mia');
  const banned = await newUser('m_ban'); const blocker = await newUser('m_blk');
  // more people, straight into the database: one whose name ends in a dot, one with the same name without it, and eleven
  const k = uniq();
  sql(`INSERT INTO users (name, name_key, email, avatar, birthdate, created) VALUES ('Dot${k}.', 'dot${k}.', NULL, '/a.png', '1990-01-01', 1),
      ('dot${k}', 'dot${k}', NULL, '/a.png', '1990-01-01', 1),
      ${Array.from({ length: 11 }, (_, i) => `('ten${k}_${i}', 'ten${k}_${i}', NULL, '/a.png', '1990-01-01', 1)`).join(', ')};
    UPDATE users SET banned = 1 WHERE id = ${banned.id}`);
  await blocker.post('/api/blocks/' + me.name);
  const names = post => post.mentions.map(m => m.name).sort();
  const s = (await me.post('/api/status', { body: `hi @${kat.name.toUpperCase()}, @${mia.name}! @${me.name} @${banned.name} @${blocker.name} @nobody_${k} @dot${k}.. and @dot${k}` })).data.id;
  const post = (await client().get('/api/posts/' + s)).data.post;
  assert.deepEqual(names(post), [`Dot${k}.`, `dot${k}`, kat.name, mia.name].sort(), 'never yourself, the banned, anyone with a block, or nobody');
  assert.deepEqual(Object.keys(post.mentions[0]).sort(), ['id', 'name']);
  const ten = (await me.post('/api/status', { body: Array.from({ length: 11 }, (_, i) => `@ten${k}_${i}`).join(' ') })).data.id;
  assert.deepEqual(names((await client().get('/api/posts/' + ten)).data.post), Array.from({ length: 10 }, (_, i) => `ten${k}_${i}`).sort(), 'the first ten');
  assert.deepEqual((await notes(kat)).items.map(n => [n.kind, n.actor.name, n.post.id, n.post.body.slice(0, 3)]), [['mention', me.name, s, 'hi ']]);
  assert.deepEqual((await notes(blocker)).items, []);

  // a private profile mentioning someone who doesn't follow it tells them nothing
  const shy = await newUser('m_shy');
  await kat.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const hush = (await shy.post('/api/status', { body: `@${kat.name} @${mia.name} secret` })).data.id;
  assert.equal((await notes(kat)).items[0].post.id, hush, 'kat follows shy');
  assert.ok(!(await notes(mia)).items.some(n => n.post && n.post.id === hush), 'mia doesn\'t');
  assert.deepEqual(names((await kat.get('/api/posts/' + hush)).data.post), [kat.name, mia.name].sort(), 'both are still mentioned');

  // Friends' Comments: the page's owner hears about the comment, the person mentioned about the mention
  await befriend(me, kat);
  const wall = (await me.post(`/api/users/${kat.name}/comments`, { body: `@${mia.name} look at this page` })).data.id;
  const m = (await notes(mia)).items[0];
  assert.deepEqual([m.kind, m.post.id, m.post.kind, m.post.page.name], ['mention', wall, 'wall', kat.name]);
  assert.deepEqual((await notes(kat)).items.slice(0, 2).map(n => [n.kind, n.post && n.post.id]), [['comment', wall], ['follow', null]]);
  assert.deepEqual((await client().get(`/api/users/${kat.name}/comments`)).data.comments[0].mentions, [{ id: mia.id, name: mia.name }]);
  // someone told about a reply (or a quote) isn't told again that it mentions them
  const r = (await kat.post(`/api/posts/${s}/replies`, { body: `@${me.name} hi back` })).data.post;
  assert.deepEqual((await notes(me)).items.filter(n => n.post && n.post.id === r.id).map(n => n.kind), ['reply']);
  assert.deepEqual(r.mentions, [{ id: me.id, name: me.name }]);
});

test('#tags: lower case, up to 10, titles count, and a page for each tag', async () => {
  const a = await newUser('tagger'); const b = await newUser('tagger'); const fan = await newUser('tagfan'); const shy = await newUser('tagshy');
  const t = 'glitz' + uniq();
  const s = (await a.post('/api/status', { body: `loving the #${t.toUpperCase()} vibes #y2k` })).data.id;
  const blog = (await a.post('/api/blog', { title: `my #${t} journey`, body: 'and more #Layouts' })).data.id;
  const r = (await b.post(`/api/posts/${s}/replies`, { body: `same #${t}` })).data.post;
  assert.deepEqual(r.tags, [t]);
  assert.deepEqual((await client().get('/api/posts/' + s)).data.post.tags, [t, 'y2k']);
  assert.deepEqual((await client().get('/api/posts/' + blog)).data.post.tags, [t, 'layouts'], 'the title counts');
  const page = (await client().get('/api/tags/' + t)).data;
  assert.deepEqual([page.tag, page.items.map(i => i.id), page.next], [t, [r.id, blog, s], null], 'newest first, replies included');
  assert.equal(page.items[1].excerpt, false);
  assert.equal((await client().get('/api/tags/' + encodeURIComponent('#' + t.toUpperCase()))).data.items.length, 3, 'any case, with or without the #');
  assert.equal((await client().get('/api/tags/123')).status, 404);
  const many = (await b.post('/api/status', { body: Array.from({ length: 12 }, (_, i) => `#many${i}`).join(' ') })).data.id;
  assert.equal((await client().get('/api/posts/' + many)).data.post.tags.length, 10);

  // a private profile's posts are only on the page for its followers
  await fan.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const hush = (await shy.post('/api/status', { body: `#${t} for followers` })).data.id;
  assert.ok(!(await client().get('/api/tags/' + t)).data.items.some(i => i.id === hush));
  assert.equal((await fan.get('/api/tags/' + t)).data.items[0].id, hush);

  // a deleted post leaves the page; it comes 30 at a time
  await b.del('/api/posts/' + r.id);
  assert.deepEqual((await client().get('/api/tags/' + t)).data.items.map(i => i.id), [blog, s]);
  const u = 'paged' + uniq(), at = Date.now() - 60000;
  sql(`INSERT INTO posts (kind, author_id, body, created) VALUES ${Array.from({ length: 32 }, (_, i) => `('status', ${a.id}, '#${u} ${i}', ${at + i})`).join(', ')};
    INSERT INTO post_tags (tag, post_id, created) SELECT '${u}', id, created FROM posts WHERE author_id = ${a.id} AND body LIKE '#${u} %'`);
  const p1 = (await client().get('/api/tags/' + u)).data;
  const p2 = (await client().get(`/api/tags/${u}?before=${encodeURIComponent(p1.next)}`)).data;
  assert.deepEqual([p1.items.length, p2.items.length, p2.next], [30, 2, null]);
  assert.deepEqual([...p1.items, ...p2.items].map(i => i.body), Array.from({ length: 32 }, (_, i) => `#${u} ${31 - i}`));
});

test('bookmarks: private, newest bookmark first, only posts you may still see', async () => {
  const me = await newUser('saver'); const other = await newUser('saved');
  const ids = [];
  for (const body of ['one', 'two', 'three']) ids.push((await other.post('/api/status', { body })).data.id);
  for (const id of [ids[0], ids[2], ids[1], ids[0]]) assert.deepEqual((await me.post(`/api/posts/${id}/bookmark`)).data, { bookmarked: true });
  const saved = (await me.get('/api/me/bookmarks')).data;
  assert.deepEqual([saved.items.map(i => i.body), saved.next], [['two', 'three', 'one'], null], 'newest bookmark first, each once');
  assert.ok(saved.items.every(i => i.viewer.bookmarked));
  assert.deepEqual((await other.get('/api/me/bookmarks')).data.items, [], 'nobody else sees them');
  assert.equal((await other.get('/api/posts/' + ids[0])).data.post.viewer.bookmarked, false);
  assert.deepEqual((await notes(other)).items, [], 'or is told');
  assert.equal((await client().get('/api/me/bookmarks')).status, 401);
  assert.deepEqual((await me.del(`/api/posts/${ids[2]}/bookmark`)).data, { bookmarked: false });
  assert.deepEqual((await me.get('/api/me/bookmarks')).data.items.map(i => i.body), ['two', 'one']);
  await other.post('/api/blocks/' + me.name);
  assert.deepEqual((await me.get('/api/me/bookmarks')).data.items, [], 'a post you may no longer see drops out');
  await other.del('/api/blocks/' + me.name);

  const at = Date.now() - 60000;
  sql(`INSERT INTO posts (kind, author_id, body, created) VALUES ${Array.from({ length: 31 }, (_, i) => `('status', ${other.id}, 'bm ${i}', ${at + i})`).join(', ')};
    INSERT INTO bookmarks (user_id, post_id, created) SELECT ${me.id}, id, created FROM posts WHERE author_id = ${other.id} AND body LIKE 'bm %'`);
  const b1 = (await me.get('/api/me/bookmarks')).data;
  const b2 = (await me.get('/api/me/bookmarks?before=' + encodeURIComponent(b1.next))).data;
  assert.deepEqual([b1.items.length, b2.items.length, b2.next], [30, 3, null]);
  assert.deepEqual([...b1.items, ...b2.items].map(i => i.body), ['two', 'one', ...Array.from({ length: 31 }, (_, i) => `bm ${30 - i}`)]);
});

test('notifications: each kind, never your own doings, nothing about what you can\'t see or across a block, undoing takes them back', async () => {
  const me = await newUser('noted'); const kat = await newUser('n_kat'); const mia = await newUser('n_mia');
  const shy = await newUser('n_shy'); const hidden = await newUser('n_hid');
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  await hidden.put('/api/me/settings', { followPolicy: 'approve' });
  const mine = (await me.post('/api/status', { body: 'notify me' })).data.id;
  await me.post(`/api/posts/${mine}/like`);                                    // my own doings: nothing
  await me.post(`/api/posts/${mine}/replies`, { body: 'talking to myself' });
  await kat.post('/api/follows/' + me.name);                                   // follow
  await me.post('/api/follows/' + shy.name);                                   // follow_request, to shy
  await shy.post('/api/followers/' + me.name);                                 // follow_accepted
  await kat.post(`/api/posts/${mine}/like`);
  const reply = (await kat.post(`/api/posts/${mine}/replies`, { body: 'nice' })).data.post.id;
  await kat.post(`/api/posts/${mine}/repost`);
  const quote = (await kat.post(`/api/posts/${mine}/quote`, { body: `@${me.name} look` })).data.post.id;
  const mention = (await mia.post('/api/status', { body: `hey @${me.name}` })).data.id;
  await befriend(me, mia);
  const comment = (await mia.post(`/api/users/${me.name}/comments`, { body: 'hi friend' })).data.id;
  await hidden.post(`/api/posts/${mine}/replies`, { body: 'you can\'t see this' });   // private, and I don't follow: nothing

  let n = await notes(me);
  assert.deepEqual(n.items.map(x => [x.kind, x.actor.name, x.post && x.post.id]), [
    ['comment', mia.name, comment], ['follow', mia.name, null], ['mention', mia.name, mention], ['quote', kat.name, quote],
    ['repost', kat.name, mine], ['reply', kat.name, reply], ['like', kat.name, mine], ['follow_accepted', shy.name, null], ['follow', kat.name, null]]);
  assert.deepEqual(Object.keys(n.items[0]).sort(), ['actor', 'created', 'id', 'kind', 'post', 'unread']);
  assert.deepEqual(n.items[6].post, { id: mine, kind: 'status', created: n.items[6].post.created, subject: null, subtitle: null, body: 'notify me', author: { id: me.id, name: me.name, avatar: n.items[6].post.author.avatar }, deleted: false });
  assert.deepEqual([n.unread, n.next, n.items.every(x => x.unread)], [9, null, true]);
  assert.equal((await me.get('/api/me')).data.counts.notifications, 9);
  assert.deepEqual((await notes(shy)).items.map(x => [x.kind, x.actor.name]), [['follow_request', me.name]]);
  assert.equal((await client().get('/api/notifications')).status, 401);

  // undoing a like, a repost or a follow takes its notification back
  await kat.del(`/api/posts/${mine}/like`);
  await kat.del(`/api/posts/${mine}/repost`);
  await mia.del('/api/follows/' + me.name);
  n = await notes(me);
  assert.deepEqual(kinds(n.items), ['comment', 'mention', 'quote', 'reply', 'follow_accepted', 'follow']);
  assert.equal(n.unread, 6);

  // reading up to the newest clears the badge; new ones are unread again
  assert.deepEqual((await me.put('/api/me/markers/notifications', { created: n.items[0].created, id: n.items[0].id })).data.marker, { created: n.items[0].created, id: n.items[0].id });
  n = await notes(me);
  assert.deepEqual([n.unread, n.items.some(x => x.unread), (await me.get('/api/me')).data.counts.notifications], [0, false, 0]);
  await kat.post(`/api/posts/${mine}/like`);
  n = await notes(me);
  assert.deepEqual([n.unread, n.items[0].kind, n.items[0].unread, n.items[1].unread], [1, 'like', true, false]);

  // a block hides everything from that person
  await me.post('/api/blocks/' + kat.name);
  n = await notes(me);
  assert.deepEqual([n.items.some(x => x.actor.name === kat.name), n.unread], [false, 0]);

  // the badge stops at 99; 30 a page
  sql(`INSERT INTO notifications (user_id, kind, actor_id, created) SELECT ${mia.id}, 'follow', ${hidden.id}, ${Date.now() - 1000}
    FROM (WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 120) SELECT i FROM k)`);
  const p1 = await notes(mia);
  assert.deepEqual([p1.unread, p1.items.length, (await mia.get('/api/me')).data.counts.notifications], [99, 30, 99]);
  const p2 = await notes(mia, '?before=' + encodeURIComponent(p1.next));
  assert.ok(p2.items.length === 30 && p2.items[0].id < p1.items[29].id);
});

test('a Friends\' Comment that @mentions someone with a block against the page\'s owner tells them nothing', async () => {
  const bob = await newUser('fc_bob'); const carol = await newUser('fc_carol'); const alice = await newUser('fc_alice');
  await befriend(bob, carol);
  const comment = body => carol.post(`/api/users/${bob.name}/comments`, { body: `@${alice.name} ${body}` });
  await bob.post('/api/blocks/' + alice.name);
  assert.equal((await comment('look what bob said about you')).status, 201);
  assert.deepEqual((await notes(alice)).items, [], 'bob blocked alice: nothing about his page reaches her');
  await bob.del('/api/blocks/' + alice.name);
  await alice.post('/api/blocks/' + bob.name);
  await comment('again');
  assert.deepEqual((await notes(alice)).items, [], 'nor when she blocked him');
  await alice.del('/api/blocks/' + bob.name);
  // told before a block: it stops showing once there is one (either way), with the page's owner or the comment's writer
  const hi = (await comment('hi')).data.id;
  assert.deepEqual((await notes(alice)).items.map(n => [n.kind, n.post.id, n.post.page.name]), [['mention', hi, bob.name]]);
  for (const [blocker, blocked] of [[bob, alice], [alice, bob], [alice, carol]]) {
    await blocker.post('/api/blocks/' + blocked.name);
    const n = await notes(alice);
    assert.deepEqual([n.items, n.unread], [[], 0], `${blocker.name} blocked ${blocked.name}`);
    await blocker.del('/api/blocks/' + blocked.name);
  }
  assert.equal((await notes(alice)).items.length, 1, 'and it\'s back once nobody blocks anybody');
});

test('"replying to" names the post answered only for people who may see it', async () => {
  const open = await newUser('rt_open'); const shy = await newUser('rt_shy'); const pal = await newUser('rt_pal'); const nosy = await newUser('rt_nosy');
  await pal.post('/api/follows/' + shy.name);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const root = (await open.post('/api/status', { body: 'public root' })).data.id;
  const hush = (await shy.post(`/api/posts/${root}/replies`, { body: 'my secret opinion' })).data.post.id;
  const ans = (await pal.post(`/api/posts/${hush}/replies`, { body: 'public answer to it' })).data.post;
  assert.deepEqual(ans.replyTo, { id: hush, author: { id: shy.id, name: shy.name, avatar: ans.replyTo.author.avatar } }, 'pal follows shy');
  const inConv = async who => (await who.get('/api/posts/' + root)).data.replies.find(r => r.id === ans.id).replyTo;
  assert.deepEqual(await inConv(nosy), { id: null, author: null }, 'nosy doesn\'t: not even its id');
  assert.deepEqual(await inConv(client()), { id: null, author: null }, 'nor does anyone logged out');
  assert.equal((await inConv(pal)).author.name, shy.name);
  const onTab = async (who, id) => (await who.get(`/api/users/${pal.name}/replies`)).data.items.find(r => r.id === id).replyTo;
  assert.deepEqual(await onTab(nosy, ans.id), { id: null, author: null }, 'on the Replies tab too');
  // a block either way, or a ban, hides it too
  const r2 = (await pal.post(`/api/posts/${root}/replies`, { body: 'to open' })).data.post.id;
  assert.equal((await onTab(nosy, r2)).author.name, open.name);
  for (const [blocker, blocked] of [[open, nosy], [nosy, open]]) {
    await blocker.post('/api/blocks/' + blocked.name);
    assert.deepEqual(await onTab(nosy, r2), { id: null, author: null }, `${blocker.name} blocked ${blocked.name}`);
    await blocker.del('/api/blocks/' + blocked.name);
  }
  sql(`UPDATE users SET banned = 1 WHERE id = ${open.id}`);
  assert.deepEqual(await onTab(client(), r2), { id: null, author: null }, 'a banned writer');
  sql(`UPDATE users SET banned = 0 WHERE id = ${open.id}`);
  assert.equal((await onTab(client(), r2)).id, root);
});

test('a deleted status or blog post that stays as a tombstone isn\'t on the profile, and its page is a tombstone', async () => {
  const me = await newUser('tp_me'); const pal = await newUser('tp_pal');
  const older = (await me.post('/api/status', { body: 'older status' })).data.id;
  const st = (await me.post('/api/status', { body: 'my latest status' })).data.id;
  const b1 = (await me.post('/api/blog', { title: 'first post', body: 'one' })).data.id;
  const b2 = (await me.post('/api/blog', { title: 'second post', body: 'two' })).data.id;
  await pal.post(`/api/posts/${st}/replies`, { body: 'a reply' });
  await pal.post(`/api/posts/${b2}/replies`, { body: 'a blog reply' });
  for (const id of [st, b2]) assert.deepEqual((await me.del('/api/posts/' + id)).data, { ok: true, tombstone: true });
  const prof = (await pal.get('/api/users/' + me.name)).data;
  assert.deepEqual([prof.latestStatus.id, prof.latestStatus.body], [older, 'older status'], 'the latest status that isn\'t deleted');
  assert.deepEqual(prof.blog.map(b => [b.id, b.title]), [[b1, 'first post']]);
  assert.deepEqual([prof.counts.statuses, prof.counts.blog], [1, 1]);
  const page = (await pal.get('/api/posts/' + b2)).data;
  assert.deepEqual([page.post.kind, page.post.deleted, page.post.subject, page.post.body, page.post.canDelete, page.replies.length], ['blog', true, null, '', false, 1]);
});

test('likes, reposts, bookmarks and replies racing a delete land on nothing, and every count stays exact', async () => {
  const others = await Promise.all(Array.from({ length: 6 }, () => newUser('race_o')));
  const authors = [], statuses = {};
  for (let round = 0; round < 4; round++) {
    const author = await newUser('race_a');
    authors.push(author.id);
    const x = (await author.post('/api/status', { body: 'race ' + round })).data.id;
    await others[0].post(`/api/posts/${x}/replies`, { body: 'keep me' });       // so deleting x leaves a tombstone
    const y = (await author.post('/api/status', { body: 'race y ' + round })).data.id;   // and y goes outright (unless a reply wins)
    const all = await Promise.all([author.del('/api/posts/' + x), author.del('/api/posts/' + y),
      ...others.slice(1).flatMap(u => [...['like', 'repost', 'bookmark'].map(w => u.post(`/api/posts/${x}/${w}`)),
        u.post(`/api/posts/${y}/like`), u.post(`/api/posts/${y}/replies`, { body: 'late' })])]);
    for (const r of all) statuses[r.status] = (statuses[r.status] || 0) + 1;
  }
  assert.ok(Object.keys(statuses).every(s => [200, 201, 404].includes(Number(s))), JSON.stringify(statuses));
  assert.deepEqual(sql(`SELECT p.id FROM posts p WHERE p.deleted = 1 AND p.author_id IN (${authors}) AND (p.like_count + p.repost_count > 0
    OR EXISTS (SELECT 1 FROM likes WHERE post_id = p.id) OR EXISTS (SELECT 1 FROM bookmarks WHERE post_id = p.id)
    OR EXISTS (SELECT 1 FROM posts r WHERE r.kind = 'repost' AND r.quote_of = p.id) OR EXISTS (SELECT 1 FROM notifications WHERE post_id = p.id))`), [],
  'nothing landed on a tombstone');
  assert.deepEqual(sql(`SELECT r.id FROM posts r WHERE r.kind = 'reply' AND r.author_id IN (${others.map(o => o.id)})
    AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = r.reply_to)`), [], 'and no reply answers a post that\'s gone');
});

test('replies to a deleted account\'s posts stay in their conversation and say what they answered', async () => {
  const v = await newUser('gone_v'); const o = await newUser('gone_o');
  const root = (await o.post('/api/status', { body: 'root by o' })).data.id;
  const vr = (await v.post(`/api/posts/${root}/replies`, { body: 'reply by v' })).data.post.id;
  const or1 = (await o.post(`/api/posts/${vr}/replies`, { body: 'answer to v' })).data.post.id;
  const vs = (await v.post('/api/status', { body: 'status by v' })).data.id;
  const or2 = (await o.post(`/api/posts/${vs}/replies`, { body: 'answer to v\'s status' })).data.post.id;
  const or3 = (await o.post(`/api/posts/${or2}/replies`, { body: 'and more' })).data.post.id;
  assert.equal((await v.del('/api/me', { password: PW })).status, 200);
  const one = async id => (await o.get('/api/posts/' + id)).data;
  const gone = id => ({ id, author: null });
  assert.deepEqual([(await one(or1)).post.replyTo, (await one(or1)).post.rootId], [gone(vr), root], 'replying to a deleted account, still in the conversation');
  assert.deepEqual((await one(root)).replies.map(r => [r.id, r.replyTo]), [[or1, gone(vr)]], 'which still shows it');
  const d = await one(or3);
  assert.deepEqual([d.post.rootId, d.ancestors.map(a => [a.id, a.replyTo])], [vs, [[or2, gone(vs)]]]);
  assert.deepEqual((await one(or2)).replies.map(r => r.id), [or3]);
  assert.equal((await o.post(`/api/posts/${or3}/replies`, { body: 'still here' })).data.post.rootId, vs, 'a new reply joins the same conversation');
  assert.deepEqual((await client().get(`/api/users/${o.name}/replies`)).data.items.find(r => r.id === or2).replyTo, gone(vs));
});

test('likes, reposts and bookmarks have hourly limits of their own; replies and quotes count as posts', async () => {
  const u = await newUser('ratey'); const op = await newUser('rated');
  const id = (await op.post('/api/status', { body: 'popular' })).data.id;
  const now = Date.now();
  const fill = (key, count) => `INSERT INTO attempts (k, created) SELECT '${key}:${u.id}', ${now}
    FROM (WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${count}) SELECT i FROM k)`;
  sql([fill('like', 299), fill('repost', 59), fill('bookmark', 299)].join(';\n'));
  for (const what of ['like', 'repost', 'bookmark']) {
    assert.equal((await u.post(`/api/posts/${id}/${what}`)).status, 200, what);
    assert.equal((await u.post(`/api/posts/${id}/${what}`)).status, 429, what);
  }
  assert.equal((await u.del(`/api/posts/${id}/like`)).status, 200, 'undoing is free');
  for (let i = 0; i < 5; i++) await u.post('/api/status', { body: 'post ' + i });
  assert.equal((await u.post(`/api/posts/${id}/replies`, { body: 'the sixth' })).status, 201);
  assert.equal((await u.post(`/api/posts/${id}/quote`, { body: 'the seventh' })).status, 429);
});

/* ---------------------------------------------------- boards: threads, nested comments, votes */

async function newThread(who, slug, subject, body = 'what do you all think?') {
  const r = await who.post(`/api/boards/${slug}/threads`, { subject, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.thread;
}
async function newComment(who, thread, body, parent) {
  const r = await who.post(`/api/threads/${thread}/comments`, parent ? { body, parent } : { body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.comment;
}
const vote = (who, id, value) => who.put(`/api/posts/${id}/vote`, { value });
async function moderator(prefix = 'boss') {
  const m = await newUser(prefix);
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${m.id}`);
  return m;
}
// a comment tree as [id, [children]] (or a bare id), with stubs as "+<more>@<parent>:<after>"
const tree = nodes => nodes.map(n => (n.more !== undefined ? `+${n.more}@${n.parent}:${n.after}` : n.children.length ? [n.item.id, tree(n.children)] : n.item.id));
// every comment's thread is there, and so is what it answers (no comment is ever left answering nothing)
const orphans = () => sql(`SELECT c.id, c.root_id, c.reply_to FROM posts c WHERE c.kind = 'comment'
  AND (NOT EXISTS (SELECT 1 FROM posts t WHERE t.id = c.root_id AND t.kind = 'thread') OR NOT EXISTS (SELECT 1 FROM posts r WHERE r.id = c.reply_to))`);
const listed = async (who, slug, q = 'sort=new') => (await who.get(`/api/boards/${slug}?${q}`)).data.items.map(i => i.id);
const BOARDS = ['music', 'movies-tv', 'games', 'art-layouts', 'cooking', 'pets', 'sports', 'tech', 'fashion', 'books-writing', 'astrology', 'school', 'advice', 'random'];

test('boards: the curated index, each with its threads and its last post; the old bulletin routes are gone', async () => {
  const index = async who => (await who.get('/api/boards')).data.boards;
  const before = await index(client());
  assert.deepEqual(before.slice(0, 14).map(b => b.slug), BOARDS);
  const cooking = before.find(b => b.slug === 'cooking');
  assert.deepEqual(Object.keys(cooking).sort(), ['description', 'icon', 'lastPost', 'name', 'slug', 'threads']);
  assert.deepEqual([cooking.name, cooking.icon], ['Cooking', '🍳']);
  const a = await newUser('chef'); const b = await newUser('chef');
  const t = await newThread(a, 'cooking', 'best grilled cheese?');
  let now = (await index(client())).find(x => x.slug === 'cooking');
  assert.deepEqual([now.threads, now.lastPost], [cooking.threads + 1, { created: t.created, author: t.author, thread: { id: t.id, subject: 'best grilled cheese?' } }]);
  const c1 = await newComment(b, t.id, 'butter on the outside');
  now = (await index(client())).find(x => x.slug === 'cooking');
  assert.deepEqual([now.threads, now.lastPost], [cooking.threads + 1, { created: c1.created, author: c1.author, thread: { id: t.id, subject: 'best grilled cheese?' } }],
    'a comment is the last post too, with its thread');
  await a.post('/api/blocks/' + b.name);
  assert.equal((await index(a)).find(x => x.slug === 'cooking').lastPost.author.name, a.name, 'not across a block');
  await a.del('/api/blocks/' + b.name);
  for (const method of ['get', 'post']) assert.equal((await a[method]('/api/bulletins')).status, 404);
  assert.equal((await client().get('/api/boards/nope')).status, 404);
});

test('threads: a title and up to 10,000 characters, with @mentions and #tags, on a board and never in the feed', async () => {
  const a = await newUser('op'); const pal = await newUser('op_pal');
  await pal.post('/api/follows/' + a.name);
  const tag = 'soup' + uniq();
  const t = await newThread(a, 'cooking', 'T'.repeat(130), `ask @${pal.name} about #${tag}`);
  assert.deepEqual([t.kind, t.subject.length, t.board, t.counts, t.viewer, t.sticky, t.locked, t.mentions.map(m => m.name), t.tags, t.deleted, t.canDelete, t.replyTo, t.rootId],
    ['thread', 120, { slug: 'cooking', name: 'Cooking', icon: '🍳', archived: false }, { up: 0, down: 0, comments: 0 }, { vote: 0 }, false, false, [pal.name], [tag], false, true, null, null]);
  assert.equal((await a.post('/api/boards/cooking/threads', { subject: '', body: 'words' })).status, 400);
  assert.equal((await a.post('/api/boards/cooking/threads', { subject: 'title', body: '   ' })).status, 400);
  assert.equal((await a.post('/api/boards/nope/threads', { subject: 'title', body: 'words' })).status, 404);
  assert.equal((await client().post('/api/boards/cooking/threads', { subject: 'title', body: 'words' })).status, 401);
  assert.equal((await newThread(a, 'cooking', 'the long one', 'w'.repeat(10050))).body.length, 10000);
  await newThread(a, 'cooking', 'the third this hour');
  assert.equal((await a.post('/api/boards/cooking/threads', { subject: 'a fourth', body: 'words' })).status, 429, '3 an hour');

  const page = (await client().get('/api/threads/' + t.id)).data;
  assert.deepEqual(Object.keys(page).sort(), ['comments', 'sort', 'thread']);
  assert.deepEqual([page.thread.id, page.thread.body, page.thread.viewer, page.sort, page.comments], [t.id, t.body, { vote: 0 }, 'best', []]);
  const row = (await client().get('/api/boards/cooking?sort=new')).data.items.find(i => i.id === t.id);
  assert.deepEqual(row, { id: t.id, subject: t.subject, excerpt: t.body, author: t.author, created: t.created, sticky: false, locked: false,
    counts: { up: 0, down: 0, comments: 0 }, lastComment: null, viewer: { vote: 0 }, media: [] });
  assert.ok((await client().get('/api/boards/cooking?sort=new')).data.items.find(i => i.body === undefined && i.excerpt.length === 201), 'a long one is cut at 200 characters');

  assert.ok(!(await pal.get('/api/feed')).data.items.some(i => i.kind === 'thread'), 'not in the following feed');
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.kind === 'thread'));
  assert.deepEqual((await client().get(`/api/users/${a.name}/statuses`)).data.items, []);
  assert.deepEqual((await client().get('/api/tags/' + tag)).data.items.map(i => [i.id, i.kind, i.board.slug]), [[t.id, 'thread', 'cooking']], 'its #tags have pages');
  for (const what of ['like', 'repost', 'bookmark', 'replies', 'quote']) assert.equal((await pal.post(`/api/posts/${t.id}/${what}`, { body: 'hi' })).status, 404, what);
  assert.equal((await client().get('/api/posts/' + t.id)).status, 404, 'a thread opens at /api/threads/:id');
  assert.equal((await client().get('/api/threads/99999999')).status, 404);
  const told = (await notes(pal)).items.find(n => n.kind === 'mention' && n.post.id === t.id);
  assert.deepEqual([told.post.kind, told.post.board, told.post.threadId], ['thread', { slug: 'cooking', name: 'Cooking' }, t.id]);
});

test('board sorts: hot, new, top and best, from fixed fixtures; sticky threads first; 25 a page', async () => {
  const u = await newUser('sorter');
  const slug = 'sorts-' + uniq();
  sql(`INSERT INTO boards (slug, name, description, icon, position, created) VALUES ('${slug}', 'Sorts', 'for the tests', '🧪', 1000, ${Date.now()})`);
  const board = sql(`SELECT id FROM boards WHERE slug = '${slug}'`)[0].id;
  const now = Date.now(), h = 3600000;
  const fixtures = { t1: [10, 0, 72 * h], t2: [2, 0, h], t3: [30, 25, 48 * h], t4: [0, 3, h / 6], t5: [6, 1, 120 * h] };   // [up, down, age]; t5 is sticky
  const id = {};
  for (const [name, [up, down, age]] of Object.entries(fixtures)) {
    const created = now - age;
    id[name] = sql(`INSERT INTO posts (kind, author_id, board_id, subject, body, created, up_count, down_count, hot, best, score, sticky)
      VALUES ('thread', ${u.id}, ${board}, '${name}', 'a fixture', ${created}, ${up}, ${down}, ${hot(up, down, 0, created)}, ${wilson(up, down)}, ${up - down},
      ${name === 't5' ? 1 : 0}) RETURNING id`)[0].id;
  }
  const order = names => names.map(n => id[n]);
  const got = await client().get(`/api/boards/${slug}`);
  assert.deepEqual([got.data.board, got.data.sort, got.data.next], [{ slug, name: 'Sorts', description: 'for the tests', icon: '🧪', archived: false }, 'hot', null]);
  assert.deepEqual(got.data.items.map(i => i.id), order(['t5', 't2', 't3', 't1', 't4']), 'hot (the default): votes against age');
  assert.deepEqual(await listed(client(), slug, 'sort=new'), order(['t5', 't4', 't2', 't3', 't1']), 'new');
  assert.deepEqual(await listed(client(), slug, 'sort=top'), order(['t5', 't1', 't3', 't2', 't4']), 'top: net votes');
  assert.deepEqual(await listed(client(), slug, 'sort=best'), order(['t5', 't1', 't2', 't3', 't4']), 'best: the Wilson bound');
  assert.deepEqual(await listed(client(), slug, 'sort=bogus'), order(['t5', 't2', 't3', 't1', 't4']));
  assert.deepEqual(got.data.items.map(i => i.sticky), [true, false, false, false, false]);
  assert.deepEqual(got.data.items[3].counts, { up: 10, down: 0, comments: 0 });

  // 30 more, older and with no votes: pages of 25, the sticky one only on the first
  sql(`INSERT INTO posts (kind, author_id, board_id, subject, body, created, hot)
    SELECT 'thread', ${u.id}, ${board}, 'old ' || i, 'a fixture', ${now - 200 * h} - i * 1000, ((${now - 200 * h} - i * 1000) / 1000.0 - 1767225600) / 172800.0
    FROM (WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 30) SELECT i FROM k)`);
  for (const sort of ['new', 'hot', 'top', 'best']) {
    const p1 = (await client().get(`/api/boards/${slug}?sort=${sort}`)).data;
    const p2 = (await client().get(`/api/boards/${slug}?sort=${sort}&before=${encodeURIComponent(p1.next)}`)).data;
    assert.deepEqual([p1.items.length, p1.items[0].id, p2.items.length, p2.next], [26, id.t5, 9, null], sort);
    const all = [...p1.items, ...p2.items].map(i => i.id);
    assert.equal(new Set(all).size, 35, `${sort}: every thread once`);
    if (sort === 'new') assert.deepEqual(p2.items.map(i => i.subject), Array.from({ length: 9 }, (_, i) => 'old ' + (i + 22)));
  }
  sql(`DELETE FROM posts WHERE board_id = ${board}; DELETE FROM boards WHERE id = ${board}`);
});

test('votes: like or dislike, switch or take back, counted exactly with the sort keys; never your own, never when locked or gone', async () => {
  const a = await newUser('voted'); const b = await newUser('voter'); const c = await newUser('voter'); const mod = await moderator();
  const t = await newThread(a, 'games', 'best console?');
  const cm = await newComment(b, t.id, 'the one with the most games');
  assert.deepEqual((await vote(b, t.id, 1)).data, { vote: 1, up: 1, down: 0 });
  assert.deepEqual((await vote(b, t.id, 1)).data, { vote: 1, up: 1, down: 0 }, 'voting twice is voting once');
  assert.deepEqual((await vote(b, t.id, -1)).data, { vote: -1, up: 0, down: 1 }, 'switching moves both counts');
  assert.deepEqual((await vote(c, t.id, -1)).data, { vote: -1, up: 0, down: 2 });
  assert.deepEqual((await vote(b, t.id, 0)).data, { vote: 0, up: 0, down: 1 }, 'taking it back');
  assert.deepEqual((await vote(b, t.id, 0)).data, { vote: 0, up: 0, down: 1 });
  assert.deepEqual((await vote(a, cm.id, 1)).data, { vote: 1, up: 1, down: 0 }, 'comments take votes too');
  const [k] = sql(`SELECT up_count, down_count, hot, best, score FROM posts WHERE id = ${t.id}`);
  assert.deepEqual([k.up_count, k.down_count, k.score], [0, 1, -1]);
  assert.ok(Math.abs(k.hot - hot(0, 1, 1, t.created)) < 1e-9 && Math.abs(k.best - wilson(0, 1)) < 1e-12, 'the stored keys follow (b\'s comment counts toward hot)');
  const [kc] = sql(`SELECT best, score FROM posts WHERE id = ${cm.id}`);
  assert.ok(Math.abs(kc.best - wilson(1, 0)) < 1e-12 && kc.score === 1);
  const page = (await c.get('/api/threads/' + t.id)).data;
  assert.deepEqual([page.thread.viewer, page.thread.counts, page.comments[0].item.counts, page.comments[0].item.viewer],
    [{ vote: -1 }, { up: 0, down: 1, comments: 1 }, { up: 1, down: 0, comments: 0 }, { vote: 0 }]);
  assert.equal((await c.get('/api/boards/games?sort=new')).data.items.find(i => i.id === t.id).viewer.vote, -1);
  assert.equal((await a.get('/api/threads/' + t.id)).data.comments[0].item.viewer.vote, 1);

  assert.equal((await vote(a, t.id, 1)).status, 400, 'not on your own post');
  assert.equal((await vote(b, t.id, 2)).status, 400);
  assert.equal((await vote(b, t.id, '1')).status, 400);
  assert.equal((await client().put(`/api/posts/${t.id}/vote`, { value: 1 })).status, 401);
  const status = (await a.post('/api/status', { body: 'no votes here' })).data.id;
  assert.equal((await vote(b, status, 1)).status, 404, 'only threads and comments take votes');
  assert.equal((await vote(b, 99999999, 1)).status, 404);

  assert.equal((await b.post('/api/admin/threads/' + t.id, { locked: true })).status, 403);
  assert.deepEqual((await mod.post('/api/admin/threads/' + t.id, { locked: true })).data, { thread: { id: t.id, sticky: false, locked: true } });
  assert.equal((await client().get('/api/threads/' + t.id)).data.thread.locked, true);
  assert.equal((await vote(c, t.id, 1)).status, 403, 'a locked thread takes no votes');
  assert.equal((await vote(c, cm.id, 1)).status, 403, 'on its comments either');
  assert.equal((await b.post(`/api/threads/${t.id}/comments`, { body: 'hello?' })).status, 403, 'and no comments');
  assert.equal((await mod.post(`/api/threads/${t.id}/comments`, { body: 'locked, folks' })).status, 403, 'from anyone');
  assert.equal((await b.del('/api/posts/' + cm.id)).status, 200, 'but deleting still works');
  await mod.post('/api/admin/threads/' + t.id, { locked: false });
  assert.equal((await vote(c, cm.id, 1)).status, 404, 'gone');
  await mod.post('/api/admin/content', { type: 'post', id: t.id, hidden: true });
  assert.equal((await vote(c, t.id, 1)).status, 404, 'hidden');
  await mod.post('/api/admin/content', { type: 'post', id: t.id, hidden: false });
  assert.ok((await notes(a)).items.every(n => n.kind === 'reply'), 'votes tell nobody');
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'lock' && l.targetId === t.id));

  sql(`INSERT INTO attempts (k, created) SELECT 'vote:${c.id}', ${Date.now()} FROM (WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 298) SELECT i FROM k)`);
  assert.equal((await vote(c, t.id, 1)).status, 200);
  assert.equal((await vote(c, t.id, -1)).status, 429, '300 an hour');
  assert.deepEqual((await vote(c, t.id, 0)).data, { vote: 0, up: 0, down: 0 }, 'taking one back is free');
});

test('comments: nested replies sorted best, new or old, tombstones, and a big tree cut into pages', async () => {
  const a = await newUser('tree_a'); const b = await newUser('tree_b'); const c = await newUser('tree_c'); const d = await newUser('tree_d');
  const t = await newThread(a, 'advice', 'how do i ask my crush to the dance');
  const c1 = await newComment(b, t.id, 'just ask!!');
  const c2 = await newComment(c, t.id, 'write a note');
  const r1 = await newComment(a, t.id, 'but HOW', c1.id);
  const r2 = await newComment(c, t.id, 'with words', r1.id);
  assert.deepEqual([c1.kind, c1.replyTo.id, c1.replyTo.author.name, c1.rootId, c1.board.slug, c1.counts, c1.viewer, c1.tags, c1.sticky],
    ['comment', t.id, a.name, t.id, 'advice', { up: 0, down: 0, comments: 0 }, { vote: 0 }, [], undefined]);
  assert.deepEqual([r1.replyTo.id, r1.replyTo.author.name, r2.rootId], [c1.id, b.name, t.id]);
  const get = async (q = '') => (await client().get(`/api/threads/${t.id}${q}`)).data;
  assert.deepEqual(tree((await get('?sort=old')).comments), [[c1.id, [[r1.id, [r2.id]]]], c2.id], 'old');
  assert.deepEqual(tree((await get('?sort=new')).comments), [c2.id, [c1.id, [[r1.id, [r2.id]]]]], 'new');
  assert.deepEqual(tree((await get()).comments), [[c1.id, [[r1.id, [r2.id]]]], c2.id], 'best, with no votes: older first');
  await vote(a, c2.id, 1); await vote(d, c2.id, 1); await vote(d, c1.id, -1);
  const best = await get();
  assert.deepEqual([best.sort, tree(best.comments)], ['best', [c2.id, [c1.id, [[r1.id, [r2.id]]]]]], 'best: 2 likes above a dislike');
  assert.deepEqual([best.thread.counts.comments, best.comments[1].item.counts], [4, { up: 0, down: 1, comments: 1 }]);
  const row = (await client().get('/api/boards/advice?sort=new')).data.items.find(i => i.id === t.id);
  assert.deepEqual([row.counts.comments, row.lastComment], [4, { created: r2.created, author: r2.author }]);
  assert.equal((await b.post(`/api/threads/${t.id}/comments`, { body: ' ' })).status, 400);
  assert.equal((await client().post(`/api/threads/${t.id}/comments`, { body: 'hi' })).status, 401);
  const other = await newThread(d, 'advice', 'another question');
  assert.equal((await b.post(`/api/threads/${other.id}/comments`, { body: 'hm', parent: c1.id })).status, 404, 'a parent from another thread');
  assert.equal((await b.post(`/api/threads/${t.id}/comments`, { body: 'hm', parent: other.id })).status, 404);
  assert.equal((await b.post(`/api/threads/${t.id}/comments`, { body: 'x'.repeat(10050) })).data.comment.body.length, 10000);

  // a deleted comment with replies stays as a tombstone, until nothing holds it
  assert.deepEqual((await b.del('/api/posts/' + c1.id)).data, { ok: true, tombstone: true });
  let page = await get('?sort=old');
  const tomb = page.comments[0].item;
  assert.deepEqual([tomb.id, tomb.deleted, tomb.body, tomb.counts, tomb.viewer, tomb.canDelete], [c1.id, true, '', { up: 0, down: 0, comments: 1 }, { vote: 0 }, false]);
  assert.equal(page.thread.counts.comments, 4, 'a tombstone isn\'t counted');
  assert.equal((await d.post(`/api/threads/${t.id}/comments`, { body: 'hm', parent: c1.id })).status, 404, 'no replying to it');
  assert.equal((await vote(d, c1.id, 1)).status, 404, 'or voting on it');
  await c.del('/api/posts/' + r2.id);
  await a.del('/api/posts/' + r1.id);
  page = await get('?sort=old');
  assert.equal(tree(page.comments)[0], c2.id, 'the tombstone went once nothing held it');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id = ${c1.id}`)[0].n, 0);

  // a deep, wide thread: c2 ← k1 ← k2 ← … ← k9, and 12 more replies to k1
  const board = sql(`SELECT board_id FROM posts WHERE id = ${t.id}`)[0].board_id;
  const at = Date.now() - 600000;
  const add = (body, parent, i) => `INSERT INTO posts (kind, author_id, board_id, body, reply_to, root_id, created) VALUES ('comment', ${d.id}, ${board}, '${body}', ${parent}, ${t.id}, ${at + i})`;
  sql([...Array.from({ length: 9 }, (_, i) => add('k' + (i + 1), i ? `(SELECT MAX(id) FROM posts WHERE root_id = ${t.id} AND author_id = ${d.id})` : c2.id, i)),
    ...Array.from({ length: 12 }, (_, i) => add('s' + (i + 1), `(SELECT id FROM posts WHERE root_id = ${t.id} AND body = 'k1')`, 100 + i)),
    `UPDATE posts SET reply_count = (SELECT COUNT(*) FROM posts x WHERE x.reply_to = posts.id AND x.deleted = 0),
      comment_count = (SELECT COUNT(*) FROM posts x WHERE x.root_id = posts.id AND x.deleted = 0) WHERE id = ${t.id} OR root_id = ${t.id}`,
    `UPDATE posts SET ${RESORT} WHERE id = ${t.id}`].join(';\n'));
  const ids = Object.fromEntries(sql(`SELECT body, id FROM posts WHERE root_id = ${t.id} AND author_id = ${d.id}`).map(r => [r.body, r.id]));
  page = await get('?sort=old');
  const k1 = page.comments[0].children[0];
  assert.equal(k1.item.id, ids.k1);
  assert.deepEqual(k1.children.map(n => n.item ? n.item.id : n), [ids.k2, ...Array.from({ length: 9 }, (_, i) => ids['s' + (i + 1)]), { more: 3, parent: ids.k1, after: `${at + 108}:${ids.s9}` }],
    '10 replies to a comment, then a stub that goes on after the 10th (s9: created, id)');
  let n = k1;
  for (let depth = 2; depth <= 7; depth++) n = n.children[0];
  assert.deepEqual([n.item.id, n.children], [ids.k7, [{ more: 2, parent: ids.k7, after: null }]], 'eight levels, then a stub');
  const deeper = (await client().get(`/api/threads/${t.id}/comments/${ids.k7}?sort=old`)).data;
  assert.deepEqual([deeper.parent.id, deeper.sort, tree(deeper.comments)], [ids.k7, 'old', [[ids.k8, [ids.k9]]]]);
  const wider = (await client().get(`/api/threads/${t.id}/comments/${ids.k1}?sort=old&after=${encodeURIComponent(k1.children.at(-1).after)}`)).data;
  assert.deepEqual(tree(wider.comments), [ids.s10, ids.s11, ids.s12]);
  assert.deepEqual(tree((await client().get(`/api/threads/${t.id}/comments/${ids.k1}?sort=old&after=nonsense`)).data.comments).slice(0, 2).map(x => (Array.isArray(x) ? x[0] : x)),
    [ids.k2, ids.s1], 'a cursor that isn\'t one starts from the first');
  const top = (await client().get(`/api/threads/${t.id}/comments/${t.id}?sort=new`)).data;
  assert.deepEqual([top.parent, top.comments.map(x => x.item.id)], [null, tree(page.comments).map(x => (Array.isArray(x) ? x[0] : x)).reverse()]);
  assert.equal((await client().get(`/api/threads/${t.id}/comments/${c1.id}`)).status, 404);
  assert.equal((await client().get(`/api/threads/${other.id}/comments/${ids.k1}`)).status, 404, 'a comment from another thread');
});

test('board notifications: replies to your thread or comment and @mentions, by phase 2\'s rules', async () => {
  const a = await newUser('bn_a'); const b = await newUser('bn_b'); const c = await newUser('bn_c'); const shy = await newUser('bn_shy');
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const t = await newThread(a, 'music', 'what are you listening to');
  const cb = await newComment(b, t.id, 'paramore on repeat');
  const ra = await newComment(a, t.id, 'same', cb.id);
  const rc = await newComment(c, t.id, `@${b.name} riot! is better`, cb.id);
  const toA = (await notes(a)).items;
  assert.deepEqual(toA.map(x => [x.kind, x.actor.name, x.post.id, x.post.kind, x.post.board, x.post.threadId]),
    [['reply', b.name, cb.id, 'comment', { slug: 'music', name: 'Music' }, t.id]], 'a reply to my thread (my own reply tells nobody)');
  assert.deepEqual((await notes(b)).items.map(x => [x.kind, x.actor.name, x.post.id]), [['reply', c.name, rc.id], ['reply', a.name, ra.id]],
    'replies to my comment, and a mention in one isn\'t told twice');
  const st = await newThread(shy, 'music', `@${c.name} you would like this`);
  assert.ok((await notes(c)).items.some(x => x.kind === 'mention' && x.post.id === st.id), 'boards are public: a private member\'s mention reaches anyone');
  await b.post('/api/blocks/' + c.name);
  assert.ok(!(await notes(b)).items.some(x => x.actor.id === c.id), 'a block hides what came before it');
  assert.equal((await c.post(`/api/threads/${t.id}/comments`, { body: 'hello?', parent: cb.id })).status, 404, 'they can\'t see each other\'s comments');
  const late = await newComment(c, t.id, `@${b.name} hello?`);
  assert.ok(!(await notes(b)).items.some(x => x.actor.id === c.id), 'and a mention tells nothing new');
  await b.del('/api/blocks/' + c.name);
  await b.del('/api/posts/' + cb.id);
  assert.deepEqual((await notes(a)).items.map(x => x.post.id), [late.id], 'deleting a comment takes back what was told about it');
});

test('boards are public spaces: a private member\'s threads and comments show to everyone; blocks, bans and hiding still hide them', async () => {
  const shy = await newUser('pub_shy'); const x = await newUser('pub_x'); const y = await newUser('pub_y'); const mod = await moderator();
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const t = await newThread(shy, 'fashion', 'thrift haul');
  const yc = await newComment(y, t.id, 'show us!');
  const sc = await newComment(shy, t.id, 'ok ok', yc.id);
  const yr = await newComment(y, t.id, 'love it', sc.id);
  const anon = client();
  assert.ok((await listed(anon, 'fashion')).includes(t.id));
  const page = (await anon.get('/api/threads/' + t.id)).data;
  assert.deepEqual([page.thread.author.name, tree(page.comments)], [shy.name, [[yc.id, [[sc.id, [yr.id]]]]]]);
  assert.equal(page.comments[0].children[0].children[0].item.replyTo.author.name, shy.name, '"replying to" names them too');
  assert.equal((await anon.get(`/api/users/${shy.name}/statuses`)).status, 403, 'while their page stays private');

  const yt = await newThread(y, 'fashion', 'jeans');
  const s2 = await newComment(shy, yt.id, 'flares');
  const y2 = await newComment(y, yt.id, 'agreed', s2.id);
  const y3 = await newComment(y, yt.id, 'skinny');
  await x.post('/api/blocks/' + shy.name);
  assert.ok(!(await listed(x, 'fashion')).includes(t.id), 'a block hides their threads');
  assert.equal((await x.get('/api/threads/' + t.id)).status, 404);
  assert.deepEqual(tree((await x.get('/api/threads/' + yt.id)).data.comments), [y3.id], 'and their comments, with the replies under them');
  assert.deepEqual(tree((await anon.get('/api/threads/' + yt.id)).data.comments), [[s2.id, [y2.id]], y3.id]);
  assert.equal((await x.post(`/api/threads/${yt.id}/comments`, { body: 'hm', parent: s2.id })).status, 404);
  assert.equal((await vote(x, s2.id, 1)).status, 404);
  assert.equal((await x.post(`/api/threads/${t.id}/comments`, { body: 'hm' })).status, 404);

  await mod.post('/api/admin/users/' + shy.name, { banned: true });
  assert.ok(!(await listed(anon, 'fashion')).includes(t.id), 'banned');
  assert.deepEqual(tree((await anon.get('/api/threads/' + yt.id)).data.comments), [y3.id]);
  await mod.post('/api/admin/users/' + shy.name, { banned: false });

  assert.equal((await y.post('/api/reports', { type: 'post', id: s2.id, reason: 'spam' })).status, 201, 'comments can be reported');
  assert.equal((await x.post('/api/reports', { type: 'post', id: yt.id, reason: 'spam' })).status, 201, 'threads too');
  const reports = (await mod.get('/api/admin/reports')).data.reports;
  assert.deepEqual(reports.filter(r => [s2.id, yt.id].includes(r.targetId)).map(r => [r.snapshot.kind, r.snapshot.subject || r.snapshot.body]).sort(),
    [['comment', 'flares'], ['thread', 'jeans']]);
  await mod.post('/api/admin/reports/' + reports.find(r => r.targetId === s2.id).id, { action: 'hide' });
  assert.deepEqual(tree((await anon.get('/api/threads/' + yt.id)).data.comments), [y3.id], 'a moderator\'s hide works');
});

test('board requests: members ask, a moderator approves (making the board) or declines, and the member hears either way', async () => {
  const m = await newUser('asker'); const mod = await moderator();
  const name = 'Knitting ' + uniq();
  const r = await m.post('/api/boards/requests', { name, reason: 'yarn is life' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data.request).sort(), ['created', 'decided', 'id', 'name', 'reason', 'status']);
  assert.deepEqual([r.data.request.name, r.data.request.reason, r.data.request.status, r.data.request.decided], [name, 'yarn is life', 'pending', null]);
  assert.equal((await m.post('/api/boards/requests', { name: ' ', reason: 'x' })).status, 400);
  assert.equal((await client().post('/api/boards/requests', { name: 'x' })).status, 401);
  assert.equal((await m.get('/api/admin/board-requests')).status, 403);
  const waiting = (await mod.get('/api/admin/board-requests')).data.requests.find(x => x.id === r.data.request.id);
  assert.deepEqual([waiting.user.name, waiting.status, waiting.board, waiting.decidedBy], [m.name, 'pending', null, null]);

  const decide = (id, body) => mod.post('/api/admin/board-requests/' + id, body);
  const id = r.data.request.id;
  assert.equal((await decide(id, { action: 'maybe' })).status, 400);
  assert.equal((await decide(id, { action: 'approve', slug: 'Bad Slug!' })).status, 400);
  assert.equal((await decide(id, { action: 'approve', slug: 'requests' })).status, 400);
  assert.equal((await decide(id, { action: 'approve', icon: 'yarn' })).status, 400, 'the icon is an emoji');
  assert.equal((await decide(id, { action: 'approve', slug: 'music' })).status, 409, 'a slug that\'s taken');
  assert.equal((await decide(99999999, { action: 'decline' })).status, 404);
  const slug = 'knit-' + uniq();
  const ok = await decide(id, { action: 'approve', slug, icon: '🧶', description: 'scarves and such' });
  assert.deepEqual([ok.data.board, ok.data.request.status], [{ slug, name, description: 'scarves and such', icon: '🧶', archived: false }, 'approved']);
  assert.equal((await decide(id, { action: 'decline' })).status, 409, 'decided once');
  const index = (await client().get('/api/boards')).data.boards;
  assert.deepEqual(index.at(-1), { slug, name, description: 'scarves and such', icon: '🧶', threads: 0, lastPost: null }, 'at the end of the index');
  await newThread(m, slug, 'first!!');
  const yes = (await notes(m)).items.find(x => x.kind === 'board_approved');
  assert.deepEqual([yes.actor.name, yes.post, yes.request], [mod.name, null, { name, status: 'approved', board: { slug, name, icon: '🧶' } }]);

  const no = (await m.post('/api/boards/requests', { name: 'Glitter Emergencies', reason: '' })).data.request;
  assert.equal((await decide(no.id, { action: 'decline' })).data.board, null);
  assert.deepEqual((await notes(m)).items.find(x => x.kind === 'board_declined').request, { name: 'Glitter Emergencies', status: 'declined', board: null });
  const plain = (await m.post('/api/boards/requests', { name: 'Pixel Art & Sprites ' + uniq().toUpperCase() })).data.request;
  const made = (await decide(plain.id, { action: 'approve' })).data.board;
  assert.deepEqual([made.slug, made.icon, made.description], [plain.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), '💬', ''], 'the address comes from the name');
  assert.equal((await m.post('/api/boards/requests', { name: 'one more' })).status, 429, '3 a day');
  const long = (await (await newUser('asker')).post('/api/boards/requests', { name: 'abcdefghij abcdefghij abcdefg xyz' })).data.request;
  assert.equal((await decide(long.id, { action: 'approve' })).data.board.slug, 'abcdefghij-abcdefghij-abcdefg', 'cut at 30, never ending in a dash (as the form suggests: frontend.test.mjs)');
  const closed = (await mod.get('/api/admin/board-requests?status=closed')).data.requests.filter(x => [id, no.id].includes(x.id));
  assert.deepEqual(closed.map(x => [x.status, x.decidedBy, x.board && x.board.slug]).sort(), [['approved', mod.name, slug], ['declined', mod.name, null]]);
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'approve_board' && l.targetId === id));
});

test('moderators: sticky threads lead every sort, and archived boards leave the index and take nothing new', async () => {
  const a = await newUser('pin_a'); const b = await newUser('pin_b'); const mod = await moderator();
  const t1 = await newThread(a, 'pets', 'the house rules');
  const t2 = await newThread(a, 'pets', 'my cat');
  const t2c = await newComment(b, t2.id, 'cute');
  assert.equal((await a.post('/api/admin/threads/' + t1.id, { sticky: true })).status, 403);
  assert.equal((await mod.post('/api/admin/threads/' + t1.id, {})).status, 400);
  assert.equal((await mod.post('/api/admin/threads/99999999', { sticky: true })).status, 404);
  assert.equal((await mod.post('/api/admin/threads/' + t2c.id, { sticky: true })).status, 404, 'threads only');
  assert.deepEqual((await mod.post('/api/admin/threads/' + t1.id, { sticky: true })).data, { thread: { id: t1.id, sticky: true, locked: false } });
  for (const sort of ['hot', 'new', 'top', 'best']) assert.equal((await listed(client(), 'pets', 'sort=' + sort))[0], t1.id, sort);
  assert.equal((await client().get('/api/threads/' + t1.id)).data.thread.sticky, true);

  assert.equal((await a.post('/api/admin/boards/pets', { archived: true })).status, 403);
  assert.equal((await mod.post('/api/admin/boards/pets', {})).status, 400);
  assert.equal((await mod.post('/api/admin/boards/nope', { archived: true })).status, 404);
  assert.deepEqual((await mod.post('/api/admin/boards/pets', { archived: true })).data.board, { slug: 'pets', name: 'Pets', description: 'brag about your cat, dog, hamster or lizard', icon: '🐾', archived: true });
  assert.ok(!(await client().get('/api/boards')).data.boards.some(x => x.slug === 'pets'), 'off the index');
  assert.equal((await client().get('/api/boards/pets')).data.board.archived, true, 'still readable');
  assert.equal((await b.post('/api/boards/pets/threads', { subject: 'hi', body: 'there' })).status, 403);
  assert.equal((await b.post(`/api/threads/${t2.id}/comments`, { body: 'hello?' })).status, 403);
  const refused = await vote(b, t2.id, 1);
  assert.deepEqual([refused.status, refused.data.error], [403, 'this board is archived.'], 'the vote says why');
  assert.deepEqual([(await client().get('/api/threads/' + t2.id)).data.thread.board.archived, (await client().get('/api/threads/' + t1.id)).data.thread.board.archived],
    [true, true], 'its threads say so (the page hides the comment box and Reply)');
  assert.equal((await mod.post('/api/admin/boards/pets', { archived: false })).data.board.archived, false);
  assert.equal((await client().get('/api/threads/' + t2.id)).data.thread.board.archived, false);
  assert.ok((await client().get('/api/boards')).data.boards.some(x => x.slug === 'pets'));
  await mod.post('/api/admin/threads/' + t1.id, { sticky: false });
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'archive' && l.targetType === 'board'));
});

test('votes and comments racing a delete or a lock land on nothing, and every count stays exact', async () => {
  const voters = await Promise.all(Array.from({ length: 6 }, () => newUser('vrace')));
  const mod = await moderator();
  const statuses = {};
  for (let round = 0; round < 3; round++) {
    const op = await newUser('vrace_op');
    const t = await newThread(op, 'random', 'race ' + round);
    const keep = await newComment(voters[0], t.id, 'keep me');
    const doomed = await newComment(op, t.id, 'doomed', keep.id);
    const all = await Promise.all([
      op.del('/api/posts/' + doomed.id),
      round === 2 ? mod.post('/api/admin/threads/' + t.id, { locked: true }) : op.del('/api/posts/' + t.id),
      ...voters.slice(1).flatMap((u, i) => [vote(u, doomed.id, i % 2 ? 1 : -1), vote(u, t.id, 1), vote(u, keep.id, -1),
        u.post(`/api/threads/${t.id}/comments`, { body: 'late', parent: doomed.id }), u.post(`/api/threads/${t.id}/comments`, { body: 'late too' })]),
    ]);
    for (const r of all) statuses[r.status] = (statuses[r.status] || 0) + 1;
  }
  assert.ok(Object.keys(statuses).every(s => [200, 201, 403, 404].includes(Number(s))), JSON.stringify(statuses));
  assert.deepEqual(sql(`SELECT v.post_id FROM votes v JOIN posts p ON p.id = v.post_id WHERE p.deleted = 1`), [], 'no vote on a tombstone');
  assert.deepEqual(sql(`SELECT c.id FROM posts c WHERE c.kind = 'comment' AND c.author_id IN (${voters.map(v => v.id)})
    AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = c.reply_to)`), [], 'no comment answers a post that\'s gone');
});

test('deleting an account takes its votes, comments and threads, and the counts and keys on everyone else\'s come right', async () => {
  const a = await newUser('stay_a'); const v = await newUser('leave_v'); const b = await newUser('stay_b');
  const t = await newThread(a, 'school', 'finals week');
  const vc = await newComment(v, t.id, 'cramming');
  const br = await newComment(b, t.id, 'same', vc.id);
  const bc = await newComment(b, t.id, 'good luck');
  await vote(v, t.id, 1); await vote(v, bc.id, -1); await vote(b, t.id, -1);
  const vt = await newThread(v, 'school', 'my own thread');
  await newComment(b, vt.id, 'bye');
  await vote(b, vt.id, 1);
  assert.equal((await v.del('/api/me', { password: PW })).status, 200);
  const page = (await client().get(`/api/threads/${t.id}?sort=old`)).data;
  assert.deepEqual([page.thread.counts, tree(page.comments), page.comments[0].item.replyTo, page.comments[1].item.counts],
    [{ up: 0, down: 1, comments: 2 }, [br.id, bc.id], { id: t.id, author: page.thread.author }, { up: 0, down: 0, comments: 0 }],
    'its comment and votes are gone; a reply to it moves up to what its comment answered (here the thread)');
  assert.deepEqual(orphans(), []);
  assert.equal((await client().get('/api/threads/' + vt.id)).status, 404);
  assert.equal(sql(`SELECT reply_count FROM posts WHERE id = ${t.id}`)[0].reply_count, 2, 'counted as a reply where it moved');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE root_id = ${vt.id}`)[0].n, 0, 'its threads went with their comments');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM votes WHERE user_id = ${v.id}`)[0].n, 0);
});

test('no comment is ever orphaned: a deleted thread stays while any comment is in it, and replies to a leaving account\'s comments move up', async () => {
  for (const order of ['thread first', 'account first']) {
    const op = await newUser('orph_op'); const x = await newUser('orph_x'); const y = await newUser('orph_y');
    const t = await newThread(op, 'school', 'orphans? ' + order);
    const cx = await newComment(x, t.id, 'X');
    const cy = await newComment(y, t.id, 'Y', cx.id);
    if (order === 'thread first') {
      assert.deepEqual((await op.del('/api/posts/' + t.id)).data, { ok: true, tombstone: true });
      assert.equal((await x.del('/api/me', { password: PW })).status, 200, 'and then X\'s writer leaves');
    } else {
      assert.equal((await x.del('/api/me', { password: PW })).status, 200);
      assert.deepEqual((await op.del('/api/posts/' + t.id)).data, { ok: true, tombstone: true }, 'Y, moved up, still holds the thread');
    }
    const page = (await client().get('/api/threads/' + t.id)).data;
    assert.deepEqual([page.thread.deleted, tree(page.comments), page.comments[0].item.replyTo.id, page.thread.counts.comments], [true, [cy.id], t.id, 1], order);
    assert.deepEqual(orphans(), [], order);
    assert.deepEqual((await y.del('/api/posts/' + cy.id)).data, { ok: true, tombstone: false });
    assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id = ${t.id}`)[0].n, 0, `${order}: the last comment going takes the thread's tombstone with it`);
  }

  // up a chain of the leaving account's comments, to the nearest one above that isn't theirs; a tombstone moves with its reply
  const a = await newUser('orph_a'); const v = await newUser('orph_v'); const b = await newUser('orph_b');
  const t = await newThread(a, 'school', 'a long chain');
  const ca = await newComment(a, t.id, 'A');
  const v1 = await newComment(v, t.id, 'V1', ca.id);
  const v2 = await newComment(v, t.id, 'V2', v1.id);
  const b1 = await newComment(b, t.id, 'B1', v2.id);
  const b2 = await newComment(b, t.id, 'B2', v1.id);
  const deep = await newComment(a, t.id, 'deep', b1.id);
  await b.del('/api/posts/' + b1.id);
  assert.equal((await v.del('/api/me', { password: PW })).status, 200);
  const page = (await client().get(`/api/threads/${t.id}?sort=old`)).data;
  assert.deepEqual(tree(page.comments), [[ca.id, [[b1.id, [deep.id]], b2.id]]]);
  assert.deepEqual([page.comments[0].children[1].item.replyTo, page.comments[0].item.counts.comments], [{ id: ca.id, author: ca.author }, 1],
    'they answer A now, which counts B2 (a tombstone isn\'t counted)');
  // a deleted thread held only by a comment deep down (its own top-level comment a tombstone too)
  await a.del('/api/posts/' + ca.id);
  assert.deepEqual((await a.del('/api/posts/' + t.id)).data, { ok: true, tombstone: true });
  await b.del('/api/posts/' + b2.id);
  assert.equal((await client().get('/api/threads/' + t.id)).status, 200, 'deep still holds it all');
  await a.del('/api/posts/' + deep.id);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id IN (${t.id}, ${ca.id}, ${b1.id})`)[0].n, 0, 'and its going clears the tombstones up to the thread');
  assert.deepEqual(orphans(), []);
});

test('votes and replies reach only what the tree shows the writer: not under a hidden comment, not across a block with the thread\'s writer, not past someone banned; nothing moves and nobody is told', async () => {
  const op = await newUser('reach_op'); const c = await newUser('reach_c'); const d = await newUser('reach_d'); const e = await newUser('reach_e'); const f = await newUser('reach_f');
  const mod = await moderator();
  const t = await newThread(op, 'fashion', 'within reach');
  const x = await newComment(c, t.id, 'X');
  const y = await newComment(d, t.id, 'Y', x.id);
  const counts = () => sql(`SELECT id, up_count, down_count, reply_count, comment_count, hot, best FROM posts WHERE id IN (${t.id}, ${x.id}, ${y.id}) ORDER BY id`);
  const before = counts();
  const refused = async (who, label) => {
    assert.equal((await vote(who, y.id, 1)).status, 404, label + ': no vote');
    assert.equal((await who.post(`/api/threads/${t.id}/comments`, { body: 'hm', parent: y.id })).status, 404, label + ': no reply');
  };
  await op.post('/api/blocks/' + e.name);
  assert.equal((await vote(e, x.id, -1)).status, 404, 'the thread\'s writer blocked them');
  await refused(e, 'blocked by the thread\'s writer');
  await mod.post('/api/admin/content', { type: 'post', id: x.id, hidden: true });
  await refused(c, 'under a hidden comment');
  await refused(f, 'under a hidden comment');
  await mod.post('/api/admin/content', { type: 'post', id: x.id, hidden: false });
  await mod.post('/api/admin/users/' + c.name, { banned: true });
  await refused(f, 'under a banned writer\'s comment');
  await mod.post('/api/admin/users/' + c.name, { banned: false });
  await mod.post('/api/admin/users/' + op.name, { banned: true });
  await refused(f, 'in a banned writer\'s thread');
  await mod.post('/api/admin/users/' + op.name, { banned: false });
  assert.deepEqual(counts(), before, 'no count or key moved');
  assert.ok(!(await notes(d)).items.some(n => n.kind === 'reply'), 'and nobody was told');
  assert.equal((await vote(f, y.id, 1)).status, 200, 'all in reach again');
  assert.equal((await f.post(`/api/threads/${t.id}/comments`, { body: 'hello', parent: y.id })).status, 201);
});

test('hiding a thread, or a comment, silences what was told about the comments under it', async () => {
  const op = await newUser('quiet_op'); const c = await newUser('quiet_c'); const d = await newUser('quiet_d'); const mod = await moderator();
  const t = await newThread(op, 'advice', 'quiet please');
  const x = await newComment(c, t.id, 'X');
  const y = await newComment(d, t.id, 'Y', x.id);
  const z = await newComment(op, t.id, 'Z', y.id);
  const told = async () => Promise.all([op, c, d].map(async who => (await notes(who)).items.filter(n => n.kind === 'reply').map(n => n.post.id)));
  assert.deepEqual(await told(), [[x.id], [y.id], [z.id]]);
  const hide = (id, hidden) => mod.post('/api/admin/content', { type: 'post', id, hidden });
  await hide(x.id, true);
  assert.deepEqual(await told(), [[], [], []], 'X hidden: what was told about X and about everything under it');
  assert.equal((await notes(d)).unread, 0, 'and the badge agrees');
  await hide(x.id, false);
  assert.deepEqual(await told(), [[x.id], [y.id], [z.id]], 'back when X is');
  await hide(t.id, true);
  assert.deepEqual(await told(), [[], [], []], 'the thread hidden: all of it');
  await hide(t.id, false);
});

test('"load more" goes on from a cursor: a comment written or deleted between the first answer and the next neither repeats nor pushes one out', async () => {
  const op = await newUser('more_op'); const w = await newUser('more_w');
  const t = await newThread(op, 'random', 'a busy one');
  const board = sql(`SELECT board_id FROM posts WHERE id = ${t.id}`)[0].board_id;
  const at = Date.now() - 3600000;
  sql([`INSERT INTO posts (kind, author_id, board_id, body, reply_to, root_id, created)
      SELECT 'comment', ${w.id}, ${board}, 'c' || value, ${t.id}, ${t.id}, ${at} + value FROM json_each('[${Array.from({ length: 210 }, (_, i) => i).join(',')}]')`,
    `UPDATE posts SET reply_count = 210, comment_count = 210 WHERE id = ${t.id}`, `UPDATE posts SET ${RESORT} WHERE id = ${t.id}`].join(';\n'));
  const all = sql(`SELECT id FROM posts WHERE root_id = ${t.id}`).map(r => r.id);
  for (const sort of ['new', 'best']) {
    const first = (await client().get(`/api/threads/${t.id}?sort=${sort}`)).data.comments;
    const stub = first.at(-1);
    assert.deepEqual([first.length, stub.more, stub.parent], [201, 10, t.id], sort);
    const shown = first.slice(0, -1).map(n => n.item.id);
    const late = await newComment(op, t.id, 'late ' + sort);                    // first in new, last in best (no votes: older first)
    await w.del('/api/posts/' + shown[5]);
    const rest = (await client().get(`/api/threads/${t.id}/comments/${t.id}?sort=${sort}&after=${encodeURIComponent(stub.after)}`)).data.comments.map(n => n.item.id);
    assert.deepEqual(rest.filter(id => shown.includes(id)), [], `${sort}: nothing shown again`);
    assert.deepEqual([...shown, ...rest].filter(id => all.includes(id)).sort((p, q) => p - q), [...all].sort((p, q) => p - q), `${sort}: nothing skipped`);
    all.splice(all.indexOf(shown[5]), 1);
    all.push(late.id);
  }
});

/* ------------------------------------------------------- other sign-in options */

test('sign up with Google: provider, then screen name + birthday, then straight in next time', async () => {
  const c = client();
  const sub = 'google-' + uniq();
  const r = await viaProvider(c, 'google', { sub, email: `g.${sub}@gmail.com`, verified: true, name: 'Gina' });
  const q = r.authorize.searchParams;
  assert.equal(q.get('client_id'), 'g-id');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state') && q.get('code_challenge'));
  assert.equal(r.location, '/join/finish');
  const tokenCall = mock.log.filter(l => l.provider === 'google').at(-1);
  assert.equal(tokenCall.form.client_secret, 'g-secret');
  assert.ok(tokenCall.form.code_verifier, 'PKCE verifier sent');
  const pend = await c.get('/api/signup/pending');
  assert.equal(pend.data.label, 'Google');
  assert.equal(pend.data.email, `g.${sub}@gmail.com`);
  assert.equal(pend.data.nameHint, 'Gina');
  assert.equal((await c.post('/api/signup/finish', { name: 'gina_' + uniq(), birthday: '', rulesOk: true })).status, 400);
  const name = 'gina_' + uniq();
  const done = await c.post('/api/signup/finish', { name, birthday: '1999-07-04', rulesOk: true });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.user.sign.name, 'Cancer');
  const acct = await c.get('/api/me/account');
  assert.equal(acct.data.email, `g.${sub}@gmail.com`);
  assert.equal(acct.data.hasPassword, false);
  assert.deepEqual(acct.data.identities.map(i => i.provider), ['google']);
  const again = client();
  assert.equal((await viaProvider(again, 'google', { sub, email: `g.${sub}@gmail.com`, verified: true })).location, '/');
  assert.equal((await again.get('/api/me')).data.user.name, name);
});

test('a provider can\'t take over an existing account just because the email matches', async () => {
  const owner = await newUser('owner');
  const r = await viaProvider(client(), 'google', { sub: 'g-' + uniq(), email: owner.email, verified: true });
  assert.equal(r.location, '/login?error=email_in_use&provider=google');
  // an address the provider hasn't verified is never matched or stored
  const unchecked = client();
  assert.equal((await viaProvider(unchecked, 'discord', { sub: 'd-' + uniq(), email: owner.email, verified: false })).location, '/join/finish');
  assert.equal((await unchecked.get('/api/signup/pending')).data.email, null);
});

test('connect Discord from Settings, log in with it, and disconnect rules', async () => {
  const me = await newUser('linker');
  const sub = String(100000 + n++);
  const linked = await viaProvider(me, 'discord', { sub, email: `dc${sub}@example.com`, verified: true, name: 'disco' }, 'link');
  assert.equal(linked.location, '/settings?linked=discord');
  assert.deepEqual((await me.get('/api/me/account')).data.identities.map(i => i.provider), ['discord']);
  const elsewhere = client();
  assert.equal((await viaProvider(elsewhere, 'discord', { sub, verified: true })).location, '/');
  assert.equal((await elsewhere.get('/api/me')).data.user.name, me.name);
  const other = await newUser('thief');
  assert.equal((await viaProvider(other, 'discord', { sub, verified: true }, 'link')).location, '/settings?error=identity_taken&provider=discord');
  assert.equal((await me.del('/api/me/identities/discord')).status, 200, 'fine: there\'s still a password');
});

test('an account that only uses Discord must keep a way in', async () => {
  const c = client();
  await viaProvider(c, 'discord', { sub: 'd-' + uniq(), email: null, verified: false, name: 'disco' });
  const name = 'disco_' + uniq();
  assert.equal((await c.post('/api/signup/finish', { name, birthday: '2001-03-03', rulesOk: true })).status, 201);
  assert.equal((await c.del('/api/me/identities/discord')).status, 400);
  assert.equal((await c.post('/api/me/password', { next: 'set-it-now-1' })).status, 200, 'no current password needed when there is none');
  assert.equal((await c.del('/api/me/identities/discord')).status, 200);
  assert.equal((await client().post('/api/login', { login: name, password: 'set-it-now-1' })).status, 200);
});

test('the provider callback only answers GET: a form POST back to it is not a route', async () => {
  const r = await client().raw('POST', '/api/oauth/google/callback', { form: { code: 'x', state: 'y' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 405);
});

test('sign-in state is single use and tied to the browser', async () => {
  const c = client();
  mock.next('google', { sub: 'g-' + uniq() });
  const start = await c.raw('GET', '/api/oauth/google/start?mode=login');
  const a = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(a.headers.get('location'));
  const thief = client();                                   // the same link in a different browser (no state cookie)
  assert.equal((await thief.raw('GET', back.pathname + back.search)).headers.get('location').replace(BASE, ''), '/login?error=expired');
  assert.equal((await c.raw('GET', back.pathname + back.search)).headers.get('location').replace(BASE, ''), '/login?error=expired', 'the failed try used it up');
  assert.equal((await c.raw('GET', '/api/oauth/myspace/start?mode=login')).headers.get('location').replace(BASE, ''), '/login?error=unavailable&provider=myspace');
});

/* --------------------------------------------------------------- Spotify */

test('everyone can connect their own Spotify, and their page shows their top songs', async () => {
  const c = await newUser('listener');
  const loggedOut = await client().raw('GET', '/api/oauth/spotify/start?mode=spotify');
  assert.equal(loggedOut.headers.get('location').replace(BASE, ''), '/login?next=/settings');
  const r = await viaProvider(c, 'spotify', { sub: 'spot-' + uniq(), name: 'DJ Listener' }, 'spotify');
  assert.equal(r.location, '/settings?spotify=connected');
  assert.equal(r.authorize.searchParams.get('scope'), 'user-top-read');
  assert.match(mock.log.filter(l => l.provider === 'spotify').at(-1).auth, /^Basic /);
  const sp = (await client().get('/api/users/' + c.name)).data.spotify;
  assert.equal(sp.tracks.length, 3);
  assert.equal(sp.tracks[0].name, 'Mr. Brightside');
  assert.equal(sp.tracks[0].image, 'https://i.scdn.co/image/mid0');
  assert.equal(sp.tracks[0].preview, 'https://p.scdn.co/mp3-preview/mock');
  assert.match(sp.tracks[1].preview, /^https:\/\/audio-ssl\.itunes\.apple\.com\//, 'iTunes fills in missing previews');
  const row = sql(`SELECT refresh_enc FROM spotify WHERE user_id = ${c.id}`)[0];
  assert.ok(row.refresh_enc && !row.refresh_enc.includes('rt.'), 'the refresh token is stored encrypted');
  assert.equal((await c.put('/api/me/spotify', { timeRange: 'long_term', show: true })).data.tracks[0].name, 'Mr. Brightside (all time)');
  await c.put('/api/me/spotify', { show: false });
  assert.equal((await client().get('/api/users/' + c.name)).data.spotify, null);
  assert.equal((await c.del('/api/me/spotify')).data.connected, false);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM spotify WHERE user_id = ${c.id}`)[0].n, 0);
});

test('Spotify\'s development-mode allowlist: people not on it are told, and nothing is stored', async () => {
  const c = await newUser('notlisted');
  const r = await viaProvider(c, 'spotify', { sub: 'spot-' + uniq(), notAllowlisted: true }, 'spotify');
  assert.equal(r.location, '/settings?spotify=not_allowlisted');
  assert.equal((await c.get('/api/me/spotify')).data.connected, false);
});

/* ------------------------------------------------------------- astrology */

test('astrology: the sky today, a sign\'s horoscope, and a personal reading', async () => {
  const sky = await client().get('/api/astro/sky?tz=0');
  assert.equal(sky.status, 200);
  assert.equal(sky.data.sky.planets.length, 10);
  assert.ok(sky.data.sky.planets.every(p => p.sign && p.glyph));
  assert.ok(sky.data.sky.moon.illumination >= 0 && sky.data.sky.moon.illumination <= 100);
  assert.ok(sky.data.summary.some(l => l.kind === 'moon') && sky.data.summary.some(l => l.kind === 'sun'));
  const leo = await client().get('/api/astro/sign/leo?tz=0');
  assert.ok(leo.data.reading.paragraphs.length >= 2);
  assert.ok(Object.values(leo.data.reading.ratings).every(v => v >= 1 && v <= 5));
  assert.deepEqual((await client().get('/api/astro/sign/leo?tz=0')).data.reading, leo.data.reading, 'the same all day');
  assert.equal((await client().get('/api/astro/sign/ophiuchus')).status, 404);
  assert.equal((await client().get('/api/astro/me')).status, 401);
  const me = await newUser('astro', { birthday: '1995-08-15' });
  const mine = await me.get('/api/astro/me?tz=0');
  assert.equal(mine.data.reading.sign.name, 'Leo');
  assert.deepEqual(mine.data.chart.map(p => p.body), ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']);
  assert.equal(mine.data.chart.find(p => p.body === 'Venus').sign, 'leo');
  assert.equal((await me.get('/api/me')).data.user.sign.key, 'leo');
});

test('deleting an account removes it and frees the name and email', async () => {
  const c = await newUser('leaving'); const pal = await newUser('stayer');
  await befriend(c, pal);
  const hers = (await pal.post('/api/status', { body: 'stay a while' })).data.id;
  for (const what of ['like', 'repost', 'bookmark']) await c.post(`/api/posts/${hers}/${what}`);
  await c.post(`/api/posts/${hers}/replies`, { body: 'can\'t, sorry' });
  await c.post(`/api/posts/${hers}/quote`, { body: 'one last quote' });
  assert.deepEqual((await pal.get('/api/posts/' + hers)).data.post.counts, { likes: 1, replies: 1, reposts: 1, quotes: 1 });
  const bye = await c.post('/api/status', { body: 'goodbye world' });
  const status = (await c.get('/api/posts/' + bye.data.id)).data.post;
  await c.put('/api/me/markers/feed', { created: status.created, id: status.id });
  assert.equal((await c.del('/api/me', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.del('/api/me', { password: PW })).status, 200);
  assert.equal((await client().get('/api/users/' + c.name)).status, 404);
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.body === 'goodbye world'));
  assert.equal(sql(`SELECT (SELECT COUNT(*) FROM follows WHERE ${c.id} IN (follower_id, followee_id)) + (SELECT COUNT(*) FROM markers WHERE user_id = ${c.id}) AS n`)[0].n, 0,
    'its follows and markers are gone');
  assert.deepEqual((await client().get('/api/users/' + pal.name)).data.counts, { followers: 0, following: 0, friends: 0, statuses: 1, replies: 0, blog: 0, comments: 0 });
  const conv = (await pal.get('/api/posts/' + hers)).data;
  assert.deepEqual([conv.post.counts, conv.replies], [{ likes: 0, replies: 0, reposts: 0, quotes: 0 }, []], 'the counts on other people\'s posts come down');
  assert.deepEqual((await notes(pal)).items, [], 'and what they were told about it goes');
  assert.equal(sql(`SELECT (SELECT COUNT(*) FROM likes WHERE user_id = ${c.id}) + (SELECT COUNT(*) FROM bookmarks WHERE user_id = ${c.id})
    + (SELECT COUNT(*) FROM notifications WHERE ${c.id} IN (user_id, actor_id)) AS n`)[0].n, 0);
  assert.equal((await client().post('/api/signup',{ email: c.email, password: PW, name: c.name, birthday: '1995-08-15', rulesOk: true })).status, 201);
});

/* ------------------------------------------------------------------ photos */

// the keys in the local R2 bucket (wrangler dev's local explorer lists it)
async function bucket() {
  const keys = new Set();
  let cursor = '';
  for (;;) {
    const r = await fetch(`${BASE}/cdn-cgi/local/explorer/api/r2/buckets/ourspace-social-media/objects?per_page=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    assert.equal(r.status, 200, 'the local explorer lists the bucket');
    const j = await r.json();
    for (const o of j.result) keys.add(o.key);
    cursor = j.result_info && j.result_info.cursor;
    if (!cursor) return keys;
  }
}
const keyOf = url => url.replace('/media/', '');
// one upload: the raw bytes with their type (or a FormData), answering { status, data }
async function upload(who, bytes, type = 'image/png', purpose) {
  const res = await who.raw('POST', '/api/media' + (purpose ? `?purpose=${purpose}` : ''), { body: bytes, headers: bytes instanceof FormData ? {} : { 'Content-Type': type } });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function photo(who, opts = {}, purpose) {
  const r = await upload(who, png({ width: 40, height: 30, ...opts }), 'image/png', purpose);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.media;
}
// GET /media/<key> as `who`: { status, bytes, headers }
async function fetchMedia(who, url) {
  const res = await who.raw('GET', url);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));
const PUBLIC_CACHE = 'public, max-age=300';
const PRIVATE_CACHE = 'private, no-store';

test('photo uploads: JPEG, PNG, GIF and WebP only, read from their bytes, 2 MB and 4096 px at most, metadata taken out', async () => {
  const me = await newUser('snap');
  const other = await newUser('peek');
  assert.equal((await upload(client(), png())).status, 401, 'members only');

  const dirty = png({ width: 64, height: 48, chunks: [['tEXt', 'Location\0GPS-SECRET'], ['eXIf', 'MM\0*GPS-SECRET']] });
  const up = await upload(me, dirty);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual(Object.keys(up.data.media).sort(), ['height', 'id', 'mime', 'url', 'width']);
  assert.deepEqual([up.data.media.width, up.data.media.height, up.data.media.mime], [64, 48, 'image/png']);
  assert.match(up.data.media.url, /^\/media\/[0-9a-f]{32}\.png$/, 'a random key, never the file\'s name');
  assert.ok((await bucket()).has(keyOf(up.data.media.url)), 'it\'s in the bucket');

  const got = await fetchMedia(me, up.data.media.url);
  assert.equal(got.status, 200);
  assert.ok(!has(got.bytes, 'GPS-SECRET') && !has(got.bytes, 'tEXt') && !has(got.bytes, 'eXIf'), 'stored without its metadata');
  assert.ok(got.bytes.length < dirty.length && got.bytes.subarray(0, 8).equals(dirty.subarray(0, 8)));
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('content-disposition'), 'inline');
  assert.equal(got.headers.get('content-security-policy'), 'default-src \'none\'; sandbox');
  assert.equal(got.headers.get('cache-control'), PRIVATE_CACHE, 'a loose upload is its owner\'s only');
  assert.equal((await me.raw('HEAD', up.data.media.url)).status, 200);
  assert.equal((await fetchMedia(other, up.data.media.url)).status, 404, 'nobody else sees an upload that isn\'t on anything');
  assert.equal((await fetchMedia(client(), up.data.media.url)).status, 404);
  assert.equal((await fetchMedia(client(), '/media/' + '0'.repeat(32) + '.png')).status, 404);
  assert.equal((await fetchMedia(client(), '/media/not-a-key.svg')).status, 404);
  assert.equal((await me.raw('POST', up.data.media.url)).status, 405);

  // a camera JPEG with a GPS position, an animated GIF, a WebP with EXIF and XMP, a multipart form
  const j = await upload(me, jpeg({ width: 1600, height: 1200, gps: true, xmp: true, comment: 'GPS-SECRET' }), 'image/jpeg');
  assert.deepEqual([j.status, j.data.media.width, j.data.media.height, j.data.media.mime], [201, 1600, 1200, 'image/jpeg']);
  const jb = (await fetchMedia(me, j.data.media.url)).bytes;
  assert.ok(!has(jb, 'GPS-SECRET') && !has(jb, 'Exif') && !has(jb, 'xmpmeta'), 'the GPS position is gone');
  const g = await upload(me, gif({ width: 200, height: 150, frames: 4, comment: 'GPS-SECRET' }), 'image/gif');
  assert.deepEqual([g.status, g.data.media.mime], [201, 'image/gif']);
  assert.ok(has((await fetchMedia(me, g.data.media.url)).bytes, 'NETSCAPE2.0'), 'it still moves');
  const w = await upload(me, webp({ kind: 'VP8X', width: 800, height: 600, exif: true, xmp: true }), 'image/webp');
  assert.deepEqual([w.status, w.data.media.mime], [201, 'image/webp']);
  assert.ok(!has((await fetchMedia(me, w.data.media.url)).bytes, 'GPS'));
  const form = new FormData();
  form.append('file', new Blob([png({ width: 10, height: 10 })], { type: 'image/png' }), 'IMG_0001.png');
  const f = await upload(me, form);
  assert.deepEqual([f.status, f.data.media.width], [201, 10], 'a multipart form with one file works too');
  assert.ok(!f.data.media.url.includes('IMG_0001'));

  // refused: not pictures, lying about their type, cut off, too big, too large, animated and too large, bad purpose
  const refuse = async (bytes, type, status, re, purpose) => {
    const r = await upload(me, bytes, type, purpose);
    assert.equal(r.status, status, JSON.stringify(r.data));
    if (re) assert.match(r.data.error, re);
  };
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/svg+xml', 415, /JPEG, PNG, GIF or WebP/);
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png', 415, /SVG/);
  await refuse(Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'image/png', 415, /SVG and web pages/);
  await refuse(Buffer.from('GIF89a<html><script>alert(1)</script></html>'), 'image/gif', 400, /broken/);
  await refuse(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]), 'image/png', 415, /HEIC/);
  await refuse(png(), 'image/jpeg', 415, /isn't the kind of picture it says/);
  await refuse(png(), 'text/plain', 415);
  await refuse(png(), 'application/json', 415);
  const whole = jpeg({ gps: true });
  await refuse(whole.subarray(0, whole.length - 20), 'image/jpeg', 400, /cut off/);
  await refuse(png({ width: 1200, height: 600, draw: () => [Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0], stored: true }), 'image/png', 413, /2 MB/);
  await refuse(png({ width: 4097, height: 2 }), 'image/png', 400, /4096/);
  await refuse(gif({ width: 900, height: 300, frames: 2 }), 'image/gif', 400, /animated/);
  assert.equal((await upload(me, gif({ width: 900, height: 300 }), 'image/gif')).status, 201, 'a still GIF may be bigger');
  await refuse(png({ width: 300, height: 200 }), 'image/png', 400, /square/, 'avatar');
  await refuse(png({ width: 400, height: 400 }), 'image/png', 400, /300/, 'avatar');
  await refuse(png(), 'image/png', 400, /purpose/, 'video');
  await refuse(Buffer.alloc(0), 'image/png', 400);

  // taking back an upload that isn't on anything: out of the table and the bucket; not someone else's
  assert.equal((await other.del('/api/media/' + up.data.media.id)).status, 404);
  assert.deepEqual((await me.del('/api/media/' + up.data.media.id)).data, { ok: true });
  assert.ok(!(await bucket()).has(keyOf(up.data.media.url)));
  assert.equal((await fetchMedia(me, up.data.media.url)).status, 404);
  assert.equal((await me.del('/api/media/' + up.data.media.id)).status, 404);
});

test('photo uploads: 30 an hour and 150 a day, and 200 MB of space per member, with a clear message', async () => {
  const me = await newUser('busy');
  sql(`INSERT INTO attempts (k, created) SELECT 'upload:${me.id}', ${Date.now()} FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30) SELECT i FROM n)`);
  const r = await upload(me, png());
  assert.equal(r.status, 429);
  assert.match(r.data.error, /a lot of photos/);
  sql(`DELETE FROM attempts WHERE k = 'upload:${me.id}'`);
  sql(`INSERT INTO media (key, owner_id, purpose, mime, bytes, width, height, created, attached) VALUES ('${'f'.repeat(32)}.png', ${me.id}, 'avatar', 'image/png', ${200 * 1024 * 1024 - 100}, 300, 300, ${Date.now()}, ${Date.now()})`);
  const full = await upload(me, png());
  assert.equal(full.status, 413);
  assert.match(full.data.error, /200 MB of your photo space/);
  sql(`DELETE FROM media WHERE key = '${'f'.repeat(32)}.png'`);
  assert.equal((await upload(me, png())).status, 201);
});

test('photos on posts: up to 4 on statuses, replies, quotes and threads, 1 on a comment, a cover on a blog post; your own unused uploads only, once', async () => {
  const me = await newUser('poster');
  const pal = await newUser('palz');
  const four = [];
  for (let i = 0; i < 5; i++) four.push(await photo(me, { width: 40 + i, height: 30 }));
  const fifth = four.pop();

  // a status with 4 photos (alt text optional), in order, in every list with their size for the page to keep room
  const s = await me.post('/api/status', { body: 'my weekend', media: [{ id: four[0].id, alt: 'the beach at sunset' }, four[1].id, four[2].id, { id: four[3].id, alt: '' }] });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const post = (await me.get('/api/posts/' + s.data.id)).data.post;
  assert.deepEqual(post.media, [
    { id: four[0].id, url: four[0].url, width: 40, height: 30, alt: 'the beach at sunset' },
    { id: four[1].id, url: four[1].url, width: 41, height: 30, alt: '' },
    { id: four[2].id, url: four[2].url, width: 42, height: 30, alt: '' },
    { id: four[3].id, url: four[3].url, width: 43, height: 30, alt: '' },
  ]);
  assert.equal(post.cover, undefined, 'only blog posts have a cover');
  assert.deepEqual((await me.get(`/api/users/${me.name}/statuses`)).data.items[0].media.map(m => m.id), four.map(m => m.id));
  assert.deepEqual((await client().get('/api/feed')).data.items.find(i => i.id === s.data.id).media.length, 4);
  assert.deepEqual((await fetchMedia(client(), four[0].url)).headers.get('cache-control'), PUBLIC_CACHE, 'an open profile\'s photo is public');

  // not twice, not someone else's, not more than 4, not a cover as a post photo, not in Friends' Comments
  const tryStatus = async (media, status, re) => {
    const r = await me.post('/api/status', { body: 'again', media });
    assert.equal(r.status, status, JSON.stringify(r.data));
    if (re) assert.match(r.data.error, re);
  };
  await tryStatus([four[0].id], 409, /already on another post/);
  const theirs = await photo(pal);
  await tryStatus([theirs.id], 400, /isn't a photo you uploaded/);
  await tryStatus([99999999], 400, /isn't a photo you uploaded/);
  await tryStatus(['1'], 400);
  await tryStatus([fifth.id, fifth.id], 400, /twice/);
  const more = [fifth, await photo(me), await photo(me), await photo(me), await photo(me)];
  await tryStatus(more.map(m => m.id), 400, /up to 4/);
  await tryStatus('nope', 400);
  const cover = await photo(me, {}, 'cover');
  await tryStatus([cover.id], 400, /isn't a post photo/);
  await befriend(me, pal);
  assert.equal((await me.post(`/api/users/${pal.name}/comments`, { body: 'hi', media: [fifth.id] })).status, 400, 'no photos in Friends\' Comments');
  // an upload a day old (about to be cleaned up) can't be attached any more
  sql(`UPDATE media SET created = created - ${23.5 * 3600000} WHERE id = ${more[4].id}`);
  await tryStatus([more[4].id], 410, /expired/);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ${me.id} AND body = 'again'`)[0].n, 0, 'none of those posted anything');

  // a photo with no words is a post; replies, quotes and threads take 4, comments 1
  const only = await me.post('/api/status', { body: '', media: [fifth.id] });
  assert.equal(only.status, 201);
  assert.equal((await me.post('/api/status', { body: '' })).status, 400, 'no words and no photo is nothing');
  const reply = await pal.post(`/api/posts/${s.data.id}/replies`, { body: 'jealous', media: [(await photo(pal)).id, (await photo(pal)).id] });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.post.media.length, 2);
  const quote = await pal.post(`/api/posts/${s.data.id}/quote`, { body: '', media: [(await photo(pal)).id] });
  assert.equal(quote.status, 201, 'a quote with a photo and no words');
  assert.equal(quote.data.post.media.length, 1);
  assert.equal(quote.data.post.quoted.media.length, 4, 'the quote\'s box shows the quoted post\'s photos');
  await pal.post(`/api/posts/${s.data.id}/repost`);
  const repost = (await pal.get(`/api/users/${pal.name}/statuses`)).data.items.find(i => i.kind === 'repost');
  assert.deepEqual([repost.media, repost.quoted.media.length], [[], 4], 'a repost shows its original\'s photos');
  const thread = await pal.post('/api/boards/pets/threads', { subject: 'my cat', body: '', media: [(await photo(pal)).id, (await photo(pal)).id, (await photo(pal)).id] });
  assert.equal(thread.status, 201, JSON.stringify(thread.data));
  assert.equal(thread.data.thread.media.length, 3);
  assert.equal((await client().get('/api/boards/pets?sort=new')).data.items.find(i => i.id === thread.data.thread.id).media.length, 3, 'the board\'s list has them too');
  const two = [(await photo(me)).id, (await photo(me)).id];
  const tooMany = await me.post(`/api/threads/${thread.data.thread.id}/comments`, { body: 'cute', media: two });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /one photo at most/);
  const comment = await me.post(`/api/threads/${thread.data.thread.id}/comments`, { body: '', media: [two[0]] });
  assert.equal(comment.status, 201);
  const shown = (await client().get('/api/threads/' + thread.data.thread.id)).data;
  assert.equal(shown.thread.media.length, 3);
  assert.equal(shown.comments[0].item.media[0].id, two[0]);

  // a blog post's cover: one, uploaded as a cover; on the post, the blog index and the feed
  assert.equal((await me.post('/api/blog', { title: 'trip', body: 'words', cover: two[1] })).status, 400, 'a post photo isn\'t a cover');
  const b = await me.post('/api/blog', { title: 'trip', body: 'words', cover: { id: cover.id, alt: 'a map' } });
  assert.equal(b.status, 201);
  const entry = (await me.get(`/api/users/${me.name}/blog`)).data.entries.find(e => e.id === b.data.id);
  assert.deepEqual([entry.cover, entry.media], [{ id: cover.id, url: cover.url, width: 40, height: 30, alt: 'a map' }, []]);
  assert.equal((await client().get('/api/posts/' + b.data.id)).data.post.cover.id, cover.id);
  assert.equal((await me.get('/api/feed')).data.items.find(i => i.id === b.data.id).cover.alt, 'a map');
  assert.equal((await me.post('/api/blog', { title: 'trip', body: 'words', media: [cover.id] })).status, 409, 'media: [cover] works too, once');
});

test('photos on posts: two posts racing for the same upload: one gets it, the other writes nothing at all', async () => {
  const me = await newUser('racer');
  const pal = await newUser('target');
  const parent = (await pal.post('/api/status', { body: 'reply to me' })).data.id;
  const m = await photo(me);
  const [a, b] = await Promise.all([
    me.post(`/api/posts/${parent}/replies`, { body: 'first', media: [m.id] }),
    me.post(`/api/posts/${parent}/replies`, { body: 'second', media: [m.id] }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.data, b.data]));
  // (whichever check catches the second: the one before the write, or the database's own in the write batch)
  assert.match((a.status === 409 ? a : b).data.error, /already on another post|just went on another post/);
  const conv = (await pal.get('/api/posts/' + parent)).data;
  assert.deepEqual([conv.post.counts.replies, conv.replies.length], [1, 1], 'one reply, counted once');
  assert.equal((await notes(pal)).items.filter(n => n.kind === 'reply').length, 1, 'and told once');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM media WHERE id = ${m.id} AND post_id = ${conv.replies[0].id}`)[0].n, 1);
});

test('photo privacy: a private member\'s photos only for who may see the post, never cached; hidden, deleted or blocked ones are 404', async () => {
  const shy = await newUser('shyphoto');
  const fan = await newUser('fanphoto');
  const stranger = await newUser('strphoto');
  const mod = await moderator('photomod');
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  await fan.post('/api/follows/' + shy.name);
  await shy.post('/api/followers/' + fan.name);
  const m = await photo(shy);
  const s = await shy.post('/api/status', { body: 'friends only', media: [m.id] });
  assert.equal(s.status, 201);
  const seen = await fetchMedia(fan, m.url);
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get('cache-control'), PRIVATE_CACHE);
  assert.equal((await fetchMedia(shy, m.url)).status, 200);
  assert.equal((await fetchMedia(mod, m.url)).status, 200, 'moderators see everything');
  assert.equal((await fetchMedia(stranger, m.url)).status, 404);
  assert.equal((await fetchMedia(client(), m.url)).status, 404);
  // losing access loses the photo
  await shy.del('/api/followers/' + fan.name);
  assert.equal((await fetchMedia(fan, m.url)).status, 404, 'removed as a follower: gone');
  // a private member's board thread is a public space
  const t = await shy.post('/api/boards/pets/threads', { subject: 'the dog', body: 'look', media: [(await photo(shy)).id] });
  const tm = t.data.thread.media[0];
  const pub = await fetchMedia(client(), tm.url);
  assert.deepEqual([pub.status, pub.headers.get('cache-control')], [200, PUBLIC_CACHE]);
  // blocks hide photos both ways
  await stranger.post('/api/blocks/' + shy.name);
  assert.equal((await fetchMedia(stranger, tm.url)).status, 404, 'across a block');
  // a moderator hides the post: its photos go dark for everyone but moderators; unhiding brings them back
  assert.equal((await mod.post('/api/admin/content', { type: 'post', id: t.data.thread.id, hidden: true })).status, 200);
  assert.equal((await fetchMedia(client(), tm.url)).status, 404);
  assert.equal((await fetchMedia(shy, tm.url)).status, 404, 'its writer too');
  assert.equal((await fetchMedia(mod, tm.url)).status, 200);
  await mod.post('/api/admin/content', { type: 'post', id: t.data.thread.id, hidden: false });
  assert.equal((await fetchMedia(client(), tm.url)).status, 200);
  // a moderator hides just the photo
  assert.equal((await fan.post(`/api/admin/media/${tm.id}`, { action: 'hide' })).status, 403, 'moderators only');
  assert.deepEqual((await mod.post(`/api/admin/media/${tm.id}`, { action: 'hide', note: 'not ok' })).data, { ok: true });
  assert.equal((await fetchMedia(client(), tm.url)).status, 404);
  assert.deepEqual((await client().get('/api/threads/' + t.data.thread.id)).data.thread.media, [], 'and it leaves the item');
  await mod.post(`/api/admin/media/${tm.id}`, { action: 'unhide' });
  assert.equal((await client().get('/api/threads/' + t.data.thread.id)).data.thread.media.length, 1);
  // deleting the post deletes its photos, from the bucket too, whether it goes or stays as a tombstone
  const reply = await shy.post(`/api/posts/${s.data.id}/replies`, { body: 'holding it up' });
  assert.equal(reply.status, 201);
  assert.ok((await bucket()).has(keyOf(m.url)));
  assert.equal((await shy.del('/api/posts/' + s.data.id)).data.tombstone, true);
  assert.ok(!(await bucket()).has(keyOf(m.url)), 'a tombstone keeps no photos');
  assert.equal((await fetchMedia(shy, m.url)).status, 404);
  assert.equal((await shy.del('/api/posts/' + t.data.thread.id)).data.tombstone, false);
  assert.ok(!(await bucket()).has(keyOf(tm.url)));
});

test('profile pictures: upload your own (square, up to 300px), use it, change it, and the old one leaves the bucket', async () => {
  const me = await newUser('selfie');
  const other = await newUser('copycat');
  const a = await photo(me, { width: 300, height: 300 }, 'avatar');
  const notAvatar = await photo(me);
  assert.equal((await me.put('/api/me/profile', { avatar: notAvatar.url })).status, 400, 'a post photo isn\'t a picture');
  assert.equal((await other.put('/api/me/profile', { avatar: a.url })).status, 400, 'nor is someone else\'s');
  assert.equal((await me.put('/api/me/profile', { avatar: '/media/../../evil.svg' })).status, 400);
  const set = await me.put('/api/me/profile', { avatar: a.url });
  assert.deepEqual([set.status, set.data.avatar], [200, a.url]);
  assert.equal((await me.get('/api/me')).data.user.avatar, a.url);
  assert.equal((await client().get('/api/users/' + me.name)).data.user.avatar, a.url);
  const pub = await fetchMedia(client(), a.url);
  assert.deepEqual([pub.status, pub.headers.get('cache-control')], [200, PUBLIC_CACHE], 'pictures are public');
  assert.equal((await me.put('/api/me/profile', { avatar: a.url, tag: 'same pic' })).status, 200, 'saving it again changes nothing');
  assert.ok((await bucket()).has(keyOf(a.url)));
  const b = await photo(me, { width: 120, height: 120 }, 'avatar');
  assert.equal((await me.put('/api/me/profile', { avatar: b.url })).data.avatar, b.url);
  let keys = await bucket();
  assert.ok(!keys.has(keyOf(a.url)) && keys.has(keyOf(b.url)), 'the old picture is deleted');
  assert.equal((await fetchMedia(client(), a.url)).status, 404);
  const preset = (await client().get('/api/options')).data.avatars[3].file;
  assert.equal((await me.put('/api/me/profile', { avatar: preset })).data.avatar, preset, 'presets still work');
  keys = await bucket();
  assert.ok(!keys.has(keyOf(b.url)), 'and going back to a preset deletes the upload');
  assert.equal((await me.put('/api/me/profile', { avatar: b.url })).status, 400, 'it\'s gone');
});

test('moderators remove a photo at once (a Take It Down request): out of R2, logged; reports on a post list its photos', async () => {
  const me = await newUser('reported');
  const reporter = await newUser('reporter');
  const mod = await moderator('takedown');
  const p1 = await photo(me), p2 = await photo(me);
  const s = await me.post('/api/status', { body: 'look', media: [{ id: p1.id, alt: 'one' }, p2.id] });
  assert.equal((await reporter.post('/api/reports', { type: 'post', id: s.data.id, reason: 'other', details: 'this photo is of me' })).status, 201);
  const rep = (await mod.get('/api/admin/reports')).data.reports.find(r => r.targetId === s.data.id);
  assert.deepEqual(rep.snapshot.media.map(m => [m.id, m.url, m.alt]), [[p1.id, p1.url, 'one'], [p2.id, p2.url, '']]);
  assert.equal((await reporter.post(`/api/admin/media/${p1.id}`, { action: 'remove' })).status, 403);
  assert.equal((await mod.post(`/api/admin/media/${p1.id}`, { action: 'explode' })).status, 400);
  assert.deepEqual((await mod.post(`/api/admin/media/${p1.id}`, { action: 'remove', note: 'Take It Down request' })).data, { ok: true });
  assert.ok(!(await bucket()).has(keyOf(p1.url)));
  assert.equal((await fetchMedia(mod, p1.url)).status, 404);
  assert.deepEqual((await client().get('/api/posts/' + s.data.id)).data.post.media.map(m => m.id), [p2.id], 'the post keeps its other photo');
  assert.equal((await mod.post(`/api/admin/media/${p1.id}`, { action: 'remove' })).status, 404);
  const log = (await mod.get('/api/admin/log')).data.log.filter(l => l.targetType === 'media' && l.targetId === p1.id);
  assert.deepEqual(log.map(l => [l.action, l.note]), [['remove_media', 'Take It Down request']], 'logged once');
  // removing someone's picture puts them back on the default one
  const pic = await photo(me, { width: 100, height: 100 }, 'avatar');
  await me.put('/api/me/profile', { avatar: pic.url });
  await mod.post(`/api/admin/media/${pic.id}`, { action: 'remove' });
  assert.equal((await me.get('/api/me')).data.user.avatar, (await client().get('/api/options')).data.avatars[0].file);
  assert.ok(!(await bucket()).has(keyOf(pic.url)));
});

test('the cron deletes uploads still loose after a day, and photos whose post went without them', async () => {
  const me = await newUser('loose');
  const old = await photo(me), fresh = await photo(me), used = await photo(me);
  await me.post('/api/status', { body: 'kept', media: [used.id] });
  sql(`UPDATE media SET created = created - ${25 * 3600000} WHERE id IN (${old.id}, ${used.id})`);
  // (a post that somehow went without taking its photos: post_id falls to NULL)
  const lost = await photo(me);
  const lostPost = (await me.post('/api/status', { body: 'lost', media: [lost.id] })).data.id;
  sql(`DELETE FROM posts WHERE id = ${lostPost}`);
  // (the local explorer runs the cron, as the dashboard's trigger would)
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=${WORKER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: '*/30 * * * *' }) });
  assert.equal(res.status, 200, await res.text());
  for (let i = 0; i < 20 && (await bucket()).has(keyOf(old.url)); i++) await new Promise(r => setTimeout(r, 250));   // (the cron runs in waitUntil)
  const keys = await bucket();
  assert.ok(!keys.has(keyOf(old.url)), 'a day-old loose upload is gone');
  assert.ok(!keys.has(keyOf(lost.url)), 'so is a photo whose post is gone');
  assert.ok(keys.has(keyOf(fresh.url)) && keys.has(keyOf(used.url)), 'a fresh upload and an attached photo stay');
  assert.deepEqual(sql(`SELECT id FROM media WHERE owner_id = ${me.id} ORDER BY id`).map(r => r.id), [fresh.id, used.id]);
});

test('deleting an account deletes every photo it uploaded and those on the comments that go with its threads, from the bucket too', async () => {
  const me = await newUser('photogone', {});
  const pal = await newUser('photostays');
  const pic = await photo(me, { width: 300, height: 300 }, 'avatar');
  await me.put('/api/me/profile', { avatar: pic.url });
  const mine = await photo(me), loose = await photo(me);
  await me.post('/api/status', { body: 'bye', media: [mine.id] });
  const t = (await me.post('/api/boards/random/threads', { subject: 'last thread', body: 'ok', media: [(await photo(me)).id] })).data.thread;
  const theirs = await photo(pal);
  await pal.post(`/api/threads/${t.id}/comments`, { body: 'nice', media: [theirs.id] });
  const kept = await photo(pal);
  await pal.post('/api/status', { body: 'still here', media: [kept.id] });
  const before = await bucket();
  const gone = [pic, mine, loose, theirs, t.media[0]].map(m => keyOf(m.url));
  assert.ok(gone.every(k => before.has(k)));
  assert.equal((await me.del('/api/me', { password: PW })).status, 200);
  const after = await bucket();
  assert.deepEqual(gone.filter(k => after.has(k)), [], 'all gone');
  assert.ok(after.has(keyOf(kept.url)), 'other people\'s photos elsewhere stay');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM media WHERE owner_id = ${me.id}`)[0].n, 0);
});

// runs the cron through the local explorer and waits for it (it runs in waitUntil) until `done()` holds
async function runCron(done) {
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=${WORKER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: '*/30 * * * *' }) });
  assert.equal(res.status, 200, await res.text());
  for (let i = 0; i < 20 && !(await done()); i++) await new Promise(r => setTimeout(r, 250));
}

test('photos a moderator hid, or on a post a moderator hid, are held as evidence: no author action deletes them, only a moderator\'s remove', async () => {
  const me = await newUser('evidence');
  const pal = await newUser('evipal');
  const reporter = await newUser('evirep');
  const mod = await moderator('evimod');
  const inBucket = async m => (await bucket()).has(keyOf(m.url));
  const row = m => sql(`SELECT owner_id, post_id, hidden FROM media WHERE id = ${m.id}`)[0];

  // a photo hidden on its own, then the post deleted: that photo stays (hidden, off the post), the other goes
  const m1 = await photo(me), m2 = await photo(me);
  const s1 = (await me.post('/api/status', { body: 'x', media: [m1.id, m2.id] })).data.id;
  await mod.post(`/api/admin/media/${m1.id}`, { action: 'hide', note: 'evidence' });
  assert.equal((await me.del('/api/posts/' + s1)).status, 200);
  assert.deepEqual(row(m1), { owner_id: me.id, post_id: null, hidden: 1 });
  assert.ok(await inBucket(m1), 'the held photo stays in the bucket');
  assert.ok(!(await inBucket(m2)), 'the other one goes');
  assert.equal((await fetchMedia(mod, m1.url)).status, 200, 'moderators can still open it');
  assert.equal((await fetchMedia(me, m1.url)).status, 404, 'nobody else');

  // a post a moderator hid, deleted by its author (or kept as a tombstone): all its photos are held
  const m3 = await photo(me);
  const s2 = (await me.post('/api/status', { body: 'x', media: [m3.id] })).data.id;
  await mod.post('/api/admin/content', { type: 'post', id: s2, hidden: true, note: 'keep' });
  await me.del('/api/posts/' + s2);
  assert.deepEqual(row(m3), { owner_id: me.id, post_id: null, hidden: 1 });
  assert.equal((await fetchMedia(mod, m3.url)).status, 200);
  const m4 = await photo(me);
  const s3 = (await me.post('/api/status', { body: 'x', media: [m4.id] })).data.id;
  const r3 = (await pal.post(`/api/posts/${s3}/replies`, { body: 'reply' })).data.post.id;
  await mod.post('/api/admin/content', { type: 'post', id: s3, hidden: true });
  assert.equal((await me.del('/api/posts/' + s3)).data.tombstone, true);
  await pal.del('/api/posts/' + r3);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id = ${s3}`)[0].n, 0, 'the tombstone is cleared');
  assert.equal(row(m4).hidden, 1);
  assert.ok(await inBucket(m4));

  // a report made after a photo was hidden still lists it for the moderators
  const m5 = await photo(me), m6 = await photo(me);
  const s4 = (await me.post('/api/status', { body: 'x', media: [m5.id, m6.id] })).data.id;
  await mod.post(`/api/admin/media/${m5.id}`, { action: 'hide' });
  await reporter.post('/api/reports', { type: 'post', id: s4, reason: 'other', details: 'this' });
  const rep = (await mod.get('/api/admin/reports')).data.reports.find(r => r.targetId === s4);
  assert.deepEqual(rep.snapshot.media.map(m => m.id), [m5.id, m6.id]);
  await me.del('/api/posts/' + s4);
  assert.deepEqual(await Promise.all(rep.snapshot.media.map(async m => (await fetchMedia(mod, m.url)).status)), [200, 404], 'the held one still opens from the report');

  // a picture a moderator hid survives its owner changing it
  const av = await photo(me, { width: 50, height: 50 }, 'avatar');
  await me.put('/api/me/profile', { avatar: av.url });
  await mod.post(`/api/admin/media/${av.id}`, { action: 'hide' });
  const preset = (await client().get('/api/options')).data.avatars[2].file;
  assert.equal((await me.put('/api/me/profile', { avatar: preset })).data.avatar, preset);
  assert.equal(row(av).hidden, 1);
  assert.ok(await inBucket(av));

  // a hidden loose upload can't be taken back by its owner
  const lo = await photo(me);
  await mod.post(`/api/admin/media/${lo.id}`, { action: 'hide' });
  assert.equal((await me.del('/api/media/' + lo.id)).status, 404);

  // the cron leaves them, the account going leaves them (without an owner), and only a moderator's remove deletes them
  const old = await photo(me);
  sql(`UPDATE media SET created = created - ${25 * 3600000} WHERE id IN (${lo.id}, ${old.id})`);
  const plain = await photo(me);
  await runCron(async () => !(await inBucket(old)));
  assert.ok(!(await inBucket(old)), 'the cron ran: an old loose upload is gone');
  assert.ok((await Promise.all([m1, m3, m4, m5, av, lo].map(inBucket))).every(Boolean), 'the cron keeps held photos');
  assert.equal((await me.del('/api/me', { password: PW })).status, 200);
  assert.deepEqual(row(m1), { owner_id: null, post_id: null, hidden: 1 });
  assert.equal(sql(`SELECT COUNT(*) AS n FROM media WHERE id = ${plain.id}`)[0].n, 0, 'their other uploads go');
  assert.ok(!(await inBucket(plain)));
  assert.equal((await fetchMedia(mod, m1.url)).status, 200, 'still there for the moderators');
  for (const m of [m1, m3, m4, m5, av, lo]) assert.deepEqual((await mod.post(`/api/admin/media/${m.id}`, { action: 'remove', note: 'reported, removed' })).data, { ok: true });
  assert.ok((await Promise.all([m1, m3, m4, m5, av, lo].map(inBucket))).every(x => !x), 'removed: out of the bucket');
});

test('a board comment\'s photo shows only while its thread and every comment above it show to the viewer, and is never cached', async () => {
  const op = await newUser('cthread');
  const cm = await newUser('ccomment');
  const viewer = await newUser('cview');
  const mod = await moderator('cmod');
  const t = (await op.post('/api/boards/music/threads', { subject: 'photo thread', body: 'x' })).data.thread;
  const parent = (await cm.post(`/api/threads/${t.id}/comments`, { body: 'parent' })).data.comment;
  const cp = await photo(cm);
  const child = await cm.post(`/api/threads/${t.id}/comments`, { body: 'child', parent: parent.id, media: [cp.id] });
  assert.equal(child.status, 201, JSON.stringify(child.data));
  const seen = await fetchMedia(client(), cp.url);
  assert.deepEqual([seen.status, seen.headers.get('cache-control')], [200, PRIVATE_CACHE]);
  const status = async who => (await fetchMedia(who, cp.url)).status;
  // the thread hidden
  await mod.post('/api/admin/content', { type: 'post', id: t.id, hidden: true });
  assert.equal(await status(client()), 404, 'thread hidden');
  assert.equal(await status(mod), 200);
  await mod.post('/api/admin/content', { type: 'post', id: t.id, hidden: false });
  assert.equal(await status(client()), 200);
  // the comment above it hidden
  await mod.post('/api/admin/content', { type: 'post', id: parent.id, hidden: true });
  assert.equal(await status(client()), 404, 'a comment above it hidden');
  await mod.post('/api/admin/content', { type: 'post', id: parent.id, hidden: false });
  // a block with the thread's writer, either way
  await op.post('/api/blocks/' + viewer.name);
  assert.equal(await status(viewer), 404, 'the thread\'s writer blocked the viewer');
  await op.del('/api/blocks/' + viewer.name);
  await viewer.post('/api/blocks/' + op.name);
  assert.equal(await status(viewer), 404, 'the viewer blocked the thread\'s writer');
  await viewer.del('/api/blocks/' + op.name);
  assert.equal(await status(viewer), 200);
  // the thread's writer banned
  await mod.post('/api/admin/users/' + op.name, { banned: true });
  assert.equal(await status(client()), 404, 'the thread\'s writer banned');
  await mod.post('/api/admin/users/' + op.name, { banned: false });
  assert.equal(await status(client()), 200);
  // the thread deleted (it stays as a tombstone for its comments; a ban logged its writer out, so a moderator does it)
  assert.equal((await mod.del('/api/posts/' + t.id)).data.tombstone, true);
  assert.equal(await status(client()), 404, 'the thread deleted');
});

test('public photos are cached for 5 minutes and revalidated by ETag; losing access wins over the cache', async () => {
  const me = await newUser('etag');
  const m = await photo(me);
  await me.post('/api/status', { body: 'public', media: [m.id] });
  const first = await client().raw('GET', m.url);
  assert.deepEqual([first.status, first.headers.get('cache-control')], [200, PUBLIC_CACHE]);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await client().raw('GET', m.url, { headers: { 'If-None-Match': etag } });
  assert.deepEqual([again.status, again.headers.get('cache-control'), again.headers.get('etag')], [304, PUBLIC_CACHE, etag]);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  const other = await client().raw('GET', m.url, { headers: { 'If-None-Match': '"something-else"' } });
  assert.equal(other.status, 200);
  assert.ok(Buffer.from(await other.arrayBuffer()).subarray(0, 8).equals(png().subarray(0, 8)));
  await me.put('/api/me/settings', { followPolicy: 'approve' });
  assert.equal((await client().raw('GET', m.url, { headers: { 'If-None-Match': etag } })).status, 404, 'gone private: no 304 any more');
});

test('photo uploads: image/jpg counts as JPEG, and a multipart part typed application/octet-stream is read from its bytes', async () => {
  const me = await newUser('jpgtype');
  const j = await upload(me, jpeg({ width: 20, height: 10 }), 'image/jpg');
  assert.deepEqual([j.status, j.data.media.mime], [201, 'image/jpeg']);
  assert.equal((await upload(me, png(), 'image/jpg')).status, 415, 'still has to be a JPEG');
  const part = (bytes, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), 'x'); return f; };
  const o = await upload(me, part(png({ width: 12, height: 12 }), 'application/octet-stream'));
  assert.deepEqual([o.status, o.data.media.mime, o.data.media.width], [201, 'image/png', 12]);
  assert.equal((await upload(me, part(jpeg(), 'image/jpg'))).status, 201);
  assert.equal((await upload(me, part(png(), 'image/gif'))).status, 415, 'a part that says another picture type is refused');
  assert.equal((await upload(me, part(png(), 'text/html'))).status, 415);
});

/* ------------------------------------------------------------- Browse */

// GET as `who`, with the rows the request read (X-Rows-Read: the tests run with SHOW_ROWS_READ)
async function getRows(who, url) {
  const res = await who.raw('GET', url);
  return { status: res.status, data: await res.json(), rows: Number(res.headers.get('x-rows-read')), headers: res.headers };
}
const ageYearsAgo = n => `${new Date().getUTCFullYear() - n}-01-01`;

test('browse, mutuals: friends of friends by mutual friends, then "follows you", then Adamic–Adar; who you have in common; private ones as name and picture; never followed, requested, blocked, banned, hidden or across the 18 line', async () => {
  const me = await newUser('mme');
  const P = {};
  for (const k of ['a', 'b', 'x', 'y', 'u', 'z', 'p', 'w', 'q', 'r', 's', 't']) P[k] = await newUser('mm' + k);
  const teen = await newUser('mmteen', { birthday: ageYearsAgo(15) });
  // a: friends with me, x, y, z, p, q, r, s, t and the teen (10 friends); b: with me, x, u, w (4)
  for (const [m, n] of [[me, P.a], [me, P.b], [P.a, P.x], [P.b, P.x], [P.a, P.y], [P.b, P.u], [P.a, P.z], [P.a, P.p], [P.b, P.w], [P.a, P.q], [P.a, P.r], [P.a, P.s], [P.a, P.t], [P.a, teen]]) await befriend(m, n);
  await P.p.put('/api/me/settings', { followPolicy: 'approve', dmPolicy: 'friends' });     // private: shows as a name and a picture
  await P.q.put('/api/me/settings', { followPolicy: 'approve' });
  await me.post('/api/follows/' + P.q.name);                                            // requested: out
  await me.post('/api/follows/' + P.w.name);                                            // followed: out
  await P.y.post('/api/follows/' + me.name);                                            // follows me
  await P.r.post('/api/blocks/' + me.name);                                             // a block: out
  const mod = await moderator('mmmod');
  await mod.post('/api/admin/users/' + P.s.name, { banned: true });                     // banned: out
  assert.equal((await me.post(`/api/browse/hidden/person/${P.t.id}`)).status, 200);    // "not interested": out

  const got = await getRows(me, '/api/browse/mutuals');
  assert.equal(got.status, 200);
  // x: 2 mutual friends. Then 1 each: y follows me; u's mutual friend (b) has 4 friends, z's and p's (a) 10, so u
  // comes first (Adamic–Adar); z and p tie on everything and the older account goes first
  assert.deepEqual(got.data.people.map(o => o.user.id), [P.x.id, P.y.id, P.u.id, P.z.id, P.p.id]);
  assert.equal(got.data.next, null);
  const [ox, oy, , , op] = got.data.people;
  const ab = [P.a, P.b].sort((m, n) => m.name.localeCompare(n.name));
  assert.deepEqual(ox.mutual, { count: 2, people: ab.map(m => ({ id: m.id, name: m.name, avatar: ox.mutual.people.find(v => v.id === m.id).avatar })) });
  assert.equal(ox.why, `Friends with ${ab[0].name} and ${ab[1].name}`);
  assert.equal(ox.because, 'mutual');
  assert.equal(oy.why, `Friends with ${P.a.name} · follows you`);
  assert.deepEqual(oy.relation, { following: 'none', followsMe: true, friends: false, blockedByMe: false, canComment: false, canMessage: true });
  assert.deepEqual(Object.keys(op).sort(), ['because', 'mutual', 'private', 'relation', 'user', 'why'], 'a private profile: nothing but its name and picture');
  assert.equal(op.private, true);
  assert.equal(op.relation.canMessage, false, 'its messages are for friends');
  assert.ok(got.rows > 0 && got.rows < 2000, `bounded: ${got.rows} rows`);

  // a teen never sees adults they don't know, nor adults the teen
  assert.deepEqual((await me.get('/api/browse/mutuals')).data.people.filter(o => o.user.id === teen.id), []);
  assert.deepEqual((await teen.get('/api/browse/mutuals')).data.people, [], 'everyone the teen could meet through a is an adult');

  // "not interested" goes both ways; following someone takes them off
  await me.post(`/api/browse/hidden/person/${P.x.id}`);
  assert.ok(!(await me.get('/api/browse/mutuals')).data.people.some(o => o.user.id === P.x.id));
  assert.deepEqual((await me.del(`/api/browse/hidden/person/${P.x.id}`)).data, { hidden: null });
  assert.ok((await me.get('/api/browse/mutuals')).data.people.some(o => o.user.id === P.x.id));
  await me.post('/api/follows/' + P.z.name);
  assert.ok(!(await me.get('/api/browse/mutuals')).data.people.some(o => o.user.id === P.z.id));

  // logged out: nobody, and a prompt
  const anon = await getRows(client(), '/api/browse/mutuals');
  assert.deepEqual([anon.data.people, anon.data.next, typeof anon.data.prompt], [[], null, 'string']);

  // Who to follow: the top mutuals first, then recently active open profiles by followers (never private, me or anyone
  // I follow); logged out, only those
  const three = await getRows(me, '/api/browse/people?limit=3');
  assert.deepEqual(three.data.people.map(o => [o.user.id, o.because]), [[P.x.id, 'mutual'], [P.y.id, 'mutual'], [P.u.id, 'mutual']]);
  assert.equal(three.headers.get('cache-control'), 'no-store', 'yours alone: a browser never keeps it for the next account');
  const ten = (await me.get('/api/browse/people?limit=10')).data.people;
  assert.ok(ten.length >= 5 && ten.length <= 10, String(ten.length));
  assert.deepEqual(ten.slice(0, 4).map(o => o.user.id), [P.x.id, P.y.id, P.u.id, P.p.id]);
  for (const o of ten.slice(4)) {
    assert.equal(o.because, 'popular');
    assert.ok(o.private === false && typeof o.followers === 'number' && o.why);
    assert.ok(![me.id, P.a.id, P.b.id, P.w.id, P.r.id, P.s.id, P.t.id, teen.id].includes(o.user.id), 'not me, followed, blocked, banned, hidden or a teen');
  }
  const out = (await client().get('/api/browse/people?limit=10')).data.people;
  assert.ok(out.length > 0 && out.every(o => o.because === 'popular' && !o.private && o.relation === null && o.user.id !== P.s.id));
  assert.ok(three.rows < 2000, `bounded: ${three.rows} rows`);
});

test('browse, boards for you: interests → boards through board_terms, with the words that matched; never a board you post in or hid; then the busiest, then the rest; logged out, the busiest', async () => {
  const fan = await newUser('bfan');
  await fan.put('/api/me/profile', { interests: { General: 'Thrifting', Music: 'My Chemical Romance, paramore!!', Movies: '', Television: 'BUFFY', Books: '', Heroes: '' } });
  const got = await getRows(fan, '/api/browse/boards');
  assert.equal(got.status, 200);
  assert.equal(got.data.hasInterests, true);
  const top = got.data.boards.slice(0, 3);
  // Music: two terms under its own field; Movies & TV: one under Television (its field); Fashion: one under General
  assert.deepEqual(top.map(o => [o.board.slug, o.because]), [['music', 'interests'], ['movies-tv', 'interests'], ['fashion', 'interests']]);
  assert.deepEqual(top[0].terms, [{ term: 'my chemical romance', field: 'Music' }, { term: 'paramore', field: 'Music' }]);
  assert.equal(top[0].why, 'Because you listed "my chemical romance" under Music');
  assert.equal(top[1].why, 'Because you listed "buffy" under Television');
  assert.equal(top[2].why, 'Because you listed "thrifting" under General');
  assert.deepEqual(Object.keys(top[0].board).sort(), ['description', 'icon', 'name', 'slug']);
  assert.equal(got.data.boards.length, 5);
  assert.ok(got.data.boards.slice(3).every(o => o.because !== 'interests' && o.why));
  assert.ok(got.rows > 0 && got.rows < 3000, `bounded: ${got.rows} rows`);

  // posting in a board, or hiding one, takes it off
  await fan.post('/api/boards/music/threads', { subject: 'mcr appreciation', body: 'that is all' });
  assert.equal((await fan.post('/api/browse/hidden/board/fashion')).status, 200);
  const after = (await fan.get('/api/browse/boards?limit=10')).data.boards;
  assert.deepEqual(after.slice(0, 1).map(o => o.board.slug), ['movies-tv']);
  assert.ok(!after.some(o => ['music', 'fashion'].includes(o.board.slug)));
  assert.equal(after.length, 10);
  assert.equal((await fan.get('/api/browse/boards?limit=2')).data.boards.length, 2);

  // no interests: the busiest this week (someone posted), then the quiet ones; logged out the same
  for (const who of [await newUser('bplain'), client()]) {
    const { boards, hasInterests } = (await who.get('/api/browse/boards?limit=10')).data;
    assert.equal(hasInterests, false);
    const kinds = boards.map(o => o.because);
    assert.ok(kinds[0] === 'busy' && kinds.every(k => k !== 'interests'), kinds.join());
    assert.equal(kinds.lastIndexOf('busy') + 1, kinds.indexOf('all') === -1 ? kinds.length : kinds.indexOf('all'), 'busy ones first');
    const busy = boards.filter(o => o.because === 'busy');
    assert.ok(busy.every((o, i) => o.posters >= 1 && (i === 0 || busy[i - 1].posters >= o.posters)), 'most people posting first');
    assert.match(busy[0].why, /^\d+ members? posted in .+ this week$/);
  }
});

test('browse, board terms: moderators add and remove them (logged), and they count at once', async () => {
  const mod = await moderator('termmod');
  const fan = await newUser('termfan');
  assert.equal((await fan.get('/api/admin/boards/pets/terms')).status, 403);
  const before = (await mod.get('/api/admin/boards/pets/terms')).data;
  assert.equal(before.board.slug, 'pets');
  assert.ok(before.terms.some(t => t.term === 'hamster'));
  assert.equal((await mod.put('/api/admin/boards/pets/terms', { add: ['one two three four'] })).status, 400, 'four words');
  assert.equal((await mod.put('/api/admin/boards/pets/terms', { add: [{ term: 'x', weight: 9 }] })).status, 400, 'weight');
  assert.equal((await mod.put('/api/admin/boards/nope/terms', { add: ['x'] })).status, 404);
  const saved = await mod.put('/api/admin/boards/pets/terms', { add: ['Axolotls!', { term: 'pond critters', weight: 2 }], remove: ['hamster'] });
  assert.equal(saved.status, 200);
  assert.ok(saved.data.terms.some(t => t.term === 'axolotls' && t.weight === 1));
  assert.ok(saved.data.terms.some(t => t.term === 'pond critters' && t.weight === 2));
  assert.ok(!saved.data.terms.some(t => t.term === 'hamster'));
  assert.equal(sql("SELECT COUNT(*) AS n FROM mod_log WHERE action = 'board_terms'")[0].n >= 1, true);
  await fan.put('/api/me/profile', { interests: { General: 'my axolotl', Music: '', Movies: '', Television: '', Books: '', Heroes: '' } });
  const [first] = (await fan.get('/api/browse/boards')).data.boards;
  assert.deepEqual([first.board.slug, first.why], ['pets', 'Because you listed "axolotl" under General']);
  await mod.put('/api/admin/boards/pets/terms', { add: ['hamster'], remove: ['axolotls', 'pond critters'] });
});

test('browse, discovery: open profiles\' recent posts and threads with a reason each; never private, blocked, banned, hidden, deleted, held photos, people I follow, boards I post in or what I hid; 2 per author and 4 per board a page; paging holds still', async () => {
  const me = await newUser('dme');
  await me.put('/api/me/profile', { interests: { General: 'kittens', Music: '', Movies: '', Television: '', Books: '', Heroes: '' } });
  const followed = await newUser('dfol'), pal = await newUser('dpal'), fof = await newUser('dfof');
  const author = await newUser('dauth'), author2 = await newUser('dautb'), author3 = await newUser('dautc');
  const priv = await newUser('dpriv'), blocker = await newUser('dblk'), banned = await newUser('dban'), holder = await newUser('dhold');
  const loud = await newUser('dloud'), muted = await newUser('dmute');
  const mod = await moderator('dmod');
  await me.post('/api/follows/' + followed.name);
  await befriend(me, pal);
  await pal.post('/api/follows/' + fof.name);
  await priv.put('/api/me/settings', { followPolicy: 'approve' });
  const status = async (who, body, media) => (await who.post('/api/status', { body, ...(media ? { media } : {}) })).data.id;
  const thread = async (who, board, subject) => (await who.post(`/api/boards/${board}/threads`, { subject, body: 'words' })).data.thread.id;

  const s1 = await status(author, 'just a status');
  await followed.post(`/api/posts/${s1}/replies`, { body: 'nice' });
  const s2 = await status(fof, 'friend of a friend');
  const s3 = await status(priv, 'private');
  const t0 = await thread(priv, 'random', 'a private member\'s thread');
  const s4 = await status(blocker, 'they blocked me');
  await blocker.post('/api/blocks/' + me.name);
  const s5 = await status(banned, 'about to be banned');
  await mod.post('/api/admin/users/' + banned.name, { banned: true });
  const s6 = await status(followed, 'someone I follow');
  const s7 = await status(me, 'my own');
  const s8 = await status(author2, 'hidden by a moderator');
  await mod.post('/api/admin/content', { type: 'post', id: s8, hidden: true });
  const s9 = await status(author2, 'deleted');
  await author2.del('/api/posts/' + s9);
  const m = await photo(holder);
  const s10 = await status(holder, 'a held photo', [m.id]);
  await mod.post(`/api/admin/media/${m.id}`, { action: 'hide' });
  const s11 = await status(author2, 'not interested in this one');
  const s12 = await status(muted, 'not interested in this person');
  const t1 = await thread(author, 'pets', 'my kitten');                                  // a board my interests point to
  await thread(me, 'cooking', 'my own thread');                                          // I post in Cooking
  const t2 = await thread(author3, 'cooking', 'in a board I post in');
  const t3 = await thread(author3, 'school', 'net -3');
  for (const v of [followed, pal, holder]) await v.put(`/api/posts/${t3}/vote`, { value: -1 });
  const t4 = await thread(author3, 'sports', 'in a board I hid');
  const louds = [await status(loud, 'one'), await status(loud, 'two'), await status(loud, 'three')];
  await me.post(`/api/browse/hidden/post/${s11}`);
  await me.post(`/api/browse/hidden/person/${muted.id}`);
  await me.post('/api/browse/hidden/board/sports');

  // every page: 20 at most, 2 per author, 4 per board, each with its reason; a post written after page 1 takes its own
  // place in the order (on a later page only if it scores below where page 1 ended) and moves nothing else
  const all = [];
  let next = null, fresh = null, rows = 0;
  for (let n = 0; n < 40; n++) {
    const r = await getRows(me, '/api/browse/discover' + (next ? '?before=' + encodeURIComponent(next) : ''));
    assert.equal(r.status, 200);
    rows = Math.max(rows, r.rows);
    const items = r.data.items;
    assert.ok(items.length <= 20);
    const count = key => items.reduce((acc, o) => acc.set(key(o), (acc.get(key(o)) || 0) + 1), new Map());
    assert.ok([...count(o => o.item.author.id).values()].every(k => k <= 2), 'two per author');
    assert.ok([...count(o => o.item.board && o.item.board.slug).entries()].every(([b, k]) => !b || k <= 4), 'four per board');
    for (const o of items) {
      assert.ok(['replied', 'friends', 'interest', 'popular'].includes(o.reason) && typeof o.why === 'string' && o.why.length > 5);
      assert.equal(o.relation.following, 'none');
    }
    all.push(...items);
    if (n === 0) fresh = await status(await newUser('dlate'), 'written after page 1');
    next = r.data.next;
    if (!next) break;
  }
  const ids = all.map(o => o.item.id);
  assert.equal(new Set(ids).size, ids.length, 'nothing twice');
  assert.ok(ids.filter(id => id === fresh).length <= 1);
  const of = id => all.find(o => o.item.id === id);
  assert.deepEqual([of(s1).reason, of(s1).why], ['replied', `Replied to by ${followed.name}, who you follow`]);
  assert.deepEqual([of(s2).reason, of(s2).why], ['friends', `Your friend ${pal.name} follows ${fof.name}`]);
  assert.deepEqual([of(t1).reason, of(t1).why], ['interest', 'Because you listed "kittens" under General']);
  assert.equal(of(t1).item.board.slug, 'pets', 'a thread carries its board (for "view board")');
  assert.ok(all.some(o => o.reason === 'popular' && /^Popular (on OurSpace this week|in .+)$/.test(o.why)));
  for (const id of louds) assert.ok(ids.includes(id), 'the third waits for the next page, it isn\'t lost');
  for (const [id, what] of [[s3, 'private'], [t0, 'a private member\'s thread'], [s4, 'blocked'], [s5, 'banned'], [s6, 'followed'], [s7, 'mine'], [s8, 'hidden'],
    [s9, 'deleted'], [s10, 'held photo'], [s11, 'hidden post'], [s12, 'hidden person'], [t2, 'a board I post in'], [t3, 'net -3'], [t4, 'a board I hid']]) {
    assert.ok(!ids.includes(id), what);
  }
  assert.ok(rows > 0 && rows <= 2000, `bounded: ${rows} rows`);

  // logged out: everybody's open posts (a block of mine doesn't count), still never private, banned or held
  const out = [];
  next = null;
  for (let n = 0; n < 40; n++) {
    const r = (await client().get('/api/browse/discover' + (next ? '?before=' + encodeURIComponent(next) : ''))).data;
    out.push(...r.items);
    next = r.next;
    if (!next) break;
  }
  const outIds = out.map(o => o.item.id);
  assert.ok([s1, s4, s6, s7, t2].every(id => outIds.includes(id)));
  assert.ok([s3, t0, s5, s8, s9, s10].every(id => !outIds.includes(id)));
  assert.ok(out.every(o => o.relation === null && o.reason === 'popular'));
  assert.equal((await client().get('/api/browse/discover?before=junk')).status, 400);
});

test('browse, "not interested": person, board or post, only things that exist, never yourself, members only', async () => {
  const me = await newUser('hide');
  assert.equal((await client().post(`/api/browse/hidden/person/${me.id}`)).status, 401);
  assert.equal((await me.post(`/api/browse/hidden/person/${me.id}`)).status, 404, 'yourself');
  assert.equal((await me.post('/api/browse/hidden/person/999999999')).status, 404);
  assert.equal((await me.post('/api/browse/hidden/board/no-such-board')).status, 404);
  assert.equal((await me.post('/api/browse/hidden/post/abc')).status, 404);
  assert.equal((await me.post('/api/browse/hidden/thing/1')).status, 404);
  const r = await me.post('/api/browse/hidden/board/Random');
  assert.equal(r.data.hidden.kind, 'board');
  assert.equal((await me.post('/api/browse/hidden/board/random')).status, 200, 'twice is fine');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM browse_hidden WHERE user_id = ${me.id}`)[0].n, 1);
  assert.deepEqual((await me.del('/api/browse/hidden/board/random')).data, { hidden: null });
  assert.equal(sql(`SELECT COUNT(*) AS n FROM browse_hidden WHERE user_id = ${me.id}`)[0].n, 0);
});

test('browse, "not interested" in a post: any id, one answer, so it never tells whether a private or hidden post exists; the daily limit counts before anything is looked up', async () => {
  const me = await newUser('hidp'), shy = await newUser('hidshy'), mod = await moderator('hidmod');
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const secret = (await shy.post('/api/status', { body: 'for my followers' })).data.id;
  const open = (await mod.post('/api/status', { body: 'about to be hidden' })).data.id;
  await mod.post('/api/admin/content', { type: 'post', id: open, hidden: true });
  const missing = Number(sql('SELECT MAX(id) AS m FROM posts')[0].m) + 1000;
  const answers = [];
  for (const id of [secret, open, missing]) {
    const r = await me.post(`/api/browse/hidden/post/${id}`);
    answers.push([r.status, r.data]);
  }
  assert.deepEqual(answers, [secret, open, missing].map(id => [200, { hidden: { kind: 'post', id } }]), 'private, hidden and missing all look alike');
  const tries = () => sql(`SELECT COUNT(*) AS n FROM attempts WHERE k = 'hide:${me.id}'`)[0].n;
  const before = tries();
  assert.equal((await me.post('/api/browse/hidden/person/999999999')).status, 404);
  assert.equal((await me.post('/api/browse/hidden/board/no-such-board')).status, 404);
  assert.equal(tries(), before + 2, 'a miss counts against the 300 a day too');
});

test('browse: every answer that depends on who is asking is no-store, so a browser never shows one account\'s page to the next', async () => {
  const me = await newUser('nostore');
  const routes = ['/api/me', '/api/me/account', '/api/me/bookmarks', '/api/astro/me', '/api/users', `/api/users/${me.name}`, `/api/users/${me.name}/followers`,
    '/api/feed', '/api/notifications', '/api/requests', '/api/chats', '/api/chats/suggestions', '/api/blocks', '/api/boards', '/api/boards/random',
    '/api/browse/discover', '/api/browse/mutuals', '/api/browse/people?limit=3', '/api/browse/boards'];
  for (const url of routes) {
    for (const who of [me, client()]) {
      const res = await who.raw('GET', url);
      if (res.status === 200) assert.equal(res.headers.get('cache-control'), 'no-store', `${url} (${who === me ? 'member' : 'logged out'})`);
      await res.arrayBuffer();
    }
  }
});

test('browse: For you, Mutuals and Who to follow are rate limited per member (60 a minute)', async () => {
  const me = await newUser('busy');
  const got = [];
  for (let i = 0; i < 61; i++) got.push((await me.get('/api/browse/people?limit=1')).status);
  assert.deepEqual([got.slice(0, 60).every(s => s === 200), got[60]], [true, 429]);
  assert.equal((await me.get('/api/browse/discover')).status, 200, 'each route counts on its own');
});

test('browse, the 18 line: For you and Who to follow never put an adult and a 13–17-year-old in front of each other; logged out, adults only', async () => {
  const adult = await newUser('agead'), teen = await newUser('ageteen', { birthday: ageYearsAgo(15) }), teen2 = await newUser('ageteenb', { birthday: ageYearsAgo(16) });
  const grown = await newUser('agegrown');
  const t = (await teen2.post('/api/status', { body: 'a teen writes' })).data.id;
  const g = (await grown.post('/api/status', { body: 'an adult writes' })).data.id;
  const all = async who => {
    const ids = [];
    let next = null;
    for (let n = 0; n < 30; n++) {
      const r = (await who.get('/api/browse/discover' + (next ? '?before=' + encodeURIComponent(next) : ''))).data;
      ids.push(...r.items.map(o => o.item.id));
      if (!(next = r.next)) break;
    }
    return ids;
  };
  const seenByAdult = await all(adult), seenByTeen = await all(teen), seenLoggedOut = await all(client());
  assert.ok(seenByAdult.includes(g) && !seenByAdult.includes(t), 'an adult: adults only');
  assert.ok(seenByTeen.includes(t) && !seenByTeen.includes(g), 'a teen: teens only');
  assert.ok(seenLoggedOut.includes(g) && !seenLoggedOut.includes(t), 'logged out: adults only');
  const people = (await client().get('/api/browse/people?limit=10')).data.people.map(o => o.user.id);
  assert.ok(![teen.id, teen2.id].some(id => people.includes(id)), 'Who to follow, logged out: adults only');
  const teenPeople = (await teen.get('/api/browse/people?limit=10')).data.people.map(o => o.user.id);
  assert.ok(!teenPeople.includes(adult.id) && !teenPeople.includes(grown.id), 'a teen is never suggested an adult');
});

test('browse, the row budget under floods: every route stays under 2,000 rows read whatever one account piles up, and one account can\'t fill For you', async () => {
  const me = await newUser('flme'), loud = await newUser('flloud'), pal = await newUser('flpal'), shy = await newUser('flshy'), spam = await newUser('flspam');
  await me.post('/api/follows/' + loud.name);
  await befriend(me, pal);
  await shy.put('/api/me/settings', { followPolicy: 'approve' });
  const target = (await pal.post('/api/status', { body: 'reply to me' })).data.id;
  const now = Date.now();
  const many = (n, select) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) ${select}`;
  const budget = async stage => {
    const out = {};
    for (const [who, url] of [[me, '/api/browse/discover'], [client(), '/api/browse/discover'], [me, '/api/browse/mutuals'], [me, '/api/browse/people?limit=10'],
      [client(), '/api/browse/people?limit=10'], [me, '/api/browse/boards']]) {
      const r = await getRows(who, url);
      assert.equal(r.status, 200, `${stage}: ${url}`);
      assert.ok(r.rows > 0 && r.rows <= 2000, `${stage}: ${url} read ${r.rows} rows`);
      out[url + (who === me ? '' : ' (logged out)')] = r.rows;
    }
    return out;
  };
  await budget('before');
  try {
    // 10,000 replies this week by somebody I follow
    sql(many(10000, `INSERT INTO posts (kind, author_id, body, created, reply_to, root_id) SELECT 'reply', ${loud.id}, 'r' || i, ${now} - i * 1000, ${target}, ${target} FROM n`));
    await budget('10k replies by a followee');
    // 10,000 statuses this week by a private profile
    sql(many(10000, `INSERT INTO posts (kind, author_id, body, created) SELECT 'status', ${shy.id}, 'p' || i, ${now} - i * 1000 FROM n`));
    await budget('10k private statuses');
    // a friend of mine follows 10,000 people one way, then they all follow back: 10,000 friends of a friend
    sql(many(10000, `INSERT INTO users (name, name_key, email, avatar, birthdate, created) SELECT 'flbot' || i, 'flbot${now}_' || i, 'flbot${now}_' || i || '@example.com', '/assets/avatars/pic_cd_rainbow.gif', '1990-01-01', ${now} FROM n`));
    sql(`INSERT INTO follows (follower_id, followee_id, status, created, accepted) SELECT ${pal.id}, id, 'accepted', ${now}, ${now} FROM users WHERE name_key LIKE 'flbot${now}_%'`);
    await budget('a friend follows 10k one way');
    sql(`INSERT INTO follows (follower_id, followee_id, status, created, accepted) SELECT id, ${pal.id}, 'accepted', ${now}, ${now} FROM users WHERE name_key LIKE 'flbot${now}_%'`);
    await budget('10k friends of a friend');
    const fof = (await me.get('/api/browse/mutuals')).data.people;
    assert.ok(fof.length > 0 && fof.every(o => o.mutual.people.some(p => p.id === pal.id)), 'Mutuals still works: through the friend, their newest few');
    // one account posts 300 statuses today (the daily limit): it takes 3 places among the candidates, 2 on a page
    sql(many(300, `INSERT INTO posts (kind, author_id, body, created) SELECT 'status', ${spam.id}, 'buy followers ' || i, ${now} - i * 200000 FROM n`));
    await budget('300 statuses by one account');
    for (const who of [me, client()]) {
      const first = (await who.get('/api/browse/discover')).data.items;
      assert.ok(first.filter(o => o.item.author.id === spam.id).length <= 2, 'two a page');
      assert.ok(new Set(first.map(o => o.item.author.id)).size >= 5, `page 1 keeps its variety: ${first.length} items`);
      let next = (await who.get('/api/browse/discover')).data.next, theirs = first.filter(o => o.item.author.id === spam.id).length;
      for (let n = 0; next && n < 30; n++) {
        const r = (await who.get('/api/browse/discover?before=' + encodeURIComponent(next))).data;
        theirs += r.items.filter(o => o.item.author.id === spam.id).length;
        next = r.next;
      }
      assert.ok(theirs <= 3, `3 candidates at most, on every page together: ${theirs}`);
    }
  } finally {
    sql(`DELETE FROM posts WHERE author_id IN (${loud.id}, ${shy.id}, ${spam.id})`);
    sql(`DELETE FROM follows WHERE follower_id IN (SELECT id FROM users WHERE name_key LIKE 'flbot${now}_%') OR followee_id IN (SELECT id FROM users WHERE name_key LIKE 'flbot${now}_%')`);
    sql(`DELETE FROM users WHERE name_key LIKE 'flbot${now}_%'`);
  }
});

test('every photo row has its file in the bucket, and every file in the bucket its row, after everything the tests above did', async () => {
  const rows = new Set(sql('SELECT key FROM media').map(r => r.key));
  const files = await bucket();
  assert.deepEqual([...files].filter(k => !rows.has(k)), [], 'no file left behind');
  assert.deepEqual([...rows].filter(k => !files.has(k)), [], 'no row without its file');
  assert.deepEqual(sql(`SELECT post_id, COUNT(*) AS n FROM media m JOIN posts p ON p.id = m.post_id WHERE m.purpose = 'post'
    GROUP BY post_id HAVING n > CASE p.kind WHEN 'comment' THEN 1 ELSE 4 END`), [], 'no post over its limit');
  assert.deepEqual(sql(`SELECT id FROM media WHERE (purpose = 'avatar' AND attached IS NOT NULL AND hidden = 0
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.avatar = '/media/' || key))
    OR (post_id IS NOT NULL AND EXISTS (SELECT 1 FROM posts p WHERE p.id = post_id AND p.deleted = 1))`), [], 'pictures in use, no photos on tombstones');
});

test('every count and stored sort key in the database matches the rows behind it, after everything the tests above did', () => {
  assert.deepEqual(sql(`SELECT id, kind, like_count, reply_count, repost_count, quote_count, up_count, down_count, comment_count FROM posts p WHERE
    like_count != (SELECT COUNT(*) FROM likes WHERE post_id = p.id)
    OR up_count != (SELECT COUNT(*) FROM votes WHERE post_id = p.id AND value = 1)
    OR down_count != (SELECT COUNT(*) FROM votes WHERE post_id = p.id AND value = -1)
    OR comment_count != (SELECT COUNT(*) FROM posts x WHERE x.root_id = p.id AND x.kind = 'comment' AND x.deleted = 0)
    OR reply_count != (SELECT COUNT(*) FROM posts x WHERE x.reply_to = p.id AND x.kind IN ('reply', 'comment') AND x.deleted = 0)
    OR repost_count != (SELECT COUNT(*) FROM posts x WHERE x.quote_of = p.id AND x.kind = 'repost')
    OR quote_count != (SELECT COUNT(*) FROM posts x WHERE x.quote_of = p.id AND x.kind = 'quote' AND x.deleted = 0)`), []);
  // the stored sort keys of every thread and comment are what src/shared/ranking.js makes of its counts (the SQL that
  // stored them, checked against the unit-tested JS)
  const keyed = sql(`SELECT id, kind, up_count AS up, down_count AS down, created, hot, best, score,
    (SELECT COUNT(*) FROM posts c WHERE c.root_id = p.id AND c.kind = 'comment' AND c.deleted = 0 AND c.author_id != p.author_id) AS others
    FROM posts p WHERE kind IN ('thread', 'comment')`);
  assert.ok(keyed.filter(r => r.up + r.down > 0).length >= 2, 'the tests above left votes');
  const off = keyed.filter(r => r.score !== r.up - r.down || Math.abs(r.best - wilson(r.up, r.down)) > 1e-12
    || Math.abs(r.hot - (r.kind === 'thread' ? hot(r.up, r.down, r.others, r.created) : 0)) > 1e-9);
  assert.deepEqual(off, []);
  assert.deepEqual(orphans(), [], 'every comment\'s thread is there, and so is what it answers');
});

test('the photo review queue: moderators only, newest first, where each photo is, marked reviewed once, and paged', async () => {
  const me = await newUser('shutter');
  const other = await newUser('looker');
  const mod = await moderator('reviewer');
  assert.equal((await client().get('/api/admin/media')).status, 401);
  assert.equal((await other.get('/api/admin/media')).status, 403, 'moderators only');
  assert.equal((await other.post('/api/admin/media/1', { action: 'reviewed' })).status, 403);
  const loose = await photo(me);
  const p1 = await photo(me), p2 = await photo(me);
  const s = await me.post('/api/status', { body: 'new snaps', media: [p1.id] });
  const t = await me.post('/api/boards/pets/threads', { subject: 'the cat', body: 'look', media: [p2.id] });
  assert.equal(s.status, 201);
  const q = (await mod.get('/api/admin/media')).data;
  const ids = q.media.map(m => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
  const row = id => q.media.find(m => m.id === id);
  assert.ok(ids.includes(loose.id) && ids.includes(p1.id) && ids.includes(p2.id), 'attached and loose alike');
  assert.deepEqual([row(loose.id).where, row(p1.id).where.type, row(p1.id).where.id, row(p1.id).where.author], [null, 'post', s.data.id, me.name]);
  assert.deepEqual([row(p2.id).where.type, row(p2.id).where.board, row(p2.id).where.thread], ['thread', 'pets', t.data.thread.id]);
  const m1 = row(p1.id);
  assert.deepEqual([m1.url, m1.reviewed, m1.reviewedAt, m1.hidden, m1.uploader.name, m1.purpose, m1.width], [p1.url, false, null, false, me.name, 'post', 40]);
  assert.ok(m1.uploader.created > 0 && m1.created > 0, 'the account\'s and the upload\'s times');
  // marking one reviewed: who and when kept, the first time stays, it leaves the unreviewed view
  assert.equal((await mod.post('/api/admin/media/999999', { action: 'reviewed' })).status, 404);
  assert.deepEqual((await mod.post(`/api/admin/media/${p1.id}`, { action: 'reviewed' })).data, { ok: true });
  const first = sql(`SELECT reviewed_by, reviewed_at FROM media WHERE id = ${p1.id}`)[0];
  assert.equal(first.reviewed_by, mod.id);
  const mod2 = await moderator('reviewer2');
  assert.equal((await mod2.post(`/api/admin/media/${p1.id}`, { action: 'reviewed' })).status, 200);
  assert.deepEqual(sql(`SELECT reviewed_by, reviewed_at FROM media WHERE id = ${p1.id}`)[0], first, 'marking twice keeps the first');
  assert.ok(!(await mod.get('/api/admin/media?filter=unreviewed')).data.media.some(m => m.id === p1.id));
  const all = (await mod.get('/api/admin/media?filter=all')).data.media.find(m => m.id === p1.id);
  assert.deepEqual([all.reviewed, all.reviewedBy, all.reviewedAt], [true, mod.name, first.reviewed_at]);
  // paging: `before` is the last id of the page before; `next` is null when there is no more
  const page = (await mod.get(`/api/admin/media?filter=all&before=${p2.id}`)).data;
  assert.ok(page.media.every(m => m.id < p2.id));
  const total = sql('SELECT COUNT(*) AS n FROM media')[0].n;
  const full = (await mod.get('/api/admin/media?filter=all')).data;
  assert.equal(full.media.length, Math.min(30, total));
  assert.equal(full.next, total > 30 ? full.media[full.media.length - 1].id : null);
  // hide and remove still work, from the same list; a held photo whose post is gone still lists
  await mod.post(`/api/admin/media/${p2.id}`, { action: 'hide' });
  assert.equal((await mod.get('/api/admin/media')).data.media.find(m => m.id === p2.id).hidden, true);
  await me.del('/api/posts/' + t.data.thread.id);
  assert.equal((await mod.get('/api/admin/media')).data.media.find(m => m.id === p2.id).where.type, 'gone');
  await mod.post(`/api/admin/media/${p2.id}`, { action: 'remove' });
  assert.ok(!(await mod.get('/api/admin/media')).data.media.some(m => m.id === p2.id));
});

test('a child-safety (csam) report holds the post\'s photos at once, comes first in the queue and starts a 48-hour clock', async () => {
  const author = await newUser('poster');
  const rep = await newUser('flagger');
  const mod = await moderator('guardian');
  assert.ok((await client().get('/api/options')).data.reportReasons.some(r => r.v === 'csam'), 'a reason to pick');
  const a = await photo(author), b = await photo(author);
  const old = await author.post('/api/status', { body: 'an ordinary post', media: [b.id] });
  const s = await author.post('/api/status', { body: 'flagged', media: [a.id] });
  // an older, ordinary report: the csam one still goes above it
  assert.equal((await rep.post('/api/reports', { type: 'post', id: old.data.id, reason: 'spam' })).status, 201);
  assert.equal((await fetchMedia(client(), a.url)).status, 200);
  assert.equal((await rep.post('/api/reports', { type: 'post', id: s.data.id, reason: 'csam' })).status, 201);
  assert.equal(sql(`SELECT hidden FROM media WHERE id = ${a.id}`)[0].hidden, 1, 'held');
  assert.equal(sql(`SELECT hidden FROM media WHERE id = ${b.id}`)[0].hidden, 0, 'other reasons hold nothing');
  assert.equal((await fetchMedia(client(), a.url)).status, 404, 'the public');
  assert.equal((await fetchMedia(author, a.url)).status, 404, 'its author');
  assert.equal((await fetchMedia(rep, a.url)).status, 404, 'the reporter');
  assert.equal((await fetchMedia(mod, a.url)).status, 200, 'moderators');
  assert.equal((await fetchMedia(client(), b.url)).status, 200, 'an ordinary report leaves the photos');
  // it survives the author deleting the post
  assert.equal((await author.del('/api/posts/' + s.data.id)).status, 200);
  assert.ok((await bucket()).has(keyOf(a.url)), 'still in storage');
  assert.equal((await fetchMedia(mod, a.url)).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM media WHERE id = ${a.id}`)[0].n, 1);
  // the queue: csam first, with the clock; ordinary reports have none
  const list = (await mod.get('/api/admin/reports')).data.reports;
  assert.equal(list[0].reason, 'csam');
  const spam = list.find(r => r.targetId === old.data.id && r.reason === 'spam');
  assert.ok(list.indexOf(spam) > 0);
  assert.equal(list[0].deadline, list[0].created + 48 * 3600000);
  assert.equal(spam.deadline, null, 'no clock for ordinary reports');
  assert.deepEqual(list[0].snapshot.media.map(m => m.id), [a.id], 'its photos are on the report');
  // a moderator marking "intimate image without consent" starts the same clock on any open post report
  assert.equal((await rep.post(`/api/admin/reports/${spam.id}`, { action: 'intimate' })).status, 403);
  assert.deepEqual((await mod.post(`/api/admin/reports/${spam.id}`, { action: 'intimate' })).data, { ok: true });
  const marked = (await mod.get('/api/admin/reports')).data.reports.find(r => r.id === spam.id);
  assert.deepEqual([marked.intimate, marked.status, marked.deadline], [true, 'open', spam.created + 48 * 3600000]);
  // the moderator finishes it: remove the held photo
  assert.equal((await mod.post(`/api/admin/media/${a.id}`, { action: 'remove', note: 'NCMEC report filed' })).status, 200);
  assert.ok(!(await bucket()).has(keyOf(a.url)));
});

/* ---------------------------------------------------- live chat: groups, DMs, #ourspace, the interaction score */

const chatOf = async (owner, names, title) => {
  const r = await owner.post('/api/chats', { members: names.map(p => p.name), ...(title ? { title } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.chat;
};
const say = async (who, chat, body) => {
  const r = await who.post(`/api/chats/${chat}/messages`, { body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.message;
};
const bodies = async (who, chat, q = '') => (await who.get(`/api/chats/${chat}/messages${q}`)).data.messages.map(m => m.body);

test('groups: friends join at once, anybody else is invited and sees nothing until they accept', async () => {
  const o = await newUser('grp_owner'); const f1 = await newUser('grp_f1'); const f2 = await newUser('grp_f2');
  const s = await newUser('grp_stranger'); const p = await newUser('grp_picky'); const k = await newUser('grp_blocker');
  await befriend(o, f1); await befriend(o, f2);
  await p.put('/api/me/settings', { dmPolicy: 'friends' });
  await k.post('/api/blocks/' + o.name);
  assert.equal((await o.post('/api/chats', { members: [p.name] })).status, 403, 'a non-friend who only takes messages from friends');
  assert.equal((await o.post('/api/chats', { members: [k.name] })).status, 404, 'someone who blocked me');
  assert.equal((await o.post('/api/chats', { members: ['nobody_by_this_name'] })).status, 404);
  assert.equal((await o.post('/api/chats', { members: [o.name] })).status, 400, 'a group needs someone else');
  assert.equal((await o.post('/api/chats', { members: Array.from({ length: 51 }, (_, i) => 'x' + i) })).status, 400, '50 at most');

  const g = await chatOf(o, [f1, s], 'the crew');
  assert.deepEqual([g.kind, g.title, g.role, g.status, g.memberCount, g.owner.name], ['group', 'the crew', 'owner', 'joined', 2, o.name]);
  assert.deepEqual([g.members.map(m => m.name), g.invited.map(m => m.name)], [[f1.name], [s.name]]);
  await say(o, g.id, 'hello crew');
  const invite = (await s.get('/api/chats')).data.items.find(i => i.id === g.id);
  assert.deepEqual([invite.status, invite.invitedBy.name, invite.members, invite.lastMessage, invite.unread, invite.memberCount],
    ['invited', o.name, [], null, 0, 2], 'an invite shows who asked and how many are in it, nothing else');
  assert.equal((await s.get(`/api/chats/${g.id}/messages`)).status, 403);
  assert.equal((await s.post(`/api/chats/${g.id}/messages`, { body: 'hi?' })).status, 403);
  assert.equal((await s.get('/api/me')).data.counts.unread, 0, 'an invite isn\'t an unread conversation');
  const told = (await s.get('/api/notifications')).data.items.find(n => n.kind === 'group_invite');
  assert.deepEqual([told.actor.name, told.chat], [o.name, { id: g.id, title: 'the crew' }]);
  assert.equal((await f1.get('/api/me')).data.counts.unread, 1, 'a friend is in at once');
  assert.deepEqual(await bodies(f1, g.id), ['hello crew']);

  const accepted = await s.post(`/api/chats/${g.id}/invite`, { action: 'accept' });
  assert.deepEqual([accepted.data.chat.status, accepted.data.chat.memberCount], ['joined', 3]);
  assert.deepEqual(await bodies(s, g.id), ['hello crew'], 'the history is there once you\'re in');
  assert.equal((await s.get('/api/me')).data.counts.unread, 0, 'and counts as read');
  assert.equal((await s.post(`/api/chats/${g.id}/invite`, { action: 'accept' })).status, 409);

  // the owner renames, adds and removes; nobody else may
  assert.equal((await f1.put(`/api/chats/${g.id}`, { title: 'mine now' })).status, 403);
  assert.equal((await o.put(`/api/chats/${g.id}`, { title: 'the crew 2' })).data.chat.title, 'the crew 2');
  assert.equal((await f1.post(`/api/chats/${g.id}/members`, { names: [f2.name] })).status, 403);
  const added = await o.post(`/api/chats/${g.id}/members`, { names: [f2.name] });
  assert.ok(added.data.chat.members.some(m => m.name === f2.name), 'a friend joins at once');
  assert.equal((await o.post(`/api/chats/${g.id}/members`, { names: [f2.name] })).status, 400, 'already in it');
  assert.equal((await f1.del(`/api/chats/${g.id}/members/${s.name}`)).status, 403);
  const removed = await o.del(`/api/chats/${g.id}/members/${s.name}`);
  assert.ok(!removed.data.chat.members.some(m => m.name === s.name));
  assert.equal((await s.get(`/api/chats/${g.id}/messages`)).status, 404, 'removed: nothing to see');
  assert.equal((await o.del(`/api/chats/${g.id}/members/${s.name}`)).status, 404);
  assert.equal((await o.del(`/api/chats/${g.id}/members/${o.name}`)).status, 400, 'the owner leaves instead');

  // invited again, and declining
  await o.post(`/api/chats/${g.id}/members`, { names: [s.name] });
  assert.equal((await s.get('/api/chats')).data.items.find(i => i.id === g.id).status, 'invited');
  assert.deepEqual((await s.post(`/api/chats/${g.id}/invite`, { action: 'decline' })).data, { ok: true });
  assert.ok(!(await s.get('/api/chats')).data.items.some(i => i.id === g.id));
  assert.ok(!(await s.get('/api/notifications')).data.items.some(n => n.kind === 'group_invite' && n.chat.id === g.id), 'nor its invites');
  assert.equal((await s.post(`/api/chats/${g.id}/invite`, { action: 'accept' })).status, 404, 'declined is declined');

  // the owner leaves: the member there longest takes over
  assert.deepEqual((await o.post(`/api/chats/${g.id}/leave`)).data, { ok: true });
  const after = (await f1.get(`/api/chats/${g.id}`)).data.chat;
  assert.deepEqual([after.role, after.owner.name, after.memberCount], ['owner', f1.name, 2]);
  assert.equal((await o.get(`/api/chats/${g.id}/messages`)).status, 404);
  assert.equal((await o.post(`/api/chats/${g.id}/leave`)).status, 404);
  assert.equal((await f2.get(`/api/chats/${g.id}`)).data.chat.role, 'member');
  assert.equal((await f1.put(`/api/chats/${g.id}`, { title: '' })).data.chat.title, null, 'the new owner may rename it');
});

test('groups: 50 people at most, 10 new groups a day', async () => {
  const o = await newUser('grp_many'); const f = await newUser('grp_pal');
  await befriend(o, f);
  for (let i = 0; i < 10; i++) await chatOf(o, [f]);
  assert.equal((await o.post('/api/chats', { members: [f.name] })).status, 429);
  // the 50 is the database's own rule (migrations test), so two adds at once can't both squeeze in
  const g = (await f.post('/api/chats', { members: [o.name] })).data.chat;
  const tag = uniq();
  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 48)
    INSERT INTO users (name, name_key, avatar, birthdate, created) SELECT 'filler_${tag}_' || i, 'filler_${tag}_' || i, '/a.png', '1990-01-01', 1 FROM n`);
  sql(`INSERT INTO conversation_members (conversation_id, user_id, status, joined) SELECT ${g.id}, id, 'joined', 1 FROM users
    WHERE name_key LIKE 'filler_${tag}_%'`);
  assert.equal((await f.get(`/api/chats/${g.id}`)).data.chat.memberCount, 50);
  const extra = await newUser('grp_51');
  await befriend(f, extra);
  assert.equal((await f.post(`/api/chats/${g.id}/members`, { names: [extra.name] })).status, 409);
});

test('a block inside a group: the two don\'t see each other\'s messages, in reads, unread counts and the list', async () => {
  const x = await newUser('gb_x'); const y = await newUser('gb_y'); const z = await newUser('gb_z');
  await befriend(x, y); await befriend(x, z);
  const g = await chatOf(x, [y, z]);
  await z.post('/api/blocks/' + y.name);
  await say(y, g.id, 'from y');
  await say(x, g.id, 'from x');
  await say(z, g.id, 'from z');
  assert.deepEqual(await bodies(x, g.id), ['from y', 'from x', 'from z']);
  assert.deepEqual(await bodies(y, g.id), ['from y', 'from x']);
  assert.deepEqual(await bodies(z, g.id), ['from x', 'from z']);
  const yChat = (await y.get('/api/chats')).data.items.find(i => i.id === g.id);
  assert.deepEqual([yChat.members.map(m => m.name), yChat.unread, yChat.lastMessage.body], [[x.name], 1, 'from x']);
  assert.equal(yChat.memberCount, 3, 'they are still in it');
  assert.equal((await x.get(`/api/chats/${g.id}`)).data.chat.unread, 1, 'z\'s (writing marked y\'s, before it, read)');
  // older pages: 50 a page, oldest first, `next` going back
  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
    INSERT INTO chat_messages (conversation_id, author_id, body, created) SELECT ${g.id}, ${x.id}, 'old ' || i, 1000 + i FROM n`);
  const first = (await x.get(`/api/chats/${g.id}/messages`)).data;
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages.at(-1).body, 'old 60', 'the newest ids last (ids, not times, order a conversation)');
  const second = (await x.get(`/api/chats/${g.id}/messages?before=${first.next}`)).data;
  assert.deepEqual([second.messages.length, second.next], [13, null]);
  const caught = (await x.get(`/api/chats/${g.id}/messages?after=${second.messages[2].id}`)).data;
  assert.deepEqual([caught.messages.length, caught.messages[0].body, caught.next], [60, 'old 1', null], 'after= catches up, oldest first');
});

test('group suggestions: friends by closeness, then people I talk to who aren\'t friends yet; never blocked people', async () => {
  const m = await newUser('sg_me');
  const [f1, f2, f3, f4, n1, n2, n3, bl] = await Promise.all(['sg_fa', 'sg_fb', 'sg_fc', 'sg_fd', 'sg_na', 'sg_nb', 'sg_nc', 'sg_bl'].map(p => newUser(p)));
  for (const f of [f1, f2, f3, f4]) await befriend(m, f);
  await n3.put('/api/me/settings', { dmPolicy: 'friends' });
  const now = Date.now(), DAY = 86400000;
  sql(`INSERT INTO affinity (from_id, to_id, eff, updated) VALUES
    (${m.id}, ${f1.id}, 4, ${now}),
    (${m.id}, ${f2.id}, 5, ${now}), (${f2.id}, ${m.id}, 5, ${now}),
    (${m.id}, ${f4.id}, 8, ${now - 60 * DAY}),
    (${m.id}, ${n1.id}, 3, ${now}), (${n1.id}, ${m.id}, 1, ${now}),
    (${n2.id}, ${m.id}, 9, ${now}),
    (${m.id}, ${n3.id}, 6, ${now}),
    (${m.id}, ${bl.id}, 7, ${now})`);
  await m.post('/api/blocks/' + bl.name);
  // closeness = eff + min(eff, back): f2 5 + 5 = 10; f1 4 + 0; f4 8 halved twice in 60 days = 2; f3 nothing; n1 3 + 1;
  // n2 only wrote to me (0: a stranger's attention doesn't count); n3 takes messages from friends only; bl is blocked
  const r = await m.get('/api/chats/suggestions');
  assert.deepEqual(r.data.people.map(p => p.name), [f2.name, f1.name, f4.name, f3.name, n1.name]);
  assert.deepEqual(r.data.people.map(p => p.friend), [true, true, true, true, false]);
  assert.equal(typeof r.data.people[0].online, 'boolean');
  assert.deepEqual((await m.get('/api/chats/suggestions?q=' + f4.name.slice(3).toUpperCase())).data.people.map(p => p.name), [f4.name], 'q filters by name');
  assert.deepEqual((await n2.get('/api/chats/suggestions')).data.people.map(p => p.name), [m.name], 'while to n2, who talks to me, I\'m someone they talk to');
});

test('the interaction score moves with replies, likes, reposts, mentions, Friends\' Comments, DMs and small groups (once each)', async () => {
  const a = await newUser('af_a'); const b = await newUser('af_b'); const c = await newUser('af_c');
  await befriend(a, b); await befriend(a, c);
  const score = (x, y) => {
    const r = sql(`SELECT eff FROM affinity WHERE from_id = ${x.id} AND to_id = ${y.id}`)[0];
    return r ? Math.round(r.eff * 100) / 100 : 0;
  };
  const st = (await b.post('/api/status', { body: 'hello' })).data.id;
  await a.post(`/api/posts/${st}/replies`, { body: 'hi b' });
  assert.equal(score(a, b), 3, 'a reply: 3');
  await a.post(`/api/posts/${st}/like`);
  await a.post(`/api/posts/${st}/like`);
  assert.equal(score(a, b), 4, 'a like: 1, once');
  await a.post(`/api/posts/${st}/repost`);
  assert.equal(score(a, b), 5, 'a repost: 1');
  await a.post('/api/status', { body: `hey @${c.name}` });
  assert.equal(score(a, c), 2, 'a mention: 2');
  await a.post(`/api/users/${c.name}/comments`, { body: 'nice page' });
  assert.equal(score(a, c), 5, 'a Friends\' Comment: 3');
  await say(a, await dmOf(a, b), 'psst');
  assert.equal(score(a, b), 7, 'a DM: 2');
  const g = await chatOf(a, [b, c]);
  await say(a, g.id, 'hi both');
  assert.deepEqual([score(a, b), score(a, c)], [7.5, 5.5], 'a group message: 0.5 to each member');
  assert.equal(score(b, a), 0, 'what a did tells nothing about b');
  assert.ok(sql(`SELECT updated FROM affinity WHERE from_id = ${a.id} AND to_id = ${b.id}`)[0].updated > Date.now() - 60000);
});

// cookie header for a client's session
const cookieOf = c => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

// A WebSocket to a room, as a page opens it (our Origin, the session cookie). `next(test)` waits for the first event
// that passes it (and takes it off the list).
function live(c, room) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/live/${room}`, { headers: { Cookie: cookieOf(c), Origin: BASE } });
  const events = [];
  let wake = () => {};
  ws.addEventListener('message', e => { events.push(JSON.parse(e.data)); wake(); });
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('the socket was refused')));
  });
  // the close code: from the close itself, or from the { type: 'bye', code } frame that comes just before it (in wrangler
  // dev a close made by an RPC reaches the client seconds late; the page stops on the frame, src/live/room.js)
  const closed = new Promise(res => {
    ws.addEventListener('close', e => res(e.code));
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'bye') res(m.code); });
  });
  async function next(ok, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = events.findIndex(ok);
      if (i >= 0) return events.splice(i, 1)[0];
      if (Date.now() > end) throw new Error('no such event; got ' + JSON.stringify(events));
      await new Promise(r => { wake = r; setTimeout(r, 50); });
    }
  }
  return { ws, events, opened, closed, next, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)), close: () => ws.close() };
}

// the status a WebSocket upgrade gets (101 when it's let through)
function upgrade(c, room, origin = BASE) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/live/' + room, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      ...(c ? { Cookie: cookieOf(c) } : {}), ...(origin ? { Origin: origin } : {}) } });
    req.on('response', r => { r.resume(); res(r.statusCode); });
    req.on('upgrade', (r, sock) => { sock.destroy(); res(101); });
    req.on('error', rej);
    req.end();
  });
}

test('live: two members get each other\'s messages in order, typing, presence and reads; outsiders and other sites are refused', async () => {
  const a = await newUser('live_a'); const b = await newUser('live_b'); const out = await newUser('live_out');
  await befriend(a, b);
  const g = await chatOf(a, [b]);
  assert.equal(await upgrade(out, g.id), 404, 'not a member');
  assert.equal(await upgrade(null, g.id), 401, 'logged out');
  assert.equal(await upgrade(a, g.id, 'https://evil.example'), 403, 'another site\'s page');
  assert.equal(await upgrade(a, g.id, null), 403, 'no Origin at all');
  assert.equal(await upgrade(a, 'nope'), 404);
  assert.equal((await a.get(`/api/live/${g.id}`)).status, 426, 'not a WebSocket');
  assert.equal(await upgrade(a, g.id), 101);
  const sa = live(a, g.id), sb = live(b, g.id);
  await Promise.all([sa.opened, sb.opened]);
  const both = await sb.next(e => e.type === 'presence' && e.online.length === 2);
  assert.deepEqual(both.online.map(p => p.name).sort(), [a.name, b.name].sort());
  assert.deepEqual(Object.keys(both.online[0]).sort(), ['avatar', 'id', 'name']);

  for (const body of ['one', 'two', 'three']) await say(a, g.id, body);
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await sb.next(e => e.type === 'message')).message);
  assert.deepEqual(got.map(m => m.body), ['one', 'two', 'three'], 'in order');
  assert.deepEqual(Object.keys(got[0]).sort(), ['author', 'body', 'chatId', 'created', 'id', 'room']);
  assert.deepEqual([got[0].chatId, got[0].room, got[0].author.name], [g.id, null, a.name]);
  await say(b, g.id, 'hi a');
  assert.equal((await sa.next(e => e.type === 'message' && e.message.author.id === b.id)).message.body, 'hi a');

  const bRef = { id: b.id, name: b.name, avatar: (await b.get('/api/me')).data.user.avatar };
  sb.send({ type: 'typing' });
  assert.deepEqual(await sa.next(e => e.type === 'typing'), { type: 'typing', user: bRef });
  sa.send('{"type":"ping"}');
  await sa.next(e => e.type === 'pong');

  const readMe = await say(a, g.id, 'read me');
  await b.put(`/api/chats/${g.id}/read`, { id: readMe.id });
  assert.deepEqual(await sa.next(e => e.type === 'read'), { type: 'read', user: bRef, id: readMe.id });
  assert.deepEqual((await a.get(`/api/chats/${g.id}/messages`)).data.reads, [{ user: bRef, id: readMe.id }]);

  await a.del('/api/chat-messages/' + got[0].id);
  assert.deepEqual(await sb.next(e => e.type === 'deleted'), { type: 'deleted', id: got[0].id });
  await a.put(`/api/chats/${g.id}`, { title: 'live room' });
  await sb.next(e => e.type === 'changed');

  // b drops off: a sees them go; what b missed comes back from the history
  sb.close();
  await sb.closed;
  await sa.next(e => e.type === 'presence' && e.online.length === 1);
  const lastSeen = got[2].id;
  await say(a, g.id, 'missed 1');
  await say(a, g.id, 'missed 2');
  const sb2 = live(b, g.id);
  await sb2.opened;
  await sa.next(e => e.type === 'presence' && e.online.length === 2);
  const missed = (await b.get(`/api/chats/${g.id}/messages?after=${lastSeen}`)).data.messages.map(m => m.body);
  assert.deepEqual(missed, ['hi a', 'read me', 'missed 1', 'missed 2']);

  // removed from the group: the socket closes
  await a.del(`/api/chats/${g.id}/members/${b.name}`);
  assert.equal(await sb2.closed, 4003);
  assert.equal(await upgrade(b, g.id), 404);
  sa.close();
});

test('live: a block keeps two people apart in a room: no messages, no typing, not in each other\'s presence', async () => {
  const x = await newUser('lb_x'); const y = await newUser('lb_y'); const z = await newUser('lb_z');
  await befriend(x, y); await befriend(x, z);
  const g = await chatOf(x, [y, z]);
  await z.post('/api/blocks/' + y.name);
  const sx = live(x, g.id), sy = live(y, g.id), sz = live(z, g.id);
  await Promise.all([sx.opened, sy.opened, sz.opened]);
  await sx.next(e => e.type === 'presence' && e.online.length === 3);
  const zSees = await sz.next(e => e.type === 'presence' && e.online.some(p => p.id === x.id));
  assert.ok(!zSees.online.some(p => p.id === y.id), 'z doesn\'t see y online');
  sy.send({ type: 'typing' });
  await sx.next(e => e.type === 'typing' && e.user.id === y.id);
  await say(y, g.id, 'from y');
  await sx.next(e => e.type === 'message' && e.message.body === 'from y');
  await say(x, g.id, 'from x');
  await sz.next(e => e.type === 'message' && e.message.body === 'from x');
  assert.ok(!sz.events.some(e => (e.type === 'message' && e.message.author.id === y.id) || (e.type === 'typing' && e.user.id === y.id)),
    'nothing of y reached z');
  assert.ok(!sz.events.some(e => e.type === 'presence' && e.online.some(p => p.id === y.id)));
  for (const s of [sx, sy, sz]) s.close();
});

const pause = ms => new Promise(r => setTimeout(r, ms));
// a socket that still works answers a ping
const alive = async s => { s.send('{"type":"ping"}'); await s.next(e => e.type === 'pong'); };

test('live: logging out, a password change or reset, a ban and deleting the account close the sockets for good (4001), in every room', async () => {
  const a = await newUser('so_a'); const b = await newUser('so_b'); const mod = await moderator('so_mod');
  await befriend(a, b);
  const g = await chatOf(a, [b]);
  const phone = client();
  assert.equal((await phone.post('/api/login', { login: a.email, password: PW })).status, 200);

  // logging out: that session's sockets, in #ourspace and the group; the phone's stay
  const a1 = live(a, 'ourspace'), a2 = live(a, g.id), p1 = live(phone, g.id);
  await Promise.all([a1.opened, a2.opened, p1.opened]);
  await a.post('/api/logout');
  assert.deepEqual(await Promise.all([a1.closed, a2.closed]), [4001, 4001]);
  await alive(p1);
  assert.equal(await upgrade(a, g.id), 401);
  await say(b, g.id, 'after the logout');
  await p1.next(e => e.type === 'message' && e.message.body === 'after the logout');
  assert.ok(!a2.events.some(e => e.type === 'message'), 'nothing more reaches a closed session\'s socket');

  // a password change: every other device's sockets
  const laptop = client();
  await laptop.post('/api/login', { login: a.email, password: PW });
  const l1 = live(laptop, g.id);
  await l1.opened;
  assert.equal((await phone.post('/api/me/password', { current: PW, next: 'brand-new-pass-7' })).status, 200);
  assert.equal(await l1.closed, 4001);
  await alive(p1);

  // a password reset: all of them
  await phone.post('/api/password/forgot', { email: a.email });
  await pause(500);
  const token = [...serverLog.matchAll(/\/reset#token=([\w-]+)/g)].map(m => m[1]).pop();
  assert.equal((await client().post('/api/password/reset', { token, password: 'brand-new-pass-8' })).status, 200);
  assert.equal(await p1.closed, 4001);

  // a ban: the banned member's sockets close and they leave the online list
  const watcher = await newUser('so_watch');
  const b1 = live(b, 'ourspace'), b2 = live(b, g.id), w1 = live(watcher, 'ourspace');
  await Promise.all([b1.opened, b2.opened, w1.opened]);
  assert.ok((await watcher.get('/api/ourspace/messages')).data.online.some(p => p.id === b.id));
  assert.equal((await mod.post('/api/admin/users/' + b.name, { banned: true, note: 'x' })).status, 200);
  assert.deepEqual(await Promise.all([b1.closed, b2.closed]), [4001, 4001]);
  await w1.next(e => e.type === 'presence' && !e.online.some(p => p.id === b.id) && e.online.some(p => p.id === watcher.id));
  assert.ok(!(await watcher.get('/api/ourspace/messages')).data.online.some(p => p.id === b.id), 'not online any more');

  // deleting the account
  const d = await newUser('so_del');
  const d1 = live(d, 'ourspace');
  await d1.opened;
  assert.equal((await d.del('/api/me', { password: PW })).status, 200);
  assert.equal(await d1.closed, 4001);

  // a session that went without the room being told: the next frame finds out
  const e = await newUser('so_quiet');
  const e1 = live(e, 'ourspace');
  await e1.opened;
  sql(`DELETE FROM sessions WHERE user_id = ${e.id}`);
  e1.send({ type: 'typing' });
  assert.equal(await e1.closed, 4001);

  // and a socket never outlives its session's time
  const f = await newUser('so_brief');
  sql(`UPDATE sessions SET expires = ${Date.now() + 2500} WHERE user_id = ${f.id}`);
  const f1 = live(f, 'ourspace');
  await f1.opened;
  await pause(3000);
  const poster = await newUser('so_post');
  assert.equal((await poster.post('/api/ourspace/messages', { body: 'anyone?' })).status, 201);
  assert.equal(await f1.closed, 4001);
  assert.ok(!f1.events.some(x => x.type === 'message'), 'nothing reached it after its time');
  w1.close();
});

test('live: 5 sockets per member in a room (the oldest goes, 4002), typing once per 2 s per person, presence in rounds, floods closed, upgrades limited', async () => {
  const u = await newUser('fl_u'); const w = await newUser('fl_w');
  await befriend(u, w);
  const g = await chatOf(u, [w]);
  const sw = live(w, g.id);
  await sw.opened;
  await sw.next(e => e.type === 'presence');
  const socks = [];
  for (let i = 0; i < 6; i++) { const s = live(u, g.id); await s.opened; socks.push(s); }
  assert.equal(await socks[0].closed, 4002, 'the oldest of six');
  await pause(1500);
  const rounds = sw.events.filter(e => e.type === 'presence');
  assert.ok(rounds.length >= 1 && rounds.length <= 3, `six connects and a close came to ${rounds.length} presence frames`);
  assert.deepEqual(rounds.at(-1).online.map(p => p.id).sort(), [u.id, w.id].sort(), 'each person once');

  // typing: once per 2 s per person, however many sockets they have
  socks[1].send({ type: 'typing' });
  socks[2].send({ type: 'typing' });
  await sw.next(e => e.type === 'typing');
  await pause(500);
  assert.equal(sw.events.filter(e => e.type === 'typing').length, 0, 'the second socket\'s typing was dropped');

  // a flood of frames closes that socket (and only that one)
  for (let i = 0; i < 40; i++) socks[3].send({ type: 'junk', i });
  assert.equal(await socks[3].closed, 1008);
  await alive(socks[4]);

  // upgrades: 30 a minute per member
  const v = await newUser('fl_v');
  for (let i = 0; i < 30; i++) assert.equal(await upgrade(v, 'ourspace'), 101);
  assert.equal(await upgrade(v, 'ourspace'), 429);
  for (const s of [sw, ...socks]) s.close();
});

test('live: a block made while both are connected applies at once (no typing, out of presence), and lifting it brings them back', async () => {
  const x = await newUser('lbn_x'); const y = await newUser('lbn_y'); const z = await newUser('lbn_z');
  await befriend(x, y); await befriend(x, z);
  const g = await chatOf(x, [y, z]);
  const sx = live(x, g.id), sy = live(y, g.id), sz = live(z, g.id), ox = live(x, 'ourspace'), oy = live(y, 'ourspace');
  await Promise.all([sx, sy, sz, ox, oy].map(s => s.opened));
  await sx.next(e => e.type === 'presence' && e.online.length === 3);
  await ox.next(e => e.type === 'presence' && e.online.some(p => p.id === y.id));

  assert.equal((await x.post('/api/blocks/' + y.name)).status, 200);
  await sx.next(e => e.type === 'presence' && e.online.length === 2 && !e.online.some(p => p.id === y.id));
  await sy.next(e => e.type === 'presence' && !e.online.some(p => p.id === x.id));
  await ox.next(e => e.type === 'presence' && !e.online.some(p => p.id === y.id));
  sx.events.length = 0;
  sy.send({ type: 'typing' });
  await sz.next(e => e.type === 'typing' && e.user.id === y.id);
  await pause(300);
  assert.ok(!sx.events.some(e => e.type === 'typing'), 'x doesn\'t see y typing');

  assert.equal((await x.del('/api/blocks/' + y.name)).status, 200);
  await sx.next(e => e.type === 'presence' && e.online.some(p => p.id === y.id));
  await pause(2100);
  sy.send({ type: 'typing' });
  await sx.next(e => e.type === 'typing' && e.user.id === y.id);
  for (const s of [sx, sy, sz, ox, oy]) s.close();
});

test('invites: after a decline the group can\'t ask again for 30 days, nor the inviter into any group for 7; one notification per invite', async () => {
  const o = await newUser('dec_o'); const v = await newUser('dec_v'); const f = await newUser('dec_f'); const o2 = await newUser('dec_o2');
  await befriend(o, f); await befriend(o2, f);
  const g = await chatOf(o, [f, v]);
  assert.deepEqual((await v.post(`/api/chats/${g.id}/invite`, { action: 'decline' })).data, { ok: true });
  const again = await o.post(`/api/chats/${g.id}/members`, { names: [v.name] });
  assert.equal(again.status, 403, 'the same group, right away');
  assert.match(again.data.error, /lately/);
  assert.equal((await o.post('/api/chats', { members: [f.name, v.name] })).status, 403, 'the same inviter, another group');
  assert.ok((await chatOf(o2, [f, v])).invited.some(p => p.id === v.id), 'somebody else may still ask');
  const back = days => sql(`UPDATE conversation_members SET declined = declined - ${days * 86400000} WHERE user_id = ${v.id} AND conversation_id = ${g.id}`);

  back(8);
  assert.equal((await o.post(`/api/chats/${g.id}/members`, { names: [v.name] })).status, 403, 'a week on, still not this group');
  assert.equal((await o.post('/api/chats', { members: [f.name, v.name] })).status, 201, 'but another group of the inviter\'s');

  back(23);
  assert.equal((await o.post(`/api/chats/${g.id}/members`, { names: [v.name] })).status, 200, 'a month on, this group may ask again');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ${v.id} AND kind = 'group_invite' AND conversation_id = ${g.id}`)[0].n, 1,
    'one invite notification for the group');
  assert.equal(sql(`SELECT declined FROM conversation_members WHERE user_id = ${v.id} AND conversation_id = ${g.id}`)[0].declined, null);
});

test('#ourspace: members only, slow mode, links out, mentions notify, moderators delete and mute', async () => {
  const u1 = await newUser('os_one'); const u2 = await newUser('os_two'); const mod = await moderator('os_mod');
  assert.equal((await client().get('/api/ourspace/messages')).status, 401);
  assert.equal(await upgrade(null, 'ourspace'), 401);
  const s2 = live(u2, 'ourspace');
  await s2.opened;
  const first = await u1.post('/api/ourspace/messages', { body: `hi @${u2.name} see www.example.com` });
  assert.equal(first.status, 201);
  assert.deepEqual([first.data.message.body, first.data.message.room, first.data.message.chatId], [`hi @${u2.name} see [link removed]`, 'ourspace', null]);
  assert.equal((await s2.next(e => e.type === 'message')).message.id, first.data.message.id);
  const note = (await u2.get('/api/notifications')).data.items.find(n => n.kind === 'chat_mention');
  assert.deepEqual([note.actor.name, note.message.id, note.message.room], [u1.name, first.data.message.id, 'ourspace']);
  assert.equal((await u1.post('/api/ourspace/messages', { body: 'again!' })).status, 429, 'one message every 3 seconds');
  sql(`DELETE FROM attempts WHERE k = 'ourspace:${u1.id}'`);
  const page = (await u2.get('/api/ourspace/messages')).data;
  assert.equal(page.messages.at(-1).id, first.data.message.id);
  assert.deepEqual([page.slowMode, page.mutedUntil], [{ seconds: 3, perMinute: 20 }, null]);
  assert.ok(page.online.some(p => p.id === u2.id), 'who has the room open');

  // moderators: mute (1 h / 24 h / 7 days, or lift), delete anybody's message
  assert.equal((await u2.post('/api/admin/mutes', { name: u1.name, hours: 1 })).status, 403);
  assert.equal((await mod.post('/api/admin/mutes', { name: u1.name, hours: 5 })).status, 400);
  assert.equal((await mod.post('/api/admin/mutes', { name: mod.name, hours: 1 })).status, 400);
  const muted = await mod.post('/api/admin/mutes', { name: u1.name, hours: 1, reason: 'cool it' });
  assert.ok(muted.data.until > Date.now() + 3500000);
  assert.equal((await u1.post('/api/ourspace/messages', { body: 'let me talk' })).status, 403);
  assert.equal((await u1.get('/api/ourspace/messages')).data.mutedUntil, muted.data.until);
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'mute' && l.targetId === u1.id));
  assert.equal((await mod.post('/api/admin/mutes', { name: u1.name, hours: 0 })).data.until, null);
  const second = await u1.post('/api/ourspace/messages', { body: 'thanks' });
  assert.equal(second.status, 201);
  assert.equal((await u2.del('/api/chat-messages/' + second.data.message.id)).status, 403, 'not yours');
  assert.equal((await mod.del('/api/chat-messages/' + second.data.message.id)).status, 200);
  assert.deepEqual(await s2.next(e => e.type === 'deleted'), { type: 'deleted', id: second.data.message.id });
  assert.ok(!(await u2.get('/api/ourspace/messages')).data.messages.some(m => m.id === second.data.message.id));
  assert.equal(sql(`SELECT hidden FROM chat_messages WHERE id = ${second.data.message.id}`)[0].hidden, 1, 'kept, taken down');
  s2.close();
});

test('#ourspace keeps the newest 500 messages of the last day; the cron deletes the rest, but never a reported one', async () => {
  const u = await newUser('os_roll'); const r = await newUser('os_rep');
  const now = Date.now();
  sql(`INSERT INTO chat_messages (room, author_id, body, created) VALUES ('ourspace', ${u.id}, 'yesterday', ${now - 25 * 3600000}),
    ('ourspace', ${u.id}, 'yesterday, reported', ${now - 25 * 3600000})`);
  sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 520)
    INSERT INTO chat_messages (room, author_id, body, created) SELECT 'ourspace', ${u.id}, 'filler ' || i, ${now - 600000} + i FROM n`);
  const [old, oldReported] = sql(`SELECT id FROM chat_messages WHERE room = 'ourspace' AND body LIKE 'yesterday%' ORDER BY id`).map(x => x.id);
  const beyond = sql(`SELECT id FROM chat_messages WHERE room = 'ourspace' AND body = 'filler 3'`)[0].id;
  const cut = sql(`SELECT id FROM chat_messages WHERE room = 'ourspace' ORDER BY id DESC LIMIT 1 OFFSET 499`)[0].id;
  assert.equal((await r.post('/api/reports', { type: 'message', id: oldReported, reason: 'harassment' })).status, 201);
  assert.equal((await r.post('/api/reports', { type: 'message', id: beyond, reason: 'spam' })).status, 201);
  const window = (await r.get('/api/ourspace/messages?after=0')).data.messages;
  assert.equal(window[0].id, cut, 'the oldest that shows is the 500th newest');
  assert.ok(!window.some(m => m.body.startsWith('yesterday')));
  await runCron(() => sql(`SELECT COUNT(*) AS n FROM chat_messages WHERE id = ${old}`)[0].n === 0);
  const left = sql(`SELECT id FROM chat_messages WHERE room = 'ourspace' AND id < ${cut} ORDER BY id`).map(x => x.id);
  assert.deepEqual(left, [oldReported, beyond], 'only the reported ones stay below the window');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM chat_messages WHERE room = 'ourspace' AND id >= ${cut}`)[0].n, 500);
});

test('deleting an account takes its DMs, hands its groups on, and takes its messages and scores', async () => {
  const a = await newUser('del_chat'); const b = await newUser('del_b'); const c = await newUser('del_c');
  await befriend(a, b); await befriend(a, c);
  const dm = await dmOf(b, a);
  await say(b, dm, 'bye?');
  const g = await chatOf(a, [b, c]);
  await say(a, g.id, 'my group');
  await say(c, g.id, 'thanks');
  assert.equal((await a.del('/api/me', { password: PW })).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM conversations WHERE id = ${dm}`)[0].n, 0, 'the DM is gone');
  const after = (await b.get(`/api/chats/${g.id}`)).data.chat;
  assert.deepEqual([after.owner.name, after.memberCount], [b.name, 2], 'the group passes on to whoever joined first');
  assert.deepEqual(await bodies(c, g.id), ['thanks']);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM affinity WHERE ${a.id} IN (from_id, to_id)`)[0].n, 0);
});

test('every DM has its two members, no group holds over 50, and every read position is a message that was there, after everything the tests above did', () => {
  assert.deepEqual(sql(`SELECT v.id FROM conversations v WHERE v.kind = 'dm'
    AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = v.id AND m.status = 'joined') != 2`), []);
  assert.deepEqual(sql(`SELECT conversation_id FROM conversation_members WHERE status != 'left' GROUP BY conversation_id HAVING COUNT(*) > 50`), []);
  assert.deepEqual(sql(`SELECT conversation_id, user_id FROM conversation_members m
    WHERE last_read_id > COALESCE((SELECT MAX(id) FROM chat_messages c WHERE c.conversation_id = m.conversation_id), 0)`), []);
  assert.deepEqual(sql(`SELECT id FROM chat_messages WHERE (conversation_id IS NULL) = (room IS NULL)`), []);
});

/* ------------------------------------------------------------------ */
/* phase 7: verifying humans, anti-spam, AI-writing strikes            */

// a sign-up the test builds by hand: the form fetched and filled by `opts` (fillForm's), sent with `headers`
async function signupWith(c, fields, opts = {}, headers = {}) {
  const form = await (await c.raw('GET', '/api/form/signup', { headers: { 'X-Test-Ip': c.ip } })).json();
  const at = Date.now();
  const body = await fillForm(form, fields, { fetchedAt: at, extraMs: 120, ...opts });
  return { ...(await c.post('/api/signup', body, { ...BROWSER, 'X-Test-Ip': c.ip, ...headers })), body, form };
}
const person = tag => { const id = uniq(); return { email: `${tag}.${id}@example.com`, password: PW, name: `${tag}_${id}`, birthday: '1999-09-09', rulesOk: true }; };
const runCronAs = async (cron, done) => {
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=${WORKER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron }) });
  assert.equal(res.status, 200, await res.text());
  for (let i = 0; i < 40 && !(await done()); i++) await new Promise(r => setTimeout(r, 250));
};

test('sign-up needs the form, its proof of work and Turnstile; a used, filled-in or rushed form is refused', async () => {
  const form = await client().get('/api/form/signup');
  assert.equal(form.status, 200);
  assert.deepEqual(Object.keys(form.data).sort(), ['expiresIn', 'honeypot', 'minMs', 'pow', 'token', 'turnstile']);
  assert.deepEqual(form.data.turnstile, { siteKey: '1x00000000000000000000AA', action: 'signup' });
  assert.deepEqual([form.data.pow.algorithm, form.data.pow.bits], ['SHA-256', 8]);
  assert.equal((await client().get('/api/form/login')).data.turnstile.action, 'login');
  assert.equal((await client().get('/api/form/nope')).status, 404);
  assert.equal((await client().get('/api/me')).data.turnstile.siteKey, '1x00000000000000000000AA');

  const c = client();
  const bare = await c.post('/api/signup', { ...person('bare'), form: undefined, turnstile: TURNSTILE_TEST_TOKEN }, BROWSER);
  assert.deepEqual([bare.status, bare.data.code], [400, 'form'], 'no form at all');
  assert.equal((await signupWith(c, person('nopow'), { pow: false })).data.code, 'pow');
  const noTs = await signupWith(c, person('nots'), { turnstile: null });
  assert.deepEqual([noTs.status, noTs.data.code], [400, 'turnstile']);
  mock.turnstile({ success: false, 'error-codes': ['invalid-input-response'] });          // what the 2x… secret answers
  const failed = await signupWith(c, person('tsfail'));
  assert.deepEqual([failed.status, failed.data.code], [403, 'turnstile']);
  mock.turnstile({ success: false, 'error-codes': ['timeout-or-duplicate'] });             // the 3x… "already spent" secret
  assert.equal((await signupWith(c, person('tsspent'))).status, 403);
  mock.turnstile('down');
  const down = await signupWith(c, person('tsdown'));
  assert.deepEqual([down.status, down.data.code], [503, 'turnstile_unavailable'], 'sign-up fails closed');
  const pot = await signupWith(c, person('pot'), { honeypot: 'http://buy.example' });
  assert.deepEqual([pot.status, pot.data.code], [400, 'form']);
  const rushed = await signupWith(c, person('rush'), { wait: false });
  assert.deepEqual([rushed.status, rushed.data.code], [400, 'too_fast']);
  const bot = await signupWith(client(), person('bot'), {}, { 'User-Agent': 'python-requests/2.32' });
  assert.deepEqual([bot.status, bot.data.code], [403, 'automation']);
  assert.equal((await signupWith(client(), person('agent'), {}, { 'Signature-Agent': '"https://agent.example"' })).data.code, 'automation');
  assert.ok(mock.turnstileLog.some(x => x.secret === '1x0000000000000000000000000000000AA' && x.response === TURNSTILE_TEST_TOKEN), 'our secret and the widget\'s token went to siteverify');

  const ok = await signupWith(client(), person('good'));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.verification, ok.data.held], ['sent', false]);
  const again = await client().post('/api/signup', { ...ok.body, ...person('replay') }, { ...BROWSER, 'X-Test-Ip': randomIp() });
  assert.deepEqual([again.status, again.data.code], [400, 'form_used'], 'a form and its proof of work work once');
  const wrongPurpose = await client().post('/api/signup/finish', { ...ok.body, name: 'nope_' + uniq() });
  assert.equal(wrongPurpose.status, 404, 'finish needs a provider sign-in first');
});

test('sign-up refuses throwaway inboxes and domains that can\'t take mail; real providers pass', async () => {
  for (const [email, code] of [['x@mailinator.com', 'disposable_email'], ['x@inbox.YOPMAIL.com', 'disposable_email'], ['x@nxdomain-nowhere.example', 'email_domain'], ['x@nullmx.example', 'email_domain']]) {
    const r = await signupWith(client(), { ...person('dom'), email: email.replace('x@', `x${uniq()}@`) });
    assert.deepEqual([r.status, r.data.code], [400, code], email);
  }
  assert.equal((await signupWith(client(), { ...person('gm'), email: `gm.${uniq()}@gmail.com` })).status, 201);
});

test('log in and "forgot my password" need the human check; log in still works if Cloudflare is down', async () => {
  const u = await newUser('tslogin');
  const c = client();
  const none = await c.post('/api/login', { login: u.email, password: PW, turnstile: undefined });
  assert.deepEqual([none.status, none.data.code], [400, 'turnstile']);
  mock.turnstile({ success: false, 'error-codes': ['invalid-input-response'] });
  assert.equal((await c.post('/api/login', { login: u.email, password: PW })).status, 403);
  mock.turnstile('down');
  assert.equal((await c.post('/api/login', { login: u.email, password: PW })).status, 200, 'fails open, under the usual limits');
  assert.equal((await c.post('/api/password/forgot', { email: u.email, turnstile: undefined })).status, 400);
  mock.turnstile('down');
  assert.equal((await c.post('/api/password/forgot', { email: u.email })).status, 503, 'the email-sending step fails closed');
  assert.equal((await c.post('/api/password/forgot', { email: u.email })).status, 200);
});

test('email verification: unverified members can set up their page but not post; the link works once; resend', async () => {
  const u = await newUser('unver', {}, { verify: false });
  const me = await u.get('/api/me');
  assert.deepEqual(me.data.account, { verified: false, held: false, timeoutUntil: null, strikes: 0 });
  const blocked = await u.post('/api/status', { body: 'hello?' });
  assert.deepEqual([blocked.status, blocked.data.code], [403, 'unverified']);
  assert.equal((await u.put('/api/me/profile', { mood: 'curious' })).status, 200, 'page set-up is free');
  const first = await verifyToken(u.email);
  assert.equal((await u.post('/api/me/verify/resend')).status, 200);
  await new Promise(r => setTimeout(r, 300));
  const second = await verifyToken(u.email);
  assert.notEqual(first, second);
  assert.equal((await client().post('/api/verify', { token: 'not-a-token' })).status, 400);
  const v = await client().post('/api/verify', { token: first });                 // on another device, logged out
  assert.deepEqual([v.status, v.data.verified], [200, true]);
  assert.equal((await client().post('/api/verify', { token: second })).status, 400, 'every link goes once one works');
  assert.equal((await u.get('/api/me')).data.account.verified, true);
  assert.equal((await u.post('/api/status', { body: 'verified now' })).status, 201);
  assert.equal((await u.post('/api/me/verify/resend')).status, 409);
  // an address changed after the link was sent: the old link no longer verifies
  const w = await newUser('moved', {}, { verify: false });
  const t = await verifyToken(w.email);
  sql(`UPDATE users SET email = 'moved.${uniq()}@example.com' WHERE id = ${w.id}`);
  assert.equal((await client().post('/api/verify', { token: t })).status, 400);
  // a provider vouches for its accounts
  const g = client();
  const gname = 'gpal_' + uniq();
  assert.equal((await viaProvider(g, 'google', { sub: 'g-' + gname, email: `${gname}@gmail.com`, verified: true, name: 'G' })).location, '/join/finish');
  const fin = await g.post('/api/signup/finish', { name: gname, birthday: '1990-01-01', rulesOk: true });
  assert.deepEqual([fin.status, fin.data.held], [201, false]);
  assert.equal((await g.get('/api/me')).data.account.verified, true);
});

// The route table in src/index.js, read as text: every route with its method, path, access and options.
function routeTable() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const body = src.slice(src.indexOf('const ROUTES = ['), src.indexOf('].map(([method'));
  const lines = body.split(/\r?\n/).filter(l => /^\s*\['(GET|POST|PUT|DELETE)'/.test(l));
  const routes = lines.map(l => {
    const m = /^\s*\['(GET|POST|PUT|DELETE)', '([^']+)', (\w+), (OPEN|AUTH|ADMIN)(?:, \{(.*)\})?\],/.exec(l);
    assert.ok(m, 'a route line the test can read: ' + l);
    const opts = m[5] || '';
    return { method: m[1], path: m[2], handler: m[3], access: m[4], free: /free:/.test(opts), freeWhen: /freeWhen:/.test(opts), gate: /gate: 'post'/.test(opts) ? 'post' : 'write' };
  });
  return routes;
}
const fill = p => p.replace(/:(\w+)/g, (_, k) => ({ name: 'nobody_here', id: '999999', provider: 'google', kind: 'person', ref: '1', slug: 'random', commentId: '1' }[k] || '1'));

test('the gate covers every member write route: unverified and held members are refused, timeouts stop public posting only', async () => {
  const routes = routeTable();
  assert.ok(routes.length > 100);
  const writes = routes.filter(r => r.access === 'AUTH' && r.method !== 'GET');
  const gated = writes.filter(r => !r.free || r.freeWhen);
  const free = writes.filter(r => r.free && !r.freeWhen);
  assert.ok(gated.length >= 20, `${gated.length} gated`);
  // the posting routes are exactly the public posting and commenting ones
  assert.deepEqual(writes.filter(r => r.gate === 'post').map(r => r.handler).sort(),
    ['postBlog', 'postComment', 'postQuote', 'postReply', 'postStatus', 'postThread', 'postThreadComment']);
  // every other gated write: likes, reposts, votes, follows, chats, messages, #ourspace, board requests, uploads
  for (const h of ['likePost', 'repostPost', 'votePost', 'followUser', 'acceptFollower', 'createChat', 'sendChatMessage', 'postOurspace', 'requestBoard', 'uploadMedia', 'answerInvite', 'addMembers', 'renameChat'])
    assert.ok(gated.some(r => r.handler === h), h + ' is gated');
  for (const h of ['block', 'unblock', 'report', 'deleteAccount', 'saveProfile', 'resendVerification', 'appealStrike', 'deletePost'])
    assert.ok(free.some(r => r.handler === h), h + ' is free');

  const unverified = await newUser('gateu', {}, { verify: false });
  const held = await newUser('gateh');
  const timed = await newUser('gatet');
  sql(`UPDATE users SET held = 1 WHERE id = ${held.id};
    INSERT INTO ai_strikes (user_id, level, text, score, label, model, created, expires) VALUES (${timed.id}, 2, 'x', 0.99, 'AI', 'mock', ${Date.now()}, ${Date.now() + 90 * 86400000});
    INSERT INTO posting_timeouts (user_id, strike_id, until) VALUES (${timed.id}, (SELECT MAX(id) FROM ai_strikes WHERE user_id = ${timed.id}), ${Date.now() + 86400000});`);
  const send = (c, r) => c.raw(r.method, fill(r.path) + (r.handler === 'uploadMedia' ? '?purpose=post' : ''), { body: r.handler === 'uploadMedia' ? png({ width: 4, height: 4 }) : {}, headers: r.handler === 'uploadMedia' ? { 'Content-Type': 'image/png' } : {} })
    .then(async res => ({ status: res.status, data: await res.json().catch(() => null) }));
  for (const r of gated) {
    const a = await send(unverified, r);
    assert.deepEqual([a.status, a.data && a.data.code], [403, 'unverified'], `${r.method} ${r.path} as an unverified member`);
    const b = await send(held, r);
    assert.deepEqual([b.status, b.data && b.data.code], [403, 'held'], `${r.method} ${r.path} as a held member`);
    const t = await send(timed, r);
    if (r.gate === 'post') {
      assert.deepEqual([t.status, t.data.code], [403, 'timeout'], `${r.method} ${r.path} while timed out`);
      assert.ok(t.data.until > Date.now());
    } else assert.notEqual(t.data && t.data.code, 'timeout', `${r.method} ${r.path} isn't stopped by a timeout`);
  }
  for (const r of free.filter(r => !['deleteAccount', 'changePassword', 'unlink', 'resendVerification'].includes(r.handler))) {
    const a = await send(unverified, r);
    assert.ok(!['unverified', 'held'].includes(a.data && a.data.code), `${r.method} ${r.path} is free (${a.status})`);
  }
  // an unverified member may still upload their own picture
  const pic = await unverified.raw('POST', '/api/media?purpose=avatar', { body: png({ width: 64, height: 64 }), headers: { 'Content-Type': 'image/png' } });
  assert.equal(pic.status, 201);
  // a timed-out member still messages, chats, likes and reads
  const pal = await newUser('gatepal');
  const dm = await timed.post('/api/chats', { dm: pal.name });
  assert.equal((await timed.post(`/api/chats/${dm.data.chat.id}/messages`, { body: 'still here' })).status, 201);
  assert.equal((await timed.post('/api/ourspace/messages', { body: 'hi room' })).status, 201);
  const st = await pal.post('/api/status', { body: 'like me' });
  assert.equal((await timed.post(`/api/posts/${st.data.id}/like`)).status, 200);
  const acct = (await timed.get('/api/me')).data.account;
  assert.ok(acct.timeoutUntil > Date.now() && acct.strikes === 1);
});

test('held sign-ups: a datacenter network signing up twice is held; the account sets up its page; a moderator approves or refuses', async () => {
  const net = randomIp(true);
  const dc = { 'X-Test-Cf': JSON.stringify({ asn: 14061, asOrganization: 'DigitalOcean, LLC', country: 'NL', httpProtocol: 'HTTP/2' }) };
  const first = client(), second = client(), third = client();
  for (const c of [first, second, third]) c.ip = net;
  const gmail = () => ({ ...person('cloudy'), email: `cloudy.${uniq()}@gmail.com` });     // (a big provider: no domain point)
  const a = await signupWith(first, gmail(), {}, dc);
  assert.deepEqual([a.status, a.data.held], [201, false], 'a datacenter alone (+2) holds nobody');
  const b = await signupWith(second, gmail(), {}, dc);
  assert.deepEqual([b.status, b.data.held], [201, true], 'datacenter + the same network again');
  const c3 = await signupWith(third, gmail(), {}, dc);
  assert.equal(c3.data.held, true);
  const bName = b.body.name, cName = c3.body.name;
  assert.equal((await second.post('/api/verify', { token: await verifyToken(b.body.email) })).status, 200);
  assert.deepEqual((await second.get('/api/me')).data.account, { verified: true, held: true, timeoutUntil: null, strikes: 0 });
  assert.equal((await second.put('/api/me/profile', { mood: 'waiting' })).status, 200, 'held accounts set up their page');
  const f = await second.post('/api/follows/' + a.body.name);
  assert.deepEqual([f.status, f.data.code], [403, 'held']);
  assert.equal((await second.post('/api/login', { login: b.body.email, password: PW })).status, 200, 'and log in');

  const mod = await moderator();
  assert.equal((await second.get('/api/admin/held')).status, 403);
  const list = await mod.get('/api/admin/held');
  const row = list.data.accounts.find(x => x.user.name === bName);
  assert.ok(row, 'in the queue');
  assert.deepEqual(row.network, { asn: 14061, asOrg: 'DigitalOcean, LLC', country: 'NL' });
  assert.ok(row.reasons.includes('hosting_network') && row.reasons.includes('same_network_24h') && row.risk >= 4);
  assert.equal(row.emailDomain, 'gmail.com');
  assert.ok(!JSON.stringify(list.data).includes(net), 'no addresses');
  const alerts = await mod.get('/api/admin/alerts');
  assert.ok(alerts.data.alerts.some(x => x.kind === 'held_signup' && x.users.some(u => u.name === bName)));
  assert.equal((await mod.post('/api/admin/held/' + bName, { action: 'approve' })).status, 200);
  assert.equal((await mod.post('/api/admin/held/' + bName, { action: 'approve' })).status, 409);
  assert.equal((await second.post('/api/follows/' + a.body.name)).status, 200, 'approved: works like any account');
  assert.equal((await mod.post('/api/admin/held/' + cName, { action: 'refuse' })).status, 400, 'a refusal needs a reason');
  assert.equal((await mod.post('/api/admin/held/' + cName, { action: 'refuse', reason: 'one of a batch of bot sign-ups' })).status, 200);
  assert.equal((await third.get('/api/me')).data.user, null, 'refused: signed out');
  assert.equal((await client().post('/api/login', { login: c3.body.email, password: PW })).status, 403);
  const closed = await mod.get('/api/admin/alerts?status=closed');
  assert.ok(closed.data.alerts.some(x => x.kind === 'held_signup' && x.resolution === 'approved' && x.users[0].name === bName));
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'refuse_signup' && /batch/.test(l.note)));
});

test('the nightly check opens cluster alerts for moderators (never a ban): one network, one hosting provider, one email domain', async () => {
  const net = randomIp();
  const made = [];
  for (let i = 0; i < 3; i++) {
    const c = client();
    c.ip = net;
    const r = await signupWith(c, { ...person('clus'), email: `clus${uniq()}@clusterco-${net.replace(/\./g, '-')}.example` }, {},
      { 'X-Test-Cf': JSON.stringify({ asn: 16276, asOrganization: 'OVH SAS', country: 'FR' }) });
    assert.equal(r.status, 201);
    made.push(r.data.user.id);
  }
  const mod = await moderator();
  const find = async rule => (await mod.get('/api/admin/alerts')).data.alerts.find(a => a.kind === 'cluster' && a.rule === rule && made.every(id => a.users.some(u => u.id === id)));
  await runCronAs('17 3 * * *', async () => !!(await find('email_domain')));
  for (const rule of ['same_network', 'hosting_burst', 'same_moment', 'email_domain']) assert.ok(await find(rule), rule);
  const alert = await find('hosting_burst');
  assert.deepEqual([alert.details.asn, alert.details.asOrg, alert.details.count], [16276, 'OVH SAS', 3]);
  assert.ok(alert.users.every(u => !u.banned), 'nobody is banned by an alert');
  // running it again doesn't open the same alerts twice
  const before = (await mod.get('/api/admin/alerts')).data.alerts.length;
  await runCronAs('17 3 * * *', async () => true);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await mod.get('/api/admin/alerts')).data.alerts.length, before);
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'ban' })).status, 400, 'bans aren\'t made from a cluster');
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'dismiss', note: 'a school' })).status, 200);
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'dismiss' })).status, 409);
});

test('the same text from several new accounts: an alert, the copy that crosses the line is held (never the earlier ones) until a moderator releases it; older accounts aren\'t held', async () => {
  const text = i => `Check out my page for ${i % 2 ? 'FREE' : 'free'} followers and likes, the best deal anywhere online, limited time only!!! ${'🔥'.repeat(i)}`;
  const [a, b, c, d] = [await newUser('dupa'), await newUser('dupb'), await newUser('dupc'), await newUser('dupd')];
  const p1 = await a.post('/api/status', { body: text(0) });
  const p2 = await b.post('/api/status', { body: text(1) });
  assert.deepEqual([p1.data.held, p2.data.held], [undefined, undefined], 'two accounts is a coincidence');
  const p3 = await c.post('/api/status', { body: text(2) });
  assert.deepEqual([p3.status, p3.data.held], [201, true], 'the third brand-new account is held');
  const anon = client();
  assert.equal((await anon.get('/api/posts/' + p3.data.id)).status, 404, 'the copy that crossed the line waits');
  for (const id of [p1.data.id, p2.data.id]) assert.equal((await anon.get('/api/posts/' + id)).status, 200, 'copies written before it never wait');
  assert.equal((await d.post(`/api/posts/${p3.data.id}/replies`, { body: 'hi' })).status, 404, 'nothing to reply to while held');
  const p4 = await d.post('/api/status', { body: text(3) });
  assert.equal(p4.data.held, true, 'later copies are held too');
  const mod = await moderator();
  const alert = (await mod.get('/api/admin/alerts')).data.alerts.find(x => x.kind === 'duplicate' && x.posts.some(p => p.id === p1.data.id));
  assert.ok(alert, 'one alert');
  const byId = (x, y) => x - y;
  assert.deepEqual(alert.posts.map(p => p.id).sort(byId), [p1.data.id, p2.data.id, p3.data.id, p4.data.id].sort(byId), 'one alert grows');
  const state = Object.fromEntries(alert.posts.map(p => [p.id, [p.held, p.hidden]]));
  assert.deepEqual([p1, p2, p3, p4].map(p => state[p.data.id]), [[false, false], [false, false], [true, false], [true, false]]);
  assert.deepEqual(alert.details.held.sort(byId), [p3.data.id, p4.data.id].sort(byId), 'it records exactly what it held');
  assert.equal(sql(`SELECT hidden FROM posts WHERE id = ${p3.data.id}`)[0].hidden, 2, 'a hold is its own state, not a moderator\'s hide');
  // a moderator takes one held copy down for good before releasing the alert: the release leaves it down
  assert.equal((await mod.post('/api/admin/content', { type: 'post', id: p4.data.id, hidden: true, note: 'spam' })).status, 200);
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'release' })).status, 200);
  assert.equal((await anon.get('/api/posts/' + p3.data.id)).status, 200, 'released');
  assert.equal((await anon.get('/api/posts/' + p4.data.id)).status, 404, 'a moderator\'s hide outlives a release');
  // members of more than 30 days can post the same meme together
  const olds = [await newUser('olda'), await newUser('oldb'), await newUser('oldc')];
  sql(`UPDATE users SET created = created - 40 * 86400000 WHERE id IN (${olds.map(o => o.id)})`);
  const meme = 'when the teacher says the test will be easy and then question one is written in a language nobody has ever seen';
  for (const o of olds) assert.equal((await o.post('/api/status', { body: meme })).data.held, undefined);
});

test('a duplicate alert never un-hides a moderator\'s takedown, and a taken-down post isn\'t counted as a copy', async () => {
  const text = `buy cheap followers now at the best prices click my profile link for amazing deals ${uniq()}`;
  const mod = await moderator();
  const anon = client();
  const abuser = await newUser('takedown');
  const bad = await abuser.post('/api/status', { body: text });
  assert.equal((await mod.post('/api/admin/content', { type: 'post', id: bad.data.id, hidden: true, note: 'takedown' })).status, 200);
  const [x, y, z] = [await newUser('tdx'), await newUser('tdy'), await newUser('tdz')];
  const px = await x.post('/api/status', { body: text });
  const py = await y.post('/api/status', { body: text });
  assert.equal(py.data.held, undefined, 'the hidden post isn\'t a copy: only two accounts so far');
  const pz = await z.post('/api/status', { body: text });
  assert.equal(pz.data.held, true);
  const alert = (await mod.get('/api/admin/alerts')).data.alerts.find(a => a.kind === 'duplicate' && a.posts.some(p => p.id === pz.data.id));
  assert.ok(!alert.posts.some(p => p.id === bad.data.id), 'the takedown isn\'t in the alert');
  // even an alert that lists it as held (as the red team's did) can't bring it back: a release only shows held posts
  sql(`UPDATE mod_alerts SET payload = json_set(payload, '$.held', json('[${pz.data.id}, ${bad.data.id}]')) WHERE id = ${alert.id}`);
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'release' })).status, 200);
  assert.equal((await anon.get('/api/posts/' + bad.data.id)).status, 404, 'still taken down');
  assert.equal((await anon.get('/api/posts/' + pz.data.id)).status, 200);
  assert.equal((await anon.get('/api/posts/' + px.data.id)).status, 200);
});

test('copying a stranger\'s post can\'t get it held: unrelated accounts only raise an alert; related ones (one network) are held', async () => {
  const anon = client();
  const mod = await moderator();
  // a member of ten days posts first; two brand-new accounts from other networks copy it word for word
  const text = `just finished my first pottery class today and the bowl came out lopsided but i love it ${uniq()}`;
  const victim = await newUser('potter');
  sql(`UPDATE users SET created = created - 10 * 86400000 WHERE id = ${victim.id}`);
  const v = await victim.post('/api/status', { body: text });
  const s1 = await newUser('socka'), s2 = await newUser('sockb');
  assert.equal((await s1.post('/api/status', { body: text })).data.held, undefined);
  const c2 = await s2.post('/api/status', { body: text });
  assert.equal(c2.data.held, undefined, 'not related (other networks, not all brand new): nothing held');
  assert.equal((await anon.get('/api/posts/' + v.data.id)).status, 200, 'the original stays up');
  assert.equal((await anon.get('/api/posts/' + c2.data.id)).status, 200);
  const alert = (await mod.get('/api/admin/alerts')).data.alerts.find(a => a.kind === 'duplicate' && a.posts.some(p => p.id === c2.data.id));
  assert.ok(alert, 'a moderator is still told');
  assert.deepEqual([alert.details.held, alert.posts.some(p => p.held || p.hidden)], [[], false]);
  // the same from accounts of ten days that signed up on one network: related, so the third copy is held
  const net = randomIp();
  const ring = [];
  for (let i = 0; i < 3; i++) {
    const c = client();
    c.ip = net;
    const r = await signupWith(c, person('ring'));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await c.post('/api/verify', { token: await verifyToken(r.body.email) })).status, 200);
    ring.push(Object.assign(c, { id: r.data.user.id }));
  }
  sql(`UPDATE users SET held = 0, created = created - 10 * 86400000 WHERE id IN (${ring.map(r => r.id)})`);
  const spam = `the best crypto signals group is open again, message me for the invite link today ${uniq()}`;
  const outs = [];
  for (const r of ring) outs.push(await r.post('/api/status', { body: spam }));
  assert.deepEqual(outs.map(o => o.data.held), [undefined, undefined, true]);
});

test('sign-up refusals: before the proof of work nothing is written; after it every outcome spends the form; no refusal shrinks a network\'s allowance', async () => {
  const net = randomIp();
  const bully = client();
  bully.ip = net;
  const H = { ...BROWSER, 'X-Test-Ip': net, 'CF-Connecting-IP': net };
  const rows = () => sql('SELECT (SELECT COUNT(*) FROM attempts WHERE k LIKE \'signup:ip:%\') AS a, (SELECT COUNT(*) FROM spent_nonces) AS s')[0];
  const start = rows();
  // one form, reused; no proof of work, no Turnstile, no waiting, the honeypot filled (the red team's lockout)
  const form = await (await bully.raw('GET', '/api/form/signup', { headers: { 'X-Test-Ip': net } })).json();
  for (let i = 0; i < 4; i++) {
    const r = await bully.post('/api/signup', { ...person('bully'), form: form.token, [form.honeypot]: 'x' }, H);
    assert.deepEqual([r.status, r.data.code], [400, 'pow'], 'refused for the missing proof of work, before anything else is read');
  }
  assert.deepEqual(rows(), start, 'no rate-limit rows, no spent forms');
  // with the proof of work done, a filled honeypot or a rushed form is refused and the form is used up
  const pot = await signupWith(bully, person('pot'), { honeypot: 'http://buy.example' }, H);
  assert.deepEqual([pot.status, pot.data.code], [400, 'form']);
  const again = await bully.post('/api/signup', { ...pot.body, [pot.form.honeypot]: '' }, H);
  assert.deepEqual([again.status, again.data.code], [400, 'form_used'], 'a refused form can\'t be tried again');
  const rushed = await signupWith(bully, person('rush'), { wait: false }, H);
  assert.deepEqual([rushed.status, rushed.data.code], [400, 'too_fast']);
  const agent = await signupWith(bully, person('agent'), {}, { ...H, 'User-Agent': 'python-requests/2.32' });
  assert.deepEqual([agent.status, agent.data.code], [403, 'automation']);
  const now = rows();
  assert.deepEqual([now.a, now.s], [start.a, start.s + 3], 'three forms spent, still no rate-limit rows');
  // a real person on the same network gets in, and only that sign-up counts
  const student = client();
  student.ip = net;
  const ok = await signupWith(student, person('student'), {}, H);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(rows().a, start.a + 1);
});

test('a flood of sign-up traffic from one network is braked without writing a row; other networks carry on', async () => {
  const net = randomIp();
  const c = client();
  const count = () => sql('SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM spent_nonces) AS n')[0].n;
  const start = count();
  let busy = null, sent = 0;
  while (!busy && sent < 80) {
    const r = await c.raw('GET', '/api/form/signup', { headers: { 'X-Test-Ip': net } });
    sent++;
    if (r.status === 429) busy = await r.json();
    else assert.equal(r.status, 200);
  }
  assert.ok(busy && sent > 60, `braked after the allowance (${sent} requests)`);
  assert.equal(busy.code, 'busy');
  const post = await c.post('/api/signup', { ...person('flood'), form: 'x' }, { ...BROWSER, 'X-Test-Ip': net });
  assert.deepEqual([post.status, post.data.code], [429, 'busy'], 'posting the form too');
  assert.equal((await c.raw('GET', '/api/form/signup', { headers: { 'X-Test-Ip': randomIp() } })).status, 200, 'another network');
  assert.equal(count(), start, 'nothing written');
});

test('finishing a sign-up through a provider: its email passes the throwaway list and feeds the domain signals; no verified email is held until a moderator approves', async () => {
  const g = client();
  const sub = 'g-' + uniq();
  await viaProvider(g, 'google', { sub, email: `${sub}@mailinator.com`, verified: true });
  const thrown = await g.post('/api/signup/finish', { name: 'thrw_' + uniq(), birthday: '1990-01-01', rulesOk: true });
  assert.deepEqual([thrown.status, thrown.data.code], [400, 'disposable_email']);
  // three sign-ups from one small domain (the provider vouched for each address, so no mail check)
  const dom = `smallco-${uniq()}.example`;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const c = client();
    await viaProvider(c, 'google', { sub: `g-${uniq()}`, email: `p${i}@${dom}`, verified: true });
    const r = await c.post('/api/signup/finish', { name: 'small_' + uniq(), birthday: '1990-01-01', rulesOk: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.user.id);
  }
  const sig = sql(`SELECT email_domain, reasons FROM signup_signals WHERE user_id IN (${ids}) ORDER BY user_id`);
  assert.deepEqual(sig.map(s => s.email_domain), [dom, dom, dom]);
  assert.ok(JSON.parse(sig[2].reasons).includes('domain_burst'));
  // no verified address from the provider: allowed, but held, and nothing to confirm by email
  const ms = client();
  await viaProvider(ms, 'discord', { sub: 'd-' + uniq(), email: `dc.${uniq()}@outlook.com`, verified: false });
  const name = 'dsc_' + uniq();
  const fin = await ms.post('/api/signup/finish', { name, birthday: '1990-01-01', rulesOk: true });
  assert.deepEqual([fin.status, fin.data.held], [201, true]);
  assert.deepEqual((await ms.get('/api/me')).data.account, { verified: true, held: true, timeoutUntil: null, strikes: 0 });
  assert.equal(sql(`SELECT email_verified_at FROM users WHERE id = ${fin.data.user.id}`)[0].email_verified_at, null);
  const blocked = await ms.post('/api/status', { body: 'hello from discord' });
  assert.deepEqual([blocked.status, blocked.data.code], [403, 'held'], 'the held message, not "confirm your email"');
  const mod = await moderator();
  const row = (await mod.get('/api/admin/held')).data.accounts.find(a => a.user.name === name);
  assert.ok(row.reasons.includes('no_verified_email'));
  assert.equal((await mod.post('/api/admin/held/' + name, { action: 'approve' })).status, 200);
  assert.equal((await ms.post('/api/status', { body: 'hello from discord' })).status, 201, 'the approval stands in for the link');
});

test('a held account is unlisted: a 404 to everyone but itself and moderators, and left out of search, follows and messages until approved', async () => {
  const net = randomIp(true);
  const dc = { 'X-Test-Cf': JSON.stringify({ asn: 14061, asOrganization: 'DigitalOcean, LLC', country: 'NL', httpProtocol: 'HTTP/2' }) };
  const first = client(), second = client();
  first.ip = second.ip = net;
  await signupWith(first, { ...person('unl'), email: `unl.${uniq()}@gmail.com` }, {}, dc);
  const r = await signupWith(second, { ...person('unl'), email: `unl.${uniq()}@gmail.com` }, {}, dc);
  assert.equal(r.data.held, true);
  const name = r.body.name;
  const member = await newUser('looker');
  const mod = await moderator();
  assert.equal((await client().get('/api/users/' + name)).status, 404, 'logged out');
  assert.equal((await member.get('/api/users/' + name)).status, 404, 'another member');
  assert.equal((await member.get(`/api/users/${name}/statuses`)).status, 404);
  assert.equal((await second.get('/api/users/' + name)).status, 200, 'their own page works');
  assert.equal((await mod.get('/api/users/' + name)).status, 200, 'moderators see it');
  assert.ok(!(await client().get('/api/users?q=' + name)).data.users.length, 'not in Browse search');
  assert.equal((await member.post('/api/follows/' + name)).status, 404);
  assert.equal((await member.post('/api/chats', { dm: name })).status, 404);
  const people = (await member.get('/api/browse/people?limit=10')).data.people;
  assert.ok(!people.some(p => p.user.name === name), 'not suggested');
  assert.equal((await mod.post('/api/admin/held/' + name, { action: 'approve' })).status, 200);
  assert.equal((await client().get('/api/users/' + name)).status, 200, 'approved: listed like anybody');
  assert.deepEqual((await client().get('/api/users?q=' + name)).data.users.map(u => u.name), [name]);
});

// a comment long enough to be judged (100+ words), with the mock detector's score in it
const judged = (score, n = 0) => `post number ${n} ` + Array.from({ length: 110 }, (_, i) => ['the', 'garden', 'was', 'quiet', 'after', 'rain', 'and', 'we', 'walked', 'home'][i % 10]).join(' ') + ` mock-ai-score: ${score}`;
async function scanOf(postId) {
  for (let i = 0; i < 60; i++) {
    const r = sql(`SELECT decision, score, label, model FROM ai_scans WHERE post_id = ${postId}`)[0];
    if (r) return r;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

test('AI scans: shadow mode only records scores for moderators; short posts and DMs are never scanned', async () => {
  const u = await newUser('shadow');
  const board = (await u.post('/api/boards/random/threads', { subject: 'long thoughts', body: judged(0.99) })).data.thread.id;
  const scan = await scanOf(board);
  assert.deepEqual(scan, { decision: 'would_strike', score: 0.99, label: 'AI', model: 'mock:marker' });
  assert.equal((await u.get('/api/me/strikes')).data.strikes.length, 0, 'shadow mode: no strike');
  const plain = await u.post(`/api/threads/${board}/comments`, { body: judged(0.2, 1) });
  assert.equal((await scanOf(plain.data.comment.id)).decision, 'clear');
  const short = await u.post('/api/status', { body: 'short and mock-ai-score: 0.99' });
  const pal = await newUser('shadowpal');
  const dm = await u.post('/api/chats', { dm: pal.name });
  await u.post(`/api/chats/${dm.data.chat.id}/messages`, { body: judged(0.99, 2).slice(0, 1900) });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM ai_scans WHERE post_id = ${short.data.id}`)[0].n, 0, 'under 100 words');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM ai_scans WHERE user_id = ${u.id}`)[0].n, 2, 'DMs never');
  const mod = await moderator();
  const list = await mod.get('/api/admin/ai-scans');
  assert.deepEqual([list.data.detector, list.data.enforcement], ['mock', 'shadow']);
  const row = list.data.scans.find(s => s.post && s.post.id === board);
  assert.deepEqual([row.decision, row.score, row.user.name, row.kind], ['would_strike', 0.99, u.name, 'thread']);
  assert.ok((await mod.get('/api/admin/ai-scans?decision=would_strike')).data.scans.every(s => s.decision === 'would_strike'));
  assert.equal((await u.get('/api/admin/ai-scans')).status, 403);
});

test('AI strikes in enforce mode: a warning, then a day\'s timeout (posting only); an appeal removes it and lifts the timeout', async () => {
  const u = await newUser('strike');
  const enforce = { 'X-Test-Enforcement': 'enforce' };
  const thread = (await u.post('/api/boards/random/threads', { subject: 'mine', body: 'a thread to comment in' })).data.thread.id;
  const say = async (score, n) => (await u.post(`/api/threads/${thread}/comments`, { body: judged(score, n) }, enforce)).data.comment.id;
  const c1 = await say(0.97, 1);
  assert.equal((await scanOf(c1)).decision, 'strike');
  let mine = (await u.get('/api/me/strikes')).data;
  assert.equal(mine.strikes.length, 1);
  const s1 = mine.strikes[0];
  assert.deepEqual([s1.level, s1.step, s1.status, s1.score, s1.label, s1.timeout, s1.canAppeal, s1.post.id], [1, 'warning', 'active', 0.97, 'AI', null, true, c1]);
  assert.match(s1.text, /garden was quiet/);
  assert.ok(Math.abs(s1.expires - s1.created - 90 * 86400000) < 1000);
  const note = (await u.get('/api/notifications')).data.items.find(n => n.kind === 'ai_strike');
  assert.deepEqual(note.strike, { id: s1.id, level: 1, status: 'active', result: null });
  assert.equal((await u.post('/api/status', { body: 'still allowed after a warning' })).status, 201);
  assert.equal((await scanOf(await say(0.99, 2))).decision, 'same_incident', 'one strike per 24 hours');
  assert.equal((await scanOf(await say(0.94, 3))).decision, 'clear', 'under 0.95 never strikes');

  sql(`UPDATE ai_strikes SET created = created - 25 * 3600000 WHERE user_id = ${u.id}`);
  const c4 = await say(0.99, 4);
  assert.equal((await scanOf(c4)).decision, 'strike');
  mine = (await u.get('/api/me/strikes')).data;
  const s2 = mine.strikes[0];
  assert.deepEqual([s2.level, s2.step], [2, 'timeout']);
  assert.ok(Math.abs(s2.timeout.until - s2.created - 86400000) < 1000, 'a day');
  assert.equal(mine.timeoutUntil, s2.timeout.until);
  const blocked = await u.post('/api/status', { body: 'can I post?' });
  assert.deepEqual([blocked.status, blocked.data.code, blocked.data.until], [403, 'timeout', s2.timeout.until]);
  assert.equal((await u.post(`/api/threads/${thread}/comments`, { body: 'or comment?' })).status, 403);
  assert.equal((await u.post('/api/ourspace/messages', { body: 'chat still works' })).status, 201);

  // the appeal: the timeout stands until a moderator decides
  assert.equal((await u.post(`/api/me/strikes/${s2.id}/appeal`, { note: '' })).status, 400);
  const ap = await u.post(`/api/me/strikes/${s2.id}/appeal`, { note: 'I wrote every word of that myself, about my garden.' });
  assert.deepEqual([ap.status, ap.data.strike.status, ap.data.strike.canAppeal], [200, 'appealed', false]);
  assert.equal((await u.post(`/api/me/strikes/${s2.id}/appeal`, { note: 'again' })).status, 409);
  assert.equal((await u.post('/api/status', { body: 'still timed out' })).status, 403);
  const mod = await moderator();
  const queue = (await mod.get('/api/admin/appeals')).data.strikes;
  const mine2 = queue.find(s => s.id === s2.id);
  assert.deepEqual([mine2.user.name, mine2.appeal.note, mine2.level], [u.name, 'I wrote every word of that myself, about my garden.', 2]);
  assert.equal((await mod.post(`/api/admin/strikes/${s1.id}`, { action: 'uphold' })).status, 409, 'only an appealed strike is upheld');
  sql(`DELETE FROM attempts WHERE k = 'post:${u.id}'`);                      // (it posted a lot this minute)
  const dec = await mod.post(`/api/admin/strikes/${s2.id}`, { action: 'remove', note: 'reads like a person' });
  assert.deepEqual([dec.status, dec.data.strike.status, dec.data.strike.appeal.result, dec.data.strike.timeout], [200, 'removed', 'removed', null]);
  assert.equal((await u.post('/api/status', { body: 'free again' })).status, 201, 'removing it lifts the timeout');
  assert.ok((await u.get('/api/notifications')).data.items.some(n => n.kind === 'ai_appeal' && n.strike.id === s2.id && n.strike.result === 'removed'));
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'remove_strike' && l.targetId === s2.id));
  assert.equal((await scanOf(await say(0.99, 5))).decision, 'exempt', '180 days without automatic strikes after a removal');
});

test('AI strikes: the 5th goes to a moderator, who decides on a ban; nothing bans by itself', async () => {
  const u = await newUser('fifth');
  const now = Date.now();
  sql(`INSERT INTO ai_strikes (user_id, level, text, score, label, model, created, expires) VALUES ${[1, 2, 3, 4].map(l => `(${u.id}, ${l}, 'old', 0.99, 'AI', 'mock', ${now - (6 - l) * 3 * 86400000}, ${now + 80 * 86400000})`).join(', ')}`);
  const t = (await u.post('/api/boards/random/threads', { subject: 'fifth', body: judged(0.99, 9) }, { 'X-Test-Enforcement': 'enforce' })).data.thread.id;
  assert.equal((await scanOf(t)).decision, 'strike');
  const s5 = (await u.get('/api/me/strikes')).data.strikes[0];
  assert.deepEqual([s5.level, s5.step, s5.timeout], [5, 'review', null]);
  assert.equal((await u.get('/api/me')).data.user.name, u.name, 'not banned by the ladder');
  const mod = await moderator();
  const alert = (await mod.get('/api/admin/alerts')).data.alerts.find(a => a.kind === 'ban_review' && a.users[0].id === u.id);
  assert.deepEqual([alert.details.level, alert.details.strike], [5, s5.id]);
  assert.equal((await mod.post(`/api/admin/alerts/${alert.id}`, { action: 'ban', note: 'five strikes, appeals denied' })).status, 200);
  assert.equal((await u.get('/api/me')).data.user, null, 'the moderator\'s ban signs them out');
});

test('the cron: sign-up signals and AI scores go after 90 days, fingerprints after 7, strikes expire after 90 clean days', async () => {
  const u = await newUser('retain');
  await u.post('/api/status', { body: 'enough words here to get a fingerprint for the duplicate check today' });
  const old = Date.now() - 91 * 86400000;
  sql(`UPDATE signup_signals SET created = ${old} WHERE user_id = ${u.id};
    UPDATE post_fingerprints SET created = ${Date.now() - 8 * 86400000} WHERE user_id = ${u.id};
    INSERT INTO ai_scans (user_id, kind, words, decision, created) VALUES (${u.id}, 'status', 120, 'clear', ${old});
    INSERT INTO ai_strikes (user_id, level, text, score, label, model, created, expires) VALUES (${u.id}, 1, 'flagged words', 0.99, 'AI', 'mock', ${old}, ${old + 90 * 86400000 - 1});
    INSERT INTO spent_nonces (nonce, expires) VALUES ('old-${u.id}', ${Date.now() - 1000});`);
  const left = () => sql(`SELECT (SELECT COUNT(*) FROM signup_signals WHERE user_id = ${u.id}) + (SELECT COUNT(*) FROM post_fingerprints WHERE user_id = ${u.id})
    + (SELECT COUNT(*) FROM ai_scans WHERE user_id = ${u.id}) + (SELECT COUNT(*) FROM spent_nonces WHERE nonce = 'old-${u.id}') AS n`)[0].n;
  assert.equal(left(), 4);
  await runCronAs('*/30 * * * *', async () => left() === 0);
  assert.equal(left(), 0);
  const s = (await u.get('/api/me/strikes')).data.strikes[0];
  assert.deepEqual([s.status, s.counting, s.canAppeal], ['expired', false, false]);
});

test('the bot simulator: floods without the checks are refused, a datacenter flood is held, spam copies past the second are held; a real person gets in', async () => {
  const lines = [];
  const res = await runBotSim({ base: BASE, n: 4, readLog: () => serverLog, log: s => lines.push(s) });
  console.log(lines.map(l => '  # ' + l).join('\n'));
  for (const k of ['no_form', 'no_pow', 'no_turnstile', 'replayed_form', 'honeypot', 'too_fast', 'declared_agent', 'throwaway_email'])
    assert.equal(res[k].refused, res[k].attempts, k + ': every attempt refused');
  assert.ok(res.datacenter.held + res.datacenter.refused >= res.datacenter.attempts - 1, 'a datacenter flood: all but the first held');
  // the first two copies stay up (nobody's earlier post is ever held: a moderator has the alert); every later one waits
  assert.deepEqual([res.duplicate_spam.public, res.duplicate_spam.held, res.duplicate_spam.stillPublic], [2, 3, 2]);
  assert.deepEqual(res.real_person, { signedUp: true, held: false, verified: true, posted: true, pass: true });
});
