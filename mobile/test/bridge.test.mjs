// Tests public/js/core/native.js, the JavaScript half of the app, in a real browser (Chromium via the repo root's Playwright):
// the real public/ bundle, a fake Capacitor (every native plugin is a recording stub) and a fake API on another origin, which
// is the position the app is in. It proves the bridge's behaviour; it does NOT prove the Swift / Java / Gradle / Xcode side, or
// that the real plugins accept these calls. Run: `node --test mobile/test/` (needs `npm ci` at the repo root and
// `npx playwright install chromium`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', '..', 'public');
const { chromium } = createRequire(join(here, '..', '..', 'package.json'))('playwright');

const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.gif': 'image/gif' };

let pageServer, apiServer, browser, pageOrigin, apiOrigin;
const seen = [];                          // every request the fake API got: { method, path, client, auth, ticket, cookie }
const secure = new Map();                 // the fake Keychain; survives page reloads like the real one
const GOOD = 'tok-good-123';
// The pass the fake API hands out for one chat room (contract §7): what the handshake carries instead of the session
// token, which the browser would otherwise publish as `socket.protocol` (docs/mobile/redteam.md R8).
const PASS = 'pass-one-room-30s';
let ticketStatus = 200;

// The app's sign-in with a provider (contract §6): what comes back on ourspace:// is a one-time CODE, and the server
// only trades it for a session if the POST also carries the verifier whose SHA-256 the app sent on /start. The fake
// API here does exactly that check, so the test proves the binding and not just the shape of the call.
const CODE = 'one-time-code-xyz';
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeFor = v => b64url(createHash('sha256').update(String(v)).digest());
let lastChallenge = null;                 // the challenge the last /start carried
let exchangeGives = 'session';            // or 'signup': somebody who still has to pick a screen name
const spentCodes = new Set();             // single use, as the real table is

// /media/*, as src/media/media.js answers it: a public photo is embeddable (CORP cross-origin) and anonymous; a private one is
// only for the token (CORP same-origin, so an <img> cannot show it, a CORS fetch can); anything else is a 404 that is not
// embeddable either. blocked.png is the nasty one: public to anonymous, but this viewer is blocked, so with the token it is a 404.
let mediaActive = 0, mediaMax = 0;
function media(req, res, path, cors, token) {
  const same = { ...cors, 'Cross-Origin-Resource-Policy': 'same-origin' };
  const open = { ...cors, 'Cross-Origin-Resource-Policy': 'cross-origin' };
  const png = headers => res.writeHead(200, { 'Content-Type': 'image/png', ...headers }).end(PNG1);
  if (path === '/media/pub.png' || path === '/media/x.png') return png(open);
  if (path === '/media/blocked.png') return token ? res.writeHead(404, same).end('not found') : png(open);
  if (/^\/media\/priv(-\d+)?\.png$/.test(path)) {
    if (token !== GOOD) return res.writeHead(404, same).end('not found');
    mediaMax = Math.max(mediaMax, ++mediaActive);
    return setTimeout(() => { mediaActive--; png(same); }, 25);
  }
  res.writeHead(404, same).end('not found');
}

const send = (res, status, body, extra = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify(body));

before(async () => {
  apiServer = createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') return res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-OurSpace-Client, X-OurSpace-Ticket' }).end();
    const path = new URL(req.url, 'http://x').pathname;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    seen.push({ method: req.method, path, client: req.headers['x-ourspace-client'], auth: bearer && bearer[1], ticket: req.headers['x-ourspace-ticket'], cookie: req.headers.cookie, credentialed: !!cors['Access-Control-Allow-Credentials'] });
    if (path.startsWith('/media/')) return media(req, res, path, cors, bearer && bearer[1]);
    const me = bearer && bearer[1] === GOOD ? { id: 1, name: 'kat', avatar: '/assets/pfp.png', isAdmin: false, sign: 'leo' } : null;
    if (path === '/api/me') return send(res, 200, { user: me, counts: { requests: 0, unread: 2, notifications: 1, reports: 0 }, settings: null }, cors);
    if (path === '/api/auth/providers') return send(res, 200, { signIn: [{ id: 'google', label: 'Google' }], spotify: false }, cors);
    if (/^\/api\/oauth\/[a-z]+\/start$/.test(path)) { lastChallenge = new URL(req.url, 'http://x').searchParams.get('challenge'); return send(res, 200, {}, cors); }
    if (path === '/api/oauth/exchange' && req.method === 'POST') {
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(raw || '{}'); } catch { /* the server would 400 too */ }
        seen.at(-1).exchange = { code: b.code, verifier: b.verifier };
        const ok = b.code === CODE && !spentCodes.has(b.code) && typeof b.verifier === 'string' && challengeFor(b.verifier) === lastChallenge;
        if (typeof b.code === 'string') spentCodes.add(b.code);
        if (!ok) return send(res, 400, { error: 'that sign-in has expired. start again.' }, cors);
        if (exchangeGives === 'signup') return send(res, 200, { ticket: 'abc123' }, cors);
        send(res, 200, { session: { token: GOOD, expires: Date.now() + 9e9 } }, cors);
      });
      return;
    }
    if (path === '/api/live/ticket' && req.method === 'POST') {
      let b = '';
      req.on('data', d => { b += d; });
      req.on('end', () => {
        seen.at(-1).body = JSON.parse(b || '{}');
        if (ticketStatus !== 200) return send(res, ticketStatus, { error: 'that chat isn\'t there.' }, cors);
        send(res, 200, { ticket: PASS, expires: Date.now() + 30000, ms: 30000 }, cors);
      });
      return;
    }
    if (path === '/api/login' && req.method === 'POST') return send(res, 200, { user: { id: 1, name: 'kat' }, session: { token: GOOD, expires: Date.now() + 9e9 } }, cors);
    if (path === '/api/me/devices' && req.method === 'POST') { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen.at(-1).body = JSON.parse(b || '{}'); send(res, 200, { device: { id: 7 } }, cors); }); return; }
    // the sign-up screen's camera (core/joinphoto.js): sign up, then the picture it held goes up and is set
    if (path === '/api/signup' && req.method === 'POST') { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen.at(-1).body = JSON.parse(b || '{}'); send(res, 200, { user: { id: 1, name: 'kat' }, session: { token: GOOD, expires: Date.now() + 9e9 } }, cors); }); return; }
    if (path === '/api/media' && req.method === 'POST') {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        seen.at(-1).upload = { purpose: new URL(req.url, 'http://x').searchParams.get('purpose'), bytes: Buffer.concat(chunks).length, type: req.headers['content-type'] };
        send(res, 201, { media: { id: 9, url: '/media/new-avatar.png', width: 300, height: 300, mime: 'image/png' } }, cors);
      });
      return;
    }
    if (path === '/api/me/profile' && req.method === 'PUT') { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen.at(-1).body = JSON.parse(b || '{}'); send(res, 200, { ok: true, avatar: '/media/new-avatar.png' }, cors); }); return; }
    if (path === '/api/options') return send(res, 200, { avatars: [{ file: '/assets/pfp.png', group: 'faces', desc: 'a face' }], moods: [], genders: [], statuses: [], hereFor: [], interestKeys: [] }, cors);
    send(res, 200, {}, cors);
  }).listen(0);
  await new Promise(r => apiServer.on('listening', r));
  apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;

  pageServer = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/native-config.json') return send(res, 200, { origin: apiOrigin });
    let file = join(publicDir, path);
    if (!file.startsWith(publicDir) || !existsSync(file) || path.endsWith('/')) file = join(publicDir, 'index.html');   // the SPA fallback
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'text/html' }).end(readFileSync(file));
  }).listen(0);
  await new Promise(r => pageServer.on('listening', r));
  pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); pageServer?.close(); apiServer?.close(); });

