// ourspace-social — one Worker for the whole site:
//   /api/*          the JSON API below (accounts, sign-in providers, profiles, friends, posts, messages, Spotify,
//                   astrology, blocks, reports, moderation)
//   everything else the static pages in public/ (wrangler.jsonc → assets), with /u/<name> etc. falling back to
//                   index.html so the page's own router can draw them
// The cron (every 30 min) clears out expired sessions, sign-in tickets, reset links and old rate-limit rows.
import { HttpError, json } from './http.js';
import { currentUser, me, signup, login, logout, changePassword, deleteAccount, forgotPassword, resetPassword } from './auth.js';
import { oauthStart, oauthCallback, signupPending, signupFinish, providers, account, unlink } from './oauth.js';
import { options, profile, browse, friendsOf, saveProfile, saveSettings } from './profiles.js';
import { addFriend, removeFriend, requests, postWall, postStatus, postBulletin, postBlog, deletePost, feed, bulletins, blogOf, statusesOf } from './social.js';
import { inbox, thread, sendMessage } from './messages.js';
import { getSpotify, putSpotify, refreshSpotify, deleteSpotify } from './spotify.js';
import { astroSky, astroSign, astroMe } from './horoscope.js';
import { listBlocks, block, unblock, report, adminReports, resolveReport, adminUser, adminContent, adminLog } from './safety.js';

const OPEN = 0, AUTH = 1, ADMIN = 2;

const ROUTES = [
  ['GET', '/api/options', options, OPEN],
  ['GET', '/api/me', me, OPEN],
  ['POST', '/api/signup', signup, OPEN],
  ['POST', '/api/login', login, OPEN],
  ['POST', '/api/logout', logout, OPEN],
  ['POST', '/api/password/forgot', forgotPassword, OPEN],
  ['POST', '/api/password/reset', resetPassword, OPEN],
  ['GET', '/api/auth/providers', providers, OPEN],
  ['GET', '/api/oauth/:provider/start', oauthStart, OPEN],
  ['GET', '/api/oauth/:provider/callback', oauthCallback, OPEN],
  ['POST', '/api/oauth/:provider/callback', oauthCallback, OPEN, { crossSite: true }],   // Apple answers with a form POST
  ['GET', '/api/signup/pending', signupPending, OPEN],
  ['POST', '/api/signup/finish', signupFinish, OPEN],

  ['GET', '/api/me/account', account, AUTH],
  ['DELETE', '/api/me/identities/:provider', unlink, AUTH],
  ['PUT', '/api/me/profile', saveProfile, AUTH],
  ['PUT', '/api/me/settings', saveSettings, AUTH],
  ['POST', '/api/me/password', changePassword, AUTH],
  ['DELETE', '/api/me', deleteAccount, AUTH],
  ['GET', '/api/me/spotify', getSpotify, AUTH],
  ['PUT', '/api/me/spotify', putSpotify, AUTH],
  ['POST', '/api/me/spotify/refresh', refreshSpotify, AUTH],
  ['DELETE', '/api/me/spotify', deleteSpotify, AUTH],

  ['GET', '/api/astro/sky', astroSky, OPEN],
  ['GET', '/api/astro/sign/:sign', astroSign, OPEN],
  ['GET', '/api/astro/me', astroMe, AUTH],

  ['GET', '/api/users', browse, OPEN],
  ['GET', '/api/users/:name', profile, OPEN],
  ['GET', '/api/users/:name/friends', friendsOf, OPEN],
  ['GET', '/api/users/:name/blog', blogOf, OPEN],
  ['GET', '/api/users/:name/statuses', statusesOf, OPEN],
  ['POST', '/api/users/:name/wall', postWall, AUTH],

  ['GET', '/api/feed', feed, OPEN],
  ['POST', '/api/status', postStatus, AUTH],
  ['GET', '/api/bulletins', bulletins, OPEN],
  ['POST', '/api/bulletins', postBulletin, AUTH],
  ['POST', '/api/blog', postBlog, AUTH],
  ['DELETE', '/api/posts/:id', deletePost, AUTH],

  ['GET', '/api/requests', requests, AUTH],
  ['POST', '/api/friends/:name', addFriend, AUTH],
  ['DELETE', '/api/friends/:name', removeFriend, AUTH],

  ['GET', '/api/inbox', inbox, AUTH],
  ['GET', '/api/inbox/:name', thread, AUTH],
  ['POST', '/api/inbox/:name', sendMessage, AUTH],

  ['GET', '/api/blocks', listBlocks, AUTH],
  ['POST', '/api/blocks/:name', block, AUTH],
  ['DELETE', '/api/blocks/:name', unblock, AUTH],
  ['POST', '/api/reports', report, AUTH],

  ['GET', '/api/admin/reports', adminReports, ADMIN],
  ['POST', '/api/admin/reports/:id', resolveReport, ADMIN],
  ['POST', '/api/admin/users/:name', adminUser, ADMIN],
  ['POST', '/api/admin/content', adminContent, ADMIN],
  ['GET', '/api/admin/log', adminLog, ADMIN],
].map(([method, path, handler, access, opts = {}]) => ({
  method, handler, access, ...opts,
  keys: [...path.matchAll(/:(\w+)/g)].map(m => m[1]),
  re: new RegExp('^' + path.replace(/:(\w+)/g, '([^/]+)') + '$'),
}));

function match(method, pathname) {
  let pathOnly = false;
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== method) { pathOnly = true; continue; }
    let params;
    try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { return { status: 400 }; }
    return { route: r, params };
  }
  return { status: pathOnly ? 405 : 404 };
}

async function api(request, env, ctx, url) {
  const c = { req: request, env, ctx, url, now: Date.now(), params: {}, user: null };
  const found = match(request.method, url.pathname);
  if (!found.route) return json({ error: found.status === 405 ? 'method not allowed' : found.status === 400 ? 'bad address' : 'not found' }, found.status);

  // Changes only from our own pages: a browser always sends Origin on these requests, and another site's would not
  // match. (SameSite=Lax cookies and JSON-only bodies are the other two locks on that door.) The one exception is the
  // sign-in provider posting back to us, which is protected by its single-use state instead.
  if (request.method !== 'GET' && !found.route.crossSite) {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if ((origin && origin !== url.origin) || site === 'cross-site') return json({ error: 'cross-site request refused' }, 403);
  }

  c.params = found.params;
  c.user = await currentUser(c);
  if (found.route.access >= AUTH && !c.user) return json({ error: 'log in first.' }, 401);
  if (found.route.access === ADMIN && !c.user.is_admin) return json({ error: 'moderators only.' }, 403);
  return found.route.handler(c);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e.cookie ? { 'Set-Cookie': e.cookie } : {});
      console.error((e && e.stack) || e);
      return json({ error: 'something broke on our end. try again in a minute.' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_signups WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM password_resets WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM attempts WHERE created < ?').bind(now - 2 * 86400000),
    ]).catch(e => console.error('cron failed:', (e && e.stack) || e)));
  },
};
