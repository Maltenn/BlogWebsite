// End-to-end API tests: `npm test`. Boots `wrangler dev` on a throwaway local database (bot replies instant, the
// sign-up limit raised), then drives the API like the page does — cookies, JSON, the lot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER = `ourspace-social-test-${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ourspace-test-'));
let server;
let serverLog = '';

const sql = command => execFileSync(WRANGLER, ['d1', 'execute', 'ourspace-social-db', '--local', '--persist-to', STATE, '--command', command],
  { cwd: ROOT, stdio: 'pipe' });

before(async () => {
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'ourspace-social-db', '--local', '--persist-to', STATE], { cwd: ROOT, stdio: 'pipe' });
  // a unique name: the local explorer (used to fire the cron) is shared by every running `wrangler dev`
  server = spawn(WRANGLER, ['dev', '--name', WORKER, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE,
    '--var', 'BOT_DELAY_SCALE:0', '--var', 'SIGNUPS_PER_IP_PER_HOUR:1000', '--var', 'BOT_POSTS_PER_DAY:480'],
    { cwd: ROOT, stdio: 'pipe' });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/options')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + serverLog);
});

after(() => {
  if (server) server.kill('SIGTERM');
  fs.rmSync(STATE, { recursive: true, force: true });
});

// a tiny browser: remembers its cookie, speaks JSON
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return {
    get: u => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b),
    get cookie() { return cookie; },
  };
}

let n = 0;
async function newUser(prefix = 'user') {
  const c = client();
  const name = `${prefix}_${Date.now().toString(36).slice(-4)}${n++}`;
  const r = await c.post('/api/signup', { name, password: 'correct-horse-9', ageOk: true, rulesOk: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.name = name;
  c.id = r.data.user.id;
  return c;
}

/* ------------------------------------------------------------------ */

test('public pages work logged out, and every bot is labeled', async () => {
  const c = client();
  const opts = await c.get('/api/options');
  assert.ok(opts.data.avatars.length > 100 && opts.data.themes.length === 10);
  const bots = await c.get('/api/users?kind=bots');
  assert.equal(bots.data.users.length, 10);
  assert.ok(bots.data.users.every(u => u.isBot === true));
  const todd = await c.get('/api/users/todd');
  assert.equal(todd.status, 200);
  assert.equal(todd.data.user.isBot, true);
  assert.ok(todd.data.wall.every(w => typeof w.author.isBot === 'boolean'));
  const feed = await c.get('/api/feed');
  assert.ok(feed.data.items.length > 0);
  assert.ok(feed.data.items.every(i => i.author && typeof i.author.isBot === 'boolean'));
  const people = await c.get('/api/feed?scope=people');
  assert.ok(people.data.items.every(i => !i.author.isBot));
  assert.equal((await c.get('/api/inbox')).status, 401);
});

test('sign-up rules', async () => {
  const c = client();
  const base = { name: 'fresh_face', password: 'correct-horse-9', ageOk: true, rulesOk: true };
  assert.equal((await c.post('/api/signup', { ...base, ageOk: false })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, rulesOk: false })).status, 400);
  assert.equal((await c.post('/api/signup', { ...base, name: 'Todd' })).status, 400, 'bot names are reserved');
  assert.equal((await c.post('/api/signup', { ...base, name: 'x_Todd_x' })).status, 201, 'decorated versions are fine');
  assert.equal((await client().post('/api/signup', { ...base, name: 'admin' })).status, 400);
  assert.equal((await client().post('/api/signup', { ...base, name: 'has space' })).status, 400);
  assert.equal((await client().post('/api/signup', { ...base, password: 'short' })).status, 400);
  assert.equal((await client().post('/api/signup', { ...base, password: 'password1' })).status, 400);
  assert.equal((await client().post('/api/signup', { ...base, name: 'X_TODD_X' })).status, 409, 'names are unique ignoring case');
});

test('sessions: log out, wrong password, log back in', async () => {
  const c = await newUser('sess');
  assert.equal((await c.get('/api/me')).data.user.name, c.name);
  assert.match(c.cookie, /^os_sid=/);
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).data.user, null);
  assert.equal((await c.post('/api/login', { name: c.name, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c.post('/api/login', { name: 'nobody_here_x', password: 'nope-nope-nope' })).status, 401);
  const ok = await c.post('/api/login', { name: c.name.toUpperCase(), password: 'correct-horse-9' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).data.user.name, c.name);
});

