// Near-duplicate text, for spam pushed by several accounts at once (docs/decisions/003, layer 2). Pure functions,
// unit-tested in test/trust.test.mjs.
//
// The text is normalised first (lower case, accents and look-alike letters folded, links, @mentions, punctuation and
// emoji out), so "BUY now!!! 🔥" and "buy now" are the same words. Then each post gets a MinHash signature: its word
// 3-shingles (every run of three words) hashed with 16 different seeds, keeping the smallest hash for each seed. Two
// texts agree on each of the 16 values with a probability equal to their Jaccard similarity (shared shingles over all
// shingles), so the share of values that agree estimates it. A light edit (a word or two changed, an emoji added) stays
// above 0.6; unrelated texts agree on none.
//
// Why not 003's 64-bit simhash: on post-sized texts it's too twitchy. Measured on a 26-word spam post, changing one
// word kept the simhash within 3 bits only 5% of the time (58 words: 34%); simhash wants long documents.
// The first four values double as lookup bands: a text sharing 60%+ of its shingles shares one of them almost surely.

export const MIN_WORDS = 8;          // shorter texts get no fingerprint ("lol", "same", "happy birthday!!")
export const SIG_VALUES = 16;
export const SIMILAR = 0.6;          // the share of signature values two near-duplicates have in common, at least

// Cyrillic and Greek letters that look like Latin ones, mapped back (spammers swap them in to dodge exact matches)
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd',
  'ɡ': 'g', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x' };

export function normalize(s) {
  return String(s || '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, ch => LOOKALIKE[ch] || ch)
    .replace(/\[link removed\]|\bhttps?:\/\/\S+|\bwww\.\S+/g, ' ')
    .replace(/(^|\s)@[\w~*.-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const words = s => { const n = normalize(s); return n ? n.split(' ') : []; };

// 32-bit FNV-1a with a seed, and a final mix so neighbouring inputs spread over all the bits
function hash32(s, seed) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
const SEEDS = Array.from({ length: SIG_VALUES }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);

export function shingles(ws) {
  if (ws.length < 3) return [ws.join(' ')];
  return [...new Set(ws.slice(2).map((w, i) => `${ws[i]} ${ws[i + 1]} ${w}`))];
}

// the signature of a list of words: 16 values of 8 hex digits, as one string
export function minhash(ws) {
  const sh = shingles(ws);
  let out = '';
  for (const seed of SEEDS) {
    let min = 0xffffffff;
    for (const s of sh) { const h = hash32(s, seed); if (h < min) min = h; }
    out += min.toString(16).padStart(8, '0');
  }
  return out;
}

const values = sig => Array.from({ length: SIG_VALUES }, (_, i) => sig.slice(i * 8, i * 8 + 8));

// the share of signature values two signatures have in common (≈ the texts' Jaccard similarity)
export function similarity(a, b) {
  const x = values(a), y = values(b);
  let same = 0;
  for (let i = 0; i < SIG_VALUES; i++) if (x[i] === y[i]) same++;
  return same / SIG_VALUES;
}

// the lookup bands: the first four values
export const bands = sig => values(sig).slice(0, 4);

// Is `a` ({ sig, textHash }) a near-duplicate of `b`? The same normalised text, or 60%+ of the signature in common.
export function nearDuplicate(a, b) {
  if (a.textHash && a.textHash === b.textHash) return true;
  return similarity(a.sig, b.sig) >= SIMILAR;
}
