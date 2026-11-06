// The build-time settings, in one place. Used by capacitor.config.js, scripts/after-copy.mjs and scripts/check.mjs.
// Precedence: environment variable, then ourspace.config.json.
const fs = require('node:fs');
const path = require('node:path');

const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ourspace.config.json'), 'utf8'));

function clean(origin) {
  const u = new URL(origin);                       // throws on garbage: better at build time than in a user's hand
  if (!/^https?:$/.test(u.protocol)) throw new Error(`OURSPACE_ORIGIN must be http(s)://host[:port], got ${origin}`);
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`OURSPACE_ORIGIN must be an origin only (no path), got ${origin}`);
  return u.origin;
}

const origin = clean(process.env.OURSPACE_ORIGIN || file.origin);
module.exports = {
  origin,
  secure: origin.startsWith('https:'),
  appId: process.env.OURSPACE_APP_ID || file.appId,
  appName: process.env.OURSPACE_APP_NAME || file.appName,
  // the app's own origins, as the contract lists them (docs/mobile/contract.md): what the Worker's CORS answers
  ios: 'capacitor://localhost',
  android: 'https://localhost',
};

// The Content-Security-Policy the app enforces on its own bundled pages. The site's CSP (public/_headers) is an HTTP
// header on the Worker's responses; the app's pages come from the device, with no headers at all, so the policy goes in
// as a <meta> tag in the copy of index.html that scripts/after-copy.mjs puts into each platform. It is the site's policy
// with three differences, and only these: the app's own origins are named (WebKit does not always match 'self' for
// capacitor://), the API origin is allowed for connect-src (fetch, XHR, WebSocket) and for img-src/media-src (members'
// photos live at <origin>/media/…), and `wss:` / `ws://localhost:*` are narrowed to that one origin.
module.exports.csp = function csp() {
  const self = "'self' capacitor://localhost https://localhost";
  const api = module.exports.origin;
  const ws = api.replace(/^http/, 'ws');
  return [
    `default-src ${self}`,
    `img-src ${self} data: blob: ${api} https://i.scdn.co https://*.spotifycdn.com`,
    `media-src ${self} ${api} https://*.itunes.apple.com https://*.apple.com https://*.mzstatic.com`,
    `style-src ${self}`,
    `script-src ${self} https://challenges.cloudflare.com`,
    `connect-src ${self} ${api} ${ws}`,
    `font-src ${self}`,
    'frame-src https://challenges.cloudflare.com',
    `base-uri ${self}`,
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
};
