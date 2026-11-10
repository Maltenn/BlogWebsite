// Small image files built byte by byte, for the photo tests (test/media.test.mjs, test/api.test.mjs) and the demo's
// sample photos (tools/demo.mjs). png() makes a real, drawable PNG (deflated with node:zlib); jpeg(), gif() and webp()
// make files with the real structure of their format (markers, chunks, blocks, sizes) and whatever metadata a test
// asks for: an EXIF block with a GPS position, XMP, comments, text chunks. Their picture data is filler, which is all the
// server's walkers look at (they never decode pixels).
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u8 = (...parts) => Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const be16 = n => [(n >> 8) & 0xff, n & 0xff];
const be32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = n => [n & 0xff, (n >> 8) & 0xff];
const le24 = n => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = n => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

// a fake GPS position as a camera writes it: a TIFF header, IFD0 pointing at a GPS IFD with latitude and longitude
// (37°46'30" N, 122°25'10" W), make/model text. Its marker text is "GPS-SECRET-37.7750" so a test can look for it.
export function exifGps() {
  const tiff = [];
  const put = (...xs) => tiff.push(...xs.flat());
  put('MM'.split('').map(ch => ch.charCodeAt(0)), be16(42), be32(8));
  // IFD0: 2 entries: Make (ASCII, at 50) and GPS IFD pointer
  put(be16(2));
  put(be16(0x010f), be16(2), be32(18), be32(50));
  put(be16(0x8825), be16(4), be32(1), be32(68));
  put(be32(0));
  while (tiff.length < 50) tiff.push(0);
  put([...'GPS-SECRET-37.7750\0'].map(ch => ch.charCodeAt(0)));
  while (tiff.length < 68) tiff.push(0);
  // GPS IFD: LatitudeRef N, Latitude (3 rationals at 128), LongitudeRef W, Longitude (at 152)
  put(be16(4));
  put(be16(1), be16(2), be32(2), ['N'.charCodeAt(0), 0, 0, 0]);
  put(be16(2), be16(5), be32(3), be32(128));
  put(be16(3), be16(2), be32(2), ['W'.charCodeAt(0), 0, 0, 0]);
  put(be16(4), be16(5), be32(3), be32(152));
  put(be32(0));
  while (tiff.length < 128) tiff.push(0);
  put(be32(37), be32(1), be32(46), be32(1), be32(30), be32(1));
  put(be32(122), be32(1), be32(25), be32(1), be32(10), be32(1));
  return u8('Exif\0\0', tiff);
}

const seg = (marker, payload) => u8([0xff, marker], be16(payload.length + 2), payload);

// A baseline JPEG's structure: SOI, APP0 JFIF, then the extras asked for, DQT, SOF0 (width × height, 3 components),
// DHT, SOS, scan data (with a stuffed FF 00 and a restart marker, as real scans have), EOI, then `trailing` bytes.
// gps: an APP1 EXIF block with a GPS position; xmp: an APP1 XMP packet; comment: a COM segment; icc: an APP2 ICC
// profile; iptc: APP13; adobe: Adobe's APP14; laterComment: a COM between two scans (progressive files can have them).
export function jpeg({ width = 64, height = 48, gps = false, xmp = false, comment = '', icc = false, iptc = false, adobe = false, laterComment = '', trailing = '' } = {}) {
  const parts = [[0xff, 0xd8], seg(0xe0, u8('JFIF\0', [1, 1, 0], be16(72), be16(72), [0, 0]))];
  if (gps) parts.push(seg(0xe1, exifGps()));
  if (xmp) parts.push(seg(0xe1, u8('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta><exif:GPSLatitude>37,46.5N</exif:GPSLatitude></x:xmpmeta>')));
  if (icc) parts.push(seg(0xe2, u8('ICC_PROFILE\0', [1, 1], 'fake profile by Phone Maker')));
  if (iptc) parts.push(seg(0xed, u8('Photoshop 3.0\0', '8BIM IPTC city=Springfield')));
  if (adobe) parts.push(seg(0xee, u8('Adobe', be16(100), be16(0), be16(0), [1])));
  if (comment) parts.push(seg(0xfe, u8(comment)));
  parts.push(seg(0xdb, u8([0], Array(64).fill(1))));
  parts.push(seg(0xc0, u8([8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0])));
  parts.push(seg(0xc4, u8([0], Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0)), [0])));
  parts.push(seg(0xda, u8([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])));
  parts.push([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  if (laterComment) {
    parts.push(seg(0xfe, u8(laterComment)));
    parts.push(seg(0xda, u8([1, 1, 0, 0, 63, 0])), [0xab, 0xcd]);
  }
  parts.push([0xff, 0xd9]);
  if (trailing) parts.push(u8(trailing));
  return u8(...parts.map(p => u8(p)));
}

const chunk = (type, data) => {
  const body = u8(type, data);
  return u8(be32(data.length), body, be32(crc32(body)));
};

// A real PNG: 8-bit RGB, width × height, each pixel from draw(x, y) → [r, g, b] (a soft gradient by default). chunks:
// extra [type, data] chunks placed before the picture data (tEXt, eXIf, iTXt, tIME …); after: more after IDAT;
// trailing: bytes after IEND. stored: no compression at all (for a big file).
export function png({ width = 64, height = 48, draw, chunks = [], after = [], trailing = '', stored = false } = {}) {
  const f = draw || ((x, y) => [(x * 255 / Math.max(1, width - 1)) | 0, (y * 255 / Math.max(1, height - 1)) | 0, 160]);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b] = f(x, y); raw[i++] = r; raw[i++] = g; raw[i++] = b; }
  }
  return u8(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', u8(be32(width), be32(height), [8, 2, 0, 0, 0])),
    ...chunks.map(([t, d]) => chunk(t, u8(d))),
    chunk('IDAT', zlib.deflateSync(raw, { level: stored ? 0 : 9 })),
    ...after.map(([t, d]) => chunk(t, u8(d))),
    chunk('IEND', Buffer.alloc(0)),
    u8(trailing),
  );
}

