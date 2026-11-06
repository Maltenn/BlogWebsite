// The sign-up risk score (docs/decisions/003, layer 1). Never a refusal by itself: a score of HOLD_AT or more makes the
// account wait for a moderator (it can log in and set up its page, but not post, comment, message or follow until
// approved). Refusals come only from hard signals, checked elsewhere: the honeypot, a form sent too fast, a missing or
// failed human check or proof of work, a replayed form, a throwaway email domain, an announced bot.
//
//   +2  the request comes from a hosting / datacenter network (HOSTING_ASNS)
//   +2  the same network (IPv4 address or IPv6 /64) signed up in the last 24 hours
//   +2  that network's provider (ASN) has had 4+ sign-ups in the last hour, more than 3× its usual hourly rate
//   +2  an unfamiliar email domain (not a big mail provider) that already had 2+ sign-ups in 24 hours
//   +1  the form was sent between SIGNUP_MIN_MS and SIGNUP_SOFT_MS after it opened (fast, not impossibly so)
//   +1  HTTP/1.1 from something calling itself a browser (browsers speak HTTP/2 or 3 to Cloudflare)
//   +1  no Accept-Language header
// A VPN or a school's shared address alone (+2) never holds anyone.
import { ipGroup, sha256Hex } from '../shared/http.js';

export const HOLD_AT = 3;

// Hosting and datacenter networks (by ASN), from github.com/brianhama/bad-asn-list's best-known entries. Review
// quarterly. Consumer VPNs often sit on these, which is why this is a score, never a block.
export const HOSTING_ASNS = new Set([
  16509, 14618, 8987,                 // Amazon AWS
  15169, 396982, 19527,               // Google Cloud
  8075, 8068,                         // Microsoft Azure
  14061,                              // DigitalOcean
  16276,                              // OVH
  24940, 213230,                      // Hetzner
  63949,                              // Linode / Akamai
  20473,                              // Vultr (Choopa)
  51167,                              // Contabo
  31898,                              // Oracle Cloud
  12876,                              // Scaleway
  60781, 28753,                       // Leaseweb
  9009,                               // M247
  45102, 37963,                       // Alibaba Cloud
  132203,                             // Tencent Cloud
  47583,                              // Hostinger
  36352,                              // ColoCrossing
  53667,                              // FranTech / BuyVM
  62567, 46562,                       // DigitalOcean (older), Performive
  40021, 399629,                      // Contabo US, BL Networks
  212238,                             // Datacamp (CDN77)
]);

const BROWSER_UA = /Mozilla\/5\.0/;
// software that says what it is: refused ("create your account yourself")
const DECLARED_BOT = /(HeadlessChrome|PhantomJS|python-requests|python-urllib|aiohttp|httpx|curl\/|Wget|Go-http-client|okhttp|axios\/|node-fetch|undici|Scrapy|Selenium|Puppeteer|Playwright|GPTBot|ChatGPT-User|OAI-SearchBot|Claude-User|ClaudeBot|anthropic-ai|PerplexityBot|Perplexity-User|Bytespider|bot\/|\bcrawler\b|\bspider\b)/i;

// Is this request an automated agent that announces itself? A Web Bot Auth signature (Signature-Agent /
// Signature-Input headers) or a User-Agent naming automation software. Answers the reason or null.
export function declaredAgent(headers) {
  if (headers.get('Signature-Agent') || headers.get('Signature-Input')) return 'signature_agent';
  const ua = headers.get('User-Agent') || '';
  if (DECLARED_BOT.test(ua)) return 'automation_ua';
  return null;
}

// What the request tells us, without keeping anything identifying: the network as a salted hash, the provider (ASN,
// its name, the country) from Cloudflare's request.cf, the User-Agent as a salted hash. With TEST_SIGNALS=1 (tests, the
// demo and the bot simulator only; never set it on a real server) the address comes from X-Test-Ip and the request.cf
// fields from the JSON in X-Test-Cf, so a test can be a datacenter or a shared /64.
export async function requestSignals(c) {
  const h = c.req.headers;
  const test = c.env.TEST_SIGNALS === '1';
  const ip = (test && h.get('X-Test-Ip')) || h.get('CF-Connecting-IP') || '';
  let cf = c.req.cf || {};
  if (test) { try { cf = JSON.parse(h.get('X-Test-Cf') || '{}') || {}; } catch { cf = {}; } }
  const salt = c.env.IP_SALT || 'ourspace-social';
  const ua = h.get('User-Agent') || '';
  return {
    ipGroupHash: (await sha256Hex(`${salt}|${ipGroup(ip)}`)).slice(0, 32),
    asn: Number(cf.asn) || null,
    asOrg: cf.asOrganization ? String(cf.asOrganization).slice(0, 80) : null,
    country: cf.country ? String(cf.country).slice(0, 2) : null,
    httpProtocol: cf.httpProtocol ? String(cf.httpProtocol) : null,
    uaHash: ua ? (await sha256Hex(`${salt}|ua|${ua}`)).slice(0, 32) : null,
    browserUa: BROWSER_UA.test(ua),
    acceptLanguage: !!h.get('Accept-Language'),
  };
}

// The score (pure). s: requestSignals() plus formMs, minMs, softMs, emailDomain, consumerDomain, and the counts from
// signup_signals: sameNet24h, asnHour, asnWeek, domain24h. Answers { risk, reasons, hold }.
export function scoreSignup(s) {
  const reasons = [];
  const add = (points, code) => reasons.push({ code, points });
  if (s.asn && HOSTING_ASNS.has(Number(s.asn))) add(2, 'hosting_network');
  if ((s.sameNet24h || 0) >= 1) add(2, 'same_network_24h');
  const usual = (s.asnWeek || 0) / (7 * 24);
  if (s.asn && (s.asnHour || 0) >= 4 && (s.asnHour || 0) > 3 * usual) add(2, 'provider_burst');
  if (s.emailDomain && !s.consumerDomain && (s.domain24h || 0) >= 2) add(2, 'domain_burst');
  if (s.formMs != null && s.formMs >= s.minMs && s.formMs < s.softMs) add(1, 'fast_form');
  if (s.httpProtocol === 'HTTP/1.1' && s.browserUa) add(1, 'old_protocol_browser');
  if (!s.acceptLanguage) add(1, 'no_accept_language');
  const risk = reasons.reduce((n, r) => n + r.points, 0);
  return { risk, reasons: reasons.map(r => r.code), hold: risk >= HOLD_AT };
}

// the counts scoreSignup needs, in one read
export async function signupCounts(env, s, emailDomain, now) {
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM signup_signals WHERE ip_group_hash = ?1 AND created > ?4 - 86400000) AS sameNet24h,
      (SELECT COUNT(*) FROM signup_signals WHERE asn = ?2 AND created > ?4 - 3600000) AS asnHour,
      (SELECT COUNT(*) FROM signup_signals WHERE asn = ?2 AND created > ?4 - 604800000) AS asnWeek,
      (SELECT COUNT(*) FROM signup_signals WHERE email_domain = ?3 AND created > ?4 - 86400000) AS domain24h`)
    .bind(s.ipGroupHash, s.asn || -1, emailDomain || '', now).first();
  return r || {};
}
