/* core/state.js — who's logged in and what the server told us.
   loadMe() refreshes it, then calls everyone who subscribed with onMeChange()
   (the entry repaints the header and tabs). */

import { api } from './api.js';

export const S = {
  me: null,                       // { id, name, avatar, isAdmin, sign } or null
  counts: { requests: 0, unread: 0, notifications: 0, reports: 0 },
  settings: null,
  account: { verified: true, held: false, timeoutUntil: null, strikes: 0 },   // where the account stands (email confirmed, held, posting timeout)
  minAge: 13,
  contact: null,                  // the site's public contact address (/api/me), or null while the owner hasn't set one
  options: null,                  // GET /api/options (lazy)
  providers: { signIn: [], spotify: false },
};

const meListeners = [];
// fn() runs after every loadMe(), once S is up to date
export function onMeChange(fn) { meListeners.push(fn); }

export async function loadMe() {
  const r = await api.get('/me');
  const before = S.counts.unread;
  S.me = r.user;
  S.minAge = r.minAge || 13;
  S.contact = r.contact || null;
  S.counts = r.counts || { requests: 0, unread: 0, notifications: 0, reports: 0 };
  S.settings = r.settings || null;
  S.account = r.account || { verified: true, held: false, timeoutUntil: null, strikes: 0 };
  meListeners.forEach(fn => fn());   // the entry repaints the header and tabs
  return before;
}
export async function options() {
  if (!S.options) S.options = await api.get('/options');
  return S.options;
}