test('Todd (a bot) welcomes every new person', async () => {
  const c = await newUser('welcome');
  const inbox = await c.get('/api/inbox');
  assert.equal(inbox.data.threads[0].with.name, 'Todd');
  assert.equal(inbox.data.threads[0].with.isBot, true);
  const page = await c.get('/api/users/' + c.name);
  assert.equal(page.data.friendCount, 1);
  assert.equal(page.data.top8[0].name, 'Todd');
  assert.equal(page.data.wall[0].author.name, 'Todd');
  assert.equal((await c.get('/api/me')).data.counts.unread, 1);
  await c.get('/api/inbox/todd');
  assert.equal((await c.get('/api/me')).data.counts.unread, 0, 'opening the thread marks it read');
});

test('editing a profile only accepts values from the lists', async () => {
  const c = await newUser('edit');
  const good = await c.put('/api/me/profile', {
    tag: 'hello world', about: 'i like https://spam.example and grapes', age: '24', theme: 'midnight',
    bgTile: '/assets/tiles/tile_hearts.png', font: 'Georgia, serif', decor: ['/assets/deco_moon.gif'],
    avatar: '/assets/avatars/preset_05.png', interests: { Music: 'weezer', Bogus: 'x' },
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.profile.about, 'i like [link removed] and grapes');
  assert.deepEqual(good.data.profile.theme, { bg: '#0a0a0a', fg: '#e0d5f5', accent: '#c3002f' });
  assert.equal(good.data.profile.interests.Bogus, undefined);
  for (const bad of [{ theme: 'hotpink' }, { bgTile: 'https://evil.example/x.png' }, { font: 'x; background:url(evil)' },
    { avatar: 'https://evil.example/me.png' }, { decor: ['/assets/a.gif', '/assets/b.gif', '/assets/c.gif', '/assets/d.gif'] },
    { age: '10' }, { age: 'twelve' }, { top8: ['todd'] }]) {
    assert.equal((await c.put('/api/me/profile', bad)).status, 400, JSON.stringify(bad));
  }
  const pub = await client().get('/api/users/' + c.name);
  assert.equal(pub.data.user.avatar, '/assets/avatars/preset_05.png');
  assert.equal(pub.data.profile.tag, 'hello world');
});

test('friend requests between people', async () => {
  const a = await newUser('alice'); const b = await newUser('bob');
  assert.equal((await a.post('/api/friends/' + b.name)).data.status, 'requested');
  assert.equal((await b.get('/api/me')).data.counts.requests, 1);
  const reqs = await b.get('/api/requests');
  assert.equal(reqs.data.incoming[0].user.name, a.name);
  assert.equal((await b.post('/api/friends/' + a.name)).data.status, 'friends');
  const page = await a.get('/api/users/' + b.name);
  assert.equal(page.data.relation.friend, 'friends');
  const feed = await a.get('/api/feed?scope=friends');
  assert.ok(feed.data.items.some(i => i.kind === 'friends' && [i.author.name, i.target.name].sort().join() === [a.name, b.name].sort().join()));
  await a.del('/api/friends/' + b.name);
  assert.equal((await a.get('/api/users/' + b.name)).data.relation.friend, 'none');
});

test('a bot accepts a friend request and says thanks on your wall', async () => {
  const c = await newUser('fan');
  assert.equal((await c.post('/api/friends/herp')).data.status, 'friends');
  const page = await c.get('/api/users/' + c.name);
  assert.ok(page.data.wall.some(w => w.author.name === 'herp' && w.author.isBot));
});

test('wall comments, deleting them, and friends-only walls', async () => {
  const a = await newUser('wallowner'); const b = await newUser('commenter');
  const post = await b.post(`/api/users/${a.name}/wall`, { body: 'nice page!!' });
  assert.equal(post.status, 201);
  let page = await client().get('/api/users/' + a.name);
  assert.ok(page.data.wall.some(w => w.id === post.data.id));
  assert.equal((await client().del('/api/posts/' + post.data.id)).status, 401);
  const stranger = await newUser('stranger');
  assert.equal((await stranger.del('/api/posts/' + post.data.id)).status, 403);
  assert.equal((await a.del('/api/posts/' + post.data.id)).status, 200, 'the wall owner may delete comments on their wall');
  page = await client().get('/api/users/' + a.name);
  assert.ok(!page.data.wall.some(w => w.id === post.data.id));
  await a.put('/api/me/settings', { wallPolicy: 'friends' });
  assert.equal((await b.post(`/api/users/${a.name}/wall`, { body: 'hi again' })).status, 403);
});

test('commenting on a bot\'s wall gets an in-character answer on yours', async () => {
  const c = await newUser('wesfan');
  await c.post('/api/users/wavedash_wes/wall', { body: 'who is the best fox player' });
  const page = await c.get('/api/users/' + c.name);
  const reply = page.data.wall.find(w => w.author.name === 'wavedash_wes');
  assert.ok(reply, 'wes answered');
  assert.equal(reply.author.isBot, true);
});

test('private messages, and a bot writing back', async () => {
  const a = await newUser('dm_a'); const b = await newUser('dm_b');
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hey!' })).status, 201);
  assert.equal((await b.get('/api/me')).data.counts.unread, 2, 'Todd\'s welcome + hey!');
  const t = await b.get('/api/inbox/' + a.name);
  assert.equal(t.data.messages.at(-1).body, 'hey!');
  assert.equal((await b.get('/api/me')).data.counts.unread, 1, 'only Todd\'s is left unread');
  await a.post('/api/inbox/patrick', { body: 'hi patrick' });
  const p = await a.get('/api/inbox/patrick');
  assert.equal(p.data.messages.length, 2);
  assert.equal(p.data.with.isBot, true);
  await b.put('/api/me/settings', { dmPolicy: 'friends' });
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'again' })).status, 403);
});

