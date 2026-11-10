// What an uploaded file really is, read from its bytes, never from its name or the type the browser claims: JPEG, PNG,
// GIF or WebP, with its size in pixels and whether it moves. Each format is walked from end to end (JPEG segments, PNG
// chunks, GIF blocks, WebP chunks), so a file that is cut off, or that only starts like a picture, is refused. Anything
// else (SVG, HTML, HEIC, PDF, …) is refused too. Pure functions on a Uint8Array; strip.js rebuilds the same walks
// without the metadata. Tested in test/media.test.mjs with byte-built fixtures.

export const TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

// a reason a file was refused: 'type' (not one of ours) or 'broken' (cut off or malformed)
export class BadImage extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}
const broken = detail => { throw new BadImage('broken', detail); };

export const u16be = (b, i) => (b[i] << 8) | b[i + 1];
export const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
export const u16le = (b, i) => b[i] | (b[i + 1] << 8);
export const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
export const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
export const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const starts = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// which of our formats the first bytes say this is, or null
export function formatOf(b) {
  if (starts(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (starts(b, PNG_SIG)) return 'png';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/* ------------------------------------------------------------- JPEG */

// SOFn markers (C4 DHT, C8 JPG and CC DAC are not frames)
export const isSOF = m => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const standalone = m => (m >= 0xd0 && m <= 0xd7) || m === 0x01;

// Every marker segment of a JPEG, in order: { marker, start, end } (end exclusive; a segment runs from its FF to the
// end of its payload), plus `scan` ranges of entropy-coded data after each SOS, and `eoi`, the offset just past EOI.
// Bytes after EOI are not part of the picture.
export function jpegSegments(b) {
  const segs = [];
  let i = 2, eoi = -1;
  while (i < b.length) {
    if (b[i] !== 0xff) broken('jpeg: expected a marker');
    while (b[i] === 0xff && b[i + 1] === 0xff) i++;          // fill bytes
    if (i + 1 >= b.length) broken('jpeg: cut off');
    const m = b[i + 1];
    if (m === 0xd9) { segs.push({ marker: m, start: i, end: i + 2 }); eoi = i + 2; break; }
    if (m === 0xd8 || m === 0x00) broken('jpeg: stray marker');
    if (standalone(m)) { segs.push({ marker: m, start: i, end: i + 2 }); i += 2; continue; }
    if (i + 4 > b.length) broken('jpeg: cut off');
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) broken('jpeg: segment runs past the end');
    const seg = { marker: m, start: i, end: i + 2 + len };
    segs.push(seg);
    i = seg.end;
    if (m === 0xda) {                                          // entropy-coded data up to the next real marker
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) broken('jpeg: cut off in the picture data');
      seg.scan = [i, j];
      i = j;
    }
  }
  if (eoi < 0) broken('jpeg: no end marker');
  return { segs, eoi };
}

function jpegInfo(b) {
  const { segs } = jpegSegments(b);
  const sof = segs.find(s => isSOF(s.marker));
  if (!sof || sof.end - sof.start < 10) broken('jpeg: no frame header');
  if (!segs.some(s => s.marker === 0xda)) broken('jpeg: no picture data');
  return { width: u16be(b, sof.start + 7), height: u16be(b, sof.start + 5), animated: false };
}

/* -------------------------------------------------------------- PNG */

// every chunk: { type, start, end, data } (start at its length field, end past its CRC), up to and including IEND
export function pngChunks(b) {
  const chunks = [];
  let i = 8;
  for (;;) {
    if (i + 12 > b.length) broken('png: cut off');
    const len = u32be(b, i);
    const end = i + 12 + len;
    if (end > b.length) broken('png: chunk runs past the end');
    const type = ascii(b, i + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) broken('png: bad chunk type');
    chunks.push({ type, start: i, end, data: i + 8, len });
    i = end;
    if (type === 'IEND') return chunks;
  }
}

function pngInfo(b) {
  const chunks = pngChunks(b);
  if (chunks[0].type !== 'IHDR' || chunks[0].len !== 13) broken('png: no header');
  if (!chunks.some(c => c.type === 'IDAT')) broken('png: no picture data');
  const d = chunks[0].data;
  return { width: u32be(b, d), height: u32be(b, d + 4), animated: chunks.some(c => c.type === 'acTL') };
}

/* -------------------------------------------------------------- GIF */

// the sub-blocks starting at i (each a length byte, then that many bytes; a 0 ends them): the offset past the end
function subBlocks(b, i) {
  for (;;) {
    if (i >= b.length) broken('gif: cut off');
    const n = b[i];
    i += 1 + n;
    if (n === 0) return i;
  }
}

// Every block after the header and global color table: { kind: 'image' | 'ext', label, start, end }, ending with the
// trailer. `head` is where the blocks start.
export function gifBlocks(b) {
  if (b.length < 13) broken('gif: cut off');
  const packed = b[10];
  let i = 13 + (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);
  const head = i;
  const blocks = [];
  for (;;) {
    if (i >= b.length) broken('gif: no trailer');
    const start = i;
    const t = b[i];
    if (t === 0x00) { i++; continue; }                         // a stray block terminator (common; decoders skip it)
    if (t === 0x3b) { blocks.push({ kind: 'trailer', start, end: i + 1 }); return { head, blocks }; }
    if (t === 0x2c) {
      if (i + 10 > b.length) broken('gif: cut off');
      const p = b[i + 9];
      i += 10 + (p & 0x80 ? 3 * (2 << (p & 7)) : 0);
      i = subBlocks(b, i + 1);                                 // (LZW minimum code size, then the data)
      blocks.push({ kind: 'image', start, end: i });
    } else if (t === 0x21) {
      if (i + 2 > b.length) broken('gif: cut off');
      const label = b[i + 1];
      i = subBlocks(b, i + 2);
      blocks.push({ kind: 'ext', label, start, end: i });
    } else broken('gif: unknown block');
  }
}

function gifInfo(b) {
  const { blocks } = gifBlocks(b);
  const frames = blocks.filter(x => x.kind === 'image').length;
  if (!frames) broken('gif: no picture');
  return { width: u16le(b, 6), height: u16le(b, 8), animated: frames > 1 };
}

/* ------------------------------------------------------------- WebP */

// every chunk inside the RIFF: { type, start, end, data, len } (end includes the pad byte)
export function webpChunks(b) {
  const size = u32le(b, 4);
  if (size < 4 || size + 8 > b.length) broken('webp: cut off');
  const stop = size + 8;
  const chunks = [];
  let i = 12;
  while (i < stop) {
    if (i + 8 > stop) broken('webp: cut off');
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > stop) broken('webp: chunk runs past the end');
    chunks.push({ type, start: i, end: Math.min(end, stop), data: i + 8, len });
    i = end;
  }
  return chunks;
}

