/* core/native.js — the bridge between this bundle and the iOS / Android shells (mobile/, docs/mobile/contract.md).
   In a browser it does nothing at all: it checks for Capacitor's native runtime, finds none, and exports `isApp = false`.
   In the app it runs once, before app.js starts (a top-level await holds app.js back for a few milliseconds), and:
   · sends X-OurSpace-Client on every API call and Authorization: Bearer when signed in. It does that at the one place
     every call passes: fetch / XMLHttpRequest / WebSocket are wrapped, so api.js, live.js and readmarker.js stay as they are.
   · points /api/* at OURSPACE_ORIGIN (a build-time setting, mobile/ourspace.config.json, read from /native-config.json)
   · keeps the session token in the iOS Keychain / Android Keystore, never in localStorage (a WebView XSS can read that)
   · opens the chat socket with a one-room pass from POST /api/live/ticket, not the session token: a handshake publishes
     the subprotocol it settles on as `socket.protocol`, which is the one place the Keychain cannot protect (redteam R8)
   · opens Google / Discord sign-in in ASWebAuthenticationSession / a Custom Tab, takes a one-time code back on
     ourspace://auth?code= and trades it for the session over TLS (nothing secret ever rides the custom scheme)
   · registers the device (POST /api/me/devices) and routes notification taps and links to their page, cold start included
   · uses the phone for what a browser can't do well: photo picker and camera (into the existing POST /api/media), share
     sheet, haptics, offline shell, and the splash that hides once the page's first frame is on screen.
   · draws the tab bar natively (core/tabbar.js + core/tabspec.js): the page's own `.ms-tabs` is MEASURED and the shell
     redraws it as a real scroll view of real buttons, outside the web view. Nothing about its look is decided here.
   Nothing here restyles anything. Where the phone forces a departure it is in docs/mobile/deviations.md. */

import { toast } from './ui.js';
import { S, loadMe } from './state.js';
import { go, route, onLeave } from './router.js';
import { useLiveTickets } from './live.js';
import { wireTabBar } from './tabbar.js';
import { wireJoinPhoto } from './joinphoto.js';

const cap = globalThis.Capacitor;
export const isApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

/* ------------------------------------------------------------ state */

const SESSION_KEY = 'ourspace_session';        // the Keychain / Keystore entry
const SCHEME = 'ourspace';
const TICKET_HEADER = 'X-OurSpace-Ticket';     // src/shared/app.js: the half-finished provider sign-up an app carries instead of os_signup
const SIGN_IN = new Set(['/api/signup', '/api/login', '/api/signup/finish', '/api/password/reset']);   // contract §2 (verify never starts a session)
const ME_CACHE = 'os.me.cache';
const ME_CACHE_DAYS = 14;

let P = null;                  // Capacitor.Plugins (the bridge builds one proxy per installed native plugin)
let platform = 'web';
let origin = 'http://localhost:8787';     // overwritten by native-config.json
let client = 'app/web/0';
let token = null;              // the session, in memory; the copy that survives a restart is in secure storage
let ticket = null;             // from POST /api/oauth/exchange, until the sign-up it belongs to is finished
let booting = true;            // until app.js has been let go: before that a link can set the first page with replaceState
let pushToken = null;
let authNext = null;
let nativeFetch = null;       // the browser's own fetch, for the photo requests below
let tabBar = null;            // the native tab bar, once the shell has accepted one (core/tabbar.js)
let joinPhoto = null;         // the camera on the sign-up screen (core/joinphoto.js)

/* ------------------------------------------------------------ helpers */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const frames = n => new Promise(r => { const step = k => (k ? requestAnimationFrame(() => step(k - 1)) : r()); step(n); });
const same = u => u.origin === location.origin;
const isApi = u => same(u) && u.pathname.startsWith('/api/');
const plugin = name => {
  if (!P) return null;
  if (P[name]) return P[name];
  return name === 'OurSpaceShell' ? cap.registerPlugin(name) : null;      // the app's own plugin (ios/…/SceneDelegate.swift, android/…/ShellPlugin.java)
};
const browse = url => { const b = plugin('Browser'); if (b) b.open({ url }).catch(() => {}); };

// a path inside the site from a notification's `url`, a universal link or a launch URL — or null. Only OUR origin or a
// relative path; never anything the server (or a link) could use to point the app somewhere else.
// The scheme is checked first and by allow-list, not by excluding ourspace:. An origin comparison alone is not a guard:
// a URL with an opaque origin (ourspace:, capacitor:, javascript:, data:, blob:) serialises `origin` to the *string*
// "null", and in a WebView whose page is also on an opaque origin "null" === "null" passed every one of them through
// (redteam R9). http / https are the only two schemes this site is ever served over.
export function sitePath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw, origin); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.origin !== origin && u.origin !== location.origin) return null;
  if (u.pathname.startsWith('//') || u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/')) return null;
  return u.pathname + u.search + u.hash;
}

