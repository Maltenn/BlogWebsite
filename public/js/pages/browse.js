/* pages/browse.js — Browse: For you (a small, explainable discovery stream), Mutuals, Boards for you, and Search people.
   Every suggestion says why it's here; nothing about how you scroll is recorded. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops, pageTitle, paged, errorCard } from '../core/ui.js';
import { go } from '../core/router.js';
import { S } from '../core/state.js';
import { personCard } from '../widgets/people.js';
import { discoveryCard } from '../widgets/discovery.js';
import { suggestedPerson, suggestedBoard } from '../widgets/suggestions.js';

const TABS = [['foryou', 'For you'], ['mutuals', 'Mutuals'], ['boards', 'Boards for you'], ['search', 'Search people']];

export async function renderBrowse(root) {
  const params = new URLSearchParams(location.search);
  const q = params.get('q') || '';
  let tab = q ? 'search' : params.get('tab');
  if (!TABS.some(([k]) => k === tab)) tab = 'foryou';
  root.append(pageTitle('Browse'));
  root.append(h('nav', { class: 'ms-feedbar ms-modebar ms-browsetabs', 'aria-label': 'browse' },
    TABS.map(([k, label]) => h('a', { class: 'btn98' + (k === tab ? ' on' : ''), href: k === 'foryou' ? '/browse' : '/browse?tab=' + k,
      'aria-current': k === tab ? 'page' : null, text: label }))));
  const box = h('div', { class: 'ms-feedbox ms-browsebox' });
  root.append(box);
  try {
    if (tab === 'foryou') await forYou(box);
    else if (tab === 'mutuals') await mutuals(box);
    else if (tab === 'boards') await boards(box);
    else await search(box, q);
  } catch (e) { box.append(errorCard(e)); }
}

const note = (...kids) => h('div', { class: 'ms-note ms-browsenote' }, kids);

async function forYou(box) {
  box.append(note('Picks from people and boards you don\'t follow yet. Every one says why it\'s here. We don\'t track how you scroll.'));
  await paged(box, cur => api.get('/browse/discover' + (cur ? '?before=' + enc(cur) : '')).then(r => ({ items: r.items, next: r.next })), discoveryCard,
    'nothing to suggest right now. check back later!');
}

async function mutuals(box) {
  if (!S.me) {
    const r = await api.get('/browse/mutuals');
    box.append(h('div', { class: 'ms-emptycta' }, h('div', { text: r.prompt || 'log in to see friends of your friends.' }),
      h('a', { class: 'btn98 go', href: '/login?next=' + enc('/browse?tab=mutuals'), text: 'log in' }), h('a', { class: 'btn98', href: '/join', text: '★ make your page' })));
    return;
  }
  box.append(note('Friends of your friends, with who you have in common. Friends are people who follow each other.'));
  await paged(box, cur => api.get('/browse/mutuals' + (cur ? '?before=' + enc(cur) : '')).then(r => ({ items: r.people, next: r.next })),
    p => suggestedPerson(p, { hide: true }), 'no mutuals yet. make some friends and their friends show up here.');
}

async function boards(box) {
  const r = await api.get('/browse/boards?limit=10');
  if (S.me && !r.hasInterests) {
    box.append(note('Tell us what you like (music, movies, books…) and we\'ll point you to boards for it. ',
      h('a', { href: '/edit', text: 'Fill in your interests on Edit My Page' }), '.'));
  }
  if (!r.boards.length) { box.append(h('div', { class: 'ms-empty', text: 'no boards to suggest yet.' })); return; }
  box.append(...r.boards.map(b => suggestedBoard(b, { hide: !!S.me })));
}

async function search(box, q) {
  const input = h('input', { value: q, placeholder: 'search by screen name', maxLength: 30, 'aria-label': 'search' });
  box.append(h('form', { class: 'ms-filterbar', onsubmit: e => { e.preventDefault(); go('/browse?tab=search' + (input.value.trim() ? '&q=' + enc(input.value.trim()) : ''), true); } },
    input, h('button', { class: 'btn98', type: 'submit', text: 'Search' }), q ? h('a', { class: 'btn98', href: '/browse?tab=search', text: 'clear' }) : null));
  const grid = h('div', { class: 'ms-browsegrid' });
  box.append(grid);
  const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'show more ▾' });
  let page = 0;
  const load = async () => {
    const r = await api.get(`/users?page=${page}${q ? '&q=' + enc(q) : ''}`);
    r.users.forEach(u => grid.append(personCard(u)));
    if (!grid.children.length) grid.append(h('div', { class: 'ms-empty', text: q ? 'nobody matches that.' : 'nobody here yet. invite someone!' }));
    more.hidden = !r.more;
    page++;
  };
  more.addEventListener('click', () => load().catch(oops));
  box.append(more);
  await load();
}