// What the page gets as window.Capacitor. Every plugin records its calls on window.__calls.
const fakeCapacitor = ({ launchUrl = null, pushTap = null, platform = 'ios', authReturn = `ourspace://auth?code=${CODE}`, refuseTabs = false } = {}) => `
  window.__calls = []; window.__sockets = [];
  // what the shell does when a native tab is tapped: ShellPlugin.notifyListeners('tabTap', …) on both platforms
  window.__shellEmit = (event, data) => { const f = (window.__shellListeners || {})[event]; if (f) f(data); return !!f; };
  const rec = (name, fn) => (...a) => { window.__calls.push([name, a[0]]); return fn ? fn(...a) : Promise.resolve({}); };
  const plugin = (p, extra = {}) => new Proxy(extra, { get: (t, k) => (t[k] ? (...a) => { window.__calls.push([p + '.' + String(k), a[0]]); return t[k](...a); } : rec(p + '.' + String(k))) });
  window.Capacitor = {
    isNativePlatform: () => true, getPlatform: () => ${JSON.stringify(platform)},
    registerPlugin: n => window.Capacitor.Plugins[n],
    Plugins: {
      SecureStorage: plugin('SecureStorage', {
        internalGetItem: async o => ({ data: await window.__keychain('get', o.prefixedKey) }),
        internalSetItem: async o => { await window.__keychain('set', o.prefixedKey, o.data); window.__calls.push(['SecureStorage.set', o.prefixedKey]); return {}; },
        internalRemoveItem: async o => { await window.__keychain('del', o.prefixedKey); return {}; },
      }),
      App: plugin('App', { getInfo: async () => ({ version: '1.2.3' }), getLaunchUrl: async () => (${JSON.stringify(launchUrl)} ? { url: ${JSON.stringify(launchUrl)} } : undefined), addListener: async (e, f) => { (window.__appListeners ||= {})[e] = f; return {}; }, exitApp: async () => {} }),
      PushNotifications: plugin('Push', {
        addListener: async (e, f) => { if (e === 'pushNotificationActionPerformed' && ${JSON.stringify(pushTap)}) f({ notification: { data: { url: ${JSON.stringify(pushTap)} } } }); (window.__pushListeners ||= {})[e] = f; return {}; },
        checkPermissions: async () => ({ receive: 'prompt' }), requestPermissions: async () => ({ receive: 'granted' }),
      }),
      Device: plugin('Device', { getInfo: async () => ({ name: "kat's phone", model: 'iPhone15,2' }) }),
      Network: plugin('Network', { getStatus: async () => ({ connected: true }), addListener: async () => ({}) }),
      Haptics: plugin('Haptics'), Share: plugin('Share'), Browser: plugin('Browser'), Camera: plugin('Camera'), ActionSheet: plugin('ActionSheet'),
      // The shell's own plugin. authenticate really loads the /start URL, so the fake API sees the challenge the app
      // sent and comes back on the custom scheme the way the real one does. setTabs is the real contract too: it
      // resolves when the bar was accepted and REJECTS when it was not, which is what tells core/tabbar.js whether
      // it may take the page's own web tab bar out of the flow. (No back-ticks in here: this is inside a template.)
      OurSpaceShell: plugin('Shell', {
        authenticate: async o => { window.__calls.push(['Shell.authenticate', o]); await fetch(o.url).catch(() => {}); return { url: ${JSON.stringify(authReturn)} }; },
        setTabs: async o => {
          window.__calls.push(['Shell.setTabs', o]);
          if (${refuseTabs ? 'true' : 'false'}) throw new Error('this shell does not draw tab bars');
          return { drawn: !!(o && o.spec) };
        },
        addListener: async (e, f) => { (window.__shellListeners ||= {})[e] = f; return { remove: async () => {} }; },
      }),
    },
  };`;