function openPage(path) {                      // open a page: the first page of a cold start, or a normal navigation
  const p = sitePath(path);
  if (!p) return;
  if (booting) history.replaceState(null, '', p); else go(p);
}

/* ------------------------------------------------------------ the session token (secure storage) */

// @aparajita/capacitor-secure-storage, pinned in mobile/package.json: iOS Keychain (this device only), Android Keystore AES-GCM.
// Its native methods are called directly because this bundle has no bundler to import the JS wrapper. There is deliberately
// no fallback to localStorage: if the store refuses, the token lives in memory and the next launch signs in again.
async function loadToken() {
  const ss = plugin('SecureStorage');
  if (!ss) return;
  try { const r = await ss.internalGetItem({ prefixedKey: SESSION_KEY, sync: false }); token = (r && r.data) || null; } catch { token = null; }
}
async function saveToken(t) {
  token = t || null;
  const ss = plugin('SecureStorage');
  if (!ss) return;
  try {
    // access: 1 is the plugin's KeychainAccess.whenUnlockedThisDeviceOnly (0 is whenUnlocked, 2 is afterFirstUnlock):
    // readable only while the phone is unlocked, and never carried to another device by a backup. Nothing reads the
    // token outside this WebView — push arrives and is drawn natively, and the device row is only ever written from
    // registerDevice() below, with the app running — so nothing needs it before the first unlock. `sync: false` keeps
    // it out of iCloud. (redteam R13 read `1` as afterFirstUnlock; it is not, and this is already the tightest class
    // that survives a reboot without a passcode requirement.)
    if (token) await ss.internalSetItem({ prefixedKey: SESSION_KEY, data: token, sync: false, access: 1 });
    else await ss.internalRemoveItem({ prefixedKey: SESSION_KEY, sync: false });
  } catch (e) { console.warn('secure storage refused the session token', e && e.message); }
}
// The Keychain survives an uninstall on iOS; contract §8 says a reinstall signs in again. localStorage does not survive
// an uninstall, so its absence is how a fresh install is told apart (the token is dropped, which only ever signs out).
// This guard fails CLOSED (redteam R13): a read that throws — storage blocked, quota, a WebView that refuses it — is
// not proof that this install is the one the token was saved in, so the token goes. The cost of being wrong that way is
// one sign-in; the cost of the other way is the previous installation's session handed to whoever reinstalled.
async function forgetOnFreshInstall() {
  let installed = false;
  try { installed = !!localStorage.getItem('os.installed'); } catch { installed = false; }
  if (installed) return;
  await saveToken(null);
  try { localStorage.setItem('os.installed', String(Date.now())); } catch { /* every launch drops it until this works */ }
}

/* ------------------------------------------------------------ talking to the API */

