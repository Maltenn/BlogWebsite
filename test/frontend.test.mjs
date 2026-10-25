// Front-end tests: `npm test`. The page code in public/js, run under node on a pretend browser (helpers/fake-dom.mjs)
// with the API answered by the test, for the rules the pages keep themselves: what a card says about the post it
// answers or quotes, a deleted blog post's page, the like / repost / bookmark row putting back a failed change, links in
// Friends' Comments, and "ago".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, answer } from './helpers/fake-dom.mjs';

const dom = installDom();
// (imported after the pretend browser is in place)
const { ago } = await import('../public/js/core/format.js');
const { S } = await import('../public/js/core/state.js');
const { rich } = await import('../public/js/widgets/richtext.js');
const { reactionRow } = await import('../public/js/widgets/reactions.js');
const { postCard } = await import('../public/js/widgets/postcard.js');
const { renderBlogPost } = await import('../public/js/pages/blog.js');
const { renderProfileComments } = await import('../public/js/pages/profile.js');

const kat = { id: 2, name: 'kat', avatar: '/assets/avatars/preset_01.png' };
const pal = { id: 3, name: 'pal', avatar: '/assets/avatars/preset_02.png' };
const ME = { id: 1, name: 'me', avatar: '/assets/avatars/preset_03.png', isAdmin: false };
const NONE = { likes: 0, replies: 0, reposts: 0, quotes: 0 };
// an item as the API sends it
const item = more => ({
  id: 9, kind: 'status', created: Date.now() - 60000, subject: null, subtitle: null, body: 'hello', excerpt: false, mood: null,
  author: pal, canDelete: false, replyTo: null, rootId: null, quoted: null, counts: NONE,
  viewer: { liked: false, reposted: false, bookmarked: false }, mentions: [], tags: [], deleted: false, ...more,
});
// answers GET/POST… paths (without /api) from a table; anything else is a 404
const serve = table => (method, path) => {
  const hit = table[`${method} ${path}`];
  return hit === undefined ? answer(404, { error: 'not here' }) : typeof hit === 'function' ? hit() : answer(200, hit);
};

test('"ago": "1 hour ago" and "1 day ago" for one, plurals for more', () => {
  const now = Date.now();
  assert.equal(ago(now - 30000), 'just now');
  assert.equal(ago(now - 5 * 60000), '5 minutes ago');
  assert.equal(ago(now - 3600000), '1 hour ago');
  assert.equal(ago(now - 2 * 3600000), '2 hours ago');
  assert.equal(ago(now - 86400000), '1 day ago');
  assert.equal(ago(now - 3 * 86400000), '3 days ago');
});

test('"Replying to": the person when you may see the post, else "a deleted account" or "a post you can\'t see"', () => {
  S.me = null;
  const said = replyTo => postCard(item({ kind: 'reply', rootId: 5, replyTo })).querySelector('.ms-replyto').textContent;
  assert.equal(said({ id: 5, author: kat }), 'Replying to @kat');
  assert.equal(said({ id: 5, author: null }), 'Replying to a deleted account');
  assert.equal(said({ id: null, author: null }), 'Replying to a post you can\'t see');
  assert.equal(postCard(item({ kind: 'reply', rootId: 5, replyTo: { id: null, author: null } }), { directTo: undefined }).querySelectorAll('.ms-replyto').length, 1);
});

test('a quote or repost of a deleted post says it was deleted; of one you can\'t see, that it\'s unavailable', () => {
  S.me = null;
  const tomb = { id: 5, kind: 'status', created: 1, subject: null, subtitle: null, body: '', author: kat, deleted: true };
  const box = quoted => postCard(item({ kind: 'quote', body: 'look', quoted })).querySelector('.ms-quotebox').textContent;
  assert.equal(box(tomb), 'this post was deleted.');
  assert.equal(box({ unavailable: true }), 'this post is unavailable.');
  assert.equal(box({ ...tomb, body: 'words', deleted: false }).includes('words'), true);
  const repost = quoted => postCard(item({ kind: 'repost', body: '', quoted })).textContent;
  assert.match(repost(item({ id: 5, author: kat, body: '', deleted: true })), /this post was deleted\./);
  assert.match(repost({ unavailable: true }), /this post is unavailable\./);
});