async function open(opts = {}, { app = true, path = '/', installed = true, readsThrow = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.exposeFunction('__keychain', (op, k, v) => (op === 'get' ? secure.get(k) ?? null : op === 'set' ? secure.set(k, v) && null : secure.delete(k) && null));
  await page.addInitScript(`window.__RealWS = window.WebSocket; window.WebSocket = class { constructor(u, p) { window.__sockets.push([String(u), p]); this.readyState = 0; } send() {} close() {} };`);
  if (installed) await page.addInitScript("localStorage.setItem('os.installed', '1')");   // (a launch after the first one)
  // a WebView that refuses to let the page read localStorage at all (blocked storage, quota, private mode)
  if (readsThrow) await page.addInitScript("Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };");
  if (app) await page.addInitScript(fakeCapacitor(opts));
  else await page.addInitScript('window.__calls = []; window.__sockets = [];');
  await page.goto(pageOrigin + path);
  await page.waitForFunction(() => document.querySelector('#ms-content') && !document.querySelector('#ms-content .os-loading'), null, { timeout: 15000 });
  return { ctx, page };
}
const calls = (page, name) => page.evaluate(n => window.__calls.filter(c => c[0] === n).map(c => c[1]), name);
const fresh = () => { seen.length = 0; secure.clear(); spentCodes.clear(); lastChallenge = null; exchangeGives = 'session'; ticketStatus = 200; };
const exchanges = () => seen.filter(s => s.path === '/api/oauth/exchange');
// wait for something the FAKE API saw (the page cannot be asked about a request it made and forgot)
async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for the server to see it');
    await new Promise(r => setTimeout(r, 25));
  }
}

test('in a browser the bridge does nothing', async () => {
  fresh();
  const { ctx, page } = await open({}, { app: false });
  const r = await page.evaluate(async () => {
    const m = await import('/js/core/native.js');
    return { isApp: m.isApp, fetchIsNative: /\[native code\]/.test(window.fetch.toString()), wsIsNative: window.WebSocket.name !== 'OurSpaceWebSocket', viewport: document.querySelector('meta[name=viewport]').content };
  });
  assert.equal(r.isApp, false);
  assert.ok(r.fetchIsNative && r.wsIsNative);
  assert.equal(r.viewport, 'width=device-width, initial-scale=1.0');
  assert.equal(seen.length, 0, 'the page asked its own origin, not the fake API');
  await ctx.close();
});

test('in the app every API call goes to OURSPACE_ORIGIN with the client header and no cookies', async () => {
  fresh();
  const { ctx, page } = await open();
  assert.ok(seen.some(s => s.path === '/api/me'));
  for (const s of seen) { assert.equal(s.client, 'app/ios/1.2.3', s.path); assert.equal(s.cookie, undefined); assert.equal(s.auth, null); }
  assert.match(await page.evaluate(() => document.querySelector('meta[name=viewport]').content), /maximum-scale=1/);
  assert.equal((await calls(page, 'Shell.hideSplash')).length, 1, 'the splash is told to go once');
  await ctx.close();
});

test('signing in stores the token in secure storage (not localStorage), sends it, registers the device, and survives a restart', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.evaluate(async () => { const { api } = await import('/js/core/api.js'); await api.post('/login', { login: 'kat', password: 'x' }); });
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Push.register'), null, { timeout: 5000 });
  assert.equal(secure.get('ourspace_session'), GOOD);
  assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes('tok-good')), false, 'the token is not in localStorage');
  await page.evaluate(async () => { const { api } = await import('/js/core/api.js'); await api.get('/me'); });
  assert.equal(seen.at(-1).auth, GOOD);
  const dev = seen.find(s => s.path === '/api/me/devices');
  assert.equal(dev.auth, GOOD);
  assert.deepEqual([dev.body.platform, dev.body.label], ['ios', "kat's phone"]);
  assert.equal((await calls(page, 'Push.requestPermissions')).length, 1, 'asked for notifications once, after sign-in');
  await ctx.close();

  seen.length = 0;                                         // a new launch: the Keychain still has it
  const second = await open();
  assert.equal(seen.find(s => s.path === '/api/me').auth, GOOD, 'the very first call of the next launch is signed in');
  assert.ok(await second.page.evaluate(() => /kat/.test(document.getElementById('who').textContent)));
  await second.ctx.close();
});

test('a reinstall (no localStorage marker) drops the Keychain token', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  const { ctx } = await open({}, { installed: false });
  assert.equal(secure.has('ourspace_session'), false);
  await ctx.close();
});

// R13: the guard's whole job is to drop a token it cannot vouch for, so a read it cannot make must not mean "keep it".
test('the reinstall guard fails closed: if localStorage cannot be read at all, the token goes', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  const { ctx, page } = await open({}, { installed: true, readsThrow: true });
  assert.equal(secure.has('ourspace_session'), false, 'a marker it could not read is not a marker');
  assert.equal(seen.filter(s => s.auth === GOOD).length, 0, 'and nothing was sent with it');
  assert.equal(await page.evaluate(() => document.getElementById('who').textContent.includes('kat')), false);
  await ctx.close();
});

const photoProbe = (page, names) => page.evaluate(async names => {
  const imgs = names.map(n => { const i = new Image(); i.src = '/media/' + n; return i; });
  await Promise.all(imgs.map(i => new Promise(res => { const done = () => setTimeout(res, 50); i.addEventListener('load', done); i.addEventListener('error', done); })));
  await new Promise(r => setTimeout(r, 200));
  return imgs.map(i => ({ src: i.src.startsWith('blob:') ? 'blob' : i.src, w: i.naturalWidth }));
}, names);
const stats = page => page.evaluate(async () => (await import('/js/core/native.js')).mediaStats());

