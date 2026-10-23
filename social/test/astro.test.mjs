// The astronomy behind the horoscopes, checked against published ephemeris facts. Pure functions: no server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sky, sunSign, natal, localDay } from '../src/astro.js';

const NOW = Date.UTC(2026, 9, 23, 18);                          // "now" for localDay, so these never drift

test('star signs from birthdays, cusps included', () => {
  assert.equal(sunSign('2000-01-01').name, 'Capricorn');
  assert.equal(sunSign('1995-08-15').name, 'Leo');
  assert.equal(sunSign('2010-03-20').name, 'Pisces');
  assert.equal(sunSign('2010-03-20').cusp, 'aries', 'the Sun entered Aries at 17:32 UTC that day');
  assert.equal(sunSign('2010-03-21').name, 'Aries');
  assert.equal(natal('2000-01-01').Moon.sign, 'scorpio');
});

test('October 23 2026 (UTC-5): Sun enters Scorpio, Venus retrograde, waxing gibbous Moon', () => {
  const d = localDay('2026-10-23', 300, NOW);
  const s = sky(d.start, d.end);
  const P = Object.fromEntries(s.planets.map(p => [p.body, p]));
  assert.deepEqual([P.Sun.ingress.from, P.Sun.ingress.to], ['libra', 'scorpio']);
  assert.equal(new Date(P.Sun.ingress.at).toISOString().slice(0, 13), '2026-10-23T09');
  assert.equal(P.Venus.retrograde, true);
  assert.equal(new Date(P.Venus.directOn).toISOString().slice(0, 10), '2026-11-14');
  assert.equal(P.Saturn.sign, 'aries');
  assert.equal(s.moon.phase, 'waxing-gibbous');
});

test('Mercury stations retrograde on October 24 2026; Full Moon in Taurus on the 26th', () => {
  const d = localDay('2026-10-24', 0, NOW);
  const merc = sky(d.start, d.end).planets.find(p => p.body === 'Mercury');
  assert.equal(merc.station.turns, 'retrograde');
  const f = localDay('2026-10-26', 0, Date.UTC(2026, 9, 26, 6));
  const ev = sky(f.start, f.end).moon.event;
  assert.equal(ev.name, 'Full Moon');
  assert.equal(ev.sign, 'taurus');
});

test('the day comes from the reader\'s clock, within reason', () => {
  assert.equal(localDay('2026-10-23', 300, NOW).start, Date.UTC(2026, 9, 23, 5));
  assert.equal(localDay('1999-01-01', 0, NOW).date, '2026-10-23', 'far-off dates fall back to today');
  assert.equal(localDay('2026-10-23', 'nonsense', NOW).tz, 0);
});
