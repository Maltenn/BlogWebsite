// `npm run demo`: the whole site running on your own computer, filled with sample people and posts, for looking around
// and deciding what to change. It never touches the real site, a real database or anybody's real accounts:
//   · its database lives in social/.demo/ and is kept between runs (`npm run demo -- --fresh` starts over)
//   · "Continue with Google" etc. and "connect Spotify" open labeled pretend pages (test/mock-providers.mjs)
//   · "forgot my password" emails are printed in this window instead of being sent
// Edit files in public/ or src/ while it runs and the server reloads; refresh the browser to see the change.
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, '.demo');
const STATE = path.join(DEMO, 'state');
const SEEDED = path.join(DEMO, 'seeded');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'ourspace-demo';

function die(message) {
  console.error('\n  ✖ ' + message + '\n');
  process.exit(1);
}
const say = message => console.log('  ' + message);

if (Number(process.versions.node.split('.')[0]) < 22) die(`the demo needs Node.js 22 or newer (this is ${process.version}). get it from https://nodejs.org`);
if (!fs.existsSync(WRANGLER)) die('run `npm install` in the social folder first.');
const { startMock } = await import('../test/mock-providers.mjs');

if (process.argv.includes('--fresh')) fs.rmSync(DEMO, { recursive: true, force: true });
fs.mkdirSync(DEMO, { recursive: true });

// the first free port at or after `from`, so a server you already have running doesn't get in the way
async function freePort(from) {
  for (let p = from; p < from + 50; p++) {
    const free = await new Promise(res => {
      const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  die(`couldn't find a free port near ${from}.`);
}

function wrangler(args) {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: 'pipe' }).toString();
  } catch (e) {
    die(`wrangler ${args[0]} failed:\n${e.stderr || ''}${e.stdout || ''}`);
  }
}
const sql = command => wrangler(['d1', 'execute', 'ourspace-social-db', '--local', '--persist-to', STATE, '--command', command]);

/* ------------------------------------------------------------ the sample */

