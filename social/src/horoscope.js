// Daily astrology, written from the real sky (astro.js):
//   GET /api/astro/sky?date=&tz=        the sky today, for everybody: positions, Moon phase, retrogrades, sign changes,
//                                       aspects, and a plain-language summary
//   GET /api/astro/sign/:sign?date=&tz= today's horoscope for one sign
//   GET /api/astro/me?date=&tz=         your personal reading: your sign's horoscope plus today's planets against the
//                                       sky on the day you were born (Moon, Mercury, Venus, Mars…)
// Readings use "solar houses" (whole signs counted from the person's Sun sign), the method newspaper horoscopes use,
// so the same sky reads differently for every sign. A reading is seeded by date + sign (+ person), so it stays the
// same all day. `date` and `tz` come from the page's clock: the day is the reader's own local day.
import { fail, json } from './http.js';
import { SIGNS, SIGN_BY_KEY, natal as natalOf, sky as skyOf, localDay, ASPECTS, sunSign } from './astro.js';

/* ---------------------------------------------------------- the words */

// noun: what the house covers (fits "… about ___"), short: "today is about ___", zone: "your ___ zone"
const HOUSES = [null,
  { noun: 'your image and how you come across', short: 'you', zone: 'self' },
  { noun: 'money, your stuff and what you value', short: 'money', zone: 'money' },
  { noun: 'texts, calls, siblings and your neighborhood', short: 'talking', zone: 'communication' },
  { noun: 'home, family and your comfort zone', short: 'home', zone: 'home' },
  { noun: 'fun, crushes, hobbies and creative projects', short: 'fun & romance', zone: 'romance' },
  { noun: 'routines, chores, work and your health', short: 'your routine', zone: 'routine' },
  { noun: 'partners, best friends and one-on-one time', short: 'your people', zone: 'partnership' },
  { noun: 'trust, shared things, secrets and deep talks', short: 'the deep stuff', zone: 'intimacy' },
  { noun: 'learning, travel, beliefs and big ideas', short: 'big ideas', zone: 'adventure' },
  { noun: 'school, work, goals and your reputation', short: 'your goals', zone: 'career' },
  { noun: 'friends, groups, online life and future plans', short: 'friends', zone: 'friendship' },
  { noun: 'rest, dreams, alone time and letting go', short: 'rest', zone: 'rest' },
];

// where the Moon is, counted from your sign: today's emotional weather
const MOON_DAY = [null,
  'The Moon is in your sign today, so your feelings sit right on the surface. You\'re more noticeable than usual — dress for it.',
  'Today\'s mood is tied to comfort and security. A small treat helps more than a big purchase.',
  'Your mind is busy and so is your inbox. Answer the message you\'ve been putting off.',
  'You\'ll want to nest today. Home, family and familiar things recharge you.',
  'A playful, flirty, creative kind of day. Make something, or make plans with someone you like.',
  'A good day to get organized. Knock out one annoying task and you\'ll feel lighter by tonight.',
  'Other people take center stage. One-on-one time matters more than the group chat today.',
  'Feelings run deep today. A real conversation beats small talk, and a secret might slip out.',
  'Restless? Feed it. Learn something, plan a trip, or wander somewhere you\'ve never been.',
  'Eyes on your goals. Someone in charge is paying attention, so show up and show off a little.',
  'Your friends are your medicine today. Say yes to the group plan.',
  'Low-battery day. Rest, journal, sleep in if you can: your intuition is louder when it\'s quiet.',
];

// where the Sun is, counted from your sign: the theme of the month
const SUN_MONTH = [null,
  'It\'s your season: birthday energy. Start things, change your look, put yourself first.',
  'This month is about money and self-worth. Know what you\'re worth and act like it.',
  'This month, words are power. Write, message, pitch, learn.',
  'This month pulls you home. Family stuff and your space need some love.',
  'This month is your fun season: romance, hobbies, and showing off what you\'re good at.',
  'This month is for getting your life together. Habits, health, the boring stuff that pays off.',
  'This month is about partnerships. Who you team up with now matters.',
  'This month goes deep: trust, shared stuff, and letting go of what\'s done.',
  'This month wants adventure and big ideas. Say yes to learning something new.',
  'This month is goals season. Your hard work gets noticed.',
  'This month is social: friends, groups, and dreaming up what\'s next.',
  'This month is a quiet recharge before your birthday season. Rest and wrap things up.',
];

