/* widgets/songs.js — someone's Spotify top songs, with 30-second previews
   (one at a time; leaving the page stops it). */

import { h } from '../core/dom.js';
import { toast } from '../core/ui.js';
import { onLeave } from '../core/router.js';

let audio = null;                 // a song preview, if one is playing

function stopSong() {
  if (audio) { audio.pause(); audio = null; }
  document.querySelectorAll('.sp-play.on').forEach(b => { b.classList.remove('on'); b.textContent = '▶'; });
}

// someone's Spotify top songs: art, title, artist, a 30-second preview, a link to the song on Spotify
export function topSongs(sp) {
  onLeave(stopSong);                                // leaving the page stops a playing preview
  const list = h('ol', { class: 'sp-list' });
  sp.tracks.forEach(t => {
    const play = h('button', { class: 'btn98 sp-play', type: 'button', text: '▶', title: t.preview ? 'play a 30-second preview' : 'no preview for this one', disabled: !t.preview, 'aria-label': `preview ${t.name}` });
    play.addEventListener('click', () => {
      const was = play.classList.contains('on');
      stopSong();
      if (was || !t.preview) return;
      audio = new Audio(t.preview);
      audio.volume = 0.4;
      audio.addEventListener('ended', stopSong);
      audio.play().then(() => { play.classList.add('on'); play.textContent = '⏹'; }).catch(() => { toast('that preview won\'t play right now.', true); stopSong(); });
    });
    const art = t.image ? h('img', { class: 'sp-art', src: t.image, alt: '', loading: 'lazy' }) : h('span', { class: 'sp-art' });
    if (t.image) art.addEventListener('error', () => art.replaceWith(h('span', { class: 'sp-art' })), { once: true });
    list.append(h('li', { class: 'sp-row' }, art,
      h('span', { class: 'sp-mid' }, h('span', { class: 'sp-name', text: t.name }), h('span', { class: 'sp-artist', text: t.artist })),
      play,
      t.url ? h('a', { class: 'sp-open', href: t.url, target: '_blank', rel: 'noopener', title: 'open in Spotify', text: '↗' }) : null));
  });
  return h('div', null, list, h('div', { class: 'ms-songnote', text: `♫ via Spotify · ${sp.range} · previews from Apple Music` }));
}
