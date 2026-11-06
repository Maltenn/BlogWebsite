/* pages/boards.js — the boards: the index (/boards: a phpBB-style table, and "request a board") and one board's thread list
   (/boards/cooking: Hot / New / Top / Best, sticky threads first, paged). The thread itself is pages/thread.js. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { ago, when } from '../core/format.js';
import { toast, oops, pageTitle, paged } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, needLogin, route } from '../core/router.js';
import { nameLink } from '../widgets/people.js';
import { boardPath, threadPath } from '../widgets/boardlinks.js';
import { threadDialog } from '../widgets/threaddialog.js';

const SORTS = [['hot', 'Hot'], ['new', 'New'], ['top', 'Top'], ['best', 'Best']];
const clip = (s, n) => { const a = Array.from(String(s)); return a.length > n ? a.slice(0, n).join('').trimEnd() + '…' : a.join(''); };

/* ---------------------------------------------------------------- the index */

export async function renderBoards(root) {
  const { boards } = await api.get('/boards');
  root.append(pageTitle('Boards', S.me ? h('a', { class: 'btn98', href: '#request', text: 'request a board', onclick: e => { e.preventDefault(); const d = document.querySelector('#board-request'); if (d) { d.open = true; d.scrollIntoView(); } } }) : null));
  root.append(h('div', { class: 'ms-note', text: 'pick a board, read its threads, start your own. everything you post in a board is public: everybody can read it, even if your page is private.' }));

  const table = h('div', { class: 'ms-section bi-table', role: 'table', 'aria-label': 'boards' },
    h('div', { class: 'ms-boxtitle bi-head', role: 'row' }, h('span', { text: 'Board' }), h('span', { class: 'bi-c-threads', text: 'Threads' }), h('span', { class: 'bi-c-last', text: 'Last post' })));
  for (const b of boards) {
    const last = b.lastPost;
    table.append(h('div', { class: 'bi-row', role: 'row' },
      h('div', { class: 'bi-icon', 'aria-hidden': 'true', text: b.icon }),
      h('div', { class: 'bi-main' }, h('a', { class: 'bi-name', href: boardPath(b.slug), text: b.name }), h('div', { class: 'bi-desc', text: b.description })),
      h('div', { class: 'bi-threads', title: `${b.threads} thread${b.threads === 1 ? '' : 's'}` }, h('b', { text: String(b.threads) }), h('span', { class: 'bi-lbl', text: b.threads === 1 ? ' thread' : ' threads' })),
      h('div', { class: 'bi-last' }, last
        ? [h('a', { class: 'bi-lastlink', href: threadPath(b.slug, last.thread.id), title: last.thread.subject, text: clip(last.thread.subject, 40) }),
          h('div', { class: 'ms-time' }, 'by ', nameLink(last.author), ' · ', h('span', { title: when(last.created), text: ago(last.created) }))]
        : h('span', { class: 'ms-time', text: 'no threads yet' }))));
  }
  if (!boards.length) table.append(h('div', { class: 'ms-empty', text: 'no boards yet.' }));
  root.append(table);

  if (S.me) root.append(requestForm());
  else root.append(h('div', { class: 'ms-note' }, h('a', { href: '/login?next=' + enc('/boards'), text: 'log in' }), ' (or ', h('a', { href: '/join', text: 'join' }), ') to start threads and ask for a new board.'));
}

// "Request a board": a name (40) and why (500); a moderator answers in your Notifications
function requestForm() {
  const name = h('input', { class: 'os-input', maxLength: 40, placeholder: 'board name, e.g. Gardening', 'aria-label': 'board name' });
  const reason = h('textarea', { class: 'os-input', maxLength: 500, placeholder: 'what would people talk about there?', 'aria-label': 'why this board' });
  return h('details', { class: 'os-panel', id: 'board-request' }, h('summary', { class: 'ms-boxtitle', text: '➕ request a board' }),
    h('form', { class: 'os-form', onsubmit: async e => {
      e.preventDefault();
      try {
        await api.post('/boards/requests', { name: name.value.trim(), reason: reason.value.trim() });
        toast('requested! a moderator will answer in your Notifications.');
        name.value = '';
        reason.value = '';
        e.target.closest('details').open = false;
      } catch (err) { oops(err); }
    } },
    h('p', { class: 'os-hint', text: 'boards are curated: a moderator reads each request. up to 3 a day.' }),
    h('label', null, 'name', name), h('label', null, 'why?', reason),
    h('div', null, h('button', { class: 'btn98 go', type: 'submit', text: 'Send request' }))));
}

/* ----------------------------------------------------------- one board */