function webpInfo(b) {
  const chunks = webpChunks(b);
  const first = chunks[0];
  if (!first) broken('webp: empty');
  const d = first.data;
  if (first.type === 'VP8X') {
    if (first.len < 10) broken('webp: bad header');
    const animated = !!(b[d] & 0x02) || chunks.some(c => c.type === 'ANIM');
    if (!chunks.some(c => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) broken('webp: no picture data');
    return { width: 1 + u24le(b, d + 4), height: 1 + u24le(b, d + 7), animated };
  }
  if (first.type === 'VP8 ') {
    if (first.len < 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) broken('webp: bad VP8 header');
    return { width: u16le(b, d + 6) & 0x3fff, height: u16le(b, d + 8) & 0x3fff, animated: false };
  }
  if (first.type === 'VP8L') {
    if (first.len < 5 || b[d] !== 0x2f) broken('webp: bad VP8L header');
    const bits = u32le(b, d + 1);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), animated: false };
  }
  broken('webp: unknown first chunk');
}

/* ------------------------------------------------------------ answer */

const INFO = { jpeg: jpegInfo, png: pngInfo, gif: gifInfo, webp: webpInfo };

// { format, mime, ext, width, height, animated } for a JPEG, PNG, GIF or WebP that is whole; throws BadImage otherwise
export function sniff(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = formatOf(b);
  if (!format) throw new BadImage('type');
  const info = INFO[format](b);
  if (!(info.width > 0 && info.height > 0)) broken('no size');
  return { format, ...TYPES[format], ...info };
}
