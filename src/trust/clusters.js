// The nightly look for accounts that came together (docs/decisions/003, layer 3): each rule that finds a group opens a
// `cluster` alert for the moderators (one per group per day; an open one isn't opened twice). Never a ban: homes,
// schools and phone networks share addresses, so a person decides.
//
//   same_network    3+ sign-ups from one network (IPv4 address or IPv6 /64) in the last 24 hours
//   hosting_burst   3+ sign-ups from one hosting / datacenter provider within an hour
//   same_moment     3+ sign-ups from one provider (any kind) with the same browser (User-Agent) within a minute
//   email_domain    3+ sign-ups with one unfamiliar email domain in 7 days
//   same_text       3+ accounts posting the same or nearly the same text in the last 24 hours (accounts of any age;
//                   new accounts are already held at the time: duplicates.js)
//
// Also the retention sweep (every 30 minutes): sign-up signals 90 days, post fingerprints 7, spent form nonces and
// email links when they expire, resolved alerts 90 days.
import { HOSTING_ASNS } from './risk.js';
import { CONSUMER } from './disposable.js';
import { nearDuplicate, bands } from './minhash.js';

const H = 3600000, D = 86400000;
export const SIGNALS_KEPT = 90 * D;

async function open(env, key, payload, now) {
  await env.DB.prepare('INSERT OR IGNORE INTO mod_alerts (kind, key, payload, created) VALUES (\'cluster\', ?, ?, ?)')
    .bind(key, JSON.stringify(payload), now).run();
}

const ids = s => String(s || '').split(',').map(Number).filter(Boolean).sort((a, b) => a - b);

// Runs every rule; answers how many alerts it tried to open per rule (an already open one isn't counted twice).
export async function findClusters(env, now) {
  const DB = env.DB;
  const day = Math.floor(now / D);
  const found = { same_network: 0, hosting_burst: 0, same_moment: 0, email_domain: 0, same_text: 0 };
  const [net, recent, domains, prints] = await DB.batch([
    DB.prepare(`SELECT ip_group_hash AS k, COUNT(*) AS n, GROUP_CONCAT(user_id) AS users FROM signup_signals
      WHERE created > ? GROUP BY ip_group_hash HAVING COUNT(*) >= 3 LIMIT 100`).bind(now - D),
    DB.prepare(`SELECT user_id, asn, as_org, ua_hash, created FROM signup_signals WHERE created > ? AND asn IS NOT NULL
      ORDER BY asn, created LIMIT 5000`).bind(now - D),
    DB.prepare(`SELECT email_domain AS k, COUNT(*) AS n, GROUP_CONCAT(user_id) AS users FROM signup_signals
      WHERE created > ? AND email_domain IS NOT NULL GROUP BY email_domain HAVING COUNT(*) >= 3 LIMIT 200`).bind(now - 7 * D),
    DB.prepare('SELECT post_id, user_id, simhash AS signature, text_hash, words FROM post_fingerprints WHERE created > ? ORDER BY created DESC LIMIT 2000').bind(now - D),
  ]);
  for (const r of net.results) {
    await open(env, `net:${r.k}:${day}`, { rule: 'same_network', users: ids(r.users), count: r.n, window: '24h' }, now);
    found.same_network++;
  }
  // the timing rules, over a sliding window: a hosting provider's sign-ups within an hour; any provider's sign-ups with
  // the same browser (User-Agent hash) within a minute
  const groups = new Map();
  for (const r of recent.results) {
    const add = (k, row) => groups.set(k, [...(groups.get(k) || []), row]);
    if (HOSTING_ASNS.has(Number(r.asn))) add(`hosting|${r.asn}`, r);
    if (r.ua_hash) add(`moment|${r.asn}|${r.ua_hash}`, r);
  }
  for (const [g, rows] of groups) {
    const [rule, asn] = g.split('|');
    const span = rule === 'hosting' ? H : 60000;
    for (let i = 0; i + 2 < rows.length; i++) {
      const inside = rows.filter(x => x.created >= rows[i].created && x.created < rows[i].created + span);
      if (inside.length < 3) continue;
      const users = inside.map(x => x.user_id).sort((a, b) => a - b);
      const payload = rule === 'hosting'
        ? { rule: 'hosting_burst', users, count: users.length, window: '1h', asn: Number(asn), asOrg: rows[i].as_org }
        : { rule: 'same_moment', users, count: users.length, window: '1m', asn: Number(asn), asOrg: rows[i].as_org };
      await open(env, `${rule}:${asn}:${users[0]}`, payload, now);
      found[payload.rule]++;
      i += inside.length - 1;                     // the next window starts after this group
    }
  }
  for (const r of domains.results.filter(r => !CONSUMER.has(r.k))) {
    await open(env, `domain:${r.k}:${day}`, { rule: 'email_domain', users: ids(r.users), count: r.n, window: '7d', domain: r.k }, now);
    found.email_domain++;
  }
  // same text: group the day's fingerprints (the same text, or 60%+ of their MinHash signatures in common) and keep
  // groups of 3+ accounts. Only fingerprints sharing the text or a lookup band are compared.
  const rows = prints.results.map(r => ({ ...r, fp: { sig: r.signature, textHash: r.text_hash } }));
  const buckets = new Map();
  rows.forEach((r, i) => [r.text_hash, ...bands(r.signature).map((b, k) => k + ':' + b)].forEach(key => buckets.set(key, [...(buckets.get(key) || []), i])));
  const taken = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (taken.has(i)) continue;
    const group = [i];
    const near = new Set([rows[i].text_hash, ...bands(rows[i].signature).map((b, k) => k + ':' + b)].flatMap(key => buckets.get(key) || []));
    for (const j of [...near].filter(j => j > i).sort((x, y) => x - y)) if (!taken.has(j) && nearDuplicate(rows[i].fp, rows[j].fp)) group.push(j);
    const users = [...new Set(group.map(k => rows[k].user_id))];
    if (users.length < 3) continue;
    for (const k of group) taken.add(k);
    const posts = group.map(k => rows[k].post_id).sort((a, b) => a - b);
    await open(env, `text:${rows[i].text_hash}:${day}`, { rule: 'same_text', users: users.sort((a, b) => a - b), posts, count: users.length, window: '24h' }, now);
    found.same_text++;
  }
  return found;
}

// the retention sweep (every 30 minutes)
export async function sweepTrust(env, now) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM signup_signals WHERE created < ?').bind(now - SIGNALS_KEPT),
    env.DB.prepare('DELETE FROM post_fingerprints WHERE created < ?').bind(now - 7 * D),
    env.DB.prepare('DELETE FROM spent_nonces WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM email_tokens WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM mod_alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?').bind(now - SIGNALS_KEPT),
  ]);
}
