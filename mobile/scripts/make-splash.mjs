// Renders the app's splash and icons into the iOS and Android projects. Run it after changing public/index.html or
// public/app.css (npm run assets). The images are COMMITTED; CI does not run this.
//
// Splash. The page's first frame is index.html with app.css and no data yet: the header (logo, search, empty #who), the empty
// tabs bar, "loading ourspace…", and the footer at the bottom of a white page. This script loads the REAL index.html and the
// REAL app.css in a browser with app.js blocked (so the page stays in that first state) and takes two pictures at each
// width: the header block (top of the page down to "loading ourspace…") and the footer block (.os-foot). The app lays them
// out natively with white between them, which is what the page's own flex layout does at any height. At the exact width
// the picture is 1:1.
//
// Fonts. app.css asks for 'MS Sans Serif', Tahoma, 'Segoe UI', Arial. On a phone only Arial exists on iOS, and Android maps
// Arial to its system sans (Roboto on Pixel and most others). A Windows machine would pick Tahoma, which no phone has, so
// the render pins the font to what the phone resolves (Arial for iOS, bundled Roboto for Android). That is the ONLY
// difference from the real page, and it only reproduces the stack's fallback; app.css itself is untouched.
//
// Icons. The site's logo mark — the "o" of "ourspace" and the orange dot after it, on the header's blue — DRAWN
// (a ring and a disc at chosen sizes), not set in a system font. See the icons section below for why and for the
// three layers it produces. `node scripts/make-splash.mjs --icons` renders only those.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const publicDir = join(root, '..', 'public');
const req = createRequire(import.meta.url);
let playwright, PNG;
try {
  const rootReq = createRequire(join(root, '..', 'package.json'));      // playwright and pngjs are devDependencies of the repo root
  playwright = rootReq('playwright');
  ({ PNG } = rootReq('pngjs'));
} catch {
  console.error('make-splash needs playwright and pngjs from the repo root: run `npm ci` there (and `npx playwright install chromium webkit`).');
  process.exit(1);
}

// widths in CSS px. Keep in step with Brand.splashWidths (SceneDelegate.swift) and SPLASH_WIDTHS (MainActivity.java).
const IOS_WIDTHS = [320, 375, 390, 393, 402, 414, 428, 430, 440, 744, 768, 810, 820, 834];
const ANDROID_WIDTHS = [320, 360, 384, 393, 411, 412, 432, 600, 768, 800];
const SCALE = 3;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const server = createServer((rq, rs) => {
  const path = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  const file = join(publicDir, path === '/' ? 'index.html' : path);
  if (!file.startsWith(publicDir) || !existsSync(file)) { rs.writeHead(404).end(); return; }
  rs.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const b64 = f => readFileSync(f).toString('base64');
const robotoDir = join(root, 'node_modules', '@fontsource', 'roboto', 'files');
const robotoCss = ['400-normal', '400-italic', '700-normal', '700-italic'].map(v => {
  const [w, s] = v.split('-');
  return `@font-face{font-family:PhoneSans;font-weight:${w};font-style:${s};src:url(data:font/woff2;base64,${b64(join(robotoDir, `roboto-latin-${v}.woff2`))})}`;
}).join('');
const FONT = {
  ios: 'body,input,button{font-family:Arial,"Helvetica Neue",sans-serif !important}',
  android: `${robotoCss}body,input,button{font-family:PhoneSans,Roboto,sans-serif !important}`,
};

async function render(browser, platform, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1400 }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  await page.route('**/app.js', r => r.abort());                       // the page stays in its first frame
  await page.route('**/js/**', r => r.abort());
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.addStyleTag({ content: FONT[platform] });
  await page.evaluate(() => document.fonts.ready);
  const m = await page.evaluate(() => {
    const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    return { loading: r('#ms-content .os-loading'), foot: r('.os-foot') };
  });
  const top = await page.screenshot({ clip: { x: 0, y: 0, width, height: Math.ceil(m.loading.bottom) } });
  const footTop = Math.floor(m.foot.top), footHeight = Math.ceil(m.foot.bottom) - footTop;
  const foot = await page.screenshot({ clip: { x: 0, y: footTop, width, height: footHeight } });
  await ctx.close();
  return { top, foot, topHeight: Math.ceil(m.loading.bottom), footHeight };
}

// PNG without an alpha channel (the App Store refuses icons that have one; the splash has none to keep)
const opaque = buf => {
  const png = PNG.sync.read(buf);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return PNG.sync.write(png, { colorType: 2 });
};
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };
const imageset = (dir, files) => put(join(dir, 'Contents.json'), JSON.stringify({ images: files, info: { version: 1, author: 'xcode' } }, null, 2) + '\n');

