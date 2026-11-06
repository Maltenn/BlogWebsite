/* pages/horoscope.js — the daily horoscope, your birth chart and today's sky. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, clock, dayName, today } from '../core/format.js';
import { pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';

const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

function readingCard(r, { personal = false } = {}) {
  const card = h('div', { class: 'horo-card' },
    h('div', { class: 'horo-head' }, h('span', { class: 'horo-glyph', text: r.sign.glyph }),
      h('div', null, h('div', { class: 'horo-sign', text: `${r.sign.name}${personal ? ' — your daily reading' : ''}` }),
        h('div', { class: 'horo-sub', text: `${dayName(Date.now())} · ${r.sign.dates} · ${r.sign.element} sign, ruled by ${r.sign.ruler}` }),
        h('div', { class: 'horo-headline', text: r.headline }))));
  r.paragraphs.forEach(p => card.append(h('p', { text: p })));
  if (r.transits && r.transits.length) {
    card.append(h('div', { class: 'horo-subhead', text: '✨ today\'s planets meet your birth chart' }),
      h('ul', { class: 'horo-transits' }, r.transits.map(t => h('li', { class: t.tone > 0 ? 'soft' : t.tone < 0 ? 'hard' : '', text: t.text }))));
  }
  card.append(h('table', { class: 'horo-ratings' }, Object.entries(r.ratings).map(([k, v]) => h('tr', null, h('td', { text: k }), h('td', { class: 'horo-stars', text: stars(v), 'aria-label': `${v} out of 5` })))),
    h('div', { class: 'horo-dos' }, h('div', { text: '✅ ' + r.do }), h('div', { text: '❌ ' + r.avoid })),
    h('div', { class: 'horo-lucky', text: `lucky number ${r.lucky.number} · lucky color ${r.lucky.color} · lucky time ${r.lucky.time}` }));
  return card;
}

function skyCard(d) {
  const s = d.sky;
  const sign = k => d.signs.find(x => x.key === k);
  const card = h('div', { class: 'horo-card horo-sky' },
    h('div', { class: 'horo-head' }, h('span', { class: 'horo-glyph', text: s.moon.emoji }),
      h('div', null, h('div', { class: 'horo-sign', text: 'The sky today' }),
        h('div', { class: 'horo-sub', text: `${dayName(Date.now())} · ${s.moon.name}, ${s.moon.illumination}% lit · worked out from where the planets really are` }))));
  card.append(h('ul', { class: 'horo-summary' }, d.summary.map(l => h('li', null,
    l.text,
    l.at ? h('span', { class: 'ms-time', text: ` (${clock(l.at)})` }) : null,
    l.until ? h('span', { class: 'ms-time', text: ` — until ${when(l.until).split(' ').slice(0, 3).join(' ')}` }) : null))));
  card.append(h('table', { class: 'horo-planets' },
    h('tr', null, h('th', { text: 'planet' }), h('th', { text: 'sign' }), h('th', { text: 'today' })),
    s.planets.map(p => h('tr', null,
      h('td', null, h('span', { class: 'horo-pglyph', text: p.glyph }), ' ', p.body),
      h('td', { text: `${sign(p.sign).glyph} ${sign(p.sign).name} ${p.degree}°` }),
      h('td', { class: 'horo-flag', text: [p.retrograde ? 'retrograde ℞' : '', p.ingress ? `entered ${sign(p.ingress.to).name} at ${clock(p.ingress.at)}` : '', p.station ? `turns ${p.station.turns} at ${clock(p.station.at)}` : ''].filter(Boolean).join(' · ') })))));
  return card;
}

function signPicker(signs, current) {
  return h('div', { class: 'horo-picker' }, signs.map(sg => h('a', {
    class: 'horo-pick' + (sg.key === current ? ' on' : ''), href: '/horoscope/' + sg.key, title: `${sg.name} (${sg.dates})`,
  }, h('span', { class: 'horo-pick-glyph', text: sg.glyph }), sg.name)));
}

export async function renderHoroscope(root, signKey) {
  root.append(pageTitle('🔮 Daily Horoscope'));
  const sky = await api.get('/astro/sky?' + today());
  const mine = S.me && S.me.sign.key;
  const showing = signKey || mine || null;
  const name = k => sky.signs.find(x => x.key === k).name;
  const wrap = h('div', { class: 'horo-page' });
  wrap.append(signPicker(sky.signs, showing));
  if (S.me && (!signKey || signKey === mine)) {
    const r = await api.get('/astro/me?' + today());
    wrap.append(readingCard(r.reading, { personal: true }));
    wrap.append(h('div', { class: 'horo-card horo-chart' },
      h('div', { class: 'horo-subhead', text: '🪐 your birth chart (from your birthday)' }),
      h('div', { class: 'horo-chartrow' }, r.chart.map(p => h('span', { class: 'horo-chip' },
        h('b', { text: `${p.glyph} ${p.body}` }), ` ${name(p.sign)}`, p.alt ? h('span', { class: 'horo-alt', text: ` or ${name(p.alt)}` }) : null))),
      h('p', { class: 'os-hint', text: 'without your birth time we place everything at noon. anything that changed signs that day (the Moon often does) shows both options' + (r.cusp ? `. you were born on the cusp: your Sun could be in ${name(r.cusp)} if you were born at the other end of the day.` : '.') })));
  } else if (showing) {
    const r = await api.get(`/astro/sign/${showing}?` + today());
    wrap.append(readingCard(r.reading));
    if (!S.me) wrap.append(h('p', { class: 'ms-note', text: 'make a page and your horoscope gets personal: we read today\'s planets against the sky on the day you were born.' }));
  } else {
    wrap.append(h('p', { class: 'ms-note', text: 'pick your sign above for today\'s horoscope, or make a page and we\'ll work it out from your birthday.' }));
  }
  wrap.append(skyCard(sky));
  root.append(wrap);
}