// a GIF89a's structure: width × height, a 2-colour global table, `frames` images (each a 1×1 LZW block), and the
// extensions asked for: comment, netscape (the animation loop), xmp (an XMP application extension), plainText
export function gif({ width = 32, height = 32, frames = 1, comment = '', netscape = frames > 1, xmp = false, plainText = false, trailing = '' } = {}) {
  const parts = [u8('GIF89a', le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255])];
  if (netscape) parts.push(u8([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]));
  const xmpText = '<x:xmpmeta>GPS 37.7750 -122.4194</x:xmpmeta>';
  if (xmp) parts.push(u8([0x21, 0xff, 11], 'XMP DataXMP', [xmpText.length], xmpText, [0]));
  if (comment) parts.push(u8([0x21, 0xfe, comment.length], comment, [0]));
  if (plainText) parts.push(u8([0x21, 0x01, 12], Array(12).fill(0), [5], 'hello', [0]));
  for (let f = 0; f < frames; f++) {
    parts.push(u8([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
    parts.push(u8([0x2c], le16(0), le16(0), le16(1), le16(1), [0], [2, 2, 0x44, 0x01, 0]));
  }
  parts.push(u8([0x3b]), u8(trailing));
  return u8(...parts);
}

// a WebP's structure. kind VP8L (lossless, the default), VP8 (lossy) or VP8X (extended, holding a VP8L); exif and xmp
// add those chunks (VP8X only, with their flags set); animated sets the animation flag and an ANIM chunk.
export function webp({ width = 40, height = 30, kind = 'VP8L', exif = false, xmp = false, animated = false } = {}) {
  const sub = (type, data) => {
    const d = u8(data);
    return u8(type, le32(d.length), d, d.length & 1 ? [0] : []);
  };
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = sub('VP8L', u8([0x2f], le32(bits >>> 0), [0x10, 0x88, 0x88, 0x08]));
  const vp8 = sub('VP8 ', u8([0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a], le16(width), le16(height), Array(8).fill(0x11)));
  let body;
  if (kind === 'VP8L') body = vp8l;
  else if (kind === 'VP8') body = vp8;
  else {
    const flags = (exif ? 0x08 : 0) | (xmp ? 0x04 : 0) | (animated ? 0x02 : 0);
    body = u8(sub('VP8X', u8([flags, 0, 0, 0], le24(width - 1), le24(height - 1))),
      animated ? sub('ANIM', u8([0, 0, 0, 0], le16(0))) : [],
      animated ? sub('ANMF', u8(Array(16).fill(0), vp8l)) : vp8l,
      exif ? sub('EXIF', exifGps().subarray(6)) : [],
      xmp ? sub('XMP ', u8('<x:xmpmeta>GPS 37.7750 -122.4194</x:xmpmeta>')) : []);
  }
  return u8('RIFF', le32(body.length + 4), 'WEBP', body);
}