const iosAssets = join(root, 'ios', 'App', 'App', 'Assets.xcassets');
const androidRes = join(root, 'android', 'app', 'src', 'main', 'res');

// ---------------------------------------------------------------- splash
async function splash() {
  const out = {};
  for (const [platform, engine, widths] of [['ios', 'webkit', IOS_WIDTHS], ['android', 'chromium', ANDROID_WIDTHS]]) {
    let browser;
    try { browser = await playwright[engine].launch(); } catch {
      console.warn(`  ${engine} is not installed: rendering the ${platform} splash with chromium instead (npx playwright install ${engine})`);
      browser = await playwright.chromium.launch();
    }
    for (const w of widths) {
      const r = await render(browser, platform, w);
      out[`${platform}${w}`] = r;
      if (platform === 'ios') {
        for (const [name, buf] of [['SplashTop', r.top], ['SplashFoot', r.foot]]) {
          const dir = join(iosAssets, `${name}${w}.imageset`);
          put(join(dir, `${name}.png`), opaque(buf));
          imageset(dir, [{ idiom: 'universal', filename: `${name}.png`, scale: '3x' }]);
        }
      } else {
        put(join(androidRes, 'drawable-nodpi', `splash_top_${w}.png`), opaque(r.top));
        put(join(androidRes, 'drawable-nodpi', `splash_foot_${w}.png`), opaque(r.foot));
      }
      console.log(`  ${platform} ${w}: header ${r.topHeight}px, footer ${r.footHeight}px`);
    }
    await browser.close();
  }

  // The iOS launch screen (before any code runs): one composite for a 390x844 phone, bands included. Other sizes get it
  // scaled (aspect fill); the shell's overlay, exact for each width, replaces it as soon as the app is running.
  const ref = out.ios390;
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  await page.setContent(`<body style="margin:0;background:#fff;position:relative;width:390px;height:844px;overflow:hidden">
    <div style="position:absolute;left:0;right:0;top:0;height:47px;background:#1c3f94"></div>
    <img style="position:absolute;left:0;top:47px;width:390px" src="data:image/png;base64,${ref.top.toString('base64')}">
    <img style="position:absolute;left:0;bottom:34px;width:390px" src="data:image/png;base64,${ref.foot.toString('base64')}">
    <div style="position:absolute;left:0;right:0;bottom:0;height:34px;background:#eef4ff"></div></body>`);
  const launch = opaque(await page.screenshot());
  await ctx.close(); await browser.close();
  const dir = join(iosAssets, 'Splash.imageset');
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) rmSync(join(dir, f), { force: true });
  put(join(dir, 'splash.png'), launch);
  imageset(dir, [{ idiom: 'universal', filename: 'splash.png', scale: '3x' }]);
}

/* ---------------------------------------------------------------- icons
   The mark is the site's own logo: the "o" of "ourspace" and the orange dot after it, on the first colour of
   `.ms-header`'s gradient. The first version of this script set that as TEXT — bold Arial "o." at 78% of the canvas —
   which is what deviations.md D11 called a placeholder and docs/mobile/redteam.md called a 2.1 rejection: a letter in
   a system font stretched to the edges is not a mark. It is drawn now:

     · a geometric ring, not a glyph, so its weight is chosen rather than inherited from whatever font the renderer
       had, and so it is the same shape at 1024px and at 48px;
     · the dot sized and placed where the wordmark's full stop sits — on the ring's baseline, to its right — rather
       than as a period two pixels across;
     · the mark optically centred as a whole (ring + gap + dot), not the ring centred with the dot hanging off;
     · 65% of the canvas, which leaves the margin iOS's squircle mask and Android's circle mask both need, so no part
       of it is ever clipped;
     · the header's real gradient (#1c3f94 → #003366) behind it, flat #1c3f94 for Android's adaptive background.

   Three layers come out of the same drawing: the full icon (iOS and Android's legacy launcher), the adaptive
   foreground (the mark alone, shrunk into Android's 66-of-108 safe circle) and the monochrome layer Android 13+
   tints for themed icons. No text, no fine detail, nothing that needs to be read.
   It is still a generated icon and not a designer's: what changed is that it is a drawing with reasons. */
