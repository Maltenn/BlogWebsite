// End-to-end API tests: `npm test`. Boots `wrangler dev` on a throwaway local database, with a stand-in for Google,
// Apple, Microsoft, Discord, GitHub and Spotify (mock-providers.mjs), then drives the API like a browser does —
// cookies, redirects, JSON, the lot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-providers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER = `ourspace-social-test-${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-test-'));
let server, mock;
let serverLog = '';

const sql = command => JSON.parse(execFileSync(WRANGLER, ['d1', 'execute', 'ourspace-social-db', '--local', '--persist-to', STATE, '--json', '--command', command],
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
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'ourspace-social-db', '--local', '--persist-to', STATE], { cwd: ROOT, stdio: 'pipe' });
  // a unique name: the local explorer is shared by every running `wrangler dev`
  server = spawn(WRANGLER, ['dev', '--name', WORKER, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE,
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
  if (server) server.kill('SIGTERM');
  if (mock) await mock.close();
  fs.rmSync(STATE, { recursive: true, force: true });
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

test('friend requests, Requests tab and Inbox are people-only', async () => {
  const a = await newUser('alice'); const b = await newUser('bob');
  assert.equal((await b.get('/api/me')).data.counts.requests, 0);
  assert.equal((await b.get('/api/inbox')).data.threads.length, 0, 'nobody writes to you unless a person does');
  assert.equal((await a.post('/api/friends/' + b.name)).data.status, 'requested');
  assert.equal((await b.get('/api/me')).data.counts.requests, 1);
  assert.equal((await b.get('/api/requests')).data.incoming[0].user.name, a.name);
  assert.equal((await b.post('/api/friends/' + a.name)).data.status, 'friends');
  assert.equal((await a.get('/api/users/' + b.name)).data.relation.friend, 'friends');
  assert.ok((await a.get('/api/feed?scope=friends')).data.items.some(i => i.kind === 'friends'));
  await a.del('/api/friends/' + b.name);
  assert.equal((await a.get('/api/users/' + b.name)).data.relation.friend, 'none');
});

test('wall comments, deleting them, and friends-only walls', async () => {
  const a = await newUser('wallowner'); const b = await newUser('commenter');
  const post = await b.post(`/api/users/${a.name}/wall`, { body: 'nice page!!' });
  assert.equal(post.status, 201);
  assert.ok((await client().get('/api/users/' + a.name)).data.wall.some(w => w.id === post.data.id));
  assert.equal((await (await newUser('stranger')).del('/api/posts/' + post.data.id)).status, 403);
  assert.equal((await a.del('/api/posts/' + post.data.id)).status, 200, 'the wall owner may delete comments on their wall');
  await a.put('/api/me/settings', { wallPolicy: 'friends' });
  assert.equal((await b.post(`/api/users/${a.name}/wall`, { body: 'hi again' })).status, 403);
});

test('private messages', async () => {
  const a = await newUser('dm_a'); const b = await newUser('dm_b');
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hey!' })).status, 201);
  assert.equal((await b.get('/api/me')).data.counts.unread, 1);
  assert.equal((await b.get('/api/inbox/' + a.name)).data.messages.at(-1).body, 'hey!');
  assert.equal((await b.get('/api/me')).data.counts.unread, 0);
  await b.put('/api/me/settings', { dmPolicy: 'friends' });
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'again' })).status, 403);
});

test('blocking hides both people from each other and stops contact', async () => {
  const a = await newUser('blocked'); const b = await newUser('blocker');
  await a.post('/api/friends/' + b.name); await b.post('/api/friends/' + a.name);
  await a.post('/api/status', { body: 'status from the person who gets blocked' });
  assert.equal((await b.post('/api/blocks/' + a.name)).status, 200);
  assert.equal((await a.get('/api/users/' + b.name)).status, 404);
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hello?' })).status, 404);
  assert.equal((await a.post(`/api/users/${b.name}/wall`, { body: 'hello?' })).status, 404);
  assert.equal((await a.post('/api/friends/' + b.name)).status, 404);
  const bView = await b.get('/api/users/' + a.name);
  assert.equal(bView.data.relation.blockedByMe, true);
  assert.equal(bView.data.relation.friend, 'none');
  assert.ok(!(await b.get('/api/feed')).data.items.some(i => i.author.id === a.id));
  assert.ok((await client().get('/api/feed')).data.items.some(i => i.author.id === a.id));
  await b.del('/api/blocks/' + a.name);
  assert.equal((await a.get('/api/users/' + b.name)).status, 200);
});

test('reports reach moderators, who can hide posts and ban accounts', async () => {
  const victim = await newUser('victim'); const troll = await newUser('troll'); const mod = await newUser('mod');
  const bad = await troll.post(`/api/users/${victim.name}/wall`, { body: 'a mean comment' });
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'harassment', details: 'again' })).status, 201);
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'nonsense' })).status, 400);
  assert.equal((await mod.get('/api/admin/reports')).status, 403);
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${mod.id}`);
  const rep = (await mod.get('/api/admin/reports')).data.reports.find(r => r.targetId === bad.data.id);
  assert.equal(rep.snapshot.body, 'a mean comment');
  assert.equal((await mod.post('/api/admin/reports/' + rep.id, { action: 'hide_ban', note: 'test' })).status, 200);
  assert.ok(!(await client().get('/api/users/' + victim.name)).data.wall.some(w => w.id === bad.data.id));
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

test('bulletins and blog entries', async () => {
  const c = await newUser('writer');
  assert.equal((await c.post('/api/bulletins', { subject: 'hi all', body: 'first bulletin' })).status, 201);
  assert.ok((await client().get('/api/bulletins')).data.items.some(i => i.subject === 'hi all'));
  assert.equal((await c.post('/api/blog', { title: 'day one', mood: 'giddy', body: 'line one\n\n\n\nline two' })).status, 201);
  assert.equal((await client().get(`/api/users/${c.name}/blog`)).data.entries[0].body, 'line one\n\nline two');
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
  const c = await newUser('leaving');
  await c.post('/api/status', { body: 'goodbye world' });
  assert.equal((await c.del('/api/me', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.del('/api/me', { password: PW })).status, 200);
  assert.equal((await client().get('/api/users/' + c.name)).status, 404);
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.body === 'goodbye world'));
  assert.equal((await client().post('/api/signup', { email: c.email, password: PW, name: c.name, birthday: '1995-08-15', rulesOk: true })).status, 201);
});
