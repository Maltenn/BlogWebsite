/* pages/tags.js — a #tag's page (/tags/ourspace): the posts that use it, newest first, "show more" for older ones. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { pageTitle, paged } from '../core/ui.js';
import { postCard } from '../widgets/postcard.js';

export async function renderTag(root, tag) {
  const url = cur => `/tags/${enc(tag)}${cur ? '?before=' + enc(cur) : ''}`;
  let first;
  try { first = await api.get(url(null)); } catch (e) {
    if (e.status !== 404) throw e;
    root.append(pageTitle('#' + tag), h('div', { class: 'ms-error', text: e.message }));
    return;
  }
  root.append(pageTitle('#' + first.tag, h('span', { class: 'ms-pagesub', text: 'posts with this tag' })));
  const list = h('div', { class: 'ms-feedbox' });
  root.append(h('div', { class: 'os-shell os-solo' }, h('div', { class: 'os-main' }, list)));
  await paged(list, cur => (cur ? api.get(url(cur)) : Promise.resolve(first)), item => postCard(item),
    'nothing here yet. write a post with #' + first.tag + ' in it and it shows up on this page.');
}
