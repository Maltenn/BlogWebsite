// The sky, computed: where the Sun, Moon and planets really are (astronomy-engine, accurate to well under a degree),
// expressed the way astrology does — tropical zodiac signs on the ecliptic of date. Used for:
//   · everybody's star sign, from their birthday (the Sun's place that day)
//   · "the sky today": positions, the Moon's phase, retrogrades, sign changes and aspects for a local day
//   · a person's birth placements, for their personal reading
// Text lives in horoscope.js; this file is only numbers.
import * as A from 'astronomy-engine';

export const SIGNS = [
  { key: 'aries', name: 'Aries', glyph: '♈', element: 'fire', mode: 'cardinal', ruler: 'Mars', dates: 'Mar 21 – Apr 19' },
  { key: 'taurus', name: 'Taurus', glyph: '♉', element: 'earth', mode: 'fixed', ruler: 'Venus', dates: 'Apr 20 – May 20' },
  { key: 'gemini', name: 'Gemini', glyph: '♊', element: 'air', mode: 'mutable', ruler: 'Mercury', dates: 'May 21 – Jun 20' },
  { key: 'cancer', name: 'Cancer', glyph: '♋', element: 'water', mode: 'cardinal', ruler: 'Moon', dates: 'Jun 21 – Jul 22' },
  { key: 'leo', name: 'Leo', glyph: '♌', element: 'fire', mode: 'fixed', ruler: 'Sun', dates: 'Jul 23 – Aug 22' },
  { key: 'virgo', name: 'Virgo', glyph: '♍', element: 'earth', mode: 'mutable', ruler: 'Mercury', dates: 'Aug 23 – Sep 22' },
  { key: 'libra', name: 'Libra', glyph: '♎', element: 'air', mode: 'cardinal', ruler: 'Venus', dates: 'Sep 23 – Oct 22' },
  { key: 'scorpio', name: 'Scorpio', glyph: '♏', element: 'water', mode: 'fixed', ruler: 'Mars', dates: 'Oct 23 – Nov 21' },
  { key: 'sagittarius', name: 'Sagittarius', glyph: '♐', element: 'fire', mode: 'mutable', ruler: 'Jupiter', dates: 'Nov 22 – Dec 21' },
  { key: 'capricorn', name: 'Capricorn', glyph: '♑', element: 'earth', mode: 'cardinal', ruler: 'Saturn', dates: 'Dec 22 – Jan 19' },
  { key: 'aquarius', name: 'Aquarius', glyph: '♒', element: 'air', mode: 'fixed', ruler: 'Saturn', dates: 'Jan 20 – Feb 18' },
  { key: 'pisces', name: 'Pisces', glyph: '♓', element: 'water', mode: 'mutable', ruler: 'Jupiter', dates: 'Feb 19 – Mar 20' },
];
export const SIGN_BY_KEY = new Map(SIGNS.map((s, i) => [s.key, { ...s, index: i }]));

export const BODIES = [
  { key: 'Sun', glyph: '☉' }, { key: 'Moon', glyph: '☽' }, { key: 'Mercury', glyph: '☿' }, { key: 'Venus', glyph: '♀' },
  { key: 'Mars', glyph: '♂' }, { key: 'Jupiter', glyph: '♃' }, { key: 'Saturn', glyph: '♄' }, { key: 'Uranus', glyph: '♅' },
  { key: 'Neptune', glyph: '♆' }, { key: 'Pluto', glyph: '♇' },
];
const GLYPH = Object.fromEntries(BODIES.map(b => [b.key, b.glyph]));
const OUTER = new Set(['Uranus', 'Neptune', 'Pluto']);

export const ASPECTS = [
  { key: 'conjunction', angle: 0, glyph: '☌', tone: 0 },
  { key: 'sextile', angle: 60, glyph: '⚹', tone: 1 },
  { key: 'square', angle: 90, glyph: '□', tone: -1 },
  { key: 'trine', angle: 120, glyph: '△', tone: 1 },
  { key: 'opposition', angle: 180, glyph: '☍', tone: -1 },
];

const DAY = 86400000;
const norm = x => ((x % 360) + 360) % 360;
const signed = x => { x = norm(x); return x > 180 ? x - 360 : x; };
export const signIndex = lon => Math.floor(norm(lon) / 30) % 12;
const sep = (a, b) => Math.abs(signed(a - b));                  // 0..180