function patchNetwork() {
  const realFetch = nativeFetch = window.fetch.bind(window);
  const addHeaders = (set, pathname) => {
    set('X-OurSpace-Client', client);
    if (token) set('Authorization', 'Bearer ' + token);
    if (ticket && (pathname === '/api/signup/pending' || pathname === '/api/signup/finish')) set(TICKET_HEADER, ticket);
  };

  window.fetch = async function ourspaceFetch(input, init) {
    let u;
    try { u = new URL(input instanceof Request ? input.url : String(input), location.href); } catch { return realFetch(input, init); }
    if (!isApi(u)) return realFetch(input, init);
    await ready;                               // the first API call of the page waits for the token and the origin (a few ms)

    const method = String((init && init.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    addHeaders((k, v) => headers.set(k, v), u.pathname);
    const target = origin + u.pathname + u.search;
    // credentials 'omit': the Worker never answers Allow-Credentials (contract §4), so a credentialed cross-origin call would fail
    const opts = { ...(init || {}), headers, credentials: 'omit' };
    const req = input instanceof Request ? new Request(new Request(target, input), opts) : null;

    let res;
    try { res = req ? await realFetch(req) : await realFetch(target, opts); } catch (e) {
      const cached = method === 'GET' && u.pathname === '/api/me' ? cachedMe() : null;   // the offline shell: the last /api/me
      if (cached) return cached;
      throw e;
    }
    await afterApi(u.pathname, method, res);
    return res;
  };

  // uploads (api.upload uses XHR for progress): the same address, headers and no cookies
  const XO = XMLHttpRequest.prototype;
  const xOpen = XO.open, xSend = XO.send;
  XO.open = function (method, url, ...rest) {
    let u = null;
    try { u = new URL(String(url), location.href); } catch { /* leave it */ }
    const mine = u && isApi(u);
    const r = xOpen.call(this, method, mine ? origin + u.pathname + u.search : url, ...rest);
    if (mine) { this.__os = u.pathname; addHeaders((k, v) => this.setRequestHeader(k, v), u.pathname); }
    return r;
  };
  XO.send = function (body) {
    if (this.__os) {
      try { this.withCredentials = false; } catch { /* already sending */ }
      this.addEventListener('load', () => { if (this.status === 401 && token) dropSession(); });
    }
    return xSend.call(this, body);
  };

  // the chat socket: live.js asks for wss://<this page's host>/api/live/<room>; the app's host is the Worker. Nothing
  // is added to the handshake here — the subprotocols are live.js's, and the only credential among them is the
  // one-room pass below.
  const RealWS = window.WebSocket;
  function OurSpaceWebSocket(url, protocols) {
    let u;
    try { u = new URL(String(url), location.href); } catch { return new RealWS(url, protocols); }
    if (!u.pathname.startsWith('/api/live/') || u.host !== location.host) return new RealWS(url, protocols);
    const to = new URL(origin);
    const target = (to.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + to.host + u.pathname + u.search;
    const list = [].concat(protocols || []);
    return list.length ? new RealWS(target, list) : new RealWS(target);
  }
  OurSpaceWebSocket.prototype = RealWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) OurSpaceWebSocket[k] = RealWS[k];
  window.WebSocket = OurSpaceWebSocket;

  // The handshake's credential (contract §7). A WebSocket can set no headers, so it has to travel as a subprotocol —
  // and whatever subprotocol a handshake settles on, the browser publishes on the live socket as `socket.protocol`,
  // where any script in the page can read it. The session token lived in the Keychain exactly so that could not happen,
  // so what goes there now is a pass for ONE room, good for one handshake and 30 seconds (redteam R8). `ourspace.live`
  // is offered alongside it and is what the room picks, so even that pass is not echoed back.
  useLiveTickets(async room => {
    if (!token) return [];                     // signed out: the socket will be refused, and live.js falls back to polling
    const res = await window.fetch('/api/live/ticket', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: String(room) }),
    });
    if (!res.ok) {
      const e = new Error('no pass for that room');
      e.status = res.status;                   // 401 / 403 / 404: live.js ends the room for good, as it does for the history
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body: treated as no pass */ }
    return data && typeof data.ticket === 'string' ? ['ourspace.live', 'ourspace.bearer.' + data.ticket] : [];
  });
}

async function afterApi(path, method, res) {
  if (res.status === 401 && token && !SIGN_IN.has(path)) { dropSession(); return; }      // the server no longer knows this session
  if (path === '/api/logout' && method === 'POST') { await dropSession(); clearMeCache(); return; }
  if (!res.ok) return;
  if (path === '/api/me' && method === 'GET') { rememberMe(res.clone()); return; }
  if (method === 'POST' && SIGN_IN.has(path)) {
    let data = null;
    try { data = await res.clone().json(); } catch { /* no body */ }
    if (data && data.session && typeof data.session.token === 'string') {
      await saveToken(data.session.token);
      ticket = null;
      signedIn(true);
      // the picture picked on the sign-up screen with the phone's own camera, now that there is an account to own it
      if (joinPhoto && (path === '/api/signup' || path === '/api/signup/finish')) {
        joinPhoto.attach().then(url => { if (url) loadMe().catch(() => {}); });
      }
    }
  }
}

async function dropSession() { await saveToken(null); clearMeCache(); }

/* the offline shell. The page itself is on the device; the one thing it needs to draw its chrome is /api/me, so the last
   good answer is kept (name, counts — no token) and used only when the network itself is down. */
