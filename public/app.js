/* ============================================================
   app.js — OurSpace, the social network: the entry module.
   Talks to the API (/api/*, the Worker in src/). Everyone here
   is a real person. Everything people wrote is put on the page
   with textContent (never innerHTML).
   The rest lives in js/: core/ (helpers, state, router, header),
   widgets/ (bits several pages share) and pages/ (one per page).
   This file holds the route table and starts everything up.
   ============================================================ */

import './js/core/native.js';   // the iOS / Android bridge; does nothing in a browser
import { $, enc } from './js/core/dom.js';
import { api } from './js/core/api.js';
import { toast } from './js/core/ui.js';
import { S, onMeChange, loadMe } from './js/core/state.js';
import { go, route, start } from './js/core/router.js';
import { paintChrome } from './js/core/chrome.js';
import { renderAdmin } from './js/pages/admin.js';
import { renderJoin, renderFinish, renderLogin, renderForgot, renderReset } from './js/pages/auth.js';
import { renderBookmarks } from './js/pages/bookmarks.js';
import { renderBrowse } from './js/pages/browse.js';
import { renderBoards, renderBoard } from './js/pages/boards.js';
import { renderEdit } from './js/pages/edit.js';
import { renderHome } from './js/pages/home.js';
import { renderHoroscope } from './js/pages/horoscope.js';
import { renderChat } from './js/pages/chat.js';
import { renderBlogPost } from './js/pages/blog.js';
import { renderFollowers, renderFollowing, renderFriends } from './js/pages/lists.js';
import { renderMessages, renderInboxRedirect } from './js/pages/messages.js';
import { renderNotifications } from './js/pages/notifications.js';
import { renderOurspace } from './js/pages/ourspace.js';
import { renderPost } from './js/pages/post.js';
import { renderProfile, renderProfileReplies, renderProfileBlog, renderProfileComments } from './js/pages/profile.js';
import { renderRequests } from './js/pages/requests.js';
import { renderPrivacy } from './js/pages/privacy.js';
import { renderRules } from './js/pages/rules.js';
import { renderSettings } from './js/pages/settings.js';
import { renderTerms } from './js/pages/terms.js';
import { renderStrikes } from './js/pages/strikes.js';
import { renderVerify } from './js/pages/verify.js';
import { renderTag } from './js/pages/tags.js';
import { renderBoardThread } from './js/pages/thread.js';

/* ------------------------------------------------------------ router */

const ROUTES = [
  [/^\/$/, renderHome],
  [/^\/join$/, renderJoin],
  [/^\/join\/finish$/, renderFinish],
  [/^\/login$/, renderLogin],
  [/^\/forgot$/, renderForgot],
  [/^\/reset$/, renderReset],
  [/^\/u\/([^/]+)$/, renderProfile],
  [/^\/u\/([^/]+)\/replies$/, renderProfileReplies],
  [/^\/u\/([^/]+)\/blog$/, renderProfileBlog],
  [/^\/u\/([^/]+)\/blog\/(\d+)$/, renderBlogPost],
  [/^\/u\/([^/]+)\/post\/(\d+)$/, renderPost],
  [/^\/u\/([^/]+)\/comments$/, renderProfileComments],
  [/^\/u\/([^/]+)\/followers$/, renderFollowers],
  [/^\/u\/([^/]+)\/following$/, renderFollowing],
  [/^\/u\/([^/]+)\/friends$/, renderFriends],
  [/^\/browse$/, renderBrowse],
  [/^\/notifications$/, renderNotifications, true],
  [/^\/bookmarks$/, renderBookmarks, true],
  [/^\/tags\/([^/]+)$/, renderTag],
  [/^\/requests$/, renderRequests, true],
  [/^\/messages$/, renderMessages, true],
  [/^\/messages\/(\d+)$/, renderChat, true],
  [/^\/inbox$/, renderInboxRedirect, true],                // the old Inbox's addresses
  [/^\/inbox\/([^/]+)$/, renderInboxRedirect, true],
  [/^\/ourspace$/, renderOurspace],
  [/^\/boards$/, renderBoards],
  [/^\/boards\/([^/]+)$/, renderBoard],
  [/^\/boards\/([^/]+)\/(\d+)$/, renderBoardThread],
  [/^\/bulletins$/, root => { go('/boards', true); }],   // the old Bulletin Board's address
  [/^\/horoscope$/, renderHoroscope],
  [/^\/horoscope\/([a-z]+)$/, renderHoroscope],
  [/^\/edit$/, renderEdit, true],
  [/^\/settings$/, renderSettings, true],
  [/^\/me\/strikes$/, renderStrikes, true],
  [/^\/verify$/, renderVerify],                            // the link in the confirmation email: /verify#token=…
  [/^\/admin$/, renderAdmin, true],
  [/^\/rules$/, renderRules],
  [/^\/terms$/, renderTerms],
  [/^\/privacy$/, renderPrivacy],
];

onMeChange(paintChrome);                       // every loadMe() repaints the header and tabs
start(ROUTES, { beforeEach: paintChrome });    // in-app links + back/forward; every page change repaints them too

/* ----------------------------------------------------------- startup */

$('#search').addEventListener('submit', e => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  go('/browse' + (q ? '?q=' + enc(q) : ''));
});

async function poll() {
  if (!S.me || document.hidden) return;
  try {
    const before = await loadMe();
    if (S.counts.unread > before && !location.pathname.startsWith('/messages')) toast('✉ you have a new message!', false, () => go('/messages'));
  } catch { /* offline for a moment */ }
}

(async () => {
  try {
    const [, prov] = await Promise.all([loadMe(), api.get('/auth/providers').catch(() => null)]);
    if (prov) S.providers = prov;
  } catch (e) { toast('ourspace can\'t reach its server right now. try again in a minute.', true); }
  await route();
  setInterval(poll, 30000);
})();
