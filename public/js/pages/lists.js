/* pages/lists.js — who follows someone, who they follow, and their friends (people who follow each other). */

import { h, enc, userPath, poss } from '../core/dom.js';
import { api } from '../core/api.js';
import { pageTitle } from '../core/ui.js';
import { personCard } from '../widgets/people.js';

const LISTS = [
  ['followers', 'Followers', name => `nobody follows ${name} yet.`],
  ['following', 'Following', name => `${name} isn't following anyone yet.`],
  ['friends', 'Friends', name => `${name} has no friends yet. friends are people who follow each other.`],
];

async function drawList(root, name, which) {
  let d;
  try { d = await api.get(`/users/${enc(name)}/${which}`); } catch (e) {
    if (e.status !== 403) throw e;
    root.append(pageTitle(`${poss(name)} ${which}`, h('a', { class: 'btn98', href: userPath(name), text: '← back to their page' })),
      h('div', { class: 'ms-privatecard' }, h('div', { class: 'ms-privatelock', text: '🔒' }),
        h('div', null, h('b', { text: 'this profile is private — follow to see their posts.' }), h('p', { text: `the lists are for ${poss(name)} followers only.` }))));
    return;
  }
  const u = d.user;
  const [, label, none] = LISTS.find(l => l[0] === which);
  root.append(pageTitle(`${poss(u.name)} ${label.toLowerCase()} (${d.people.length})`, h('a', { class: 'btn98', href: userPath(u.name), text: '← back to their page' })));
  root.append(h('nav', { class: 'os-tabs2 ms-listtabs', 'aria-label': 'lists' }, LISTS.map(([key, text]) =>
    h('a', { class: key === which ? 'on' : '', href: `${userPath(u.name)}/${key}`, 'aria-current': key === which ? 'page' : null, text }))));
  if (!d.people.length) root.append(h('div', { class: 'ms-empty', text: none(u.name) }));
  root.append(h('div', { class: 'ms-browsegrid' }, d.people.map(personCard)));
  if (d.people.length >= 500) root.append(h('div', { class: 'ms-empty', text: 'showing the newest 500.' }));
}

export const renderFollowers = (root, name) => drawList(root, name, 'followers');
export const renderFollowing = (root, name) => drawList(root, name, 'following');
export const renderFriends = (root, name) => drawList(root, name, 'friends');