async function rememberMe(res) {
  try { const body = await res.text(); localStorage.setItem(ME_CACHE, JSON.stringify({ t: Date.now(), body })); } catch { /* full or blocked */ }
}
function clearMeCache() { try { localStorage.removeItem(ME_CACHE); } catch { /* blocked */ } }
function cachedMe() {
  if (!token) return null;
  try {
    const c = JSON.parse(localStorage.getItem(ME_CACHE) || 'null');
    if (!c || Date.now() - c.t > ME_CACHE_DAYS * 864e5) return null;
    return new Response(c.body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-OurSpace-Cached': '1' } });
  } catch { return null; }
}

/* ------------------------------------------------------------ members' photos live on the Worker, not in the bundle

   On the web an <img src="/media/…"> carries the session cookie, so the Worker decides per viewer who may see the photo
   (a private profile's followers only, a block either way, a moderator's hide). In the app an <img> is cross-origin and
   carries nothing, and the Worker answers a private photo with Cross-Origin-Resource-Policy: same-origin. So, signed in,
   EVERY /media/ image on an <img> is fetched with the bearer token (a CORS fetch, which CORP does not govern) and handed
   to the element as a blob: URL. Uniform, not "try directly, fall back on failure": a direct load is anonymous, and the
   Worker answers an anonymous request for some photos that this viewer must not see (they have blocked the author, or the
   author them), so a fallback design would show those. Signed out, nobody is deciding anything, and the plain URL is used.
   The cost, in docs/mobile/deviations.md D21: no browser HTTP-cache hit for a photo, and blobs held in memory, which is why
   they are few, capped by size, shared between images, and revoked when the page is left. */

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';   // what the <img> shows meanwhile
const BROKEN = 'data:image/gif;base64,AA==';   // not an image: the browser's real load error, so the page sees what it sees on the web
const MAX_BLOBS = 40;                          // held at once
const MAX_BLOB_BYTES = 24 * 1024 * 1024;       // …and in total (animated GIF avatars; a 2019 Android)
const MAX_PARALLEL = 4;                        // photo requests in flight (a private profile can have dozens on one page)
const photoBlobs = new Map();                  // '/media/…' → { url: 'blob:…', size }, oldest first
const photoLoads = new Map();                  // '/media/…' → Promise<'blob:…'>, one request however many images ask
let photoBytes = 0, photoArmed = false, photoBusy = 0;
const photoQueue = [];

export const mediaStats = () => ({ blobs: photoBlobs.size, bytes: photoBytes, loading: photoLoads.size });

function dropPhotoBlob(rel) {
  const b = photoBlobs.get(rel);
  if (!b) return;
  photoBlobs.delete(rel);
  photoBytes -= b.size;
  URL.revokeObjectURL(b.url);
}
function dropAllPhotoBlobs() { for (const rel of [...photoBlobs.keys()]) dropPhotoBlob(rel); }

const photoSlot = () => (photoBusy < MAX_PARALLEL ? (photoBusy++, Promise.resolve()) : new Promise(r => photoQueue.push(r)));
const photoDone = () => { const next = photoQueue.shift(); if (next) next(); else photoBusy--; };

async function fetchPhoto(rel) {
  await photoSlot();
  try {
    const res = await nativeFetch(origin + rel, { mode: 'cors', credentials: 'omit', headers: { Authorization: 'Bearer ' + token, 'X-OurSpace-Client': client } });
    if (res.status === 401 && token) dropSession();
    if (!res.ok) throw new Error('photo ' + res.status);
    const blob = await res.blob();
    if (!/^image\//.test(blob.type)) throw new Error('not a photo');
    const url = URL.createObjectURL(blob);
    photoBlobs.set(rel, { url, size: blob.size });
    photoBytes += blob.size;
    while (photoBlobs.size > 1 && (photoBlobs.size > MAX_BLOBS || photoBytes > MAX_BLOB_BYTES)) dropPhotoBlob(photoBlobs.keys().next().value);   // the oldest first
    if (!photoArmed) { photoArmed = true; onLeave(() => { photoArmed = false; dropAllPhotoBlobs(); }); }   // gone with the page
    return url;
  } finally { photoDone(); }
}

function photoBlob(rel) {
  const held = photoBlobs.get(rel);
  if (held) { photoBlobs.delete(rel); photoBlobs.set(rel, held); return Promise.resolve(held.url); }   // (most recently used last)
  let load = photoLoads.get(rel);
  if (!load) {
    load = fetchPhoto(rel);
    photoLoads.set(rel, load);
    const forget = () => photoLoads.delete(rel);
    load.then(forget, forget);
  }
  return load;
}

function patchMedia() {
  const plain = v => (typeof v === 'string' && v.startsWith('/media/') ? origin + v : v);
  const setAttr = Element.prototype.setAttribute;

  // an <img> being given /media/…: while signed in, a blob of the photo. If that fails (404: not yours to see, gone; or the
  // network) the image is BROKEN, as on the web. Never the plain URL: that would ask anonymously, and the Worker answers
  // some photos anonymously that this viewer, who is blocked, must not see.
  function photoFor(img, rel) {
    const seq = img.__osPhoto = (img.__osPhoto || 0) + 1;
    setAttr.call(img, 'src', PIXEL);
    photoBlob(rel).then(
      url => { if (img.__osPhoto === seq) setAttr.call(img, 'src', url); },
      () => { if (img.__osPhoto === seq) setAttr.call(img, 'src', BROKEN); });
  }
  const forImg = (img, v) => {
    if (typeof v === 'string' && v.startsWith('/media/') && token) { photoFor(img, v); return true; }
    img.__osPhoto = (img.__osPhoto || 0) + 1;       // a newer value (any value) cancels a load still in flight for this element
    return false;
  };

  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if (n === 'src' && this instanceof HTMLImageElement && forImg(this, value)) return undefined;
    return setAttr.call(this, name, n === 'src' || n === 'poster' ? plain(value) : value);
  };
  for (const [proto, prop] of [[HTMLImageElement.prototype, 'src'], [HTMLMediaElement.prototype, 'src'], [HTMLSourceElement.prototype, 'src'], [HTMLVideoElement.prototype, 'poster']]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) continue;
    const isImg = proto === HTMLImageElement.prototype;
    Object.defineProperty(proto, prop, { ...d, set(v) { if (isImg && forImg(this, v)) return; d.set.call(this, plain(v)); } });
  }
}

