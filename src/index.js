// ourspace-social — one Worker for the whole site:
//   /api/*          the JSON API below (accounts, sign-in providers, profiles, follows, posts and the feed, replies,
//                   likes, reposts, quotes, bookmarks, tags, boards with their threads, comments and votes,
//                   notifications, chat (#ourspace, group chats, DMs), Browse (discovery, mutuals, boards for you, who to
//                   follow), photo uploads, Spotify, astrology, blocks,
//                   reports, moderation)
//   /api/live/:room a chat room's WebSocket, handed to its Durable Object (src/live/room.js, exported below as Room)
//                   (a client with no cookie opens it with a one-room pass from POST /api/live/ticket)
//   /media/<key>    uploaded photos, from the R2 bucket MEDIA, to whoever may see them (src/media/media.js)
//   everything else the static pages in public/ (wrangler.jsonc → assets), with /u/<name> etc. falling back to
//                   index.html so the page's own router can draw them
// The mobile apps use the same API with a bearer token instead of the cookie, from three origins that CORS answers (and
// no others): src/shared/app.js, src/accounts/auth.js, docs/mobile/contract.md. Their devices and push: src/push/.
// The cron (every minute) sends the push notifications waiting in the outbox. The cron (every 30 min) clears out expired sessions, sign-in tickets, chat-socket passes, reset links, old rate-limit rows, photo uploads
// never attached to anything, #ourspace messages past its rolling window, expired mutes and faded interaction scores,
// and the trust data past its time (sign-up signals and AI scores after 90 days); a nightly one looks for clusters of
// accounts for the moderators (src/trust/clusters.js).
import { HttpError, json, netLimit } from './shared/http.js';
import { currentUser, me, signup, login, logout, changePassword, deleteAccount, forgotPassword, resetPassword } from './accounts/auth.js';
import { oauthStart, oauthCallback, oauthExchange, signupPending, signupFinish, providers, account, unlink } from './accounts/oauth.js';
import { options, profile, browse, saveProfile, saveSettings } from './profiles/profiles.js';
import { followUser, unfollowUser, acceptFollower, removeFollower, requests, followersOf, followingOf, friendsOf } from './follows/follows.js';
import { postComment, postStatus, postBlog, deletePost, feed, saveMarker, blogOf, statusesOf, repliesOf, commentsOf, onePost, tagged } from './social/social.js';
import { postReply, postQuote, likePost, unlikePost, repostPost, unrepostPost, bookmarkPost, unbookmarkPost, bookmarks } from './social/interactions.js';
import { boardList, board, postThread, boardThread, threadComments, postThreadComment, moderateThread, moderateBoard } from './boards/boards.js';
import { votePost } from './boards/votes.js';
import { requestBoard, boardRequests, decideBoardRequest } from './boards/requests.js';
import { notifications } from './notifications/notifications.js';
import { chatList, oneChat, chatMessages, sendChatMessage, readChat, createChat, addMembers, removeMember, leaveChat, answerInvite, renameChat, chatSuggestions } from './chats/chats.js';
import { deleteChatMessage } from './chats/messages.js';
import { ourspaceMessages, postOurspace, muteMember, sweepChat } from './chats/ourspace.js';
import { liveRoom, liveTicket } from './chats/live.js';
import { getSpotify, putSpotify, refreshSpotify, deleteSpotify } from './music/spotify.js';
import { astroSky, astroSign, astroMe } from './horoscope/horoscope.js';
import { listBlocks, block, unblock, report, adminReports, resolveReport, adminUser, adminContent, adminLog } from './safety/safety.js';
import { discover, mutuals, people, boardsForYou, hideSuggestion, unhideSuggestion } from './browse/browse.js';
import { boardTerms, saveBoardTerms } from './browse/terms.js';
import { uploadMedia, deleteUpload, serveMedia, adminMedia, moderateMedia, sweepMedia } from './media/media.js';
import { verifyEmail, resendVerification } from './accounts/verify.js';
import { formFor } from './trust/form.js';
import { heldAccounts, decideHeld, adminAlerts, resolveAlert } from './trust/moderation.js';
import { findClusters, sweepTrust } from './trust/clusters.js';
import { myStrikes, appealStrike, adminAppeals, decideStrike, adminScans } from './ai/strikes.js';
import { sweepStrikes } from './ai/scan.js';
import { checkGate } from './shared/gate.js';
import { tokenRequest, corsFor, preflight, withCors } from './shared/app.js';
import { myDevices, registerDevice, revokeDevice } from './push/devices.js';
import { drainPush } from './push/push.js';

