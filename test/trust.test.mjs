// Phase 7's pure parts, without a server: the sign-up form token and its proof of work, the risk score, throwaway
// email domains and the MX check, Turnstile's verdict, near-duplicate fingerprints, the AI detector adapter and its
// text cleaning, the strike ladder on a fake clock, and the evaluation harness's Wilson intervals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueForm, checkForm, honeypotName, powBits, leadingZeroBits, spendNonce, wasSpent, FORM_TTL } from '../src/trust/form.js';
import { scoreSignup, declaredAgent, HOLD_AT } from '../src/trust/risk.js';
import { isDisposable, domainOf, mailProblem } from '../src/trust/email.js';
import { judgeSiteverify, isTestSecret, checkTurnstile } from '../src/trust/turnstile.js';
import { normalize, words, minhash, similarity, shingles, bands, nearDuplicate, SIMILAR } from '../src/trust/minhash.js';
import { cleanForDetection, eligible, wordCount } from '../src/ai/clean.js';
import { detect, mockDetect, parseProbability, detectorName } from '../src/ai/detect.js';
import * as L from '../src/ai/ladder.js';
import { wilson, evaluate, readCorpus } from '../tools/eval-detector.mjs';
import { solvePow } from './helpers/human.mjs';

const SECRET = 'test-secret';
const T0 = 1_800_000_000_000;

/* ------------------------------------------------------- form + PoW */

test('form token: signed, for one purpose, the honeypot name changes per form, and a minimum time', async () => {
  const a = await issueForm(SECRET, { purpose: 'signup', bits: 6, now: T0 });
  const b = await issueForm(SECRET, { purpose: 'signup', bits: 6, now: T0 });
  assert.notEqual(a.honeypot, b.honeypot, 'a new name every load');
  assert.match(a.honeypot, /^f[0-9a-f]{6}$/);
  assert.equal(a.honeypot, await honeypotName(SECRET, a.nonce), 'the server can work the name out again');
  const pow = solvePow(a.token, 6);
  const ok = await checkForm(SECRET, { token: a.token, pow, body: { [a.honeypot]: '' }, purpose: 'signup', now: T0 + 3000, minMs: 2000 });
  assert.deepEqual([ok.ok, ok.nonce, ok.formMs, ok.honeypotFilled], [true, a.nonce, 3000, false]);
  const fast = await checkForm(SECRET, { token: a.token, pow, body: {}, purpose: 'signup', now: T0 + 1500, minMs: 2000 });
  assert.deepEqual([fast.ok, fast.tooFast], [true, true], 'a rushed form is read as rushed once its proof of work is done');
  assert.equal(ok.tooFast, false);
  const filled = await checkForm(SECRET, { token: a.token, pow, body: { [a.honeypot]: 'http://spam' }, purpose: 'signup', now: T0 + 3000, minMs: 2000 });
  assert.deepEqual([filled.ok, filled.honeypotFilled], [true, true]);
  // the cheap signals are only read after the proof of work: without it, it's just "pow", whatever else was sent
  const lazy = await checkForm(SECRET, { token: a.token, pow: '', body: { [a.honeypot]: 'http://spam' }, purpose: 'signup', now: T0 + 100, minMs: 2000 });
  assert.deepEqual(lazy, { ok: false, code: 'pow' });
  const other = await checkForm(SECRET, { token: a.token, pow, body: {}, purpose: 'finish', now: T0 + 3000, minMs: 2000 });
  assert.equal(other.code, 'form', 'a token is for its own purpose');
  const forged = a.token.slice(0, -2) + (a.token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await checkForm(SECRET, { token: forged, pow, body: {}, purpose: 'signup', now: T0 + 3000, minMs: 0 })).code, 'form');
  assert.equal((await checkForm('another-secret', { token: a.token, pow, body: {}, purpose: 'signup', now: T0 + 3000, minMs: 0 })).code, 'form', 'another key');
  assert.equal((await checkForm(SECRET, { token: 'nonsense', pow, body: {}, purpose: 'signup', now: T0, minMs: 0 })).code, 'form');
});