/* ------------------------------------------------------------ sign-in with Google / Discord (contract §6)

   Nothing secret comes back on ourspace://. The scheme is a public, exported BROWSABLE intent filter on Android, so a
   co-installed app that declares `ourspace` is offered the OAuth return; and on either platform any installed app, or a
   tapped web link, can fire an ourspace:// URL at this one. The old flow took `token=` from whatever arrived and saved
   it, which was both a theft (Android: the victim's 90-day token read off the scheme) and an injection (either
   platform: the attacker's token written into the victim's Keychain, and the victim's push token and device label
   registered into the attacker's account) — redteam R1.

   So: before the sheet opens, this app mints a 256-bit `verifier`, keeps it in memory and nowhere else, and sends the
   server SHA-256(verifier). What comes back on the scheme is a one-time CODE, and the code is only worth something to
   whoever holds the verifier: POST /api/oauth/exchange over TLS trades the two for the session (or, for somebody new,
   the sign-up ticket). A hijacking app reads a code it cannot spend. A code fired at us out of nowhere matches no
   verifier of ours and is dropped without a word. One attempt per sign-in: the verifier is spent by the first
   ourspace://auth that arrives, whatever it carries. docs/mobile/r1-fix.md. */

const AUTH_WINDOW_MS = 600000;                 // as long as the server keeps the sign-in's oauth_states row
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256b64 = async s => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));

let pendingAuth = null;                        // { verifier, until }: a sign-in THIS app started and has not collected

// arm a sign-in: a new verifier (any outstanding one is abandoned) → the challenge to send with /start
async function armAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256b64(verifier);
  pendingAuth = { verifier, until: Date.now() + AUTH_WINDOW_MS };
  return challenge;
}
// the verifier for the attempt being answered right now, and nothing afterwards gets it
function takeAuth() {
  const p = pendingAuth;
  pendingAuth = null;
  return p && p.until > Date.now() ? p.verifier : null;
}

async function webAuth(url) {                  // → the ourspace:// URL the provider flow ended on, or null
  const shell = plugin('OurSpaceShell');
  if (platform === 'ios' && shell) {
    const r = await shell.authenticate({ url, scheme: SCHEME });
    return (r && r.url) || null;
  }
  // Android: a Custom Tab. It has no completion callback; the redirect to ourspace:// re-opens this activity and arrives as appUrlOpen.
  const browser = plugin('Browser');
  return new Promise(resolve => {
    waitingForAuth = resolve;
    browser.open({ url }).catch(() => { waitingForAuth = null; resolve(null); });
  });
}
let waitingForAuth = null;

async function startProviderSignIn(a) {
  const u = new URL(a.href, location.href);
  const m = /^\/api\/oauth\/([a-z]+)\/start$/.exec(u.pathname);
  const mode = u.searchParams.get('mode') || 'login';
  if (!m) return false;
  if (mode !== 'login') {                      // the server refuses these from an app (it has no cookie in the browser sheet)
    toast('connecting accounts is done on the website for now: open ourspace in a browser on your phone, then Settings.', true);
    return true;
  }
  authNext = sitePath(u.searchParams.get('next'));
  const start = new URL(origin + u.pathname);
  start.searchParams.set('mode', 'login');
  if (authNext) start.searchParams.set('next', authNext);
  start.searchParams.set('client', 'app');
  try {
    start.searchParams.set('challenge', await armAuth());
  } catch (e) {
    pendingAuth = null;
    toast('sign-in with google or discord isn\'t available on this phone. use your email and password.', true);
    return true;
  }
  try {
    const back = await webAuth(start.href);
    if (back) await onAppUrl(back);
  } catch (e) { pendingAuth = null; toast('sign-in didn\'t go through. try again.', true); }
  return true;
}

const AUTH_ERRORS = {
  cancelled: 'sign-in cancelled.',
  expired: 'that sign-in took too long. try again.',
  busy: 'too many tries. wait a few minutes and try again.',
  unavailable: 'that way of signing in isn\'t available right now.',
  suspended: 'that account is suspended.',
};

