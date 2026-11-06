/* widgets/pow.js — the sign-up form's proof of work: find a counter (decimal digits) so that SHA-256(token + ":" + counter)
   starts with `bits` zero bits (src/trust/form.js checks it with one hash). Web Crypto in small batches, giving the page
   back to the browser every few milliseconds so typing and scrolling never stall. 18 bits is about 260,000 hashes. */

const enc = new TextEncoder();
const idle = () => new Promise(res => setTimeout(res, 0));

// the number of leading zero bits of a byte array
export function zeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

// → the counter, as a string. onProgress(0..1) is the chance a counter would have turned up by now (it never says 1 until
// it has). signal (an AbortSignal) stops it: the promise rejects with an Error whose .aborted is true.
export async function solvePow(token, bits, { signal, onProgress, sliceMs = 8, batch = 128 } = {}) {
  const expected = 2 ** bits;
  let counter = 0, sliceStart = performance.now();
  for (;;) {
    if (signal && signal.aborted) { const e = new Error('cancelled'); e.aborted = true; throw e; }
    const tries = Array.from({ length: batch }, (_, i) => counter + i);
    const digests = await Promise.all(tries.map(c => crypto.subtle.digest('SHA-256', enc.encode(`${token}:${c}`))));
    for (let i = 0; i < digests.length; i++) if (zeroBits(new Uint8Array(digests[i])) >= bits) return String(tries[i]);
    counter += batch;
    if (performance.now() - sliceStart >= sliceMs) {
      if (onProgress) onProgress(Math.min(0.99, 1 - Math.exp(-counter / expected)));
      await idle();
      sliceStart = performance.now();
    }
  }
}