test('proof of work: the difficulty in the token counts, it expires after 2 hours, and a spent form is refused', async () => {
  assert.equal(leadingZeroBits(Uint8Array.from([0, 0, 0x1f])), 19);
  assert.equal(leadingZeroBits(Uint8Array.from([0x80])), 0);
  const f = await issueForm(SECRET, { purpose: 'signup', bits: 10, now: T0 });
  const good = solvePow(f.token, 10);
  assert.ok(await powBits(f.token, good) >= 10);
  // a counter good for fewer bits only
  let weak = 0;
  while (await powBits(f.token, weak) >= 10 || await powBits(f.token, weak) < 1) weak++;
  const at = T0 + 5000;
  const check = pow => checkForm(SECRET, { token: f.token, pow, body: {}, purpose: 'signup', now: at, minMs: 0 });
  assert.equal((await check(good)).ok, true);
  assert.equal((await check(String(weak))).code, 'pow', 'not enough zero bits');
  assert.equal((await check('')).code, 'pow', 'no proof at all');
  assert.equal((await check('12abc')).code, 'pow', 'digits only');
  const late = await checkForm(SECRET, { token: f.token, pow: good, body: {}, purpose: 'signup', now: T0 + FORM_TTL + 1, minMs: 0 });
  assert.equal(late.code, 'form_expired');
  // single use: the nonce table (a stand-in D1 with a primary key)
  const seen = new Set();
  const env = { DB: { prepare: sql => ({ bind: (...v) => ({
    run: async () => { if (seen.has(v[0])) throw new Error('UNIQUE constraint failed: spent_nonces.nonce'); seen.add(v[0]); return { meta: { changes: 1 } }; },
    first: async () => (/SELECT/.test(sql) && seen.has(v[0]) ? { x: 1 } : null),
  }) }) } };
  const nonce = (await check(good)).nonce;
  assert.equal(await wasSpent(env, nonce), false);
  assert.equal(await spendNonce(env, nonce, at), true);
  assert.equal(await spendNonce(env, nonce, at), false, 'a replayed form');
  assert.equal(await wasSpent(env, nonce), true);
});

/* -------------------------------------------------------------- risk */

test('risk score: hosting networks, the same network, provider and domain bursts, quick forms, old protocols, no language', () => {
  const base = { asn: 7922, formMs: 20000, minMs: 2000, softMs: 6000, acceptLanguage: true, browserUa: true, httpProtocol: 'HTTP/2', emailDomain: 'gmail.com', consumerDomain: true };
  assert.deepEqual(scoreSignup(base), { risk: 0, reasons: [], hold: false });
  assert.deepEqual(scoreSignup({ ...base, asn: 16509 }).reasons, ['hosting_network']);
  assert.equal(scoreSignup({ ...base, asn: 16509 }).hold, false, 'a VPN or datacenter alone never holds anyone');
  assert.equal(scoreSignup({ ...base, sameNet24h: 1 }).risk, 2);
  assert.equal(scoreSignup({ ...base, asn: 16509, sameNet24h: 1 }).hold, true, 'datacenter + a repeat network = held');
  assert.equal(scoreSignup({ ...base, asnHour: 4, asnWeek: 4 }).reasons.includes('provider_burst'), true);
  assert.equal(scoreSignup({ ...base, asnHour: 4, asnWeek: 1000 }).reasons.includes('provider_burst'), false, 'a busy provider at its usual rate');
  assert.equal(scoreSignup({ ...base, emailDomain: 'tiny.example', consumerDomain: false, domain24h: 2 }).reasons.includes('domain_burst'), true);
  assert.equal(scoreSignup({ ...base, domain24h: 50 }).reasons.includes('domain_burst'), false, 'gmail waves mean nothing');
  assert.deepEqual(scoreSignup({ ...base, formMs: 3000 }).reasons, ['fast_form']);
  assert.deepEqual(scoreSignup({ ...base, formMs: 6000 }).reasons, [], 'from SIGNUP_SOFT_MS on, no point');
  assert.deepEqual(scoreSignup({ ...base, httpProtocol: 'HTTP/1.1' }).reasons, ['old_protocol_browser']);
  assert.deepEqual(scoreSignup({ ...base, httpProtocol: 'HTTP/1.1', browserUa: false }).reasons, []);
  assert.deepEqual(scoreSignup({ ...base, acceptLanguage: false }).reasons, ['no_accept_language']);
  const worst = scoreSignup({ ...base, asn: 14061, sameNet24h: 3, asnHour: 9, formMs: 2500, httpProtocol: 'HTTP/1.1', acceptLanguage: false, emailDomain: 'x.example', consumerDomain: false, domain24h: 5 });
  assert.equal(worst.risk, 11);
  assert.equal(worst.hold, true, 'however high the score, it holds; it never refuses');
  assert.equal(HOLD_AT, 3);
});