// Trade the one-time code for what the sign-in was actually for. The plain fetch, not the wrapped one: the address is
// built here, and the old token (if there is one) has no business on this call.
async function collectSignIn(code, verifier) {
  const oops = (msg = 'sign-in didn\'t go through. try again.') => toast(msg, true);
  let data = null;
  try {
    const res = await (nativeFetch || fetch)(origin + '/api/oauth/exchange', {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-OurSpace-Client': client },
      body: JSON.stringify({ code, verifier }),
    });
    data = await res.json().catch(() => null);
    if (!res.ok) return oops((data && data.error) || undefined);
  } catch { return oops('sign-in didn\'t go through. check your connection and try again.'); }

  if (data && data.session && typeof data.session.token === 'string') {
    await saveToken(data.session.token);
    ticket = null;
    if (!booting) await loadMe().catch(() => {});          // (while booting, app.js is about to do it)
    signedIn(true);
    openPage(authNext || '/');
    authNext = null;
    if (S.me) toast(`welcome back, ${S.me.name}!`);
    return;
  }
  // somebody new: the sign-up ticket, which goes on as X-OurSpace-Ticket (contract §2) and never near the scheme
  if (data && typeof data.ticket === 'string') { ticket = data.ticket; openPage('/join/finish'); return; }
  oops();
}

// every ourspace:// or https://<origin>/… that reaches the app: the OAuth return, a universal link, a launch URL
async function onAppUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return; }
  if (u.protocol === `${SCHEME}:`) {
    const what = u.hostname || u.pathname.replace(/^\/+/, '');
    if (waitingForAuth) { const done = waitingForAuth; waitingForAuth = null; done(null); Promise.resolve(plugin('Browser').close()).catch(() => {}); }   // (Android: not implemented, and not needed)
    if (what === 'auth') {
      // one attempt per sign-in, and only for a sign-in this app started: whatever this URL turns out to be, the
      // verifier is spent here. Anything that arrives without one is somebody else's URL — drop it, say nothing.
      const verifier = takeAuth();
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (!verifier) return;
      if (code) await collectSignIn(code, verifier);
      else if (err) toast(AUTH_ERRORS[err] || 'sign-in with that didn\'t work. try again.', true);
    }
    // ourspace://join?ticket= is gone: a sign-up ticket is a secret of the same weight as the token, and it now comes
    // out of the exchange above like everything else. Any other ourspace:// host is not ours to act on.
    return;
  }
  const p = sitePath(raw);                     // https://<origin>/u/kat/post/3 and the like
  if (p) openPage(p);
}

/* ------------------------------------------------------------ this device: registration and push */

let registeredAt = 0;
async function registerDevice(force) {
  if (!token || !plugin('Device')) return;
  const key = JSON.stringify([token.slice(-12), pushToken]);
  if (!force && key === lastRegistered && Date.now() - registeredAt < 12 * 36e5) return;
  try {
    const info = await plugin('Device').getInfo();
    const label = String(info.name || info.model || platform).slice(0, 60);
    await fetch('/api/me/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pushToken ? { platform, label, pushToken } : { platform, label }),
    });
    lastRegistered = key;
    registeredAt = Date.now();
  } catch { /* offline or signed out: the next launch tries again */ }
}
let lastRegistered = '';

// after a sign-in (or at start-up while signed in): register this device, and ask for notifications once per install
function signedIn(fresh) {
  registerDevice(true);
  const pn = plugin('PushNotifications');
  if (!pn) return;
  (async () => {
    try {
      let perm = await pn.checkPermissions();
      if (perm.receive === 'prompt' && fresh && !localStorage.getItem('os.push.asked')) {
        localStorage.setItem('os.push.asked', '1');
        perm = await pn.requestPermissions();
      }
      if (perm.receive === 'granted') {
        if (platform === 'android') await pn.createChannel({ id: 'default', name: 'OurSpace', description: 'messages, replies and requests', importance: 4 }).catch(() => {});
        await pn.register();                   // → 'registration' with the APNs / FCM token
      }
    } catch (e) { console.warn('push setup', e && e.message); }
  })();
}

async function setupPush() {
  const pn = plugin('PushNotifications');
  if (!pn) return;
  let firstTap = null;
  const tapped = new Promise(r => { firstTap = r; });
  // Registered before the first route: a tap that cold-started the app is held by the plugin until a listener exists,
  // and is delivered the moment this one is added — which is why the page can open on the exact thread, not on the feed.
  await pn.addListener('pushNotificationActionPerformed', ev => {
    const url = ev && ev.notification && ev.notification.data && ev.notification.data.url;
    openPage(url);
    firstTap(true);
  });
  await pn.addListener('registration', t => { pushToken = t && t.value; registerDevice(true); });
  await pn.addListener('registrationError', e => console.warn('push registration', e && e.error));
  await pn.addListener('pushNotificationReceived', n => {
    if (platform === 'android') toast(`${n.title || 'ourspace'}${n.body ? ': ' + n.body : ''}`, false, () => openPage(n.data && n.data.url));   // (iOS shows its own banner)
    if (S.me) loadMe().catch(() => {});        // the tab badges
  });
  await Promise.race([tapped, sleep(120)]);    // give a retained cold-start tap its moment; most launches wait no time at all
}

/* ------------------------------------------------------------ what the page opens by itself */

