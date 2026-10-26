// Static checks: `npm test`. No server — these read the files and keep the repo honest as it grows:
//   · every image the code points at exists, and every image in public/assets is used (no leftovers)
//   · every image is credited in public/assets/CREDITS.md (served at /assets/CREDITS.md: CC BY images need reachable credits)
//   · every relative import resolves, and names imported from our own modules are really exported
//   · the layering rules in CONVENTIONS.md (shared/ and js/core/ never reach up; features only cross where allowed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(PUBLIC, 'assets');
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const read = f => fs.readFileSync(f, 'utf8');

function walk(dir, skip = []) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    if (skip.includes(f)) return [];
    return e.isDirectory() ? walk(f, skip) : [f];
  });
}

const srcFiles = walk(path.join(ROOT, 'src')).filter(f => f.endsWith('.js'));
const pageFiles = walk(PUBLIC, [ASSETS]).filter(f => /\.(js|html|css)$/.test(f));
const toolFiles = walk(path.join(ROOT, 'tools')).filter(f => /\.m?js$/.test(f));
const testFiles = walk(path.join(ROOT, 'test')).filter(f => /\.m?js$/.test(f));
const MEDIA = /.(png|gif|jpe?g|webp|svg|ico|webm)$/;
const assetFiles = walk(ASSETS).map(f => path.relative(ASSETS, f).split(path.sep).join('/')).filter(f => MEDIA.test(f));
const CREDITS = path.join(ASSETS, 'CREDITS.md');
// Images whose source nobody has found yet. Fill in their line in CREDITS.md and take them off this list; it may only shrink.
const SOURCE_UNKNOWN = ['stars.png'];

/* ------------------------------------------------------------ assets */

// "/assets/…" as the code writes it. Template-built names (`/assets/${n}.gif`) are covered by importing the catalog.
const ASSET_URL = /\/assets\/[A-Za-z0-9_\-./]+\.(?:png|gif|jpe?g|webp|svg|ico|webm)/g;
const { OPTION_ASSETS } = await import(pathToFileURL(path.join(ROOT, 'src', 'catalog', 'options.js')));
const { AVATARS } = await import(pathToFileURL(path.join(ROOT, 'src', 'catalog', 'avatars.js')));
const referenced = new Map();   // "/assets/x.gif" → first file that mentions it
for (const f of [...srcFiles, ...pageFiles, ...toolFiles]) {
  for (const u of read(f).match(ASSET_URL) || []) if (!referenced.has(u)) referenced.set(u, rel(f));
}
for (const u of [...OPTION_ASSETS, ...AVATARS.map(a => a.file)]) if (!referenced.has(u)) referenced.set(u, 'src/catalog/');

test('every image the code points at exists in public/assets', () => {
  const missing = [...referenced].filter(([u]) => !fs.existsSync(path.join(PUBLIC, u))).map(([u, f]) => `${u} (in ${f})`);
  assert.deepEqual(missing, [], 'missing images');
});

test('every image in public/assets is used somewhere (no leftovers)', () => {
  const orphans = assetFiles.filter(a => !referenced.has('/assets/' + a));
  assert.deepEqual(orphans, [], 'unused images: delete them, or reference them from src/catalog/ or a page');
});