// geocentric ecliptic longitude (of date), degrees
export function longitude(body, ms) {
  const t = new Date(ms);
  if (body === 'Sun') return A.SunPosition(t).elon;
  if (body === 'Moon') return A.EclipticGeoMoon(t).lon;
  return A.Ecliptic(A.GeoVector(A.Body[body], t, true)).elon;
}

// degrees per day (negative = retrograde)
export function speed(body, ms) {
  const h = 6 * 3600000;
  return signed(longitude(body, ms + h) - longitude(body, ms - h)) * 2;
}

// the moment in [lo, hi] where f flips from its value at lo (f must change exactly once there)
function bisect(f, lo, hi, steps = 24) {
  const flo = f(lo);
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) === flo) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

const place = (body, lon) => {
  const i = signIndex(lon);
  return { body, glyph: GLYPH[body], lon: +norm(lon).toFixed(2), sign: SIGNS[i].key, signIndex: i, degree: Math.floor(norm(lon) % 30) };
};

/* ------------------------------------------------------- birthdays */

const natalCache = new Map();

// Where everything was on someone's birthday. We don't know their birth time or place, so: positions at noon UTC, and
// for anything that changed sign that day (the Moon often does), `alt` names the other possibility.
export function natal(birthdate) {
  if (natalCache.has(birthdate)) return natalCache.get(birthdate);
  const [y, m, d] = birthdate.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d), noon = start + DAY / 2, end = start + DAY - 1;
  const out = {};
  for (const b of ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const p = place(b, longitude(b, noon));
    const s0 = signIndex(longitude(b, start)), s1 = signIndex(longitude(b, end));
    if (s0 !== s1) p.alt = SIGNS[s0 === p.signIndex ? s1 : s0].key;
    out[b] = p;
  }
  if (natalCache.size > 5000) natalCache.clear();
  natalCache.set(birthdate, out);
  return out;
}

// the star sign for a birthday: { key, name, glyph, …, cusp? }
export function sunSign(birthdate) {
  const s = natal(birthdate).Sun;
  return { ...SIGN_BY_KEY.get(s.sign), cusp: s.alt || null };
}

/* ------------------------------------------------------- the sky */

const MOON_PHASES = [
  [22.5, 'new', 'New Moon', '🌑'], [67.5, 'waxing-crescent', 'Waxing Crescent', '🌒'], [112.5, 'first-quarter', 'First Quarter', '🌓'],
  [157.5, 'waxing-gibbous', 'Waxing Gibbous', '🌔'], [202.5, 'full', 'Full Moon', '🌕'], [247.5, 'waning-gibbous', 'Waning Gibbous', '🌖'],
  [292.5, 'last-quarter', 'Last Quarter', '🌗'], [337.5, 'waning-crescent', 'Waning Crescent', '🌘'], [360.1, 'new', 'New Moon', '🌑'],
];
const QUARTER_NAMES = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];

const skyCache = new Map();