test('signed out, /media/ photos load straight from the Worker (nobody is deciding anything)', async () => {
  fresh();
  const { ctx, page } = await open();
  const [pub, priv] = await photoProbe(page, ['pub.png', 'priv.png']);
  assert.deepEqual(pub, { src: apiOrigin + '/media/pub.png', w: 1 });
  assert.equal(priv.w, 0, 'a private photo does not show to nobody');
  const viaAttr = await page.evaluate(() => { const i = document.createElement('img'); i.setAttribute('src', '/media/x.png'); const j = document.createElement('img'); j.setAttribute('src', '/assets/pfp.png'); return [i.getAttribute('src'), j.getAttribute('src')]; });
  assert.deepEqual(viaAttr, [apiOrigin + '/media/x.png', '/assets/pfp.png'], 'and bundled assets stay local');
  assert.equal((await stats(page)).blobs, 0);
  assert.ok(seen.filter(s => s.path.startsWith('/media/')).every(s => s.auth === null), 'no token went with them');
  await ctx.close();
});

test('signed in, EVERY /media/ image is fetched with the token and shown as a blob (public and private); a 404 stays broken', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  const { ctx, page } = await open();
  const [pub, priv, gone] = await photoProbe(page, ['pub.png', 'priv.png', 'gone.png']);
  assert.deepEqual([pub, priv], [{ src: 'blob', w: 1 }, { src: 'blob', w: 1 }], 'a public and a private photo both show');
  assert.equal(gone.w, 0, 'a 404 is a broken image, as on the web');
  const asked = n => seen.filter(s => s.path === '/media/' + n).map(s => s.auth);
  assert.deepEqual(asked('priv.png'), [GOOD], 'private: one request, with the token, no anonymous one first');
  assert.deepEqual(asked('pub.png'), [GOOD], 'public too: the viewer is always the one asking');
  assert.deepEqual(asked('gone.png'), [GOOD], 'a 404 is asked once');
  assert.equal((await stats(page)).blobs, 2);
  await ctx.close();
});

test('a photo that is public to everyone but this viewer (they are blocked) does NOT show', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  const { ctx, page } = await open();
  const [blocked] = await photoProbe(page, ['blocked.png']);
  assert.equal(blocked.w, 0);
  assert.equal(seen.filter(s => s.path === '/media/blocked.png' && s.auth === null).length, 0, 'never asked anonymously, which would have shown it');
  await ctx.close();
});

test('blobs are shared, revoked when the page is left, and capped; requests are few at a time', async () => {
  fresh(); secure.set('ourspace_session', GOOD); mediaMax = 0;
  const { ctx, page } = await open();
  const three = await page.evaluate(async () => {            // one photo on three images = one request
    const imgs = [0, 1, 2].map(() => { const i = document.createElement('img'); document.body.append(i); i.src = '/media/priv.png'; return i; });
    await new Promise(r => setTimeout(r, 400));
    return imgs.map(i => i.naturalWidth);
  });
  assert.deepEqual(three, [1, 1, 1]);
  assert.equal(seen.filter(s => s.path === '/media/priv.png').length, 1);

  const blobUrl = await page.evaluate(() => document.querySelector('img[src^="blob:"]').src);   // leaving the page revokes every blob
  await page.evaluate(async () => { const { go } = await import('/js/core/router.js'); go('/boards'); });
  await page.waitForFunction(async () => (await import('/js/core/native.js')).mediaStats().blobs === 0, null, { timeout: 5000 });
  assert.equal(await page.evaluate(u => fetch(u).then(() => 'still there', () => 'revoked'), blobUrl), 'revoked');

  await page.evaluate(() => { for (let n = 0; n < 70; n++) { const i = document.createElement('img'); i.src = `/media/priv-${n}.png`; document.body.append(i); } });
  await page.waitForFunction(() => [...document.querySelectorAll('img')].filter(i => i.naturalWidth === 1).length >= 70, null, { timeout: 20000 });
  const held = await stats(page);
  assert.ok(held.blobs <= 40, `held ${held.blobs}`);
  assert.ok(mediaMax <= 4, `${mediaMax} requests at once`);
  await ctx.close();
});

const openRoomAndWait = page => page.evaluate(async () => {
  const { openRoom } = await import('/js/core/live.js');
  openRoom('ourspace', {});
  await new Promise(r => setTimeout(r, 400));          // the pass is fetched before the handshake
});
const passes = () => seen.filter(s => s.path === '/api/live/ticket');

test('the chat socket goes to the Worker with a one-room pass, never the session token (redteam R8)', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  const { ctx, page } = await open();
  await openRoomAndWait(page);
  const [[url, protocols]] = await page.evaluate(() => window.__sockets);
  assert.equal(url, apiOrigin.replace('http', 'ws') + '/api/live/ourspace');
  assert.deepEqual(protocols, ['ourspace.live', 'ourspace.bearer.' + PASS]);
  assert.ok(!protocols.some(x => x.includes(GOOD)), 'the Keychain token is not on the handshake');
  // and the pass was asked for over the API, with the token in a header where no page script can see it
  assert.equal(passes().length, 1);
  const [ask] = passes();
  assert.deepEqual([ask.method, ask.auth, ask.cookie, ask.client, ask.body], ['POST', GOOD, undefined, 'app/ios/1.2.3', { room: 'ourspace' }]);
  await ctx.close();
});

test('no pass, no handshake: a refused /api/live/ticket opens no socket at all', async () => {
  fresh(); secure.set('ourspace_session', GOOD); ticketStatus = 404;
  const { ctx, page } = await open();
  await openRoomAndWait(page);
  assert.deepEqual(await page.evaluate(() => window.__sockets), [], 'nothing was opened');
  assert.equal(passes().length, 1, 'and it was not retried: a 404 ends the room');
  await ctx.close();
});

