// Everything people type goes through here before it is stored: invisible / direction-flipping characters out,
// whitespace tidied, length capped, links removed, the blocked words starred out. The page shows text with
// textContent only, so none of this is about HTML — it is about spam and abuse. Also: the @mentions and #tags in a post.

// Matched as whole words, so "grapes" and "braids" survive.
const BLOCKED = ['nigger', 'nigga', 'retard', 'retarded', 'chink', 'nazi', 'hitler', 'swastika',
  'fag', 'faggot', 'fucktard', 'rape', 'incest', 'aids'];
const WORDS = new RegExp(`(^|[^\\p{L}\\p{N}])(${BLOCKED.join('|')})(s|es|ed|ing)?(?=$|[^\\p{L}\\p{N}])`, 'giu');
const HAS_WORD = new RegExp(WORDS.source, 'iu');   // the same pattern without the global flag, for tests
const LINKS = /\b(?:https?:\/\/|www\.)\S+/gi;

// control characters, zero-width characters and bidi overrides (used to disguise text and names), and the blank
// "letters" that look like nothing: the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the blank Braille pattern
// (U+2800), which would otherwise count as letters in a #tag
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u115F\u1160\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFEFF\uFFA0]/g;

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

// `s` cut to `max` characters with an ellipsis (for teasers), or null when it already fits
export function clip(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() + '…' : null;
}

/* @mentions and #tags, read out of a post when it is written (from the stored text, so after filter()) */

const MENTION = /(^|[^A-Za-z0-9_~*.\-@])@([A-Za-z0-9_~*.\-]+)/g;

// The screen names a text @mentions, in order and lower case, at most 20. Each comes as the names it could be, longest
// first: a trailing . ~ * or - is punctuation unless somebody's name really ends that way, so "@kat." is kat. or kat.
export function mentionsIn(s) {
  const found = [];
  for (const m of String(s ?? '').matchAll(MENTION)) {
    const tries = [];
    for (let run = m[2].toLowerCase(); ; run = run.slice(0, -1)) {
      if (run.length >= 3 && run.length <= 20) tries.push(run);
      if (!/[.~*-]$/.test(run)) break;
    }
    if (tries.length && !found.some(f => f[0] === tries[0])) found.push(tries);
    if (found.length === 20) break;
  }
  return found;
}

const HASHTAG = /(^|[^\p{L}\p{M}\p{N}_])#([\p{L}\p{M}\p{N}_]+)/gu;

// a #tag as stored (lower case, invisible characters out), or '' if it isn't one: 1–40 letters (any alphabet), digits
// or _, at least one letter
export function tagKey(s) {
  const t = String(s ?? '').replace(INVISIBLE, '').normalize('NFC').toLowerCase();
  return /^[\p{L}\p{M}\p{N}_]{1,40}$/u.test(t) && /\p{L}/u.test(t) ? t : '';
}

// the #tags in a text, in order, without repeats, at most 10
export function tagsIn(s) {
  const tags = [];
  for (const m of String(s ?? '').matchAll(HASHTAG)) {
    const tag = tagKey(m[2]);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length === 10) break;
  }
  return tags;
}

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
