// Takes the metadata out of a photo the server has already sniffed (sniff.js), whatever the browser did before: camera
// details, GPS position, comments, editing history, embedded thumbnails, colour profiles. It rebuilds the file from an
// allowlist of the parts a picture needs, each cut to the size its own fields give it, so nothing can ride along in a
// part that's kept or in bytes past a part's end; bytes after the picture's end (where polyglot files hide things) go too.
//   JPEG: only DQT, DHT, DAC, DRI, SOFn, SOS (with its scan data), RSTn, DNL and EOI, each rebuilt to the length its
//         tables give it; a JFIF APP0 cut to its 16-byte header (no thumbnail) and Adobe's APP14 cut to its 12 bytes
//         (dropping it turns CMYK photos the wrong colours). Everything else goes: APP1–APP15 (EXIF with GPS, XMP, ICC,
//         IPTC, …), JFXX thumbnails, COM, JPGn and reserved markers.
//   PNG:  only the chunks that draw the picture stay (IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, sBIT, bKGD, pHYs,
//         and acTL, fcTL, fdAT when it really is an APNG), and only at their proper sizes; tEXt, zTXt, iTXt, eXIf, tIME,
//         iCCP (a colour profile has room for any text) and anything unknown go
//   GIF:  graphic control extensions are rebuilt at their fixed 4 bytes and the NETSCAPE2.0 / ANIMEXTS1.0 loop at its 3;
//         comment, plain-text and every other application extension go
//   WebP: only VP8X, VP8, VP8L, ALPH, ANIM and ANMF stay (EXIF, XMP and ICCP go, with their flags in VP8X); VP8X and
//         ANIM are cut to their fixed sizes, and an ANMF frame keeps only its picture chunks
// What can't be taken out without decoding: bytes inside the compressed picture data itself (a JPEG scan, a VP8 or
// VP8L bitstream). The browser re-encodes every photo before it's uploaded, which is what clears those.
// Pure functions on a Uint8Array.
import { formatOf, jpegSegments, pngChunks, gifBlocks, webpChunks, ascii, u32le, isSOF, BadImage } from './sniff.js';

const broken = detail => { throw new BadImage('broken', detail); };

const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

/* ------------------------------------------------------------- JPEG */

const be16 = n => [(n >> 8) & 0xff, n & 0xff];
const segment = (marker, payload) => concat([Uint8Array.from([0xff, marker, ...be16(payload.length + 2)]), payload]);

// How many bytes of a kept segment's payload `p` its own fields use (the rest is dropped), or a throw when they run past
// its end. DQT and DHT are lists of tables; anything left over that isn't a whole table means the file is broken.
function jpegNeeds(m, p) {
  const need = n => (n <= p.length ? n : broken('jpeg: segment too short'));
  if (m === 0xdb) {                                            // DQT: Pq/Tq, then 64 values of 1 or 2 bytes
    let i = 0;
    while (i < p.length) {
      if (p[i] >> 4 > 1 || (p[i] & 15) > 3) broken('jpeg: bad quantization table');
      i += 1 + 64 * ((p[i] >> 4) + 1);
    }
    return i === p.length ? i : broken('jpeg: bad quantization table');
  }
  if (m === 0xc4) {                                            // DHT: Tc/Th, 16 counts, then that many symbols
    let i = 0;
    while (i < p.length) {
      if (p[i] >> 4 > 1 || (p[i] & 15) > 3 || i + 17 > p.length) broken('jpeg: bad Huffman table');
      let n = 0;
      for (let k = 1; k <= 16; k++) n += p[i + k];
      i += 17 + n;
    }
    return i === p.length ? i : broken('jpeg: bad Huffman table');
  }
  if (m === 0xcc) return p.length - (p.length % 2) || broken('jpeg: bad DAC');   // DAC: 2 bytes a table
  if (m === 0xdd || m === 0xdc) return need(2);               // DRI, DNL
  if (isSOF(m)) return need(6 + 3 * p[need(6) - 1]);           // P, Y, X, Nf, then 3 bytes a component
  if (m === 0xda) return need(1 + 2 * p[need(1) - 1] + 3);     // Ns, 2 bytes a component, Ss, Se, Ah/Al
  return 0;
}

const KEEP_JPEG = m => m === 0xdb || m === 0xc4 || m === 0xcc || m === 0xdd || m === 0xdc || m === 0xda || isSOF(m);

function stripJpeg(b) {
  const { segs } = jpegSegments(b);
  const parts = [b.subarray(0, 2)];                            // SOI
  let jfif = false, adobe = false;
  for (const s of segs) {
    const m = s.marker;
    const p = b.subarray(s.start + 4, s.end);
    if (m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) parts.push(Uint8Array.from([0xff, m]));       // EOI, RSTn
    else if (KEEP_JPEG(m)) parts.push(segment(m, p.subarray(0, jpegNeeds(m, p))));
    else if (m === 0xe0 && !jfif && p.length >= 14 && ascii(p, 0, 5) === 'JFIF\0') {
      jfif = true;                                             // 'JFIF\0', version, units, densities; no thumbnail
      parts.push(segment(m, concat([p.subarray(0, 12), Uint8Array.from([0, 0])])));
    } else if (m === 0xee && !adobe && p.length >= 12 && ascii(p, 0, 5) === 'Adobe') {
      adobe = true;                                            // 'Adobe', version 100, no flags, the colour transform
      parts.push(segment(m, Uint8Array.from([...p.subarray(0, 5), 0, 100, 0, 0, 0, 0, Math.min(p[11], 2)])));
    }
    if (s.scan) parts.push(b.subarray(s.scan[0], s.scan[1]));
  }
  return concat(parts);
}