test('a failed like puts back only the like, not a bookmark that went through meanwhile', async () => {
  S.me = ME;
  let failLike;
  dom.onFetch = serve({
    'POST /posts/7/like': () => new Promise(res => { failLike = () => res(answer(500, { error: 'the server tripped' })); }),
    'POST /posts/7/bookmark': { bookmarked: true },
  });
  const row = reactionRow(item({ id: 7, counts: { ...NONE, likes: 4 } }));
  const like = row.querySelector('button.like'), mark = row.querySelector('button.bookmark');
  like.click();
  assert.deepEqual([like.classList.contains('on'), like.textContent], [true, '♥5'], 'liked at once');
  mark.click();
  await dom.settle();
  assert.equal(mark.classList.contains('on'), true, 'bookmarked');
  failLike();
  await dom.settle();
  assert.deepEqual([like.classList.contains('on'), like.textContent], [false, '♥4'], 'the like is put back');
  assert.equal(mark.classList.contains('on'), true, 'the bookmark stays');
  assert.match(document.querySelector('#toasts').textContent, /the server tripped/);
});

test('undoing a like of a post you can\'t see any more keeps the row\'s own count (the answer has none)', async () => {
  S.me = ME;
  dom.onFetch = serve({ 'DELETE /posts/8/like': { liked: false } });
  const row = reactionRow(item({ id: 8, counts: { ...NONE, likes: 3 }, viewer: { liked: true, reposted: false, bookmarked: false } }));
  const like = row.querySelector('button.like');
  like.click();
  await dom.settle();
  assert.deepEqual([like.classList.contains('on'), like.textContent], [false, '♥2']);
});

test('a deleted blog post\'s page is a tombstone: "this post was deleted.", its Discussion, nothing to act on', async () => {
  S.me = ME;
  const post = item({ id: 20, kind: 'blog', body: '', author: kat, deleted: true, counts: { ...NONE, replies: 1 } });
  const reply = item({ id: 21, kind: 'reply', body: 'a blog reply', replyTo: { id: 20, author: kat }, rootId: 20 });
  dom.onFetch = serve({
    'GET /posts/20': { post, ancestors: [], replies: [reply], next: null },
    'GET /users/kat': { user: kat, profile: { theme: { bg: '#fff', fg: '#000', accent: '#69c' } }, relation: null, private: false, canSeePosts: true },
    'GET /users/kat/blog': { user: kat, entries: [] },
  });
  const root = document.createElement('main');
  await renderBlogPost(root, 'kat', '20');
  const head = root.querySelector('.post-head');
  assert.equal(head.querySelector('h1').textContent, 'this post was deleted.');
  assert.deepEqual([root.querySelectorAll('.post-reactions').length, root.querySelectorAll('.post-foot').length], [0, 0], 'no action row, no delete or report');
  const discussion = root.querySelector('.ms-discussion');
  assert.deepEqual(discussion.querySelectorAll('.ms-feeditem').map(c => Number(c.dataset.id)), [21], 'the replies stay');
  assert.match(discussion.textContent, /nothing to reply to/);
});

test('Friends\' Comments link their @mentions but not #tags (the server doesn\'t keep a comment\'s tags)', async () => {
  S.me = null;
  const mentions = [{ id: 2, name: 'kat' }];
  const links = nodes => { const box = document.createElement('div'); box.append(...nodes); return box.querySelectorAll('a').map(a => [a.textContent, a.getAttribute('href')]); };
  assert.deepEqual(links(rich('hi @kat, #glitter forever', mentions)), [['@kat', '/u/kat'], ['#glitter', '/tags/glitter']], 'a post links both');
  assert.deepEqual(links(rich('hi @kat, #glitter forever', mentions, { tags: false })), [['@kat', '/u/kat']]);

  const counts = { followers: 0, following: 0, friends: 0, statuses: 0, replies: 0, blog: 0, comments: 1 };
  dom.onFetch = serve({
    'GET /users/pal': { user: { ...pal, online: false, lastSeen: null, joined: 1, banned: false }, profile: { theme: { bg: '#fff', fg: '#000', accent: '#69c' } },
      age: null, sign: null, spotify: null, counts, top8: [], private: false, canSeePosts: true, latestStatus: null, blog: [], self: false, relation: null },
    'GET /users/pal/comments?page=1': { comments: [{ id: 30, body: 'hi @kat, #glitter forever', created: 1, author: kat, mentions, canDelete: false }], total: 1, page: 1, pages: 1 },
  });
  const root = document.createElement('main');
  await renderProfileComments(root, 'pal');
  const body = root.querySelector('.ms-comment-body');
  assert.equal(body.textContent, 'hi @kat, #glitter forever');
  assert.deepEqual(body.querySelectorAll('a').map(a => a.textContent), ['@kat']);
});
