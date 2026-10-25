/* pages/bookmarks.js — your bookmarks (/bookmarks): the posts you saved, newest bookmark first. Only you can see them. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { pageTitle, paged } from '../core/ui.js';
import { postCard } from '../widgets/postcard.js';

export async function renderBookmarks(root) {
  root.append(pageTitle('🔖 Bookmarks', h('span', { class: 'ms-pagesub', text: 'only you can see these' })));
  const list = h('div', { class: 'ms-feedbox' });
  root.append(h('div', { class: 'os-shell os-solo' }, h('div', { class: 'os-main' }, list)));
  await paged(list, cur => api.get('/me/bookmarks' + (cur ? '?before=' + enc(cur) : '')), item => postCard(item, { removeOnUnbookmark: true }),
    'nothing saved yet. tap the 🔖 under a post to keep it here.');
}