test('announced bots: Web Bot Auth signatures and automation User-Agents; ordinary browsers pass', () => {
  const h = o => new Headers(o);
  assert.equal(declaredAgent(h({ 'Signature-Agent': '"https://agent.example"' })), 'signature_agent');
  assert.equal(declaredAgent(h({ 'Signature-Input': 'sig=("@authority")' })), 'signature_agent');
  for (const ua of ['Mozilla/5.0 HeadlessChrome/120.0', 'python-requests/2.31', 'curl/8.4.0', 'Go-http-client/1.1', 'Mozilla/5.0 (compatible; GPTBot/1.0)', 'Scrapy/2.11'])
    assert.equal(declaredAgent(h({ 'User-Agent': ua })), 'automation_ua', ua);
  for (const ua of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 10; CUBOT X19) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'])
    assert.equal(declaredAgent(h({ 'User-Agent': ua })), null, ua);
});

/* ------------------------------------------------------------- email */

test('throwaway email domains: the list and every subdomain, any case; real providers and relays pass', async () => {
  for (const d of ['mailinator.com', 'MAILINATOR.COM', 'foo.mailinator.com', 'a.b.guerrillamail.com', 'yopmail.fr', '10minutemail.com', 'sharklasers.com', 'trashmail.de'])
    assert.equal(isDisposable(d), true, d);
  for (const d of ['gmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'fastmail.com', 'cs.stanford.edu', 'privaterelay.appleid.com', 'mozmail.com', 'duck.com', 'com', 'notmailinator.com', ''])
    assert.equal(isDisposable(d), false, d);
  assert.equal(domainOf('Kat@Example.COM'), 'example.com');
});

test('MX check over DNS-over-HTTPS: no such domain or a null MX is a problem; anything else, errors and timeouts included, passes', async () => {
  const real = globalThis.fetch;
  const answers = {
    'gone.example': { Status: 3 }, 'nomail.example': { Status: 0, Answer: [{ type: 15, data: '0 .' }] },
    'ok.example': { Status: 0, Answer: [{ type: 15, data: '10 mx.ok.example.' }] }, 'servfail.example': { Status: 2 },
  };
  const asked = [];
  globalThis.fetch = async url => {
    const name = new URL(url).searchParams.get('name');
    asked.push(name);
    if (name === 'down.example') throw new Error('network');
    return new Response(JSON.stringify(answers[name] || { Status: 0 }), { status: 200 });
  };
  try {
    const env = { DOH_URL: 'https://doh.invalid/dns-query' };
    assert.equal(await mailProblem(env, 'gone.example'), 'nxdomain');
    assert.equal(await mailProblem(env, 'nomail.example'), 'null_mx');
    assert.equal(await mailProblem(env, 'ok.example'), null);
    assert.equal(await mailProblem(env, 'servfail.example'), null, 'a resolver error fails open');
    assert.equal(await mailProblem(env, 'down.example'), null, 'a network error fails open');
    assert.equal(await mailProblem(env, 'gmail.com'), null);
    assert.ok(!asked.includes('gmail.com'), 'big providers aren\'t looked up');
  } finally { globalThis.fetch = real; }
});

/* --------------------------------------------------------- Turnstile */

test('Turnstile: success, action and hostname are ours to check; test secrets skip the last two; failures and outages', async () => {
  const opts = { action: 'signup', hostnames: ['ourspace.example'], testKey: false };
  assert.equal(judgeSiteverify({ success: true, action: 'signup', hostname: 'ourspace.example' }, opts).ok, true);
  assert.equal(judgeSiteverify({ success: true, action: 'login', hostname: 'ourspace.example' }, opts).reason, 'action');
  assert.equal(judgeSiteverify({ success: true, action: 'signup', hostname: 'evil.example' }, opts).reason, 'hostname');
  assert.equal(judgeSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] }, opts).reason, 'timeout-or-duplicate');
  assert.equal(judgeSiteverify({ success: true, hostname: 'example.com' }, { ...opts, testKey: true }).ok, true);
  assert.equal(isTestSecret('1x0000000000000000000000000000000AA'), true);
  assert.equal(isTestSecret('2x0000000000000000000000000000000AA'), true);
  assert.equal(isTestSecret('0x4AAAAAAAreal-secret'), false);

  // the published test secrets, against a stand-in siteverify: 1x passes, 2x fails, 3x is "already spent"
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const form = new URLSearchParams(init.body);
    const s = form.get('secret');
    if (s === 'down') throw new Error('unreachable');
    const ok = s.startsWith('1x');
    return new Response(JSON.stringify(ok ? { success: true, hostname: 'example.com' } : { success: false, 'error-codes': [s.startsWith('3x') ? 'timeout-or-duplicate' : 'invalid-input-response'] }));
  };
  const c = secret => ({ env: { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: secret }, req: new Request('https://ourspace.example/api/signup'), url: new URL('https://ourspace.example/api/signup') });
  try {
    assert.deepEqual(await checkTurnstile(c('1x0000000000000000000000000000000AA'), 'XXXX.DUMMY.TOKEN.XXXX', 'signup'), { ok: true, skipped: false });
    await assert.rejects(checkTurnstile(c('2x0000000000000000000000000000000AA'), 'XXXX.DUMMY.TOKEN.XXXX', 'signup'), e => e.status === 403 && e.extra.code === 'turnstile');
    await assert.rejects(checkTurnstile(c('3x0000000000000000000000000000000AA'), 'XXXX.DUMMY.TOKEN.XXXX', 'signup'), e => e.extra.reason === 'timeout-or-duplicate');
    await assert.rejects(checkTurnstile(c('1x0000000000000000000000000000000AA'), '', 'signup'), e => e.status === 400 && e.extra.code === 'turnstile');
    await assert.rejects(checkTurnstile(c('down'), 'tok', 'signup'), e => e.status === 503 && e.extra.code === 'turnstile_unavailable', 'sign-up fails closed');
    assert.deepEqual(await checkTurnstile(c('down'), 'tok', 'login', { failOpen: true }), { ok: true, skipped: true }, 'log in fails open');
    const unset = { env: {}, req: new Request('https://ourspace.example/'), url: new URL('https://ourspace.example/') };
    await assert.rejects(checkTurnstile(unset, 'tok', 'signup'), e => e.status === 503, 'not set up on a real server: sign-ups refused');
    const local = { env: {}, req: new Request('http://127.0.0.1:8787/'), url: new URL('http://127.0.0.1:8787/') };
    assert.equal((await checkTurnstile(local, null, 'signup')).skipped, true, 'a bare `wrangler dev` without keys');
  } finally { globalThis.fetch = real; }
});

