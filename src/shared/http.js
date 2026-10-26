// Small HTTP helpers shared by every route.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// throw an error the router turns into { error } with this status
export function fail(status, message) {
  throw new HttpError(status, message);
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

// The request body as an object. Only JSON is accepted: a cross-site form can't send it without a CORS preflight,
// which this API never answers, so this doubles as CSRF protection alongside the SameSite cookie and the origin check.
export async function readBody(req, max = 20000) {
  const type = (req.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) fail(415, 'send JSON');
  const raw = await req.text();
  if (raw.length > max) fail(413, 'that is too long');
  let v;
  try { v = JSON.parse(raw || '{}'); } catch { fail(400, 'bad JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'bad JSON');
  return v;
}

export function getCookie(req, name) {
  const header = req.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(url, token, maxAgeSec) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `os_sid=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The network an address belongs to, for rate limits: IPv4 as is; IPv6 by its /64, because one home or phone line
// is handed a whole /64 and could otherwise rotate through 2^64 addresses to dodge every per-IP limit.
export function ipGroup(ip) {
  ip = String(ip || '').trim().toLowerCase().split('%')[0];
  if (!ip.includes(':')) return ip || '0.0.0.0';
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);   // IPv4-mapped (::ffff:1.2.3.4) is really IPv4
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// the request's network (ipGroup), salted and hashed: the key per-IP rate limits count under
export async function ipKey(c) {
  const ip = ipGroup(c.req.headers.get('CF-Connecting-IP'));
  return (await sha256Hex(`${c.env.IP_SALT || 'ourspace-social'}|${ip}`)).slice(0, 32);
}

export function int(v, def = null) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
