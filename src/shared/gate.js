// The gate in front of every write a member makes to the site (src/index.js applies it from the route table, so a new
// route can't forget it): a confirmed email and not held for review for any write that reaches other people
// (posts, comments, likes, reposts, votes, follows, messages, chats, board requests), and, for public posting and
// commenting only, no posting timeout from an AI-writing strike. Moderators pass. Account, page set-up, privacy and
// safety routes (blocks, reports, deleting your own things) are exempt: those are marked in the route table.
import { fail } from './http.js';

// SQL: when user ?1's posting timeout ends (the latest `until` of a timeout whose strike still counts), or NULL. ?2: now.
export const TIMEOUT_UNTIL = `(SELECT MAX(t.until) FROM posting_timeouts t JOIN ai_strikes s ON s.id = t.strike_id
  WHERE t.user_id = ?1 AND t.until > ?2 AND s.status IN ('active', 'appealed'))`;

export async function timeoutUntil(env, userId, now) {
  const r = await env.DB.prepare(`SELECT ${TIMEOUT_UNTIL} AS until`).bind(userId, now).first();
  return (r && r.until) || null;
}

// level: 'write' (verified, not held) or 'post' (that, and no posting timeout)
export async function checkGate(c, level) {
  const u = c.user;
  if (!u || u.is_admin) return;
  // (an account without an email: a sign-in provider vouched for none, so it is held instead and a moderator's
  // approval confirms it: trust/moderation.js)
  if (!u.email_verified_at && u.email) {
    fail(403, 'confirm your email first: we sent you a link when you signed up. (no email? you can send it again from the banner.)', { code: 'unverified' });
  }
  if (u.held || !u.email_verified_at) {
    fail(403, 'a moderator will take a quick look at your new account, usually within a day. until then you can set up your page and look around.', { code: 'held' });
  }
  if (level === 'post') {
    const until = await timeoutUntil(c.env, u.id, c.now);
    if (until) fail(403, 'you can\'t post or comment until your posting timeout ends. you can still read, like and chat.', { code: 'timeout', until });
  }
}