function wireClicks() {
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented) return;
    const raw = a.getAttribute('href');

    if (raw === '#' && /^copy link$/i.test((a.textContent || '').trim())) {   // blog.js: "copy link" → the share sheet
      e.preventDefault(); e.stopImmediatePropagation();
      share({ title: document.title, url: publicUrl(location.href) });
      return;
    }
    let u;
    try { u = new URL(a.href, location.href); } catch { return; }
    if (same(u) && /^\/api\/oauth\//.test(u.pathname)) {
      e.preventDefault(); e.stopImmediatePropagation();
      startProviderSignIn(a);
      return;
    }
    if (same(u) && (u.pathname.startsWith('/media/') || u.pathname.startsWith('/api/'))) {   // a photo on the Worker: show it in the system browser
      e.preventDefault(); e.stopImmediatePropagation();
      browse(origin + u.pathname + u.search);
      return;
    }
    if (!same(u) && /^https?:$/.test(u.protocol) && !a.hasAttribute('download')) {          // leaving the site: never inside the app's own web view
      e.preventDefault(); e.stopImmediatePropagation();
      browse(u.href);
    }
  }, true);
}

// a link to share or copy must be the real address, not capacitor://localhost/…
function publicUrl(href) {
  try { const u = new URL(href); return origin + u.pathname + u.search + u.hash; } catch { return href; }
}
function patchShareAndClipboard() {
  try {
    const cb = navigator.clipboard;
    const write = cb && cb.writeText && cb.writeText.bind(cb);
    if (write) cb.writeText = t => write(typeof t === 'string' && t.startsWith(location.origin) ? publicUrl(t) : t);
  } catch { /* read-only: the share sheet still carries the right link */ }
  if (!navigator.share && plugin('Share')) {
    navigator.share = d => share(d || {});
    navigator.canShare = () => true;
  }
}
async function share(d) {
  const sh = plugin('Share');
  try { await sh.share({ title: d.title, text: d.text, url: d.url, dialogTitle: 'share' }); } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast(d.url || 'sharing isn\'t available.', false); }
}

/* the photo picker and camera, into the same <input type="file"> the pages already use (so POST /api/media is untouched) */
function patchFileInputs() {
  const click = HTMLInputElement.prototype.click;
  const wants = el => el.type === 'file' && /image/.test(el.accept || '') && !el.disabled && plugin('Camera') && plugin('ActionSheet');
  HTMLInputElement.prototype.click = function () {
    if (wants(this)) { pickPhotos(this); return; }
    return click.call(this);
  };
  document.addEventListener('click', e => {      // a visible file input tapped directly
    if (e.target instanceof HTMLInputElement && wants(e.target)) { e.preventDefault(); pickPhotos(e.target); }
  }, true);
}
/* The phone's own sheet → File objects. Used by the page's file inputs (above) and by the camera button the app puts
   on the sign-up screen (core/joinphoto.js), which has no file input to put anything into. Resolves to [] when the
   member backed out; throws only when a caller should be told something went wrong. */
async function pickFiles({ multiple = false } = {}) {
  const sheet = await plugin('ActionSheet').showActions({
    title: 'add a picture',
    options: [{ title: 'take a photo' }, { title: 'choose from my photos' }, { title: 'cancel', style: 'CANCEL' }],
  });
  if (sheet.index === 2 || sheet.index == null) return [];
  const cam = plugin('Camera');
  const shots = sheet.index === 0
    ? [await cam.takePhoto({ quality: 92, correctOrientation: true, encodingType: 0 })]
    : (await cam.chooseFromGallery({ mediaType: 0, allowMultipleSelection: !!multiple, limit: multiple ? 10 : 1 })).results;
  const files = [];
  for (const s of shots) {
    const blob = await (await fetch(s.webPath)).blob();      // a file on the device, served same-origin by the shell
    files.push(new File([blob], `photo-${Date.now()}-${files.length}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`, { type: blob.type || 'image/jpeg' }));
  }
  return files;
}

// what a failed pick should say, in the site's own voice
function pickFailed(e) {
  const msg = String((e && e.message) || e);
  if (/cancel|dismiss/i.test(msg)) return null;
  if (/denied|permission/i.test(msg)) return 'ourspace needs access to your camera or photos: turn it on in your phone\'s settings.';
  return 'couldn\'t get that picture. try again.';
}

async function pickPhotos(input) {
  try {
    const files = await pickFiles({ multiple: input.multiple });
    if (!files.length) return;
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    const why = pickFailed(e);
    if (why) toast(why, true);
  }
}