const MARK = { r: 0.235, w: 0.088, dot: 0.068, gap: 0.040 };      // ring radius, stroke, dot radius, gap — of the canvas

function markSvg(size, { mono = false, scale = 1 } = {}) {
  const { r, w, dot, gap } = MARK;
  const markW = 2 * r + gap + 2 * dot;
  const x0 = (1 - markW * scale) / 2;
  const s = v => v * scale * size;
  const ringCx = (x0 + r * scale) * size;
  const ringCy = size / 2;
  const dotCx = (x0 + (2 * r + gap + dot) * scale) * size;
  const dotCy = ringCy + s(r) - s(dot);          // the dot sits on the ring's baseline, as the full stop does
  const white = mono ? '#fff' : '#fff';
  const orange = mono ? '#fff' : '#ff6600';      // the themed-icon layer is one colour by definition
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${ringCx}" cy="${ringCy}" r="${s(r) - s(w) / 2}" fill="none" stroke="${white}" stroke-width="${s(w)}"/>
    <circle cx="${dotCx}" cy="${dotCy}" r="${s(dot)}" fill="${orange}"/>
  </svg>`;
}

const iconHtml = (size, { round = false, fg = false, mono = false } = {}) => {
  // the adaptive foreground and the monochrome layer live in Android's 66-of-108 safe circle: the mark's bounding box
  // is 0.646 x 0.47 of the canvas, whose diagonal is 0.80, so 0.74 is the largest scale that cannot be clipped
  const scale = fg || mono ? 0.74 : 1;
  const plate = mono ? 'transparent'
    : fg ? 'transparent'
      : 'linear-gradient(180deg,#1c3f94,#003366)';
  return `<body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent">
    <div style="width:${size}px;height:${size}px;background:${plate};${round ? 'border-radius:50%;' : ''}">
      ${markSvg(size, { mono, scale })}
    </div></body>`;
};

async function icons() {
  const browser = await playwright.chromium.launch();
  const shot = async (size, opts, transparent) => {
    const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(iconHtml(size, opts));
    const buf = await page.screenshot({ omitBackground: transparent });
    await ctx.close();
    return buf;
  };
  // the App Store refuses an icon with an alpha channel, so this one is flattened (opaque())
  put(join(iosAssets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), opaque(await shot(1024, {}, false)));
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = join(androidRes, `mipmap-${d}`);
    put(join(dir, 'ic_launcher.png'), await shot(Math.round(48 * k), {}, false));
    put(join(dir, 'ic_launcher_round.png'), await shot(Math.round(48 * k), { round: true }, true));
    put(join(dir, 'ic_launcher_foreground.png'), await shot(Math.round(108 * k), { fg: true }, true));
    put(join(dir, 'ic_launcher_monochrome.png'), await shot(Math.round(108 * k), { mono: true }, true));
  }
  // Play's listing wants a 512 icon too, and the Play Console will not take one with transparency
  put(join(root, 'store', 'play-icon-512.png'), opaque(await shot(512, {}, false)));
  put(join(androidRes, 'values', 'ic_launcher_background.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1c3f94</color>\n</resources>\n');
  // Android 13+ themed icons: the launcher tints the monochrome layer with the wallpaper's colours
  const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    + '    <background android:drawable="@color/ic_launcher_background"/>\n'
    + '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
    + '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n';
  put(join(androidRes, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
  put(join(androidRes, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);
  await browser.close();
}

// `npm run assets` does both; `--icons` / `--splash` do one, so a change to the icon does not re-render 24 splashes
const only = process.argv.includes('--icons') ? 'icons' : process.argv.includes('--splash') ? 'splash' : 'both';
try {
  if (only !== 'icons') { console.log('splash:'); await splash(); }
  if (only !== 'splash') { console.log('icons:'); await icons(); }
  console.log('done. Review the diff in mobile/ios and mobile/android, then commit the images.');
} finally { server.close(); }
