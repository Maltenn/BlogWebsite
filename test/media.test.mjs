// Photo checks: `npm test`. The server's own reading of an upload (src/media/sniff.js: which of JPEG, PNG, GIF and
// WebP it really is, how big, whether it moves, whether it's whole) and its metadata stripper (src/media/strip.js), on
// files built byte by byte (helpers/images.mjs) with a GPS position, XMP, comments and text chunks in them, and on the
// real GIFs in public/assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sniff, BadImage, jpegSegments, pngChunks, gifBlocks, webpChunks } from '../src/media/sniff.js';
import { strip } from '../src/media/strip.js';
import { jpeg, png, gif, webp, exifGps } from './helpers/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));
const refused = (bytes, reason) => assert.throws(() => sniff(bytes), e => e instanceof BadImage && e.reason === reason);
const SECRETS = ['GPS-SECRET', 'Exif\0\0', 'xmpmeta', 'GPSLatitude', '37.7750', 'Phone Maker', 'Springfield', 'secret note', 'ICC_PROFILE'];
const clean = bytes => { for (const s of SECRETS) assert.ok(!has(bytes, s), `"${s.replace(/\0/g, '\\0')}" is gone`); };
// sharp (an image library wrangler's miniflare brings along) decodes the stripped files for real; skipped without it
const sharp = (() => { try { return createRequire(import.meta.url)('sharp'); } catch { return null; } })();

