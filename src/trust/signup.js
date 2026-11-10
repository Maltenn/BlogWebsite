// Every way of signing up passes through here before an account is made (accounts/auth.js for email, accounts/oauth.js
// for Google & co.): the signed form and its proof of work (form.js), the form spent, then an announced bot, the
// honeypot and a rushed form, the email domain (email.js) and Cloudflare Turnstile (turnstile.js). Then the risk score
// (risk.js) decides whether a moderator looks at the account first. recordSignup() stores the signals (90 days).
import { fail } from '../shared/http.js';
import { checkForm, spendNonce, formSecret, minFormMs, softFormMs } from './form.js';
import { checkTurnstile } from './turnstile.js';
import { domainOf, isDisposable, isConsumer, mailProblem } from './email.js';
import { declaredAgent, requestSignals, scoreSignup, signupCounts } from './risk.js';

const STALE = 'this sign-up form went stale. we loaded a fresh one: send it again.';
const MESSAGES = {
  form: STALE,
  form_expired: STALE,
  form_used: 'that form was already used. we loaded a fresh one: send it again.',
  too_fast: 'whoa, that was fast! take a second to check your details, then send it again.',
  pow: 'your browser hasn\'t finished its check yet. wait for "checking…" to finish, then send it again.',
};
const GENERIC = 'something about this sign-up didn\'t look right. reload the page and try again.';

// b: the request body ({ form, pow, turnstile, <honeypot>, … }). purpose: 'signup' | 'finish'. email: the address to
// check. vouched: a sign-in provider confirmed that address (Google & co.), so only the throwaway list applies, not the
// mail check. Answers { risk, reasons, hold, signals, formMs, emailDomain } or throws a 4xx with { code }.
//
// The order matters (red team, phase 7): first the signed form and its proof of work, which write nothing when they
// fail (a request that didn't pay for the proof of work can't cost anybody anything); then the form is spent, so every
// outcome after it uses it up; only then the cheap-to-fake refusals (an announced bot, the honeypot, a rushed form, the
// email, Turnstile). None of them writes a rate-limit row: the network's sign-up allowance (createUser) counts only
// sign-ups that got through all of this.
export async function screenSignup(c, b, { purpose, email, vouched = false }) {
  const f = await checkForm(formSecret(c.env), { token: b.form, pow: b.pow, body: b, purpose, now: c.now, minMs: minFormMs(c.env) });
  if (!f.ok) fail(400, MESSAGES[f.code] || STALE, { code: f.code });
  if (!await spendNonce(c.env, f.nonce, c.now)) fail(400, MESSAGES.form_used, { code: 'form_used' });
  if (declaredAgent(c.req.headers)) {
    fail(403, 'automated sign-ups aren\'t allowed here. please create your account yourself, in a browser.', { code: 'automation' });
  }
  if (f.honeypotFilled) fail(400, GENERIC, { code: 'form' });
  if (f.tooFast) fail(400, MESSAGES.too_fast, { code: 'too_fast' });
  const emailDomain = email ? domainOf(email) : null;
  if (emailDomain) {
    if (isDisposable(emailDomain)) {
      fail(400, 'throwaway email addresses can\'t be used here. use an address you\'ll keep: we send your confirmation link there.', { code: 'disposable_email' });
    }
    const problem = vouched ? null : await mailProblem(c.env, emailDomain);
    if (problem) fail(400, `"${emailDomain}" can't receive email. check the address for a typo.`, { code: 'email_domain' });
  }
  await checkTurnstile(c, b.turnstile, 'signup');
  const signals = await requestSignals(c);
  const counts = await signupCounts(c.env, signals, emailDomain, c.now);
  const score = scoreSignup({ ...signals, ...counts, formMs: f.formMs, minMs: minFormMs(c.env), softMs: softFormMs(c.env), emailDomain, consumerDomain: isConsumer(emailDomain) });
  return { ...score, signals, formMs: f.formMs, emailDomain };
}

// The statements that keep a sign-up's signals (and, when it's held, the moderators' alert), for the account just made.
export function recordSignup(env, userId, screen, now) {
  const s = screen.signals;
  const out = [env.DB.prepare(`INSERT OR REPLACE INTO signup_signals (user_id, ip_group_hash, asn, as_org, country, ua_hash, email_domain, form_ms, risk, reasons, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, s.ipGroupHash, s.asn, s.asOrg, s.country, s.uaHash, screen.emailDomain, screen.formMs, screen.risk, JSON.stringify(screen.reasons), now)];
  if (screen.hold) {
    out.push(env.DB.prepare('INSERT OR IGNORE INTO mod_alerts (kind, key, payload, created) VALUES (\'held_signup\', ?, ?, ?)')
      .bind('user:' + userId, JSON.stringify({ users: [userId], risk: screen.risk, reasons: screen.reasons }), now));
  }
  return out;
}
