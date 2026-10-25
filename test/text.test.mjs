// Unit tests for the @mention and #tag readers (and the invisible characters they never see) in src/shared/text.js:
// `npm test`. Pure functions: no server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsIn, tagsIn, tagKey, clip, line, para } from '../src/shared/text.js';

test('@mentions: screen names in order, lower case, each with the names it could be', () => {
  assert.deepEqual(mentionsIn('hi @Kat and @sk8r_jules!'), [['kat'], ['sk8r_jules']]);
  assert.deepEqual(mentionsIn('@xX_glitterkat_Xx rules'), [['xx_glitterkat_xx']]);
  assert.deepEqual(mentionsIn('ask @pete.jones, or @emo~drew*'), [['pete.jones'], ['emo~drew*', 'emo~drew']]);
  assert.deepEqual(mentionsIn('thanks @kat.'), [['kat.', 'kat']], 'a trailing . might be punctuation: both are tried, longest first');
  assert.deepEqual(mentionsIn('wow @mia...'), [['mia...', 'mia..', 'mia.', 'mia']]);
  assert.deepEqual(mentionsIn('(@mia) @mia @MIA'), [['mia']], 'each name once');
});

test('@mentions: not inside words or email addresses, 3 to 20 characters, at most 20', () => {
  assert.deepEqual(mentionsIn('mail me@example.com or kat@home'), []);
  assert.deepEqual(mentionsIn('@ab @abc'), [['abc']], 'too short');
  assert.deepEqual(mentionsIn('@' + 'a'.repeat(21)), [], 'too long');
  assert.deepEqual(mentionsIn('@' + 'a'.repeat(20) + '..'), [['a'.repeat(20)]], 'too long only with its punctuation');
  assert.deepEqual(mentionsIn('@@kat'), []);
  const many = Array.from({ length: 25 }, (_, i) => `@person${i}`).join(' ');
  assert.equal(mentionsIn(many).length, 20);
  assert.deepEqual(mentionsIn(null), []);
});

test('#tags: letters (any alphabet), digits and _, with a letter, lower case, at most 10', () => {
  assert.deepEqual(tagsIn('#Glitter is a #lifestyle, #GLITTER forever'), ['glitter', 'lifestyle']);
  assert.deepEqual(tagsIn('#café #東京 #Ünïcode #добро_пожаловать'), ['café', '東京', 'ünïcode', 'добро_пожаловать']);
  assert.deepEqual(tagsIn('#2006 #y2k #_ #a_1'), ['y2k', 'a_1'], 'digits and _ alone are not tags');
  assert.deepEqual(tagsIn('c#sharp and a#b, #ok!'), ['ok'], 'not inside a word');
  assert.deepEqual(tagsIn('#' + 'x'.repeat(40) + ' #' + 'y'.repeat(41)), ['x'.repeat(40)], 'up to 40 characters');
  assert.deepEqual(tagsIn('#tag-with-dash #end.'), ['tag', 'end']);
  assert.equal(tagsIn(Array.from({ length: 12 }, (_, i) => `#t${i}`).join(' ')).length, 10);
  assert.deepEqual(tagsIn('#****'), [], 'a starred-out word is not a tag');
});

test('tagKey: the stored form of a tag, or nothing', () => {
  assert.equal(tagKey('Glitter'), 'glitter');
  assert.equal(tagKey('café'), 'café', 'NFC, so the two ways of typing é are one tag');
  assert.equal(tagKey('123'), '');
  assert.equal(tagKey('two words'), '');
  assert.equal(tagKey(''), '');
});

test('blank "letters" (Hangul fillers, the blank Braille pattern) are invisible: stripped from text, and no #tag on their own', () => {
  const blanks = ['ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '⠀'];
  assert.equal(line(`a${blanks.join('b')}c`, 50), 'abbbbc');
  assert.equal(para(`xㅤ\n⠀y`, 50), 'x\ny');
  for (const b of blanks) {
    assert.equal(tagKey(b), '', `U+${b.codePointAt(0).toString(16)} alone is no tag`);
    assert.equal(tagKey(`glitter${b}`), 'glitter');
    assert.deepEqual(tagsIn(`#${b} #${b}${b} hi`), [], 'a tag that is empty once they are out is no tag');
  }
  assert.deepEqual(tagsIn('#rtㅤspace #ㅤ'), ['rtspace']);
  assert.deepEqual(tagsIn(line('#ㅤ #okㅤ', 50)), ['ok'], 'as stored');
});

test('clip: cut by characters, never through an emoji', () => {
  assert.equal(clip('short', 10), null);
  assert.equal(clip('a long sentence here', 6), 'a long…');
  assert.equal(clip('💖💖💖', 2), '💖💖…');
});