/* --------------------------------------------------------- simhash */

test('near-duplicates: the same words whatever the case, punctuation or emoji; light edits stay similar; other texts do not', () => {
  const spam = 'Get free followers now at my page, the best deal you will ever see online, limited time only, do not miss out, act fast today friends';
  const edited = 'GET free followers now at my page!!! the best deal you will ever see online — limited time only, do not miss out, act fast today friends 🔥';
  const other = 'I spent the whole afternoon at the roller rink with my cousin and we both fell over at least six times, which was honestly the best part';
  assert.equal(normalize('Ünïcödé  BUY!!! @kat http://x.y [link removed] nоw'), 'unicode buy now');
  const fp = t => { const w = words(t); return { sig: minhash(w), textHash: w.join(' ') }; };
  const [a, b, c] = [fp(spam), fp(edited), fp(other)];
  assert.equal(a.sig.length, 16 * 8);
  assert.equal(a.textHash, b.textHash, 'case, punctuation and emoji do not count');
  assert.equal(a.sig, b.sig);
  const reworded = fp(spam.replace('best deal', 'greatest deal'));
  assert.ok(similarity(a.sig, reworded.sig) >= SIMILAR, `one word changed: ${similarity(a.sig, reworded.sig)}`);
  assert.ok(nearDuplicate(a, reworded));
  assert.ok(bands(a.sig).some((x, i) => x === bands(reworded.sig)[i]), 'and it shares a lookup band');
  assert.equal(similarity(a.sig, c.sig), 0, 'unrelated texts share nothing');
  assert.equal(nearDuplicate(a, c), false);
  // over many one-word edits of a 26-word post, nearly all stay near-duplicates
  const w = words(spam), dict = ['apple', 'river', 'stone', 'cloud', 'music', 'happy', 'green', 'window'];
  let caught = 0;
  for (let i = 0; i < 100; i++) { const v = [...w]; v[i % w.length] = dict[i % dict.length]; if (similarity(minhash(w), minhash(v)) >= SIMILAR) caught++; }
  assert.ok(caught >= 95, `${caught}/100`);
  assert.deepEqual(shingles(['a', 'b', 'c', 'd']), ['a b c', 'b c d']);
});

