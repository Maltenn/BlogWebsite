/* widgets/photos.js — putting photos on a post:
     photoPicker()    the 📷 button, the thumbnails (a preview, a description field, a ✕, upload progress) and the list of
                      uploaded ids for the post's create call.
     uploadAvatar()   the same, for one profile picture.
   The pipeline that shrinks and re-encodes a file (prepareImage, readDataUrl and the sizes) moved to core/image.js, so
   that core/joinphoto.js can use it without core/ importing a widget; it is re-exported below, so every existing
   `from '../widgets/photos.js'` still works. Previews are data: URLs (the CSP allows data: images, not blob:). */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';
import { prepareImage, readDataUrl } from '../core/image.js';

// The pipeline itself lives in core/image.js (core/ may not import widgets/, and core/joinphoto.js needs it);
// re-exported here so every existing `from '../widgets/photos.js'` keeps working.
export { AVATAR_SIDE, GIF_SIDE, LONG_SIDE, MAX_BYTES, centreSquare, fitWithin, isHeic, prepareImage, readDataUrl } from '../core/image.js';

export const ALT_MAX = 200;

// the real work, replaceable in tests: shrink, preview, upload
const REAL_IO = {
  prepare: prepareImage,
  preview: readDataUrl,
  upload: (blob, purpose, onProgress, signal) => api.upload(`/media?purpose=${purpose}`, blob, onProgress, signal).then(r => r.media),
};

// Uploads a picture (a square, 300 px) for a profile: resolves { url, id, preview } where url is '/media/<key>'.
export async function uploadAvatar(file, io = REAL_IO) {
  const p = await io.prepare(file, { avatar: true });
  const preview = await io.preview(p.blob);
  const m = await io.upload(p.blob, 'avatar');
  return { url: m.url, id: m.id, preview };
}

// opts: max (4), purpose ('post' | 'cover'), label (the button), onChange(), io (tests).
// Returns { el, media(), count(), busy(), reset(), discard(), add(files) }.
//   media(): what a create call takes: [id | { id, alt }]. reset(): forget them (the post took them). discard(): take back
//   the uploads that were never posted (a cancelled window).
export function photoPicker(opts = {}) {
  const max = opts.max || 4;
  const purpose = opts.purpose || 'post';
  const io = opts.io || REAL_IO;
  const entries = [];
  const input = h('input', { type: 'file', accept: 'image/*', multiple: max > 1, hidden: true, 'aria-label': max > 1 ? 'choose photos' : 'choose a photo', tabindex: -1 });
  const addBtn = h('button', { class: 'btn98 ph-add', type: 'button', text: opts.label || (max > 1 ? '📷 Photos' : '📷 Photo'), title: max > 1 ? `add up to ${max} photos` : 'add a photo', onclick: () => input.click() });
  const strip = h('div', { class: 'ph-strip' });
  const el = h('div', { class: 'ph-picker' }, h('div', { class: 'ph-bar' }, addBtn, input, h('span', { class: 'os-hint ph-hint', text: max > 1 ? `up to ${max}` : 'one photo' })), strip);

  const changed = () => {
    addBtn.disabled = entries.length >= max;
    if (opts.onChange) opts.onChange();
  };
  const forget = en => {
    en.gone = true;
    if (en.ctl) en.ctl.abort();
    const i = entries.indexOf(en);
    if (i >= 0) entries.splice(i, 1);
    en.tile.remove();
  };
  const takeBack = en => { if (en.id != null) api.del('/media/' + en.id).catch(() => {}); };

  function start(file) {
    const thumb = h('img', { class: 'ph-thumb', alt: 'preview', width: 64, height: 64 });
    const bar = h('progress', { class: 'ph-progress', max: 100, value: 0 });
    const alt = h('input', { class: 'os-input ph-alt', maxLength: ALT_MAX, placeholder: 'describe it (optional)', 'aria-label': 'photo description' });
    const remove = h('button', { class: 'btn98 ph-x', type: 'button', text: '✕', title: 'remove this photo', 'aria-label': 'remove this photo' });
    const state = h('div', { class: 'os-hint ph-state', text: 'getting it ready…' });
    const tile = h('div', { class: 'ph-tile is-busy' }, thumb, h('div', { class: 'ph-side' }, state, bar, alt), remove);
    const en = { tile, alt, id: null, done: false, gone: false, ctl: typeof AbortController !== 'undefined' ? new AbortController() : null };
    remove.addEventListener('click', () => { forget(en); takeBack(en); changed(); });
    entries.push(en);
    strip.append(tile);
    (async () => {
      try {
        const p = await io.prepare(file);
        if (en.gone) return;
        io.preview(p.blob).then(u => { if (!en.gone) thumb.src = u; }, () => {});
        state.textContent = 'uploading…';
        const m = await io.upload(p.blob, purpose, f => { bar.value = Math.round(f * 100); }, en.ctl && en.ctl.signal);
        if (en.gone) { en.id = m.id; takeBack(en); return; }
        en.id = m.id;
        en.done = true;
        tile.classList.remove('is-busy');
        state.textContent = `${m.width} × ${m.height}`;
        bar.hidden = true;
      } catch (e) {
        if (en.gone || (e && e.aborted)) return;
        forget(en);
        oops(e);
      }
      changed();
    })();
  }

  function add(files) {
    const list = [...files].filter(f => f);
    if (!list.length) return;
    const room = max - entries.length;
    if (list.length > room) toast(room >= max ? `up to ${max} photo${max > 1 ? 's' : ''} here: using the first ${max > 1 ? max : 'one'}.` : room > 0 ? `only ${room} more fit here (up to ${max}).` : `up to ${max} photo${max > 1 ? 's' : ''} here.`, true);
    list.slice(0, Math.max(0, room)).forEach(start);
    changed();
  }
  input.addEventListener('change', () => { add(input.files ? [...input.files] : []); input.value = ''; });

  return {
    el, add,
    media: () => entries.filter(e => e.done).map(e => { const a = e.alt.value.trim(); return a ? { id: e.id, alt: a } : e.id; }),
    count: () => entries.filter(e => e.done).length,
    busy: () => entries.some(e => !e.done),
    reset() { entries.splice(0).forEach(e => { e.gone = true; e.tile.remove(); }); changed(); },
    discard() { entries.splice(0).forEach(e => { e.gone = true; if (e.ctl) e.ctl.abort(); takeBack(e); e.tile.remove(); }); changed(); },
  };
}
