// node tools/build.mjs — regenerate everything in social/ that comes from the original site (the repo root):
//   src/generated/bots.js     the bot cast: profiles + lines, merged from content-src/base, depth/ (BOT_IDS only)
//   src/generated/avatars.js  the picture presets people choose from (basics + content-src/avatar-presets*.json + decor)
//   public/assets/…           every image the new site uses, copied (the original assets/ folder is never touched)
//   public/blog/<post>.html   malten's essays: the <article> lifted verbatim, new page chrome around it
// Run it after editing content-src/ or adding a post. It only writes inside social/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOCIAL = path.resolve(HERE, '..');
const ROOT = path.resolve(SOCIAL, '..');                 // the original site
const CONTENT = path.join(ROOT, 'content-src');
const PUBLIC = path.join(SOCIAL, 'public');
const GEN = path.join(SOCIAL, 'src', 'generated');

// The bots. Deliberately few: the ten original residents (all adults in the fiction). Each one is clearly labeled as a
// bot everywhere it appears. Add or remove ids here and rebuild; the Worker re-syncs bot profiles on its next request.
const BOT_IDS = ['todd', 'darkangel', 'sk8rboi', 'vinyl_witch', 'wes', 'herp', 'banana', 'patrick', 'starxgazer', 'zorp'];

// Essays to republish (file name in the repo root → same name under public/blog/). Newest first.
const POSTS = [
  { file: 'what-does-it-mean-to-have-changed.html', num: '002', date: 'October 22, 2026', title: 'What does it mean to have changed?',
    desc: 'the ship of theseus, a $400 computer, and a dinner with my grandparents. on leaving georgia, and whether you can be someone if you never stay someone.' },
  { file: 'why-do-i-create.html', num: '001', date: 'October 5, 2026', title: 'Why do I create?',
    desc: 'why i spent two years on a website nobody asked for. losing my faith, finding poetry, and what making things gives back.' },
];

// Images the pages themselves use (editor choices are added from src/options.js below)
const UI_ASSETS = ['pfp.png', 'stars.png', 'assets/deco_new.gif', 'assets/deco_hearts_bar.gif', 'assets/deco_rainbow_bar.gif',
  'assets/construction_tape.gif', 'assets/construction_banner.gif', 'assets/under_repair_dog.gif', 'assets/under_construction_sign.gif',
  'assets/deco_welcome_banner.gif', 'assets/deco_email_bear.gif'];

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = f => fs.existsSync(f);
const copied = new Set();

