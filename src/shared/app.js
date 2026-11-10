// The mobile apps' way in (docs/mobile/contract.md). The apps bundle the site's own pages and talk to the same API, from
// an origin of their own, so they sign in with a token instead of the cookie. This file is what the API knows about them:
// who is an app (the X-OurSpace-Client header), where a token may come from, and the three origins CORS ever answers.

// The only origins CORS answers: iOS (WKWebView), Android (WebView, http or https scheme).
export const APP_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost'];

// Every request from an app carries `X-OurSpace-Client: app/<ios|android>/<app version>`. → { platform, version } or null
const CLIENT = /^app\/(ios|android)\/([\w.+-]{1,32})$/;
export function appClient(req) {
  const m = CLIENT.exec(req.headers.get('X-OurSpace-Client') || '');
  return m ? { platform: m[1], version: m[2] } : null;
}

// A WebSocket handshake can't carry an Authorization header, so a client with no cookie offers its credential as a
// subprotocol instead. That credential is a short-lived, single-use, one-room TICKET (`ourspace.bearer.<ticket>`, minted
// by POST /api/live/ticket and claimed in src/shared/live.js) — never the session token. It used to be the token, and a
// handshake must select one of the subprotocols the client offered, so the browser published it on the live socket as
// `socket.protocol`, readable by any script in the page: the one thing the Keychain was chosen to prevent
// (docs/mobile/redteam.md R8, docs/mobile/contract.md §7).
export const BEARER_PROTOCOL = 'ourspace.bearer.';
// And the handshake no longer echoes the credential at all: the client offers this fixed name alongside it and the room
// selects this one, so `socket.protocol` holds nothing worth stealing even before the ticket is spent.
export const LIVE_PROTOCOL = 'ourspace.live';

const offered = req => (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(p => p.trim());

// The room ticket a WebSocket upgrade offers, or null. Only on an upgrade: nowhere else is a subprotocol a credential.
export function ticketProtocol(req) {
  if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return null;
  for (const v of offered(req)) if (v.startsWith(BEARER_PROTOCOL) && v.length > BEARER_PROTOCOL.length) return v.slice(BEARER_PROTOCOL.length);
  return null;
}

// What the room's 101 answers with (src/live/room.js): the fixed `ourspace.live`, when the client offered it. A client
// that offered only a ticket gets no subprotocol back — which the WebSocket spec allows ("none of yours") — because
// echoing the ticket is what R8 was about.
export const echoProtocol = req => (offered(req).includes(LIVE_PROTOCOL) ? LIVE_PROTOCOL : null);

// The session token a request offers instead of the cookie: `Authorization: Bearer <token>`. null when it offers none.
// (Whoever offers one is asking to be that session: the cookie is not tried.) A WebSocket subprotocol is NOT one of
// these any more — see above.
export function bearerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') || '');
  return m ? m[1] : null;
}

// does the request carry the session cookie? (checked without decoding it, so a mangled one can't throw)
export const hasSessionCookie = req => /(?:^|;\s*)os_sid=/.test(req.headers.get('Cookie') || '');

// A request whose credentials are not ambient: it names an app or carries a bearer token, and has no session cookie. A
// hostile page can't make a browser send either header (a custom header needs a CORS preflight, which only the three app
// origins ever get), so the cross-site check has nothing left to protect on it (src/index.js).
export const tokenRequest = req => !hasSessionCookie(req) && (!!appClient(req) || /^Bearer\s+\S+/i.test(req.headers.get('Authorization') || ''));

// The CORS headers for a request from one of the app origins, else null. Allow-Credentials is never sent: tokens only.
export function corsFor(req) {
  const origin = req.headers.get('Origin');
  return origin && APP_ORIGINS.includes(origin) ? origin : null;
}

export const PREFLIGHT = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  // X-OurSpace-Ticket: the half-finished provider sign-up the app carries instead of the os_signup cookie
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-OurSpace-Client, X-OurSpace-Ticket',
  'Access-Control-Max-Age': '600',
};

export function preflight(origin) {
  return new Response(null, { status: 204, headers: { ...PREFLIGHT, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } });
}

// `res` with the CORS headers of an app origin (a copy: a fetched response's headers can't be changed)
export function withCors(res, origin) {
  if (res.status === 101) return res;               // a WebSocket upgrade isn't read cross-origin
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.append('Vary', 'Origin');
  return out;
}