const PLANET_IN_HOUSE = {
  Mercury: n => `Mercury has your mind on ${n}. Talk it through, write it down, make a plan.`,
  Venus: n => `Venus is making ${n} sweeter right now. Lead with charm.`,
  Mars: n => `Mars lights a fire under ${n}. Go after it, just watch the temper.`,
  Jupiter: n => `Jupiter is growing ${n} this year. Say yes to the openings.`,
  Saturn: n => `Saturn wants you to get serious about ${n}. Slow and steady wins.`,
};
const PLANET_RX_IN_HOUSE = {
  Mercury: n => `Mercury is retrograde, so re-read, re-check and re-think anything to do with ${n}. Old friends may resurface.`,
  Venus: n => `Venus is retrograde: revisit old feelings about ${n} before you start anything new. Not the week for a drastic haircut.`,
  Mars: n => `Mars is retrograde: if ${n} feels stuck, rethink the plan instead of pushing harder.`,
};

const PHASE = {
  new: 'New Moon energy: a clean slate. Set one intention tonight.',
  'waxing-crescent': 'The Moon is growing, and so is your momentum. Take the first small step.',
  'first-quarter': 'First Quarter Moon: a little friction tests your plans. Push through it.',
  'waxing-gibbous': 'The Moon is almost full: refine, polish, adjust. You\'re close.',
  full: 'Full Moon: emotions peak and things come to light. Celebrate what\'s finished.',
  'waning-gibbous': 'Just past full: share what you\'ve learned and say thank you.',
  'last-quarter': 'Last Quarter Moon: let go of what isn\'t working. Clear some space.',
  'waning-crescent': 'The Moon is fading toward new. Rest, reflect, recharge.',
};

const MOON_IN_SIGN = {
  aries: 'quick tempers and quick starts. Act on your gut.',
  taurus: 'slow down and enjoy the good snacks. Comfort is the theme.',
  gemini: 'chatty, curious and easily distracted. Great for catching up.',
  cancer: 'soft, sentimental, a little homesick. Call someone who feels like home.',
  leo: 'everyone wants to be seen. Compliments go a long way.',
  virgo: 'tidy up, fix something, make a list.',
  libra: 'harmony and good manners matter. Skip the drama.',
  scorpio: 'intense feelings and private thoughts. Trust is everything.',
  sagittarius: 'restless and optimistic. Go somewhere, learn something.',
  capricorn: 'serious, focused, productive. Get the hard thing done.',
  aquarius: 'friends, causes and weird ideas. Be your odd self.',
  pisces: 'dreamy, sensitive and artsy. Music hits harder today.',
};

const SUN_IN_SIGN = {
  aries: 'fresh starts and bold moves', taurus: 'building something steady and enjoying the slow stuff', gemini: 'talking, learning and connecting',
  cancer: 'home, family and feelings', leo: 'shining, creating and having fun', virgo: 'organizing your life and helping where you can',
  libra: 'balance, beauty and relationships', scorpio: 'going deep, getting real and transforming', sagittarius: 'adventure, honesty and big-picture thinking',
  capricorn: 'goals, discipline and long-term plans', aquarius: 'friendship, ideas and doing it your own way', pisces: 'dreams, empathy and endings before the zodiac starts over',
};

const SIGN_TONE = {
  aries: 'bold, impatient', taurus: 'steady, comfort-loving', gemini: 'chatty, curious', cancer: 'tender, protective', leo: 'warm, dramatic',
  virgo: 'practical, detail-minded', libra: 'charming, fair-minded', scorpio: 'intense, private', sagittarius: 'adventurous, blunt',
  capricorn: 'ambitious, serious', aquarius: 'quirky, independent', pisces: 'dreamy, sensitive',
};