// a thread's row: icons · title + starter + a line of the words · ▲ ▼ · comments · last post
function threadRow(t, slug) {
  const last = t.lastComment || { created: t.created, author: t.author };
  const icons = [t.sticky ? h('span', { title: 'pinned by a moderator', text: '📌' }) : null, t.locked ? h('span', { title: 'locked: no new comments', text: '🔒' }) : null];
  return h('div', { class: 'bb-row' + (t.sticky ? ' is-sticky' : ''), role: 'row', dataset: { id: t.id } },
    h('div', { class: 'bb-icon' }, t.sticky || t.locked ? icons : h('span', { 'aria-hidden': 'true', text: '💬' })),
    h('div', { class: 'bb-main' },
      h('a', { class: 'bb-title', href: threadPath(slug, t.id), text: t.subject }),
      h('div', { class: 'bb-by ms-time' }, 'started by ', nameLink(t.author), ' · ', h('span', { title: when(t.created), text: ago(t.created) })),
      t.excerpt ? h('div', { class: 'bb-excerpt', text: t.excerpt }) : null),
    h('div', { class: 'bb-stat bb-up', title: `${t.counts.up} like${t.counts.up === 1 ? '' : 's'}` }, '▲ ', h('b', { text: String(t.counts.up) })),
    h('div', { class: 'bb-stat bb-down', title: `${t.counts.down} dislike${t.counts.down === 1 ? '' : 's'}` }, '▼ ', h('b', { text: String(t.counts.down) })),
    h('div', { class: 'bb-stat bb-coms', title: `${t.counts.comments} comment${t.counts.comments === 1 ? '' : 's'}` }, '💬 ', h('b', { text: String(t.counts.comments) })),
    h('div', { class: 'bb-last' }, h('span', { title: when(last.created), text: ago(last.created) }), ' by ', nameLink(last.author)));
}

export async function renderBoard(root, slug) {
  const sort = SORTS.some(([k]) => k === new URLSearchParams(location.search).get('sort')) ? new URLSearchParams(location.search).get('sort') : 'hot';
  let first;
  try { first = await api.get(`/boards/${enc(slug)}?sort=${sort}`); } catch (e) {
    if (e.status !== 404) throw e;
    root.append(pageTitle('Boards', h('a', { class: 'btn98', href: '/boards', text: '← all boards' })), h('div', { class: 'ms-error', text: 'there is no board by that name.' }));
    return;
  }
  const board = first.board;
  const tools = [h('a', { class: 'btn98', href: '/boards', text: '← all boards' })];
  if (!board.archived) tools.push(h('button', { class: 'btn98 go', type: 'button', text: '✎ New thread', onclick: async () => {
    if (!S.me) { needLogin(); return; }
    const t = await threadDialog({ board });
    if (t) { toast('thread posted!'); go(threadPath(board.slug, t.id)); }
  } }));
  if (S.me && S.me.isAdmin) tools.push(h('button', { class: 'btn98', type: 'button', text: board.archived ? 'Unarchive' : 'Archive', title: 'moderators: archived boards leave the index and take nothing new', onclick: async () => {
    try { await api.post('/admin/boards/' + enc(board.slug), { archived: !board.archived }); toast(board.archived ? 'board is open again.' : 'board archived.'); route(); } catch (e) { oops(e); }
  } }));
  root.append(pageTitle(`${board.icon} ${board.name}`, ...tools));
  root.append(h('div', { class: 'ms-note' }, board.description || '', board.archived ? ' (archived: you can read it, but nothing new goes in.)' : ''));
  root.append(h('div', { class: 'ms-feedbar bb-sorts', role: 'group', 'aria-label': 'sort threads' },
    SORTS.map(([k, label]) => h('a', { class: 'btn98' + (k === sort ? ' on' : ''), href: `${boardPath(board.slug)}?sort=${k}`, 'aria-current': k === sort ? 'true' : null, text: label }))));

  const wrap = h('div', { class: 'bb-table', role: 'table', 'aria-label': board.name + ' threads' },
    h('div', { class: 'bb-head', role: 'row' }, h('span', { class: 'bb-h-main', text: 'Thread' }), h('span', { text: '▲' }), h('span', { text: '▼' }), h('span', { text: '💬' }), h('span', { class: 'bb-h-last', text: 'Last post' })));
  root.append(wrap);
  // the first page is already here; "show more" asks for the next with the cursor
  await paged(root, cur => (cur ? api.get(`/boards/${enc(board.slug)}?sort=${sort}&before=${enc(cur)}`) : Promise.resolve(first)),
    t => threadRow(t, board.slug), `no threads yet. ${board.archived ? '' : 'start the first one!'}`);
}