/* haptics on interactions that already exist (delegated; nothing in the pages knows about them) */
function wireHaptics() {
  const hp = plugin('Haptics');
  if (!hp) return;
  let last = 0;
  const buzz = fn => { const now = Date.now(); if (now - last < 60) return; last = now; fn().catch(() => {}); };
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('button, .btn98, .ms-tab, .ms-actions a, .post-reactions *');
    if (!t || t.disabled || t.closest('.ms-modal')) return;
    if (t.matches('.go, .ms-fab, .ms-followbtn')) buzz(() => hp.impact({ style: 'MEDIUM' }));
    else if (t.matches('.ms-tab')) buzz(() => hp.selectionChanged());
    else buzz(() => hp.impact({ style: 'LIGHT' }));
  }, true);
  const box = document.getElementById('toasts');
  if (box) new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.classList && n.classList.contains('toast')) buzz(() => hp.notification({ type: n.classList.contains('bad') ? 'ERROR' : 'SUCCESS' }));
    }
  }).observe(box, { childList: true });
}

/* ------------------------------------------------------------ offline */

async function wireNetwork() {
  const net = plugin('Network');
  if (!net) return;
  let was = (await net.getStatus().catch(() => ({ connected: true }))).connected;
  net.addListener('networkStatusChange', st => {
    if (st.connected === was) return;
    was = st.connected;
    if (!st.connected) { toast('you\'re offline. what you\'ve already opened stays here; the rest comes back with your connection.', true); return; }
    toast('back online.');
    if (S.me || document.querySelector('#ms-content .ms-error')) loadMe().then(() => { if (document.querySelector('#ms-content .ms-error')) route(); }).catch(() => {});
  });
}

/* Android's Back button. Listening for it switches off Capacitor's own handling, which only walks the web view's history:
   with a dialog open that changed the page underneath and left the dialog up. So what is on top goes first, closed the way
   its ✕ closes it, and otherwise this does what Capacitor did. iOS has no such button, and never fires this. */
function onBack({ canGoBack }) {
  const close = [...document.querySelectorAll('.ms-modal')].pop()?.querySelector('[aria-label="close"]');
  if (close) close.click();
  else if (canGoBack) history.back();
  else plugin('App').exitApp();
}

/* ------------------------------------------------------------ start-up */

async function boot() {
  const shell = () => plugin('OurSpaceShell');
  // the splash (native, a render of this page's first frame) goes away once that frame is really on screen
  frames(2).then(() => { const s = shell(); if (s) s.hideSplash().catch(() => {}); });

  try {
    const cfg = await (await fetch('/native-config.json', { cache: 'no-store' })).json();
    if (cfg && cfg.origin) origin = cfg.origin;
  } catch { /* keep the default: the demo */ }
  let version = '0';
  try { version = (await plugin('App').getInfo()).version || '0'; } catch { /* keep */ }
  client = `app/${platform}/${version}`;

  await forgetOnFreshInstall();
  await loadToken();
  patchShareAndClipboard();
  patchFileInputs();
  wireClicks();
  wireHaptics();

  // the native tab bar (deviations.md D3/D22): the page's own `.ms-tabs` is measured by core/tabspec.js and drawn by
  // the shell. A shell that has no setTabs — an older build — leaves the web bar exactly where it has always been.
  const sh = shell();
  if (sh) {
    tabBar = wireTabBar(sh) || null;
    if (!tabBar) console.info('this shell has no native tab bar; the page keeps its own');
  }
  // the camera on the sign-up screen, so a reviewer meets a native sheet in the first few seconds (deviations.md D24)
  if (plugin('Camera') && plugin('ActionSheet')) {
    joinPhoto = wireJoinPhoto({
      pick: async opts => {
        try { return await pickFiles(opts); } catch (e) { const why = pickFailed(e); if (!why) return []; throw new Error(why); }
      },
    }) || null;
  }

  const app = plugin('App');
  if (app) {
    await app.addListener('appUrlOpen', ev => onAppUrl(ev.url));
    try { const launch = await app.getLaunchUrl(); if (launch && launch.url) await onAppUrl(launch.url); } catch { /* none */ }
    app.addListener('appStateChange', st => { if (st.isActive && token) { registerDevice(false); if (S.me) loadMe().catch(() => {}); } });
    app.addListener('backButton', ev => onBack(ev));
  }
  await setupPush();
  wireNetwork();
  if (token) signedIn(false);                  // a signed-in launch: refresh the device row, re-register for push if allowed
}

/* Synchronous part: runs while the module is evaluated, so the wrappers are in place before app.js makes its first call.
   The asynchronous part (config, token, links) is `ready`; the wrapped fetch waits for it. */
let ready = Promise.resolve();
if (isApp) {
  P = cap.Plugins || {};
  platform = cap.getPlatform();                // 'ios' | 'android'
  patchNetwork();
  patchMedia();
  if (platform === 'ios') {                    // a focused field must not make WKWebView zoom the page (fields here are 11–12px); pinch zoom stays
    const vp = document.querySelector('meta[name=viewport]');
    if (vp && !/maximum-scale/.test(vp.content)) vp.content += ', maximum-scale=1';
  }
  ready = boot().catch(e => console.error('native bridge failed to start; the web build runs as it is', e)).then(() => { booting = false; });
}
