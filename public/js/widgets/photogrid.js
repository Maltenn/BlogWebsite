/* widgets/photogrid.js — a post's photos as a Twitter-style grid: one big, two side by side, three (one tall, two small)
   or four in a square. Each cell has its room reserved from the photo's width and height (no jumping when it loads), loads
   lazily, and opens the picture viewer. A blog post's cover is the same thing as a wide single photo. */

import { h } from '../core/dom.js';
import { openViewer } from './photoviewer.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const TALLEST = 360;              // px: how tall a single photo gets in a feed

// media: [{ id, url, width, height, alt }] (up to 4). opts.small: a thumbnail grid (inside a quote). opts.cover: a blog cover.
export function photoGrid(media, opts = {}) {
  const list = (media || []).filter(m => m && m.url).slice(0, 4);
  if (!list.length) return null;
  const grid = h('div', { class: `ph-grid ph-n${list.length}` + (opts.small ? ' is-small' : '') + (opts.cover ? ' is-cover' : '') });
  if (list.length === 1) {
    const m = list[0];
    const ratio = m.width && m.height ? m.width / m.height : 1.5;
    const r = opts.cover ? clamp(ratio, 1.4, 2.4) : clamp(ratio, 0.75, 2);
    grid.style.aspectRatio = `${Math.round(r * 1000) / 1000}`;
    if (!opts.small && !opts.cover) grid.style.width = `min(100%, ${Math.round(TALLEST * r)}px)`;
  }
  list.forEach((m, i) => {
    const label = m.alt ? `open photo: ${m.alt}` : `open photo ${i + 1} of ${list.length}`;
    grid.append(h('button', { class: 'ph-cell', type: 'button', title: m.alt || null, 'aria-label': label, onclick: e => { e.stopPropagation(); openViewer(list, i); } },
      h('img', { class: 'ph-img', src: m.url, alt: m.alt || 'photo', width: m.width, height: m.height, loading: 'lazy', decoding: 'async' })));
  });
  return grid;
}
