// "Other options": sign in with Google or Discord — and connecting Spotify, which uses the same machinery. A provider
// only appears when its keys are configured (docs/deploy.md → "Other sign-in options").
//
//   GET  /api/oauth/:provider/start?mode=login|link|spotify&next=/path   → 303 to the provider
//   GET  /api/oauth/:provider/callback                                     → 303 back into the site
//   GET  /api/signup/pending   POST /api/signup/finish                    new people: screen name + birthday first
//   GET  /api/auth/providers   GET /api/me/account   DELETE /api/me/identities/:provider
//
// Safety: the `state` sent to the provider is random, single use, stored hashed for ten minutes and tied to this
// browser by a cookie; PKCE where the provider supports it. An outside account is never attached to an existing
// OurSpace account just because the email matches (anyone can type any email at sign-up): the person is asked to log
// in with their password and connect it from Settings instead.
import { fail, json, readBody, getCookie, sha256Hex } from '../shared/http.js';
import { randomToken } from '../shared/seal.js';
import { limit } from '../shared/db.js';
import { createUser, startSession, ageGate, userOut, ipKey, nameAndEmailFree } from './auth.js';
import { screenSignup, recordSignup } from '../trust/signup.js';
import { connectSpotify, spotifyReady, getSpotify } from '../music/spotify.js';
import { sunSign } from '../shared/astro.js';

const PROVIDERS = {
  google: {
    label: 'Google', env: 'GOOGLE', pkce: true,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile', params: { prompt: 'select_account' },
    who: u => ({ id: u.sub, email: u.email, verified: u.email_verified === true || u.email_verified === 'true', name: u.given_name || u.name }),
  },
  discord: {
    label: 'Discord', env: 'DISCORD', pkce: true,
    authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me', scope: 'identify email',
    who: u => ({ id: u.id, email: u.email, verified: !!u.verified, name: u.global_name || u.username }),
  },
  spotify: {
    label: 'Spotify', env: 'SPOTIFY', pkce: true, connectOnly: true, basicAuth: true,
    authorize: 'https://accounts.spotify.com/authorize', token: 'https://accounts.spotify.com/api/token', scope: 'user-top-read',
  },
};
const SIGN_IN = Object.keys(PROVIDERS).filter(k => !PROVIDERS[k].connectOnly);

// endpoints, or the test suite's stand-in server when TEST_PROVIDER_BASE is set (never set it in production)
const url = (env, id, what) => (env.TEST_PROVIDER_BASE ? `${env.TEST_PROVIDER_BASE}/${id}/${what}` : PROVIDERS[id][what]);

function configured(env, id) {
  const p = PROVIDERS[id];
  if (!p || !env[`${p.env}_CLIENT_ID`]) return false;
  if (id === 'spotify') return spotifyReady(env);
  return !!env[`${p.env}_CLIENT_SECRET`];
}
export const signInProviders = env => SIGN_IN.filter(id => configured(env, id)).map(id => ({ id, label: PROVIDERS[id].label }));
const label = id => (PROVIDERS[id] ? PROVIDERS[id].label : id);

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const redirectUri = (c, id) => `${c.url.origin}/api/oauth/${id}/callback`;
const safeNext = n => (typeof n === 'string' && /^\/(?![/\\])[^\\]*$/.test(n) && n.length < 300 ? n : null);
const secure = c => (c.url.protocol === 'https:' ? '; Secure' : '');

// The state cookie must survive the trip to the provider and back: the return is a top-level GET, which Lax allows
const stateCookie = (c, value, maxAge) => `os_oauth=${value}; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(c)}`;

function go(location, cookies = []) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  cookies.filter(Boolean).forEach(ck => h.append('Set-Cookie', ck));
  return new Response(null, { status: 303, headers: h });
}

/* ------------------------------------------------------------ start */

// GET /api/oauth/:provider/start?mode=login|link|spotify&next=
export async function oauthStart(c) {
  const id = c.params.provider;
  const mode = c.url.searchParams.get('mode') || 'login';
  const back = mode === 'login' ? '/login' : '/settings';
  if (!PROVIDERS[id] || !configured(c.env, id)) return go(`${back}?error=unavailable&provider=${encodeURIComponent(id)}`);
  if ((id === 'spotify') !== (mode === 'spotify') || !['login', 'link', 'spotify'].includes(mode)) return go(`${back}?error=failed`);
  if (mode !== 'login' && !c.user) return go('/login?next=/settings');
  try { await limit(c, 'oauth:' + await ipKey(c), [[30, 600000]]); } catch { return go(`${back}?error=busy`); }

  const P = PROVIDERS[id];
  const state = randomToken();
  const verifier = P.pkce ? randomToken(48) : null;
  await c.env.DB.prepare('INSERT INTO oauth_states (state_hash, provider, mode, user_id, verifier, next, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(state), id, mode, c.user ? c.user.id : null, verifier, safeNext(c.url.searchParams.get('next')), c.now, c.now + 600000).run();
  const q = new URLSearchParams({
    client_id: c.env[`${P.env}_CLIENT_ID`], redirect_uri: redirectUri(c, id), response_type: 'code', scope: P.scope, state, ...(P.params || {}),
  });
  if (verifier) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    q.set('code_challenge', b64url(digest));
    q.set('code_challenge_method', 'S256');
  }
  return go(`${url(c.env, id, 'authorize')}?${q}`, [stateCookie(c, state, 600)]);
}

