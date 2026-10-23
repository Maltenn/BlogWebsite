// Everybody's own Spotify: connect your account (oauth.js runs the sign-in with the user-top-read scope) and your page
// shows your top songs. Refresh tokens are stored encrypted (seal.js). Top tracks are cached and refreshed in the
// background when a page is viewed and the copy is more than six hours old.
//
// Spotify's rule for apps in Development Mode (every app that isn't a large registered business): only the people
// the app owner adds by hand in the Spotify developer dashboard (five at most, since 2026) can connect. Everyone else
// gets a 403 from Spotify; we tell them so plainly and store nothing.
import { json, readBody, fail } from './http.js';
import { seal, unseal } from './seal.js';
import { limit } from './db.js';

export const RANGES = { short_term: 'the last 4 weeks', medium_term: 'the last 6 months', long_term: 'all time' };
const STALE = 6 * 3600000;
const base = env => env.TEST_PROVIDER_BASE ? `${env.TEST_PROVIDER_BASE}/spotify` : null;
const apiUrl = env => (base(env) ? base(env) + '/v1' : 'https://api.spotify.com/v1');
const tokenUrl = env => (base(env) ? base(env) + '/token' : 'https://accounts.spotify.com/api/token');
const itunesUrl = env => (env.TEST_PROVIDER_BASE ? `${env.TEST_PROVIDER_BASE}/itunes/search` : 'https://itunes.apple.com/search');

export const spotifyReady = env => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.TOKEN_KEY);

class SpotifyError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

const basic = env => 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

