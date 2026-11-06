// `npm run plates:check`: compares captures against the reference plates (plates/manifest.json) with pixelmatch.
//
//   node tools/pixeldiff.mjs                          capture the CURRENT web build now, exactly as the plates were
//                                                     captured (same clock, same freezing), and diff it against them
//   node tools/pixeldiff.mjs --candidate DIR          diff PNGs an app shell produced; DIR/<engine>/<viewport>/<route>--<state>.png,
//                                                     matched by the manifest's keys (see docs/mobile/harness.md)
//   node tools/pixeldiff.mjs --candidate DIR --engine webkit      DIR/<viewport>/<route>--<state>.png, all of it webkit
//
//   --threshold N     fail any plate with more than N percent of its pixels different (default 0.1)
//   --sensitivity N   pixelmatch's per-pixel colour tolerance, 0 to 1 (default 0.1); --strict means 0 and anti-aliasing counted
//   --engine/--viewport/--route/--state a,b   only these
//   --all             list every plate, not only the ones that differ
//   --allow-missing   a plate with no candidate is a warning, not a failure
//   --plates DIR      the baseline (default plates/)      --out DIR   where diff images go (default plates/diff/)
//   plus every capture option of tools/plates.mjs (--url, --jobs, --scale…) when no --candidate is given
//
// Exit status: 0 all within threshold; 1 something exceeds it, is missing, or the run failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ROOT, WORK, capturePass, resolveOptions } from './plates.mjs';

const FLAGS = ['all', 'allow-missing', 'strict', 'help'];
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    a[k] = FLAGS.includes(k) || k === 'headed' || k === 'reuse' ? true : inline ?? argv[++i];
  }
  return a;
}
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null);