test('a link or a notification tap that cold-starts the app opens that exact page', async () => {
  fresh(); secure.set('ourspace_session', GOOD);
  let { ctx, page } = await open({ launchUrl: apiOrigin + '/messages/5' });
  assert.equal(new URL(page.url()).pathname, '/messages/5', 'universal link');
  await ctx.close();

  ({ ctx, page } = await open({ pushTap: '/messages/9' }));
  assert.equal(new URL(page.url()).pathname, '/messages/9', 'push tap');
  await ctx.close();

  ({ ctx, page } = await open({ pushTap: 'https://evil.example/phish' }));
  assert.equal(new URL(page.url()).pathname, '/', 'a url that is not this site is ignored');
  await ctx.close();
});

const signInLink = page => page.evaluate(() => {
  const a = document.createElement('a'); a.id = 'g'; a.href = '/api/oauth/google/start?mode=login&next=%2Fmessages'; a.textContent = 'Continue with Google'; document.body.append(a);
});

test('Google sign-in runs in the system sheet with client=app and a challenge, and trades the code it gets back for the token', async () => {
  fresh();
  const { ctx, page } = await open();
  await signInLink(page);
  await page.click('#g');
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.authenticate'), null, { timeout: 5000 });
  const [arg] = await calls(page, 'Shell.authenticate');
  const u = new URL(arg.url);
  assert.equal(u.origin, apiOrigin);
  assert.equal(u.pathname, '/api/oauth/google/start');
  assert.equal(u.searchParams.get('client'), 'app');
  assert.equal(u.searchParams.get('next'), '/messages');
  assert.match(u.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/, 'SHA-256 of the verifier, base64url');
  assert.equal(arg.scheme, 'ourspace');
  await page.waitForFunction(() => document.getElementById('who').textContent.includes('kat'), null, { timeout: 5000 });
  const [ex] = exchanges();
  assert.equal(ex.method, 'POST');
  assert.equal(ex.exchange.code, CODE);
  assert.equal(challengeFor(ex.exchange.verifier), u.searchParams.get('challenge'), 'the verifier it kept in memory is the one it hashed');
  assert.ok(ex.exchange.verifier.length >= 32 && !arg.url.includes(ex.exchange.verifier), 'and the verifier itself never went near the sheet');
  assert.equal(ex.auth, null, 'no earlier token rides the exchange');
  assert.equal(secure.get('ourspace_session'), GOOD);
  assert.equal(new URL(page.url()).pathname, '/messages');
  await ctx.close();
});

// R1(a): any installed app, or a tapped link, can fire ourspace://auth at us. It must buy nothing at all.
test('an ourspace://auth that no sign-in here asked for is dropped: no exchange, no token', async () => {
  fresh();
  const { ctx, page } = await open();
  for (const url of [`ourspace://auth?code=${CODE}`, 'ourspace://auth?token=attackers-own-token', 'ourspace://join?ticket=attackers-ticket', 'ourspace://auth?error=cancelled']) {
    await page.evaluate(u => window.__appListeners.appUrlOpen({ url: u }), url);
  }
  await page.waitForTimeout(400);
  assert.deepEqual(exchanges(), [], 'nothing was even offered to the server');
  assert.equal(secure.has('ourspace_session'), false);
  assert.equal(seen.filter(s => s.auth !== null).length, 0, 'no request was ever signed');
  assert.equal(await page.evaluate(() => document.getElementById('who').textContent.includes('kat')), false, 'still signed out');
  // and nothing was registered into anybody's account on the back of it
  assert.deepEqual(seen.filter(s => s.path === '/api/me/devices'), []);
  await page.evaluate(async () => { const { api } = await import('/js/core/api.js'); await api.get('/signup/pending'); });
  assert.equal(seen.filter(s => s.path === '/api/signup/pending').at(-1).ticket, undefined, 'ourspace://join?ticket= is not a way in any more');
  await ctx.close();
});

// R1(b): on Android the return comes through the public ourspace:// intent filter, so another app can read it. A code
// is all it can read, and a code is spent by the first attempt and worth nothing without the verifier.
test('a code that is not the one this sign-in is waiting for buys nothing, and spends the attempt', async () => {
  fresh();
  const { ctx, page } = await open();
  await signInLink(page);
  await page.evaluate(() => { window.Capacitor.Plugins.OurSpaceShell.authenticate = async o => { await fetch(o.url).catch(() => {}); return { url: 'ourspace://auth?code=a-code-from-somewhere-else' }; }; });
  await page.click('#g');
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.authenticate'), null, { timeout: 5000 });
  await page.waitForTimeout(500);
  assert.equal(exchanges().length, 1, 'tried once, with the verifier it had');
  assert.equal(exchanges()[0].exchange.code, 'a-code-from-somewhere-else');
  assert.equal(secure.has('ourspace_session'), false, 'and was refused');

  // the real code arriving afterwards is not even tried: one sign-in, one attempt
  await page.evaluate(u => window.__appListeners.appUrlOpen({ url: u }), `ourspace://auth?code=${CODE}`);
  await page.waitForTimeout(300);
  assert.equal(exchanges().length, 1, 'the verifier was spent by the first attempt');
  assert.equal(secure.has('ourspace_session'), false);
  await ctx.close();
});

test('somebody new comes back as a code too: the ticket arrives in the exchange\'s answer and goes on as X-OurSpace-Ticket', async () => {
  fresh();
  exchangeGives = 'signup';
  const { ctx, page } = await open();
  await signInLink(page);
  await page.click('#g');
  await page.waitForFunction(() => location.pathname === '/join/finish', null, { timeout: 5000 });
  const [ex] = exchanges();
  assert.equal(challengeFor(ex.exchange.verifier), lastChallenge);
  await page.evaluate(async () => { const { api } = await import('/js/core/api.js'); await api.get('/signup/pending'); });
  assert.equal(seen.filter(s => s.path === '/api/signup/pending').at(-1).ticket, 'abc123');
  assert.equal(seen.filter(s => s.path === '/api/me').at(-1).ticket, undefined, 'only the sign-up routes get it');
  await ctx.close();
});