/* ---------------------------------------------------------- AI text */

test('AI scan input: only public post kinds, 100 words (blogs 150), only the person\'s own words', () => {
  const t = 'Hello @kat! check https://spam.example and `code` here\n> quoted line\n```\nblock\n```\nthe **end** 🔥 саt';
  const cleaned = cleanForDetection(t);
  assert.ok(!/kat|spam|code|quoted|block|🔥|\*/.test(cleaned), cleaned);
  assert.match(cleaned, /cat$/, 'look-alike letters mapped back');
  const words100 = Array(100).fill('word').join(' ');
  assert.equal(eligible('status', words100).ok, true);
  assert.equal(eligible('status', words100.split(' ').slice(1).join(' ')).ok, false, '99 words');
  assert.equal(eligible('blog', words100).ok, false, 'blogs need 150');
  assert.equal(eligible('blog', Array(150).fill('word').join(' ')).ok, true);
  for (const k of ['repost', 'dm', 'chat', 'bulletin']) assert.equal(eligible(k, words100).ok, false, k);
  assert.equal(wordCount("it's a dog-eat-dog world, 42 times"), 5);
});

test('the detector adapter: off by default, the mock, Workers AI\'s answer read, vendors mapped, every failure fails open', async () => {
  assert.equal(detectorName({}), 'off');
  assert.equal(detectorName({ AI_DETECTOR: 'nonsense' }), 'off');
  assert.equal(await detect({}, 'anything'), null);
  assert.deepEqual(mockDetect('blah mock-ai-score: 0.97 blah'), { score: 0.97, label: 'AI', model: 'mock:marker', raw: { marker: true } });
  assert.equal(mockDetect('mock-ai-score=0.5').label, 'Mixed');
  assert.equal(mockDetect('we went to the lake and my dog ate a sandwich').score, 0);
  assert.ok(mockDetect('In conclusion, this vibrant tapestry underscores a pivotal and transformative journey. Moreover, it is crucial.').score >= 0.95);
  assert.equal(parseProbability('{"ai_probability": 0.83}'), 0.83);
  assert.equal(parseProbability('Sure! {"ai_probability":1}'), 1);
  assert.equal(parseProbability('probably human'), null);

  const reply = body => async () => new Response(JSON.stringify(body), { status: 200 });
  const g = await detect({ AI_DETECTOR: 'gptzero', GPTZERO_API_KEY: 'k' }, 'text', { fetchImpl: reply({ version: '2026-01', documents: [{ predicted_class: 'ai', class_probabilities: { ai: 0.99 } }] }) });
  assert.deepEqual([g.score, g.label, g.model], [0.99, 'AI', 'gptzero:2026-01']);
  const p = await detect({ AI_DETECTOR: 'pangram', PANGRAM_API_KEY: 'k' }, 'text', { fetchImpl: reply({ fraction_ai: 0.4, prediction_short: 'Mixed' }) });
  assert.deepEqual([p.score, p.label], [0.4, 'Mixed']);
  const w = await detect({ AI_DETECTOR: 'workersai', AI: { run: async () => ({ response: '{"ai_probability": 0.2}' }) } }, 'text');
  assert.deepEqual([w.score, w.label, w.model], [0.2, 'Human', 'workersai:@cf/meta/llama-3.1-8b-instruct']);
  // failures: no key, a 429, a timeout-ish throw, an unreadable answer, no binding
  assert.ok((await detect({ AI_DETECTOR: 'gptzero' }, 'text')).error);
  assert.ok((await detect({ AI_DETECTOR: 'pangram', PANGRAM_API_KEY: 'k' }, 'text', { fetchImpl: async () => new Response('', { status: 429 }) })).error);
  assert.ok((await detect({ AI_DETECTOR: 'gptzero', GPTZERO_API_KEY: 'k' }, 'text', { fetchImpl: async () => { throw new Error('timeout'); } })).error);
  assert.ok((await detect({ AI_DETECTOR: 'workersai', AI: { run: async () => ({ response: 'I cannot help with that' }) } }, 'text')).error);
  assert.ok((await detect({ AI_DETECTOR: 'workersai' }, 'text')).error);
});

