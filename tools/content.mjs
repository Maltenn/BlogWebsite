#!/usr/bin/env node
// OurSpace content packs: validate content-src/**.json and compile content-pack.js
//   node tools/content.mjs check <file> [<file>...]   validate specific files
//   node tools/content.mjs check                      validate everything
//   node tools/content.mjs build [outFile]            validate everything, write content-pack.js (or outFile)
// Schema + style rules: content-src/SCHEMA.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'content-src');

const EXISTING = fs.readdirSync(path.join(SRC, 'reference', 'existing')).map(f => f.replace(/\.json$/, ''));
const ROSTER = ['ryan', 'nat', 'hunter', 'rick', 'min', 'dmitri', 'gus', 'sara', 'gary',
  'larry', 'nick', 'marcus', 'lars', 'miles', 'doug', 'angela', 'trevor', 'fred',
  'faye', 'maddie', 'ben', 'devon', 'andy', 'leo', 'hailey', 'tj', 'luna',
  'becca', 'thad', 'ashley', 'tyler', 'yvette', 'tim', 'holly', 'brad', 'henry',
  'skip', 'evan', 'penny', 'aaron', 'ember', 'gwen', 'sven', 'vince', 'harmony',
  'debbie', 'linda', 'walt', 'henderson', 'kyle', 'whiskers', 'bill', 'gina', 'adam'];
const ALL_IDS = new Set([...EXISTING, ...ROSTER]);
const TILES = ['bolts', 'checker', 'checker_pink', 'flowers', 'hearts', 'leopard', 'leopard_tan', 'skulls',
  'skulls_pink', 'stars_neon', 'web', 'zebra', 'zebra_pink'].map(t => `assets/tiles/tile_${t}.png`);

const BANNED = /\b(vibes?|vibing|slay(?:s|ed|ing)?|besties?|main character|lowkey|highkey|sus|yeet(?:ed)?|simp(?:s|ing)?|no cap|rizz|ghosted|ghosting|cringe|cringey|iykyk|selfies?|influencers?|emojis?|hashtags?|tiktok|instagram|snapchat|twitter|tweet(?:s|ed)?|iphone|smartphones?|whore|haters?|haterz|h8rs?|h8rz)\b/i;
const YEAR = /\b(?:19[89]\d|200\d|201\d)\b/;       // "never state the year"
const TIME = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} 2026 \d{1,2}:\d{2} (AM|PM)$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

const isStr = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;
const isArr = (v, min = 0) => Array.isArray(v) && v.length >= min;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => allStrings(x, out));
  else if (isObj(v)) Object.values(v).forEach(x => allStrings(x, out));
  return out;
}

function lint(data, R, { emojiMax }) {
  const strs = allStrings(data);
  let emoji = 0;
  for (const s of strs) {
    const m = s.match(BANNED);
    if (m) R.err(`banned word "${m[0]}" in: "${s.slice(0, 90)}"`);
    emoji += (s.match(/[\u{1F000}-\u{1FAFF}]/gu) || []).length;
    if (/—/.test(s) && /[a-z]—[a-z]/.test(s) === false) { /* spaced em dash: fine */ }
  }
  if (emoji > emojiMax) R.err(`${emoji} emoji (max ${emojiMax}) — use emoticons like =] xD <3 instead`);
  // year check skips timestamps and song metadata
  const prose = allStrings({ ...data, song: null, lastLogin: null })
    .filter(s => !TIME.test(s));
  for (const s of prose) {
    const m = s.match(YEAR);
    if (m) R.warn(`mentions a year (${m[0]}) — never state the year: "${s.slice(0, 80)}"`);
  }
}