// R9: an origin comparison is not a scheme check. `capacitor:`, `javascript:` and `data:` all serialise origin to the
// string "null", so in the app's own WebView "null" === "null" let every one of them through.
test('sitePath takes http(s) on our own origin and nothing else', async () => {
  fresh();
  const { ctx, page } = await open();
  const got = await page.evaluate(async api => {
    const { sitePath } = await import('/js/core/native.js');
    const cases = [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'blob:http://x/y', 'file:///etc/passwd',
      'ourspace://auth?code=x', 'capacitor://localhost/u/kat', 'about:blank',
      '//evil.com/api/me', '\\\\evil.com\\x', '/\\evil.com/x', 'https://evil.example/x', 'http://evil.example/x',
      'https://ourspace.page@evil.example/x', '/%2f%2fevil.com', '/%5cevil.com',
      '/api/me', '/media/x.png', '/messages/5', '/u/kat?tab=blog#top', api + '/u/kat', 'not a url at all',
    ];
    return cases.map(s => [s, sitePath(s)]);
  }, apiOrigin);
  const out = Object.fromEntries(got);
  for (const s of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'blob:http://x/y', 'file:///etc/passwd',
    'ourspace://auth?code=x', 'capacitor://localhost/u/kat', 'about:blank', '//evil.com/api/me', '\\\\evil.com\\x', '/\\evil.com/x',
    'https://evil.example/x', 'http://evil.example/x', 'https://ourspace.page@evil.example/x', '/api/me', '/media/x.png']) {
    assert.equal(out[s], null, `${s} must not become a path (got ${JSON.stringify(out[s])})`);
  }
  assert.equal(out['/messages/5'], '/messages/5');
  assert.equal(out['/u/kat?tab=blog#top'], '/u/kat?tab=blog#top');
  assert.equal(out[apiOrigin + '/u/kat'], '/u/kat');
  // the encoded forms stay encoded and stay on this origin: a path, not an escape from it
  for (const s of ['/%2f%2fevil.com', '/%5cevil.com']) {
    assert.ok(out[s] === null || /^\/%[0-9a-fA-F]{2}/.test(out[s]), `${s} -> ${JSON.stringify(out[s])}`);
  }
  // and the one that matters: nothing sitePath returns can be navigated off this origin
  for (const [, v] of got) if (v !== null) assert.equal(new URL(v, apiOrigin).origin, apiOrigin, v);
  await ctx.close();
});

test('haptics fire on existing buttons, and "copy link" opens the share sheet with the real address', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.evaluate(() => {
    const b = document.createElement('button'); b.className = 'btn98'; b.id = 'b'; b.textContent = 'x'; document.body.append(b);
    const a = document.createElement('a'); a.href = '#'; a.id = 'cl'; a.textContent = 'copy link'; document.body.append(a);
  });
  await page.click('#b');
  assert.equal((await calls(page, 'Haptics.impact')).length, 1);
  await page.click('#cl');
  const [shared] = await calls(page, 'Share.share');
  assert.ok(shared.url.startsWith(apiOrigin + '/'), shared.url);
  await ctx.close();
});

test('the photo picker feeds the page\'s own file input', async () => {
  fresh();
  const { ctx, page } = await open();
  const r = await page.evaluate(async () => {
    window.Capacitor.Plugins.ActionSheet.showActions = async () => ({ index: 1 });
    window.Capacitor.Plugins.Camera.chooseFromGallery = async () => ({ results: [{ webPath: '/assets/pfp.png' }] });
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    const got = new Promise(res => input.addEventListener('change', () => res([input.files.length, input.files[0].type, input.files[0].size > 0])));
    input.click();
    return got;
  });
  assert.deepEqual(r, [1, 'image/png', true]);
  await ctx.close();
});

/* ---------------------------------------------------------------- the native tab bar (deviations.md D3, D22)

   What these prove, and what they cannot. They prove the PAGE half: that `.ms-tabs` is measured, that the numbers
   handed to the shell really describe it, that the web bar leaves the flow only once the shell has accepted a spec,
   that a tap comes back through the page's own router, and that a browser is untouched. They do not prove that Swift
   and Java draw it right — tools/tabbar-check.mjs proves the spec is enough to draw from (48 cases, both engines, 0
   pixels), and a device is the only thing that can prove the two drawers. docs/mobile/harness.md says so. */

const tabSpecs = page => page.evaluate(() => window.__calls.filter(c => c[0] === 'Shell.setTabs').map(c => c[1] && c[1].spec));
const webTabs = page => page.evaluate(() => {
  const bar = document.getElementById('tabs');
  const s = bar.getAttribute('style') || '';
  return {
    inFlow: !/position:\s*absolute/.test(s),
    labels: [...bar.children].map(a => a.textContent),
    hrefs: [...bar.children].map(a => a.getAttribute('href')),
  };
});

test('in a browser the tab bar is the page\'s own: nothing is measured and nothing is moved', async () => {
  fresh();
  const { ctx, page } = await open({}, { app: false });
  const bar = await webTabs(page);
  assert.equal(bar.inFlow, true);
  assert.ok(bar.labels.length > 0);
  assert.equal(await page.evaluate(() => window.__calls.length), 0);
  await ctx.close();
});

