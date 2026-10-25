# 005 — Photos and video: formats and safety
Status: reference (checked 2026-10-25)

Scope: members 13+; photos and clips (≤ 60 s, ≤ 50 MB) in statuses and forum posts. Plain JS under CSP `script-src 'self'`; Cloudflare Worker + R2; no ffmpeg. "unverified" = no source below confirmed it.

## Playback and capture support

Key: Y = listed as supported; P = conditional; ? = not verified. Columns are the six platforms asked for.

| Format | Chrome | Edge | Firefox | Safari macOS | iOS Safari | Android Chrome |
|---|---|---|---|---|---|---|
| H.264 video in MP4 | Y | Y | Y (uses OS codecs) | Y | Y (MDN: "all versions of Safari") | ? |
| AAC audio in MP4 | Y (MP4 only) | Y | Y (platform AAC) | Y | Y | Y (MP4 only) |
| HEVC (H.265) in MP4 | P: HW only; Win 8+, macOS 11+, Android 5+ | P: needs Store HEVC extension on Win | P: Win 134, macOS 136, Linux 137, Android 137 (HW only) | Y (macOS High Sierra+) | Y (caniuse: iOS 11+) | P |
| HEVC in .mov | ? | ? | ? | Y (MDN QuickTime column) | ? | ? |
| VP9 in WebM | Y | Y | Y | ? (MDN "all versions"; disputed) | ? | ? |
| AV1 in MP4 or WebM | Y (70+) | Y (121+) | Y (67+; Android 113+) | P: M3 Macs and later | P: iPhone 15 Pro, iPhone 16+ | ? |
| QuickTime .mov, H.264 | ? | ? | ? | MDN: `video/quicktime` for Safari only | ? | ? |