function checkBlog(blog, min, bodyMin, R) {
  if (!isArr(blog, min)) return R.err(`blog: need >= ${min} entries`);
  blog.forEach((b, i) => {
    if (!isObj(b) || !isStr(b.title) || !isStr(b.mood) || !isStr(b.body, bodyMin)) R.err(`blog[${i}]: need title, mood, body >= ${bodyMin} chars`);
    if (!b || !TIME.test(b.date || '')) R.err(`blog[${i}].date must look like "Sep 14 2026 11:42 PM"`);
  });
}
function checkSurvey(sv, min, R) {
  if (!isObj(sv) || !isStr(sv.title) || !isArr(sv.qa, min)) return R.err(`survey: need title + qa with >= ${min} pairs`);
  sv.qa.forEach((p, i) => { if (!isArr(p, 2) || p.length !== 2 || !isStr(p[0]) || !isStr(p[1])) R.err(`survey.qa[${i}] must be ["question","answer"]`); });
}
function checkStrList(v, min, name, R, minLen = 8) {
  if (!isArr(v, min)) return R.err(`${name}: need >= ${min} strings`);
  v.forEach((s, i) => { if (!isStr(s, minLen)) R.err(`${name}[${i}] is not a real line`); });
  if (new Set(v).size !== v.length) R.err(`${name}: contains duplicate lines`);
}
function checkBanter(b, minTargets, name, R, self, onlyRoster) {
  if (!isObj(b) || Object.keys(b).length < minTargets) return R.err(`${name}: need >= ${minTargets} targets`);
  for (const [t, lines] of Object.entries(b)) {
    if (!ALL_IDS.has(t)) R.err(`${name}: unknown resident id "${t}"`);
    if (t === self) R.err(`${name}: cannot target themselves`);
    if (onlyRoster && !ROSTER.includes(t)) R.warn(`${name}.${t}: expected targets from the NEW roster`);
    if (!isArr(lines, 2) || lines.some(l => !isStr(l, 8))) R.err(`${name}.${t}: need >= 2 lines`);
  }
}
function checkWall(w, min, name, R, self, needTime) {
  if (!isArr(w, min)) return R.err(`${name}: need >= ${min} entries`);
  w.forEach((c, i) => {
    if (!isObj(c) || !isStr(c.text, 8)) return R.err(`${name}[${i}]: need {from, text}`);
    if (!ALL_IDS.has(c.from)) R.err(`${name}[${i}].from: unknown resident id "${c.from}"`);
    if (c.from === self) R.err(`${name}[${i}]: wall comments come from OTHER residents`);
    if (needTime && !TIME.test(c.time || '')) R.err(`${name}[${i}].time must look like "Sep 14 2026 11:42 PM"`);
  });
}