test('in the app the web bar leaves the flow and the shell is given a spec that describes it', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.setTabs'));
  const spec = (await tabSpecs(page)).at(-1);
  assert.ok(spec, 'a spec went to the shell');
  assert.equal(spec.v, 2);
  assert.ok(spec.items.length >= 5, spec.items.length + ' items');

  // the spec's hrefs and labels are the page's own, in the page's own order
  const bar = await webTabs(page);
  assert.deepEqual(spec.items.map(i => i.href), bar.hrefs);
  assert.deepEqual(spec.items.map(i => i.label.trim()), bar.labels.map(l => l.trim()));

  // the site's own colours and metrics, measured rather than written down anywhere native
  assert.equal(spec.bg, '#6699ccff');                       // .ms-tabs background
  assert.deepEqual(spec.rule, { dy: 1, h: 1, color: '#00000040' });   // box-shadow: 0 1px 0 rgba(0,0,0,.25)
  const on = spec.items.find(i => i.on);
  assert.ok(on, 'one tab is the current page');
  assert.equal(on.bg, '#ffffffff');                         // .ms-tab.on background
  assert.equal(on.fg, '#003366ff');                         // .ms-tab.on colour
  for (const i of spec.items) {
    assert.equal(i.font.size, 12);
    assert.equal(i.font.weight, 700);
    assert.ok(i.font.families.includes('MS Sans Serif'), JSON.stringify(i.font.families));
    assert.ok(i.w > 0 && i.h > 0 && i.baseline > i.y, JSON.stringify(i));
    assert.ok(i.textX >= i.x && i.textX + i.textW <= i.x + i.w + 0.5, JSON.stringify(i));
  }
  // the tabs sit inside the bar and do not overlap
  const row = [...spec.items].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let k = 1; k < row.length; k++) {
    if (row[k].y === row[k - 1].y) assert.ok(row[k].x + 0.001 >= row[k - 1].x + row[k - 1].w, 'tabs do not overlap');
  }
  assert.ok(spec.h + 0.001 >= Math.max(...spec.items.map(i => i.y + i.h)), 'every tab is inside the bar');

  // only now is the web bar out of the flow — and it is still laid out, so the next measurement can happen
  assert.equal(bar.inFlow, false);
  assert.equal(await page.evaluate(() => document.getElementById('tabs').getBoundingClientRect().width > 0), true);
  await ctx.close();
});

test('signing in repaints the chrome and the shell gets the new bar, badges and all', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.setTabs'));
  const before = (await tabSpecs(page)).at(-1);
  const sent = (await tabSpecs(page)).length;
  await page.evaluate(async () => {
    const { api } = await import('/js/core/api.js');
    const { loadMe } = await import('/js/core/state.js');
    await api.post('/login', { login: 'kat', password: 'x' });
    await loadMe();
  });
  await page.waitForFunction(n => window.__calls.filter(c => c[0] === 'Shell.setTabs').length > n, sent);
  const after = (await tabSpecs(page)).at(-1);
  assert.ok(after.items.length > before.items.length, before.items.length + ' -> ' + after.items.length + ' tabs');
  // /api/me says unread: 2, notifications: 1, so two tabs carry a pink pill
  const badges = after.items.filter(i => i.badge).map(i => i.badge.s).sort();
  assert.deepEqual(badges, ['1', '2']);
  for (const i of after.items) {
    if (!i.badge) continue;
    assert.equal(i.badge.bg, i.on ? '#cc0066ff' : '#ff3399ff');     // .ms-badge / .ms-tab.on .ms-badge
    assert.equal(i.badge.fg, '#ffffffff');
    assert.equal(i.badge.font.size, 10);
    assert.ok(i.badge.x >= i.x && i.badge.x + i.badge.w <= i.x + i.w + 0.5, 'the pill is inside its tab');
    assert.ok(i.badge.textX >= i.badge.x, 'the pill\'s digits are inside the pill');
  }
  await ctx.close();
});

test('a tap on a native tab clicks the web tab it was measured from', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.setTabs'));
  const tap = i => page.evaluate(n => {
    const spec = window.__calls.filter(c => c[0] === 'Shell.setTabs').at(-1)[1].spec;
    const it = spec.items[n];
    window.__shellEmit('tabTap', { id: it.id, href: it.href });
    return it.href;
  }, i);

  // an ordinary route: the page's own router takes it
  const browse = await page.evaluate(() => {
    const spec = window.__calls.filter(c => c[0] === 'Shell.setTabs').at(-1)[1].spec;
    return spec.items.findIndex(i => i.href === '/browse');
  });
  assert.ok(browse >= 0, 'the signed-out bar has a Browse tab');
  await tap(browse);
  await page.waitForFunction(() => location.pathname === '/browse', null, { timeout: 5000 });

  // "Blog" is /blog/, one of the router's STATIC_PREFIXES: a real file in the bundle, which the BROWSER must load.
  // Calling go('/blog/') instead would strip the slash, find no route and land on the 404 page. This is why a tap
  // clicks the web tab rather than routing its href.
  const blog = await page.evaluate(() => {
    const spec = window.__calls.filter(c => c[0] === 'Shell.setTabs').at(-1)[1].spec;
    return spec.items.findIndex(i => i.href === '/blog/');
  });
  assert.ok(blog >= 0, 'the bar has a Blog tab');
  await tap(blog);
  await page.waitForFunction(() => location.pathname === '/blog/', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => !!document.querySelector('#ms-content .ms-error, #ms-content .os-404')), false);
  await ctx.close();
});

test('a tap that arrives after the bar changed is ignored, not guessed at', async () => {
  fresh();
  const { ctx, page } = await open();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.setTabs'));
  const before = new URL(page.url()).pathname;
  await page.evaluate(() => window.__shellEmit('tabTap', { id: '99:/nowhere', href: '/nowhere' }));
  await page.waitForTimeout(150);
  assert.equal(new URL(page.url()).pathname, before);
  await ctx.close();
});

test('a shell that will not take the spec keeps the page\'s own tab bar', async () => {
  fresh();
  const { ctx, page } = await open({ refuseTabs: true });
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'Shell.setTabs'));
  await page.waitForTimeout(150);
  const bar = await webTabs(page);
  assert.equal(bar.inFlow, true, 'the web bar is still where the site puts it');
  assert.ok(bar.labels.length > 0);
  await ctx.close();
});