// byte builders for files written to smuggle things through the stripper
const MARK = 'GPSLAT51.5007';
const L = s => [...Buffer.from(s, 'latin1')];
const b16 = n => [n >> 8, n & 255];
const l16 = n => [n & 255, n >> 8];
const l32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const jseg = (m, payload) => [0xff, m, ...b16(payload.length + 2), ...payload];
const J_APP0 = jseg(0xe0, L('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
const J_DQT = jseg(0xdb, [0, ...Array(64).fill(1)]);
const J_SOF = jseg(0xc0, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]);
const J_DHT = jseg(0xc4, [0, 1, ...Array(15).fill(0), 0]);
const J_SOS = jseg(0xda, [1, 1, 0, 0, 63, 0]);
const jpegOf = (...mid) => Buffer.from([0xff, 0xd8, ...mid.flat(), 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
const wchunk = (t, d) => [...L(t), ...l32(d.length), ...d, ...(d.length & 1 ? [0] : [])];
const W_VP8L = wchunk('VP8L', [0x2f, ...l32(9 | (9 << 14)), 0x10, 0x88, 0x88, 0x08]);
const W_VP8X = flags => wchunk('VP8X', [flags, 0, 0, 0, 9, 0, 0, 9, 0, 0]);
const webpOf = (...c) => { const body = c.flat(); return Buffer.from([...L('RIFF'), ...l32(body.length + 4), ...L('WEBP'), ...body]); };

/* -------------------------------------------------------------- JPEG */

test('JPEG: sniffed with its size; the EXIF GPS block, XMP, ICC, IPTC and every comment come out, the picture stays', () => {
  const dirty = jpeg({ width: 640, height: 480, gps: true, xmp: true, icc: true, iptc: true, comment: 'secret note', laterComment: 'secret note 2' });
  assert.ok(has(dirty, 'GPS-SECRET') && has(dirty, 'Exif\0\0'), 'the fixture really carries a GPS position');
  assert.ok(has(exifGps(), 'MM\0*'), 'in a TIFF header, as cameras write it');
  assert.deepEqual(sniff(dirty), { format: 'jpeg', mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480, animated: false });
  const out = strip(dirty);
  clean(out);
  assert.deepEqual(sniff(out), sniff(dirty), 'still a whole JPEG of the same size');
  const markers = jpegSegments(out).segs.map(s => s.marker.toString(16));
  assert.deepEqual(markers, ['e0', 'db', 'c0', 'c4', 'da', 'da', 'd9'], 'only JFIF, tables, frame, scans and the end are left');
  // the scan data is copied byte for byte (stuffed FF 00 and the restart marker included)
  assert.ok(has(out, Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]).toString('latin1')));
  assert.equal(strip(out).length, out.length, 'stripping twice changes nothing');
});

test('JPEG: Adobe\'s APP14 colour marker stays; anything after the end marker (a polyglot\'s payload) goes', () => {
  const out = strip(jpeg({ adobe: true, trailing: '<html><script>alert(1)</script>' }));
  assert.ok(has(out, 'Adobe'));
  assert.ok(!has(out, '<script>'));
  assert.deepEqual([out[out.length - 2], out[out.length - 1]], [0xff, 0xd9]);
  const html = strip(jpeg({ comment: '<html><body onload=alert(1)>' }));
  assert.ok(!has(html, '<html>'), 'HTML hidden in a comment goes with the comment');
});

test('JPEG: cut off anywhere, or with a broken segment, it\'s refused', () => {
  const whole = jpeg({ gps: true });
  for (const n of [3, 10, 30, whole.length - 60, whole.length - 2, whole.length - 1]) refused(whole.subarray(0, n), 'broken');
  const bad = Buffer.from(whole);
  bad[5] = 0xff;                                             // APP0's length now runs past the end
  refused(bad, 'broken');
  refused(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'broken');  // no frame, no picture
});

/* --------------------------------------------------------------- PNG */

test('PNG: a real PNG; eXIf, tEXt, zTXt, iTXt, tIME and unknown chunks come out, the drawing chunks stay', () => {
  const dirty = png({
    width: 20, height: 10,
    chunks: [['eXIf', exifGps().subarray(6)], ['tEXt', 'Comment\0secret note'], ['zTXt', Buffer.concat([Buffer.from('Author\0\0'), zlib.deflateSync('Phone Maker')])],
      ['iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>37.7750</x:xmpmeta>'], ['tIME', [7, 234, 10, 25, 12, 0, 0]], ['gAMA', [0, 0, 0xb1, 0x8f]], ['prVt', 'GPS-SECRET']],
    after: [['tEXt', 'Location\0GPS-SECRET']],
    trailing: '<svg onload=alert(1)>',
  });
  assert.deepEqual(sniff(dirty), { format: 'png', mime: 'image/png', ext: 'png', width: 20, height: 10, animated: false });
  const out = strip(dirty);
  clean(out);
  assert.ok(!has(out, '<svg'), 'nothing after IEND');
  assert.deepEqual(pngChunks(out).map(c => c.type), ['IHDR', 'gAMA', 'IDAT', 'IEND']);
  assert.deepEqual(sniff(out), sniff(dirty));
  // the pixels are untouched: the IDAT inflates to the same rows
  const idat = b => { const c = pngChunks(b).find(x => x.type === 'IDAT'); return zlib.inflateSync(b.subarray(c.data, c.data + c.len)); };
  assert.deepEqual(idat(out), idat(dirty));
});

test('PNG: cut off, missing its header or its picture data, it\'s refused', () => {
  const whole = png();
  for (const n of [9, 20, 33, whole.length - 13, whole.length - 1]) refused(whole.subarray(0, n), 'broken');
  const noIdat = Buffer.concat([whole.subarray(0, 33), whole.subarray(whole.length - 12)]);
  refused(noIdat, 'broken');
});

/* --------------------------------------------------------------- GIF */

test('GIF: size and frames; comments, plain text and XMP come out, the animation loop stays', () => {
  const dirty = gif({ width: 100, height: 80, frames: 3, comment: 'secret note GPS-SECRET', xmp: true, plainText: true, trailing: 'PK\x03\x04zip' });
  assert.deepEqual(sniff(dirty), { format: 'gif', mime: 'image/gif', ext: 'gif', width: 100, height: 80, animated: true });
  const out = strip(dirty);
  clean(out);
  assert.ok(has(out, 'NETSCAPE2.0'), 'it still loops');
  assert.ok(!has(out, 'PK\x03\x04'), 'nothing after the trailer');
  const { blocks } = gifBlocks(out);
  assert.deepEqual(blocks.map(b => (b.kind === 'ext' ? b.label.toString(16) : b.kind)), ['ff', 'f9', 'image', 'f9', 'image', 'f9', 'image', 'trailer']);
  assert.deepEqual(sniff(out), sniff(dirty));
  assert.equal(sniff(gif()).animated, false, 'one frame stands still');
});

test('the real GIFs and PNGs in public/assets are read as whole pictures, and stripping keeps every frame', () => {
  const dir = path.join(ROOT, 'public', 'assets');
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => /\.(gif|png)$/.test(f));
  assert.ok(files.length > 100);
  let moving = 0;
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f));
    const info = sniff(b);
    // (pfp.png is really a WebP: the name says nothing, the bytes say what it is)
    assert.equal(info.mime, f.endsWith('pfp.png') ? 'image/webp' : f.endsWith('.gif') ? 'image/gif' : 'image/png', f);
    const out = strip(b);
    assert.deepEqual(sniff(out), info, f);
    if (info.format === 'gif') {
      assert.equal(gifBlocks(out).blocks.filter(x => x.kind === 'image').length, gifBlocks(b).blocks.filter(x => x.kind === 'image').length, f);
    }
    if (info.animated) moving++;
  }
  assert.ok(moving > 0, 'some of them move');
});

