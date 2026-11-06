/* widgets/suggestions.js — suggested people (Mutuals, and "Who to follow" in the Feed's sidebar) and suggested boards
   (Boards for you). Every one says why. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { avatar, nameLink } from './people.js';
import { followButton } from './followbutton.js';
import { hideButton } from './hide.js';
import { boardPath } from './boardlinks.js';

// "kat, pete and 2 others" with the names linked
function inCommon(m) {
  const names = [];
  m.people.forEach((p, i) => {
    if (i) names.push(i === m.people.length - 1 && m.count === m.people.length ? ' and ' : ', ');
    names.push(nameLink(p));
  });
  const rest = m.count - m.people.length;
  if (rest > 0) names.push(` and ${rest} other${rest === 1 ? '' : 's'}`);
  return names;
}

// one person: picture, name, why (the friends you share, or the reason), Follow, ✕. A private page shows name + picture only.
// opts.small: the sidebar's row. opts.hide: add the ✕.
export function suggestedPerson(p, opts = {}) {
  const row = h('div', { class: 'ms-suggest' + (opts.small ? ' is-small' : '') });
  const why = h('div', { class: 'ms-suggestwhy' });
  if (p.mutual && p.mutual.people.length) {
    why.append('👥 friends with ', ...inCommon(p.mutual));
    if (p.relation && p.relation.followsMe) why.append(' · follows you');
  } else why.append(p.why);
  row.append(avatar(p.user, opts.small ? 32 : 48),
    h('div', { class: 'ms-suggestmid' }, nameLink(p.user), p.private ? h('span', { class: 'ms-chip', text: '🔒 private' }) : null, why),
    h('div', { class: 'ms-suggestbtns' }, followButton(p.user, p.relation, { isPrivate: p.private }), opts.hide ? hideButton('person', p.user.id, row) : null));
  return row;
}

// "Who to follow" for the Feed's sidebar
export function whoToFollowBox() {
  const body = h('div', { class: 'ms-whobody' });
  const box = h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle' }, '👋 Who to follow ', h('a', { href: '/browse?tab=mutuals', text: 'more' })), body);
  api.get('/browse/people?limit=3').then(r => {
    if (!r.people.length) { box.remove(); return; }
    body.replaceChildren(...r.people.map(p => suggestedPerson(p, { small: true, hide: true })));
  }).catch(() => box.remove());
  return box;
}

// the matched words of the reason shown as marks
function marked(text, terms) {
  const low = text.toLowerCase();
  const spans = [];
  for (const { term } of terms || []) {
    const at = low.indexOf(term.toLowerCase());
    if (at >= 0) spans.push([at, at + term.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue;
    out.push(text.slice(pos, s), h('mark', { class: 'ms-hl', text: text.slice(s, e) }));
    pos = e;
  }
  out.push(text.slice(pos));
  return out;
}

// one suggested board: icon, name, description, the reason, how many posted this week, View board
export function suggestedBoard(s, opts = {}) {
  const b = s.board;
  const row = h('div', { class: 'ms-suggest ms-boardrow' });
  row.append(h('div', { class: 'ms-boardicon', 'aria-hidden': 'true', text: b.icon }),
    h('div', { class: 'ms-suggestmid' },
      h('a', { class: 'ms-name-link', href: boardPath(b.slug), text: b.name }),
      h('div', { class: 'ms-boarddesc', text: b.description }),
      h('div', { class: 'ms-suggestwhy' }, ...marked(s.why, s.terms)),
      s.because === 'interests' ? h('div', { class: 'ms-boardposters', text: `${s.posters} ${s.posters === 1 ? 'member' : 'members'} posting this week` }) : null),
    h('div', { class: 'ms-suggestbtns' }, h('a', { class: 'btn98 go', href: boardPath(b.slug), text: 'View board' }),
      opts.hide ? hideButton('board', b.slug, row) : null));
  return row;
}
