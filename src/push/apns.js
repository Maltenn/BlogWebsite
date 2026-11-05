// Apple Push Notification service, over its HTTP/2 API: POST /3/device/<token> with a provider token (an ES256 JWT
// made from the .p8 key, good for an hour; Apple wants it reused, not minted per push).
// Secrets: APNS_KEY_P8 (the key file's text), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (the app's bundle id). APNS_SANDBOX=1
// (a plain variable) sends to Apple's development server, for builds run from Xcode. TEST_PUSH_BASE (tests only)
// points everything at the stand-in server.
import { signJwt } from './jwt.js';

export const apnsReady = env => !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);

const REUSE_MS = 40 * 60000;                   // Apple: no new token more often than every 20 minutes, none older than 60
let cached = null;                             // { id, jwt, at }

async function providerToken(env, now) {
  const id = `${env.APNS_TEAM_ID}/${env.APNS_KEY_ID}`;
  if (cached && cached.id === id && now - cached.at < REUSE_MS) return cached.jwt;
  const jwt = await signJwt('ES256', env.APNS_KEY_P8, { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  cached = { id, jwt, at: now };
  return jwt;
}

const host = env => (env.TEST_PUSH_BASE ? `${env.TEST_PUSH_BASE}/apns` : env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');

// Sends one alert. → 'ok', 'gone' (the token is dead: forget it), 'retry' (try again later) or 'drop' (this message can
// never be sent; say why in the log and move on)
export async function sendApns(env, token, { title, body, url, kind }, now = Date.now()) {
  let res;
  try {
    res = await fetch(`${host(env)}/3/device/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${await providerToken(env, now)}`,
        'apns-topic': env.APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(now / 1000) + 86400),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, url, kind }),
    });
  } catch (e) {
    console.error('push: APNs unreachable:', (e && e.message) || e);
    return 'retry';
  }
  if (res.ok) return 'ok';
  const reason = (await res.json().catch(() => ({}))).reason || '';
  if (res.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') return 'gone';
  if (res.status === 403) cached = null;       // ExpiredProviderToken / InvalidProviderToken: mint a new one next time
  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    console.error('push: APNs', res.status, reason);
    return 'retry';
  }
  console.error('push: APNs refused a message:', res.status, reason);
  return 'drop';
}