// the Durable Object class behind every chat room (wrangler.jsonc → durable_objects)
export { Room } from './live/room.js';

const OPEN = 0, AUTH = 1, ADMIN = 2;
const NIGHTLY = '17 3 * * *';
const EVERY_MINUTE = '* * * * *';

// Every write a member makes (AUTH, not GET) passes the gate in src/shared/gate.js: a confirmed email and not held for
// review; `gate: 'post'` adds "no posting timeout" (public posting and commenting). A write that needs neither (account
// and page set-up, private things, undoing, safety) says why in `free`; `freeWhen` narrows that to some requests.
// `net`: unauthenticated sign-up traffic, braked per network (netLimit in src/shared/http.js).
// test/api.test.mjs reads this table and tries every gated route as an unverified, a held and a timed-out member.
const ROUTES = [
  ['GET', '/api/options', options, OPEN],
  ['GET', '/api/me', me, OPEN],
  ['GET', '/api/form/:purpose', formFor, OPEN, { net: true }],
  ['POST', '/api/signup', signup, OPEN, { net: true }],
  ['POST', '/api/login', login, OPEN],
  ['POST', '/api/logout', logout, OPEN],
  ['POST', '/api/password/forgot', forgotPassword, OPEN],
  ['POST', '/api/password/reset', resetPassword, OPEN],
  ['POST', '/api/verify', verifyEmail, OPEN],
  ['GET', '/api/auth/providers', providers, OPEN],
  ['GET', '/api/oauth/:provider/start', oauthStart, OPEN],
  ['GET', '/api/oauth/:provider/callback', oauthCallback, OPEN],
  ['POST', '/api/oauth/exchange', oauthExchange, OPEN],
  ['GET', '/api/signup/pending', signupPending, OPEN],
  ['POST', '/api/signup/finish', signupFinish, OPEN, { net: true }],

  ['GET', '/api/me/account', account, AUTH],
  ['DELETE', '/api/me/identities/:provider', unlink, AUTH, { free: 'account' }],
  ['PUT', '/api/me/profile', saveProfile, AUTH, { free: 'setting up your page' }],
  ['PUT', '/api/me/settings', saveSettings, AUTH, { free: 'privacy settings' }],
  ['PUT', '/api/me/markers/:name', saveMarker, AUTH, { free: 'private: how far you read' }],
  ['GET', '/api/me/bookmarks', bookmarks, AUTH],
  ['GET', '/api/me/devices', myDevices, AUTH],
  ['POST', '/api/me/devices', registerDevice, AUTH, { free: 'your own devices' }],
  ['DELETE', '/api/me/devices/:id', revokeDevice, AUTH, { free: 'your own devices' }],
  ['POST', '/api/me/password', changePassword, AUTH, { free: 'account' }],
  ['DELETE', '/api/me', deleteAccount, AUTH, { free: 'account' }],
  ['POST', '/api/me/verify/resend', resendVerification, AUTH, { free: 'the way to get verified' }],
  ['GET', '/api/me/strikes', myStrikes, AUTH],
  ['POST', '/api/me/strikes/:id/appeal', appealStrike, AUTH, { free: 'appealing must work while timed out' }],
  ['GET', '/api/me/spotify', getSpotify, AUTH],
  ['PUT', '/api/me/spotify', putSpotify, AUTH, { free: 'setting up your page' }],
  ['POST', '/api/me/spotify/refresh', refreshSpotify, AUTH, { free: 'setting up your page' }],
  ['DELETE', '/api/me/spotify', deleteSpotify, AUTH, { free: 'setting up your page' }],

  ['GET', '/api/astro/sky', astroSky, OPEN],
  ['GET', '/api/astro/sign/:sign', astroSign, OPEN],
  ['GET', '/api/astro/me', astroMe, AUTH],

  ['GET', '/api/users', browse, OPEN],
  ['GET', '/api/users/:name', profile, OPEN],
  ['GET', '/api/users/:name/followers', followersOf, OPEN],
  ['GET', '/api/users/:name/following', followingOf, OPEN],
  ['GET', '/api/users/:name/friends', friendsOf, OPEN],
  ['GET', '/api/users/:name/blog', blogOf, OPEN],
  ['GET', '/api/users/:name/statuses', statusesOf, OPEN],
  ['GET', '/api/users/:name/replies', repliesOf, OPEN],
  ['GET', '/api/users/:name/comments', commentsOf, OPEN],
  ['POST', '/api/users/:name/comments', postComment, AUTH, { gate: 'post' }],

  ['GET', '/api/feed', feed, OPEN],
  ['POST', '/api/status', postStatus, AUTH, { gate: 'post' }],
  ['POST', '/api/blog', postBlog, AUTH, { gate: 'post' }],
  ['GET', '/api/posts/:id', onePost, OPEN],
  ['DELETE', '/api/posts/:id', deletePost, AUTH, { free: 'deleting your own post' }],
  ['POST', '/api/posts/:id/replies', postReply, AUTH, { gate: 'post' }],
  ['POST', '/api/posts/:id/quote', postQuote, AUTH, { gate: 'post' }],
  ['POST', '/api/posts/:id/like', likePost, AUTH],
  ['DELETE', '/api/posts/:id/like', unlikePost, AUTH, { free: 'undoing' }],
  ['POST', '/api/posts/:id/repost', repostPost, AUTH],
  ['DELETE', '/api/posts/:id/repost', unrepostPost, AUTH, { free: 'undoing' }],
  ['POST', '/api/posts/:id/bookmark', bookmarkPost, AUTH, { free: 'private to you' }],
  ['DELETE', '/api/posts/:id/bookmark', unbookmarkPost, AUTH, { free: 'private to you' }],
  ['GET', '/api/tags/:tag', tagged, OPEN],
  ['POST', '/api/media', uploadMedia, AUTH, { free: 'your own picture is page set-up', freeWhen: c => c.url.searchParams.get('purpose') === 'avatar' }],
  ['DELETE', '/api/media/:id', deleteUpload, AUTH, { free: 'taking back your own upload' }],

  ['GET', '/api/boards', boardList, OPEN],
  ['POST', '/api/boards/requests', requestBoard, AUTH],
  ['GET', '/api/boards/:slug', board, OPEN],
  ['POST', '/api/boards/:slug/threads', postThread, AUTH, { gate: 'post' }],
  ['GET', '/api/threads/:id', boardThread, OPEN],
  ['GET', '/api/threads/:id/comments/:commentId', threadComments, OPEN],
  ['POST', '/api/threads/:id/comments', postThreadComment, AUTH, { gate: 'post' }],
  ['PUT', '/api/posts/:id/vote', votePost, AUTH],
  ['GET', '/api/notifications', notifications, AUTH],

  ['GET', '/api/browse/discover', discover, OPEN],
  ['GET', '/api/browse/mutuals', mutuals, OPEN],
  ['GET', '/api/browse/people', people, OPEN],
  ['GET', '/api/browse/boards', boardsForYou, OPEN],
  ['POST', '/api/browse/hidden/:kind/:ref', hideSuggestion, AUTH, { free: 'private to you' }],
  ['DELETE', '/api/browse/hidden/:kind/:ref', unhideSuggestion, AUTH, { free: 'private to you' }],

  ['GET', '/api/requests', requests, AUTH],
  ['POST', '/api/follows/:name', followUser, AUTH],
  ['DELETE', '/api/follows/:name', unfollowUser, AUTH, { free: 'undoing' }],
  ['POST', '/api/followers/:name', acceptFollower, AUTH],
  ['DELETE', '/api/followers/:name', removeFollower, AUTH, { free: 'removing someone' }],

  ['GET', '/api/chats', chatList, AUTH],
  ['POST', '/api/chats', createChat, AUTH],
  ['GET', '/api/chats/suggestions', chatSuggestions, AUTH],
  ['GET', '/api/chats/:id', oneChat, AUTH],
  ['PUT', '/api/chats/:id', renameChat, AUTH],
  ['GET', '/api/chats/:id/messages', chatMessages, AUTH],
  ['POST', '/api/chats/:id/messages', sendChatMessage, AUTH],
  ['PUT', '/api/chats/:id/read', readChat, AUTH, { free: 'private: how far you read' }],
  ['POST', '/api/chats/:id/members', addMembers, AUTH],
  ['DELETE', '/api/chats/:id/members/:name', removeMember, AUTH, { free: 'removing someone' }],
  ['POST', '/api/chats/:id/leave', leaveChat, AUTH, { free: 'leaving' }],
  ['POST', '/api/chats/:id/invite', answerInvite, AUTH],
  ['DELETE', '/api/chat-messages/:id', deleteChatMessage, AUTH, { free: 'deleting your own message' }],
  ['GET', '/api/ourspace/messages', ourspaceMessages, AUTH],
  ['POST', '/api/ourspace/messages', postOurspace, AUTH],
  ['POST', '/api/live/ticket', liveTicket, AUTH, { free: 'the pass for a chat socket, which is a GET' }],
  ['GET', '/api/live/:room', liveRoom, AUTH],

  ['GET', '/api/blocks', listBlocks, AUTH],
  ['POST', '/api/blocks/:name', block, AUTH, { free: 'safety' }],
  ['DELETE', '/api/blocks/:name', unblock, AUTH, { free: 'safety' }],
  ['POST', '/api/reports', report, AUTH, { free: 'safety' }],

  ['GET', '/api/admin/reports', adminReports, ADMIN],
  ['POST', '/api/admin/reports/:id', resolveReport, ADMIN],
  ['POST', '/api/admin/users/:name', adminUser, ADMIN],
  ['POST', '/api/admin/content', adminContent, ADMIN],
  ['GET', '/api/admin/log', adminLog, ADMIN],
  ['GET', '/api/admin/board-requests', boardRequests, ADMIN],
  ['POST', '/api/admin/board-requests/:id', decideBoardRequest, ADMIN],
  ['POST', '/api/admin/threads/:id', moderateThread, ADMIN],
  ['POST', '/api/admin/boards/:slug', moderateBoard, ADMIN],
  ['GET', '/api/admin/boards/:slug/terms', boardTerms, ADMIN],
  ['PUT', '/api/admin/boards/:slug/terms', saveBoardTerms, ADMIN],
  ['GET', '/api/admin/media', adminMedia, ADMIN],
  ['POST', '/api/admin/media/:id', moderateMedia, ADMIN],
  ['POST', '/api/admin/mutes', muteMember, ADMIN],
  ['GET', '/api/admin/held', heldAccounts, ADMIN],
  ['POST', '/api/admin/held/:name', decideHeld, ADMIN],
  ['GET', '/api/admin/alerts', adminAlerts, ADMIN],
  ['POST', '/api/admin/alerts/:id', resolveAlert, ADMIN],
  ['GET', '/api/admin/appeals', adminAppeals, ADMIN],
  ['POST', '/api/admin/strikes/:id', decideStrike, ADMIN],
  ['GET', '/api/admin/ai-scans', adminScans, ADMIN],
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
  // match. (SameSite=Lax cookies and JSON-only bodies are the other two locks on that door.) Not for an app's request
  // (a bearer token, or X-OurSpace-Client, and no os_sid cookie): it has no ambient credentials for a hostile page to
  // ride, and the headers are ones no hostile page can make a browser send (src/shared/app.js).
  if (request.method !== 'GET' && !tokenRequest(request)) {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if ((origin && origin !== url.origin) || site === 'cross-site') return json({ error: 'cross-site request refused' }, 403);
  }

  c.params = found.params;
  // `net`: unauthenticated sign-up traffic, braked per network before anything touches the database (shared/http.js)
  if (found.route.net) await netLimit(c);
  c.user = await currentUser(c);
  if (found.route.access >= AUTH && !c.user) return json({ error: 'log in first.' }, 401);
  if (found.route.access === ADMIN && !c.user.is_admin) return json({ error: 'moderators only.' }, 403);
  // the gate on members' writes (src/shared/gate.js): verified, not held, and for public posting no timeout
  const r = found.route;
  if (r.access === AUTH && request.method !== 'GET' && !(r.free && (!r.freeWhen || r.freeWhen(c)))) await checkGate(c, r.gate || 'write');
  return found.route.handler(c);
}

