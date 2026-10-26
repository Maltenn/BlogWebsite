/* widgets/photos.js — putting photos on a post. Two parts:
     prepareImage()   the browser's half of the pipeline: decode (rotated the way the camera meant), shrink to 1600 px on the
                      long side (a picture: a centred 300 px square), encode again as JPEG (or WebP when that's smaller; PNG
                      when there is transparency), which leaves out the EXIF and GPS. A small GIF goes up as it is. The
                      Worker checks everything again and strips the metadata itself; this half only keeps the files small.
     photoPicker()    the 📷 button, the thumbnails (a preview, a description field, a ✕, upload progress) and the list of
                      uploaded ids for the post's create call.
   Previews are data: URLs (the page's CSP allows data: images, not blob:). */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';

export const LONG_SIDE = 1600;          // a photo's longest side after shrinking
export const AVATAR_SIDE = 300;         // a picture: a square this big
export const MAX_BYTES = 2 * 1024 * 1024;
export const GIF_SIDE = 800;            // a GIF up to this wide and tall (and 2 MB) goes up untouched
export const ALT_MAX = 200;
const QUALITIES = [0.85, 0.7, 0.55];

// the size after shrinking so that the longer side is at most `max` (never bigger than the original)
export function fitWithin(w, hh, max) {
  const s = Math.min(1, max / Math.max(w, hh));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(hh * s)) };
}
// the centred square of a w × hh picture: where to start cutting and how long its side is
export function centreSquare(w, hh) {
  const side = Math.min(w, hh);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((hh - side) / 2), side };
}
export const isHeic = f => /hei[cf]/i.test(f.type || '') || /\.hei[cf]$/i.test(f.name || '');

const WHY_NOT = f => (isHeic(f)
  ? 'this browser can\'t open HEIC photos. export it as a JPEG first (on an iPhone: Settings → Camera → Formats → Most Compatible), then try again.'
  : 'that file isn\'t a picture this browser can open. use a JPEG, PNG, GIF or WebP.');

// the real browser's tools; tests hand prepareImage fakes of the same three
function browserEnv() {
  return {
    decode: async f => {
      try { return await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch { return createImageBitmap(f); }
    },
    canvas: (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; },
    encode: (c, type, q) => new Promise(resolve => c.toBlob(resolve, type, q)),
  };
}

function hasAlpha(ctx, w, hh) {
  const d = ctx.getImageData(0, 0, w, hh).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// file → { blob, width, height, mime, kept } ready to upload; throws an Error with a plain message when it can't be done.
// opts.avatar: a centred square, 300 px. opts.env: the browser's tools (for tests).
export async function prepareImage(file, { avatar = false, env = browserEnv() } = {}) {
  let bmp;
  try { bmp = await env.decode(file); } catch { throw new Error(WHY_NOT(file)); }
  try {
    const sw = bmp.width, sh = bmp.height;
    if (!avatar && file.type === 'image/gif' && file.size <= MAX_BYTES && sw <= GIF_SIDE && sh <= GIF_SIDE) {
      return { blob: file, width: sw, height: sh, mime: 'image/gif', kept: true };   // it's 2006: let it dance
    }
    let src = { sx: 0, sy: 0, sw, sh };
    let out;
    if (avatar) {
      const sq = centreSquare(sw, sh);
      src = { sx: sq.sx, sy: sq.sy, sw: sq.side, sh: sq.side };
      const side = Math.min(AVATAR_SIDE, sq.side);
      out = { w: side, h: side };
    } else out = fitWithin(sw, sh, LONG_SIDE);
    const canvas = env.canvas(out.w, out.h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, src.sx, src.sy, src.sw, src.sh, 0, 0, out.w, out.h);
    const clear = file.type !== 'image/jpeg' && hasAlpha(ctx, out.w, out.h);        // a see-through PNG stays PNG
    let blob = null;
    if (clear) {
      blob = await env.encode(canvas, 'image/png');
      if (blob && blob.size > MAX_BYTES) { blob = null; }
    }
    if (!blob) {
      if (clear) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.w, out.h); }   // too big as PNG: flatten
      for (const q of QUALITIES) {
        const jpeg = await env.encode(canvas, 'image/jpeg', q);
        let best = jpeg;
        if (!avatar) {                                                                // WebP when the browser can make one and it's smaller
          const webp = await env.encode(canvas, 'image/webp', q);
          if (webp && webp.type === 'image/webp' && jpeg && webp.size < jpeg.size) best = webp;
        }
        if (best && best.size <= MAX_BYTES) { blob = best; break; }
      }
    }
    if (!blob) throw new Error('that photo is still over 2 MB after shrinking it. try a smaller one.');
    return { blob, width: out.w, height: out.h, mime: blob.type, kept: false };
  } finally { if (bmp && bmp.close) bmp.close(); }
}

export function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('couldn\'t read that file.'));
    r.readAsDataURL(blob);
  });
}

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
