// Captures the per-identity answers of tools/fixtures/server-clock.json (the `byIdentity` section) from a RUNNING, freshly
// seeded demo, as each identity the plates use. Leaves `responses` (the answers that need no identity) exactly as it is.
//
//   DEMO_DIR=<new folder> PORT=8840 node tools/demo.mjs --fresh        (leave it running, seeded just now)
//   node tools/pin-server-clock.mjs [--url http://127.0.0.1:8840]
//
// Which paths, and for which states: PINNED below. Changing what is in the fixture means deliberately re-baselining the
// plates that show it (docs/mobile/harness.md, "The server's clock").
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, login, discover, frozenNow } from './plates.mjs';

const FILE = path.join(ROOT, 'tools', 'fixtures', 'server-clock.json');
const IDENTITIES = { out: null, in: 'you@example.com', admin: 'malten@example.com' };
const PINNED = [                                                            // [request path as the page makes it, states]
  ['/api/browse/discover', ['out', 'in']],                                  // the /browse plate
  ['/api/browse/people?limit=3', ['out', 'in']],                            // the home plates' "Who to follow"
];

const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8840';
const cookies = {};
for (const [state, email] of Object.entries(IDENTITIES)) cookies[state] = email ? await login(url, email) : '';
const d = await discover(url, cookies.in);
const fixture = JSON.parse(fs.readFileSync(FILE, 'utf8'));
fixture.identityClock = frozenNow(d);                                       // the clock the plates would be taken at on THIS seed; the answers are shifted from it to the run's own
fixture.identityCapturedAt = new Date().toISOString();
fixture.byIdentity = {};
for (const [p, states] of PINNED) {
  const answers = {};
  for (const state of states) {
    const res = await fetch(url + p, { headers: cookies[state] ? { Cookie: 'os_sid=' + cookies[state] } : {} });
    if (!res.ok) throw new Error(`GET ${p} as ${state} -> ${res.status}`);
    answers[state] = await res.json();
  }
  fixture.byIdentity[p.split('?')[0]] = answers;                            // keyed on pathname, like `responses`
}
// The photos in those answers are stored under random keys, different in every seed, so the answers' /media/<key> urls
// would 404 on the plates' own seed. Their bytes are kept beside the fixture and served under the same urls.
const MEDIA = path.join(ROOT, 'tools', 'fixtures', 'server-clock-media');
fs.rmSync(MEDIA, { recursive: true, force: true });
fs.mkdirSync(MEDIA, { recursive: true });
for (const m of new Set(JSON.stringify(fixture.byIdentity).match(/\/media\/[0-9a-f]{32}\.[a-z]+/g) || [])) {
  const res = await fetch(url + m);
  if (!res.ok) throw new Error(`GET ${m} -> ${res.status}`);
  fs.writeFileSync(path.join(MEDIA, path.basename(m)), Buffer.from(await res.arrayBuffer()));
}
fs.writeFileSync(FILE, JSON.stringify(fixture, null, 1).replace(/\n/g, '\r\n') + '\r\n');
console.log(`pinned ${PINNED.length} paths as ${[...new Set(PINNED.flatMap(x => x[1]))].join(', ')}; clock ${new Date(fixture.identityClock).toISOString()}`);