/* --------------------------------------------------------- callback */

async function exchange(c, id, code, verifier) {
  const P = PROVIDERS[id];
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(c, id) });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const clientId = c.env[`${P.env}_CLIENT_ID`];
  const secret = c.env[`${P.env}_CLIENT_SECRET`];
  if (P.basicAuth) headers.Authorization = 'Basic ' + btoa(`${clientId}:${secret}`);
  else { body.set('client_id', clientId); body.set('client_secret', secret); }
  if (verifier) body.set('code_verifier', verifier);
  const r = await fetch(url(c.env, id, 'token'), { method: 'POST', headers, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error || !data.access_token) throw new Error(`${id} token exchange: ${r.status} ${data.error || ''}`);
  return data;
}

async function identify(c, id, tokens) {
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'ourspace-social' };
  const r = await fetch(url(c.env, id, 'userinfo'), { headers });
  if (!r.ok) throw new Error(`${id} userinfo ${r.status}`);
  return PROVIDERS[id].who(await r.json());
}

// GET /api/oauth/:provider/callback
export async function oauthCallback(c) {
  const id = c.params.provider;
  const params = c.url.searchParams;
  const clear = stateCookie(c, '', 0);
  const state = params.get('state') || '';
  const cookie = getCookie(c.req, 'os_oauth') || '';
  const row = state ? await c.env.DB.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').bind(await sha256Hex(state)).first() : null;
  if (row) await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(await sha256Hex(state)).run();
  if (!row || row.expires < c.now || row.provider !== id || !PROVIDERS[id] || state !== cookie) return go('/login?error=expired', [clear]);
  const back = row.mode === 'login' ? '/login' : '/settings';
  const p = `&provider=${encodeURIComponent(id)}`;
  if (params.get('error')) return go(`${back}?error=cancelled${p}`, [clear]);
  const code = params.get('code');
  if (!code) return go(`${back}?error=failed${p}`, [clear]);

  let tokens;
  try { tokens = await exchange(c, id, code, row.verifier); } catch (e) { console.error(e.message); return go(`${back}?error=failed${p}`, [clear]); }

  if (row.mode === 'spotify') {
    const res = await connectSpotify(c, row.user_id, tokens).catch(e => { console.error(e && e.message); return { error: 'failed' }; });
    return go(res.ok ? '/settings?spotify=connected' : `/settings?spotify=${res.error}`, [clear]);
  }

  let who;
  try { who = await identify(c, id, tokens); } catch (e) { console.error(e.message); return go(`${back}?error=failed${p}`, [clear]); }
  if (!who || !who.id) return go(`${back}?error=failed${p}`, [clear]);
  const email = who.verified && who.email ? String(who.email).trim().toLowerCase() : null;
  const linked = await c.env.DB.prepare('SELECT i.user_id, u.banned FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?')
    .bind(id, String(who.id)).first();

  if (row.mode === 'link') {
    const owner = await c.env.DB.prepare('SELECT banned FROM users WHERE id = ?').bind(row.user_id).first();
    if (!owner || owner.banned) return go('/login?error=expired', [clear]);
    if (linked && linked.user_id !== row.user_id) return go(`/settings?error=identity_taken${p}`, [clear]);
    if (!linked) {
      await c.env.DB.prepare('INSERT INTO identities (provider, subject, user_id, email, created) VALUES (?, ?, ?, ?, ?)')
        .bind(id, String(who.id), row.user_id, who.email ? String(who.email).slice(0, 254) : null, c.now).run();
    }
    return go(`/settings?linked=${encodeURIComponent(id)}`, [clear]);
  }

  // logging in
  if (linked) {
    if (linked.banned) return go('/login?error=suspended', [clear]);
    await c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(c.now, linked.user_id).run();
    return go(row.next || '/', [clear, await startSession(c, linked.user_id)]);
  }
  if (email && await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) {
    return go(`/login?error=email_in_use${p}`, [clear]);
  }
  // somebody new: hold on to who they are for half an hour while they pick a screen name and give their birthday
  const ticket = randomToken();
  await c.env.DB.prepare('INSERT INTO oauth_signups (ticket_hash, provider, subject, email, name_hint, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(ticket), id, String(who.id), email, who.name ? String(who.name).slice(0, 40) : null, c.now, c.now + 1800000).run();
  return go('/join/finish', [clear, `os_signup=${ticket}; Path=/api/signup; HttpOnly; SameSite=Lax; Max-Age=1800${secure(c)}`]);
}

/* ---------------------------------------------- finishing a sign-up */

async function pending(c) {
  const ticket = getCookie(c.req, 'os_signup');
  if (!ticket) return null;
  const row = await c.env.DB.prepare('SELECT * FROM oauth_signups WHERE ticket_hash = ?').bind(await sha256Hex(ticket)).first();
  return row && row.expires > c.now ? row : null;
}

// GET /api/signup/pending — who is half-way through signing up with a provider
export async function signupPending(c) {
  const row = await pending(c);
  if (!row) fail(404, 'that sign-in has expired. start again.');
  // a suggestion for the screen name box: their first name, if it would be a valid screen name
  const hint = row.name_hint ? row.name_hint.replace(/[^A-Za-z0-9_~*.-]/g, '').slice(0, 20) : '';
  return json({ provider: row.provider, label: label(row.provider), email: row.email, nameHint: hint.length >= 3 ? hint : '' });
}

// POST /api/signup/finish { name, birthday, avatar, rulesOk, form, pow, turnstile, <honeypot>: '' } — the same human
// checks as an email sign-up (form from GET /api/form/finish); the provider's verified email skips our mail check and
// link (the account starts verified) but not the throwaway list. Without one the account is held. → 201 { user, held }
export async function signupFinish(c) {
  const row = await pending(c);
  if (!row) fail(404, 'that sign-in has expired. start again.');
  const b = await readBody(c.req);
  if (b.rulesOk !== true) fail(400, 'please read and agree to the house rules.');
  const birthdate = ageGate(c, b.birthday);
  const already = await c.env.DB.prepare('SELECT 1 AS x FROM identities WHERE provider = ? AND subject = ?').bind(row.provider, row.subject).first();
  if (already) fail(409, `that ${label(row.provider)} account already has a page. log in instead.`);
  const name = String(b.name ?? '').trim();
  await nameAndEmailFree(c, name, row.email);
  // row.email is only ever an address the provider says it verified (see the callback). It passes the throwaway list
  // and counts toward the email-domain signals like any sign-up's. No verified address (a Discord account without
  // one): the sign-up goes ahead, but held for a moderator
  // (no_verified_email), and the moderator's approval stands in for the confirmation link (trust/moderation.js).
  const screened = await screenSignup(c, b, { purpose: 'finish', email: row.email, vouched: true });
  const screen = row.email ? screened : { ...screened, hold: true, reasons: [...screened.reasons, 'no_verified_email'] };
  const user = await createUser(c, { name, email: row.email, passHash: null, birthdate, avatar: b.avatar, verified: !!row.email, held: screen.hold ? screen.reasons : null });
  await c.env.DB.batch([
    ...recordSignup(c.env, user.id, screen, c.now),
    c.env.DB.prepare('INSERT INTO identities (provider, subject, user_id, email, created) VALUES (?, ?, ?, ?, ?)').bind(row.provider, row.subject, user.id, row.email, c.now),
    c.env.DB.prepare('DELETE FROM oauth_signups WHERE ticket_hash = ?').bind(row.ticket_hash),
  ]);
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  h.append('Set-Cookie', await startSession(c, user.id));
  h.append('Set-Cookie', `os_signup=; Path=/api/signup; HttpOnly; SameSite=Lax; Max-Age=0${secure(c)}`);
  return new Response(JSON.stringify({ user: userOut(user), held: screen.hold }), { status: 201, headers: h });
}

/* ------------------------------------------------ account settings */

// GET /api/auth/providers — what the Join / Log in pages can offer
export async function providers(c) {
  return json({ signIn: signInProviders(c.env), spotify: configured(c.env, 'spotify') }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// GET /api/me/account — everything the Settings page shows about how you sign in
export async function account(c) {
  const { results } = await c.env.DB.prepare('SELECT provider, email, created FROM identities WHERE user_id = ? ORDER BY created').bind(c.user.id).all();
  const s = sunSign(c.user.birthdate);
  const sp = await (await getSpotify(c)).json();
  return json({
    email: c.user.email, hasPassword: !!c.user.pass_hash, birthday: c.user.birthdate,
    sign: { key: s.key, name: s.name, glyph: s.glyph, cusp: s.cusp },
    identities: results.map(r => ({ provider: r.provider, label: label(r.provider), email: r.email, created: r.created })),
    available: signInProviders(c.env),
    spotify: sp,
  });
}

// DELETE /api/me/identities/:provider — only while there's still another way to log in
export async function unlink(c) {
  const id = c.params.provider;
  const { results } = await c.env.DB.prepare('SELECT provider FROM identities WHERE user_id = ?').bind(c.user.id).all();
  if (!results.some(r => r.provider === id)) fail(404, 'that isn\'t connected.');
  if (!c.user.pass_hash && results.length < 2) fail(400, `set a password first, or you'd have no way to log in without ${label(id)}.`);
  await c.env.DB.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').bind(c.user.id, id).run();
  return json({ ok: true });
}