/* ------------------------------------------------- the camera on the sign-up screen (deviations.md D24) */

test('the sign-up screen offers the phone\'s camera, and the picture it takes becomes the new page\'s picture', async () => {
  fresh();
  const { ctx, page } = await open({}, { path: '/join' });
  const button = page.locator('.os-nativepic button');
  await button.waitFor({ timeout: 5000 });
  assert.match(await button.textContent(), /photo of my own/i);

  await page.evaluate(() => {
    window.Capacitor.Plugins.ActionSheet.showActions = async o => { window.__sheet = o; return { index: 0 }; };
    window.Capacitor.Plugins.Camera.takePhoto = async o => { window.__shot = o; return { webPath: '/assets/pfp.png' }; };
  });
  await button.click();
  await page.waitForFunction(() => { const i = document.querySelector('.os-nativepic img'); return i && !i.hidden; }, null, { timeout: 5000 });

  // it really went through the phone's own sheet and camera, not through a file input
  const sheet = await page.evaluate(() => window.__sheet);
  assert.deepEqual(sheet.options.map(o => o.title), ['take a photo', 'choose from my photos', 'cancel']);
  assert.equal(await page.evaluate(() => !!window.__shot), true);

  // sign up: the account is made, then the held picture is uploaded and set — in that order
  await page.evaluate(async () => {
    const { api } = await import('/js/core/api.js');
    await api.post('/signup', { email: 'kat@example.com', password: 'hunter22', name: 'kat' });
  });
  await waitFor(() => seen.some(s => s.path === '/api/me/profile' && s.method === 'PUT'));

  const order = seen.filter(s => ['/api/signup', '/api/media', '/api/me/profile'].includes(s.path)).map(s => s.path);
  assert.deepEqual(order, ['/api/signup', '/api/media', '/api/me/profile']);
  const upload = seen.find(s => s.path === '/api/media').upload;
  assert.equal(upload.purpose, 'avatar');                     // src/index.js:127 lets this through unverified
  assert.ok(upload.bytes > 0, 'the cropped picture really went up');
  assert.equal(seen.find(s => s.path === '/api/media').auth, GOOD, 'uploaded as the new account');
  assert.equal(seen.find(s => s.path === '/api/me/profile').body.avatar, '/media/new-avatar.png');
  await ctx.close();
});

test('nothing is uploaded when no picture was taken', async () => {
  fresh();
  const { ctx, page } = await open({}, { path: '/join' });
  await page.locator('.os-nativepic button').waitFor({ timeout: 5000 });
  await page.evaluate(async () => {
    const { api } = await import('/js/core/api.js');
    await api.post('/signup', { email: 'kat@example.com', password: 'hunter22', name: 'kat' });
  });
  await page.waitForTimeout(300);
  assert.equal(seen.some(s => s.path === '/api/media'), false);
  assert.equal(seen.some(s => s.path === '/api/me/profile'), false);
  await ctx.close();
});

test('the camera button is only on the cards that ask for a picture', async () => {
  fresh();
  // the log-in card is .ms-signup with a .su-lead too, and so are "check your email" and /verify: none of them has a
  // picture step, so none of them may grow a camera button
  const { ctx, page } = await open({}, { path: '/login' });
  await page.locator('.ms-signup').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.os-nativepic').count(), 0);
  await ctx.close();
});

/* ---- Android's Back: what is on top goes first ----

   A listener on the App plugin's backButton replaces Capacitor's own handling, which only walks the web view's history:
   with a dialog open it changed the page underneath and left the dialog up (found on the emulator, 2026-11-05). */

const pressBack = (page, canGoBack) => page.evaluate(c => {
  history.back = () => window.__calls.push(['history.back']);
  window.__appListeners.backButton({ canGoBack: c });
}, canGoBack);
const openDialog = (page, title) => page.evaluate(async t => {
  const { dialog } = await import('/js/core/ui.js');
  dialog({ title: t, text: 'x' }).then(v => window.__calls.push(['closed', t, v]));
}, title);

test('Back closes the dialog on top and only that one, and neither moves the page nor leaves the app', async () => {
  fresh();
  const { ctx, page } = await open();
  await openDialog(page, 'under');
  await openDialog(page, 'over');
  assert.equal(await page.locator('.ms-modal').count(), 2);
  await pressBack(page, true);
  assert.equal(await page.locator('.ms-modal').count(), 1);
  assert.deepEqual(await calls(page, 'closed'), ['over']);
  await pressBack(page, true);
  assert.equal(await page.locator('.ms-modal').count(), 0);
  assert.equal((await calls(page, 'history.back')).length, 0);
  assert.equal((await calls(page, 'App.exitApp')).length, 0);
  await ctx.close();
});

test('with nothing open, Back walks the router, and at the first page it leaves the app', async () => {
  fresh();
  const { ctx, page } = await open();
  await pressBack(page, true);
  assert.equal((await calls(page, 'history.back')).length, 1);
  assert.equal((await calls(page, 'App.exitApp')).length, 0);
  await pressBack(page, false);
  assert.equal((await calls(page, 'history.back')).length, 1);
  assert.equal((await calls(page, 'App.exitApp')).length, 1);
  await ctx.close();
});

/* ---- a call with no answer at all ---- */

for (const app of [false, true]) {
  test(`no answer from the server is said in the site's words, not the browser's (${app ? 'app' : 'browser'})`, async () => {
    fresh();
    const { ctx, page } = await open({}, { app });
    await page.route('**/api/**', r => r.abort());
    const said = await page.evaluate(async () => {
      const { api } = await import('/js/core/api.js');
      try { await api.get('/boards'); return 'no error'; } catch (e) { return e.message; }
    });
    assert.match(said, /can't reach ourspace/);
    await ctx.close();
  });
}