const THEMES = {
  Sun: 'your mood', Moon: 'feelings', Mercury: 'communication', Venus: 'love', Mars: 'drive', Jupiter: 'luck',
  Saturn: 'responsibility', Uranus: 'surprises', Neptune: 'dreams', Pluto: 'transformation',
};
const an = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
const cap1 = s => s[0].toUpperCase() + s.slice(1);

const RETRO = {
  Mercury: 'double-check plans, back up your files, re-read before you send. Exes and old friends tend to text.',
  Venus: 'old feelings resurface. Rethink what (and who) you really value.',
  Mars: 'energy turns inward. Revise the plan instead of forcing it.',
  Jupiter: 'growth happens on the inside. Reflect on what luck means to you.',
  Saturn: 'review your commitments and fix the foundations.',
  Uranus: 'quiet rebellion. Changes brew under the surface.',
  Neptune: 'the fog lifts a little. See people as they really are.',
  Pluto: 'inner transformation. Let go of what you\'ve outgrown.',
};

const ASPECT_VERB = { conjunction: 'meets', sextile: 'gives a friendly nod to', square: 'squares off with', trine: 'flows easily with', opposition: 'faces off against' };
const ASPECT_MEANING = {
  conjunction: 'merge into one strong theme',
  sextile: 'open a small, easy door. Knock on it',
  square: 'pull against each other. Friction now, progress later',
  trine: 'cooperate, so things in these areas come easily',
  opposition: 'want opposite things. Look for the middle ground',
};

// today's planets touching the sky you were born under
const TRANSIT_VERB = {
  0: { Sun: 'turns the spotlight on', Moon: 'makes you extra aware of', Mercury: 'gets you thinking about', Venus: 'adds charm to', Mars: 'charges up', Jupiter: 'expands', Saturn: 'gets serious with' },
  1: { Sun: 'shines a warm light on', Moon: 'softens', Mercury: 'finds the right words for', Venus: 'sweetens', Mars: 'gives a boost to', Jupiter: 'brings luck to', Saturn: 'steadies' },
  '-1': { Sun: 'puts pressure on', Moon: 'stirs up', Mercury: 'scrambles', Venus: 'tests', Mars: 'picks a fight with', Jupiter: 'overinflates', Saturn: 'puts limits on' },
};
const NATAL_OBJ = { Sun: 'your sense of who you are', Moon: 'your feelings', Mercury: 'how you think and talk', Venus: 'your love life and friendships', Mars: 'your drive', Jupiter: 'your optimism', Saturn: 'your sense of duty' };
const ADVICE = {
  0: ['Notice what this stirs up.', 'Pay attention to this theme today.', 'This one\'s about you. Own it.'],
  1: ['Use it while it lasts.', 'Say yes to what comes easily.', 'A good day to ask for something.'],
  '-1': ['Breathe before you hit send.', 'Friction now, growth later.', 'Pick your battles.'],
};

const DO = [null,
  'try a new look, a new picture, a new font on your page.',
  'look at your budget. Just look at it.',
  'message the friend you keep meaning to message.',
  'clean your room, cook something, call home.',
  'make something just for fun: a playlist, a drawing, a layout.',
  'do the chore you keep dodging. Drink some water.',
  'plan one-on-one time with someone who matters.',
  'have the real conversation. Ask the real question.',
  'read, watch or listen to something that teaches you something.',
  'work on the thing that would impress future you.',
  'say yes to the group plan. Update your Top 8.',
  'go to bed early and write down your dreams.',
];
const AVOID_BY_PLANET = {
  Mercury: 'sending the message before you re-read it.', Venus: 'impulse buys and impulse crushes.', Mars: 'arguing in the comments.',
  Saturn: 'saying yes to everything.', Jupiter: 'promising more than you can deliver.', Moon: 'taking things personally.',
  Sun: 'needing to win every argument.',
};
const AVOID = ['checking who looked at your page.', 'the 2 AM overthinking spiral.', 'starting drama on someone\'s wall.',
  'comparing your Top 8 to anybody else\'s.', 'skipping breakfast.', 'reading old messages for clues.'];
const COLORS = ['hot pink', 'lime green', 'electric blue', 'glitter silver', 'black (obviously)', 'tangerine', 'lavender', 'teal',
  'cherry red', 'sunshine yellow', 'mint', 'cobalt', 'bubblegum', 'midnight purple'];
