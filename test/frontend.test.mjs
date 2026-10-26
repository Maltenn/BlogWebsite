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

/* ---- boards (phase 3): votes and nested comments ---- */
const { voteBar } = await import('../public/js/widgets/votes.js');
const { commentTree } = await import('../public/js/widgets/comments.js');

const BOARD = { slug: 'cooking', name: 'Cooking', icon: '🍳' };
const VOTES = { up: 2, down: 1, comments: 0 };
// a thread or comment as the API sends it
const threadItem = more => ({ ...item({ id: 50, kind: 'thread', subject: 'grilled cheese', author: kat }), board: BOARD, sticky: false, locked: false, counts: { up: 0, down: 0, comments: 4 }, viewer: { vote: 0 }, ...more });
const commentItem = (id, body, more) => ({ ...item({ id, kind: 'comment', body, author: pal, rootId: 50 }), board: BOARD, counts: VOTES, viewer: { vote: 0 }, ...more });
const node = (id, body, children = []) => ({ item: commentItem(id, body), children });

test('votes: ▲ ▼ change at once, switching moves one count to the other, and a refused vote puts the numbers back', async () => {
  S.me = ME;
  const calls = [];
  let answerWith = null;
  dom.onFetch = (method, path, body) => { calls.push([method, path, body]); return answerWith(); };
  const bar = voteBar(commentItem(9, 'hi'));
  const [up, down] = bar.querySelectorAll('button');
  assert.deepEqual([up.textContent, down.textContent], ['▲2', '▼1']);

  answerWith = () => answer(200, { vote: 1, up: 3, down: 1 });
  up.click();
  assert.deepEqual([up.textContent, up.classList.contains('on'), up.getAttribute('aria-pressed')], ['▲3', true, 'true'], 'liked at once');
  await dom.settle();
  assert.deepEqual(calls.at(-1), ['PUT', '/posts/9/vote', { value: 1 }]);

  answerWith = () => answer(200, { vote: -1, up: 2, down: 2 });
  down.click();
  assert.deepEqual([up.textContent, down.textContent, down.classList.contains('on')], ['▲2', '▼2', true], 'switching: one goes down, the other up');
  await dom.settle();
  assert.deepEqual(calls.at(-1)[2], { value: -1 });

  answerWith = () => answer(200, { vote: 0, up: 2, down: 1 });
  down.click();                                                      // your current vote again takes it back
  await dom.settle();
  assert.deepEqual(calls.at(-1)[2], { value: 0 });
  assert.deepEqual([up.textContent, down.textContent, up.classList.contains('on'), down.classList.contains('on')], ['▲2', '▼1', false, false]);

  answerWith = () => answer(403, { error: 'this thread is locked.' });
  up.click();
  assert.equal(up.textContent, '▲3');
  await dom.settle();
  assert.deepEqual([up.textContent, up.classList.contains('on')], ['▲2', false], 'refused: only the vote goes back');
  assert.match(document.querySelector('#toasts').textContent, /this thread is locked\./);
});