test('GIF: cut off before the trailer, it\'s refused', () => {
  const whole = gif({ frames: 2 });
  for (const n of [8, 13, 25, whole.length - 1]) refused(whole.subarray(0, n), 'broken');
});

/* -------------------------------------------------------------- WebP */

test('WebP: lossless, lossy and extended sizes; EXIF and XMP chunks (and their flags) come out', () => {
  assert.deepEqual(sniff(webp({ width: 40, height: 30 })), { format: 'webp', mime: 'image/webp', ext: 'webp', width: 40, height: 30, animated: false });
  assert.deepEqual([sniff(webp({ kind: 'VP8', width: 321, height: 123 })).width, sniff(webp({ kind: 'VP8', width: 321, height: 123 })).height], [321, 123]);
  const dirty = webp({ kind: 'VP8X', width: 1000, height: 700, exif: true, xmp: true });
  assert.ok(has(dirty, 'GPS-SECRET'));
  assert.equal(sniff(dirty).width, 1000);
  const out = strip(dirty);
  clean(out);
  assert.deepEqual(webpChunks(out).map(c => c.type), ['VP8X', 'VP8L']);
  assert.equal(out[20] & 0x0c, 0, 'the EXIF and XMP flags are off');
  assert.equal(Buffer.from(out).readUInt32LE(4) + 8, out.length, 'the RIFF size is right');
  assert.deepEqual(sniff(out), sniff(dirty));
  assert.equal(sniff(webp({ kind: 'VP8X', animated: true })).animated, true);
});

test('WebP: cut off, or claiming more than it has, it\'s refused', () => {
  const whole = webp({ kind: 'VP8X', exif: true });
  for (const n of [12, 20, whole.length - 3]) refused(whole.subarray(0, n), 'broken');
});

/* ------------------------------------------------------ not pictures */

test('SVG, HTML, XML, HEIC, PDF, scripts and empty files are not pictures; a polyglot that only starts like one is broken', () => {
  for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<?xml version="1.0"?><svg/>', '<!DOCTYPE html><html></html>',
    '  <html>', '%PDF-1.4', 'alert(document.cookie)', '', 'RIFF\0\0\0\0AVI ']) refused(Buffer.from(s), 'type');
  refused(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]), 'type');   // HEIC (ftyp heic)
  refused(Buffer.from('GIF89a<html><script>alert(1)</script></html>'), 'broken');
  refused(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>alert(1)</script>')]), 'broken');
  refused(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>')]), 'broken');
  assert.throws(() => strip(Buffer.from('<svg/>')), e => e instanceof BadImage && e.reason === 'type');
});

/* ------------------------------------------- the allowlists (red team) */

