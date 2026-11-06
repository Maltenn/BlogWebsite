// Firebase Cloud Messaging, HTTP v1: POST /v1/projects/<project>/messages:send with an OAuth access token that a
// service account's RS256 JWT is exchanged for (good for an hour, kept and reused).
// Secret: FCM_SERVICE_ACCOUNT_JSON (the service account's key file, as one JSON text). TEST_PUSH_BASE (tests only)
// points the send at the stand-in server; the token exchange goes to the file's own token_uri.
import { signJwt } from './jwt.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function account(env) {
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
    return a && a.client_email && a.private_key && a.project_id ? a : null;
  } catch { return null; }
}
export const fcmReady = env => !!account(env);

let cached = null;                             // { id, token, until }

async function accessToken(env, a, now) {
  if (cached && cached.id === a.client_email && cached.until > now + 60000) return cached.token;
  const uri = a.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt('RS256', a.private_key, a.private_key_id ? { kid: a.private_key_id } : {},
    { iss: a.client_email, scope: SCOPE, aud: uri, iat, exp: iat + 3600 });
  const res = await fetch(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`FCM token exchange: ${res.status} ${data.error || ''}`);
  cached = { id: a.client_email, token: data.access_token, until: now + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

const host = env => (env.TEST_PUSH_BASE ? `${env.TEST_PUSH_BASE}/fcm` : 'https://fcm.googleapis.com');

// Sends one alert. → 'ok', 'gone', 'retry' or 'drop', as sendApns does.
export async function sendFcm(env, token, { title, body, url, kind }, now = Date.now()) {
  const a = account(env);
  if (!a) return 'drop';
  let res;
  try {
    res = await fetch(`${host(env)}/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken(env, a, now)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: { url, kind },                   // (FCM data values are strings)
          android: { priority: 'HIGH' },
        },
      }),
    });
  } catch (e) {
    console.error('push: FCM unreachable:', (e && e.message) || e);
    return 'retry';
  }
  if (res.ok) return 'ok';
  const err = (await res.json().catch(() => ({}))).error || {};
  const code = (err.details || []).map(d => d.errorCode).find(Boolean) || err.status || '';
  if (res.status === 404 || code === 'UNREGISTERED') return 'gone';
  if (res.status === 401) cached = null;
  if (res.status === 401 || res.status === 429 || res.status >= 500) {
    console.error('push: FCM', res.status, code);
    return 'retry';
  }
  console.error('push: FCM refused a message:', res.status, code, err.message || '');
  return 'drop';
}