/* ------------------------------------------------------ strike ladder */

test('strike ladder on a fake clock: warning, a day, a week, a month, then a moderator; one per incident; 90 clean days', () => {
  const D = L.DAY;
  const ai = { label: 'AI', score: 0.97 };
  const s = L.newLadder();
  let now = T0;
  assert.equal(L.decide(s, { label: 'AI', score: 0.94 }, now), 'clear', 'under 0.95');
  assert.equal(L.decide(s, { label: 'Mixed', score: 0.99 }, now), 'clear', 'only label AI');
  assert.equal(L.decide(s, ai, now, 'shadow'), 'would_strike', 'shadow mode never strikes');

  const one = L.strike(s, now);
  assert.deepEqual([one.level, one.action, one.timeoutUntil], [1, 'warning', null]);
  assert.equal(L.timeoutUntil(s, now), null, 'a warning is only a warning');
  assert.equal(L.decide(s, ai, now + 23 * 3600000), 'same_incident', 'one strike per 24 hours');

  now += D + 1;
  assert.equal(L.decide(s, ai, now), 'strike');
  const two = L.strike(s, now);
  assert.deepEqual([two.level, two.action], [2, 'timeout']);
  assert.equal(L.timeoutUntil(s, now), now + D);
  assert.equal(L.timeoutUntil(s, now + D + 1), null, 'a day later it\'s over');
  assert.equal(one.expires, now + L.STRIKE_LIFE, 'every strike moves the older ones\' expiry to 90 days from now');

  now += 2 * D;
  assert.equal(L.strike(s, now).timeoutUntil, now + 7 * D, 'a week');
  now += 8 * D;
  assert.equal(L.strike(s, now).timeoutUntil, now + 30 * D, 'a month');
  now += 31 * D;
  const five = L.strike(s, now);
  assert.deepEqual([five.level, five.action, five.timeoutUntil], [5, 'review', null], 'the 5th goes to a moderator: no automatic ban');

  // 90 clean days: everything expires, and the next one is a warning again
  now += L.STRIKE_LIFE;
  L.expire(s, now);
  assert.equal(L.counting(s, now).length, 0);
  assert.ok(s.strikes.every(x => x.status === 'expired'));
  assert.equal(L.strike(s, now + 1).level, 1);
});

