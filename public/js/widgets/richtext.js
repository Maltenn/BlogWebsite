/* widgets/richtext.js — the words of a post with its @mentions and #tags turned into links. Built with createElement and
   textContent only (never innerHTML).
     @name  links to /u/name, but only when the server resolved it (the post's `mentions`, case doesn't matter).
     #tag   links to /tags/tag, by the same rule as the server: 1–40 letters (any alphabet), digits or _, at least one letter
            (not in Friends' Comments, whose tags the server doesn't keep).
   The patterns are the server's own (src/shared/text.js), so what the page links is what the server stored.
   rich(text, mentions) is for plain bodies. blogtext.js uses linkSpans() and weave() so the links sit inside **bold** and
   *italic* without being cut by them. */

import { h, userPath, enc } from '../core/dom.js';

const MENTION = /(^|[^A-Za-z0-9_~*.\-@])@([A-Za-z0-9_~*.\-]+)/g;
const HASHTAG = /(^|[^\p{L}\p{M}\p{N}_])#([\p{L}\p{M}\p{N}_]+)/gu;

export const tagPath = tag => '/tags/' + enc(tag);

// a #tag as stored (lower case), or '' if it isn't one
export function tagKey(s) {
  const t = String(s ?? '').normalize('NFC').toLowerCase();
  return /^[\p{L}\p{M}\p{N}_]{1,40}$/u.test(t) && /\p{L}/u.test(t) ? t : '';
}

// Where the links are in `text`: [{ start, end, href, cls }], in order, none overlapping. `mentions` is the post's
// [{ id, name }]; with none, only the #tags link. tags: false leaves #tags as plain text (Friends' Comments: the server
// doesn't keep their tags, so a link would lead to a page without them).
export function linkSpans(text, mentions, { tags = true } = {}) {
  const known = new Map((mentions || []).map(m => [m.name.toLowerCase(), m.name]));
  const found = [];
  if (known.size) {
    for (const m of text.matchAll(MENTION)) {
      const start = m.index + m[1].length;
      // a trailing . ~ * - is punctuation unless somebody's name really ends that way: the longest name that exists wins
      for (let run = m[2]; ; run = run.slice(0, -1)) {
        const key = run.toLowerCase();
        if (key.length >= 3 && key.length <= 20 && known.has(key)) {
          found.push({ start, end: start + 1 + run.length, href: userPath(known.get(key)), cls: 'ms-mention' });
          break;
        }
        if (!/[.~*-]$/.test(run)) break;
      }
    }
  }
  for (const m of tags ? text.matchAll(HASHTAG) : []) {
    const tag = tagKey(m[2]);
    const start = m.index + m[1].length;
    if (tag) found.push({ start, end: start + 1 + m[2].length, href: tagPath(tag), cls: 'ms-hashtag' });
  }
  found.sort((a, b) => a.start - b.start);
  const spans = [];
  for (const s of found) if (!spans.length || s.start >= spans[spans.length - 1].end) spans.push(s);
  return spans;
}

// text[from, to) as nodes: strings, and a link for each span that lies wholly inside
export function weave(text, from, to, spans) {
  const out = [];
  let at = from;
  for (const s of spans) {
    if (s.start < at || s.end > to) continue;
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(h('a', { class: s.cls, href: s.href, text: text.slice(s.start, s.end) }));
    at = s.end;
  }
  if (at < to) out.push(text.slice(at, to));
  return out;
}

// a plain body → nodes (strings and links), for h(el, props, rich(body, item.mentions)). opts: as linkSpans().
export function rich(text, mentions, opts) {
  const s = String(text ?? '');
  return weave(s, 0, s.length, linkSpans(s, mentions, opts));
}
