/* widgets/blogindex.js — the Blog tab of a profile: the write form (on your own page) and the index of posts, newest
   first under month headings, each linking to the post's own page. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { monthLabel, shortDate } from '../core/format.js';
import { toast, oops } from '../core/ui.js';
import { postActions } from './safety.js';
import { blogBody, teaser } from './blogtext.js';
import { blogPath } from './postcard.js';

const BODY_MAX = 20000;

// the write form: title, subtitle, mood, body (with a preview). opts.onPosted(id) after publishing.
function writer(opts) {
  const title = h('input', { class: 'os-input', maxLength: 100, placeholder: 'title', 'aria-label': 'title' });
  const subtitle = h('input', { class: 'os-input', maxLength: 160, placeholder: 'subtitle (optional)', 'aria-label': 'subtitle' });
  const mood = h('input', { class: 'os-input', maxLength: 40, placeholder: 'current mood (optional)', 'aria-label': 'mood' });
  const body = h('textarea', { class: 'os-input ms-blogtext', maxLength: BODY_MAX, placeholder: 'start writing…', 'aria-label': 'post' });
  const count = h('span', { class: 'os-hint', text: `0/${BODY_MAX}` });
  const preview = h('div', { class: 'ms-blogpreview', hidden: true });
  const publish = h('button', { class: 'btn98 go', type: 'submit', text: 'Publish' });
  const peek = h('button', { class: 'btn98', type: 'button', text: '👁 Preview' });
  body.addEventListener('input', () => { count.textContent = `${body.value.length}/${BODY_MAX}`; if (!preview.hidden) paint(); });
  const paint = () => preview.replaceChildren(h('div', { class: 'ms-previewlabel', text: 'preview' }), title.value ? h('h3', { class: 'ms-previewtitle', text: title.value }) : null, blogBody(body.value));
  peek.addEventListener('click', () => {
    preview.hidden = !preview.hidden;
    peek.textContent = preview.hidden ? '👁 Preview' : '✎ Keep writing';
    body.hidden = !preview.hidden;
    if (!preview.hidden) paint();
  });
  const form = h('form', { class: 'ms-blogform', onsubmit: async e => {
    e.preventDefault();
    publish.disabled = true;
    try {
      const r = await api.post('/blog', { title: title.value, subtitle: subtitle.value, mood: mood.value, body: body.value });
      toast('published!');
      if (opts.onPosted) opts.onPosted(r.id);
    } catch (err) { oops(err); publish.disabled = false; }
  } },
  title, subtitle, h('div', { class: 'row' }, mood),
  body, preview,
  h('div', { class: 'ms-blogtips os-hint', text: 'blank line = new paragraph. ## heading · > quote · - list item · **bold** · *italic*' }),
  h('div', { class: 'ms-blogform-btns' }, publish, peek, count));
  return h('details', { class: 'ms-blogwriter' }, h('summary', { class: 'btn98 go', text: '✏ Write a post' }), form);
}

// box: where it goes. user: { name }. opts.self: it's your own blog. opts.onPosted(id) / opts.onDeleted().
export async function blogIndex(box, user, opts = {}) {
  const d = await api.get(`/users/${enc(user.name)}/blog`);
  if (opts.self) box.append(writer(opts));
  if (!d.entries.length) {
    box.append(h('div', { class: 'ms-empty', text: opts.self ? 'no posts yet. the first one is the hardest.' : 'no blog posts yet.' }));
    return;
  }
  let month = '';
  d.entries.forEach(b => {
    const m = monthLabel(b.created);
    if (m !== month) { month = m; box.append(h('div', { class: 'ms-month', text: m })); }
    const row = h('div', { class: 'ms-blogrow' },
      h('a', { class: 'ms-blogrow-title', href: blogPath(d.user.name, b.id), text: b.subject }),
      b.subtitle ? h('div', { class: 'ms-blogrow-sub', text: b.subtitle }) : null,
      h('div', { class: 'ms-blogrow-tease', text: teaser(b.body, 160) }),
      h('div', { class: 'ms-blogrow-meta' }, shortDate(b.created), b.mood ? ` · feeling ${b.mood}` : '',
        postActions(b, () => { row.remove(); if (opts.onDeleted) opts.onDeleted(); })));
    box.append(row);
  });
  if (d.entries.length >= 100) box.append(h('div', { class: 'ms-empty', text: 'showing the latest 100 posts.' }));
}