test('strike ladder: an appeal, upheld or removed; removing lifts its timeout and exempts the member for 180 days', () => {
  const D = L.DAY;
  const ai = { label: 'AI', score: 0.99 };
  const s = L.newLadder();
  let now = T0;
  L.strike(s, now);
  now += 2 * D;
  const two = L.strike(s, now);
  assert.equal(L.timeoutUntil(s, now + 3600000), now + D);
  assert.equal(L.appeal(s, two.id, 'i wrote this myself').status, 'appealed');
  assert.equal(L.appeal(s, two.id, 'again'), null, 'one appeal per strike');
  assert.equal(L.timeoutUntil(s, now + 3600000), now + D, 'the timeout stands while a moderator looks');
  assert.equal(L.counting(s, now).length, 2, 'an appealed strike still counts');
  L.resolve(s, two.id, 'remove', now + 7200000);
  assert.equal(two.status, 'removed');
  assert.equal(L.timeoutUntil(s, now + 7200000), null, 'removing it lifts its timeout at once');
  assert.equal(L.counting(s, now + 7200000).length, 1);
  assert.equal(L.decide(s, ai, now + 10 * D), 'exempt', '180 days without automatic strikes');
  assert.equal(L.decide(s, ai, now + 7200000 + L.EXEMPT_AFTER_REMOVAL + 1), 'strike');
  // upheld: it stays, as it was
  const t = L.newLadder();
  const w = L.strike(t, T0);
  L.appeal(t, w.id, 'not me');
  L.resolve(t, w.id, 'uphold', T0 + 1000);
  assert.deepEqual([w.status, w.result], ['active', 'upheld']);
  assert.equal(L.counting(t, T0 + 2000).length, 1);
  assert.equal(L.resolve(t, 999, 'remove', T0), null);
  assert.deepEqual([L.step(1).action, L.step(2).timeoutMs, L.step(3).timeoutMs, L.step(4).timeoutMs, L.step(6).action], ['warning', D, 7 * D, 30 * D, 'review']);
});

/* --------------------------------------------------- the eval harness */

test('the evaluation harness: Wilson 95% intervals, the 1% bar, and the confusion matrix', async () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 5e-4, `${a} vs ${b}`);
  const [lo, hi] = wilson(0, 300);
  close(lo, 0); close(hi, 0.01264);                       // zero false positives in 300: still just over 1%
  close(wilson(0, 400)[1], 0.00952);                      // 400 clean human texts pass the bar
  const [l2, h2] = wilson(5, 100);
  close(l2, 0.02154); close(h2, 0.11175);
  close(wilson(50, 100)[0], 0.40383); close(wilson(50, 100)[1], 0.59617);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const corpus = [
    ...Array.from({ length: 400 }, (_, i) => ({ file: `human/${i}.txt`, truth: 'human', kind: 'thread', text: Array(120).fill('plain words ' + i).join(' ') })),
    ...Array.from({ length: 10 }, (_, i) => ({ file: `ai/${i}.txt`, truth: 'ai', kind: 'thread', text: Array(120).fill('robot').join(' ') + (i < 8 ? ' mock-ai-score: 0.99' : ' mock-ai-score: 0.5') })),
    { file: 'human/short.txt', truth: 'human', kind: 'thread', text: 'too short to judge' },
  ];
  const res = await evaluate(corpus, async text => mockDetect(text));
  assert.deepEqual(res.matrix, { tp: 8, fn: 2, fp: 0, tn: 400 });
  assert.equal(res.skipped, 1);
  assert.equal(res.pass, true);
  const failing = await evaluate(corpus.slice(0, 50), async () => ({ score: 0.99, label: 'AI', model: 'x' }));
  assert.equal(failing.pass, false);
  assert.equal(failing.matrix.fp, 50);
  // the shipped starter corpus reads, with both labels in it
  const starter = readCorpus(new URL('../eval', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(starter.filter(t => t.truth === 'human').length >= 20 && starter.filter(t => t.truth === 'ai').length >= 8);
});
