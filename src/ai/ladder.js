// The owner's strike ladder for AI-written posts, as pure functions (unit-tested on a fake clock in
// test/trust.test.mjs; src/ai/scan.js and src/ai/strikes.js do the same in SQL):
//
//   1st strike  a warning
//   2nd         no public posting or commenting for a day
//   3rd         a week
//   4th         a month (30 days)
//   5th+        a moderator decides whether to ban (a ban_review alert; nothing automatic)
//
// Only label "AI" with a score of 0.95 or more strikes, at most once per 24-hour incident; the post stays up. Strikes
// expire after 90 clean days: every new strike moves the expiry of the ones still counting to 90 days after it. Each is
// appealable: a moderator upholds it or removes it, and removing it lifts any timeout it caused and exempts the member
// from automatic strikes for 180 days (their scores are still recorded).

export const DAY = 86400000;
export const THRESHOLD = 0.95;
export const STRIKE_LIFE = 90 * DAY;
export const INCIDENT = DAY;
export const EXEMPT_AFTER_REMOVAL = 180 * DAY;
const TIMEOUTS = { 2: DAY, 3: 7 * DAY, 4: 30 * DAY };

export const strikeWorthy = r => !!r && r.label === 'AI' && Number(r.score) >= THRESHOLD;

// what the `level`th strike does: { level, action: 'warning' | 'timeout' | 'review', timeoutMs }
export function step(level) {
  if (level <= 1) return { level: 1, action: 'warning', timeoutMs: 0 };
  if (level >= 5) return { level, action: 'review', timeoutMs: 0 };
  return { level, action: 'timeout', timeoutMs: TIMEOUTS[level] };
}

/* the ladder as a state machine: { strikes: [...], exemptUntil, nextId } */

export const newLadder = () => ({ strikes: [], exemptUntil: 0, nextId: 1 });

const counts = (s, now) => (s.status === 'active' || s.status === 'appealed') && s.expires > now;
export const counting = (state, now) => state.strikes.filter(s => counts(s, now));

// what a scan leads to: 'clear' | 'would_strike' (shadow mode) | 'exempt' | 'same_incident' | 'strike'
export function decide(state, result, now, mode = 'enforce') {
  if (!strikeWorthy(result)) return 'clear';
  if (state.exemptUntil > now) return 'exempt';
  if (mode !== 'enforce') return 'would_strike';
  if (state.strikes.some(s => s.status !== 'removed' && s.created > now - INCIDENT)) return 'same_incident';
  return 'strike';
}

// gives a strike: answers it (with its step and timeout)
export function strike(state, now, extra = {}) {
  const live = counting(state, now);
  for (const s of live) s.expires = now + STRIKE_LIFE;
  const st = step(live.length + 1);
  const s = { id: state.nextId++, level: st.level, action: st.action, created: now, expires: now + STRIKE_LIFE, status: 'active',
    timeoutUntil: st.timeoutMs ? now + st.timeoutMs : null, appealNote: null, result: null, ...extra };
  state.strikes.push(s);
  return s;
}

export function appeal(state, id, note) {
  const s = state.strikes.find(x => x.id === id);
  if (!s || s.status !== 'active' || s.appealNote != null) return null;
  s.status = 'appealed';
  s.appealNote = note;
  return s;
}

// a moderator's decision: 'uphold' (it stays) or 'remove' (it's gone, its timeout lifted, 180 days' exemption)
export function resolve(state, id, action, now) {
  const s = state.strikes.find(x => x.id === id);
  if (!s || (s.status !== 'active' && s.status !== 'appealed')) return null;
  if (action === 'remove') {
    s.status = 'removed';
    s.timeoutUntil = null;
    s.result = 'removed';
    state.exemptUntil = now + EXEMPT_AFTER_REMOVAL;
  } else {
    s.status = 'active';
    s.result = 'upheld';
  }
  return s;
}

// the end of the posting timeout in force, or null
export function timeoutUntil(state, now) {
  const ends = counting(state, now).map(s => s.timeoutUntil).filter(t => t && t > now);
  return ends.length ? Math.max(...ends) : null;
}

// the cron: strikes past their expiry stop counting
export function expire(state, now) {
  for (const s of state.strikes) if ((s.status === 'active' || s.status === 'appealed') && s.expires <= now) s.status = 'expired';
  return state;
}
