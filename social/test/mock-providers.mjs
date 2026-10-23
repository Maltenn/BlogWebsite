// A stand-in for Google, Apple, Microsoft, Discord, GitHub, Spotify and iTunes Search, for the tests (the Worker talks
// to it when TEST_PROVIDER_BASE points here). It approves every sign-in at once. Who signs in is decided by the test:
// mock.next(provider, { sub, email, verified, name, notAllowlisted }) sets the identity the next authorize returns.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const b64url = s => Buffer.from(s).toString('base64url');
const unb64url = s => Buffer.from(s, 'base64url').toString();

// With { pretend: true } (the local demo), a sign-in with nothing queued shows a labeled "pretend <provider>" page
// where you type a name (or cancel) instead of being approved at once. The same name always means the same account.
export async function startMock(port = 0, { pretend = false } = {}) {
  const queue = {};                                     // provider → identities to hand out, in order
  const log = [];                                       // every token request, for assertions
  const fallback = p => ({ sub: `${p}-${Math.random().toString(36).slice(2, 8)}`, email: null, verified: false, name: 'Mock Person' });
  const typed = (p, q) => {
    const name = String(q.get('demo_name') || '').trim().slice(0, 40) || 'Demo Person';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'demo';
    return { sub: `${p}-${slug}`, email: `${slug}@example.com`, verified: true, name, notAllowlisted: q.get('demo_not_allowlisted') === 'on' };
  };

  const body = req => new Promise(res => { let s = ''; req.on('data', d => { s += d; }); req.on('end', () => res(s)); });
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  const who = req => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    try { return JSON.parse(unb64url(tok.replace(/^at\./, '').replace(/^rt\./, ''))); } catch { return null; }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, provider, what, ...rest] = url.pathname.split('/');

    if (what === 'authorize' || what === 'approve') {
      const q = url.searchParams;
      let id = queue[provider] && queue[provider].shift();
      if (!id && pretend && what === 'authorize') return pretendPage(res, provider, q);
      id = id || (what === 'approve' ? typed(provider, q) : fallback(provider));
      const code = b64url(JSON.stringify({ ...id, challenge: q.get('code_challenge') || null, client: q.get('client_id') }));
      if (q.get('response_mode') === 'form_post') {           // Apple: an auto-submitting form back to the site
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<form method="post" action="${q.get('redirect_uri')}"><input name="code" value="${code}"><input name="state" value="${q.get('state')}">` +
          `<input name="user" value='${JSON.stringify({ name: { firstName: id.name || 'Apple' } })}'></form><script>document.forms[0].submit()</script>`);
        return;
      }
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }

    if (what === 'token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      log.push({ provider, form: Object.fromEntries(form), auth: req.headers.authorization || null });
      if (form.get('grant_type') === 'refresh_token') {
        const id = JSON.parse(unb64url(form.get('refresh_token').replace(/^rt\./, '')));
        if (id.revoked) return send(res, 400, { error: 'invalid_grant' });
        return send(res, 200, { access_token: 'at.' + b64url(JSON.stringify(id)), expires_in: 3600 });
      }
      let id;
      try { id = JSON.parse(unb64url(form.get('code'))); } catch { return send(res, 400, { error: 'invalid_grant' }); }
      if (id.challenge && !form.get('code_verifier')) return send(res, 400, { error: 'invalid_request', error_description: 'PKCE verifier missing' });
      const tokens = { access_token: 'at.' + form.get('code'), refresh_token: 'rt.' + form.get('code'), expires_in: 3600, token_type: 'Bearer' };
      if (provider === 'apple') {
        tokens.id_token = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: id.sub, email: id.email, email_verified: id.verified ? 'true' : 'false' }))}.x`;
      }
      return send(res, 200, tokens);
    }

    if (what === 'userinfo') {
      const id = who(req);
      if (!id) return send(res, 401, { error: 'no token' });
      if (provider === 'discord') return send(res, 200, { id: id.sub, username: id.name, global_name: id.name, email: id.email, verified: !!id.verified });
      if (provider === 'github') return send(res, 200, { id: Number(String(id.sub).replace(/\D/g, '')) || 4242, login: id.name, name: id.name });
      return send(res, 200, { sub: id.sub, email: id.email, email_verified: !!id.verified, name: id.name, given_name: id.name });
    }
    if (what === 'emails' && provider === 'github') {
      const id = who(req);
      return send(res, 200, id && id.email ? [{ email: id.email, primary: true, verified: !!id.verified }] : []);
    }

    if (provider === 'spotify' && what === 'v1') {
      const id = who(req);
      if (!id) return send(res, 401, { error: { status: 401 } });
      if (id.notAllowlisted) return send(res, 403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
      const route = '/' + rest.join('/');
      if (route === '/me') return send(res, 200, { id: id.sub, display_name: id.name });
      if (route === '/me/top/tracks' && pretend) return send(res, 200, { items: demoTracks(id.sub, url.searchParams.get('time_range')) });
      if (route === '/me/top/tracks') {
        const range = url.searchParams.get('time_range');
        const tracks = [['Mr. Brightside', 'The Killers'], ['Welcome to the Black Parade', 'My Chemical Romance'], ['Hey Ya!', 'OutKast']]
          .map(([name, artist], i) => ({
            name: range === 'long_term' ? name + ' (all time)' : name,
            artists: [{ name: artist }],
            album: { name: 'Album ' + i, images: [{ url: `https://i.scdn.co/image/big${i}`, width: 640 }, { url: `https://i.scdn.co/image/mid${i}`, width: 300 }, { url: `https://i.scdn.co/image/small${i}`, width: 64 }] },
            external_urls: { spotify: `https://open.spotify.com/track/mock${i}` },
            preview_url: i === 0 ? 'https://p.scdn.co/mp3-preview/mock' : null,
          }));
        return send(res, 200, { items: tracks });
      }
    }

    if (provider === 'itunes' && what === 'search') {
      // the demo asks the real iTunes Search API (no account needed), so the play buttons play real previews
      if (pretend) {
        try {
          const r = await fetch('https://itunes.apple.com/search' + url.search, { signal: AbortSignal.timeout(4000) });
          return send(res, 200, r.ok ? await r.text() : { results: [] });
        } catch { return send(res, 200, { results: [] }); }
      }
      return send(res, 200, { results: [{ previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mock.m4a' }] });
    }

    send(res, 404, { error: 'mock: no such endpoint ' + url.pathname });
  });

  await new Promise((r, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', r); });
  const actual = server.address().port;
  return {
    base: `http://127.0.0.1:${actual}`,
    port: actual,
    next(provider, identity) { (queue[provider] = queue[provider] || []).push(identity); },
    log,
    close: () => new Promise(r => server.close(r)),
  };
}

// the demo's pretend Spotify: a different top 5 for each person (and each time range), from real songs
const SONGS = [['Mr. Brightside', 'The Killers'], ['Welcome to the Black Parade', 'My Chemical Romance'], ['Hey Ya!', 'OutKast'],
  ['Misery Business', 'Paramore'], ['Sk8er Boi', 'Avril Lavigne'], ['Toxic', 'Britney Spears'], ['Crazy in Love', 'Beyoncé'],
  ['Seven Nation Army', 'The White Stripes'], ['Float On', 'Modest Mouse'], ['Since U Been Gone', 'Kelly Clarkson'],
  ['Sugar, We\'re Goin Down', 'Fall Out Boy'], ['Maps', 'Yeah Yeah Yeahs'], ['Gold Digger', 'Kanye West'],
  ['Feel Good Inc.', 'Gorillaz'], ['Hips Don\'t Lie', 'Shakira'], ['Take Me Out', 'Franz Ferdinand'], ['Umbrella', 'Rihanna'],
  ['Last Nite', 'The Strokes'], ['In da Club', '50 Cent'], ['The Middle', 'Jimmy Eat World'], ['Such Great Heights', 'The Postal Service'],
  ['Chasing Cars', 'Snow Patrol'], ['Ocean Avenue', 'Yellowcard'], ['Hollaback Girl', 'Gwen Stefani']];
function demoTracks(sub, range) {
  let n = 0;
  for (const ch of `${sub}:${range}`) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 5 }, (_, i) => SONGS[(n + i * 7) % SONGS.length]).map(([name, artist], i) => ({
    name, artists: [{ name: artist }], album: { name: '', images: [] },          // no album art: its real addresses are Spotify's
    external_urls: { spotify: 'https://open.spotify.com/search/' + encodeURIComponent(`${name} ${artist}`) },
    preview_url: null,
  }));
}

const LABELS = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft', discord: 'Discord', github: 'GitHub', spotify: 'Spotify' };
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// the page that stands in for "Sign in with Google" etc. in the local demo
function pretendPage(res, provider, q) {
  const label = LABELS[provider] || provider;
  const keep = [...q].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const cancel = new URL(q.get('redirect_uri'));
  cancel.searchParams.set('error', 'access_denied');
  cancel.searchParams.set('state', q.get('state') || '');
  const spotify = provider === 'spotify';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pretend ${esc(label)} (local demo)</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #f2f2f2; color: #222; margin: 0; padding: 16px; }
  main { max-width: 420px; margin: 40px auto; background: #fff; border: 1px solid #ccc; border-radius: 8px; padding: 24px; }
  .tag { display: inline-block; background: #fff3b0; border: 1px solid #e0c200; border-radius: 4px; padding: 2px 8px; font-size: 13px; }
  h1 { font-size: 22px; margin: 12px 0 4px; }
  p { margin: 8px 0; color: #555; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 8px; font: inherit; border: 1px solid #aaa; border-radius: 4px; }
  .check { font-weight: 400; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 20px; }
  button { font: inherit; padding: 8px 18px; border: 0; border-radius: 4px; background: #1a73e8; color: #fff; cursor: pointer; }
  a { color: #555; }
</style>
<main>
  <span class="tag">🧪 local demo: not the real ${esc(label)}</span>
  <h1>Pretend ${esc(label)} ${spotify ? 'connection' : 'sign-in'}</h1>
  <p>On the real site, this is where ${esc(label)}'s own page asks the person to ${spotify ? 'log in to Spotify and allow OurSpace to see their top songs' : 'pick their account'}. Nothing here talks to ${esc(label)}.</p>
  <p>OurSpace asked for: <code>${esc(q.get('scope') || '')}</code></p>
  <form method="get" action="/${esc(provider)}/approve">
    ${keep}
    <label for="n">Pretend to be</label>
    <input id="n" type="text" name="demo_name" value="Demo Person" maxlength="40">
    <p>The same name always comes back as the same ${esc(label)} account.</p>
    ${spotify ? '<label class="check"><input type="checkbox" name="demo_not_allowlisted"> pretend this person isn\'t on the app\'s Spotify allowlist (the 5-person limit)</label>' : ''}
    <div class="row"><button type="submit">Continue</button> <a href="${esc(cancel)}">Cancel</a></div>
  </form>
</main>`);
}

// run on its own: `node test/mock-providers.mjs 8899` (for trying the sign-in buttons by hand against `npm run dev`).
// `npm run demo` runs this for you, with the pretend pages on.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMock(Number(process.argv[2]) || 8899, { pretend: true });
  console.log('mock providers on', m.base);
}
