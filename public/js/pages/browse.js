/* pages/browse.js — Browse: find people. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { oops, pageTitle } from '../core/ui.js';
import { go } from '../core/router.js';
import { personCard } from '../widgets/people.js';

export async function renderBrowse(root) {
  const q = new URLSearchParams(location.search).get('q') || '';
  root.append(pageTitle('Browse — find people'));
  const search = h('input', { value: q, placeholder: 'search by screen name', maxLength: 30, 'aria-label': 'search' });
  root.append(h('form', { class: 'ms-filterbar', onsubmit: e => { e.preventDefault(); go('/browse' + (search.value.trim() ? '?q=' + enc(search.value.trim()) : ''), true); } },
    search, h('button', { class: 'btn98', type: 'submit', text: 'Search' }), q ? h('a', { class: 'btn98', href: '/browse', text: 'clear' }) : null));
  const grid = h('div', { class: 'ms-browsegrid' });
  root.append(grid);
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
  root.append(more);
  await load();
}