/* -------------------------------------------------------------- PNG */

// the chunks kept, with the data sizes they may have (a fixed size, or a test)
const PNG_KEEP = {
  IHDR: n => n === 13, PLTE: n => n > 0 && n <= 768 && n % 3 === 0, IDAT: () => true, IEND: n => n === 0,
  tRNS: n => n <= 256, gAMA: n => n === 4, cHRM: n => n === 32, sRGB: n => n === 1, sBIT: n => n >= 1 && n <= 4,
  bKGD: n => n === 1 || n === 2 || n === 6, pHYs: n => n === 9,
  acTL: n => n === 8, fcTL: n => n === 26, fdAT: n => n >= 4,
};
const APNG = new Set(['acTL', 'fcTL', 'fdAT']);

function stripPng(b) {
  const chunks = pngChunks(b);
  const animated = chunks.some(c => c.type === 'acTL' && c.len === 8);
  const keep = c => PNG_KEEP[c.type] && PNG_KEEP[c.type](c.len) && (animated || !APNG.has(c.type));
  return concat([b.subarray(0, 8), ...chunks.filter(keep).map(c => b.subarray(c.start, c.end))]);
}

/* -------------------------------------------------------------- GIF */

const LOOPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

// an extension block rebuilt from what a picture needs, or null to drop it
function gifExtension(b, x) {
  const first = x.start + 2;                                   // its first sub-block's length byte
  if (x.label === 0xf9) {                                      // graphic control: frame timing and transparency
    return b[first] >= 4 ? Uint8Array.from([0x21, 0xf9, 4, ...b.subarray(first + 1, first + 5), 0]) : null;
  }
  if (x.label === 0xff && b[first] === 11 && LOOPS.has(ascii(b, first + 1, 11))) {
    const d = first + 12;                                      // the loop sub-block: 1, then the loop count
    if (d < x.end && b[d] >= 3 && b[d + 1] === 1) return Uint8Array.from([0x21, 0xff, 11, ...b.subarray(first + 1, first + 12), 3, 1, b[d + 2], b[d + 3], 0]);
  }
  return null;                                                 // comment (FE), plain text (01), other applications, unknown
}

function stripGif(b) {
  const { head, blocks } = gifBlocks(b);
  return concat([b.subarray(0, head), ...blocks.map(x => (x.kind === 'ext' ? gifExtension(b, x) : b.subarray(x.start, x.end))).filter(Boolean)]);
}

/* ------------------------------------------------------------- WebP */

const le32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const riffChunk = (type, payload) => concat([Uint8Array.from([...type].map(ch => ch.charCodeAt(0))), Uint8Array.from(le32(payload.length)), payload,
  new Uint8Array(payload.length & 1)]);

// the chunks found in b[from, to): { type, data, len } (data: the payload's offset). Bytes at the end that don't make a
// whole chunk are left out.
function chunksIn(b, from, to) {
  const out = [];
  for (let i = from; i + 8 <= to;) {
    const len = u32le(b, i + 4);
    if (i + 8 + len > to) break;
    out.push({ type: ascii(b, i, 4), data: i + 8, len });
    i += 8 + len + (len & 1);
  }
  return out;
}

const FRAME = new Set(['ALPH', 'VP8 ', 'VP8L']);

function webpChunk(b, c) {
  const p = b.subarray(c.data, c.data + c.len);
  if (c.type === 'VP8X') {
    if (c.len < 10) broken('webp: bad header');
    const head = p.slice(0, 10);
    head[0] &= ~0x2c;                                          // no ICC (0x20), EXIF (0x08) or XMP (0x04) any more
    return riffChunk('VP8X', head);
  }
  if (c.type === 'ANIM') return riffChunk('ANIM', p.subarray(0, 6));
  if (c.type === 'ANMF') {                                     // a frame: 16 bytes of placing and timing, then its picture
    if (c.len < 16) broken('webp: bad frame');
    const inner = chunksIn(b, c.data + 16, c.data + c.len).filter(x => FRAME.has(x.type));
    return riffChunk('ANMF', concat([p.subarray(0, 16), ...inner.map(x => riffChunk(x.type, b.subarray(x.data, x.data + x.len)))]));
  }
  return riffChunk(c.type, p);                                 // VP8, VP8L, ALPH: the picture itself
}

const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);

function stripWebp(b) {
  const body = concat(webpChunks(b).filter(c => WEBP_KEEP.has(c.type)).map(c => webpChunk(b, c)));
  return concat([Uint8Array.from([...b.subarray(0, 4), ...le32(body.length + 4), ...b.subarray(8, 12)]), body]);
}

const STRIP = { jpeg: stripJpeg, png: stripPng, gif: stripGif, webp: stripWebp };

// the same picture without its metadata (a new Uint8Array); throws BadImage for anything sniff() would refuse
export function strip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = formatOf(b);
  if (!format) throw new BadImage('type');
  const out = STRIP[format](b);
  if (format === 'webp' && u32le(out, 4) + 8 !== out.length) throw new BadImage('broken', 'webp: size');
  return out;
}