// oauth.js calls this once Spotify sends tokens back for `userId`. → { ok } | { error }
export async function connectSpotify(c, userId, tokens) {
  const me = await fetch(apiUrl(c.env) + '/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (me.status === 403) return { error: 'not_allowlisted' };
  if (!me.ok || !tokens.refresh_token) return { error: 'failed' };
  const profile = await me.json();
  const access = await seal(c.env, tokens.access_token);
  const refresh = await seal(c.env, tokens.refresh_token);
  await c.env.DB.prepare(`INSERT INTO spotify (user_id, spotify_id, display_name, refresh_enc, access_enc, access_expires, created)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET spotify_id = excluded.spotify_id, display_name = excluded.display_name,
      refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, access_expires = excluded.access_expires,
      tracks = NULL, fetched = NULL, error = NULL`)
    .bind(userId, String(profile.id || ''), String(profile.display_name || profile.id || '').slice(0, 60), refresh, access,
      c.now + (Number(tokens.expires_in) || 3600) * 1000, c.now).run();
  await refreshTracks(c.env, userId, c.now);
  return { ok: true };
}

// a working access token for this connection (refreshing it, and storing a rotated refresh token, when needed)
async function accessToken(env, row, now, force = false) {
  if (!force && row.access_enc && row.access_expires > now + 60000) return unseal(env, row.access_enc);
  const r = await fetch(tokenUrl(env), {
    method: 'POST',
    headers: { Authorization: basic(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await unseal(env, row.refresh_enc) }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 400 && data.error === 'invalid_grant') throw new SpotifyError('revoked');
  if (!r.ok || !data.access_token) throw new SpotifyError('failed', `token refresh ${r.status}`);
  const stmts = [env.DB.prepare('UPDATE spotify SET access_enc = ?, access_expires = ? WHERE user_id = ?')
    .bind(await seal(env, data.access_token), now + (Number(data.expires_in) || 3600) * 1000, row.user_id)];
  if (data.refresh_token) stmts.push(env.DB.prepare('UPDATE spotify SET refresh_enc = ? WHERE user_id = ?').bind(await seal(env, data.refresh_token), row.user_id));
  await env.DB.batch(stmts);
  return data.access_token;
}

// Spotify deprecated preview clips; Apple's iTunes Search still has 30-second previews for most songs
async function itunesPreview(env, name, artist) {
  try {
    const q = new URLSearchParams({ term: `${name} ${artist}`, media: 'music', entity: 'song', limit: '1' });
    const r = await fetch(`${itunesUrl(env)}?${q}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const data = await r.json();
    const url = data.results && data.results[0] && data.results[0].previewUrl;
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  } catch { return null; }
}

// fetch and store someone's top tracks. Never throws: a problem is written to the row's `error`.
export async function refreshTracks(env, userId, now = Date.now()) {
  const row = await env.DB.prepare('SELECT * FROM spotify WHERE user_id = ?').bind(userId).first();
  if (!row) return;
  try {
    let token = await accessToken(env, row, now);
    const get = t => fetch(`${apiUrl(env)}/me/top/tracks?limit=10&time_range=${row.time_range}`, { headers: { Authorization: `Bearer ${t}` } });
    let r = await get(token);
    if (r.status === 401) { token = await accessToken(env, row, now, true); r = await get(token); }
    if (r.status === 403) throw new SpotifyError('not_allowlisted');
    if (r.status === 429) throw new SpotifyError('busy');
    if (!r.ok) throw new SpotifyError('failed', `top tracks ${r.status}`);
    const data = await r.json();
    const tracks = (data.items || []).slice(0, 10).map(t => {
      const imgs = (t.album && t.album.images) || [];             // largest first
      const img = imgs.find(i => i.width && i.width <= 300) || imgs[imgs.length - 1];
      const url = t.external_urls && t.external_urls.spotify;
      return {
        name: String(t.name || '').slice(0, 120),
        artist: (t.artists || []).map(a => a.name).join(', ').slice(0, 120),
        album: t.album ? String(t.album.name || '').slice(0, 120) : '',
        image: img && /^https:\/\//.test(img.url) ? img.url : null,
        url: typeof url === 'string' && url.startsWith('https://open.spotify.com/') ? url : null,
        preview: typeof t.preview_url === 'string' && t.preview_url.startsWith('https://') ? t.preview_url : null,
      };
    });
    await Promise.all(tracks.map(async t => { if (!t.preview) t.preview = await itunesPreview(env, t.name, t.artist.split(', ')[0]); }));
    await env.DB.prepare('UPDATE spotify SET tracks = ?, fetched = ?, error = NULL WHERE user_id = ?').bind(JSON.stringify(tracks), now, userId).run();
  } catch (e) {
    const code = e instanceof SpotifyError ? e.code : 'failed';
    if (!(e instanceof SpotifyError)) console.error('spotify refresh failed:', e && e.message);
    await env.DB.prepare('UPDATE spotify SET fetched = ?, error = ? WHERE user_id = ?').bind(now, code, userId).run();
  }
}

// for a profile page: the cached top tracks (refreshed in the background when stale), or null
export async function profileSpotify(c, userId) {
  const row = await c.env.DB.prepare('SELECT time_range, show, tracks, fetched FROM spotify WHERE user_id = ?').bind(userId).first();
  if (!row || !row.show) return null;
  if (spotifyReady(c.env) && (!row.fetched || row.fetched < c.now - STALE)) {
    // claim the refresh, so ten people opening the same page start one refresh, not ten
    const claim = await c.env.DB.prepare('UPDATE spotify SET fetched = ? WHERE user_id = ? AND (fetched IS NULL OR fetched < ?)')
      .bind(c.now, userId, c.now - STALE).run();
    if (claim.meta.changes) c.ctx.waitUntil(refreshTracks(c.env, userId, c.now));
  }
  let tracks = [];
  try { tracks = JSON.parse(row.tracks || '[]'); } catch { /* keep [] */ }
  return tracks.length ? { tracks, range: RANGES[row.time_range] || RANGES.short_term } : null;
}

async function status(c) {
  const row = await c.env.DB.prepare('SELECT display_name, time_range, show, tracks, fetched, error FROM spotify WHERE user_id = ?').bind(c.user.id).first();
  let tracks = [];
  if (row) { try { tracks = JSON.parse(row.tracks || '[]'); } catch { /* keep [] */ } }
  return {
    ready: spotifyReady(c.env),
    connected: !!row,
    displayName: row ? row.display_name : null,
    timeRange: row ? row.time_range : 'short_term',
    show: row ? !!row.show : true,
    fetched: row ? row.fetched : null,
    error: row ? row.error : null,
    tracks,
  };
}

// GET /api/me/spotify
export async function getSpotify(c) {
  return json(await status(c));
}

// PUT /api/me/spotify { timeRange, show }
export async function putSpotify(c) {
  const b = await readBody(c.req);
  const row = await c.env.DB.prepare('SELECT time_range FROM spotify WHERE user_id = ?').bind(c.user.id).first();
  if (!row) fail(404, 'connect Spotify first.');
  const range = b.timeRange ?? row.time_range;
  if (!RANGES[range]) fail(400, 'pick 4 weeks, 6 months or all time.');
  await c.env.DB.prepare('UPDATE spotify SET time_range = ?, show = ? WHERE user_id = ?').bind(range, b.show === false ? 0 : 1, c.user.id).run();
  if (range !== row.time_range) await refreshTracks(c.env, c.user.id, c.now);
  return json(await status(c));
}

// POST /api/me/spotify/refresh
export async function refreshSpotify(c) {
  await limit(c, 'spotify:' + c.user.id, [[6, 3600000]], 'you just refreshed. give Spotify a minute.');
  await refreshTracks(c.env, c.user.id, c.now);
  return json(await status(c));
}

// DELETE /api/me/spotify — forget the connection and the tokens
export async function deleteSpotify(c) {
  await c.env.DB.prepare('DELETE FROM spotify WHERE user_id = ?').bind(c.user.id).run();
  return json(await status(c));
}
