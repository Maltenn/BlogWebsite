// Encrypting secrets we have to keep (Spotify refresh tokens) with AES-256-GCM. The key is the TOKEN_KEY secret:
// 32 random bytes, base64 or hex (`openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY`).
import { fail } from './http.js';

const cache = new Map();

async function key(env) {
  const raw = String(env.TOKEN_KEY || '').trim();
  if (!raw) fail(503, 'this server isn\'t set up to store connections yet (TOKEN_KEY is missing).');
  if (cache.has(raw)) return cache.get(raw);
  let bytes;
  if (/^[0-9a-f]{64}$/i.test(raw)) bytes = Uint8Array.from(raw.match(/../g), h => parseInt(h, 16));
  else bytes = Uint8Array.from(atob(raw), ch => ch.charCodeAt(0));
  if (bytes.length !== 32) fail(503, 'TOKEN_KEY must be 32 bytes (base64 or hex).');
  const k = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cache.set(raw, k);
  return k;
}

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function unseal(env, blob) {
  const all = unb64(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await key(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

// 32 random bytes, URL-safe
export function randomToken(bytes = 32) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, ch => ({ '+': '-', '/': '_', '=': '' })[ch]);
}
