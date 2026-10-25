/* widgets/blogtext.js — a blog post's body. Plain text plus a tiny set of marks, built with createElement/textContent
   only (never innerHTML):
     a blank line starts a new paragraph (single line breaks stay)   ## a heading   > a quote   - a list item
     **bold**   *italic*
   teaser() is the same text with the marks taken out, cut short, for the feed and the blog's index. */

import { h } from '../core/dom.js';

// **bold** and *italic* inside one line → nodes
function inline(line) {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(/\*\*(.+?)\*\*|\*(?!\s)(.+?)\*/g)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(m[1] != null ? h('strong', { text: m[1] }) : h('em', { text: m[2] }));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

const KINDS = [['h', /^##\s+(.*)$/], ['q', /^>\s?(.*)$/], ['li', /^[-•]\s+(.*)$/]];
function classify(line) {
  for (const [kind, re] of KINDS) { const m = re.exec(line); if (m) return [kind, m[1]]; }
  return ['p', line];
}

// the post's text → a <div class="post-body">
export function blogBody(text) {
  const root = h('div', { class: 'post-body' });
  let kind = null, box = null;                    // the block being filled
  const flush = () => { kind = null; box = null; };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }      // a blank line ends the block
    const [k, body] = classify(line.trim());
    if (k === 'h') { flush(); root.append(h('h2', null, inline(body))); continue; }
    if (k !== kind) {
      flush();
      kind = k;
      box = h(k === 'q' ? 'blockquote' : k === 'li' ? 'ul' : 'p');
      root.append(box);
    }
    if (k === 'li') box.append(h('li', null, inline(body)));
    else {
      if (box.childNodes.length) box.append(h('br'));
      box.append(...inline(body));
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
