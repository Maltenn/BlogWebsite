// The bot simulator (docs/decisions/003, "How we'll test it"): scripted sign-up floods and spam against a running
// OurSpace, and one real person's journey that must get through. It reports, per scenario, how many attempts were
// refused, held for a moderator, or got in.
//
//   node tools/bot-sim.mjs --base http://127.0.0.1:8787 [--log wrangler.log] [--n 20]
//
// Run it against a local server started with Turnstile's test keys (so the in-house layers are what's measured) and
// TEST_SIGNALS=1 (so a scenario can come from a datacenter or a shared network: X-Test-Ip, X-Test-Cf), like `npm run
// demo` or the test server (test/api.test.mjs runs it). --log: the server's output, where local confirmation emails
// are printed, for the duplicate-spam scenario (it needs confirmed accounts; without it that scenario is skipped).
// Never point it at a site you don't run.
//
// Scenarios:
//   no_form          posts straight to /api/signup: no form token, no proof of work
//   no_pow           a real form, but no proof of work
//   no_turnstile     form and proof of work, no Turnstile token
//   replayed_form    every attempt reuses one form (its token and proof of work) that already made an account
//   honeypot         a form-filler that fills every field, the hidden one too
//   too_fast         submits the moment the form arrives
//   declared_agent   an honest automation User-Agent / Web Bot Auth signature
//   throwaway_email  a disposable inbox
//   datacenter       a careful bot on a cloud provider's network, all attempts from one /64
//   duplicate_spam   confirmed new accounts posting the same promotion (lightly edited) in a row: the first two stay up
//                    (earlier copies are never held), the rest are held
// The scenarios without their own X-Test-Ip share one network, so after 60 requests in a minute the per-network brake
// answers them (code busy) before any other check.
//   real_person      a person: a browser, their own network, takes their time; must get in, confirm and post
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { fillForm, randomIp, verifyTokenIn, BROWSER, TURNSTILE_TEST_TOKEN } from '../test/helpers/human.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(base, fixed = {}) {
  const jar = new Map();
  const call = async (method, url, body, headers = {}) => {
    const h = { ...fixed, ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: u => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h) };
}

