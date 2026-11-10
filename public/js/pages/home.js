/* pages/home.js — Home. Logged out: a welcome and the latest from everyone. Logged in: the Feed, with a status box and
   two ways to read it: Newest (newest first) and "Pick up where I left off" (oldest first from the last post you saw,
   marking each as seen as you scroll, until you're all caught up). */

import { h, $, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { dayLabel, clock, today, sameDay } from '../core/format.js';
import { toast, oops, dialog, pageTitle, paged, errorCard } from '../core/ui.js';
import { S } from '../core/state.js';
import { onLeave } from '../core/router.js';
import { avatar, nameLink } from '../widgets/people.js';
import { composer } from '../widgets/composer.js';
import { postCard } from '../widgets/postcard.js';
import { readTracker, after } from '../widgets/readmarker.js';
import { whoToFollowBox } from '../widgets/suggestions.js';

let feedMode = 'latest';          // 'latest' | 'resume' — kept while you click around the site
let feedScope = 'following';      // 'following' | 'everyone' (Newest only; "pick up" is always the people you follow)
const NO_MARKER_DAYS = 3;         // with no marker yet, "pick up" starts three days back (the server does the same)
const countLabel = n => (n >= 999 ? '999+' : String(n));

/* ------------------------------------------------------------ logged out */

async function publicHome(root) {
  root.append(h('div', { class: 'ms-welcome' },
    h('img', { src: '/assets/deco_welcome_banner.gif', alt: 'welcome', height: 70 }),
    h('div', null,
      h('h1', { text: 'welcome to ourspace.' }),
      h('p', { text: 'a place for friends. make a page, decorate it like it\'s 2006 (glitter is encouraged), follow people, post what\'s on your mind, write a blog, show off your Spotify top songs, check your daily horoscope and actually talk to people. everyone here is a real person.' }),
      h('a', { class: 'btn98 go', href: '/join', text: '★ make your page' }), h('a', { class: 'btn98', href: '/login', text: 'log in' }), h('a', { class: 'btn98', href: '/horoscope', text: '🔮 today\'s horoscope' }))));
  root.append(pageTitle('Latest — what everyone is up to'));
  await paged(root, cur => api.get(`/feed?scope=everyone${cur ? '&before=' + enc(cur) : ''}`), item => postCard(item),
    'it\'s quiet in here. be the first to say something!');
}

/* --------------------------------------------------------------- sidebar */

// today's reading in one box
function horoscopeBox() {
  const text = h('span', { class: 'horo-teaser-text', text: 'reading the stars…' });
  const link = h('a', { class: 'horo-teaser', href: '/horoscope' }, h('span', { class: 'horo-teaser-glyph', text: S.me.sign.glyph }), h('span', null, h('b', { text: `today for ${S.me.sign.name}: ` }), text));
  const box = h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: '🔮 Your horoscope' }), link);
  api.get('/astro/me?' + today()).then(r => {
    text.textContent = `${r.reading.headline}. ${r.reading.paragraphs[0].split('. ')[0].replace(/\.$/, '')}. [read more]`;
  }).catch(() => box.remove());
  return box;
}

// friends who are on right now
function onlineBox() {
  const body = h('div', { class: 'ms-online' }, h('div', { class: 'ms-empty', text: 'looking…' }));
  const box = h('div', { class: 'ms-section' }, h('div', { class: 'ms-boxtitle', text: '🟢 Online now' }), body);
  api.get(`/users/${enc(S.me.name)}/friends`).then(r => {
    const on = r.people.filter(p => p.online).slice(0, 12);
    body.replaceChildren(...(on.length ? on.map(p => h('div', { class: 'ms-onlinerow' }, avatar(p, 28), nameLink(p)))
      : [h('div', { class: 'ms-empty', text: r.people.length ? 'none of your friends are on right now.' : 'friends are people who follow each other. none yet!' })]));
  }).catch(() => box.remove());
  return box;
}

/* ------------------------------------------------------------- logged in */

