// End-to-end API tests: `npm test`. Boots `wrangler dev` on a throwaway local database, with a stand-in for Google,
// Apple, Microsoft, Discord, GitHub and Spotify (helpers/mock-providers.mjs), then drives the API like a browser does —
// cookies, redirects, JSON, the lot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './helpers/mock-providers.mjs';

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
    SIGNUPS_PER_IP_PER_HOUR: '1000', TEST_PROVIDER_BASE: mock.base, TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
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
  assert.deepEqual(page.data.counts, { followers: 1, following: 1, friends: 1, statuses: 0, blog: 0, comments: 0 });
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
  assert.deepEqual((await client().get('/api/users/' + a.name)).data.counts, { followers: 0, following: 0, friends: 0, statuses: 0, blog: 0, comments: 0 });
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
  assert.deepEqual(oldView.data.counts, { followers: 1, following: 0, friends: 0, statuses: 1, blog: 1, comments: 0 });
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
  assert.deepEqual(Object.keys(r.data.comments[0]).sort(), ['author', 'body', 'canDelete', 'created', 'id']);
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
  assert.deepEqual((await client().get('/api/users/' + owner.name)).data.counts, { followers: 4, following: 4, friends: 4, statuses: 2, blog: 1, comments: 23 });
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

test('bulletins, blog posts with a subtitle, and a blog post\'s own page', async () => {
  const c = await newUser('writer');
  assert.equal((await c.post('/api/bulletins', { subject: 'hi all', body: 'first bulletin' })).status, 201);
  assert.ok((await client().get('/api/bulletins')).data.items.some(i => i.subject === 'hi all'));
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.kind === 'bulletin'), 'bulletins stay out of the feed');
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
  const bye = await c.post('/api/status', { body: 'goodbye world' });
  const status = (await c.get('/api/posts/' + bye.data.id)).data.post;
  await c.put('/api/me/markers/feed', { created: status.created, id: status.id });
  assert.equal((await c.del('/api/me', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.del('/api/me', { password: PW })).status, 200);
  assert.equal((await client().get('/api/users/' + c.name)).status, 404);
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.body === 'goodbye world'));
  assert.equal(sql(`SELECT (SELECT COUNT(*) FROM follows WHERE ${c.id} IN (follower_id, followee_id)) + (SELECT COUNT(*) FROM markers WHERE user_id = ${c.id}) AS n`)[0].n, 0,
    'its follows and markers are gone');
  assert.deepEqual((await client().get('/api/users/' + pal.name)).data.counts, { followers: 0, following: 0, friends: 0, statuses: 0, blog: 0, comments: 0 });
  assert.equal((await client().post('/api/signup',{ email: c.email, password: PW, name: c.name, birthday: '1995-08-15', rulesOk: true })).status, 201);
});
