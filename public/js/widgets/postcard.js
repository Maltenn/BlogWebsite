/* widgets/postcard.js — one post as a card: in the feed, on a profile's Posts and Replies tabs, in a conversation, on the
   tag and Bookmarks pages. Every kind of post is here:
     status / blog / reply   the writer, the words (@mentions and #tags are links), the time, the 💬 ↻ ♥ 🔖 row
     quote                   the writer's words, then the post they quote in a box
     repost                  "↻ kat reposted" above the original's card
     deleted                 "this post was deleted." (a tombstone keeps a conversation's shape)
   (Friends' Comments and the blog's own page have their own looks.) */

import { h, userPath } from '../core/dom.js';
import { when, ago, clock } from '../core/format.js';
import { S } from '../core/state.js';
import { go } from '../core/router.js';
import { avatar, nameLink } from './people.js';
import { postActions } from './safety.js';
import { teaser } from './blogtext.js';
import { rich } from './richtext.js';
import { reactionRow } from './reactions.js';
import { quoteBox } from './quotebox.js';
import { postPath, blogPath } from './postlinks.js';

// the time, as a link to the post: 'ago' ("3 hours ago"), 'clock' ("9:12 PM", under a day heading) or 'full' (the whole date)
// (`to` is the post it links to, when that isn't `p`: a repost's time links to its original)
function stamp(p, style, to = p) {
  const text = style === 'clock' ? clock(p.created) : style === 'full' ? when(p.created) : ago(p.created);
  return h('a', { class: 'ms-time', href: postPath(to), title: when(p.created), text });
}

// "Replying to @kat" (nothing when it's a reply to opts.directTo, which the page already says). The server names the
// post answered only when you may see it: with an id and no author it went with its writer's account, with neither it's
// there but not for you (a private profile's, or across a block).
function replyingTo(p, directTo) {
  if (!p.replyTo || (p.replyTo.id != null && p.replyTo.id === directTo)) return null;
  const who = p.replyTo.author;
  return h('div', { class: 'ms-replyto' }, 'Replying to ', who ? h('a', { class: 'ms-mention', href: userPath(who.name), text: '@' + who.name })
    : p.replyTo.id != null ? 'a deleted account' : 'a post you can\'t see');
}

// opts.time: 'ago' (the default) or 'clock'. opts.onDeleted(post, tombstone) after "delete" (tombstone: it stays, as
// "this post was deleted", because it has replies or quotes). opts.big: the post a conversation is about.
// opts.compact: a small card (the posts above it). opts.onReply(): the 💬 does this instead of opening the Reply window.
// opts.directTo: a post id; replies to it don't say "Replying to". opts.removeOnUnbookmark: the card goes when unbookmarked.
export function postCard(item, opts = {}) {
  const row = h('div', { class: 'ms-feeditem' + (opts.big ? ' is-big' : '') + (opts.compact ? ' is-compact' : ''), dataset: { id: item.id, created: item.created } });
  draw(row, item, opts);
  return row;
}

function draw(row, item, opts) {
  row.classList.toggle('is-repost', item.kind === 'repost');
  if (item.kind !== 'repost') { row.replaceChildren(item.deleted ? gone(item, opts) : body(row, item, item, opts)); return; }
  const orig = item.quoted;
  const line = h('div', { class: 'ms-repostline' }, '↻ ', nameLink(item.author), ' reposted',
    orig && !orig.unavailable ? [' · ', stamp(item, opts.time === 'clock' ? 'clock' : 'ago', orig)] : null);
  if (!orig || orig.unavailable) { row.replaceChildren(line, h('div', { class: 'ms-feedrow' }, h('div', { class: 'ms-feedmid ms-gone', text: 'this post is unavailable.' }))); return; }
  row.replaceChildren(line, orig.deleted ? gone(orig, opts) : body(row, item, orig, { ...opts, time: 'ago' }));
}

// a deleted post
function gone(p, opts) {
  return h('div', { class: 'ms-feedrow' }, avatar(p.author, 40),
    h('div', { class: 'ms-feedmid' }, h('div', null, nameLink(p.author)),
      h('div', { class: 'ms-feedtext ms-gone', text: 'this post was deleted.' }),
      h('div', null, stamp(p, opts.time))));
}

// The card's avatar and words. via: the item in the list (the same as `p`, or the repost that brought `p` here).
function body(row, via, p, opts) {
  const a = p.author;
  const open = e => {                                      // the words open the conversation (a click on a link or a selection doesn't)
    if (e.target.closest('a, button')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    go(postPath(p));
  };
  const afterDelete = r => {
    if (opts.onDeleted) opts.onDeleted(p, r.tombstone);
    if (r.tombstone) { row.replaceChildren(gone(p, opts)); row.classList.remove('is-repost'); }   // with replies or quotes, a tombstone stays
    else row.remove();
  };
  let mid;
  if (p.kind === 'blog') {
    mid = [
      h('div', null, nameLink(a), ' wrote a blog post'),
      h('a', { class: 'ms-feedtitle', href: blogPath(a.name, p.id), text: p.subject }),
      p.subtitle ? h('div', { class: 'ms-feedsub', text: p.subtitle }) : null,
      h('div', { class: 'ms-feedtext' }, rich(teaser(p.body), p.mentions)),
      h('a', { class: 'ms-readon', href: blogPath(a.name, p.id), text: 'Continue reading →' }),
    ];
  } else {
    mid = [
      h('div', null, nameLink(a)),
      replyingTo(p, opts.directTo),
      h('div', { class: 'ms-feedtext' + (opts.big ? '' : ' is-link'), onclick: opts.big ? null : open }, rich(p.body, p.mentions)),
      p.kind === 'quote' ? quoteBox(p.quoted) : null,
    ];
  }
  const mine = S.me && via.author.id === S.me.id;
  return h('div', { class: 'ms-feedrow' },
    avatar(a, opts.big ? 48 : 40),
    h('div', { class: 'ms-feedmid' }, mid,
      h('div', { class: 'ms-feedmeta' }, stamp(p, opts.big ? 'full' : opts.time), postActions(p, afterDelete)),
      reactionRow(p, {
        onReply: opts.onReply,
        onBookmarkChange: opts.removeOnUnbookmark ? on => { if (!on) row.remove(); } : null,
        onUnrepost: via !== p && mine ? () => { row.remove(); if (opts.onDeleted) opts.onDeleted(via); } : null,   // you undid your own repost: the card was only there because of it
      })));
}
