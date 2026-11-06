/* core/image.js — the browser's half of the photo pipeline: decode a file the way the camera meant it, shrink it
   (1600 px on the long side; a profile picture is a centred 300 px square), and encode it again as JPEG, WebP or PNG,
   which leaves the EXIF and the GPS behind. A small GIF goes up untouched. The Worker checks all of it again and
   strips the metadata itself; this half only keeps the files small.

   It lives in core/ rather than in widgets/ because it is pure image work with no interface in it, and because
   core/joinphoto.js (the camera button the apps put on the sign-up screen) needs it: CONVENTIONS.md says core/ may
   import nothing above itself, and test/static.test.mjs enforces that. widgets/photos.js, which owns the 📷 button
   and the thumbnails, re-exports everything here so that every existing import of it keeps working.

   Previews are data: URLs (the page's CSP allows data: images, not blob:). */

export const LONG_SIDE = 1600;          // a photo's longest side after shrinking
export const AVATAR_SIDE = 300;         // a picture: a square this big
export const MAX_BYTES = 2 * 1024 * 1024;
export const GIF_SIDE = 800;            // a GIF up to this wide and tall (and 2 MB) goes up untouched
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
