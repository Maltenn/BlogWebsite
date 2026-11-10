// .github/workflows/*.yml, read the way GitHub reads them: `npm test`. No network.
// GitHub refuses a whole workflow file over one mistake, runs none of its jobs, and says only "a workflow file issue".
// b75b617 gave one step two `env:` keys and PR #1 ran no checks at all, with 351 tests passing. These are the mistakes
// that fail that way, plus the file's own rule that every action is pinned to a commit SHA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter(f => /\.ya?ml$/.test(f));

// The keys GitHub's workflow syntax allows at each level. Anything else (a typo, a step key put on a job) is refused.
const TOP = new Set(['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs']);
const JOB = new Set(['name', 'permissions', 'needs', 'if', 'runs-on', 'snapshot', 'environment', 'concurrency', 'outputs', 'env',
  'defaults', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error', 'container', 'services', 'uses', 'with', 'secrets']);
const STEP = new Set(['id', 'if', 'name', 'uses', 'run', 'working-directory', 'shell', 'with', 'env', 'continue-on-error', 'timeout-minutes']);
const PINNED = /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/;

// Throws on anything a YAML parser rejects, a repeated key included (the `yaml` package's uniqueKeys, on by default).
function readWorkflow(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'));
  return doc.toJS();
}

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function unclosedExpressions(value, where, out) {
  if (typeof value === 'string') {
    for (const part of value.split('${{').slice(1)) if (!part.includes('}}')) out.push(`${where}: \${{ with no closing }}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => unclosedExpressions(v, `${where}[${i}]`, out));
  else if (isMap(value)) for (const [k, v] of Object.entries(value)) unclosedExpressions(v, `${where}.${k}`, out);
}

function checkUses(uses, where, out) {
  if (typeof uses !== 'string') return out.push(`${where}: uses is not a string`);
  if (uses.startsWith('./') || uses.startsWith('docker://')) return;
  if (!PINNED.test(uses)) out.push(`${where}: ${uses} is not pinned to a 40-character commit SHA`);
}

// Every problem GitHub would refuse the file for (or that breaks the pinning rule), as readable strings. [] is clean.
function problems(wf) {
  const out = [];
  if (!isMap(wf)) return ['the file is not a mapping'];
  for (const k of Object.keys(wf)) if (!TOP.has(k)) out.push(`unknown top-level key "${k}"`);
  if (wf.on === undefined) out.push('no "on:" trigger');
  if (!isMap(wf.jobs) || !Object.keys(wf.jobs).length) return [...out, 'no jobs'];
  const names = new Set(Object.keys(wf.jobs));
  for (const [name, job] of Object.entries(wf.jobs)) {
    const at = `jobs.${name}`;
    if (!isMap(job)) { out.push(`${at}: not a mapping`); continue; }
    for (const k of Object.keys(job)) if (!JOB.has(k)) out.push(`${at}: unknown key "${k}"`);
    for (const need of [job.needs ?? []].flat()) if (!names.has(need)) out.push(`${at}: needs "${need}", which is not a job here`);
    if (job.uses !== undefined) {
      if (job.steps !== undefined || job['runs-on'] !== undefined) out.push(`${at}: a reusable-workflow job cannot also have steps or runs-on`);
      checkUses(job.uses, `${at}.uses`, out);
      continue;
    }
    if (job['runs-on'] === undefined) out.push(`${at}: no runs-on`);
    if (!Array.isArray(job.steps) || !job.steps.length) { out.push(`${at}: no steps`); continue; }
    job.steps.forEach((step, i) => {
      const where = `${at}.steps[${i}]${isMap(step) && step.name ? ` (${step.name})` : ''}`;
      if (!isMap(step)) return out.push(`${where}: not a mapping`);
      for (const k of Object.keys(step)) if (!STEP.has(k)) out.push(`${where}: unknown key "${k}"`);
      if ((step.uses === undefined) === (step.run === undefined)) out.push(`${where}: needs exactly one of uses and run`);
      if (step.uses !== undefined) checkUses(step.uses, `${where}.uses`, out);
    });
  }
  unclosedExpressions(wf, 'workflow', out);
  return out;
}

test('there is a workflow to check', () => {
  assert.ok(FILES.includes('mobile.yml'), `found: ${FILES.join(', ') || 'nothing'}`);
});

for (const file of FILES) {
  test(`${file} parses with no repeated key, and has the shape GitHub requires`, () => {
    const wf = readWorkflow(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.deepEqual(problems(wf), []);
  });
}

test('mobile.yml still has the jobs the docs describe', () => {
  const wf = readWorkflow(fs.readFileSync(path.join(DIR, 'mobile.yml'), 'utf8'));
  assert.deepEqual(Object.keys(wf.jobs), ['bridge', 'tabbar', 'android', 'ios', 'ios-sideload', 'android-release', 'ios-release']);
});

test('a repeated key is refused: the b75b617 mistake', () => {
  const step = (extra = '') => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: x\n        env:\n          A: 1\n${extra}        run: echo\n`;
  assert.doesNotThrow(() => readWorkflow(step()));
  assert.throws(() => readWorkflow(step('        env:\n          B: 2\n')), /unique/i);
  assert.throws(() => readWorkflow('on: push\non: pull_request\njobs: {}\n'), /unique/i);
});

test('the shape checks catch what GitHub refuses', () => {
  const sha = 'actions/checkout@' + 'a'.repeat(40);
  const wf = steps => ({ on: 'push', jobs: { a: { 'runs-on': 'x', steps } } });
  assert.deepEqual(problems(wf([{ uses: sha }, { run: 'echo' }, { uses: './local' }])), []);

  const has = (w, re) => assert.ok(problems(w).some(p => re.test(p)), `expected ${re} in ${JSON.stringify(problems(w))}`);
  has(wf([{ uses: sha, run: 'echo' }]), /exactly one of uses and run/);
  has(wf([{ name: 'nothing' }]), /exactly one of uses and run/);
  has(wf([{ run: 'echo', enviroment: {} }]), /unknown key "enviroment"/);
  has(wf([{ uses: 'actions/checkout@v4' }]), /not pinned/);
  has(wf([{ run: 'echo ${{ github.sha' }]), /no closing/);
  has(wf([]), /no steps/);
  has({ on: 'push', jobs: { a: { 'runs-on': 'x', needs: ['nope'], steps: [{ run: 'x' }] } } }, /needs "nope"/);
  has({ on: 'push', jobs: { a: { steps: [{ run: 'x' }] } } }, /no runs-on/);
  has({ on: 'push', job: {} }, /unknown top-level key "job"/);
  has({ jobs: { a: { 'runs-on': 'x', steps: [{ run: 'x' }] } } }, /no "on:" trigger/);
});
