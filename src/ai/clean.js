// What an AI-writing detector gets to judge (docs/decisions/002): only public posts long enough to judge (100 words;
// blog posts 150), never DMs or chat, and only the person's own words: quotes, code, links, @mentions, emoji, markdown
// marks and invisible characters are taken out, look-alike Cyrillic and Greek letters mapped back to Latin (they wreck
// some detectors). Pure functions, shared by the Worker and tools/eval-detector.mjs, so the evaluation runs the exact
// same pipeline.

export const SCANNED_KINDS = ['status', 'reply', 'quote', 'blog', 'thread', 'comment', 'wall'];
export const MIN_WORDS = { blog: 150, default: 100 };
export const MAX_CHARS = 6000;          // longer texts are cut (one window is enough for a score, and it caps the cost)

const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'Α': 'A', 'Β': 'B', 'Ε': 'E',
  'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X' };

export function cleanForDetection(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')                        // code blocks
    .replace(/`[^`\n]*`/g, ' ')                             // inline code
    .replace(/^\s*>.*$/gm, ' ')                             // quoted lines
    .replace(/\[link removed\]|\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/(^|[^\w])@[\w~*.-]+/g, '$1 ')                 // @mentions
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️⃣]/gu, ' ')
    .normalize('NFKC')
    .replace(/[Ͱ-ϿЀ-ӿԀ-ԯ]/g, ch => LOOKALIKE[ch] || ch)
    .replace(/[*_~#|^]+/g, ' ')                             // markdown marks
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

export const wordCount = s => (String(s || '').match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).length;

// Is a post of `kind` with `text` (its title and words) judged? { ok, cleaned, words, min }
export function eligible(kind, text) {
  const min = kind === 'blog' ? MIN_WORDS.blog : MIN_WORDS.default;
  if (!SCANNED_KINDS.includes(kind)) return { ok: false, cleaned: '', words: 0, min };
  const cleaned = cleanForDetection(text);
  const words = wordCount(cleaned);
  return { ok: words >= min, cleaned, words, min };
}