const MOODS = { good: ['sparkly', 'lucky', 'on a roll', 'golden', 'magnetic'], mid: ['steady', 'curious', 'thoughtful', 'easygoing'], hard: ['complicated', 'touchy', 'stormy but survivable', 'a lot'] };

/* ------------------------------------------------------- the writing */

function rng(seedText) {
  let a = 2166136261;
  for (let i = 0; i < seedText.length; i++) a = Math.imul(a ^ seedText.charCodeAt(i), 16777619);
  return () => {                                           // mulberry32
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const houseOf = (signIdx, p) => ((p.signIndex - signIdx + 12) % 12) + 1;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sign = k => SIGN_BY_KEY.get(k);

// today's planets against the positions on someone's birthday
function transitsFor(n, s) {
  const out = [];
  const bySky = Object.fromEntries(s.planets.map(p => [p.body, p]));
  const lonAt = (body, t) => { const p = bySky[body]; return p.lon + p.speed * (t - (s.start + s.end) / 2) / 86400000; };
  for (const T of ['Moon', 'Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    for (const N of ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars']) {
      if (N === 'Moon' && n.Moon.alt) continue;              // we don't know their birth Moon well enough
      const natalLon = n[N].lon;
      const d = t => Math.abs((((lonAt(T, t) - natalLon) % 360) + 540) % 360 - 180);
      for (const asp of ASPECTS) {
        const mid = d((s.start + s.end) / 2) - asp.angle;
        let hit;
        if (T === 'Moon') {
          const a0 = d(s.start) - asp.angle, a1 = d(s.end) - asp.angle;
          hit = Math.sign(a0) !== Math.sign(a1) && Math.abs(a0) < 20;
        } else hit = Math.abs(mid) <= 1.5;
        if (hit) out.push({ transit: T, natal: N, aspect: asp.key, glyph: asp.glyph, tone: asp.tone, orb: +Math.abs(mid).toFixed(2) });
      }
    }
  }
  // the slow planets matter most, then the closest
  const weight = { Saturn: 0, Jupiter: 1, Mars: 2, Venus: 3, Sun: 4, Mercury: 5, Moon: 6 };
  return out.sort((x, y) => (weight[x.transit] - weight[y.transit]) || (x.orb - y.orb));
}

// The horoscope for one sign on one day. With `natal` (a person's birth placements) it becomes their personal reading.
function reading({ signKey, s, date, natal = null, seed, birthday = false }) {
  const me = sign(signKey);
  const r = rng(`${seed}|${date}|${signKey}`);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const P = Object.fromEntries(s.planets.map(p => [p.body, p]));
  const house = body => houseOf(me.index, P[body]);
  const paragraphs = [];

  if (birthday) paragraphs.push(`Happy birthday! 🎂 The Sun is back where it was the day you were born, which makes today the start of your personal new year. Make a wish you'd actually tell someone about.`);

  // 1. the Moon: today's mood
  const mh = house('Moon');
  let moonText = MOON_DAY[mh] + ' ' + PHASE[s.moon.phase];
  if (P.Moon.ingress) {
    const nh = ((sign(P.Moon.ingress.to).index - me.index + 12) % 12) + 1;
    moonText += ` Later today the Moon moves into ${sign(P.Moon.ingress.to).name}, and your focus shifts to ${HOUSES[nh].short}.`;
  }
  paragraphs.push(moonText);

  // 2. the month (the Sun) and one personal planet (whichever is doing something today)
  const sh = house('Sun');
  const candidates = ['Mercury', 'Venus', 'Mars'];
  const busy = candidates.find(b => P[b].ingress || P[b].station) || candidates.find(b => P[b].retrograde) || pick(candidates);
  const bh = house(busy);
  const planetLine = (P[busy].retrograde && PLANET_RX_IN_HOUSE[busy]) ? PLANET_RX_IN_HOUSE[busy](HOUSES[bh].noun) : PLANET_IN_HOUSE[busy](HOUSES[bh].noun);
  paragraphs.push(`${SUN_MONTH[sh]} ${planetLine}`);

  // 3. what the sky's aspects mean for this sign: ones touching its angles (houses 1, 4, 7, 10) or its ruling planet
  const touches = a => [a.a, a.b].some(b => b === me.ruler || [1, 4, 7, 10].includes(house(b)));
  const skyAsp = s.aspects.filter(a => a.a !== 'Moon' && a.b !== 'Moon' && touches(a)).slice(0, 2);
  for (const a of skyAsp) {
    const ha = house(a.a), hb = house(a.b);
    const where = ha === hb ? `in your ${HOUSES[ha].zone} zone` : `connecting your ${HOUSES[ha].zone} and ${HOUSES[hb].zone} zones`;
    paragraphs.push(`${a.a} ${ASPECT_VERB[a.aspect]} ${a.b} today, ${where}: ${THEMES[a.a]} and ${THEMES[a.b]} ${ASPECT_MEANING[a.aspect]}.`);
  }

  // 4. personal: today's planets against the sky on the day you were born
  let transits = [];
  if (natal) {
    transits = transitsFor(natal, s).slice(0, 4).map(t => ({
      ...t,
      text: `${t.transit} ${TRANSIT_VERB[t.tone][t.transit]} ${NATAL_OBJ[t.natal]} (today's ${t.transit} ${t.glyph} your birth ${t.natal}). ${pick(ADVICE[t.tone])}`,
    }));
  }

  // ratings: start in the middle, nudge for what's happening, a little luck
  const hard = skyAsp.filter(a => a.tone < 0).length + transits.filter(t => t.tone < 0).length;
  const soft = skyAsp.filter(a => a.tone > 0).length + transits.filter(t => t.tone > 0).length;
  const involves = (b, list) => list.filter(x => x.a === b || x.b === b || x.transit === b || x.natal === b);
  const toneOf = (b) => [...involves(b, skyAsp), ...involves(b, transits)].reduce((n, x) => n + x.tone, 0);
  const jitter = () => (r() < 0.35 ? (r() < 0.5 ? -1 : 1) : 0);
  const ratings = {
    love: clamp(3 + ([5, 7].includes(house('Venus')) || [5, 7].includes(mh) ? 1 : 0) + toneOf('Venus') - (P.Venus.retrograde ? 1 : 0) + jitter(), 1, 5),
    friends: clamp(3 + ([3, 11].includes(mh) ? 1 : 0) + toneOf('Mercury') + jitter(), 1, 5),
    work: clamp(3 + ([6, 10].includes(mh) || [6, 10].includes(sh) ? 1 : 0) + toneOf('Saturn') + toneOf('Jupiter') - (P.Mercury.retrograde ? 1 : 0) + jitter(), 1, 5),
    energy: clamp(3 + toneOf('Mars') + (s.moon.waxing ? 1 : 0) - (s.moon.phase === 'waning-crescent' ? 1 : 0) + jitter(), 1, 5),
  };
  const mood = pick(soft > hard ? MOODS.good : hard > soft ? MOODS.hard : MOODS.mid);
  const roughest = [...transits, ...skyAsp].find(x => x.tone < 0);
  const avoidPlanet = roughest && (roughest.transit || (AVOID_BY_PLANET[roughest.a] ? roughest.a : roughest.b));
  const hourNum = 7 + Math.floor(r() * 17);

  return {
    sign: { key: me.key, name: me.name, glyph: me.glyph, element: me.element, dates: me.dates, ruler: me.ruler },
    date,
    headline: `${mood} — today is about ${HOUSES[mh].short}`,
    focus: { house: mh, area: HOUSES[mh].noun },
    paragraphs,
    transits,
    ratings,
    do: 'Do: ' + DO[mh],
    avoid: 'Avoid: ' + ((avoidPlanet && AVOID_BY_PLANET[avoidPlanet]) || pick(AVOID)),
    lucky: { number: 1 + Math.floor(r() * 88), color: pick(COLORS), time: `around ${hourNum % 12 || 12} ${hourNum < 12 ? 'AM' : 'PM'}` },
  };
}

// the sky, explained in plain words, for everyone
function skySummary(s) {
  const P = Object.fromEntries(s.planets.map(p => [p.body, p]));
  const lines = [];
  const m = s.moon;
  lines.push({ kind: 'moon', text: `The Moon is ${m.name.toLowerCase()} (${m.illumination}% lit) in ${sign(m.sign).name}: ${MOON_IN_SIGN[m.sign]}` });
  if (m.event) lines.push({ kind: 'event', at: m.event.at, text: `${m.event.name} in ${sign(m.event.sign).name} today. ${PHASE[{ 'New Moon': 'new', 'First Quarter': 'first-quarter', 'Full Moon': 'full', 'Last Quarter': 'last-quarter' }[m.event.name]]}` });
  lines.push({ kind: 'sun', text: `The Sun is in ${sign(P.Sun.sign).name}: a season of ${SUN_IN_SIGN[P.Sun.sign]}.` });
  for (const p of s.planets) {
    if (p.ingress && p.body !== 'Moon') {
      lines.push({ kind: 'ingress', at: p.ingress.at, text: `${p.body} moves into ${sign(p.ingress.to).name} today, giving ${THEMES[p.body]} ${an(SIGN_TONE[p.ingress.to])} edge.` });
    }
    if (p.station) {
      lines.push({ kind: 'station', at: p.station.at, text: p.station.turns === 'retrograde'
        ? `${p.body} turns retrograde today: ${RETRO[p.body]}`
        : `${p.body} turns direct today. Whatever stalled while it was retrograde starts moving again.` });
    }
  }
  for (const p of s.planets.filter(x => x.retrograde && !x.station)) {
    lines.push({ kind: 'retrograde', until: p.directOn, body: p.body, text: `${p.body} is retrograde in ${sign(p.sign).name}: ${RETRO[p.body]}` });
  }
  for (const a of s.aspects.slice(0, 5)) {
    lines.push({ kind: 'aspect', at: a.at || null, text: `${a.a} ${ASPECT_VERB[a.aspect]} ${a.b}: ${cap1(THEMES[a.a])} and ${THEMES[a.b]} ${ASPECT_MEANING[a.aspect]}.` });
  }
  return lines;
}

/* ------------------------------------------------------------- routes */

const dayOf = c => localDay(c.url.searchParams.get('date'), c.url.searchParams.get('tz'), c.now);
const publicSky = s => ({
  planets: s.planets.map(({ body, glyph, sign: sg, degree, retrograde, ingress, station, directOn }) => ({ body, glyph, sign: sg, degree, retrograde, ingress, station, directOn })),
  moon: s.moon,
  aspects: s.aspects.slice(0, 10).map(({ a, b, aspect, glyph, orb, exactToday, at }) => ({ a, b, aspect, glyph, orb, exactToday, at: at || null })),
});

export async function astroSky(c) {
  const d = dayOf(c);
  const s = skyOf(d.start, d.end);
  return json({ date: d.date, sky: publicSky(s), summary: skySummary(s), signs: SIGNS.map(({ key, name, glyph, dates, element }) => ({ key, name, glyph, dates, element })) },
    200, { 'Cache-Control': 'private, max-age=600' });
}

export async function astroSign(c) {
  const k = String(c.params.sign || '').toLowerCase();
  if (!SIGN_BY_KEY.has(k)) fail(404, 'that\'s not one of the twelve signs.');
  const d = dayOf(c);
  const s = skyOf(d.start, d.end);
  return json({ reading: reading({ signKey: k, s, date: d.date, seed: 'sign' }) }, 200, { 'Cache-Control': 'private, max-age=600' });
}

export async function astroMe(c) {
  const d = dayOf(c);
  const s = skyOf(d.start, d.end);
  const n = natalOf(c.user.birthdate);
  const sun = sunSign(c.user.birthdate);
  const birthday = c.user.birthdate.slice(5) === d.date.slice(5);
  const r = reading({ signKey: sun.key, s, date: d.date, natal: n, seed: 'me:' + c.user.id, birthday });
  return json({
    reading: r,
    chart: ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].map(b => ({
      body: b, glyph: n[b].glyph, sign: n[b].sign, alt: n[b].alt || null, degree: n[b].degree,
    })),
    cusp: sun.cusp,
  });
}