test('JPEG: only the allowlisted segments survive, each cut to the length its own fields give it', () => {
  const ok = (name, bytes) => {
    const out = strip(bytes);
    assert.ok(!has(out, MARK), `${name}: the marker is gone`);
    assert.deepEqual(sniff(out), sniff(bytes), `${name}: the same picture`);
    assert.equal(strip(out).length, out.length, `${name}: stripping twice changes nothing`);
    return out;
  };
  ok('a JFXX thumbnail APP0', jpegOf(J_APP0, jseg(0xe0, L('JFXX\0\x10' + MARK)), J_DQT, J_SOF, J_DHT, J_SOS));
  ok('a JPG0 segment', jpegOf(J_APP0, jseg(0xf0, L(MARK)), J_DQT, J_SOF, J_DHT, J_SOS));
  ok('a reserved 0x02 segment', jpegOf(J_APP0, jseg(0x02, L(MARK)), J_DQT, J_SOF, J_DHT, J_SOS));
  ok('a DAC with an odd byte', jpegOf(J_APP0, J_DQT, J_SOF, jseg(0xcc, [0, 0x10, ...L('G')]), J_DHT, J_SOS));
  const jfif = ok('a JFIF APP0 with a thumbnail', jpegOf(jseg(0xe0, L('JFIF\0\x01\x02\0\0\x48\0\x48\x01\x01\xff\xff\xff' + MARK)), J_DQT, J_SOF, J_DHT, J_SOS));
  assert.deepEqual([...jfif.subarray(2, 20)], [0xff, 0xe0, 0, 16, ...L('JFIF\0\x01\x02\0\0\x48\0\x48'), 0, 0], 'the 16-byte JFIF header, no thumbnail');
  const adobe = ok('Adobe APP14 with more after it', jpegOf(J_APP0, jseg(0xee, L('Adobe\0\x64\x80\0\0\0\x01' + MARK)), J_DQT, J_SOF, J_DHT, J_SOS));
  const at = jpegSegments(adobe).segs.find(s => s.marker === 0xee);
  assert.deepEqual([...adobe.subarray(at.start, at.end)], [0xff, 0xee, 0, 14, ...L('Adobe'), 0, 100, 0, 0, 0, 0, 1], 'Adobe\'s 12 bytes, the transform kept');
  ok('a frame header and a scan header with bytes after their fields', jpegOf(J_APP0, J_DQT, jseg(0xc0, [8, 0, 10, 0, 10, 1, 1, 0x11, 0, ...L(MARK)]),
    J_DHT, jseg(0xda, [1, 1, 0, 0, 63, 0, ...L(MARK)])));
  ok('a restart interval and a DNL with bytes after them', jpegOf(J_APP0, J_DQT, J_SOF, J_DHT, jseg(0xdd, [0, 4, ...L(MARK)]), J_SOS));
  // tables that aren't whole tables: the file is broken
  assert.throws(() => strip(jpegOf(J_APP0, jseg(0xdb, L('\0' + MARK)), J_SOF, J_DHT, J_SOS)), e => e instanceof BadImage && e.reason === 'broken');
  assert.throws(() => strip(jpegOf(J_APP0, jseg(0xdb, [0, ...Array(64).fill(1), ...L(MARK)]), J_SOF, J_DHT, J_SOS)), e => e instanceof BadImage);
  assert.throws(() => strip(jpegOf(J_APP0, J_DQT, J_SOF, jseg(0xc4, [0, 1, ...Array(15).fill(0), 0, ...L(MARK)]), J_SOS)), e => e instanceof BadImage);
});