// a path from the original site ("assets/x.gif" or a root file like "herp.gif") → the new site's URL, copying the file
function asset(rel) {
  if (typeof rel !== 'string' || !rel) return '';
  rel = rel.replace(/^\.?\//, '');
  const src = path.join(ROOT, rel);
  if (!exists(src)) throw new Error(`missing asset: ${rel}`);
  const out = rel.startsWith('assets/') ? rel : `assets/${rel}`;   // root files (herp.gif, stars.png…) land in assets/
  if (!copied.has(out)) {
    const dest = path.join(PUBLIC, out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.add(out);
  }
  return '/' + out;
}

/* ------------------------------------------------------------------ bots */
const strings = a => (Array.isArray(a) ? a : []).filter(s => typeof s === 'string' && s.trim());
const uniq = a => [...new Set(a)];
const addressesPlayer = s => /\{you\}/i.test(s);           // lines written TO the single-player visitor

function buildBot(id) {
  const base = readJson(path.join(CONTENT, 'base', 'residents', `${id}.json`));
  const depthFile = path.join(CONTENT, 'depth', `${id}.json`);
  const depth = exists(depthFile) ? readJson(depthFile) : {};
  const set = new Set(BOT_IDS);

  const keywords = {};
  for (const [k, v] of Object.entries({ ...(base.keywords || {}), ...(depth.keywordsExtra || {}) })) {
    if (typeof v === 'string' && v.trim()) keywords[k.toLowerCase()] = v;
  }
  // wall comments other bots left on this bot's page (the rest of the old cast doesn't live here any more)
  const wallSeeds = [...(base.wall || []), ...(depth.wallExtra || [])]
    .filter(w => w && set.has(w.from) && w.from !== id && typeof w.text === 'string' && !addressesPlayer(w.text))
    .map(w => ({ from: w.from, text: w.text }));
  const bulletins = (base.bulletins || [])
    .filter(b => b && typeof b.body === 'string' && !addressesPlayer(b.body + (b.subject || '')))
    .map(b => ({ subject: b.subject || '', body: b.body }));
  const blog = (Array.isArray(depth.blog) ? depth.blog : [])
    .filter(b => b && b.title && b.body && !addressesPlayer(b.title + b.body))
    .map(b => ({ title: b.title, mood: b.mood || '', body: b.body }));
  const song = base.song && base.song.name ? { name: base.song.name, artist: base.song.artist || '', url: base.song.url || '' } : null;

  return {
    key: id,
    name: base.name,
    avatar: asset(depth.avatar || base.avatar),
    friends: strings(base.friends).filter(f => set.has(f) && f !== id),
    profile: {
      tag: base.tag || '', mood: base.mood || '', age: String(base.age ?? ''), gender: base.gender || '',
      hometown: base.hometown || base.loc || '', zodiac: base.zodiac || '', status: base.status || '', hereFor: base.hereFor || '',
      about: base.about || '', aboutMore: depth.aboutMore || base.aboutMore || '', meet: base.meet || '',
      interests: base.interests || {}, blogTitle: base.blogTitle || '',
      theme: base.theme || null, bgTile: base.bgTile ? asset(base.bgTile) : '', font: '',
      decor: strings(base.decor).map(asset), badges: [], song,
      survey: depth.survey && Array.isArray(depth.survey.qa) ? { title: depth.survey.title || 'survey', qa: depth.survey.qa } : null,
    },
    lines: {
      statuses: uniq(strings([...(base.statuses || []), ...(base.statusesExtra || []), ...(depth.statusesExtra || [])])).filter(s => !addressesPlayer(s)),
      replies: uniq(strings([...(base.replies || []), ...(depth.repliesExtra || [])])),
      dms: uniq(strings(depth.dms)),
      ambient: uniq(strings(base.ambient)).filter(s => !addressesPlayer(s)),
      keywords,
      thanksAdd: base.thanksAdd || 'thanks for the add!!',
      bulletins,
    },
    wallSeeds,
    blog,
  };
}

/* --------------------------------------------------------- avatar presets */
function buildAvatars() {
  const basics = ['gray silhouette (the classic "no photo")', 'blue silhouette', 'pink silhouette', 'green silhouette',
    'purple silhouette on midnight', 'orange silhouette', 'teal silhouette', 'red silhouette on black', 'lavender silhouette',
    'neon green silhouette on black', 'sky blue silhouette', 'brown silhouette']
    .map((desc, i) => ({ file: `assets/avatars/preset_${String(i + 1).padStart(2, '0')}.png`, desc, group: 'basics' }));
  const pack = fs.readdirSync(CONTENT).filter(f => /^avatar-presets.*\.json$/.test(f)).sort()
    .flatMap(f => readJson(path.join(CONTENT, f)))
    .filter(a => a && typeof a.file === 'string')
    .map(a => ({ file: a.file, desc: a.desc || '', group: (a.group || 'icons').toLowerCase() }));
  const decor = ['deco_smiley', 'deco_skull', 'deco_moon', 'deco_dragon', 'deco_fairy', 'deco_hamster', 'deco_sparkle_bunny',
    'deco_dancing_baby', 'deco_email_bear', 'deco_record_dj', 'deco2_atom', 'deco2_mushroom', 'deco2_goth_inside',
    'deco_banana_tiny', 'deco_blinkie_zim']
    .map(n => ({ file: `assets/${n}.gif`, desc: n.replace(/^deco2?_/, '').replace(/_/g, ' '), group: 'decor' }));
  const order = ['basics', 'people', 'animals', 'smileys', 'glitter', 'goth', 'kawaii', 'space', 'tech', 'food', 'music'];
  const all = [...basics, ...pack, ...decor];
  const seen = new Set();
  const groups = uniq(all.map(a => a.group));
  const sorted = [...order.filter(g => groups.includes(g)), ...groups.filter(g => !order.includes(g) && g !== 'decor').sort(), 'decor'];
  return sorted.flatMap(g => all.filter(a => a.group === g))
    .filter(a => !seen.has(a.file) && seen.add(a.file))
    .map(a => ({ file: asset(a.file), desc: a.desc, group: a.group }));
}

/* ------------------------------------------------------------- the essays */
const PAGE = ({ title, desc, body, current }) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${desc}">
    <link rel="icon" href="/assets/pfp.png">
    <link rel="stylesheet" href="/app.css">
</head>
<body class="static-page">
    <!-- GENERATED by tools/build.mjs from the original site's ${current}. The essay is reproduced verbatim: do not edit the prose. -->
    <div id="page">
        <header class="os-top">
            <div class="ms-header">
                <a class="ms-logo" href="/">ourspace<span class="ms-logo-dot">.</span></a>
                <span class="ms-slogan">a place for friends</span>
            </div>
            <nav class="ms-tabs">
                <a class="ms-tab" href="/">Home</a>
                <a class="ms-tab" href="/browse">Browse</a>
                <a class="ms-tab" href="/bulletins">Bulletins</a>
                <a class="ms-tab on" href="/blog/">Blog</a>
            </nav>
        </header>
        <main class="page-doc">
${body}
        </main>
        <footer class="os-foot"><a href="/rules">house rules</a> · <a href="/blog/">blog</a> · <a href="/">ourspace</a> — a place for friends</footer>
    </div>
</body>
</html>
`;

function buildPost(p) {
  const html = fs.readFileSync(path.join(ROOT, p.file), 'utf8');
  const start = html.indexOf('<article class="post">');
  const end = html.indexOf('</article>');
  if (start < 0 || end < 0) throw new Error(`${p.file}: no <article class="post">`);
  let article = html.slice(start, end + '</article>'.length);
  // the footer pointed at the desktop and its guestbook; everything above it (the essay) is copied as-is
  const foot = `<footer class="post-foot">
                        <img src="/assets/deco_rainbow_bar.gif" alt="" class="bar-gif">
                        <p>thanks for reading. if you want to say something back, leave a comment on
                        <a href="/u/malten">malten's page</a>.</p>
                        <a class="btn98" href="/blog/">📁 all posts</a>
                        <a class="btn98" href="/">👥 back to ourspace</a>
                    </footer>`;
  article = article.replace(/<footer class="post-foot">[\s\S]*?<\/footer>/, foot);
  const leftover = article.match(/(src|href)="(?!\/|https?:)[^"]*"/g);
  if (leftover) throw new Error(`${p.file}: relative links left in the article: ${leftover.join(', ')}`);
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || p.title;
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || p.desc;
  fs.writeFileSync(path.join(PUBLIC, 'blog', p.file), PAGE({ title: title.replace('MALTEN.EXE', 'OurSpace'), desc, body: '            ' + article, current: p.file }));
}

function buildHub() {
  const items = POSTS.map(p => `
            <div class="blog-preview">
                <img src="/assets/pfp.png" alt="">
                <div>
                    <a href="/blog/${p.file.replace(/\.html$/, '')}">${p.title}</a>
                    <div class="blog-date">post #${p.num} · ${p.date}</div>
                    <div class="desc">${p.desc}</div>
                </div>
            </div>`).join('\n');
  const body = `            <p class="rainbow-text hub-title">★ malten's blog ★</p>
            <img src="/assets/deco_hearts_bar.gif" alt="" class="bar-gif">
            <!-- GENERATED from POSTS in tools/build.mjs: add a post there, then rebuild -->
${items}
            <img src="/assets/construction_tape.gif" alt="" class="divider-gif">
            <p class="hub-soon">
                <img src="/assets/under_repair_dog.gif" alt="under repair dog" height="90"><br>
                <span class="blink">more posts under construction…</span>
            </p>`;
  fs.writeFileSync(path.join(PUBLIC, 'blog', 'index.html'),
    PAGE({ title: "malten's blog — OurSpace", desc: 'Every blog post malten has written, all in one place.', body, current: 'blog-hub.html' }));
}

/* ------------------------------------------------------------------ main */
fs.rmSync(path.join(PUBLIC, 'assets'), { recursive: true, force: true });   // copies only: rebuilt from scratch every time
fs.mkdirSync(GEN, { recursive: true });
fs.mkdirSync(path.join(PUBLIC, 'blog'), { recursive: true });

UI_ASSETS.forEach(asset);
const { OPTION_ASSETS } = await import(path.join(SOCIAL, 'src', 'options.js'));   // every editor choice (tiles, decor, badges)
OPTION_ASSETS.forEach(u => asset(u.replace(/^\//, '')));

const bots = BOT_IDS.map(buildBot);
const avatars = buildAvatars();
const botsJson = JSON.stringify(bots);
const version = crypto.createHash('sha256').update(botsJson).digest('hex').slice(0, 12);
const header = '// GENERATED by `node tools/build.mjs` from the original site\'s content-src/ — do not edit by hand.\n';
fs.writeFileSync(path.join(GEN, 'bots.js'), `${header}export const BOTS_VERSION = '${version}';\nexport const BOTS = ${JSON.stringify(bots, null, 1)};\n`);
fs.writeFileSync(path.join(GEN, 'avatars.js'), `${header}export const AVATARS = ${JSON.stringify(avatars, null, 1)};\n`);

POSTS.forEach(buildPost);
buildHub();

const bytes = [...copied].reduce((n, f) => n + fs.statSync(path.join(PUBLIC, f)).size, 0);
console.log(`bots: ${bots.length} (${bots.map(b => b.name).join(', ')}) · version ${version}`);
console.log(`lines: ${bots.reduce((n, b) => n + b.lines.statuses.length + b.lines.replies.length + b.lines.dms.length, 0)} statuses/replies/dms, ${bots.reduce((n, b) => n + b.wallSeeds.length, 0)} bot-to-bot wall comments, ${bots.reduce((n, b) => n + b.blog.length, 0)} blog entries`);
console.log(`avatars: ${avatars.length} presets`);
console.log(`assets: ${copied.size} files, ${(bytes / 1024 / 1024).toFixed(2)} MB → public/assets`);
console.log(`blog: ${POSTS.length} posts + index → public/blog`);
