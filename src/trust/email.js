// Email addresses at sign-up (docs/decisions/003): refuse throwaway inboxes (the bundled list, src/trust/disposable.js,
// a domain and every subdomain of it) and domains that can't receive mail: no such domain (NXDOMAIN) or a "null MX"
// (RFC 7505: the domain says it takes no mail). Asked over DNS-over-HTTPS (Cloudflare's resolver, or DOH_URL: the
// tests and the demo point it at a stand-in). Anything else passes, a timeout or a resolver error included: we fail
// open, since a typo'd domain only costs the person their verification email.
import { DISPOSABLE, ALLOW, CONSUMER } from './disposable.js';

const DOH = 'https://cloudflare-dns.com/dns-query';

export const domainOf = email => String(email || '').slice(String(email || '').lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');

// is this domain (or a domain it's under) a throwaway-inbox service? Case-insensitive; never matches a bare TLD.
export function isDisposable(domain) {
  const parts = String(domain || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (ALLOW.has(d)) return false;
    if (DISPOSABLE.has(d)) return true;
  }
  return false;
}

export const isConsumer = domain => CONSUMER.has(String(domain || '').toLowerCase());

// 'nxdomain' | 'null_mx' | null (fine, or we couldn't tell)
export async function mailProblem(env, domain) {
  if (!domain || CONSUMER.has(domain)) return null;
  try {
    const url = `${env.DOH_URL || DOH}?name=${encodeURIComponent(domain)}&type=MX`;
    const r = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.Status === 3) return 'nxdomain';
    if (data.Status !== 0) return null;
    const mx = (data.Answer || []).filter(a => a.type === 15).map(a => String(a.data || '').trim());
    if (mx.length && mx.every(m => /^0\s+\.?$/.test(m))) return 'null_mx';
    return null;
  } catch {
    return null;
  }
}
