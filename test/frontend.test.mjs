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

test('a latest status that is only photos shows "📷 photo", not an empty box', async () => {
  S.me = null;
  const counts = { followers: 0, following: 0, friends: 0, statuses: 1, replies: 0, blog: 0, comments: 0 };
  const page = latestStatus => ({ user: { ...pal, online: false, lastSeen: null, joined: 1, banned: false }, profile: { theme: { bg: '#fff', fg: '#000', accent: '#69c' } },
    age: null, sign: null, spotify: null, counts, top8: [], private: false, canSeePosts: true, latestStatus, blog: [], self: false, relation: null });
  for (const [body, shown] of [['', '📷 photo'], ['words', 'words']]) {
    dom.onFetch = serve({ 'GET /users/pal': page({ id: 40, body, created: 1 }), 'GET /users/pal/comments?page=1': { comments: [], total: 0, page: 1, pages: 1 } });
    const root = document.createElement('main');
    await renderProfileComments(root, 'pal');
    assert.equal(root.querySelector('.ms-latest-body').textContent, shown);
  }
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

/* ------------------------------------------------------------ photos (phase 4) */

// a pretend browser for prepareImage: a w × h picture; `sizes` says how big each encoding comes out (bytes)
const fakeEnv = ({ w, h, alpha = false, sizes = {}, fail = false }) => {
  const log = { draws: [], encodes: [] };
  return {
    log,
    decode: async () => { if (fail) throw new Error('no'); return { width: w, height: h, close() { log.closed = true; } }; },
    canvas: (cw, ch) => {
      log.canvas = [cw, ch];
      return { getContext: () => ({ drawImage: (...a) => log.draws.push(a), getImageData: () => ({ data: new Uint8ClampedArray(alpha ? [1, 2, 3, 0] : [1, 2, 3, 255]) }), fillRect() {}, set fillStyle(v) {}, set globalCompositeOperation(v) {} }) };
    },
    encode: async (c, type, q) => {
      log.encodes.push([type, q]);
      if (type === 'image/webp' && sizes[type] === undefined) return { type: 'image/png', size: 9e9 };     // a browser with no WebP encoder answers with a PNG
      return { type, size: sizes[type] ?? 100000 };
    },
  };
};

test('photo sizes: the long side is at most 1600, never enlarged; a picture is the centred square', async () => {
  const { fitWithin, centreSquare, isHeic } = await import('../public/js/widgets/photos.js');
  assert.deepEqual(fitWithin(3200, 2400, 1600), { w: 1600, h: 1200 });
  assert.deepEqual(fitWithin(1000, 4000, 1600), { w: 400, h: 1600 });
  assert.deepEqual(fitWithin(800, 600, 1600), { w: 800, h: 600 }, 'small stays small');
  assert.deepEqual(centreSquare(1200, 800), { sx: 200, sy: 0, side: 800 });
  assert.deepEqual(centreSquare(500, 900), { sx: 0, sy: 200, side: 500 });
  assert.equal(isHeic({ type: 'image/heic', name: 'a' }) && isHeic({ type: '', name: 'IMG_1.HEIC' }) && !isHeic({ type: 'image/jpeg', name: 'a.jpg' }), true);
});

test('prepareImage: a big JPEG is shrunk to 1600 and re-encoded (a fresh JPEG: no EXIF); WebP wins when smaller; a see-through PNG stays PNG', async () => {
  const { prepareImage } = await import('../public/js/widgets/photos.js');
  const jpg = { type: 'image/jpeg', size: 5e6, name: 'a.jpg' };
  let env = fakeEnv({ w: 4000, h: 3000 });
  let r = await prepareImage(jpg, { env });
  assert.deepEqual([r.width, r.height, r.mime, r.kept], [1600, 1200, 'image/jpeg', false]);
  assert.deepEqual(env.log.canvas, [1600, 1200]);
  assert.equal(env.log.closed, true, 'the decoded picture is let go');
  env = fakeEnv({ w: 2000, h: 1000, sizes: { 'image/jpeg': 300000, 'image/webp': 200000 } });
  r = await prepareImage(jpg, { env });
  assert.equal(r.mime, 'image/webp');
  env = fakeEnv({ w: 600, h: 400, alpha: true });
  r = await prepareImage({ type: 'image/png', size: 9e4, name: 'a.png' }, { env });
  assert.deepEqual([r.mime, r.width], ['image/png', 600], 'transparency keeps PNG');
  env = fakeEnv({ w: 600, h: 400, alpha: true, sizes: { 'image/png': 3e6 } });
  r = await prepareImage({ type: 'image/png', size: 3e6, name: 'a.png' }, { env });
  assert.equal(r.mime, 'image/jpeg', 'a PNG too big for 2 MB is flattened');
  env = fakeEnv({ w: 3000, h: 3000, sizes: { 'image/jpeg': 3e6 } });
  await assert.rejects(prepareImage(jpg, { env }), /over 2 MB/);
  assert.deepEqual(env.log.encodes.filter(([t]) => t === 'image/jpeg').map(([, q]) => q), [0.85, 0.7, 0.55], 'tries lower qualities next');
});

test('prepareImage: a small GIF goes up as it is, a big one is flattened; a picture is a 300 px centred square; HEIC says to export as JPEG', async () => {
  const { prepareImage } = await import('../public/js/widgets/photos.js');
  const gif = { type: 'image/gif', size: 4e5, name: 'a.gif' };
  let env = fakeEnv({ w: 400, h: 300 });
  let r = await prepareImage(gif, { env });
  assert.deepEqual([r.blob === gif, r.kept, r.mime, env.log.encodes.length], [true, true, 'image/gif', 0]);
  env = fakeEnv({ w: 1200, h: 900 });
  r = await prepareImage(gif, { env });
  assert.deepEqual([r.kept, r.mime, r.width], [false, 'image/jpeg', 1200], 'over 800: flattened');
  env = fakeEnv({ w: 400, h: 300 });
  r = await prepareImage({ ...gif, size: 3e6 }, { env });
  assert.equal(r.kept, false, 'over 2 MB: flattened');
  env = fakeEnv({ w: 1200, h: 800 });
  r = await prepareImage({ type: 'image/jpeg', size: 1e6, name: 'me.jpg' }, { avatar: true, env });
  assert.deepEqual([r.width, r.height, env.log.canvas], [300, 300, [300, 300]]);
  assert.deepEqual(env.log.draws[0].slice(1), [200, 0, 800, 800, 0, 0, 300, 300], 'cut from the centre square, drawn at 300');
  env = fakeEnv({ w: 100, h: 100 });
  r = await prepareImage({ type: 'image/jpeg', size: 1e4, name: 'tiny.jpg' }, { avatar: true, env });
  assert.equal(r.width, 100, 'a small picture isn\'t enlarged');
  await assert.rejects(prepareImage({ type: 'image/heic', size: 1e6, name: 'IMG.HEIC' }, { env: fakeEnv({ fail: true }) }), /export it as a JPEG/);
  await assert.rejects(prepareImage({ type: 'text/plain', size: 10, name: 'x.txt' }, { env: fakeEnv({ fail: true }) }), /isn't a picture/);
});

const badToasts = () => document.querySelector('#toasts').querySelectorAll('.toast').filter(t => t.classList.contains('bad'));
const pic = (n, o = {}) => ({ id: n, url: `/media/${n}.jpg`, width: 800, height: 600, alt: '', ...o });

test('the photo grid: 1 to 4 photos, room reserved from width and height, lazy, alt text; none draws nothing', async () => {
  const { photoGrid } = await import('../public/js/widgets/photogrid.js');
  assert.equal(photoGrid([]), null);
  assert.equal(photoGrid(undefined), null);
  const one = photoGrid([pic(1, { width: 1000, height: 500, alt: 'a cat' })]);
  assert.equal(one.className, 'ph-grid ph-n1');
  assert.equal(one.style.aspectRatio, '2', 'the photo\'s own shape');
  const img = one.querySelector('img');
  assert.deepEqual([img.getAttribute('alt'), img.getAttribute('width'), img.getAttribute('height'), img.loading, img.getAttribute('src')], ['a cat', '1000', '500', 'lazy', '/media/1.jpg']);
  assert.equal(photoGrid([pic(1, { width: 100, height: 1000 })]).style.aspectRatio, '0.75', 'a tall one is cropped to 3:4 in the feed (the viewer shows it whole)');
  assert.equal(photoGrid([pic(1), pic(2), pic(3)]).className, 'ph-grid ph-n3');
  assert.equal(photoGrid([1, 2, 3, 4, 5, 6].map(n => pic(n))).querySelectorAll('img').length, 4, 'four at most');
  assert.equal(photoGrid([pic(1)]).querySelector('img').getAttribute('alt'), 'photo', 'no description: "photo"');
  assert.match(photoGrid([pic(1)], { small: true, cover: true }).className, /is-small is-cover/);
});

test('the picture viewer: opens on the one clicked, ← → go round, Esc closes it (and nothing under it), alt text under the photo', async () => {
  const { photoGrid } = await import('../public/js/widgets/photogrid.js');
  const grid = photoGrid([pic(1, { alt: 'first' }), pic(2), pic(3, { alt: 'third' })]);
  grid.querySelectorAll('.ph-cell')[1].click();
  const title = () => document.querySelector('.pv-title').textContent;
  assert.equal(title(), 'Photo 2 of 3');
  assert.equal(document.querySelector('.pv-img').getAttribute('src'), '/media/2.jpg');
  assert.equal(document.querySelector('.pv-caption').hidden, true, 'no description, no caption');
  document.dispatch('keydown', { key: 'ArrowRight' });
  assert.deepEqual([title(), document.querySelector('.pv-caption').textContent, document.querySelector('.pv-img').getAttribute('alt')], ['Photo 3 of 3', 'third', 'third']);
  document.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(title(), 'Photo 1 of 3', 'round the end');
  let under = 0;
  const watch = () => { under++; };
  document.addEventListener('keydown', watch);
  document.dispatch('keydown', { key: 'Escape' });
  document.removeEventListener('keydown', watch);
  assert.equal(document.querySelector('.pv-modal'), null, 'Esc closed it');
  assert.equal(under, 0, 'a window under the viewer doesn\'t also get the Esc (the viewer runs first and stops it)');
  photoGrid([pic(9)]).querySelector('.ph-cell').click();
  assert.equal(document.querySelector('.pv-window').querySelectorAll('button').filter(b => b.textContent.includes('Back')).length, 0, 'one photo: no ◀ ▶');
  document.dispatch('keydown', { key: 'Escape' });
});

test('cards show their photos: a status, a quote\'s quoted photos, a blog cover, a thread; photos alone need no words', () => {
  S.me = null;
  const card = postCard(item({ body: '', media: [pic(1), pic(2)] }));
  assert.equal(card.querySelectorAll('.ph-cell').length, 2);
  assert.equal(card.querySelectorAll('.ms-feedtext').length, 0, 'no empty text line');
  const q = postCard(item({ kind: 'quote', body: 'look', quoted: { id: 5, kind: 'status', created: 1, body: 'so cute', author: kat, media: [pic(7)] } }));
  assert.equal(q.querySelector('.ms-quotebox').querySelector('.ph-grid').className, 'ph-grid ph-n1 is-small');
  const blog = postCard(item({ kind: 'blog', subject: 'trip', body: 'words words', cover: pic(3, { width: 1600, height: 600 }) }));
  assert.match(blog.querySelector('.ph-grid').className, /is-cover/);
  const thread = postCard(threadItem({ media: [pic(4), pic(5), pic(6), pic(8)] }));
  assert.equal(thread.querySelectorAll('.ph-cell').length, 4);
  assert.equal(postCard(item({})).querySelectorAll('.ph-grid').length, 0, 'no photos, no grid');
});

// a photo picker with the shrink / preview / upload steps replaced by the test
const fakeIo = (log, { failOn = -1 } = {}) => {
  let n = 0;
  return {
    prepare: async f => ({ blob: { size: 10, name: f.name }, width: 10, height: 10, mime: 'image/jpeg' }),
    preview: async () => 'data:image/jpeg;base64,AA==',
    upload: async (blob, purpose) => {
      const i = n++;
      log.push(['upload', blob.name, purpose]);
      if (i === failOn) throw Object.assign(new Error('that photo is too big: 2 MB at most.'), { status: 413 });
      return { id: 100 + i, url: `/media/k${i}.jpg`, width: 10, height: 10 };
    },
  };
};

test('photo picker: up to the limit, ✕ takes an upload back, alt text goes with the id, a failed upload leaves no tile and says why', async () => {
  const { photoPicker } = await import('../public/js/widgets/photos.js');
  const calls = [];
  dom.onFetch = (method, path) => { calls.push(`${method} ${path}`); return answer(200, { ok: true }); };
  const log = [];
  let changes = 0;
  const pick = photoPicker({ max: 2, io: fakeIo(log), onChange: () => changes++ });
  pick.add([{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }]);
  assert.ok(badToasts().some(t => /up to 2/.test(t.textContent)), 'a third is refused with a message');
  assert.equal(pick.busy(), true, 'still uploading');
  await dom.settle(); await dom.settle();
  assert.deepEqual([pick.count(), pick.busy(), pick.el.querySelectorAll('.ph-tile').length, pick.el.querySelector('.ph-add').disabled], [2, false, 2, true], 'full: the button is off');
  assert.deepEqual(log.map(l => l[2]), ['post', 'post']);
  pick.el.querySelectorAll('.ph-alt')[1].value = '  a dog  ';
  assert.deepEqual(pick.media(), [100, { id: 101, alt: 'a dog' }], 'an id, or { id, alt } when described');
  pick.el.querySelectorAll('.ph-x')[0].click();
  assert.deepEqual([pick.count(), pick.el.querySelector('.ph-add').disabled], [1, false]);
  assert.ok(calls.includes('DELETE /media/100'), 'taken back from the server');
  assert.ok(changes > 0);
  pick.discard();
  await dom.settle();
  assert.ok(calls.includes('DELETE /media/101'), 'a cancelled window takes back what it uploaded');
  assert.equal(pick.el.querySelectorAll('.ph-tile').length, 0);
  const bad = photoPicker({ max: 2, io: fakeIo([], { failOn: 0 }) });
  bad.add([{ name: 'big.jpg' }]);
  await dom.settle(); await dom.settle();
  assert.deepEqual([bad.count(), bad.busy(), bad.el.querySelectorAll('.ph-tile').length], [0, false, 0]);
  assert.ok(badToasts().some(t => /2 MB at most/.test(t.textContent)));
});

test('the status box has a 📷 button for image files, and nothing to post until there are words or a photo', async () => {
  S.me = ME;
  const { composer } = await import('../public/js/widgets/composer.js');
  const form = composer({});
  assert.equal(form.querySelector('button.go').disabled, true, 'nothing to post');
  const input = form.querySelector('input');
  assert.deepEqual([input.getAttribute('type'), input.getAttribute('accept')], ['file', 'image/*']);
  assert.ok(form.querySelector('.ph-add'), 'a 📷 button');
});

test('the moderation photo queue: unreviewed ones first, links to where each is, Mark reviewed takes it off the list, show older pages on', async () => {
  S.me = { ...ME, isAdmin: true };
  const { photoQueue, whereIs } = await import('../public/js/widgets/photoqueue.js');
  const { timeLeft } = await import('../public/js/core/format.js');
  const mk = (id, extra) => ({ id, url: `/media/${id}.jpg`, width: 40, height: 30, alt: '', purpose: 'post', created: Date.now() - 3600000, hidden: false,
    reviewed: false, reviewedAt: null, reviewedBy: null, uploader: { id: 2, name: 'kat', avatar: kat.avatar, created: Date.now() - 86400000 }, where: { type: 'post', id: 9, author: 'kat', board: null, thread: null }, ...extra });
  const calls = [];
  dom.onFetch = (method, path, body) => {
    calls.push(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (path === '/admin/media?filter=unreviewed') return answer(200, { media: [mk(5, { where: null }), mk(4, { where: { type: 'thread', id: 7, author: 'kat', board: 'pets', thread: 7 } })], next: 4 });
    if (path === '/admin/media?filter=unreviewed&before=4') return answer(200, { media: [mk(3, { where: { type: 'avatar', author: 'kat' }, purpose: 'avatar' })], next: null });
    return answer(200, { ok: true });
  };
  const box = photoQueue();
  await dom.settle(); await dom.settle();
  assert.deepEqual(box.querySelectorAll('.mod-pq-card').map(c => Number(c.dataset.id)), [5, 4]);
  assert.match(box.textContent, /not on anything yet/);
  assert.equal(box.querySelectorAll('a').find(a => a.textContent === 'board thread').getAttribute('href'), '/boards/pets/7');
  assert.deepEqual([whereIs(mk(1, { where: { type: 'post', id: 9, author: 'kat' } })), whereIs(mk(1, { where: { type: 'gone' } }))],
    [['post', '/u/kat/post/9'], ['a deleted post (held)', null]]);
  const first = box.querySelector('.mod-pq-card');
  first.querySelectorAll('button').find(b => /Mark reviewed/.test(b.textContent)).click();
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('POST /admin/media/5 {"action":"reviewed"}'));
  assert.deepEqual(box.querySelectorAll('.mod-pq-card').map(c => Number(c.dataset.id)), [4], 'reviewed: off the unreviewed list');
  box.querySelectorAll('button').find(b => /older/.test(b.textContent)).click();
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('GET /admin/media?filter=unreviewed&before=4'));
  assert.deepEqual(box.querySelectorAll('.mod-pq-card').map(c => Number(c.dataset.id)), [4, 3]);
  const hide = box.querySelector('.mod-pq-card').querySelectorAll('button').find(b => /Hide/.test(b.textContent));
  hide.click();
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('POST /admin/media/4 {"action":"hide"}'));
  assert.match(box.querySelector('.mod-pq-card').textContent, /HIDDEN/);
  assert.deepEqual([timeLeft(1000 + 3 * 3600000 + 5 * 60000, 1000), timeLeft(1000, 1000 + 90 * 60000)], ['3h 5m left', 'OVERDUE by 1h 30m']);
});

/* ------------------------------------------------------------ phase 5: live chat */

const { FakeSocket } = await import('./helpers/fake-dom.mjs');
globalThis.WebSocket = FakeSocket;
const wait = ms => new Promise(r => setTimeout(r, ms));
const lastSocket = () => FakeSocket.all.at(-1);

test('live: the socket goes to /api/live/:room (ws or wss), frames arrive as events, pongs are dropped', async () => {
  const { openRoom, liveUrl } = await import('../public/js/core/live.js');
  assert.equal(liveUrl('ourspace', { protocol: 'https:', host: 'ourspace.example' }), 'wss://ourspace.example/api/live/ourspace');
  assert.equal(liveUrl(12, { protocol: 'http:', host: 'localhost:8787' }), 'ws://localhost:8787/api/live/12');
  const seen = [], states = [];
  const room = openRoom('ourspace', { onEvent: e => seen.push(e), onState: s => states.push(s) });
  const ws = lastSocket();
  assert.match(ws.url, /\/api\/live\/ourspace$/);
  ws.open();
  ws.emit({ type: 'pong' });
  ws.emit({ type: 'typing', user: kat });
  ws.emit('not json');
  assert.deepEqual(seen, [{ type: 'typing', user: kat }]);
  assert.equal(room.send({ type: 'typing' }), true);
  assert.deepEqual(ws.sent, ['{"type":"typing"}']);
  assert.deepEqual(states, ['live']);
  room.close();
  assert.equal(room.state, 'closed');
  assert.equal(room.send({ type: 'typing' }), false);
});

test('live: a lost socket comes back and catches up; three failures in a row fall back to polling until it returns', async () => {
  const { openRoom } = await import('../public/js/core/live.js');
  let syncs = 0;
  const room = openRoom('7', { sync: async () => { syncs++; }, pollMs: 15 });
  lastSocket().open();
  assert.equal(syncs, 0, 'the first connect has nothing to catch up on');
  room.reconnect();                                   // (what a retry timer does)
  lastSocket().open();
  await wait(5);
  assert.equal(syncs, 1, 'a reconnect asks for what it missed');
  for (let i = 0; i < 3; i++) { lastSocket().shut(1006); if (i < 2) room.reconnect(); }
  assert.equal(room.state, 'polling');
  await wait(60);
  assert.ok(syncs >= 3, 'while down it polls the history');
  room.reconnect();
  lastSocket().open();
  await wait(5);
  assert.equal(room.state, 'live');
  const after = syncs;
  await wait(50);
  assert.equal(syncs, after, 'polling stops once the socket is back');
  room.close();
});

test('live: close code 4003 ends it for good with a "removed" event, and no retry', async () => {
  const { openRoom } = await import('../public/js/core/live.js');
  const seen = [];
  const room = openRoom('9', { onEvent: e => seen.push(e.type) });
  const before = FakeSocket.all.length;
  lastSocket().open();
  lastSocket().shut(4003);
  assert.deepEqual(seen, ['removed']);
  assert.equal(room.state, 'closed');
  await wait(20);
  assert.equal(FakeSocket.all.length, before, 'no new socket');
});

test('live: signed out (4001) and too many tabs (4002) end it for good too, each with its own event', async () => {
  const { openRoom } = await import('../public/js/core/live.js');
  for (const [code, why] of [[4001, 'signedout'], [4002, 'elsewhere']]) {
    const seen = [];
    const room = openRoom('9', { onEvent: e => seen.push(e.type), sync: async () => { throw new Error('no polling after the end'); } });
    const before = FakeSocket.all.length;
    lastSocket().open();
    lastSocket().shut(code);
    assert.deepEqual(seen, [why]);
    assert.equal(room.state, 'closed');
    await wait(20);
    assert.equal(FakeSocket.all.length, before, 'no new socket');
  }
  // the room's { type: 'bye', code } frame ends it already, before the close itself arrives
  const seen = [];
  const room = openRoom('9', { onEvent: e => seen.push(e.type) });
  const ws = lastSocket();
  ws.open();
  ws.emit({ type: 'bye', code: 4001 });
  assert.deepEqual([seen, room.state, ws.readyState], [['signedout'], 'closed', 3]);
  ws.shut(4001);
  assert.deepEqual(seen, ['signedout'], 'told once');
});

test('live: a 401 from the history ends it as "signedout", a 403 or 404 as "removed": no more polling, no more sockets', async () => {
  const { openRoom } = await import('../public/js/core/live.js');
  for (const [status, why] of [[401, 'signedout'], [403, 'removed'], [404, 'removed']]) {
    const seen = [];
    let syncs = 0;
    const room = openRoom('7', { onEvent: e => seen.push(e.type), pollMs: 10,
      sync: async () => { syncs++; const e = new Error('no'); e.status = status; throw e; } });
    for (let i = 0; i < 3; i++) { lastSocket().shut(1006); if (i < 2) room.reconnect(); }
    await wait(5);
    assert.deepEqual(seen, [why]);
    assert.equal(room.state, 'closed');
    const [n, sockets] = [syncs, FakeSocket.all.length];
    await wait(60);
    assert.deepEqual([syncs, FakeSocket.all.length], [n, sockets], 'nothing more is tried');
  }
  // anything else (a 500, the network) keeps polling
  let syncs = 0;
  const room = openRoom('7', { pollMs: 10, sync: async () => { syncs++; throw Object.assign(new Error('down'), { status: 500 }); } });
  for (let i = 0; i < 3; i++) { lastSocket().shut(1006); if (i < 2) room.reconnect(); }
  await wait(60);
  assert.equal(room.state, 'polling');
  assert.ok(syncs >= 3);
  room.close();
});

test('live: polling slows to once a minute while the tab is hidden', async () => {
  const { openRoom } = await import('../public/js/core/live.js');
  let syncs = 0;
  const room = openRoom('7', { pollMs: 10, sync: async () => { syncs++; } });
  document.hidden = true;
  for (let i = 0; i < 3; i++) { lastSocket().shut(1006); if (i < 2) room.reconnect(); }
  await wait(80);
  assert.equal(syncs, 1, 'one look when it starts polling, then nothing while hidden');
  document.hidden = false;
  await wait(40);
  assert.ok(syncs >= 3, 'back to every few seconds once it shows');
  room.close();
});

const dmChat = { id: 5, kind: 'dm', title: null, status: 'joined', role: 'member', created: 1, memberCount: 2, owner: null, members: [kat], invited: [], lastMessage: null, unread: 1, invitedBy: null };
const said = (id, author, body, more) => ({ id, chatId: 5, room: null, body, created: Date.now() - 60000 + id, author, mine: author.id === ME.id, ...more });

test('a chat window: history, live messages drawn once, typing, read ticks, delete, and the box stays off when you may not write', async () => {
  S.me = ME;
  const calls = [];
  let canMessage = true;
  dom.onFetch = (method, path, body) => {
    calls.push(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (method === 'GET' && path === '/chats/5/messages') return answer(200, { chat: dmChat, messages: [said(1, kat, 'hi there')], next: null, reads: [], canMessage, reason: canMessage ? null : 'kat only takes messages from friends.' });
    if (method === 'POST' && path === '/chats/5/messages') return answer(201, { message: said(2, ME, body.body) });
    if (method === 'DELETE' && path === '/chat-messages/2') return answer(200, { ok: true });
    if (path === '/me') return answer(200, { user: ME, counts: { unread: 0 } });
    return answer(200, { ok: true });
  };
  const { renderChat } = await import('../public/js/pages/chat.js');
  const root = document.createElement('main');
  await renderChat(root, '5');
  await dom.settle();
  const texts = () => root.querySelectorAll('.ms-chat-text').map(e => e.textContent);
  assert.deepEqual(texts(), ['hi there']);
  assert.match(root.querySelector('.title-bar').textContent, /kat - Instant Message/);
  assert.ok(root.querySelector('.ms-day'), 'a day separator');
  const ws = lastSocket();
  ws.open();
  // typing from them shows, from me doesn't; their next message clears it
  ws.emit({ type: 'typing', user: kat });
  ws.emit({ type: 'typing', user: ME });
  assert.equal(root.querySelector('.ms-chat-typing').textContent, 'kat is typing…');
  ws.emit({ type: 'message', message: said(3, kat, 'second', { mine: undefined }) });
  ws.emit({ type: 'message', message: said(3, kat, 'second') });
  assert.deepEqual(texts(), ['hi there', 'second'], 'the same message twice is drawn once');
  assert.equal(root.querySelector('.ms-chat-typing').textContent, '');
  // sending: Enter posts, the answer and the socket's copy are one line
  const ta = root.querySelector('textarea');
  ta.value = 'hello kat';
  ta.dispatch('input');
  assert.deepEqual(ws.sent, ['{"type":"typing"}'], 'typing goes out');
  ta.dispatch('keydown', { key: 'Enter', shiftKey: false });
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('POST /chats/5/messages {"body":"hello kat"}'));
  ws.emit({ type: 'message', message: said(2, ME, 'hello kat') });
  assert.deepEqual(texts(), ['hi there', 'hello kat', 'second'], 'in the order of their ids');
  assert.equal(ta.value, '');
  assert.match(root.querySelector('.ms-chat-seen').textContent, /sent/);
  ws.emit({ type: 'read', user: kat, id: 2 });
  assert.match(root.querySelector('.ms-chat-seen').textContent, /read/);
  // shift+Enter is a new line, not a send
  const posts = calls.filter(c => c.startsWith('POST /chats/5/messages')).length;
  ta.value = 'a\nb';
  ta.dispatch('keydown', { key: 'Enter', shiftKey: true });
  await dom.settle();
  assert.equal(calls.filter(c => c.startsWith('POST /chats/5/messages')).length, posts);
  // my own line has delete, theirs report
  const mine = root.querySelectorAll('.ms-chatmsg').find(m => m.classList.contains('me'));
  assert.deepEqual(mine.querySelectorAll('a').filter(a => !a.classList.contains('ms-aim-name') && !a.classList.contains('ms-name-link')).map(a => a.textContent), ['delete']);
  assert.deepEqual(root.querySelector('.ms-chatmsg.them').querySelectorAll('.ms-actions a').map(a => a.textContent), ['⚑ report']);
  ws.emit({ type: 'deleted', id: 3 });
  assert.deepEqual(texts(), ['hi there', 'hello kat']);
  // not allowed to write: the reason, no box
  canMessage = false;
  const locked = document.createElement('main');
  await renderChat(locked, '5');
  assert.equal(locked.querySelector('textarea'), null);
  assert.match(locked.textContent, /only takes messages from friends/);
});

test('an invite you haven\'t answered shows Accept / Decline instead of the chat', async () => {
  S.me = ME;
  const invite = { ...dmChat, id: 8, kind: 'group', title: 'mixtape club', status: 'invited', members: [], lastMessage: null, unread: 0, invitedBy: kat, memberCount: 2 };
  dom.onFetch = serve({ 'GET /chats/8/messages': () => answer(403, { error: 'accept the invite first.' }), 'GET /chats/8': { chat: invite } });
  const { renderChat } = await import('../public/js/pages/chat.js');
  const root = document.createElement('main');
  await renderChat(root, '8');
  assert.match(root.textContent, /kat/);
  assert.match(root.textContent, /mixtape club/);
  assert.deepEqual(root.querySelectorAll('button').map(b => b.textContent), ['✔ Accept', 'Decline']);
  assert.equal(root.querySelector('textarea'), null);
});

test('Messages: invites first with Accept / Decline, unread in bold with a count, a group says how many, search narrows the list', async () => {
  S.me = ME;
  const invite = { ...dmChat, id: 8, kind: 'group', title: 'mixtape club', status: 'invited', members: [], unread: 0, invitedBy: pal, memberCount: 3 };
  const group = { ...dmChat, id: 6, kind: 'group', title: 'top 8 crew', members: [kat, pal], memberCount: 3, unread: 0, lastMessage: { id: 9, body: 'see you there', author: kat, created: Date.now() } };
  const dm = { ...dmChat, lastMessage: { id: 4, body: 'psst', author: ME, created: Date.now() }, unread: 2 };
  dom.onFetch = serve({ 'GET /chats': { items: [group, dm, invite] } });
  const { renderMessages } = await import('../public/js/pages/messages.js');
  const root = document.createElement('main');
  await renderMessages(root);
  const rows = root.querySelectorAll('.ms-chatrow');
  assert.deepEqual(rows.map(r => r.classList.contains('invite')), [true, false, false], 'the invite is on top');
  assert.deepEqual(rows[0].querySelectorAll('button').map(b => b.textContent), ['✔ Accept', 'Decline']);
  assert.match(rows[0].textContent, /pal invited you/);
  assert.match(rows[1].textContent, /top 8 crew.*3 people.*kat: see you there/);
  assert.equal(rows[2].classList.contains('unread'), true);
  assert.equal(rows[2].querySelector('.ms-badge').textContent, '2');
  assert.match(rows[2].textContent, /you: psst/);
  const search = root.querySelector('input');
  search.value = 'crew';
  search.dispatch('input');
  assert.deepEqual(root.querySelectorAll('.ms-chatrow').map(r => /top 8 crew/.test(r.textContent)), [true]);
  search.value = 'zzz';
  search.dispatch('input');
  assert.match(root.querySelector('.ms-chatlist').textContent, /no conversations match/);
});

test('the people picker: friends first, then "people you talk to" with a note that they\'ll be invited; chips; add by name', async () => {
  const asked = [];
  dom.onFetch = (method, path) => {
    asked.push(path);
    return answer(200, { people: [
      { id: 2, name: 'kat', avatar: kat.avatar, friend: true, online: true },
      { id: 3, name: 'pal', avatar: pal.avatar, friend: false, online: false }] });
  };
  const { peoplePicker } = await import('../public/js/widgets/peoplepicker.js');
  const p = peoplePicker({ exclude: ['already'] });
  await dom.settle(); await dom.settle();
  assert.ok(asked.includes('/chats/suggestions?q='));
  const list = p.el.querySelector('.ms-pp-list');
  assert.deepEqual(list.children.map(c => c.textContent.replace(/[+✔]$/, '')), ['Friends', 'kat', 'People you talk to', 'palgets an invite']);
  list.querySelectorAll('button').find(b => /pal/.test(b.textContent)).click();
  p.el.querySelector('.ms-pp-list').querySelectorAll('button').find(b => /^kat/.test(b.textContent)).click();
  assert.deepEqual(p.names().sort(), ['kat', 'pal']);
  assert.equal(p.el.querySelectorAll('.ms-pp-chip').length, 2);
  p.el.querySelectorAll('.ms-pp-x')[0].click();
  assert.equal(p.names().length, 1);
  const input = p.el.querySelector('input');
  input.value = 'somebody';
  input.dispatch('keydown', { key: 'Enter' });
  assert.ok(p.names().includes('somebody'), 'a typed name that isn\'t suggested can still be added');
});

const irc = (id, author, body) => ({ id, chatId: null, room: 'ourspace', body, created: Date.now() - 3600000 + id * 1000, author, mine: false });
const room0 = more => ({ messages: [], next: null, online: [], mutedUntil: null, slowMode: { seconds: 3, perMinute: 20 }, ...more });

test('#ourspace: logged out asks you to log in; logged in the lines are [time] <nick> words with the @mentions linked, nicks come from presence', async () => {
  S.me = null;
  const { renderOurspace } = await import('../public/js/pages/ourspace.js');
  const out = document.createElement('main');
  await renderOurspace(out);
  assert.match(out.textContent, /log in/);
  assert.equal(out.querySelector('input'), null);
  S.me = ME;
  dom.onFetch = serve({ 'GET /ourspace/messages': room0({ messages: [irc(1, kat, 'hello @pal and @me'), irc(2, pal, 'hi')], online: [kat] }) });
  const root = document.createElement('main');
  await renderOurspace(root);
  const lines = root.querySelectorAll('.ms-irc-line');
  assert.match(lines[0].textContent, /^\[\d\d:\d\d\] <kat> hello @pal and @me/);
  assert.equal(lines[0].classList.contains('hl'), true, 'a line that mentions me is highlighted');
  assert.deepEqual(lines[0].querySelectorAll('a.ms-mention').map(a => a.getAttribute('href')), ['/u/pal']);
  assert.deepEqual(root.querySelectorAll('.ms-irc-nickbtn').map(b => b.textContent), ['kat']);
  lastSocket().open();
  lastSocket().emit({ type: 'presence', online: [kat, pal, ME] });
  assert.deepEqual(root.querySelectorAll('.ms-irc-nickbtn').map(b => b.textContent), ['kat', 'me', 'pal']);
  assert.match(root.querySelector('.ms-irc-nickhead').textContent, /3 here now/);
  lastSocket().emit({ type: 'message', message: irc(3, pal, 'live one') });
  assert.equal(root.querySelectorAll('.ms-irc-line').filter(l => /live one/.test(l.textContent)).length, 1);
  assert.equal(root.querySelectorAll('.ms-irc-acts a').filter(a => /mute/.test(a.textContent)).length, 0, 'no mute for a regular member');
  lastSocket().emit({ type: 'deleted', id: 3 });
  assert.equal(root.querySelectorAll('.ms-irc-line').filter(l => /live one/.test(l.textContent)).length, 0);
});

test('#ourspace: Send counts down the slow mode, a muted member sees the notice instead of the box, moderators get [del] and [mute]', async () => {
  const { renderOurspace } = await import('../public/js/pages/ourspace.js');
  S.me = ME;
  dom.onFetch = (method, path, body) => {
    if (method === 'POST' && path === '/ourspace/messages') return answer(201, { message: irc(9, ME, body.body) });
    return answer(200, room0({ messages: [irc(1, kat, 'hello')] }));
  };
  const root = document.createElement('main');
  await renderOurspace(root);
  const input = root.querySelector('.ms-irc-send input'), btn = root.querySelector('.ms-irc-send button');
  input.value = 'first';
  root.querySelector('.ms-irc-send').dispatch('submit');
  await dom.settle(); await dom.settle();
  assert.equal(btn.disabled, true);
  assert.match(btn.textContent, /^wait [1-3]s$/);
  assert.match(root.textContent, /first/);
  // muted
  dom.onFetch = serve({ 'GET /ourspace/messages': room0({ mutedUntil: Date.now() + 3600000 }) });
  const muted = document.createElement('main');
  await renderOurspace(muted);
  assert.equal(muted.querySelector('input'), null);
  assert.match(muted.querySelector('.ms-irc-muted').textContent, /muted in #ourspace until/);
  // a moderator
  S.me = { ...ME, isAdmin: true };
  dom.onFetch = serve({ 'GET /ourspace/messages': room0({ messages: [irc(1, kat, 'hello')] }) });
  const mod = document.createElement('main');
  await renderOurspace(mod);
  assert.deepEqual(mod.querySelector('.ms-irc-line').querySelectorAll('.ms-irc-acts a').map(a => a.textContent), ['[del]', '[mute]', '[report]']);
  S.me = ME;
});

test('a group invite in Notifications leads to the chat and answers in place; a #ourspace mention leads to the room', async () => {
  S.me = ME;
  const posted = [];
  dom.onFetch = (method, path, body) => {
    if (method === 'GET' && path === '/notifications') return answer(200, { unread: 2, next: null, items: [
      { id: 2, kind: 'group_invite', created: Date.now(), unread: true, actor: kat, post: null, chat: { id: 8, title: 'mixtape club' } },
      { id: 1, kind: 'chat_mention', created: Date.now() - 1000, unread: true, actor: pal, post: null, message: { id: 4, body: 'hey @me look', created: Date.now(), room: 'ourspace' } }] });
    if (method === 'GET' && path === '/requests') return answer(200, { incoming: [] });
    posted.push(`${method} ${path} ${JSON.stringify(body || {})}`);
    return answer(200, { ok: true });
  };
  const { renderNotifications } = await import('../public/js/pages/notifications.js');
  const root = document.createElement('main');
  await renderNotifications(root);
  const rows = root.querySelectorAll('.ms-note-row');
  assert.match(rows[0].textContent, /kat invited you to the group chat "mixtape club"/);
  assert.equal(rows[0].querySelectorAll('a').find(a => /invited/.test(a.textContent)).getAttribute('href'), '/messages/8');
  assert.deepEqual(rows[0].querySelectorAll('.ms-note-actions button').map(b => b.textContent), ['✔ Accept', 'Decline']);
  assert.match(rows[1].textContent, /pal mentioned you in #ourspace.*hey @me look/);
  assert.equal(rows[1].querySelectorAll('a').find(a => /mentioned/.test(a.textContent)).getAttribute('href'), '/ourspace');
  rows[0].querySelectorAll('.ms-note-actions button')[1].click();
  await dom.settle(); await dom.settle();
  assert.ok(posted.includes('POST /chats/8/invite {"action":"decline"}'));
  assert.match(rows[0].textContent, /declined/);
});
