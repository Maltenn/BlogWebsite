// End-to-end API tests: `npm test`. Boots `wrangler dev` on a throwaway local database, with a stand-in for Google,
// Apple, Microsoft, Discord, GitHub and Spotify (helpers/mock-providers.mjs), then drives the API like a browser does —
// cookies, redirects, JSON, photo uploads, the lot. The local R2 bucket is listed through wrangler's local explorer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './helpers/mock-providers.mjs';
import { hot, wilson, RESORT } from '../src/shared/ranking.js';
import { jpeg, png, gif, webp } from './helpers/images.mjs';

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
  const appleKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const vars = {
    SIGNUPS_PER_IP_PER_HOUR: '1000', SIGNUPS_PER_DAY: '1000', TEST_PROVIDER_BASE: mock.base, TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', MICROSOFT_CLIENT_ID: 'm-id', MICROSOFT_CLIENT_SECRET: 'm-secret',
    DISCORD_CLIENT_ID: 'd-id', DISCORD_CLIENT_SECRET: 'd-secret', GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret',
    APPLE_CLIENT_ID: 'page.ourspace.web', APPLE_TEAM_ID: 'TEAM123', APPLE_KEY_ID: 'KEY123', APPLE_PRIVATE_KEY: appleKey,
    SPOTIFY_CLIENT_ID: 's-id', SPOTIFY_CLIENT_SECRET: 's-secret',
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

// a tiny browser: a cookie jar, JSON in and out, redirects left for the test to look at
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
  const call = async (method, url, body, headers) => {
    const res = await raw(method, url, { body, headers });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return {
    raw, jar,
    get: u => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b),
  };
}

let n = 0;
const uniq = () => `${Date.now().toString(36).slice(-4)}${n++}`;
const PW = 'correct-horse-9';
async function newUser(prefix = 'user', extra = {}) {
  const c = client();
  const id = uniq();
  const name = `${prefix}_${id}`;
  const email = `${prefix}.${id}@example.com`;
  const r = await c.post('/api/signup', { email, password: PW, name, birthday: '1995-08-15', rulesOk: true, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  Object.assign(c, { name, email, id: r.data.user.id });
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
  let done;
  if (provider === 'apple') {
    const html = await a.text();
    const field = k => (html.match(new RegExp(`name="${k}" value="([^"]*)"`)) || [])[1];
    done = await c.raw('POST', '/api/oauth/apple/callback', { form: { code: field('code'), state: field('state'), user: '{"name":{"firstName":"Appley"}}' }, headers: { Origin: 'https://appleid.apple.com' } });
  } else {
    const back = new URL(a.headers.get('location'));
    done = await c.raw('GET', back.pathname + back.search);
  }
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
  assert.deepEqual(prov.data.signIn.map(p => p.id).sort(), ['apple', 'discord', 'github', 'google', 'microsoft']);
  assert.equal(prov.data.spotify, true);
  assert.equal((await c.get('/api/users')).data.users.length, 0, 'nobody lives here until people sign up');
  assert.equal((await c.get('/api/users/todd')).status, 404);
  assert.equal((await c.get('/api/feed')).status, 200);
  assert.equal((await c.get('/api/inbox')).status, 401);
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
  assert.equal((await b.get('/api/inbox')).data.threads.length, 0, 'nobody writes to you unless a person does');
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

test('private messages, where "friends only" means both follow each other', async () => {
  const a = await newUser('dm_a'); const b = await newUser('dm_b');
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hey!' })).status, 201);
  assert.equal((await b.get('/api/me')).data.counts.unread, 1);
  assert.equal((await b.get('/api/inbox/' + a.name)).data.messages.at(-1).body, 'hey!');
  assert.equal((await b.get('/api/me')).data.counts.unread, 0);
  await b.put('/api/me/settings', { dmPolicy: 'friends' });
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'again' })).status, 403);
  await a.post('/api/follows/' + b.name);
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'again' })).status, 403, 'following them isn\'t enough');
  await b.post('/api/follows/' + a.name);
  assert.equal((await a.get('/api/users/' + b.name)).data.relation.canMessage, true);
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'again' })).status, 201);
});

test('blocking hides both people from each other, ends their follows and stops contact', async () => {
  const a = await newUser('blocked'); const b = await newUser('blocker');
  await befriend(a, b);
  await a.post('/api/status', { body: 'status from the person who gets blocked' });
  assert.equal((await b.post('/api/blocks/' + a.name)).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM follows WHERE ${a.id} IN (follower_id, followee_id) AND ${b.id} IN (follower_id, followee_id)`)[0].n, 0,
    'both follows are gone');
  assert.equal((await a.get('/api/users/' + b.name)).status, 404);
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hello?' })).status, 404);
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

test('only the receiver can report a message', async () => {
  const a = await newUser('msg_a'); const b = await newUser('msg_b'); const c = await newUser('msg_c');
  const m = await a.post('/api/inbox/' + b.name, { body: 'buy my mixtape' });
  assert.equal((await c.post('/api/reports', { type: 'message', id: m.data.id, reason: 'spam' })).status, 404);
  assert.equal((await b.post('/api/reports', { type: 'message', id: m.data.id, reason: 'spam' })).status, 201);
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
  // Microsoft doesn't promise the address is verified: it's never matched or stored
  const ms = client();
  assert.equal((await viaProvider(ms, 'microsoft', { sub: 'm-' + uniq(), email: owner.email, verified: true })).location, '/join/finish');
  assert.equal((await ms.get('/api/signup/pending')).data.email, null);
});

test('connect GitHub from Settings, log in with it, and disconnect rules', async () => {
  const me = await newUser('linker');
  const sub = String(100000 + n++);
  const linked = await viaProvider(me, 'github', { sub, email: `gh${sub}@example.com`, verified: true, name: 'octo' }, 'link');
  assert.equal(linked.location, '/settings?linked=github');
  assert.deepEqual((await me.get('/api/me/account')).data.identities.map(i => i.provider), ['github']);
  const elsewhere = client();
  assert.equal((await viaProvider(elsewhere, 'github', { sub, verified: true })).location, '/');
  assert.equal((await elsewhere.get('/api/me')).data.user.name, me.name);
  const other = await newUser('thief');
  assert.equal((await viaProvider(other, 'github', { sub, verified: true }, 'link')).location, '/settings?error=identity_taken&provider=github');
  assert.equal((await me.del('/api/me/identities/github')).status, 200, 'fine: there\'s still a password');
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

test('Sign in with Apple answers with a form POST from appleid.apple.com', async () => {
  const c = client();
  const sub = 'apple.' + uniq();
  const r = await viaProvider(c, 'apple', { sub, email: `${sub}@privaterelay.appleid.com`, verified: true });
  assert.equal(r.location, '/join/finish');
  assert.equal(r.authorize.searchParams.get('response_mode'), 'form_post');
  const secret = mock.log.filter(l => l.provider === 'apple').at(-1).form.client_secret;
  const [header, payload] = secret.split('.').slice(0, 2).map(s => JSON.parse(Buffer.from(s, 'base64url').toString()));
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.iss, 'TEAM123');
  assert.equal((await c.get('/api/signup/pending')).data.nameHint, 'Appley');
  assert.equal((await c.post('/api/signup/finish', { name: 'apple_' + uniq(), birthday: '1990-12-25', rulesOk: true })).status, 201);
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