// a tiny browser: a cookie jar, JSON in and out, redirects left for the caller
function client() {
  const jar = new Map();
  const raw = async (method, url, body) => {
    const headers = {};
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c) || i === pair.length - 1) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
  const call = async (method, url, body) => {
    const res = await raw(method, url, body);
    const data = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status} ${data && data.error}`);
    return data;
  };
  return { raw, get: u => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b) };
}

const pic = file => '/assets/avatars/' + file;
const gif = name => `/assets/${name}.gif`;

const PEOPLE = [
  { key: 'you', name: 'the_reviewer', email: 'you@example.com', birthday: '1998-04-12', avatar: pic('pic_star_top_hat.gif'),
    profile: { tag: 'just looking around', mood: 'curious', theme: 'classic-purple',
      about: 'this is your demo account. change anything you like: Edit My Page, Settings, connect the pretend Spotify, post a status. nothing here is real or public.' } },
  { key: 'malten', name: 'malten', email: 'malten@example.com', birthday: '1995-06-18', avatar: pic('pic_cd_rainbow.gif'),
    profile: { tag: 'i run this place', mood: 'caffeinated', theme: 'ourspace-blue', hereFor: 'Friends, The bulletins',
      about: 'the site owner and moderator in this demo. log in as me to see the Moderation tab: reports, hiding posts, bans and the log.' } },
  { key: 'kat', name: 'xX_glitterkat_Xx', email: 'kat@example.com', birthday: '2001-02-14', avatar: pic('pic_glitter_heart_pink.gif'), spotify: 'short_term',
    profile: { tag: '♥ glitter is a lifestyle ♥', mood: 'sparkly', hometown: 'the mall food court', status: 'Saving myself for my Top 8', hereFor: 'Friends, Glitter, Top 8 drama',
      about: 'hiii!! i\'m kat. i collect glitter gifs, hello kitty everything and way too many layouts. my top 8 changes weekly, don\'t take it personally ♥\n\nleave me a comment!!',
      meet: 'anyone who still makes mix CDs.',
      interests: { General: 'glitter gifs, sleepovers, photo booths, layouts', Music: 'paramore, avril, the killers, britney (forever)', Movies: 'mean girls, she\'s the man, aquamarine', Television: 'laguna beach, the OC', Books: 'the princess diaries', Heroes: 'whoever invented the sparkle cursor' },
      theme: 'bubblegum', bgTile: '/assets/tiles/tile_hearts.png', font: '"Comic Sans MS", cursive',
      decor: [gif('deco_sparkle_bunny'), gif('deco_hearts_bar')], badges: [gif('badge_hello_kitty'), gif('badge_aim'), gif('badge_blink')] } },
  { key: 'jules', name: 'sk8r_jules', email: 'jules@example.com', birthday: '1999-07-04', avatar: pic('icon_gc_skater_kickflip.gif'),
    profile: { tag: 'landed my first kickflip 4 real', mood: 'stoked', hometown: 'behind the 7-eleven', status: 'Engaged to my Xbox', hereFor: 'Friends, Music',
      about: 'skate, eat, sleep, repeat. i film my friends falling off stuff and call it a documentary.', meet: 'someone who can fix a snapped deck.',
      interests: { General: 'skating, tony hawk games, bmx videos', Music: 'blink-182, yellowcard, sum 41', Movies: 'lords of dogtown', Television: 'rob & big', Books: 'thrasher (does that count)', Heroes: 'my older cousin' },
      theme: 'sk8r-blue', bgTile: '/assets/tiles/tile_checker.png', font: 'Verdana, sans-serif', badges: [gif('badge_8bit'), gif('badge_winamp')] } },
  { key: 'drew', name: 'emo_drew', email: 'drew@example.com', birthday: '1997-11-08', avatar: pic('pic_heart_skull.gif'), settings: { wallPolicy: 'friends' },
    profile: { tag: 'the night is my diary', mood: 'misunderstood', hometown: 'a basement show', status: 'It\'s Complicated', hereFor: 'Pen pals', showAge: false,
      about: 'i write poems in the margins of my chemistry notes. eyeliner is self-expression. replies may be slow, i\'m probably at a show.', meet: 'whoever keeps requesting MCR at the roller rink.',
      interests: { General: 'poetry, band tees, thrift stores', Music: 'my chemical romance, taking back sunday, dashboard confessional', Movies: 'donnie darko', Television: 'buffy', Books: 'the perks of being a wallflower', Heroes: 'anyone who finishes their poems' },
      theme: 'scene-queen', bgTile: '/assets/tiles/tile_skulls.png', font: '"Lucida Console", monospace',
      decor: [gif('deco_skull'), gif('deco_moon')], badges: [gif('badge_coffee')], blogTitle: 'rain, mostly' } },
  { key: 'pete', name: 'pixelpete', email: 'pete@example.com', birthday: '1994-05-30', avatar: pic('pic_computer_beige.gif'), spotify: 'medium_term',
    profile: { tag: 'it works on my machine', mood: 'compiling', hometown: 'the computer lab', status: 'Married to my Wacom', hereFor: 'Networking, Free layouts',
      about: 'i make layouts, pixel art and the occasional website that only works in one browser. ask me for a layout, i might say yes.', meet: 'someone who remembers their AIM password.',
      interests: { General: 'pixel art, html, retro games', Music: 'daft punk, the postal service, chiptune', Movies: 'hackers, the matrix', Television: 'futurama', Books: 'snow crash', Heroes: 'whoever made geocities' },
      theme: 'crt-green', font: '"Courier New", monospace',
      badges: [gif('badge_built_with_microsoft_notepad'), gif('badge_netscape'), gif('badge_geocities'), gif('badge_best_viewed_with_eyes')] } },
  { key: 'mia', name: 'starlight_mia', email: 'mia@example.com', birthday: '2003-09-27', avatar: pic('pic_moon_golden.gif'),
    profile: { tag: '✩ written in the stars ✩', mood: 'cosmic', hometown: 'somewhere under the full moon', status: 'Swiss (neutral)', hereFor: 'Friends, The bulletins',
      about: 'libra sun, always reading everyone\'s horoscope before my own. i will absolutely ask for your birthday.', meet: 'a fellow air sign who answers texts.',
      interests: { General: 'astrology, stargazing, journaling, tarot (for fun)', Music: 'florence + the machine, fleetwood mac, lana del rey', Movies: 'practical magic, stardust', Television: 'charmed', Books: 'the little prince', Heroes: 'every astronomer ever' },
      theme: 'nightcore', bgTile: '/assets/tiles/tile_stars_neon.png', font: 'Georgia, serif', decor: [gif('deco_moon'), gif('deco_fairy')], blogTitle: 'notes from orbit' } },
  { key: 'banana', name: 'dj_bananabread', email: 'banana@example.com', birthday: '1996-03-21', avatar: pic('pic_headphones_neon.gif'), spotify: 'long_term',
    profile: { tag: 'mixtapes baked fresh daily', mood: 'bouncy', hometown: 'the aux cord', status: 'Single', hereFor: 'Music, Networking',
      about: 'bedroom DJ. i make mixes for every occasion: road trips, breakups, homework, cleaning your room. requests open!', meet: 'anyone with a better playlist than mine (impossible).',
      interests: { General: 'mixing, vinyl, baking banana bread', Music: 'gorillaz, missy elliott, outkast, daft punk', Movies: 'high fidelity, scott pilgrim', Television: 'yo gabba gabba (ironically)', Books: 'record store price guides', Heroes: 'whoever invented the crossfader' },
      theme: 'banana', bgTile: '/assets/bg_stars_tile.gif', decor: [gif('deco_record_dj'), gif('deco_banana_tiny')], badges: [gif('badge_winamp'), gif('badge_midi_files_now')] } },
];

async function connectSpotify(c, range) {
  mock.next('spotify', { sub: 'spotify-' + c.name.toLowerCase(), email: null, verified: true, name: c.name });
  const start = await c.raw('GET', '/api/oauth/spotify/start?mode=spotify');
  const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location'));
  const done = await c.raw('GET', back.pathname + back.search);
  if (!/spotify=connected/.test(done.headers.get('location') || '')) throw new Error('connecting the pretend Spotify failed');
  if (range !== 'short_term') await c.put('/api/me/spotify', { timeRange: range, show: true });
}

async function seed() {
  const P = {};
  for (const p of PEOPLE) {
    const c = client();
    const r = await c.post('/api/signup', { email: p.email, password: PASSWORD, name: p.name, birthday: p.birthday, avatar: p.avatar, rulesOk: true });
    Object.assign(c, { id: r.user.id, name: p.name });
    if (p.settings) await c.put('/api/me/settings', p.settings);
    P[p.key] = c;
  }
  const { you, malten, kat, jules, drew, pete, mia, banana } = P;
  const friends = async (a, b) => { await a.post('/api/friends/' + b.name); await b.post('/api/friends/' + a.name); };
  for (const [a, b] of [[kat, jules], [kat, mia], [kat, drew], [kat, pete], [jules, pete], [pete, banana], [mia, banana], [drew, mia], [kat, you], [pete, you], [mia, you], [malten, you], [malten, kat]]) await friends(a, b);
  await jules.post('/api/friends/' + you.name);                      // two requests waiting for you
  await banana.post('/api/friends/' + you.name);
  for (const p of PEOPLE) await P[p.key].put('/api/me/profile', p.key === 'kat' ? { ...p.profile, top8: [mia.id, jules.id, drew.id, pete.id, you.id] } : p.profile);
  for (const p of PEOPLE) if (p.spotify) await connectSpotify(P[p.key], p.spotify);

  const status = (c, body) => c.post('/api/status', { body });
  const wall = (from, to, body) => from.post(`/api/users/${encodeURIComponent(to.name)}/wall`, { body });
  const dm = (from, to, body) => from.post('/api/inbox/' + encodeURIComponent(to.name), { body });

  await status(pete, 'debugging my layout at 2am. the marquee won\'t stop. send help');
  await wall(jules, kat, 'ur layout is blinding me (compliment)');
  await kat.post('/api/bulletins', { subject: 'TAKE THIS SURVEY!!! ♥', body: 'copy, paste, repost!!\n\n1. name: kat\n2. fave color: glitter\n3. last song you heard: misery business\n4. top 8 drama level (1-10): 11\n5. would you rather never use the internet again, or only listen to one song forever?\n\nrepost with ur answers!!' });
  await status(jules, 'landed it!!! (once) (nobody filmed it)');
  await drew.post('/api/blog', { title: 'rain, again', mood: 'melancholy', body: 'the bus window is a painting\nthat only knows one color\n\ni count the drops\nthe way other people count sheep\n\nsomeone in the back is playing\nthe same song as my headphones\nand for one stop\nwe are a band' });
  const peteWall = await wall(pete, kat, 'nice layout. the sparkle cursor is a choice');
  await status(mia, 'the moon is in my sign today and i can FEEL it');
  await wall(drew, mia, 'thanks for the tarot reading. the tower card was rude though');
  await pete.post('/api/bulletins', { subject: 'free layouts!!', body: 'taking layout requests this weekend. tell me your colors and your favorite band. no promises on the marquee.' });
  await wall(banana, pete, 'ur playlist is decent. jk it\'s elite');
  await mia.post('/api/blog', { title: 'full moon notes', mood: 'dreamy', body: 'the moon was so bright tonight that i could read without a lamp. i made a list of everything i want to let go of this month and then fell asleep before i finished it, which honestly feels like the point.\n\nthings i\'m keeping: my friends, my playlists, the glow-in-the-dark stars on my ceiling.\n\nthings i\'m letting go of: checking if someone read my message. it\'s a full moon, not a read receipt.' });
  await wall(mia, banana, 'your banana bread mix cured my mercury retrograde');
  await banana.post('/api/bulletins', { subject: 'new mix out', body: '"songs to clean your room to" vol. 2 is done. 14 tracks, zero skips. message me for the tracklist.' });
  await wall(kat, jules, 'film me next time, i wanna be in the documentary');
  await status(drew, 'new poem on my blog. it\'s about rain. it\'s always about rain');
  await dm(drew, mia, 'did you mean it about the tower card');
  await dm(mia, drew, 'it means change!! good change. probably');
  await status(banana, 'new mix: songs to clean your room to. link in my bulletin');
  await wall(kat, you, 'hiii welcome to ourspace!!! ur page needs more glitter tho ♥ add me to ur top 8 or else (jk) (unless?)');
  await dm(pete, you, 'hey, saw you joined. want a layout? i have a green one with a marquee');
  await dm(you, pete, 'maybe! what colors do you have?');
  await wall(mia, you, 'what\'s your sign?? wait never mind, it\'s on your page. ARIES. that explains the confidence ✩');
  await status(kat, 'new layout!!! tell me what u think ♥');
  await dm(pete, you, 'green. also green. (i can do purple too)');
  await dm(kat, you, 'omg hi!! welcome!! did u see my survey bulletin?? take it!!!');
  await kat.post('/api/reports', { type: 'post', id: peteWall.id, reason: 'harassment', details: 'he\'s being mean about my sparkle cursor (jk, i\'m testing the report button)' });

  // spread it all over the last day or so, so the feed and inbox read like a real afternoon, not one second
  const now = Date.now();
  sql(`UPDATE posts SET created = ${now} - ((SELECT MAX(id) FROM posts) - id) * 1500000 - 240000`);
  sql(`UPDATE messages SET created = ${now} - ((SELECT MAX(id) FROM messages) - id) * 1200000 - 120000`);
  sql('UPDATE users SET created = COALESCE((SELECT MIN(created) FROM posts WHERE author_id = users.id AND kind = \'joined\'), created)');
  sql(`UPDATE users SET is_admin = 1 WHERE name_key = 'malten'`);
}

/* ---------------------------------------------------------------- start */

say('setting up the demo database…');
wrangler(['d1', 'migrations', 'apply', 'ourspace-social-db', '--local', '--persist-to', STATE]);

const mock = await startMock(await freePort(8899), { pretend: true });
const PORT = await freePort(Number(process.env.PORT) || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

// the key that encrypts stored Spotify tokens has to stay the same between runs
const keyFile = path.join(DEMO, 'token-key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('base64'));
const vars = {
  TEST_PROVIDER_BASE: mock.base, TOKEN_KEY: fs.readFileSync(keyFile, 'utf8').trim(), SIGNUPS_PER_IP_PER_HOUR: '1000',
  GOOGLE_CLIENT_ID: 'demo', GOOGLE_CLIENT_SECRET: 'demo', MICROSOFT_CLIENT_ID: 'demo', MICROSOFT_CLIENT_SECRET: 'demo',
  DISCORD_CLIENT_ID: 'demo', DISCORD_CLIENT_SECRET: 'demo', GITHUB_CLIENT_ID: 'demo', GITHUB_CLIENT_SECRET: 'demo',
  APPLE_CLIENT_ID: 'page.ourspace.demo', APPLE_TEAM_ID: 'DEMO', APPLE_KEY_ID: 'DEMO',
  APPLE_PRIVATE_KEY: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  SPOTIFY_CLIENT_ID: 'demo', SPOTIFY_CLIENT_SECRET: 'demo',
};

say('starting the site…');
let stopping = false;
const server = spawn(process.execPath, [WRANGLER, 'dev', '--name', 'ourspace-social-demo', '--port', String(PORT), '--ip', '127.0.0.1',
  '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });

// wrangler is chatty: before the site is up its output is kept (and shown only if it fails); after, everything but
// request logs and known noise is passed through, which is how the password-reset emails reach you
let ready = false;
let early = '';
let blank = true;                                     // (so stray blank lines before any output are skipped)
const NOISE = [/^\[wrangler:info\] (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, /Request\.cf/, /^Error: Request was cancelled/, /^\s+at /,
  /Parsed \d+ valid header/, /Reloading local server/, /Proxy environment variables/, /dev session is running in an AI agent/,
  /Local Explorer API|Useful routes|cdn-cgi\/local/];
function relay(chunk) {
  const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
  if (!ready) { early += text; return; }
  for (const line of text.split(/\r?\n/)) {
    if (NOISE.some(re => re.test(line))) continue;
    if (/Local server updated and ready/.test(line)) { say('↻ reloaded with your changes (refresh the page)'); continue; }
    if (!line.trim()) { if (!blank) console.log('  │'); blank = true; continue; }
    blank = false;
    console.log('  │ ' + line);
  }
}
server.stdout.on('data', relay);
server.stderr.on('data', relay);
server.on('exit', code => {
  if (stopping) return;
  console.error(ready ? '\n  ✖ the site stopped.' : '\n  ✖ the site didn\'t start. what wrangler said:\n\n' + early);
  mock.close().finally(() => process.exit(code || 1));
});

async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\n  stopping the demo…');
  server.kill();
  await mock.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function fail(message) {
  stopping = true;
  server.kill();
  await mock.close();
  die(message);
}

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/api/options')).ok) break; } catch { /* not up yet */ }
  if (i > 240) await fail('the site took too long to start. what wrangler said:\n\n' + early);
  await new Promise(r => setTimeout(r, 500));
}
ready = true;

if (!fs.existsSync(SEEDED)) {
  say('adding the sample people and posts (first run only)…');
  try {
    await seed();
  } catch (e) {
    await fail('adding the sample content failed: ' + e.message + '\n  try again with: npm run demo -- --fresh');
  }
  fs.writeFileSync(SEEDED, new Date().toISOString());
}

console.log(`
  ┌──────────────────────────────────────────────────────────────────────────┐
     ourspace demo is running:   ${BASE}
  └──────────────────────────────────────────────────────────────────────────┘

  Log in as you:     you@example.com  /  ${PASSWORD}     (screen name the_reviewer, a regular member)
  The moderator:     malten@example.com, same password     (sees the Moderation tab and a sample report)
  Or anyone else:    kat@, jules@, drew@, pete@, mia@ or banana@example.com, same password

  · Everything is fake and stays on this computer. Sign up as many new people as you like.
  · "Other options" (Google, Apple…) and "connect Spotify" open pretend pages.
    Type any name there; the same name brings back the same pretend account.
  · "forgot my password" emails show up in this window instead of being sent.
  · Edit files in public/ or src/ and refresh the page to see the change.
  · Start over with:  npm run demo -- --fresh        Stop with:  Ctrl+C
`);