test('blocking hides both people from each other and stops contact', async () => {
  const a = await newUser('blocked'); const b = await newUser('blocker');
  await a.post('/api/friends/' + b.name); await b.post('/api/friends/' + a.name);
  await a.post('/api/status', { body: 'status from the person who gets blocked' });
  assert.equal((await b.post('/api/blocks/' + a.name)).status, 200);
  assert.equal((await a.get('/api/users/' + b.name)).status, 404, 'they can\'t see your page');
  assert.equal((await a.post('/api/inbox/' + b.name, { body: 'hello?' })).status, 404);
  assert.equal((await a.post(`/api/users/${b.name}/wall`, { body: 'hello?' })).status, 404);
  assert.equal((await a.post('/api/friends/' + b.name)).status, 404);
  const bView = await b.get('/api/users/' + a.name);
  assert.equal(bView.data.relation.blockedByMe, true);
  assert.equal(bView.data.relation.canMessage, false);
  assert.equal(bView.data.relation.friend, 'none', 'the friendship ended');
  const feed = await b.get('/api/feed');
  assert.ok(!feed.data.items.some(i => i.author.id === a.id), 'their posts leave your feed');
  assert.ok((await client().get('/api/feed')).data.items.some(i => i.author.id === a.id), 'everyone else still sees them');
  assert.equal((await b.get('/api/blocks')).data.blocked[0].user.name, a.name);
  await b.del('/api/blocks/' + a.name);
  assert.equal((await a.get('/api/users/' + b.name)).status, 200);
});

test('reports reach moderators, who can hide posts and ban accounts', async () => {
  const victim = await newUser('victim'); const troll = await newUser('troll'); const mod = await newUser('mod');
  const bad = await troll.post(`/api/users/${victim.name}/wall`, { body: 'a mean comment' });
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'harassment', details: 'they keep doing this' })).status, 201);
  await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'harassment' });   // duplicate: ignored
  assert.equal((await victim.post('/api/reports', { type: 'post', id: bad.data.id, reason: 'nonsense' })).status, 400);
  assert.equal((await victim.post('/api/reports', { type: 'user', name: troll.name, reason: 'spam' })).status, 201);
  assert.equal((await mod.get('/api/admin/reports')).status, 403, 'only moderators see reports');

  sql(`UPDATE users SET is_admin = 1 WHERE id = ${mod.id}`);
  const list = await mod.get('/api/admin/reports');
  const postReports = list.data.reports.filter(r => r.type === 'post' && r.targetId === bad.data.id);
  assert.equal(postReports.length, 1);
  assert.equal(postReports[0].snapshot.body, 'a mean comment');
  assert.equal((await mod.get('/api/me')).data.counts.reports >= 2, true);

  assert.equal((await mod.post('/api/admin/reports/' + postReports[0].id, { action: 'hide_ban', note: 'test' })).status, 200);
  const page = await client().get('/api/users/' + victim.name);
  assert.ok(!page.data.wall.some(w => w.id === bad.data.id), 'the comment is hidden');
  assert.equal((await troll.get('/api/me')).data.user, null, 'the troll is logged out');
  assert.equal((await troll.post('/api/login', { name: troll.name, password: 'correct-horse-9' })).status, 403);
  assert.equal((await client().get('/api/users/' + troll.name)).status, 404);
  const closed = await mod.get('/api/admin/reports?status=closed');
  assert.ok(closed.data.reports.some(r => r.targetId === bad.data.id && r.status === 'actioned'));
  assert.ok((await mod.get('/api/admin/log')).data.log.some(l => l.action === 'ban'));
  assert.equal((await mod.post('/api/admin/users/' + troll.name, { banned: false })).status, 200);
  assert.equal((await troll.post('/api/login', { name: troll.name, password: 'correct-horse-9' })).status, 200);
});