// Everything about one local day: start = local midnight (ms UTC), end = the next local midnight.
export function sky(start, end) {
  const key = `${start}:${end}`;
  if (skyCache.has(key)) return skyCache.get(key);
  const mid = Math.round((start + end) / 2);

  const planets = BODIES.map(({ key: b }) => {
    const lon0 = longitude(b, start), lon1 = longitude(b, end - 1), lon = longitude(b, mid);
    const p = place(b, lon);
    const v0 = speed(b, start), v1 = speed(b, end - 1), v = speed(b, mid);
    p.speed = +v.toFixed(3);
    p.retrograde = b !== 'Sun' && b !== 'Moon' && v < 0;
    if (signIndex(lon0) !== signIndex(lon1)) {
      const at = bisect(t => signIndex(longitude(b, t)), start, end - 1);
      p.ingress = { from: SIGNS[signIndex(lon0)].key, to: SIGNS[signIndex(lon1)].key, at };
    }
    if (b !== 'Sun' && b !== 'Moon' && Math.sign(v0) !== Math.sign(v1)) {
      p.station = { turns: v1 < 0 ? 'retrograde' : 'direct', at: bisect(t => Math.sign(speed(b, t)), start, end - 1) };
    }
    if (p.retrograde) p.directOn = nextDirect(b, mid);
    return p;
  });
  const at = Object.fromEntries(planets.map(p => [p.body, p]));

  // the Moon: phase angle (0 new → 180 full), how lit, and any exact quarter today
  const angle = A.MoonPhase(new Date(mid));
  const [, phaseKey, phaseName, phaseEmoji] = MOON_PHASES.find(([lim]) => angle < lim);
  let event = null;
  const q = A.SearchMoonQuarter(new Date(start));
  if (q && +q.time.date < end) event = { name: QUARTER_NAMES[q.quarter], at: +q.time.date, sign: SIGNS[signIndex(longitude('Moon', +q.time.date))].key };
  const moon = {
    phase: phaseKey, name: phaseName, emoji: phaseEmoji, angle: +angle.toFixed(1),
    illumination: Math.round(A.Illumination(A.Body.Moon, new Date(mid)).phase_fraction * 100),
    waxing: angle < 180, sign: at.Moon.sign, event,
  };

  // aspects: exact some time today, or (for the slower planets) close enough to be felt all day
  const aspects = [];
  for (let i = 0; i < BODIES.length; i++) {
    for (let j = i + 1; j < BODIES.length; j++) {
      const a = BODIES[i].key, b = BODIES[j].key;
      const withMoon = a === 'Moon' || b === 'Moon';
      const outerPair = OUTER.has(a) && OUTER.has(b);
      if (outerPair) continue;                                   // generational: in effect for years
      const s0 = sep(longitude(a, start), longitude(b, start));
      const s1 = sep(longitude(a, end - 1), longitude(b, end - 1));
      const sm = sep(at[a].lon, at[b].lon);
      for (const asp of ASPECTS) {
        const d0 = s0 - asp.angle, d1 = s1 - asp.angle;
        const crosses = Math.sign(d0) !== Math.sign(d1) && Math.abs(d0) < 20 && Math.abs(d1) < 20;
        const orb = Math.abs(sm - asp.angle);
        const limit = withMoon ? 0 : (a === 'Sun' || b === 'Sun') ? 2 : 2.5;
        if (!crosses && orb > limit) continue;
        const item = { a, b, aspect: asp.key, glyph: asp.glyph, tone: asp.tone, orb: +orb.toFixed(2), exactToday: crosses };
        if (crosses) item.at = bisect(t => Math.sign(sep(longitude(a, t), longitude(b, t)) - asp.angle), start, end - 1);
        aspects.push(item);
      }
    }
  }
  // exact today first, then the tightest; the Moon's quick daily aspects after the planets'
  aspects.sort((x, y) => (y.exactToday - x.exactToday) || ((x.a === 'Moon') - (y.a === 'Moon')) || (x.orb - y.orb));

  const result = { start, end, planets, moon, aspects };
  if (skyCache.size > 400) skyCache.clear();
  skyCache.set(key, result);
  return result;
}

// when a retrograde planet turns direct again (to the day), searching up to ~7 months ahead
function nextDirect(body, from) {
  const step = OUTER.has(body) ? 3 * DAY : DAY;
  for (let t = from; t < from + 220 * DAY; t += step) {
    if (speed(body, t) > 0) return bisect(x => Math.sign(speed(body, x)), t - step, t, 16);
  }
  return null;
}

// One local day from the page's own clock: date = 'YYYY-MM-DD' (its calendar), tz = getTimezoneOffset() minutes.
// Anything implausible (more than two days from now, an impossible offset) falls back to the UTC day.
export function localDay(dateStr, tzMin, now = Date.now()) {
  let tz = Number.parseInt(tzMin, 10);
  if (!Number.isFinite(tz) || tz < -840 || tz > 840) tz = 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  const pick = () => {
    const t = new Date(now - tz * 60000);
    y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
  };
  if (!m) pick();
  let start = Date.UTC(y, mo - 1, d) + tz * 60000;
  if (!Number.isFinite(start) || Math.abs(start + DAY / 2 - now) > 2.5 * DAY) { pick(); start = Date.UTC(y, mo - 1, d) + tz * 60000; }
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date, start, end: start + DAY, tz };
}
