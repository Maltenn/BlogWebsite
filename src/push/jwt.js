// Signed tokens for the two push services, with crypto.subtle only (no packages): ES256 for APNs (a P-256 key from
// Apple's .p8 file) and RS256 for Google's service account (an RSA key from its JSON file). Both keys are PKCS#8 PEM.

const enc = new TextEncoder();

export const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = o => b64url(enc.encode(JSON.stringify(o)));

// the key bytes inside a PEM. A secret pasted into a dashboard or a .env file often has its line breaks written as the
// two characters \n, or lost; both come out the same here.
export function pemBytes(pem) {
  const body = String(pem || '').replace(/\\n/g, '\n').replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), ch => ch.charCodeAt(0));
}

const ALGS = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
};

// A compact JWT. WebCrypto's ECDSA signature is the raw r||s form that JWT wants (not DER), so it goes in as it is.
export async function signJwt(alg, pem, header, claims) {
  const a = ALGS[alg];
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(pem), a.import, false, ['sign']);
  const data = `${json64({ alg, typ: 'JWT', ...header })}.${json64(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(a.sign, key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}
