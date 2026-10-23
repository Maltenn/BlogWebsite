// A stand-in for Google, Apple, Microsoft, Discord, GitHub, Spotify and iTunes Search, for the tests (the Worker talks
// to it when TEST_PROVIDER_BASE points here). It approves every sign-in at once. Who signs in is decided by the test:
// mock.next(provider, { sub, email, verified, name, notAllowlisted }) sets the identity the next authorize returns.
import http from 'node:http';

const b64url = s => Buffer.from(s).toString('base64url');
const unb64url = s => Buffer.from(s, 'base64url').toString();

export async function startMock(port = 0) {
  const queue = {};                                     // provider → identities to hand out, in order
  const log = [];                                       // every token request, for assertions
  const fallback = p => ({ sub: `${p}-${Math.random().toString(36).slice(2, 8)}`, email: null, verified: false, name: 'Mock Person' });

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

    if (what === 'authorize') {
      const q = url.searchParams;
      const id = (queue[provider] && queue[provider].shift()) || fallback(provider);
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
      return send(res, 200, { results: [{ previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mock.m4a' }] });
    }

    send(res, 404, { error: 'mock: no such endpoint ' + url.pathname });
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    base: `http://127.0.0.1:${actual}`,
    port: actual,
    next(provider, identity) { (queue[provider] = queue[provider] || []).push(identity); },
    log,
    close: () => new Promise(r => server.close(r)),
  };
}

// run on its own: `node test/mock-providers.mjs 8899` (for trying the sign-in buttons by hand against `npm run dev`)
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock(Number(process.argv[2]) || 8899);
  console.log('mock providers on', m.base);
}