// both images padded to the union canvas with opaque magenta, so a missing strip of page counts as different
function pad(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 255; out.data[i + 3] = 255; }
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const platesDir = path.resolve(ROOT, a.plates || 'plates');
  const outDir = path.resolve(ROOT, a.out || path.join(platesDir, 'diff'));
  const threshold = Number(a.threshold ?? 0.1);
  const sensitivity = a.strict ? 0 : Number(a.sensitivity ?? 0.1);
  if (!(threshold >= 0)) throw new Error('--threshold must be a percentage such as 0.1');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(platesDir, 'manifest.json'), 'utf8')); } catch { throw new Error(`no plates/manifest.json in ${platesDir}. run \`npm run plates\` first.`); }

  const only = { engine: list(a.engine), viewport: list(a.viewport), route: list(a.route), state: list(a.state) };
  const keys = Object.keys(manifest.plates).filter(k => {
    const p = manifest.plates[k];
    return p.file && (!only.engine || only.engine.includes(p.engine)) && (!only.viewport || only.viewport.includes(p.viewport)) && (!only.route || only.route.includes(p.route)) && (!only.state || only.state.includes(p.state));
  });
  if (!keys.length) throw new Error('no plates match those filters.');

  // where the candidate pictures are
  let candDir, candidateFile;
  if (a.candidate) {
    candDir = path.resolve(process.cwd(), a.candidate);
    const single = a.engine && !list(a.engine)[1] && !fs.existsSync(path.join(candDir, list(a.engine)[0]));
    candidateFile = p => path.join(candDir, ...(single ? [] : [p.engine]), p.viewport, `${p.route}--${p.state}.png`);
  } else {
    console.log('capturing the current web build the way the plates were captured…');
    candDir = path.join(WORK, 'check');
    fs.rmSync(candDir, { recursive: true, force: true });
    const engines = [...new Set(keys.map(k => manifest.plates[k].engine))];
    const viewportNames = new Set(keys.map(k => manifest.plates[k].viewport));
    const base = resolveOptions({ ...a, engines: engines.join(','), viewports: [...viewportNames].join(','), routes: a.route, states: a.state, now: a.now ?? String(manifest.freeze.now),
      scale: a.scale ?? manifest.freeze.deviceScaleFactor, 'max-height': a['max-height'] ?? manifest.freeze.maxHeight });
    const pass = await capturePass(candDir, base);
    const moved = Object.entries(pass.entries).filter(([k, e]) => manifest.plates[k] && e.path !== manifest.plates[k].path);
    for (const [k, e] of moved) console.log(`  note: ${k} now points at ${e.path}, the plate was taken at ${manifest.plates[k].path}`);
    const bad = Object.values(pass.entries).filter(e => e.error);
    for (const e of bad) console.log(`  capture failed: ${e.engine}/${e.viewport}/${e.route}--${e.state}: ${e.error}`);
    candidateFile = p => path.join(candDir, p.file);
  }

  const rows = [];
  const extras = [];
  for (const k of keys) {
    const p = manifest.plates[k];
    const row = { key: k, engine: p.engine, viewport: p.viewport, route: `${p.route}--${p.state}`, diff: 0, total: 0, pct: 0 };
    const cf = candidateFile(p);
    if (!fs.existsSync(cf)) { row.status = 'MISSING'; rows.push(row); continue; }
    const ref = PNG.sync.read(fs.readFileSync(path.join(platesDir, p.file)));
    const cand = PNG.sync.read(fs.readFileSync(cf));
    const w = Math.max(ref.width, cand.width), h = Math.max(ref.height, cand.height);
    const out = new PNG({ width: w, height: h });
    row.diff = pixelmatch(pad(ref, w, h).data, pad(cand, w, h).data, out.data, w, h, { threshold: sensitivity, includeAA: !!a.strict });
    row.total = w * h;
    row.pct = (100 * row.diff) / row.total;
    if (ref.width !== cand.width || ref.height !== cand.height) row.size = `${cand.width}x${cand.height} vs ${ref.width}x${ref.height}`;
    row.status = row.pct > threshold ? 'FAIL' : row.diff ? 'ok (within threshold)' : 'identical';
    if (row.diff) {
      const f = path.join(outDir, p.engine, p.viewport, `${p.route}--${p.state}.png`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, PNG.sync.write(out));
      row.image = path.relative(ROOT, f);
    }
    rows.push(row);
  }
  if (a.candidate) {                                                         // candidate files nobody asked about
    const known = new Set(keys.map(k => path.resolve(candidateFile(manifest.plates[k]))));
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.png') ? [path.resolve(d, e.name)] : []));
    for (const f of fs.existsSync(candDir) ? walk(candDir) : []) if (!known.has(f)) extras.push(path.relative(candDir, f));
  }

  // the table
  const show = a.all ? rows : rows.filter(r => r.diff || r.status === 'MISSING');
  const width = Math.max(...show.map(r => `${r.engine}/${r.viewport}/${r.route}`.length), 20);
  if (show.length) {
    console.log(`\n${'plate'.padEnd(width)}  ${'diff px'.padStart(10)}  ${'%'.padStart(8)}  status`);
    for (const r of show.sort((x, y) => y.pct - x.pct || (x.key < y.key ? -1 : 1))) {
      console.log(`${`${r.engine}/${r.viewport}/${r.route}`.padEnd(width)}  ${String(r.diff).padStart(10)}  ${r.pct.toFixed(3).padStart(8)}  ${r.status}${r.size ? '  [size ' + r.size + ']' : ''}`);
    }
  }
  const groups = {};
  for (const r of rows) {
    const g = groups[`${r.engine} ${r.viewport}`] ||= { n: 0, identical: 0, within: 0, fail: 0, missing: 0, worst: 0 };
    g.n++;
    if (r.status === 'identical') g.identical++; else if (r.status === 'FAIL') g.fail++; else if (r.status === 'MISSING') g.missing++; else g.within++;
    g.worst = Math.max(g.worst, r.pct);
  }
  console.log(`\n${'engine viewport'.padEnd(22)} plates  identical  within  FAIL  missing  worst %`);
  for (const [g, s] of Object.entries(groups)) console.log(`${g.padEnd(22)} ${String(s.n).padStart(6)}  ${String(s.identical).padStart(9)}  ${String(s.within).padStart(6)}  ${String(s.fail).padStart(4)}  ${String(s.missing).padStart(7)}  ${s.worst.toFixed(3).padStart(7)}`);
  if (extras.length) console.log(`\n${extras.length} candidate PNG(s) match no plate (ignored), e.g. ${extras.slice(0, 3).join(', ')}`);

  const failed = rows.filter(r => r.status === 'FAIL');
  const missing = rows.filter(r => r.status === 'MISSING');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ threshold, sensitivity, strict: !!a.strict, rows }, null, 1));
  console.log(`\nthreshold ${threshold}% of pixels, colour sensitivity ${sensitivity}${a.strict ? ' (strict)' : ''}: ${rows.length} plates, ${failed.length} over threshold, ${missing.length} missing.${rows.some(r => r.diff) ? ` diff images: ${path.relative(ROOT, outDir)}/` : ''}`);
  if (failed.length) console.log('FAIL');
  else if (missing.length && !a['allow-missing']) console.log('FAIL (missing candidates; --allow-missing to accept)');
  else console.log('PASS');
  return failed.length || (missing.length && !a['allow-missing']) ? 1 : 0;
}

main().then(code => process.exit(code), e => { console.error('\npixeldiff failed: ' + (e && e.message || e)); process.exit(1); });
