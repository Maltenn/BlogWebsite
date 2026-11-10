// Cloudflare Turnstile, checked on our side (docs/decisions/003): the page's widget gives a token, we post it with our
// secret to siteverify and check `success`, the `action` (signup | login | reset) and the `hostname` ourselves (the API
// doesn't). A token works once and for 300 s. TURNSTILE_SITE_KEY (public, shown to the page) and TURNSTILE_SECRET_KEY
// (a secret) switch it on; Cloudflare's published test keys (1x… always passes, 2x… always fails, 3x… "already spent")
// are what the tests and the demo use, against a stand-in for siteverify (TURNSTILE_VERIFY_URL), so they never reach
// the internet. Their answers carry no real action or hostname, so those two checks are skipped for test secrets.
// Sign-up and password reset fail closed when Cloudflare can't be reached ("try again"); logging in fails open and
// falls back to the per-account and per-network limits.
import { fail } from '../shared/http.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TEST_SECRETS = /^[123]x0{30,}AA$/;

export const turnstileReady = env => !!(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
export const isTestSecret = secret => TEST_SECRETS.test(String(secret || ''));
const isLocal = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

// The verdict on a siteverify answer (pure): { ok, reason }. `hostnames`: where our pages live.
export function judgeSiteverify(data, { action, hostnames, testKey }) {
  if (!data || data.success !== true) return { ok: false, reason: ((data && data['error-codes']) || ['failed']).join(',') || 'failed' };
  if (testKey) return { ok: true, reason: 'test-key' };
  if (action && data.action !== action) return { ok: false, reason: 'action' };
  if (hostnames && hostnames.length && !hostnames.includes(String(data.hostname || '').toLowerCase())) return { ok: false, reason: 'hostname' };
  return { ok: true, reason: 'ok' };
}

// Checks the token in a request body. failOpen: when Cloudflare can't be reached (or Turnstile isn't set up), let the
// request through (log in); otherwise refuse with "try again". Answers { ok, skipped } or throws a 4xx/5xx with
// { code: 'turnstile' } (failed or missing) or { code: 'turnstile_unavailable' }.
export async function checkTurnstile(c, token, action, { failOpen = false } = {}) {
  const env = c.env;
  if (!turnstileReady(env)) {
    if (failOpen || isLocal(c.url)) return { ok: true, skipped: true };
    fail(503, 'sign-ups aren\'t open on this server yet (the human check isn\'t set up). ask a moderator.', { code: 'turnstile_unavailable' });
  }
  if (typeof token !== 'string' || !token || token.length > 2048) {
    fail(400, 'please finish the "verify you are human" check first.', { code: 'turnstile' });
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = c.req.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  let data;
  try {
    const r = await fetch(env.TURNSTILE_VERIFY_URL || SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('siteverify ' + r.status);
    data = await r.json();
  } catch (e) {
    console.error('turnstile unreachable:', e && e.message);
    if (failOpen) return { ok: true, skipped: true };
    fail(503, 'we couldn\'t run the human check just now. try again in a minute.', { code: 'turnstile_unavailable' });
  }
  const hostnames = String(env.TURNSTILE_HOSTNAMES || c.url.hostname).split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const verdict = judgeSiteverify(data, { action, hostnames, testKey: isTestSecret(env.TURNSTILE_SECRET_KEY) });
  if (!verdict.ok) fail(403, 'the "verify you are human" check didn\'t go through. try it again.', { code: 'turnstile', reason: verdict.reason });
  return { ok: true, skipped: false };
}