function checkResident(d, file, R) {
  const id = d.id;
  if (!ROSTER.includes(id)) R.err(`id "${id}" is not in the new-resident roster`);
  if (path.basename(file, '.json') !== id) R.err(`filename must be ${id}.json`);
  for (const k of ['name', 'tag', 'gender', 'hometown', 'loc', 'zodiac', 'status', 'hereFor', 'mood', 'lastLogin', 'blogTitle', 'meet', 'thanksAdd', 'saltyDm'])
    if (!isStr(d[k])) R.err(`missing string field "${k}"`);
  if (!isStr(d.about, 300)) R.err('about: need >= 300 chars');
  if (d.aboutMore !== undefined && !isStr(d.aboutMore, 150)) R.err('aboutMore: need >= 150 chars when present');
  if (typeof d.age !== 'number') R.err('age must be a number');
  if (d.avatar !== `assets/avatar_${id}.gif`) R.err(`avatar must be "assets/avatar_${id}.gif"`);
  if (!isObj(d.theme) || !HEX.test(d.theme.bg) || !HEX.test(d.theme.fg) || !HEX.test(d.theme.accent)) R.err('theme: need {bg, fg, accent} as #rrggbb');
  else if (contrast(d.theme.bg, d.theme.fg) < 4.5) R.err(`theme: fg on bg contrast is ${contrast(d.theme.bg, d.theme.fg).toFixed(1)} (need >= 4.5)`);
  if (d.bgTile !== undefined && !TILES.includes(d.bgTile)) R.err(`bgTile must be one of assets/tiles/tile_*.png (got ${d.bgTile})`);
  const IK = ['General', 'Music', 'Movies', 'Television', 'Books', 'Heroes'];
  if (!isObj(d.interests) || IK.some(k => !isStr(d.interests[k], 10))) R.err(`interests: need ${IK.join(', ')}`);
  const s = d.song;
  if (!isObj(s) || !isStr(s.name) || !isStr(s.artist) || !isArr(s.pattern, 8) || s.pattern.length !== 8 || s.pattern.some(n => !Number.isInteger(n)) || typeof s.bpm !== 'number')
    R.err('song: need {name, artist, url, pattern[8 ints], bpm}');
  else if (s.url && !/^https:\/\/audio-ssl\.itunes\.apple\.com\//.test(s.url)) R.err('song.url must be an audio-ssl.itunes.apple.com preview URL or ""');
  else if (!s.url) R.warn('song.url is empty (chiptune fallback will play)');
  if (!isArr(d.decor, 1) || d.decor.length > 3) R.err('decor: 1-3 asset paths');
  else d.decor.forEach(f => { if (!fs.existsSync(path.join(ROOT, f))) R.err(`decor file does not exist: ${f}`); });
  if (!isArr(d.friends, 5) || d.friends.some(f => !ALL_IDS.has(f) || f === id)) R.err('friends: need >= 5 valid resident ids (not themselves)');
  checkWall(d.wall, 4, 'wall', R, id, true);
  checkStrList(d.replies, 8, 'replies', R, 4);
  checkStrList(d.ambient, 4, 'ambient', R);
  checkStrList(d.statuses, 6, 'statuses', R);
  checkStrList(d.pcComments, 4, 'pcComments', R);
  checkStrList(d.dms, 6, 'dms', R);
  if (!isObj(d.keywords) || Object.keys(d.keywords).length < 4) R.err('keywords: need >= 4');
  else for (const k of Object.keys(d.keywords)) if (k !== k.toLowerCase() || !isStr(d.keywords[k], 8)) R.err(`keywords.${k}: key must be lowercase with a real reply`);
  checkBanter(d.banter, 4, 'banter', R, id, false);
  if (!isArr(d.bulletins, 2) || d.bulletins.some(b => !isObj(b) || !isStr(b.subject) || !isStr(b.body, 40))) R.err('bulletins: need >= 2 {subject, body}');
  if (!isArr(d.dmSeed, 1) || d.dmSeed.some(m => !isObj(m) || !isStr(m.text, 20))) R.err('dmSeed: need 1-2 {text}');
  checkBlog(d.blog, 2, 350, R);
  checkSurvey(d.survey, 8, R);
  lint(d, R, { emojiMax: 6 });
}

function checkDepth(d, file, R) {
  const id = d.id;
  if (!EXISTING.includes(id)) R.err(`id "${id}" is not an existing resident`);
  if (path.basename(file, '.json') !== id) R.err(`filename must be ${id}.json`);
  if (!isStr(d.aboutMore, 250)) R.err('aboutMore: need >= 250 chars');
  checkBlog(d.blog, 3, 400, R);
  checkSurvey(d.survey, 10, R);
  checkStrList(d.dms, 8, 'dms', R);
  checkStrList(d.repliesExtra, 8, 'repliesExtra', R, 4);
  checkStrList(d.statusesExtra, 5, 'statusesExtra', R);
  checkWall(d.wallExtra, 4, 'wallExtra', R, id, false);
  checkBanter(d.banterExtra, 2, 'banterExtra', R, id, true);
  if (d.keywordsExtra !== undefined && !isObj(d.keywordsExtra)) R.err('keywordsExtra must be an object');
  lint(d, R, { emojiMax: 6 });
}

const FEED_FX = ['status', 'wallpost', 'bulletin', 'wall'];
function checkEffects(list, where, tree, R) {
  if (!Array.isArray(list)) return R.err(`${where}: effects must be an array`);
  list.forEach((e, i) => {
    const w = `${where}.effects[${i}]`;
    if (!isObj(e)) return R.err(`${w}: not an object`);
    if (!['status', 'wallpost', 'wall', 'bulletin', 'dm', 'friend'].includes(e.type)) return R.err(`${w}: unknown type "${e.type}"`);
    if (e.type !== 'friend' && !isStr(e.text, 12)) R.err(`${w}: needs text`);
    if (e.type === 'bulletin' && !isStr(e.subject)) R.err(`${w}: bulletin needs subject`);
    if (e.type === 'wallpost') {
      if (!ALL_IDS.has(e.to)) R.err(`${w}: wallpost needs "to" = a resident id (got ${e.to})`);
      if (e.to === (e.from || tree.with)) R.err(`${w}: wallpost to themselves`);
    }
    if (e.from !== undefined && !ALL_IDS.has(e.from)) R.err(`${w}: unknown from "${e.from}"`);
    if (e.delay !== undefined && (typeof e.delay !== 'number' || e.delay < 0 || e.delay > 900)) R.err(`${w}: delay must be 0-900 seconds`);
  });
}
function checkDialogue(d, file, R) {
  if (!isStr(d.id) || path.basename(file, '.json') !== d.id) R.err('id must equal the filename');
  if (!ALL_IDS.has(d.with)) R.err(`with: unknown resident id "${d.with}"`);
  else if (!String(d.id).startsWith(d.with + '_')) R.err(`id should start with "${d.with}_"`);
  if (!isArr(d.opener, 2) || d.opener.length > 4 || d.opener.some(s => !isStr(s, 4))) R.err('opener: 2-4 messages');
  const N = d.nodes;
  if (!isObj(N) || !N.start) return R.err('nodes.start is required');
  const names = Object.keys(N);
  if (names.length < 14 || names.length > 30) R.err(`${names.length} nodes (need 14-26)`);
  let ends = 0, midFx = 0;
  for (const [name, n] of Object.entries(N)) {
    const fx = n.effects || (n.effect ? [n.effect] : []);
    if (n.effects !== undefined || n.effect !== undefined) checkEffects(fx, name, d, R);
    if (name !== 'start' && (!isArr(n.them, 1) || n.them.length > 3 || n.them.some(s => !isStr(s, 2)))) R.err(`${name}: "them" must be 1-3 messages`);
    if (n.end) {
      ends++;
      if (n.choices && n.choices.length) R.err(`${name}: end nodes have no choices`);
      if (fx.length < 2) R.err(`${name}: end nodes need >= 2 effects`);
      if (!fx.some(e => FEED_FX.includes(e.type))) R.err(`${name}: needs an effect that posts publicly (status/wallpost/bulletin/wall)`);
      if (!fx.some(e => e.from && e.from !== d.with)) R.err(`${name}: needs one effect with "from" = another resident reacting`);
    } else {
      if (!isArr(n.choices, 2) || n.choices.length > 3) R.err(`${name}: needs 2-3 choices`);
      (n.choices || []).forEach((c, i) => {
        if (!isStr(c.say, 6)) R.err(`${name}.choices[${i}]: "say" too short`);
        if (!N[c.next]) R.err(`${name}.choices[${i}]: next "${c.next}" does not exist`);
      });
      if (fx.length) midFx++;
    }
  }
  if (ends < 3) R.err(`${ends} end nodes (need >= 3)`);
  if (midFx < 2) R.err(`${midFx} non-end nodes carry effects (need >= 2)`);
  // reachability + minimum depth (BFS)
  const depth = { start: 0 }; const q = ['start'];
  while (q.length) {
    const cur = q.shift();
    for (const c of (N[cur].choices || [])) if (N[c.next] && depth[c.next] === undefined) { depth[c.next] = depth[cur] + 1; q.push(c.next); }
  }
  names.filter(n => depth[n] === undefined).forEach(n => R.err(`node "${n}" is unreachable`));
  names.filter(n => N[n].end && depth[n] !== undefined && depth[n] < 4).forEach(n => R.err(`end node "${n}" is reachable after only ${depth[n]} choices (need >= 4)`));
  lint(d, R, { emojiMax: 3 });
}

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

function kindOf(file) {
  const dir = path.basename(path.dirname(path.resolve(file)));
  return { residents: 'resident', depth: 'depth', dialogues: 'dialogue' }[dir] || null;
}
function checkFile(file) {
  const errs = [], warns = [];
  const R = { err: m => errs.push(m), warn: m => warns.push(m) };
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { R.err('invalid JSON: ' + e.message); return { file, errs, warns, data: null }; }
  const kind = kindOf(file);
  if (!kind) R.err('file must live in content-src/residents, /depth or /dialogues');
  else ({ resident: checkResident, depth: checkDepth, dialogue: checkDialogue })[kind](data, file, R);
  return { file, kind, errs, warns, data };
}
function listAll() {
  return ['residents', 'depth', 'dialogues'].flatMap(d => {
    const dir = path.join(SRC, d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : [];
  });
}
function report(results) {
  let bad = 0;
  for (const r of results) {
    const rel = path.relative(ROOT, r.file).replace(/\\/g, '/');
    if (r.errs.length) bad++;
    console.log(`${r.errs.length ? 'FAIL' : 'ok  '} ${rel}${r.warns.length ? `  (${r.warns.length} warn)` : ''}`);
    r.errs.forEach(e => console.log('   ERROR ' + e));
    r.warns.forEach(w => console.log('   warn  ' + w));
  }
  console.log(`\n${results.length - bad}/${results.length} files valid`);
  return bad;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'check') {
  const files = args.length ? args : listAll();
  process.exit(report(files.map(checkFile)) ? 1 : 0);
} else if (cmd === 'build') {
  const results = listAll().map(checkFile);
  const bad = report(results);
  const good = results.filter(r => !r.errs.length);
  // asset agents write assets-manifest*.json (one file per hunting pass); later files win per resident
  const manifest = {};
  for (const f of fs.readdirSync(SRC).filter(f => /^assets-manifest.*\.json$/.test(f)).sort())
    for (const [id, m] of Object.entries(JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')))) manifest[id] = { ...(manifest[id] || {}), ...m };
  const overridesPath = path.join(SRC, 'avatar-overrides.json');
  const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : {};
  const pack = { people: {}, depth: {}, dialogues: [], posts: [] };
  const exists = f => f && fs.existsSync(path.join(ROOT, f));
  for (const r of good) {
    const d = r.data;
    if (r.kind === 'resident') {
      const { id, ...p } = d;
      const m = manifest[id] || {};
      if (exists(m.avatar)) p.avatar = m.avatar;
      else if (!exists(p.avatar)) { console.log(`   warn  ${id}: no avatar file yet, using placeholder`); p.avatar = 'assets/deco_smiley.gif'; }
      const extraDecor = (m.decor || []).filter(exists);
      if (extraDecor.length) p.decor = [...new Set([...extraDecor, ...p.decor])].slice(0, 3);
      if (exists(m.post) && isStr(m.postCaption)) {
        const lintR = { err: e => console.log(`   ERROR caption ${id}: ${e}`), warn: () => {} };
        lint({ c: m.postCaption, k: m.postComments || [] }, lintR, { emojiMax: 2 });
        pack.posts.push({ from: id, kind: 'gif', src: m.post, caption: m.postCaption, kudos: m.postKudos || 0,
          comments: (m.postComments || []).filter(c => c && ALL_IDS.has(c.from) && c.from !== id && isStr(c.text, 4)).map(c => ({ from: c.from, text: c.text })) });
      }
      pack.people[id] = p;
    } else if (r.kind === 'depth') {
      const { id, ...rest } = d; pack.depth[id] = rest;
    } else if (r.kind === 'dialogue') pack.dialogues.push(d);
  }
  for (const [id, av] of Object.entries(overrides)) if (EXISTING.includes(id) && exists(av.avatar || av)) (pack.depth[id] = pack.depth[id] || {}).avatar = av.avatar || av;
  const out = '/* GENERATED by `node tools/content.mjs build` from content-src/ — do not edit by hand. */\n' +
    'window.MS_PACK = ' + JSON.stringify(pack) + ';\n' +
    'if (window.MS && MS.applyPack) MS.applyPack(window.MS_PACK);\n';
  const outFile = args[0] ? path.resolve(args[0]) : path.join(ROOT, 'content-pack.js');
  fs.writeFileSync(outFile, out);
  console.log(`\nwrote content-pack.js: ${Object.keys(pack.people).length} new residents, ${Object.keys(pack.depth).length} depth packs, ${pack.dialogues.length} dialogue trees, ${pack.posts.length} posts (${(out.length / 1024).toFixed(0)} KB)`);
  process.exit(bad ? 1 : 0);
} else {
  console.log('usage: node tools/content.mjs check [files...] | build');
  process.exit(2);
}