test('votes: no asking the server about your own post or a locked thread; logged out they ask you to log in', async () => {
  const calls = [];
  dom.onFetch = (method, path) => { calls.push(path); return answer(200, { vote: 1, up: 3, down: 1 }); };
  S.me = ME;
  voteBar(commentItem(9, 'mine', { author: ME })).querySelector('button').click();
  voteBar(commentItem(9, 'locked'), { locked: true }).querySelector('button').click();
  await dom.settle();
  assert.deepEqual(calls, [], 'no request');
  assert.match(document.querySelector('#toasts').textContent, /you can't vote on your own post/);
  assert.match(document.querySelector('#toasts').textContent, /locked: no more votes here/);
});

test('comment tree: the depth cap hides what is under it behind "Continue this thread →", [−] folds to [+n], and a deleted one is [deleted]', async () => {
  S.me = ME;
  const tomb = { item: commentItem(12, '', { deleted: true, body: '' }), children: [node(13, 'deep one', [node(14, 'too deep to show')])] };
  const tree = commentTree(threadItem(), [{ item: commentItem(11, 'first @kat', { mentions: [{ id: 2, name: 'kat' }] }), children: [tomb] }], { max: 3 });
  const shown = tree.el.querySelectorAll('.bc-comment').map(e => Number(e.dataset.id));
  assert.deepEqual(shown, [11, 12, 13], 'three levels, not the fourth');
  const link = tree.el.querySelector('a.bc-continue');
  assert.deepEqual([link.textContent, link.getAttribute('href')], ['Continue this thread →', '/boards/cooking/50?c=13']);
  const gone = tree.el.querySelectorAll('.bc-comment')[1];
  assert.match(gone.querySelector('.bc-head').textContent, /\[deleted\]/);
  assert.equal(gone.querySelectorAll('.bv').length, 1, 'a [deleted] comment has no vote buttons of its own (only the reply under it has)');
  assert.deepEqual(tree.el.querySelector('a.ms-mention').getAttribute('href'), '/u/kat', 'comments link @mentions');

  const first = tree.el.querySelector('.bc-comment');
  const toggle = first.querySelector('button.bc-toggle');
  assert.equal(toggle.textContent, '[−]');
  toggle.click();
  assert.deepEqual([first.classList.contains('is-folded'), toggle.textContent], [true, '[+2]'], 'folded, with what is under it counted');
  toggle.click();
  assert.deepEqual([first.classList.contains('is-folded'), toggle.textContent], [false, '[−]']);
});

test('comment tree: "Load more replies (n)" asks for the rest and puts it where the button was; a locked thread has no Reply', async () => {
  S.me = ME;
  const asked = [];
  dom.onFetch = (method, path) => { asked.push(path); return answer(200, { parent: null, sort: 'best', comments: [node(21, 'more a'), node(22, 'more b')] }); };
  const tree = commentTree(threadItem(), [node(20, 'first'), { more: 2, parent: 50, after: '0.5:1700000000000:20' }]);
  const button = tree.el.querySelector('button.bc-more');
  assert.equal(button.textContent, 'Load more replies (2)');
  button.click();
  await dom.settle();
  assert.deepEqual(asked, ['/threads/50/comments/50?sort=best&after=0.5%3A1700000000000%3A20'], 'with the stub\'s cursor');
  assert.deepEqual(tree.el.querySelectorAll('.bc-comment').map(e => Number(e.dataset.id)), [20, 21, 22]);
  assert.equal(tree.el.querySelectorAll('button.bc-more').length, 0, 'the button is gone');
  assert.equal(tree.el.querySelectorAll('a.bc-replylink').length, 3, 'Reply under each');
  const locked = commentTree(threadItem({ locked: true }), [node(30, 'x')]);
  assert.equal(locked.el.querySelectorAll('a.bc-replylink').length, 0, 'locked: no Reply');
});

test('comment tree: a "load more" answer never draws a comment that is already on the page, and a stub without a cursor starts from the first', async () => {
  S.me = ME;
  const asked = [];
  dom.onFetch = (method, path) => { asked.push(path); return answer(200, { parent: null, sort: 'new', comments: [node(41, 'mine, already shown'), node(40, 'shown'), node(43, 'new to the page')] }); };
  const tree = commentTree(threadItem(), [node(41, 'mine'), node(40, 'first'), node(42, 'second', [{ more: 3, parent: 42, after: null }])], { sort: 'new' });
  tree.el.querySelector('button.bc-more').click();
  await dom.settle();
  assert.deepEqual(asked, ['/threads/50/comments/42?sort=new']);
  assert.deepEqual(tree.el.querySelectorAll('.bc-comment').map(e => Number(e.dataset.id)), [41, 40, 42, 43], 'each comment once');
});

test('an archived board\'s thread: no comment box, no Reply, and its votes say the board is archived', async () => {
  S.me = ME;
  const ARCHIVED = { ...BOARD, archived: true };
  const tree = commentTree(threadItem({ board: ARCHIVED }), [node(60, 'x', [node(61, 'y')])]);
  assert.equal(tree.el.querySelectorAll('a.bc-replylink').length, 0, 'no Reply');
  const calls = [];
  dom.onFetch = (method, path) => { calls.push(path); return answer(200, {}); };
  tree.el.querySelector('button.bv-btn').click();
  await dom.settle();
  assert.deepEqual(calls, [], 'no request');
  assert.match(document.querySelector('#toasts').textContent, /this board is archived: no more votes here/);

  const { renderBoardThread } = await import('../public/js/pages/thread.js');
  dom.onFetch = serve({ 'GET /threads/50?sort=best': { thread: threadItem({ board: ARCHIVED }), sort: 'best', comments: [node(60, 'x')] } });
  const root = document.createElement('main');
  await renderBoardThread(root, 'cooking', '50');
  assert.deepEqual([root.querySelectorAll('textarea').length, root.querySelectorAll('form').length, root.querySelectorAll('a.bc-replylink').length], [0, 0, 0], 'no comment box, no Reply');
  assert.match(root.querySelector('.bt-locked').textContent, /this board is archived/);
  const open = document.createElement('main');
  dom.onFetch = serve({ 'GET /threads/50?sort=best': { thread: threadItem(), sort: 'best', comments: [node(60, 'x')] } });
  await renderBoardThread(open, 'cooking', '50');
  assert.deepEqual([open.querySelectorAll('textarea').length, open.querySelectorAll('a.bc-replylink').length], [1, 1], 'an open board has both');
});

test('a thread on a #tag page is a card that leads to the thread: board, title, words and ▲ ▼ 💬 to read, no like / repost / bookmark row', () => {
  S.me = ME;
  const card = postCard(threadItem({ body: 'with #cheese and @kat', mentions: [{ id: 2, name: 'kat' }], counts: { up: 3, down: 1, comments: 7 } }));
  const links = card.querySelectorAll('a').map(a => [a.textContent, a.getAttribute('href')]);
  assert.ok(links.some(([t, href]) => t === '🍳 Cooking' && href === '/boards/cooking'), 'the board chip');
  assert.ok(links.some(([t, href]) => t === 'grilled cheese' && href === '/boards/cooking/50'), 'the title');
  assert.equal(card.querySelector('a.pc-threadstats').getAttribute('href'), '/boards/cooking/50');
  assert.equal(card.querySelector('a.pc-threadstats').textContent, '▲ 3▼ 1💬 7');
  assert.equal(card.querySelector('a.ms-time').getAttribute('href'), '/boards/cooking/50', 'the time too');
  assert.ok(!links.some(([, href]) => href && href.includes('/post/')), 'nothing points at a status page');
  assert.deepEqual([card.querySelectorAll('button.ms-act').length, card.querySelectorAll('.bv').length], [0, 0], 'nothing to press');
  assert.match(card.querySelector('.ms-feedtext').textContent, /with #cheese and @kat/);
});

test('the board request form suggests the slug the server would make (never ending in a dash)', async () => {
  const { slugOf } = await import('../public/js/widgets/boardrequests.js');
  assert.equal(slugOf('Pixel Art & Sprites'), 'pixel-art-sprites');
  assert.equal(slugOf('abcdefghij abcdefghij abcdefg xyz'), 'abcdefghij-abcdefghij-abcdefg', 'cut at 30, then the dash goes (api.test.mjs: the server agrees)');
});
