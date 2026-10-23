// ourspace-api — one Cloudflare Worker standing in for the two old localhost backends:
//   GET  /messages            the guestbook, newest first (max 50)         (was msgserver/, port 3001)
//   POST /messages            { screenName, message } → { id }
//   GET  /top-tracks?limit=N  malten's Spotify top tracks, same shape as    (was spotifyserver/, port 8080)
//                             spotifyserver returned, served from a 10-minute cache that a cron keeps warm
// Storage is a D1 database (binding DB, see schema.sql). Secrets come from `wrangler secret put`.

const MAX_NAME = 20;
const MAX_MESSAGE = 200;
const LIST_LIMIT = 50;
const POSTS_PER_MINUTE = 3;                  // per IP
const TRACKS_TTL = 10 * 60 * 1000;           // how long a top-tracks answer counts as fresh
const DEFAULT_LIMIT = 5;

// the same word filter the page applies client-side (Guestbook.filter in apps.js) — kept in step by hand
const BLOCKED = ['nigger', 'nigga', 'retard', 'retarded', 'chink', 'nazi', 'hitler', 'swastika',
  'fag', 'faggot', 'fucktard', 'rape', 'incest', 'aids', 'legend', 'birthday'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin') || '', env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /') res = text('ourspace-api is running');
      else if (route === 'GET /messages') res = await listMessages(env);
      else if (route === 'POST /messages') res = await postMessage(request, env);
      else if (route === 'GET /top-tracks') res = await topTracks(url, env, ctx);
      else res = json({ error: 'not found' }, 404);
    } catch (e) {
      console.error((e && e.stack) || e);
      res = json({ error: 'server error' }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  // cron (wrangler.jsonc → triggers.crons): refresh the list the page asks for, so /top-tracks is always a cache hit
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshTracks(env, 10).catch(e => console.error('cron refresh failed:', e && e.message)));
  },
};

/* ------------------------------------------------------------------ helpers */

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// tiny key/value store on top of D1 (token + track cache)
async function kvGet(env, k, { allowStale = false } = {}) {
  const row = await env.DB.prepare('SELECT v, expires FROM kv WHERE k = ?').bind(k).first();
  if (!row) return null;
  const stale = row.expires != null && row.expires < Date.now();
  if (stale && !allowStale) return null;
  return { value: row.v, stale };
}

async function kvSet(env, k, v, ttlMs) {
  const expires = ttlMs ? Date.now() + ttlMs : null;
  await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v, expires) VALUES (?, ?, ?)').bind(k, v, expires).run();
}

/* ---------------------------------------------------------------- guestbook */

// one line of plain text: no control characters, single spaces, trimmed, capped
function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')   // control characters + line/paragraph separators
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// same treatment the page gives a message before showing it (links out, blocked words starred)
function filter(message) {
  message = message.replace(/https?:\/\/\S+/gi, '[link removed]');
  for (const w of BLOCKED) message = message.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  return message;
}

async function listMessages(env) {
  const { results } = await env.DB.prepare(
    'SELECT created AS id, screen_name AS screenName, message, timestamp FROM messages WHERE hidden = 0 ORDER BY created DESC LIMIT ?'
  ).bind(LIST_LIMIT).all();
  return json(results, 200, { 'Cache-Control': 'no-store' });
}

