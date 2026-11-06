/* widgets/blogtext.js — a blog post's body. Plain text plus a tiny set of marks, built with createElement/textContent
   only (never innerHTML):
     a blank line starts a new paragraph (single line breaks stay)   ## a heading   > a quote   - a list item
     **bold**   *italic*
   The post's @mentions and #tags become links (richtext.js), inside the bold and italic too.
   teaser() is the same text with the marks taken out, cut short, for the feed and the blog's index. */

import { h } from '../core/dom.js';
import { linkSpans, weave } from './richtext.js';

// **bold** and *italic* inside one line → nodes. The links are found first and hidden from the pattern (a name may
// contain * or ~), then each stretch of text gets its links back.
function inline(line, mentions) {
  const spans = mentions === null ? [] : linkSpans(line, mentions);   // null: no links at all (a preview)
  let masked = line;
  for (const s of spans) masked = masked.slice(0, s.start) + '\uE000'.repeat(s.end - s.start) + masked.slice(s.end);
  const out = [];
  let last = 0;
  for (const m of masked.matchAll(/\*\*(.+?)\*\*|\*(?!\s)(.+?)\*/g)) {
    if (m.index > last) out.push(...weave(line, last, m.index, spans));
    const pad = m[1] != null ? 2 : 1;
    out.push(h(m[1] != null ? 'strong' : 'em', null, weave(line, m.index + pad, m.index + m[0].length - pad, spans)));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(...weave(line, last, line.length, spans));
  return out;
}

const KINDS = [['h', /^##\s+(.*)$/], ['q', /^>\s?(.*)$/], ['li', /^[-•]\s+(.*)$/]];
function classify(line) {
  for (const [kind, re] of KINDS) { const m = re.exec(line); if (m) return [kind, m[1]]; }
  return ['p', line];
}

// the post's text → a <div class="post-body">. mentions: the post's [{ id, name }]. opts.links: false in a preview, where
// a click must not leave the page you're writing.
export function blogBody(text, mentions = [], opts = {}) {
  const who = opts.links === false ? null : mentions;
  const root = h('div', { class: 'post-body' });
  let kind = null, box = null;                    // the block being filled
  const flush = () => { kind = null; box = null; };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }      // a blank line ends the block
    const [k, body] = classify(line.trim());
    if (k === 'h') { flush(); root.append(h('h2', null, inline(body, who))); continue; }
    if (k !== kind) {
      flush();
      kind = k;
      box = h(k === 'q' ? 'blockquote' : k === 'li' ? 'ul' : 'p');
      root.append(box);
    }
    if (k === 'li') box.append(h('li', null, inline(body, who)));
    else {
      if (box.childNodes.length) box.append(h('br'));
      box.append(...inline(body, who));
    }
  }
  return root;
}

// "the first few words…" with the marks and line breaks taken out
export function teaser(text, max = 280) {
  const plain = String(text).replace(/\r/g, '').split('\n')
    .map(l => l.trim().replace(/^(##\s+|>\s?|[-•]\s+)/, ''))
    .filter(Boolean).join(' ')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(?!\s)(.+?)\*/g, '$1');
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd().replace(/…$/, '') + '…' : plain;
}
