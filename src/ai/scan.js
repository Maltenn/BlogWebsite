// Scanning public posts for AI writing, after they're published (the post never waits: the scan runs in waitUntil and
// fails open). AI_DETECTOR picks the detector (detect.js; off by default), AI_ENFORCEMENT the mode:
//   shadow (the default)  every score is recorded for moderators; nobody gets a strike
//   enforce               the owner's ladder (ladder.js) applies: switch to it only after the evaluation harness
//                         (tools/eval-detector.mjs) measured the human false-positive rate at ≤ 1% (95% upper bound)
// Also the cron's part: strikes past their 90 clean days stop counting, old flagged text is cleared, scans go after 90
// days, except an account's under a child-safety hold (the view held_accounts, migrations/0014).
import { sha256Hex } from '../shared/http.js';
import { detect, detectorName } from './detect.js';
import { eligible } from './clean.js';
import { strikeWorthy, step, DAY, STRIKE_LIFE, INCIDENT } from './ladder.js';

export const enforcement = env => (String((env && env.AI_ENFORCEMENT) || '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow');
const KEEP_TEXT = 4000;

// called by writePost (social/items.js) for each new public post: queues the scan when there's a detector and the
// post is long enough to judge
export function scanLater(c, { id, kind, text }) {
  if (detectorName(c.env) === 'off') return;
  const e = eligible(kind, text);
  if (!e.ok) return;
  // (with TEST_SIGNALS=1, tests only, X-Test-Enforcement picks the mode for this post)
  const mode = (c.env.TEST_SIGNALS === '1' && c.req.headers.get('X-Test-Enforcement')) || enforcement(c.env);
  const job = { postId: id, userId: c.user.id, kind, cleaned: e.cleaned, words: e.words, now: c.now, exemptUntil: c.user.ai_exempt_until || 0, mode };
  c.ctx.waitUntil(scanPost(c.env, job).catch(err => console.error('ai scan failed:', (err && err.stack) || err)));
}

// Scores one post and acts on it. Answers the decision.
export async function scanPost(env, job) {
  const DB = env.DB;
  const now = job.now;
  const res = await detect(env, job.cleaned);
  if (!res) return null;
  const textHash = (await sha256Hex(job.cleaned)).slice(0, 32);
  if (res.error) {
    console.error('ai detector failed (the post stays up):', res.error);
    await DB.prepare('INSERT INTO ai_scans (post_id, user_id, kind, words, model, text_hash, decision, created) VALUES (?, ?, ?, ?, ?, ?, \'error\', ?)')
      .bind(job.postId, job.userId, job.kind, job.words, res.model, textHash, now).run();
    return 'error';
  }
  let decision = 'clear';
  if (strikeWorthy(res)) {
    if (job.exemptUntil > now) decision = 'exempt';
    else if ((job.mode || enforcement(env)) !== 'enforce') decision = 'would_strike';
    else {
      const recent = await DB.prepare('SELECT 1 AS x FROM ai_strikes WHERE user_id = ? AND created > ? AND status != \'removed\' LIMIT 1')
        .bind(job.userId, now - INCIDENT).first();
      decision = recent ? 'same_incident' : 'strike';
    }
  }
  const scan = await DB.prepare(`INSERT INTO ai_scans (post_id, user_id, kind, words, score, label, model, text_hash, decision, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(job.postId, job.userId, job.kind, job.words, res.score, res.label, res.model, textHash, decision, now).first();
  if (decision === 'strike') await giveStrike(env, { ...job, scanId: scan.id, res });
  return decision;
}

// The next strike on the ladder, in one batch: the ones still counting get 90 days from now, the new one (its level is
// one more than those), its timeout, the member's notification, the log line, and at the 5th a moderator's review.
async function giveStrike(env, { userId, postId, scanId, res, cleaned, now }) {
  const DB = env.DB;
  const { n } = await DB.prepare('SELECT COUNT(*) AS n FROM ai_strikes WHERE user_id = ? AND status IN (\'active\', \'appealed\') AND expires > ?').bind(userId, now).first();
  const st = step(n + 1);
  const fresh = '(SELECT MAX(id) FROM ai_strikes WHERE user_id = ?1 AND created = ?2)';
  await DB.batch([
    DB.prepare('UPDATE ai_strikes SET expires = ?3 WHERE user_id = ?1 AND status IN (\'active\', \'appealed\') AND expires > ?2').bind(userId, now, now + STRIKE_LIFE),
    DB.prepare(`INSERT INTO ai_strikes (user_id, post_id, scan_id, level, text, score, label, model, created, expires)
      VALUES (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?2, ?10)`)
      .bind(userId, now, postId, scanId, st.level, cleaned.slice(0, KEEP_TEXT), res.score, res.label, res.model, now + STRIKE_LIFE),
    st.timeoutMs && DB.prepare(`INSERT INTO posting_timeouts (user_id, strike_id, until) SELECT ?1, ${fresh}, ?3`).bind(userId, now, now + st.timeoutMs),
    DB.prepare(`INSERT INTO notifications (user_id, kind, actor_id, created, strike_id) SELECT ?1, 'ai_strike', ?1, ?2, ${fresh}`).bind(userId, now),
    DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (NULL, \'ai_strike\', \'user\', ?, ?, ?)')
      .bind(userId, `strike ${st.level} (${st.action}): ${res.label} ${res.score} by ${res.model}, post ${postId}`, now),
    st.action === 'review' && DB.prepare(`INSERT OR IGNORE INTO mod_alerts (kind, key, payload, created)
      SELECT 'ban_review', 'user:' || ?1, json_object('users', json_array(?1), 'strike', ${fresh}, 'level', ?3), ?2`).bind(userId, now, st.level),
  ].filter(Boolean));
}

// the cron (every 30 minutes): expiry, old text, old scans
export async function sweepStrikes(env, now) {
  const free = 'user_id NOT IN (SELECT user_id FROM held_accounts)';
  await env.DB.batch([
    env.DB.prepare('UPDATE ai_strikes SET status = \'expired\' WHERE status IN (\'active\', \'appealed\') AND expires <= ?').bind(now),
    env.DB.prepare('DELETE FROM posting_timeouts WHERE until < ?').bind(now - DAY),
    env.DB.prepare(`UPDATE ai_strikes SET text = '' WHERE status IN ('removed', 'expired') AND text != '' AND COALESCE(decided_at, expires) < ? AND ${free}`).bind(now - 30 * DAY),
    env.DB.prepare(`DELETE FROM ai_scans WHERE created < ? AND ${free}`).bind(now - 90 * DAY),
  ]);
}