export async function renderHome(root) {
  if (!S.me) { await publicHome(root); return; }

  const main = h('div', { class: 'os-main' });
  const side = h('aside', { class: 'os-side', 'aria-label': 'extras' }, whoToFollowBox(), horoscopeBox(), onlineBox());
  const feedBox = h('div', { class: 'ms-feedbox' });
  const bar = h('div', { class: 'ms-feedbar ms-modebar' });
  let unseen = null;              // posts waiting after your marker (people you follow); null = not known yet (only the Following views say)
  let active = null;              // the reading tracker of the "pick up" view being shown
  let drawing = 0;                // bumped on every redraw so a slow one can tell it has been replaced

  const form = composer({ onPosted: () => { feedMode = 'latest'; drawFeed(); } });
  main.append(form, bar, feedBox);
  root.append(h('div', { class: 'os-shell' }, main, side));
  root.append(h('button', { class: 'btn98 go ms-fab', type: 'button', 'aria-label': 'write a status', text: '✏', onclick: () => form.focusText() }));
  onLeave(() => { if (active) active.stop(); });

  const paintBar = () => {
    const pick = h('button', { class: 'btn98' + (feedMode === 'resume' ? ' on' : ''), type: 'button', 'aria-pressed': String(feedMode === 'resume'),
      onclick: () => setMode('resume') }, 'Pick up where I left off', unseen ? h('span', { class: 'ms-badge', text: countLabel(unseen) }) : null);
    const latest = h('button', { class: 'btn98' + (feedMode === 'latest' ? ' on' : ''), type: 'button', 'aria-pressed': String(feedMode === 'latest'),
      onclick: () => setMode('latest'), text: 'Newest' });
    bar.replaceChildren(latest, pick);
    if (feedMode === 'latest') {
      bar.append(h('span', { class: 'ms-barsep' }), ...[['following', 'Following'], ['everyone', 'Everyone']].map(([k, label]) =>
        h('button', { class: 'btn98' + (feedScope === k ? ' on' : ''), type: 'button', text: label, onclick: () => { feedScope = k; drawFeed(); } })));
      if (unseen && feedScope === 'following') {
        bar.append(h('a', { class: 'ms-jump', href: '#', text: '↧ jump to where I left off', onclick: e => {
          e.preventDefault();
          const rule = $('#leftoff');
          if (rule) rule.scrollIntoView({ block: 'center' }); else setMode('resume');
        } }));
      }
    }
  };
  const setMode = mode => { if (mode !== feedMode) { feedMode = mode; drawFeed(); } };

  async function drawFeed() {
    const mine = ++drawing;
    if (active) { const was = active; active = null; await was.stop(); }       // write down how far you got first
    if (mine !== drawing) return;
    feedBox.replaceChildren(h('div', { class: 'os-loading', text: 'loading…' }));
    paintBar();
    const box = h('div');
    try {
      if (feedMode === 'resume') feedScope = 'following';
      const ok = feedMode === 'resume' ? await drawResume(box, mine) : await drawLatest(box);
      if (ok === false || mine !== drawing) return;
    } catch (e) { box.replaceChildren(errorCard(e)); }
    feedBox.replaceChildren(box);
    paintBar();
  }

  /* ---- Newest ---- */
  async function drawLatest(box) {
    let marker = null, first = true, sawNew = false, placed = false;
    const from = () => marker || { created: Date.now() - NO_MARKER_DAYS * 86400000, id: 0 };
    await paged(box, async cur => {
      const r = await api.get(`/feed?mode=latest&scope=${feedScope}${cur ? '&before=' + enc(cur) : ''}`);
      if (first) { first = false; marker = r.marker; if (feedScope === 'following') unseen = r.unseen; }
      return r;
    }, item => {
      const card = postCard(item);
      if (feedScope !== 'following' || item.author.id === S.me.id) return card;
      if (after(item, from())) { sawNew = true; card.classList.add('is-new'); return card; }
      if (!sawNew || placed) return card;
      placed = true;                                       // the first post you had already seen
      const frag = document.createDocumentFragment();
      frag.append(h('div', { class: 'ms-leftoff', id: 'leftoff', text: '📍 you left off here' }), card);
      return frag;
    }, feedScope === 'following' ? 'nothing here yet. follow some people and their statuses and blog posts show up here.' : 'it\'s quiet in here. be the first to say something!');
    if (feedScope === 'following' && !box.querySelector('.ms-feeditem')) {
      box.prepend(h('div', { class: 'ms-emptycta' }, h('a', { class: 'btn98 go', href: '/browse', text: '🔍 find people to follow' }),
        h('button', { class: 'btn98', type: 'button', text: 'see everyone\'s posts', onclick: () => { feedScope = 'everyone'; drawFeed(); } })));
    }
  }

  /* ---- Pick up where I left off ---- */
  async function drawResume(box, mine) {
    const q = '/feed?mode=resume&scope=following';
    let r = await api.get(q);
    if (mine !== drawing) return false;
    unseen = r.unseen;
    let waiting = r.unseen;                                // how many were waiting when we started
    let next = r.next;
    let last = r.marker ? `${r.marker.created}:${r.marker.id}` : null;   // where "check for new" continues from
    let prevItem = null;
    let loader = null;                                     // watches the "keep reading" button

    const head = h('div', { class: 'ms-resumehead' },
      h('b', { text: r.marker ? `Reading forward from ${dayLabel(r.marker.created)} ${clock(r.marker.created)}` : `Reading forward from ${NO_MARKER_DAYS} days ago` }),
      h('span', { text: ' · oldest first, newest at the bottom' }));
    const list = h('div', { class: 'ms-resumelist' });
    const end = h('div', { class: 'ms-resumeend' });
    const status = h('div', { class: 'ms-resumebar', role: 'status' });
    box.append(head);
    if (r.unseen > 100) {
      box.append(h('div', { class: 'ms-note' }, `${countLabel(r.unseen)} posts are waiting. that's a lot. keep reading, or `,
        h('a', { href: '#', text: 'mark them all read', onclick: e => { e.preventDefault(); markAll(); } }), ' and start fresh from now.'));
    }
    box.append(list, end, status);

    const tracker = readTracker({
      marker: r.marker,
      top: $('.os-top') ? $('.os-top').offsetHeight : 0,
      bottom: matchMedia('(max-width: 760px)').matches ? 44 : 34,
      onChange: () => paintStatus(),
      onSaved: () => { unseen = Math.max(0, waiting - tracker.counts().seen); paintBar(); },
      onStop: () => { if (loader) loader.disconnect(); loader = null; },
    });
    active = tracker;

    function paintStatus() {
      const { seen, total } = tracker.counts();
      const all = Math.max(waiting, total);
      unseen = Math.max(0, all - seen);
      if (paintCaught) paintCaught();
      if (!all) { status.replaceChildren(h('span', { class: 'ms-resumecount', text: 'nothing waiting' }), h('span', { text: 'caught up' })); return; }
      status.replaceChildren(
        h('span', { class: 'ms-resumecount', text: `${seen} of ${countLabel(all)} read` }),
        h('span', { text: unseen ? `~${countLabel(unseen)} left` : 'caught up' }),
        h('span', { class: 'ms-resumebtns' },
          h('button', { class: 'btn98', type: 'button', text: '↑ first unseen', onclick: () => {
            const el = tracker.firstUnseen();
            if (el) el.scrollIntoView({ block: 'center' }); else end.scrollIntoView({ block: 'center' });
          } }),
          h('button', { class: 'btn98', type: 'button', text: 'Mark all read', onclick: markAll })));
    }

    const addItems = items => {
      for (const item of items) {
        if (!prevItem || !sameDay(prevItem.created, item.created)) list.append(h('div', { class: 'ms-dayrule' }, h('span', { text: dayLabel(item.created) })));
        const card = postCard(item, { time: 'clock' });
        list.append(card);
        tracker.add(card, item);
        prevItem = item;
        last = `${item.created}:${item.id}`;
      }
    };

    let paintCaught = null;                                // redraws the "caught up" line at the end of the list
    const paintEnd = () => {
      if (loader) { loader.disconnect(); loader = null; }
      paintCaught = null;
      if (next) {
        const more = h('button', { class: 'btn98 ms-more', type: 'button', text: 'keep reading ▾', onclick: async () => {
          more.disabled = true;
          try {
            const page = await api.get(`${q}&after=${enc(next)}`);
            if (mine !== drawing) return;
            next = page.next;
            addItems(page.items);
            paintStatus();
          } catch (e) { oops(e); }
          paintEnd();
        } });
        end.replaceChildren(more);
        loader = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && !more.disabled) more.click(); }, { rootMargin: '0px 0px 300px 0px' });
        loader.observe(more);
      } else {
        const caught = h('div', { class: 'ms-caughtup' });
        paintCaught = () => {                                // "all caught up" only once everything above has been seen
          const { seen, total } = tracker.counts();
          caught.classList.toggle('skipped', seen < total);
          caught.textContent = seen < total ? `That's the newest post. ${total - seen} above ${total - seen === 1 ? 'is' : 'are'} still unseen.`
            : `✔ You're all caught up as of ${clock(Date.now())}`;
        };
        paintCaught();
        end.replaceChildren(
          h('img', { class: 'bar-gif', src: '/assets/deco_hearts_bar.gif', alt: '' }),
          caught,
          h('div', { class: 'ms-caughtbtns' },
            h('button', { class: 'btn98', type: 'button', text: '↻ check for new', onclick: checkNew }),
            h('button', { class: 'btn98', type: 'button', text: 'Newest ▸', onclick: () => setMode('latest') })));
      }
    };
    const checkNew = async () => {
      try {
        const page = await api.get(last ? `${q}&after=${enc(last)}` : q);
        if (mine !== drawing) return;
        if (!page.items.length) { toast('nothing new yet.'); return; }
        waiting += page.items.length;
        next = page.next;
        addItems(page.items);
        paintStatus();
        paintEnd();
      } catch (e) { oops(e); }
    };
    async function markAll() {
      if (!await dialog({ title: 'Mark all read', icon: '✔', ok: 'Mark all read', text: 'Skip everything that\'s waiting and start from the newest post? You can still find those posts under Newest.' })) return;
      try {
        const newest = (await api.get('/feed?mode=latest&scope=following')).items[0];
        const was = active; active = null;
        if (was) await was.stop();
        if (newest) await api.put('/me/markers/feed', { created: newest.created, id: newest.id });
        unseen = 0;
        drawFeed();
      } catch (e) { oops(e); }
    }

    addItems(r.items);
    paintStatus();
    paintEnd();
    return true;
  }

  await drawFeed();
}
