// Push, without a server: the signed tokens for APNs and FCM, the gate that keeps it all silent until the secrets are set,
// and how each service's answers are read. (The whole path, from a notification to a phone, is in api.test.mjs, against a
// stand-in for both services.) What a real APNs or FCM does with these can only be checked with real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { signJwt, pemBytes } from '../src/push/jwt.js';
import { apnsReady, sendApns } from '../src/push/apns.js';
import { fcmReady, sendFcm } from '../src/push/fcm.js';
import { pushReady } from '../src/push/push.js';
import { appClient, bearerToken, ticketProtocol, echoProtocol, tokenRequest, corsFor, APP_ORIGINS } from '../src/shared/app.js';

const pem = k => k.export({ type: 'pkcs8', format: 'pem' }).toString();
const EC = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const unb64 = s => JSON.parse(Buffer.from(s, 'base64url').toString());
const req = (headers = {}) => ({ headers: new Headers(headers) });

test('signed tokens: ES256 (raw r||s, as JWT wants) and RS256 verify with the public key, and a pasted key works however its lines were broken', async () => {
  const claims = { iss: 'TEAM', iat: 1700000000 };
  const jwt = await signJwt('ES256', pem(EC.privateKey), { kid: 'KEY' }, claims);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(unb64(h), { alg: 'ES256', typ: 'JWT', kid: 'KEY' });
  assert.deepEqual(unb64(c), claims);
  assert.equal(Buffer.from(s, 'base64url').length, 64, 'r and s, 32 bytes each (not DER)');
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: EC.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  const rs = (await signJwt('RS256', pem(RSA.privateKey), {}, claims)).split('.');
  assert.deepEqual(unb64(rs[0]), { alg: 'RS256', typ: 'JWT' });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${rs[0]}.${rs[1]}`), RSA.publicKey, Buffer.from(rs[2], 'base64url')));
  // the key as a secret is often pasted with its breaks written as \n, with them lost, or without its header lines
  const real = pem(EC.privateKey);
  const forms = [real, real.replace(/\n/g, '\\n'), real.replace(/\n/g, ' '), real.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, ''), '  ' + real + '\n\n'];
  for (const f of forms) assert.deepEqual(pemBytes(f), pemBytes(real));
  await assert.doesNotReject(signJwt('ES256', forms[1], {}, claims));
});

test('push is silent until its secrets are all set (pushReady), like mailReady', () => {
  const apns = { APNS_KEY_P8: 'k', APNS_KEY_ID: 'id', APNS_TEAM_ID: 't', APNS_TOPIC: 'page.ourspace.app' };
  const fcm = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b', private_key: 'k', project_id: 'p' }) };
  assert.equal(pushReady({}), false);
  assert.equal(pushReady({ APNS_KEY_ID: 'id', APNS_TEAM_ID: 't' }), false, 'a part of a set is nothing');
  for (const missing of Object.keys(apns)) assert.equal(apnsReady({ ...apns, [missing]: '' }), false, missing);
  assert.equal(apnsReady(apns), true);
  assert.equal(pushReady(apns), true);
  assert.equal(fcmReady({ FCM_SERVICE_ACCOUNT_JSON: 'not json' }), false);
  assert.equal(fcmReady({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b' }) }), false, 'no key, no project');
  assert.equal(fcmReady(fcm), true);
  assert.equal(pushReady(fcm), true);
  assert.equal(pushReady({ ...apns, APNS_TOPIC: '' }), false);
});

// runs `fn` with fetch standing in for the push services: `answers` are their replies, in order; `calls` is what was asked
async function withFetch(answers, fn, exchange = { status: 200, body: { access_token: 'ya29.abc', expires_in: 3600 } }) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const a = String(url).startsWith('https://oauth2.example/') ? exchange : answers.shift();
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  };
  try { return [await fn(), calls]; } finally { globalThis.fetch = real; }
}

test('APNs: the request Apple wants, the provider token reused, and its answers read as ok / gone / retry / drop', async () => {
  const env = { APNS_KEY_P8: pem(EC.privateKey), APNS_KEY_ID: 'KEYID', APNS_TEAM_ID: 'TEAMID', APNS_TOPIC: 'page.ourspace.app' };
  const msg = { title: 'ann', body: 'liked your post', url: '/u/bob/post/7', kind: 'like' };
  const now = 1800000000000;
  const [first, calls] = await withFetch([{ status: 200 }, { status: 200 }], async () => [await sendApns(env, 'a1b2', msg, now), await sendApns(env, 'c3d4', msg, now + 5 * 60000)]);
  assert.deepEqual(first, ['ok', 'ok']);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.push.apple.com/3/device/a1b2');
  assert.equal(init.method, 'POST');
  assert.deepEqual([init.headers['apns-topic'], init.headers['apns-push-type'], init.headers['apns-priority'], init.headers['apns-expiration']], ['page.ourspace.app', 'alert', '10', String(now / 1000 + 86400)]);
  assert.deepEqual(JSON.parse(init.body), { aps: { alert: { title: 'ann', body: 'liked your post' }, sound: 'default' }, url: '/u/bob/post/7', kind: 'like' });
  const [h, c, s] = init.headers.authorization.replace(/^bearer /, '').split('.');
  assert.deepEqual([unb64(h).alg, unb64(h).kid, unb64(c)], ['ES256', 'KEYID', { iss: 'TEAMID', iat: now / 1000 }]);
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: EC.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(calls[1].init.headers.authorization, init.headers.authorization, 'Apple wants the token reused, not minted per push');

  const answer = async a => (await withFetch([a], () => sendApns(env, 'tok', msg, now + 10 * 60000)))[0];
  assert.equal(await answer({ status: 410, body: { reason: 'Unregistered' } }), 'gone');
  assert.equal(await answer({ status: 400, body: { reason: 'BadDeviceToken' } }), 'gone');
  assert.equal(await answer({ status: 400, body: { reason: 'PayloadEmpty' } }), 'drop');
  assert.equal(await answer({ status: 429 }), 'retry');
  assert.equal(await answer({ status: 503 }), 'retry');
  assert.equal(await answer(new Error('connection reset')), 'retry');
  assert.equal(await answer({ status: 403, body: { reason: 'ExpiredProviderToken' } }), 'retry');
  const [, again] = await withFetch([{ status: 200 }], () => sendApns(env, 'tok', msg, now + 10 * 60000));
  assert.notEqual(again[0].init.headers.authorization, init.headers.authorization, 'after a 403 a new token is made');
  const [, sandbox] = await withFetch([{ status: 200 }], () => sendApns({ ...env, APNS_SANDBOX: '1' }, 'tok', msg, now));
  assert.equal(sandbox[0].url, 'https://api.sandbox.push.apple.com/3/device/tok');
});

test('FCM: the service account\'s token is fetched once and reused, the message is v1, and its answers are read', async () => {
  const account = { client_email: 'push@proj.iam.gserviceaccount.com', private_key: pem(RSA.privateKey), private_key_id: 'kid1', project_id: 'proj-1', token_uri: 'https://oauth2.example/token' };
  const env = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account) };
  const msg = { title: 'ann', body: 'hi', url: '/messages/3', kind: 'chat_message' };
  const now = 1800000000000;
  const [out, calls] = await withFetch([{ status: 200 }, { status: 200 }],
    async () => [await sendFcm(env, 'reg-token-1', msg, now), await sendFcm(env, 'reg-token-2', msg, now + 60000)]);
  assert.deepEqual(out, ['ok', 'ok']);
  assert.equal(calls.length, 3, 'one token exchange, two sends');
  assert.equal(calls[0].url, 'https://oauth2.example/token');
  const form = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, s] = form.get('assertion').split('.');
  assert.deepEqual([unb64(h).alg, unb64(h).kid], ['RS256', 'kid1']);
  assert.deepEqual(unb64(c), { iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: account.token_uri, iat: now / 1000, exp: now / 1000 + 3600 });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), RSA.publicKey, Buffer.from(s, 'base64url')));
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ya29.abc');
  assert.deepEqual(JSON.parse(calls[1].init.body), { message: { token: 'reg-token-1', notification: { title: 'ann', body: 'hi' }, data: { url: '/messages/3', kind: 'chat_message' }, android: { priority: 'HIGH' } } });

  const later = now + 2 * 3600000;                           // (the first token has run out)
  const answer = async a => (await withFetch([a], () => sendFcm(env, 'reg', msg, later), { status: 200, body: { access_token: 'ya29.def', expires_in: 3600 } }))[0];
  assert.equal(await answer({ status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }), 'gone');
  assert.equal(await answer({ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }), 'drop');
  assert.equal(await answer({ status: 429 }), 'retry');
  assert.equal(await answer({ status: 500 }), 'retry');
  assert.equal(await answer({ status: 401 }), 'retry');
  assert.equal((await withFetch([], () => sendFcm({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, client_email: 'other@x' }) }, 'reg', msg, later), { status: 500, body: { error: 'nope' } }))[0], 'retry', 'a token exchange that fails is tried again later');
  assert.equal(await sendFcm({ FCM_SERVICE_ACCOUNT_JSON: 'broken' }, 'reg', msg, now), 'drop');
});

test('the app\'s way in: who is an app, where a token may come from, which requests have ambient credentials', () => {
  assert.deepEqual(appClient(req({ 'X-OurSpace-Client': 'app/ios/1.2.3' })), { platform: 'ios', version: '1.2.3' });
  assert.deepEqual(appClient(req({ 'X-OurSpace-Client': 'app/android/2.0.0-beta+4' })), { platform: 'android', version: '2.0.0-beta+4' });
  for (const bad of ['', 'app/windows/1', 'web/ios/1', 'app/ios', 'app/ios/', 'app/ios/1 evil', 'App/ios/1', 'app/ios/' + '1'.repeat(40)]) assert.equal(appClient(req({ 'X-OurSpace-Client': bad })), null, bad);
  assert.equal(appClient(req()), null);

  assert.equal(bearerToken(req({ Authorization: 'Bearer abc.DEF-_9' })), 'abc.DEF-_9');
  assert.equal(bearerToken(req({ Authorization: 'bearer abc' })), 'abc');
  for (const bad of ['Basic abc', 'Bearer', 'Bearer ', 'Bearer a b', 'abc']) assert.equal(bearerToken(req({ Authorization: bad })), null, bad);
  // A subprotocol is NOT a session token, on an upgrade or anywhere else (redteam R8, contract §7): what rides there
  // is a one-room ticket, and the handshake answers with a fixed name instead of echoing it.
  const sub = { 'Sec-WebSocket-Protocol': 'ourspace.live, ourspace.bearer.tick123' };
  assert.equal(bearerToken(req(sub)), null);
  assert.equal(bearerToken(req({ ...sub, Upgrade: 'websocket' })), null, 'the one place the token used to leak');

  // the ticket, and only on an upgrade: nowhere else is a subprotocol a credential
  assert.equal(ticketProtocol(req(sub)), null);
  assert.equal(ticketProtocol(req({ ...sub, Upgrade: 'websocket' })), 'tick123');
  assert.equal(ticketProtocol(req({ 'Sec-WebSocket-Protocol': 'chat, ourspace.bearer.tick123', Upgrade: 'WebSocket' })), 'tick123', 'whichever of several');
  assert.equal(ticketProtocol(req({ 'Sec-WebSocket-Protocol': 'ourspace.bearer.', Upgrade: 'websocket' })), null, 'an empty one is nothing');
  assert.equal(ticketProtocol(req({ Upgrade: 'websocket' })), null);

  // what comes back in the 101: the fixed name when offered, and otherwise nothing at all
  assert.equal(echoProtocol(req(sub)), 'ourspace.live');
  assert.equal(echoProtocol(req({ 'Sec-WebSocket-Protocol': 'ourspace.bearer.tick123' })), null, 'never the credential');
  assert.equal(echoProtocol(req({ 'Sec-WebSocket-Protocol': 'chat' })), null);
  assert.equal(echoProtocol(req()), null, 'our own pages offer none and get none');

  assert.equal(tokenRequest(req({ Authorization: 'Bearer abc' })), true);
  assert.equal(tokenRequest(req({ 'X-OurSpace-Client': 'app/ios/1' })), true);
  assert.equal(tokenRequest(req({ Authorization: 'Bearer abc', Cookie: 'a=b; os_sid=xyz' })), false, 'any session cookie puts the check back');
  assert.equal(tokenRequest(req({ Authorization: 'Bearer abc', Cookie: 'os_sid=' })), false);
  assert.equal(tokenRequest(req({ Authorization: 'Bearer abc', Cookie: 'other_os_sid=1' })), true, 'only the cookie called os_sid');
  assert.equal(tokenRequest(req({ Origin: 'capacitor://localhost' })), false, 'an origin proves nothing');
  assert.equal(tokenRequest(req()), false);

  assert.deepEqual(APP_ORIGINS, ['capacitor://localhost', 'http://localhost', 'https://localhost']);
  for (const o of APP_ORIGINS) assert.equal(corsFor(req({ Origin: o })), o);
  for (const o of ['http://localhost:3000', 'https://localhost.evil.com', 'capacitor://localhost/', 'null', 'https://ourspace.page']) assert.equal(corsFor(req({ Origin: o })), null, o);
  assert.equal(corsFor(req()), null);
});

/* ---------------------------------------------------------------------------------------------------------------
   The server side against a real SQLite (node:sqlite, in memory), with every migration applied and a thin stand-in
   for D1's prepare/bind/all/first/run/batch. The outbox, the cron's claim, the sessions and the photo rules are SQL,
   so this runs the actual statements (the end-to-end path through workerd is in api.test.mjs).
   --------------------------------------------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { drainPush, pushChat } from '../src/push/push.js';
import { currentUser, DEVICE_MAX_DAYS } from '../src/accounts/auth.js';
import { serveMedia } from '../src/media/media.js';
import { sha256Hex } from '../src/shared/http.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const DAY = 86400000;

// the database as the first `upTo` migration files left it (all of them by default)
function database(upTo = Infinity) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) if (Number(f.slice(0, 4)) <= upTo) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  return db;
}
// a D1 look-alike over it; rows come back as plain objects
function d1(db) {
  // (node:sqlite binds ?1, ?2 ... by order of appearance, not by number, so they become named parameters first)
  const bound = (sql, args) => (/\?\d/.test(sql) ? [sql.replace(/\?(\d+)/g, ':p$1'), [Object.fromEntries(args.map((v, i) => ['p' + (i + 1), v]))]] : [sql, args]);
  const rows = (sql, args) => { const [q, a] = bound(sql, args); return db.prepare(q).all(...a).map(r => ({ ...r })); };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: rows(sql, args) }),
    first: async () => rows(sql, args)[0] ?? null,
    run: async () => { const [q, a] = bound(sql, args); db.prepare(q).run(...a); return { success: true }; },
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.all()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const all = (db, sql, ...a) => db.prepare(sql).all(...a).map(r => ({ ...r }));
const exec = (db, sql, ...a) => db.prepare(sql).run(...a);

let seq = 1000;
const addUser = (db, name, extra = '') => {
  const id = ++seq;
  exec(db, `INSERT INTO users (id, name, name_key, avatar, birthdate, created) VALUES (?, ?, ?, '/a.png', '1990-01-01', 1)`, id, name, name.toLowerCase() + id);
  if (extra) exec(db, `UPDATE users SET ${extra} WHERE id = ?`, id);
  return id;
};
// a signed-in app on a phone with a push token; → the device's id
const addPhone = (db, user, token, { provider = 'apns', now = Date.now(), expires = now + 60 * DAY } = {}) => {
  const hash = `sess-${user}-${token}`;
  exec(db, 'INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', hash, user, now, expires);
  return Number(exec(db, `INSERT INTO devices (user_id, token_hash, platform, label, push_token, push_provider, created, last_seen) VALUES (?, ?, ?, 'phone', ?, ?, ?, ?)`,
    user, hash, provider === 'apns' ? 'ios' : 'android', token, provider, now, now).lastInsertRowid);
};
const addPost = (db, author, extra = {}) => Number(exec(db, `INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (?, ?, ?, ?, 5)`, extra.kind || 'status', author, extra.target ?? null, extra.body || 'hello').lastInsertRowid);
const like = (db, to, actor, post, now = Date.now()) => Number(exec(db, `INSERT INTO notifications (user_id, kind, actor_id, post_id, created) VALUES (?, 'like', ?, ?, ?)`, to, actor, post, now).lastInsertRowid);
const outbox = db => all(db, 'SELECT id, user_id, notification_id, attempts FROM push_outbox ORDER BY id');

const APNS_ENV = { APNS_KEY_P8: pem(EC.privateKey), APNS_KEY_ID: 'K2', APNS_TEAM_ID: 'T2', APNS_TOPIC: 'page.ourspace.app' };
const FCM_ENV = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'drain@proj.iam.gserviceaccount.com', private_key: pem(RSA.privateKey), project_id: 'proj-2', token_uri: 'https://oauth2.example/token' }) };
const envFor = (db, extra = {}) => ({ DB: d1(db), ...APNS_ENV, ...FCM_ENV, ...extra });

// runs `fn` with fetch standing in for APNs and FCM: `status(token, nth)` is what the nth push to that token gets. → the tokens pushed to, in order
async function pushing(status, fn, bodies = []) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith('https://oauth2.example/')) return new Response(JSON.stringify({ access_token: 'ya29.drain', expires_in: 3600 }), { status: 200 });
    const token = url.startsWith('https://api.push.apple.com/3/device/') ? decodeURIComponent(url.split('/').pop()) : JSON.parse(init.body).message.token;
    sent.push(token);
    bodies.push(String(init.body));
    const code = status(token, sent.filter(t => t === token).length);
    return new Response(JSON.stringify(code === 200 ? {} : { reason: code === 410 ? 'Unregistered' : 'ServiceUnavailable' }), { status: code });
  };
  try { await fn(); } finally { globalThis.fetch = real; }
  return sent;
}

test('0012 gives every outbox line its notification (dropping lines with none), keeps what the trigger writes, and ties lines, devices and notifications together', () => {
  const db = database(10);
  const ann = addUser(db, 'ann'), ben = addUser(db, 'ben');
  const phone = addPhone(db, ann, 'tok-ann');
  const post = addPost(db, ann);
  const a = like(db, ann, ben, post, 100), b = like(db, ann, ben, post, 200);
  const strike = Number(exec(db, `INSERT INTO notifications (user_id, kind, actor_id, created) VALUES (?, 'ai_strike', ?, 250)`, ann, ben).lastInsertRowid);
  assert.equal(all(db, 'SELECT body, url FROM push_outbox WHERE kind = ?', 'ai_strike')[0].body, 'a note about your writing', '(0010 said so)');
  exec(db, `INSERT INTO push_outbox (user_id, kind, title, body, url, created) VALUES (?, 'like', 'ben', 'liked your post', '/x', 300)`, ann);   // (nothing it came from)
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM push_outbox')[0].n, 4);
  db.exec(fs.readFileSync(path.join(MIGRATIONS, '0012_push_shown.sql'), 'utf8'));
  assert.deepEqual(outbox(db).map(l => l.notification_id), [a, b, strike], 'matched by person, kind and moment; the one with no notification is gone');
  assert.deepEqual(all(db, 'SELECT title, body, url FROM push_outbox WHERE notification_id = ?', strike), [{ title: 'ourspace', body: 'you have a notification from OurSpace', url: '/notifications' }], 'a waiting strike line no longer says what it is');
  const fresh = like(db, ann, ben, post, 400);
  const line = all(db, 'SELECT * FROM push_outbox WHERE notification_id = ?', fresh)[0];
  assert.deepEqual([line.title, line.body, line.url, line.created, line.attempts], ['ben', 'liked your post', `/u/ann/post/${post}`, 400, 0], 'the trigger still writes the same line');
  // a line remembers the devices it reached; it goes with the line, or the device
  exec(db, 'INSERT INTO push_sent (outbox_id, device_id) VALUES (?, ?)', line.id, phone);
  exec(db, 'DELETE FROM notifications WHERE id = ?', fresh);
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM push_outbox WHERE id = ?', line.id)[0].n, 0, 'its notification went: so does the line');
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM push_sent')[0].n, 0, '... and what it remembered');
  const other = like(db, ann, ben, post, 500);
  const next = all(db, 'SELECT id FROM push_outbox WHERE notification_id = ?', other)[0].id;
  exec(db, 'INSERT INTO push_sent (outbox_id, device_id) VALUES (?, ?)', next, phone);
  exec(db, 'DELETE FROM devices WHERE id = ?', phone);
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM push_sent')[0].n, 0, 'a device that goes takes its marks');
  assert.throws(() => exec(db, 'INSERT INTO push_sent (outbox_id, device_id) VALUES (9999, 9999)'), 'both ends must exist');
});

test('R6: a notification that stops showing after it was written is never pushed (a later block, hide, ban or delete), and what still shows is', async () => {
  const db = database();
  const ann = addUser(db, 'ann'), blocked = addUser(db, 'blocked'), hider = addUser(db, 'hider'), banned = addUser(db, 'banned'), gone = addUser(db, 'gone'), friend = addUser(db, 'friend');
  addPhone(db, ann, 'ann-phone');
  const p1 = addPost(db, ann), p2 = addPost(db, ann), p3 = addPost(db, ann), p4 = addPost(db, ann);
  like(db, ann, blocked, p1); like(db, ann, hider, p2); like(db, ann, banned, p3); like(db, ann, friend, p3);
  like(db, ann, gone, p4);
  assert.equal(outbox(db).length, 5, 'all five were written: that part was always sound');
  // ... and then, within the minute:
  exec(db, 'INSERT INTO blocks (blocker_id, blocked_id, created) VALUES (?, ?, 1)', ann, blocked);
  exec(db, 'UPDATE posts SET hidden = 1 WHERE id = ?', p2);
  exec(db, 'UPDATE users SET banned = 1 WHERE id = ?', banned);
  exec(db, 'DELETE FROM notifications WHERE actor_id = ?', gone);
  const sent = await pushing(() => 200, () => drainPush(envFor(db), Date.now()));
  assert.deepEqual(sent, ['ann-phone'], 'one push: the like from the friend');
  assert.deepEqual(outbox(db), [], 'and nothing left over, shown or not');
});

test('R12: a retry only goes to the device that asked for it; a device that got the push is not pushed twice', async () => {
  const db = database();
  const ann = addUser(db, 'ann'), ben = addUser(db, 'ben');
  const ios = addPhone(db, ann, 'ios-tok'), droid = addPhone(db, ann, 'droid-tok', { provider: 'fcm' });
  const post = addPost(db, ann);
  like(db, ann, ben, post);
  const env = envFor(db);
  const first = await pushing(tok => (tok === 'ios-tok' ? 503 : 200), () => drainPush(env, Date.now()));
  assert.deepEqual(first.sort(), ['droid-tok', 'ios-tok']);
  assert.deepEqual(outbox(db).map(l => l.attempts), [1], 'kept for the phone that said later');
  assert.deepEqual(all(db, 'SELECT device_id FROM push_sent'), [{ device_id: droid }], 'remembering the one that got it');
  const second = await pushing(() => 200, () => drainPush(env, Date.now()));
  assert.deepEqual(second, ['ios-tok'], 'only the iPhone, the Android phone is not told again');
  assert.deepEqual([outbox(db), all(db, 'SELECT * FROM push_sent')], [[], []]);
  // a token the service calls dead is forgotten and not retried; the line still ends
  const post2 = addPost(db, ann);
  like(db, ann, ben, post2);
  const third = await pushing(tok => (tok === 'ios-tok' ? 410 : 200), () => drainPush(env, Date.now()));
  assert.deepEqual(third.sort(), ['droid-tok', 'ios-tok']);
  assert.deepEqual(all(db, 'SELECT id, push_token FROM devices ORDER BY id'), [{ id: ios, push_token: null }, { id: droid, push_token: 'droid-tok' }]);
  assert.deepEqual(outbox(db), []);
  // a line goes after GIVE_UP tries for a phone that never answers
  like(db, ann, ben, addPost(db, ann));
  let tries = 0;
  for (let i = 0; i < 8; i++) tries += (await pushing(() => 503, () => drainPush(env, Date.now()))).length;
  assert.equal(tries, 5, 'five tries, then dropped');
  assert.deepEqual(outbox(db), []);
});

test('R12: one busy member cannot starve the others, and a run never makes more sends than it may (the free plan\'s 50 subrequests)', async () => {
  const db = database();
  const busy = addUser(db, 'busy'), quiet = addUser(db, 'quiet'), pair = addUser(db, 'pair'), ben = addUser(db, 'ben');
  addPhone(db, busy, 'busy-phone'); addPhone(db, quiet, 'quiet-phone');
  addPhone(db, pair, 'pair-ios'); addPhone(db, pair, 'pair-droid', { provider: 'fcm' });
  for (let i = 0; i < 25; i++) like(db, busy, ben, addPost(db, busy));      // the busy member's likes are the oldest in the outbox
  like(db, quiet, ben, addPost(db, quiet));
  like(db, pair, ben, addPost(db, pair));
  const env = envFor(db, { PUSH_SENDS_PER_RUN: '3' });
  const run1 = await pushing(() => 200, () => drainPush(env, Date.now()));
  assert.equal(run1.length, 3, 'a run makes no more sends than its budget');
  assert.ok(run1.includes('quiet-phone'), 'the quiet member is not kept waiting behind 25 lines: ' + run1);
  assert.equal(run1.filter(t => t === 'busy-phone').length, 1, 'the busy one gets one line per round, like everybody');
  // the rest comes in the following minutes, every device exactly once (nobody is pushed twice, whatever a run cut short)
  const rest = [];
  for (let i = 0; i < 40 && outbox(db).length; i++) rest.push(...await pushing(() => 200, () => drainPush(env, Date.now())));
  const every = [...run1, ...rest];
  const count = t => every.filter(x => x === t).length;
  assert.deepEqual([count('busy-phone'), count('quiet-phone'), count('pair-ios'), count('pair-droid')], [25, 1, 1, 1]);
  assert.deepEqual(outbox(db), []);

  // the default is the free plan's: 50 subrequests, minus the FCM token exchange and some to spare
  for (let i = 0; i < 60; i++) {
    const u = addUser(db, 'member' + i);
    addPhone(db, u, 'm' + i);
    like(db, u, ben, addPost(db, u));
  }
  const first = await pushing(() => 200, () => drainPush(envFor(db), Date.now()));
  assert.equal(first.length, 45, 'at most 45 sends a run');
  const second = await pushing(() => 200, () => drainPush(envFor(db), Date.now()));
  assert.equal(second.length, 15);
  assert.equal(new Set([...first, ...second]).size, 60, 'sixty people, once each');
  assert.deepEqual(outbox(db), []);
});

test('R7: an app\'s session slides to 90 days from use, but never past 180 days from sign-in; a web session never slides', async () => {
  assert.equal(DEVICE_MAX_DAYS, 180);
  const db = database();
  const ann = addUser(db, 'ann');
  const t0 = 1800000000000;
  const token = 'device-token-1';
  exec(db, 'INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', await sha256Hex(token), ann, t0, t0 + 90 * DAY);
  const expires = async () => all(db, 'SELECT expires FROM sessions WHERE token_hash = ?', await sha256Hex(token))[0].expires;
  const use = async (days, bearer = token) => {
    const pending = [];
    const c = { req: new Request('https://ourspace.test/api/me', { headers: { Authorization: 'Bearer ' + bearer } }), env: { DB: d1(db) }, ctx: { waitUntil: p => pending.push(p) }, now: t0 + days * DAY };
    const u = await currentUser(c);
    await Promise.all(pending);
    return u;
  };
  assert.ok(await use(60), 'used on day 60');
  assert.equal(await expires(), t0 + 150 * DAY, 'slid to 90 days from then');
  assert.ok(await use(100));
  assert.equal(await expires(), t0 + 180 * DAY, 'day 100 + 90 would be day 190: held at 180');
  assert.equal((await use(150)).id, ann);
  assert.equal(await expires(), t0 + 180 * DAY, 'no more sliding, however busy');
  assert.equal((await use(179.5)).id, ann, 'good until the day');
  assert.equal(await use(180.01), null, 'then it must sign in again');
  assert.equal(await expires(), t0 + 180 * DAY);
  // a web session (30 days) is not touched by any of it, even if a bearer is used with its token
  const web = 'web-token-1';
  exec(db, 'INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', await sha256Hex(web), ann, t0, t0 + 30 * DAY);
  assert.ok(await use(10, web));
  assert.equal(all(db, 'SELECT expires FROM sessions WHERE token_hash = ?', await sha256Hex(web))[0].expires, t0 + 30 * DAY);
});

// serveMedia against the real tables: who gets a photo, and as what ('public' = Cache-Control public + CORP cross-origin)
async function fetchPhoto(db, key, viewer = null, now = Date.now()) {
  const MEDIA = { get: async () => ({ body: 'bytes', size: 5, httpEtag: '"e"' }), head: async () => ({ size: 5, httpEtag: '"e"' }) };
  const c = { user: viewer, now, env: { DB: d1(db), MEDIA }, req: new Request('https://ourspace.test/media/' + key) };
  const res = await serveMedia(c, key);
  return [res.status, res.headers.get('cross-origin-resource-policy'), res.headers.get('cache-control')];
}
const PUBLIC = [200, 'cross-origin', 'public, max-age=300'], PRIVATE = [200, 'same-origin', 'private, no-store'], NOT_FOUND = [404, 'same-origin', 'no-store'];
const addPhoto = (db, owner, post, { purpose = 'post', attached = 1 } = {}) => {
  const key = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32) + '.png';
  exec(db, `INSERT INTO media (key, owner_id, purpose, mime, bytes, width, height, created, attached, post_id) VALUES (?, ?, ?, 'image/png', 10, 5, 5, 1, ?, ?)`, key, owner, purpose, attached, post);
  return key;
};

test('R10: a photo on a Friends\' Comment follows the page it is on (its owner\'s privacy and blocks), not only its writer\'s', async () => {
  const db = database();
  const owner = addUser(db, 'owner', `follow_policy = 'approve'`), writer = addUser(db, 'writer'), follower = addUser(db, 'follower'), stranger = addUser(db, 'stranger'), openOwner = addUser(db, 'openowner');
  exec(db, `INSERT INTO follows (follower_id, followee_id, status, created) VALUES (?, ?, 'accepted', 1)`, follower, owner);
  const onPrivate = addPost(db, writer, { kind: 'wall', target: owner });      // an open-profile member's comment on a private member's page
  const onOpen = addPost(db, writer, { kind: 'wall', target: openOwner });
  const own = addPost(db, writer);
  const [a, b, c2] = [addPhoto(db, writer, onPrivate), addPhoto(db, writer, onOpen), addPhoto(db, writer, own)];
  const as = id => ({ id, is_admin: 0 });
  assert.deepEqual(await fetchPhoto(db, a), NOT_FOUND, 'logged out: the page is private, whoever wrote the comment');
  assert.deepEqual(await fetchPhoto(db, a, as(stranger)), NOT_FOUND);
  assert.deepEqual(await fetchPhoto(db, a, as(follower)), PRIVATE, 'the page owner\'s follower');
  assert.deepEqual(await fetchPhoto(db, a, as(owner)), PRIVATE, 'the page\'s owner');
  assert.deepEqual(await fetchPhoto(db, a, as(writer)), PRIVATE, 'its writer');
  assert.deepEqual(await fetchPhoto(db, b), PUBLIC, 'on an open page it is public, as before');
  assert.deepEqual(await fetchPhoto(db, c2), PUBLIC, 'an ordinary post is unchanged');
  // a block with the page's owner hides it, as it hides the comment
  exec(db, 'INSERT INTO blocks (blocker_id, blocked_id, created) VALUES (?, ?, 1)', openOwner, stranger);
  assert.deepEqual(await fetchPhoto(db, b, as(stranger)), NOT_FOUND, 'blocked by the page owner');
  assert.deepEqual(await fetchPhoto(db, b), PUBLIC);
  exec(db, 'UPDATE users SET banned = 1 WHERE id = ?', openOwner);
  assert.deepEqual(await fetchPhoto(db, b), NOT_FOUND, 'a banned page owner\'s page is gone');
});

test('R10: a profile picture is public on purpose, but only while it is the member\'s current one', async () => {
  const db = database();
  const ann = addUser(db, 'ann', `follow_policy = 'approve'`);
  const old = addPhoto(db, ann, null, { purpose: 'avatar' }), current = addPhoto(db, ann, null, { purpose: 'avatar' });
  exec(db, 'UPDATE users SET avatar = ? WHERE id = ?', '/media/' + current, ann);
  assert.deepEqual(await fetchPhoto(db, current), PUBLIC, 'even a private profile\'s, to anyone');
  assert.deepEqual(await fetchPhoto(db, old), NOT_FOUND, 'a leftover is not served (nor embeddable)');
  assert.deepEqual(await fetchPhoto(db, old, { id: ann, is_admin: 0 }), NOT_FOUND);
  exec(db, 'UPDATE users SET avatar = ? WHERE id = ?', '/assets/avatars/preset_01.png', ann);
  assert.deepEqual(await fetchPhoto(db, current), NOT_FOUND, 'switching to a preset takes the upload off');
});

// what Apple and Google must never be handed: anything a member typed, or who is under moderation (red team R5; the owner chose sender-only pushes)
const BODIES = new Set(['liked your post', 'replied to you', 'reposted your post', 'quoted your post', 'mentioned you', 'left a comment on your page', 'started following you',
  'wants to follow you', 'accepted your follow request', 'invited you to a group chat', 'mentioned you in #ourspace', 'your board request was approved',
  'your board request was declined', 'you have a notification from OurSpace', 'something happened on ourspace', 'sent you a message', 'sent a message in a group chat']);
const alertsOf = bodies => bodies.map(b => {
  const j = JSON.parse(b);
  return j.aps ? { title: j.aps.alert.title, body: j.aps.alert.body, url: j.url } : { title: j.message.notification.title, body: j.message.notification.body, url: j.message.data.url };
});

test('a push never carries member-written text: not a message, not a post or comment, not a group name, and nothing about moderation', async () => {
  const db = database();
  const ann = addUser(db, 'ann'), kat = addUser(db, 'kat');
  addPhone(db, ann, 'ann-ios'); addPhone(db, ann, 'ann-droid', { provider: 'fcm' });
  const env = envFor(db);
  const SECRET = 'MEET-ME-BEHIND-THE-GYM-AT-NOON';
  // a DM and a group message, pushed at once: the sender and the fact of a message
  const dm = Number(exec(db, "INSERT INTO conversations (kind, created, dm_key) VALUES ('dm', 1, 'k')").lastInsertRowid);
  const grp = Number(exec(db, "INSERT INTO conversations (kind, title, created) VALUES ('group', 'THE-SECRET-CLUB-NAME', 1)").lastInsertRowid);
  for (const c of [dm, grp]) for (const u of [ann, kat]) exec(db, "INSERT INTO conversation_members (conversation_id, user_id, status, joined) VALUES (?, ?, 'joined', 1)", c, u);
  const bodies = [];
  const sent = await pushing(() => 200, async () => {
    // (the extra fields are what sendChatMessage has always passed: they must not matter)
    await pushChat(env, { chatId: dm, kind: 'dm', title: null, from: { id: kat, name: 'kat' }, body: SECRET, skip: [] });
    await pushChat(env, { chatId: grp, kind: 'group', title: 'THE-SECRET-CLUB-NAME', from: { id: kat, name: 'kat' }, body: SECRET, skip: [] });
  }, bodies);
  assert.equal(sent.length, 4, 'two messages to two phones');
  assert.deepEqual(alertsOf(bodies).map(a => [a.title, a.body, a.url]), [
    ['kat', 'sent you a message', `/messages/${dm}`], ['kat', 'sent you a message', `/messages/${dm}`],
    ['kat', 'sent a message in a group chat', `/messages/${grp}`], ['kat', 'sent a message in a group chat', `/messages/${grp}`]]);
  // every kind of notification the outbox knows, about a post full of recognisable words
  const post = addPost(db, ann, { body: 'POST-TEXT-' + SECRET });
  const kinds = ['like', 'reply', 'repost', 'quote', 'mention', 'comment', 'follow', 'follow_request', 'follow_accepted', 'group_invite', 'chat_mention',
    'board_approved', 'board_declined', 'ai_strike', 'ai_appeal', 'something_new'];
  for (const k of kinds) exec(db, 'INSERT INTO notifications (user_id, kind, actor_id, post_id, created) VALUES (?, ?, ?, ?, ?)', ann, k, kat, post, Date.now());
  const lines = all(db, 'SELECT kind, title, body, url FROM push_outbox ORDER BY id');
  assert.equal(lines.length, kinds.length);
  for (const l of lines) {
    assert.ok(BODIES.has(l.body), `${l.kind}: "${l.body}" is not a fixed phrase`);
    assert.ok(l.title === 'kat' || l.title === 'ourspace', `${l.kind}: title ${l.title}`);
    if (/^ai_/.test(l.kind)) assert.deepEqual([l.title, l.body, l.url], ['ourspace', 'you have a notification from OurSpace', '/notifications'], 'a strike or an appeal looks like any other notice');
  }
  const bodies2 = [];
  await pushing(() => 200, async () => { await drainPush(env, Date.now()); await drainPush(env, Date.now()); }, bodies2);   // (10 lines a person a run)
  const wire = bodies2.join(' | ');
  assert.equal(bodies2.length, kinds.length * 2, 'every line to both phones');
  assert.ok(!wire.includes('MEET-ME') && !wire.includes('POST-TEXT') && !wire.includes('SECRET-CLUB'), 'nothing a member typed is on the wire');
  assert.ok(!/strike|moderat|writing|appeal/i.test(wire), 'nor anything about moderation');
  for (const a of alertsOf(bodies2)) assert.ok(BODIES.has(a.body), a.body);
});