test('every image in public/assets is credited in public/assets/CREDITS.md', t => {
  const text = read(CREDITS);
  const unknownAt = text.search(/^## Source unknown/m);
  const unknown = unknownAt < 0 ? [] : [...text.slice(unknownAt).matchAll(/`([^`]+)`/g)].map(m => m[1]);
  assert.deepEqual(unknown.filter(u => !SOURCE_UNKNOWN.includes(u)), [], 'a new image with no known source: find its source before shipping it');
  if (unknown.length) t.diagnostic(`still no known source: ${unknown.join(', ')}`);
  const tokens = [...(unknownAt < 0 ? text : text.slice(0, unknownAt)).matchAll(/`([^`]+)`/g)].map(m => m[1]).concat(unknown.filter(u => SOURCE_UNKNOWN.includes(u)));
  const globs = tokens.filter(t => t.includes('*')).map(t => new RegExp('^' + t.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$'));
  const exact = new Set(tokens);
  const uncredited = assetFiles.filter(a => !exact.has(a) && !globs.some(g => g.test(a)));
  assert.deepEqual(uncredited, [], 'add a line for each to public/assets/CREDITS.md (path relative to public/assets, in backticks)');
  const stale = tokens.filter(t => /\.(png|gif|jpe?g|webp|svg|webm)$/.test(t) && !t.includes('*') && !assetFiles.includes(t));
  assert.deepEqual(stale, [], 'CREDITS.md lists images that no longer exist');
});

test('every <script src> and <link href> in the pages points at a real file', () => {
  const broken = [];
  for (const f of pageFiles.filter(p => p.endsWith('.html'))) {
    for (const m of read(f).matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(\/[^"]+)"/g)) {
      if (!fs.existsSync(path.join(PUBLIC, m[1]))) broken.push(`${m[1]} (in ${rel(f)})`);
    }
  }
  assert.deepEqual(broken, []);
});

/* ----------------------------------------------------------- imports */

// [file, specifier, imported names | null] for every static import / re-export / dynamic import in our code
function importsOf(file) {
  const code = read(file);
  const out = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1];
    const named = clause.match(/\{([^}]*)\}/);
    const names = named ? named[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [];
    if (/^(import\s+)?[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.replace(/^import\s+/, '')) && !clause.startsWith('*')) names.push('default');
    out.push([file, m[2], clause.startsWith('*') ? null : names]);
  }
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push([file, m[1], null]);
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push([file, m[1], null]);
  return out;
}

function resolveSpec(file, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  if (spec.startsWith('/') && file.startsWith(PUBLIC)) return path.join(PUBLIC, spec);
  return null;   // a package (astronomy-engine, node:…)
}

function exportsOf(file) {
  const code = read(file);
  const names = new Set();
  for (const m of code.matchAll(/^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^\s*export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(s => names.add(s.split(/\s+as\s+/).pop().trim()));
  }
  if (/^\s*export\s+default\b/m.test(code)) names.add('default');
  return names;
}

const ourCode = [...srcFiles, ...pageFiles.filter(f => f.endsWith('.js')), ...toolFiles, ...testFiles];
const allImports = ourCode.flatMap(importsOf).map(([file, spec, names]) => ({ file, spec, names, target: resolveSpec(file, spec) }));

test('every relative import resolves to a file', () => {
  const broken = allImports.filter(i => i.target && !fs.existsSync(i.target)).map(i => `${rel(i.file)}: ${i.spec}`);
  assert.deepEqual(broken, []);
});

test('names imported from our own modules are exported by them', () => {
  const missing = [];
  for (const i of allImports.filter(x => x.target && x.names && fs.existsSync(x.target))) {
    const exported = exportsOf(i.target);
    for (const n of i.names) if (!exported.has(n)) missing.push(`${rel(i.file)}: ${n} is not exported by ${i.spec}`);
  }
  assert.deepEqual(missing, []);
});

/* ---------------------------------------------------------- layering */

// What each part of the code may import (besides packages). See CONVENTIONS.md.
const SRC = path.join(ROOT, 'src');
const CROSS_FEATURE = ['accounts/oauth.js → music/spotify.js', 'profiles/profiles.js → music/spotify.js', 'accounts/auth.js → profiles/profiles.js',
  'boards/boards.js → social/items.js'];
const srcRel = f => path.relative(SRC, f).split(path.sep).join('/');
function srcArea(f) {
  const parts = path.relative(SRC, f).split(path.sep);
  return parts.length === 1 ? '(entry)' : parts[0];
}
function frontArea(f) {
  const r = path.relative(path.join(PUBLIC, 'js'), f).split(path.sep);
  return r[0] === '..' || r.length === 1 ? '(entry)' : r[0];
}

test('back end layering: shared/ and catalog/ never import features; features cross only where CONVENTIONS.md allows', () => {
  const bad = [];
  for (const i of allImports.filter(x => x.target && x.file.startsWith(SRC + path.sep) && x.target.startsWith(SRC + path.sep))) {
    const from = srcArea(i.file), to = srcArea(i.target);
    if (from === '(entry)' || from === to || to === 'shared') continue;
    if (to === 'catalog' && from !== 'shared') continue;
    if (CROSS_FEATURE.includes(`${srcRel(i.file)} → ${srcRel(i.target)}`)) continue;
    bad.push(`${rel(i.file)} → ${rel(i.target)}`);
  }
  assert.deepEqual(bad, []);
});

test('front end layering: js/core/ imports only core; js/widgets/ never imports pages', () => {
  const bad = [];
  for (const i of allImports.filter(x => x.target && x.file.startsWith(path.join(PUBLIC, 'js') + path.sep))) {
    const from = frontArea(i.file), to = frontArea(i.target);
    if ((from === 'core' && to !== 'core') || (from === 'widgets' && !['core', 'widgets'].includes(to))) bad.push(`${rel(i.file)} → ${rel(i.target)}`);
  }
  assert.deepEqual(bad, []);
});

test('the CSP lets the live chat\'s socket reach the site (wss:, and ws: to the local machine for wrangler dev) and nothing else loosens', () => {
  const csp = read(path.join(PUBLIC, '_headers')).match(/Content-Security-Policy: (.*)/)[1].trim();
  const directives = Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  // older WebKit never matched ws:/wss: against 'self' (WebKit bug 235873), and a static header can't name the host
  assert.deepEqual(directives['connect-src'], ["'self'", 'wss:', 'ws://localhost:*', 'ws://127.0.0.1:*']);
  assert.deepEqual([directives['script-src'], directives['default-src']], [["'self'"], ["'self'"]]);
});
