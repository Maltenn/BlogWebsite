/* pages/blog.js — one blog post on its own page: a narrow reading column, title, subtitle, who wrote it and when, then the
   post's 💬 ↻ ♥ 🔖 row and its Discussion (replies, with a reply box). A deleted post that has replies is a tombstone:
   "this post was deleted." and its Discussion, nothing to act on. */

import { h, enc, userPath, poss } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, readTime } from '../core/format.js';
import { toast, pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';
import { go, route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { postActions } from '../widgets/safety.js';
import { followButton } from '../widgets/followbutton.js';
import { privateCard } from '../widgets/privatecard.js';
import { blogBody } from '../widgets/blogtext.js';
import { blogPath, postPath } from '../widgets/postlinks.js';
import { rich } from '../widgets/richtext.js';
import { reactionRow } from '../widgets/reactions.js';
import { repliesBlock } from '../widgets/replies.js';
import { photoGrid } from '../widgets/photogrid.js';

export async function renderBlogPost(root, name, idText) {
  const id = Number(idText);
  // the post, the writer's page (for the Follow button and their color) and their other posts (for Older / Newer) at once
  const [mine, who, others] = await Promise.allSettled([api.get('/posts/' + id), api.get('/users/' + enc(name)), api.get(`/users/${enc(name)}/blog`)]);
  if (mine.status === 'rejected') {
    if (mine.reason.status === 404) {                                        // missing, or a private writer's post (the API says the same for both)
      const u = who.status === 'fulfilled' ? who.value : null;
      if (u && u.private && !u.canSeePosts) {                                // the private card is for the page in the URL, and only when that page says so
        root.append(pageTitle(`${poss(u.user.name)} Blog`, h('a', { class: 'btn98', href: userPath(u.user.name), text: '← their page' })),
          privateCard(u.user, u.relation, { onChange: () => route() }));
        return;
      }
      root.append(pageTitle(`${poss(name)} Blog`, h('a', { class: 'btn98', href: userPath(name) + '/blog', text: '← all posts' })),
        h('div', { class: 'ms-error', text: mine.reason.message }));
      return;
    }
    throw mine.reason;
  }
  const post = mine.value.post;
  const a = post.author;
  if (post.kind !== 'blog') { go(postPath(post), true); return; }            // a status, reply or quote has a conversation instead
  if (a.name !== name) { go(blogPath(a.name, post.id), true); return; }      // the post's own address is under its writer's name
  const d = who.status === 'fulfilled' ? who.value : null;
  const entries = others.status === 'fulfilled' ? others.value.entries : [];
  const at = entries.findIndex(e => e.id === post.id);
  const newer = at > 0 ? entries[at - 1] : null, older = at >= 0 ? entries[at + 1] : null;

  root.append(pageTitle(`${poss(a.name)} Blog`, h('a', { class: 'btn98', href: userPath(a.name) + '/blog', text: '← all posts' })));
  const page = h('article', { class: 'ms-postpage' });
  if (d && d.profile.theme) page.style.setProperty('--ms-accent', d.profile.theme.accent);
  const discussion = replies => h('section', { class: 'post ms-discussion', id: 'discussion' }, h('h2', { text: 'Discussion' }), replies.el);

  if (post.deleted) {                                                        // a tombstone: the words are gone, the Discussion stays
    page.append(h('div', { class: 'post' },
      h('div', { class: 'post-head' }, h('h1', { class: 'ms-gone', text: 'this post was deleted.' }),
        h('div', { class: 'post-by' }, avatar(a, 32), nameLink(a), h('span', { class: 'post-meta', text: when(post.created) })))),
    discussion(repliesBlock(post, mine.value, { direct: true })));
    root.append(page);
    return;
  }

  const by = h('div', { class: 'post-by' }, avatar(a, 32), nameLink(a));
  if (S.me && S.me.id !== a.id && d) by.append(followButton(a, d.relation, { isPrivate: d.private }));
  by.append(h('span', { class: 'post-meta', text: [when(post.created), readTime(post.body), post.mood ? `feeling ${post.mood}` : ''].filter(Boolean).join(' · ') }));

  const nav = (label, e, cls) => (e ? h('a', { class: 'btn98 ' + cls, href: blogPath(a.name, e.id), title: e.subject, text: `${label}: “${e.subject.length > 28 ? e.subject.slice(0, 27) + '…' : e.subject}”` }) : h('span'));
  const foot = h('div', { class: 'post-foot' },
    older || newer ? h('div', { class: 'post-nav' }, nav('← Older', older, 'older'), nav('Newer →', newer, 'newer')) : null,
    h('a', { href: '#', text: 'copy link', onclick: async ev => {
      ev.preventDefault();
      try { await navigator.clipboard.writeText(location.href); toast('link copied.'); } catch { toast(location.href); }
    } }),
    postActions(post, r => (r.tombstone ? route() : go(userPath(a.name) + '/blog'))));   // with replies or quotes it stays, as a tombstone

  const reactions = reactionRow(post, { onReply: () => replies.focus() });
  const replies = repliesBlock(post, mine.value, { direct: true, onCount: n => reactions.bump('replies', n) });
  page.append(h('div', { class: 'post' },
    h('div', { class: 'post-head' },
      h('h1', null, rich(post.subject, post.mentions)),
      post.subtitle ? h('div', { class: 'post-sub', text: post.subtitle }) : null,
      by),
    post.cover ? photoGrid([post.cover], { cover: true }) : null,
    blogBody(post.body, post.mentions),
    h('div', { class: 'post-reactions' }, reactions),
    foot),
  discussion(replies));
  root.append(page);
}