async function postMessage(request, env) {
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too long' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const screenName = clean(body && body.screenName, MAX_NAME);
  const message = filter(clean(body && body.message, MAX_MESSAGE));
  if (!screenName || !message) return json({ error: 'screenName and message are required' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ipHash = (await sha256Hex(`${env.IP_SALT || 'ourspace'}|${ip}`)).slice(0, 32);
  const now = Date.now();

  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created > ?')
    .bind(ipHash, now - 60 * 1000).first();
  if (recent && recent.n >= POSTS_PER_MINUTE) return json({ error: 'slow down - a few per minute is plenty' }, 429);

  await env.DB.prepare(
    'INSERT INTO messages (created, screen_name, message, timestamp, ip_hash) VALUES (?, ?, ?, ?, ?)'
  ).bind(now, screenName, message, new Date(now).toISOString(), ipHash).run();
  return json({ id: now });
}

/* ------------------------------------------------------------- spotify */

async function topTracks(url, env, ctx) {
  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));
  const cached = await kvGet(env, `tracks:${limit}`, { allowStale: true });
  if (cached) {
    // stale: answer now with what we have, refresh after the response has gone out
    if (cached.stale) ctx.waitUntil(refreshTracks(env, limit).catch(e => console.error('refresh failed:', e && e.message)));
    return new Response(cached.value, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Cache': cached.stale ? 'stale' : 'hit',
      },
    });
  }
  try {
    const tracks = await refreshTracks(env, limit);
    return json(tracks, 200, { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'miss' });
  } catch (e) {
    console.error('top-tracks failed:', e && e.message);
    const status = /not configured/.test(String(e && e.message)) ? 503 : 502;
    return json({ error: 'Failed to fetch top tracks' }, status);
  }
}

// ask Spotify, add iTunes previews where Spotify has none, store the answer, return it
async function refreshTracks(env, limit) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) throw new Error('spotify not configured (client id/secret)');
  let token = await accessToken(env);
  let r = await spotifyTop(token, limit);
  if (r.status === 401) {                       // token died early: refresh once and retry
    token = await accessToken(env, { force: true });
    r = await spotifyTop(token, limit);
  }
  if (!r.ok) throw new Error(`spotify /me/top/tracks ${r.status}`);
  const data = await r.json();
  const tracks = (data.items || []).map(t => {
    const images = (t.album && t.album.images) || [];       // largest first
    return {
      name: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      album: t.album ? t.album.name : '',
      preview_url: t.preview_url || null,
      image_url: images.length ? images[0].url : null,
      image_small: images.length ? images[images.length - 1].url : null,
      url: (t.external_urls && t.external_urls.spotify) || null,
    };
  });
  // Spotify deprecated preview_url (null for most tracks since late 2024); iTunes still serves 30s previews
  await Promise.all(tracks.map(async t => {
    if (t.preview_url) return;
    t.preview_url = await itunesPreview(t.name, t.artist.split(', ')[0]);
  }));
  // `expires` only marks the fresh window: the row stays and is served stale while Spotify is down (topTracks)
  await kvSet(env, `tracks:${limit}`, JSON.stringify(tracks), TRACKS_TTL);
  return tracks;
}

function spotifyTop(token, limit) {
  const q = new URLSearchParams({ limit: String(limit), time_range: 'short_term' });
  return fetch(`https://api.spotify.com/v1/me/top/tracks?${q}`, { headers: { Authorization: `Bearer ${token}` } });
}

// a usable access token: the cached one, else a fresh one from the refresh token
async function accessToken(env, { force = false } = {}) {
  if (!force) {
    const c = await kvGet(env, 'spotify:access');
    if (c) return c.value;
  }
  // Spotify occasionally hands out a new refresh token; a rotated one lives in D1 and beats the secret
  const rotated = await kvGet(env, 'spotify:refresh');
  const refresh = (rotated && rotated.value) || env.SPOTIFY_REFRESH_TOKEN;
  if (!refresh) throw new Error('spotify not configured (refresh token)');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!r.ok) throw new Error(`spotify token refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const ttl = Math.max(60, (data.expires_in || 3600) - 60) * 1000;
  await kvSet(env, 'spotify:access', data.access_token, ttl);
  if (data.refresh_token && data.refresh_token !== refresh) await kvSet(env, 'spotify:refresh', data.refresh_token, null);
  return data.access_token;
}

async function itunesPreview(name, artist) {
  try {
    const q = new URLSearchParams({ term: `${name} ${artist}`, media: 'music', entity: 'song', limit: '1' });
    const r = await fetch(`https://itunes.apple.com/search?${q}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    return (data.results && data.results[0] && data.results[0].previewUrl) || null;
  } catch (e) {
    console.error('iTunes preview lookup failed:', e && e.message);
    return null;
  }
}
