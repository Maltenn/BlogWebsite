// The evaluation harness for the AI-writing detector, and the gate before AI_ENFORCEMENT=enforce (docs/deploy.md).
//
//   node tools/eval-detector.mjs [--dir eval] [--json]
//
// Runs the detector the environment configures (AI_DETECTOR=mock | workersai | pangram | gptzero, with its keys:
// PANGRAM_API_KEY, GPTZERO_API_KEY, or CF_ACCOUNT_ID + CF_API_TOKEN for Workers AI) over a labelled corpus: every
// eval/human/*.txt is a text a person wrote, every eval/ai/*.txt one a model wrote. Each text goes through the same
// cleaning and length rule as a post on the site (src/ai/clean.js: 100 words, 150 for files named blog-*). A text
// "flags" exactly when the site would strike: label AI with a score of 0.95 or more (src/ai/ladder.js).
//
// Prints the confusion matrix, the false-positive rate on human text and the true-positive rate on AI text, each with
// its Wilson 95% interval, and PASS / FAIL against the bar: the upper end of the FPR interval at or under 1%. With
// zero false positives that needs about 300 human texts (the upper bound is roughly 3/n), so the starter corpus
// always fails: it is there to show the pipeline works. Exit code 0 on PASS, 1 on FAIL, 2 on a broken run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detect, detectorName } from '../src/ai/detect.js';
import { eligible } from '../src/ai/clean.js';
import { strikeWorthy } from '../src/ai/ladder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FPR_BAR = 0.01;

// Wilson score interval for k successes in n trials (z = 1.96 for 95%): [low, high]. n = 0 gives [0, 1].
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function readCorpus(dir) {
  const out = [];
  for (const truth of ['human', 'ai']) {
    const d = path.join(dir, truth);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter(f => f.endsWith('.txt')).sort()) {
      out.push({ file: `${truth}/${f}`, truth, kind: f.startsWith('blog-') ? 'blog' : 'thread', text: fs.readFileSync(path.join(d, f), 'utf8') });
    }
  }
  return out;
}

// runs `detector` (text → result) over the corpus: { rows, matrix: { tp, fn, fp, tn }, skipped, errors, fpr, tpr, pass }
export async function evaluate(corpus, detector) {
  const rows = [];
  const m = { tp: 0, fn: 0, fp: 0, tn: 0 };
  let skipped = 0, errors = 0;
  for (const t of corpus) {
    const e = eligible(t.kind, t.text);
    if (!e.ok) { skipped++; rows.push({ ...t, words: e.words, skipped: true }); continue; }
    const r = await detector(e.cleaned);
    if (!r || r.error) { errors++; rows.push({ ...t, words: e.words, error: r ? r.error : 'detector is off' }); continue; }
    const flagged = strikeWorthy(r);
    if (t.truth === 'ai') m[flagged ? 'tp' : 'fn']++; else m[flagged ? 'fp' : 'tn']++;
    rows.push({ ...t, words: e.words, score: r.score, label: r.label, model: r.model, flagged });
  }
  const humans = m.fp + m.tn, ais = m.tp + m.fn;
  const fpr = { rate: humans ? m.fp / humans : null, ci: wilson(m.fp, humans), n: humans };
  const tpr = { rate: ais ? m.tp / ais : null, ci: wilson(m.tp, ais), n: ais };
  return { rows, matrix: m, skipped, errors, fpr, tpr, pass: humans > 0 && fpr.ci[1] <= FPR_BAR };
}

const pct = x => (x == null ? '  n/a ' : `${(x * 100).toFixed(1).padStart(5)}%`);

export function report(res, name) {
  const { matrix: m, fpr, tpr } = res;
  const lines = [
    `detector: ${name}   texts judged: ${fpr.n + tpr.n}   too short to judge: ${res.skipped}   detector errors: ${res.errors}`,
    '',
    '                 flagged AI   not flagged',
    `  written by AI    ${String(m.tp).padStart(6)}       ${String(m.fn).padStart(6)}`,
    `  written by a     ${String(m.fp).padStart(6)}       ${String(m.tn).padStart(6)}`,
    '  person',
    '',
    `  false positives on human text (FPR): ${pct(fpr.rate)}  95% CI ${pct(fpr.ci[0])} – ${pct(fpr.ci[1])}  (n = ${fpr.n})`,
    `  AI texts caught (TPR):               ${pct(tpr.rate)}  95% CI ${pct(tpr.ci[0])} – ${pct(tpr.ci[1])}  (n = ${tpr.n})`,
    '',
    res.pass
      ? `PASS: the FPR's 95% upper bound is ${pct(fpr.ci[1]).trim()}, at or under the 1% bar. Enforcement may be switched on (docs/deploy.md).`
      : `FAIL: the FPR's 95% upper bound is ${pct(fpr.ci[1]).trim()}, over the 1% bar${fpr.n < 300 ? ` (with ${fpr.n} human texts it can't get under ~${pct(Math.min(1, 3 / Math.max(1, fpr.n))).trim()}: grow eval/human/ to 300+)` : ''}. Keep AI_ENFORCEMENT=shadow.`,
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(ROOT, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'eval');
  const env = { ...process.env };
  const name = detectorName(env);
  if (name === 'off') {
    console.error('AI_DETECTOR is off. set it, e.g.  AI_DETECTOR=mock node tools/eval-detector.mjs');
    process.exit(2);
  }
  const corpus = readCorpus(dir);
  if (!corpus.length) { console.error(`no texts in ${dir}/human or ${dir}/ai`); process.exit(2); }
  const res = await evaluate(corpus, text => detect(env, text));
  if (args.includes('--json')) console.log(JSON.stringify({ ...res, rows: res.rows.map(({ text, ...r }) => r) }, null, 2));
  else {
    for (const r of res.rows) {
      const what = r.skipped ? `skipped (${r.words} words)` : r.error ? `error: ${r.error}` : `${r.label.padEnd(6)} ${r.score.toFixed(3)}${r.flagged ? '  FLAGGED' : ''}`;
      console.log(`  ${r.file.padEnd(40)} ${what}`);
    }
    console.log('\n' + report(res, name));
  }
  process.exit(res.errors && !res.fpr.n ? 2 : res.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
