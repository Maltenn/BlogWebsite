// Everything people type goes through here before it is stored: invisible / direction-flipping characters out,
// whitespace tidied, length capped, links removed, the blocked words starred out. The page shows text with
// textContent only, so none of this is about HTML — it is about spam and abuse.

// The original site's guestbook list, minus "legend" and "birthday" (inside jokes that would stop real people
// saying happy birthday). Matched as whole words now, so "grapes" and "braids" survive.
const BLOCKED = ['nigger', 'nigga', 'retard', 'retarded', 'chink', 'nazi', 'hitler', 'swastika',
  'fag', 'faggot', 'fucktard', 'rape', 'incest', 'aids'];
const WORDS = new RegExp(`(^|[^\\p{L}\\p{N}])(${BLOCKED.join('|')})(s|es|ed|ing)?(?=$|[^\\p{L}\\p{N}])`, 'giu');
const HAS_WORD = new RegExp(WORDS.source, 'iu');   // the same pattern without the global flag, for tests
const LINKS = /\b(?:https?:\/\/|www\.)\S+/gi;

// control characters, zero-width characters and bidi overrides (used to disguise text and names)
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const cap = (s, max) => {
  const chars = Array.from(s);                     // by code point, so an emoji is never cut in half
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
};

// one line of text
export function line(s, max) {
  const t = String(s ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return cap(t, max);
}

// a paragraph or several: keeps single blank lines, nothing more
export function para(s, max) {
  const t = String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cap(t, max);
}

export function filter(s) {
  return s
    .replace(LINKS, '[link removed]')
    .replace(WORDS, (m, pre, w, suf = '') => pre + '*'.repeat(Array.from(w + suf).length));
}

// cleaned + filtered, ready to store
export const text = (s, max) => filter(line(s, max));
export const longText = (s, max) => filter(para(s, max));

// Screen names: 3–20 characters, letters/digits/_ plus ~ * . - for 2006 styling, at least two letters or digits.
const RESERVED = ['admin', 'administrator', 'mod', 'moderator', 'ourspace', 'staff', 'support', 'system', 'official',
  'you', 'guest', 'null', 'undefined', 'anonymous', 'root', 'api', 'help', 'rules', 'settings'];

export function nameProblem(name) {
  const n = String(name ?? '').trim();
  if (n.length < 3) return 'screen names need at least 3 characters.';
  if (n.length > 20) return 'max 20 characters. this isn\'t a novel.';
  if (!/^[A-Za-z0-9_~*.\-]+$/.test(n)) return 'letters, numbers and _ only (plus ~ * . - for styling). no spaces!';
  if ((n.match(/[A-Za-z0-9]/g) || []).length < 2) return 'needs at least a couple of letters or numbers in there.';
  const key = n.toLowerCase();
  const bare = key.replace(/[^a-z0-9]/g, '');
  if (RESERVED.includes(key) || RESERVED.includes(bare)) return 'that one\'s reserved. pick something with more personality.';
  if (HAS_WORD.test(n.replace(/[_~*.\-]+/g, ' '))) return 'pick a different name.';
  return '';
}