test('PNG: iCCP goes, APNG chunks only in a real APNG, and kept chunks only at their proper sizes', () => {
  const dirty = png({ width: 10, height: 4, chunks: [['iCCP', `x\0\0${MARK}`], ['gAMA', [0, 0, 0xb1, 0x8f, ...L(MARK)]], ['sRGB', [0]]],
    after: [['fdAT', L('\0\0\0\x01' + MARK)], ['fcTL', Array(26).fill(0)]] });
  const out = strip(dirty);
  assert.ok(!has(out, MARK));
  assert.deepEqual(pngChunks(out).map(c => c.type), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  const apng = png({ width: 10, height: 4, chunks: [['acTL', [0, 0, 0, 1, 0, 0, 0, 0]], ['fcTL', Array(26).fill(0)]] });
  assert.deepEqual(pngChunks(strip(apng)).map(c => c.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']);
});

test('GIF: graphic control and loop extensions are rebuilt at their fixed sizes, extra sub-blocks dropped', () => {
  const head = [...L('GIF89a'), ...l16(10), ...l16(10), 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const frame = [0x2c, 0, 0, 0, 0, ...l16(10), ...l16(10), 0, 2, 2, 0x4c, 0x01, 0];
  const sub = s => [s.length, ...L(s)];
  const dirty = Buffer.from([...head,
    0x21, 0xff, 11, ...L('NETSCAPE2.0'), 3, 1, 5, 0, ...sub(MARK), 0,
    0x21, 0xff, 11, ...L('NETSCAPE2.0'), 5, 2, ...L('BUFF'), 0,
    0x21, 0xf9, 4, 4, 10, 0, 1, ...sub(MARK), 0,
    ...frame, 0x3b]);
  const out = strip(dirty);
  assert.ok(!has(out, MARK) && !has(out, 'BUFF'));
  assert.deepEqual([...out.subarray(head.length, head.length + 27)],
    [0x21, 0xff, 11, ...L('NETSCAPE2.0'), 3, 1, 5, 0, 0, 0x21, 0xf9, 4, 4, 10, 0, 1, 0], 'the loop count and the frame timing kept');
  assert.deepEqual(sniff(out), sniff(dirty));
});

test('WebP: ICCP goes, chunks hidden in an animation frame go, VP8X and ANIM are cut to their sizes', () => {
  const frame = [0, 0, 0, 0, 0, 0, 9, 0, 0, 9, 0, 0, 0, 0, 0, 0, ...wchunk('XYZW', L(MARK)), ...W_VP8L, ...L('tail')];
  const dirty = webpOf(wchunk('VP8X', [0x22, 0, 0, 0, 9, 0, 0, 9, 0, 0, ...L(MARK)]), wchunk('ICCP', L(MARK)),
    wchunk('ANIM', [0, 0, 0, 0, 0, 0, ...L(MARK)]), wchunk('ANMF', frame));
  const out = strip(dirty);
  assert.ok(!has(out, MARK) && !has(out, 'XYZW') && !has(out, 'tail'));
  assert.deepEqual(webpChunks(out).map(c => [c.type, c.len]), [['VP8X', 10], ['ANIM', 6], ['ANMF', 16 + W_VP8L.length]]);
  assert.equal(out[20] & 0x20, 0, 'the ICC flag is off');
  assert.deepEqual(sniff(out), sniff(dirty));
  assert.ok(!has(strip(webpOf(W_VP8X(0x20), wchunk('ICCP', L(MARK)), W_VP8L)), MARK));
});

test('stripped files still decode: the real images in public/assets, and JPEGs and WebPs made from them', { skip: !sharp && 'sharp is not installed' }, async () => {
  const decode = async b => sharp(b, { animated: true }).raw().toBuffer({ resolveWithObject: true });
  const same = async (name, b, pixels = true) => {
    const out = strip(b);
    const [x, y] = [await decode(b), await decode(out)];
    assert.deepEqual([y.info.width, y.info.height, y.info.pages], [x.info.width, x.info.height, x.info.pages], name);
    if (pixels) assert.ok(x.data.equals(y.data), `${name}: the same pixels`);
    return out;
  };
  const dir = path.join(ROOT, 'public', 'assets');
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(n => /\.(gif|png)$/.test(n))) {
    const b = fs.readFileSync(path.join(dir, f));
    await same(f, b, sniff(b).format !== 'png' || !pngChunks(b).some(c => c.type === 'iCCP'));   // (a dropped colour profile shifts the colours)
  }
  const src = path.join(dir, 'deco_dragon.gif');
  const still = sharp(src).resize(64, 48);
  const exif = { exif: { IFD0: { Copyright: 'GPS-SECRET-37.7750' } } };
  const made = {
    'JPEG with EXIF': [await still.clone().jpeg().withMetadata(exif).toBuffer(), true],
    'progressive JPEG with an ICC profile': [await still.clone().jpeg({ progressive: true }).withIccProfile('p3').toBuffer(), false],
    'lossy WebP with EXIF': [await still.clone().webp().withMetadata(exif).toBuffer(), true],
    'lossless WebP with an ICC profile': [await still.clone().webp({ lossless: true }).withIccProfile('p3').toBuffer(), false],
    'animated WebP': [await sharp(src, { animated: true }).webp().toBuffer(), true],
  };
  for (const [name, [b, pixels]] of Object.entries(made)) {
    const out = await same(name, b, pixels);
    assert.ok(!has(out, 'GPS-SECRET') && !has(out, 'ICC_PROFILE') && !has(out, 'ICCP'), `${name}: no metadata left`);
  }
});
