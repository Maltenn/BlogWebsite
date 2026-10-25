/* pages/home.js — Home: the welcome box (or today's horoscope), your status and the feed. */

import { h, enc, userPath, poss } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, today } from '../core/format.js';
import { oops, pageTitle, paged } from '../core/ui.js';
import { S } from '../core/state.js';
import { route } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { postActions } from '../widgets/safety.js';

function feedLine(item) {
  const a = item.author, t = item.target;
  const head = h('div', null, nameLink(a));
  let text = null;
  if (item.kind === 'status') { head.append(' updated their status'); text = item.body; }
  else if (item.kind === 'wall') { head.append(' ➜ ', t ? h('a', { class: 'ms-name-link', href: userPath(t.name), text: poss(t.name) + ' wall' }) : 'a wall'); text = item.body; }
  else if (item.kind === 'bulletin') { head.append(' posted a bulletin'); text = h('span', null, h('a', { class: 'ms-feedsubject', href: '/bulletins', text: item.subject }), ' — ', item.body); }
  else if (item.kind === 'blog') { head.append(' wrote a blog entry'); text = h('span', null, h('a', { class: 'ms-feedsubject', href: userPath(a.name) + '/blog', text: item.subject }), ' — ', item.body); }
  else if (item.kind === 'friends') { head.append(' and ', t ? nameLink(t) : 'someone', ' are now friends!'); }
  else if (item.kind === 'joined') { head.append(' joined OurSpace! go say hi ★'); }
  const row = h('div', { class: 'ms-feeditem' },
    avatar(a, 40),
    h('div', { class: 'ms-feedmid' }, head, text != null ? h('div', { class: 'ms-feedtext' }, text) : null,
      h('div', null, h('span', { class: 'ms-time', text: when(item.created) }), postActions(item, () => row.remove()))));
  return row;
}

// today's reading in one box, at the top of Home
async function horoscopeTeaser(root) {
  const text = h('span', { class: 'horo-teaser-text', text: 'reading the stars…' });
  const box = h('a', { class: 'horo-teaser', href: '/horoscope' }, h('span', { class: 'horo-teaser-glyph', text: S.me.sign.glyph }),
    h('span', null, h('b', { text: `today for ${S.me.sign.name}: ` }), text));
  root.append(box);
  try {
    const r = await api.get('/astro/me?' + today());
    text.textContent = `${r.reading.headline}. ${r.reading.paragraphs[0].split('. ')[0].replace(/\.$/, '')}. [read more]`;
  } catch { box.remove(); }
}

let feedScope = 'all';
export async function renderHome(root) {
  if (!S.me) {
    root.append(h('div', { class: 'ms-welcome' },
      h('img', { src: '/assets/deco_welcome_banner.gif', alt: 'welcome', height: 70 }),
      h('div', null,
        h('h1', { text: 'welcome to ourspace.' }),
        h('p', { text: 'a place for friends. make a page, decorate it like it\'s 2006 (glitter is encouraged), show off your Spotify top songs, check your daily horoscope, write on walls and actually talk to people. everyone here is a real person.' }),
        h('a', { class: 'btn98 go', href: '/join', text: '★ make your page' }), h('a', { class: 'btn98', href: '/login', text: 'log in' }), h('a', { class: 'btn98', href: '/horoscope', text: '🔮 today\'s horoscope' }))));
  } else {
    await horoscopeTeaser(root);
  }
  root.append(pageTitle('The Feed — what everyone is up to', h('button', { class: 'btn98', type: 'button', text: '↻ refresh', onclick: () => route() })));
  if (S.me) {
    const inp = h('input', { maxLength: 200, placeholder: 'update your status… what\'s on your mind?', 'aria-label': 'status' });
    const share = async () => {
      if (!inp.value.trim()) return;
      try { await api.post('/status', { body: inp.value }); inp.value = ''; route(); } catch (e) { oops(e); }
    };
    root.append(h('form', { class: 'ms-commentform', onsubmit: e => { e.preventDefault(); share(); } }, inp, h('button', { class: 'btn98', type: 'submit', text: 'Share' })));
    root.append(h('div', { class: 'ms-feedbar' }, [['all', 'everyone'], ['friends', '💛 my friends']].map(([k, label]) =>
      h('button', { class: 'btn98' + (feedScope === k ? ' on' : ''), type: 'button', text: label, onclick: () => { feedScope = k; route(); } }))));
  }
  const scope = S.me ? feedScope : 'all';
  await paged(root, cur => api.get(`/feed?scope=${scope}${cur ? '&before=' + enc(cur) : ''}`), feedLine,
    scope === 'friends' ? 'nothing from your friends yet. go add some people!' : 'it\'s quiet in here. be the first to say something!');
}