// /media/<key>: a photo, for whoever may see it (GET or HEAD; the session decides who's asking)
async function media(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const c = { req: request, env, ctx, url, now: Date.now(), params: {}, user: null };
  c.user = await currentUser(c);
  return serveMedia(c, url.pathname.slice('/media/'.length));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isMedia = url.pathname.startsWith('/media/');
    if (!url.pathname.startsWith('/api/') && !isMedia) return env.ASSETS.fetch(request);
    // CORS: only the apps' three origins ever get an answer (src/shared/app.js); everyone else's OPTIONS is a 405 as before
    const origin = corsFor(request);
    if (origin && request.method === 'OPTIONS') return preflight(origin);
    let res;
    try {
      res = await (isMedia ? media(request, env, ctx, url) : api(request, env, ctx, url));
    } catch (e) {
      if (e instanceof HttpError) res = json({ ...(e.extra || {}), error: e.message }, e.status, e.cookie ? { 'Set-Cookie': e.cookie } : {});
      else {
        console.error((e && e.stack) || e);
        res = json({ error: 'something broke on our end. try again in a minute.' }, 500);
      }
    }
    return origin ? withCors(res, origin) : res;
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    // every minute: the push notifications waiting in the outbox (src/push/push.js). Nothing else runs this often.
    if (event.cron === EVERY_MINUTE) {
      ctx.waitUntil(drainPush(env, now).catch(e => console.error('push drain failed:', (e && e.stack) || e)));
      return;
    }
    // nightly (wrangler.jsonc: '17 3 * * *'): look for accounts that came together, for the moderators. Never bans.
    if (event.cron === NIGHTLY) {
      ctx.waitUntil(findClusters(env, now).catch(e => console.error('cluster check failed:', (e && e.stack) || e)));
      return;
    }
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_signups WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_app_codes WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM live_tickets WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM password_resets WHERE expires < ?').bind(now),
      env.DB.prepare('DELETE FROM attempts WHERE created < ?').bind(now - 2 * 86400000),
    ]).catch(e => console.error('cron failed:', (e && e.stack) || e)));
    // photo uploads loose for a day, and photos whose post went without them: out of the table and R2
    ctx.waitUntil(sweepMedia(env, now).catch(e => console.error('media sweep failed:', (e && e.stack) || e)));
    // #ourspace's rolling window (reported messages stay), expired mutes, interaction scores faded below 0.05
    ctx.waitUntil(sweepChat(env, now).catch(e => console.error('chat sweep failed:', (e && e.stack) || e)));
    // sign-up signals (90 days), post fingerprints (7), used form nonces and email links, resolved alerts (90 days);
    // strikes past their 90 clean days, old flagged text, AI scan scores (90 days)
    ctx.waitUntil(sweepTrust(env, now).catch(e => console.error('trust sweep failed:', (e && e.stack) || e)));
    ctx.waitUntil(sweepStrikes(env, now).catch(e => console.error('strike sweep failed:', (e && e.stack) || e)));
  },
};