let seq = 0;
const person = (tag, domain = 'gmail.com') => {
  const id = `${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;
  return { email: `${tag}.${id}@${domain}`, password: 'a-real-passphrase-7', name: `${tag.slice(0, 10)}_${id}`, birthday: '2001-05-05', rulesOk: true };
};

// one sign-up attempt → 'refused' | 'held' | 'created' (and the client, and the answer)
async function attempt(base, { fields, headers = {}, build }) {
  const c = client(base, headers);
  let r;
  try { r = await c.post('/api/signup', await build(c, fields)); } catch (e) {
    if (!e.answer) throw e;
    r = e.answer;                                  // the form itself was refused (429 busy: the per-network brake)
  }
  const outcome = r.status === 201 ? (r.data.held ? 'held' : 'created') : 'refused';
  return { outcome, c, r, fields };
}

async function freshForm(c) {
  const r = await c.get('/api/form/signup');
  if (r.status !== 200) throw Object.assign(new Error('no form: ' + r.status), { answer: r });
  return { form: r.data, at: Date.now() };
}

export async function runBotSim({ base, n = 20, readLog = null, log = () => {} }) {
  const results = {};
  const tally = async (name, count, make) => {
    const t = { attempts: 0, refused: 0, held: 0, created: 0, codes: {} };
    for (let i = 0; i < count; i++) {
      const a = await make(i);
      t.attempts++;
      t[a.outcome]++;
      const code = a.r.data && (a.r.data.code || (a.outcome !== 'refused' ? a.outcome : String(a.r.status)));
      t.codes[code] = (t.codes[code] || 0) + 1;
    }
    results[name] = t;
    log(`${name.padEnd(16)} attempts ${t.attempts}  refused ${t.refused}  held ${t.held}  got in ${t.created}   ${JSON.stringify(t.codes)}`);
    return t;
  };
  const human = { ...BROWSER };

  await tally('no_form', n, () => attempt(base, { fields: person('noform'), headers: human, build: async (c, f) => ({ ...f, turnstile: TURNSTILE_TEST_TOKEN }) }));
  await tally('no_pow', n, () => attempt(base, { fields: person('nopow'), headers: human, build: async (c, f) => {
    const { form, at } = await freshForm(c);
    return fillForm(form, f, { fetchedAt: at, pow: false });
  } }));
  await tally('no_turnstile', n, () => attempt(base, { fields: person('nots'), headers: human, build: async (c, f) => {
    const { form, at } = await freshForm(c);
    return fillForm(form, f, { fetchedAt: at, turnstile: null });
  } }));
  // one good form, used once for real, then replayed
  const seedClient = client(base, { ...human, 'X-Test-Ip': randomIp() });
  const { form: replay, at: replayAt } = await freshForm(seedClient);
  const replayBody = await fillForm(replay, person('replayseed'), { fetchedAt: replayAt });
  await seedClient.post('/api/signup', replayBody);
  await tally('replayed_form', n, () => attempt(base, { fields: person('replay'), headers: { ...human, 'X-Test-Ip': randomIp() }, build: async (c, f) => ({ ...replayBody, ...f }) }));
  await tally('honeypot', n, () => attempt(base, { fields: person('filler'), headers: human, build: async (c, f) => {
    const { form, at } = await freshForm(c);
    return fillForm(form, f, { fetchedAt: at, honeypot: 'https://cheap-followers.example' });
  } }));
  await tally('too_fast', n, () => attempt(base, { fields: person('fast'), headers: human, build: async (c, f) => {
    const { form, at } = await freshForm(c);
    return fillForm(form, f, { fetchedAt: at, wait: false });
  } }));
  await tally('declared_agent', n, i => attempt(base, { fields: person('agent'),
    headers: i % 2 ? { 'User-Agent': 'python-requests/2.32' } : { ...human, 'Signature-Agent': '"https://agent.example"', 'Signature-Input': 'sig1=("@authority")' },
    build: async (c, f) => { const { form, at } = await freshForm(c); return fillForm(form, f, { fetchedAt: at }); } }));
  await tally('throwaway_email', n, i => attempt(base, { fields: person('throw', i % 2 ? 'mailinator.com' : 'x.guerrillamail.com'), headers: { ...human, 'X-Test-Ip': randomIp() },
    build: async (c, f) => { const { form, at } = await freshForm(c); return fillForm(form, f, { fetchedAt: at, extraMs: 200 }); } }));
  // a careful bot: everything right, but from one cloud network (AWS), one /64, quickly one after another
  const dcNet = randomIp(true);
  await tally('datacenter', n, () => attempt(base, { fields: person('cloud'),
    headers: { ...human, 'X-Test-Ip': dcNet, 'X-Test-Cf': JSON.stringify({ asn: 16509, asOrganization: 'Amazon.com, Inc.', country: 'US', httpProtocol: 'HTTP/2' }) },
    build: async (c, f) => { const { form, at } = await freshForm(c); return fillForm(form, f, { fetchedAt: at, extraMs: 200 }); } }));

  // duplicate spam: 5 confirmed new accounts post the same promotion, lightly edited
  if (readLog) {
    const spam = i => `Want ${i % 2 ? 'FREE' : 'free'} followers?? message me for the best deal you will ever see online, limited spots only, do not miss out, act fast today friends ${'!'.repeat(i + 1)}`;
    const t = { attempts: 0, public: 0, held: 0, refused: 0, codes: {} };
    for (let i = 0; i < 5; i++) {
      const a = await attempt(base, { fields: person('spam'), headers: { ...human, 'X-Test-Ip': randomIp() },
        build: async (c, f) => { const { form, at } = await freshForm(c); return fillForm(form, f, { fetchedAt: at, extraMs: 200 }); } });
      if (a.outcome !== 'created') { t.refused++; continue; }
      let token = null;
      for (let k = 0; k < 100 && !token; k++) { token = verifyTokenIn(readLog(), a.fields.email); if (!token) await sleep(30); }
      await a.c.post('/api/verify', { token });
      const p = await a.c.post('/api/status', { body: spam(i) });
      t.attempts++;
      if (p.status !== 201) { t.refused++; continue; }
      t.codes[p.data.held ? 'held' : 'public'] = (t.codes[p.data.held ? 'held' : 'public'] || 0) + 1;
      if (p.data.held) t.held++; else t.public++;
    }
    // what a logged-out visitor sees of it now
    const shown = (await client(base).get('/api/feed?scope=everyone')).data.items.filter(x => /best deal you will ever see/.test(x.body || '')).length;
    t.stillPublic = shown;
    results.duplicate_spam = t;
    log(`${'duplicate_spam'.padEnd(16)} posts ${t.attempts}  public when posted ${t.public}  held ${t.held}  still public now ${shown}`);
  }

  // a real person: their own network, a browser, ~2 s more than the minimum, confirms and posts
  const me = person('realperson');
  const real = await attempt(base, { fields: me, headers: { ...human, 'X-Test-Ip': randomIp() },
    build: async (c, f) => { const { form, at } = await freshForm(c); return fillForm(form, f, { fetchedAt: at, extraMs: 300 }); } });
  const journey = { signedUp: real.outcome === 'created', held: real.outcome === 'held', verified: false, posted: false };
  if (readLog && journey.signedUp) {
    let token = null;
    for (let k = 0; k < 100 && !token; k++) { token = verifyTokenIn(readLog(), me.email); if (!token) await sleep(30); }
    journey.verified = (await real.c.post('/api/verify', { token })).status === 200;
    journey.posted = (await real.c.post('/api/status', { body: 'hi everyone, just joined! still figuring out where everything is' })).status === 201;
  }
  journey.pass = journey.signedUp && !journey.held && (!readLog || (journey.verified && journey.posted));
  results.real_person = journey;
  log(`${'real_person'.padEnd(16)} ${journey.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(journey)}`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const base = arg('--base', 'http://127.0.0.1:8787');
  const file = arg('--log', null);
  const res = await runBotSim({ base, n: Number(arg('--n', 20)), readLog: file ? () => fs.readFileSync(file, 'utf8') : null, log: s => console.log('  ' + s) });
  process.exit(res.real_person.pass ? 0 : 1);
}