Sources: [MDN video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs) (modified 2026-09-07); [MDN containers](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) (2026-10-01); [MDN audio codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs) (2026-10-13); [caniuse HEVC](https://caniuse.com/hevc).
- Firefox HEVC conflicts: MDN's table says 120, its notes say 134+; caniuse says partial from 137. Treat as partial.
- MDN says Chrome supports only AAC Main Profile; verify AAC-LC (what phones write) with a test file.
- MDN says Safari plays Opus only in CAF. Do not use Opus in clips.

Capture defaults:
- iPhone: Settings > Camera > Formats. "Most Compatible" records JPEG and H.264; "High Efficiency" records HEIF and HEVC. Apple's "switches back" wording implies High Efficiency is the default ([Apple HT207022](https://support.apple.com/en-us/HT207022)). iCloud keeps originals; AirDrop, Messages, email and USB import "might" convert to JPEG/H.264.
- Android: default codec varies by phone and app. No current Pixel or Samsung default found (unverified). Older XDA report: HEVC often off by default ([XDA](https://www.xda-developers.com/oems-change-default-video-capture-format-android-12-hevc/)).
- HEIC: caniuse lists it as supported only in Safari 17+ (about 17% of global usage); Chrome, Edge, Firefox and Android Chrome do not support it ([caniuse HEIF](https://caniuse.com/heif)). MDN's [image types](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types) page does not list HEIC. Safari's start version is disputed (unverified). Rule: never depend on decoding HEIC outside Safari.

## Recommended pipeline

Photos (client):
1. Input: `accept="image/jpeg,image/png,image/webp"`. WebKit reports say Safari converts HEIC to the first accepted type; results vary, so test on iPhone ([WebKit 292350](https://bugs.webkit.org/show_bug.cgi?id=292350)).
2. Reject inputs over 40 megapixels (our limit, for decode memory).
3. `createImageBitmap(file, { imageOrientation: 'from-image' })`. Default, Baseline since 2021 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)).
4. Draw to canvas at 1600 px long edge (2048 hard cap); `canvas.toBlob(cb, 'image/jpeg', 0.85)`. Quality is 0–1 ([MDN toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)).
5. Animated GIF or WebP: refuse in v1. Canvas draws one frame (standard, not sourced here). ImageDecoder exposes frames but is "Limited availability" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder)).
6. HEIC or failed decode: "Please choose a JPEG or PNG."
7. Server: magic bytes, then JPEG only. Walk JPEG segments up to SOS and reject APP1 (Exif/XMP) or APP13 (IPTC) (our design).

Videos:
- Accept in v1: MP4, H.264 + AAC-LC, ≤ 1080p, ≤ 60 fps (our choice; Apple says 1080p/60 fps is "more broadly compatible"). `.mov` with H.264: rewrite the major brand to `isom` on the client, then test in all browsers (unverified).
- Reject in v1: HEVC, AV1, VP9, WebM. No server transcode exists.
- Client: size ≤ 50 MB; duration ≤ 60 s from `<video>` `loadedmetadata`; box checks in JS (see Metadata).
- Server (Worker): magic bytes; read `moov` (R2 suffix range if it sits at the end, [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)); parse `mvhd` for duration ≤ 60.5 s; check sample entries (`avc1`, `mp4a` allowed; `hvc1`, `hev1`, `av01`, `vp09` rejected); dimensions; location scan. Feasible at a few hundred lines of JS (estimate). Limits: 128 MB memory; CPU 10 ms per request on Free, 30 s default on Paid; request body 100 MB on Free/Pro ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- Member message for HEVC clips: "This clip is HEVC (H.265), which many browsers can't play, so we can't accept it. On iPhone, set Settings > Camera > Formats > Most Compatible and record again. Sharing may convert the clip, but Apple doesn't guarantee it."

## Metadata and privacy

Photos:
- Camera JPEGs carry EXIF, which can include GPS (standard; not checked per phone model).
- Canvas re-encode drops EXIF, XMP and IPTC (standard; verify with ExifTool). ICC handling for Display P3 photos is unverified; test before shipping.
- Server rejects APP1 and APP13 as a backstop.

Videos (blocker):
- iPhone MOV/MP4 store location. ExifTool documents `©xyz` (ItemList, ISO 6709 string) and `com.apple.quicktime.location.ISO6709` (Keys) ([ExifTool QuickTime tags](https://exiftool.org/TagNames/QuickTime.html)). ffprobe on iOS shows `com.apple.quicktime.location.ISO6709` ([addpipe](https://blog.addpipe.com/geolocation-metadata-ios-android-video-files/), 2025-08-27).
- Android: addpipe found no location in one Galaxy S21 FE clip ("Save location" off by default). Pixel untested. Assume location may be present.
- Box paths (`moov/udta/meta/ilst` for `©xyz`; `moov/meta` keys and ilst for the ISO6709 key) are our reading, unverified. Confirm with a hex dump of test files.
- Strip options, in order:
  a. Byte-preserving JS edit: replace the location atoms with `free` atoms of the same length, so no offsets change (`stco`/`co64` stay valid). Estimate 150–250 lines; unverified.
  b. Remux with mp4box.js 2.5.0 (BSD-3-Clause; 2.49 MB unpacked, minified size unverified) ([npm](https://registry.npmjs.org/mp4box/latest)). Whether it copies samples without re-encoding is unverified.
  c. WebCodecs re-encode: last resort. CPU-heavy and lossy; [VideoEncoder is "Limited availability"](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder).
- Also drop device make/model in `udta` (not GPS; recommended).
- Server: refuse any `moov` containing a location key. Do not rewrite server-side (copy cost in a Worker).
- Verify after stripping: ExifTool shows no GPS, and the clip plays on iPhone, Pixel and Samsung.

## Serving uploads safely

Magic bytes ([Wikipedia](https://en.wikipedia.org/wiki/List_of_file_signatures)):

| Type | Signature | Note |
|---|---|---|
| JPEG | `FF D8 FF` at 0 | accept |
| PNG | `89 50 4E 47 0D 0A 1A 0A` at 0 | accept if re-encoded |
| GIF | `GIF87a` / `GIF89a` at 0 | refuse if animated |
| WebP | `RIFF`…`WEBP` | refuse if animated |
| MP4 | `ftyp` at 4; brand `isom` listed, `mp42`/`avc1` unverified | accept |
| MOV | `ftyp` brand `qt  ` (not in Wikipedia list; unverified) | rewrite to MP4 brand |
| WebM | `1A 45 DF A3` at 0; DocType `webm` (ID 0x4282, unverified) | not in v1 |
| HEIC | `ftyp` `heic` at 4 (listed) | reject |

- Refuse SVG (scriptable), HTML/XHTML, XML, JS, and any type outside this table.
- Do not trust the extension or client MIME type. Signatures alone are not enough ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)).
- Polyglots are harmless with a fixed Content-Type and nosniff ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options)).

Headers on upload responses:
- `Content-Type`: our detected type, never the client's.
- `X-Content-Type-Options: nosniff`.
- `Content-Disposition: inline` for media; `attachment` for anything else (our choice).
- `Content-Security-Policy: default-src 'none'; sandbox` (our recommendation).
- `Cache-Control: public, max-age=31536000, immutable` for random keys; support `Range` (206) for video seeking.
- Random object keys; never the uploaded filename.

Origin: serve media from a separate host, ideally a separate registrable domain, so uploads never share cookies or origin with the app. OWASP prefers a different server ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)). Do not use an r2.dev URL in production (unverified; not checked).

## CSAM obligations

- 18 U.S.C. 2258A ([text](https://www.law.cornell.edu/uscode/text/18/2258A)): once we have actual knowledge of an apparent violation, report to the NCMEC CyberTipline "as soon as reasonably possible" (a). Report contents are optional (b). No duty to monitor or proactively scan (f). Preserve report contents for 1 year after submission (h), changed from 90 days in 2024.
- No statutory scanning duty. Hash matching is our choice. Staff must not view reported material beyond what the report needs (our recommendation).
- Cloudflare CSAM Scanning Tool ([docs, updated 2026-05-01](https://developers.cloudflare.com/cache/reference/csam-scanning/)): images only; video is not mentioned. Needs an email; emails daily; attempts a block; places the NCMEC report duty on the site owner. Conflict: [INHOPE](https://inhope.org/EN/articles/cloudflare-simplifying-the-fight-against-csam) says Cloudflare files daily NCMEC reports. Verify before relying on either.
- Video: no tool verified. Candidates to evaluate: Microsoft PhotoDNA, Thorn Safer. Check video coverage, eligibility and cost (unverified).
- Take It Down Act: FTC enforcement began 2026-05-19. Covered platforms must remove non-consensual intimate images within 48 hours of a valid request ([JD Supra, secondary](https://www.jdsupra.com/legalnews/ftc-s-take-it-down-act-stakeholder-6616558/)). We need a removal route before launch. Applicability to OurSpace is unverified; needs legal review.

## Open questions for the owner
1. Reject HEVC in v1 (recommended) with the re-record message, or accept with a warning?
2. Approve a 150–250 line JS atom editor plus a device test matrix (iPhone, Pixel, Samsung), with mp4box.js as fallback?
3. Refuse animated GIF and WebP in v1?
4. Confirm photo limits: 1600 px output, 40 MP input cap?
5. Which hash-matching vendor for video, and at what budget? Does it also cover photos?
6. Which separate domain for media?
7. Who is the CyberTipline reporter? Is legal review done for 2258A and the Take It Down Act?
8. Drop device make and model from videos (recommended)?