test('only the receiver can report a message', async () => {
  const a = await newUser('msg_a'); const b = await newUser('msg_b'); const c = await newUser('msg_c');
  const m = await a.post('/api/inbox/' + b.name, { body: 'buy my mixtape' });
  assert.equal((await c.post('/api/reports', { type: 'message', id: m.data.id, reason: 'spam' })).status, 404);
  assert.equal((await a.post('/api/reports', { type: 'message', id: m.data.id, reason: 'spam' })).status, 404);
  assert.equal((await b.post('/api/reports', { type: 'message', id: m.data.id, reason: 'spam' })).status, 201);
});

test('cross-site and non-JSON writes are refused', async () => {
  const c = await newUser('csrf');
  assert.equal((await c.post('/api/status', { body: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.post('/api/status', { body: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const res = await fetch(BASE + '/api/status', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: c.cookie }, body: '{"body":"x"}' });
  assert.equal(res.status, 415);
  assert.equal((await c.post('/api/status', { body: 'same-origin is fine' }, { Origin: BASE })).status, 201);
});

test('posting too fast is rate limited', async () => {
  const c = await newUser('spammer');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c.post('/api/status', { body: 'spam ' + i })).status);
  assert.deepEqual(codes.slice(0, 6), [201, 201, 201, 201, 201, 201]);
  assert.equal(codes[6], 429);
});

test('bulletins and blog entries', async () => {
  const c = await newUser('writer');
  assert.equal((await c.post('/api/bulletins', { subject: 'hi all', body: 'first bulletin' })).status, 201);
  assert.ok((await client().get('/api/bulletins')).data.items.some(i => i.subject === 'hi all'));
  assert.equal((await c.post('/api/blog', { title: 'day one', mood: 'giddy', body: 'line one\n\n\n\nline two' })).status, 201);
  const blog = await client().get(`/api/users/${c.name}/blog`);
  assert.equal(blog.data.entries[0].body, 'line one\n\nline two');
  assert.equal((await client().get('/api/users/' + c.name)).data.blogCount, 1);
});

test('the bots post on their own schedule (10 a run at BOT_POSTS_PER_DAY=480)', async () => {
  const newest = (await client().get('/api/feed')).data.items[0].id;
  // wrangler's local explorer runs the Worker's scheduled() handler (/__scheduled is a page route here: SPA fallback)
  const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=${WORKER}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: '*/30 * * * *' }) });
  assert.ok(res.ok, 'cron ran');
  await new Promise(r => setTimeout(r, 1500));
  const fresh = (await client().get('/api/feed')).data.items.filter(i => i.id > newest);
  assert.ok(fresh.length >= 5, `bots posted ${fresh.length}`);
  assert.ok(fresh.every(i => i.author.isBot), 'only bots post on the schedule');
});

test('deleting an account removes it and frees the name', async () => {
  const c = await newUser('leaving');
  await c.post('/api/status', { body: 'goodbye world' });
  assert.equal((await c.del('/api/me', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.del('/api/me', { password: 'correct-horse-9' })).status, 200);
  assert.equal((await client().get('/api/users/' + c.name)).status, 404);
  assert.ok(!(await client().get('/api/feed')).data.items.some(i => i.body === 'goodbye world'));
  assert.equal((await client().post('/api/signup', { name: c.name, password: 'correct-horse-9', ageOk: true, rulesOk: true })).status, 201);
});
