/* ============================================================
   extras.js — the era pack: Presence + AIM buddy list, #ourspace
   IRC chatroom, MSN nudges, daily horoscope, webring, glitter
   text studio, profile customizer, control panel, spam drip.
   Loads after ourspace.js (needs MS, Sfx, WM, Guestbook).
   ============================================================ */

/* ============================ PRESENCE ============================ */
const Presence = {
  online: {}, away: {},

  // how many residents are believably signed on at once: about half of a small cast, ~21 of the full ~92
  target() {
    const n = Object.keys(MS.people).length;
    return Math.round(Math.min(n * 0.5, 12 + n * 0.1));
  },

  init() {
    // your friends are likelier to be around than strangers
    const friends = new Set((MS.state && MS.state.friends) || []);
    Object.keys(MS.people)
      .map(id => ({ id, r: Math.random() * (friends.has(id) ? 2.5 : 1) }))
      .sort((a, b) => b.r - a.r)
      .slice(0, this.target())
      .forEach(({ id }) => {
        this.online[id] = true;
        if (Math.random() < 0.3) this.away[id] = this.awayMsg(id);
      });
    this.online.todd = true;               // todd is always online. he is load-bearing.
    delete this.away.todd;
    // so is the owner (malten "lives here") — and nothing ever signs him off or writes his away message
    Object.keys(MS.people).filter(id => MS.people[id].owner).forEach(id => { this.online[id] = true; delete this.away[id]; });
    // whoever has a scripted conversation waiting on you is signed on
    (MS.activeTreeIds ? MS.activeTreeIds() : []).forEach(tid => { this.online[MS.trees[tid].with] = true; delete this.away[MS.trees[tid].with]; });
    setInterval(() => this.tick(), 22000);
  },

  awayMsg(id) {
    const p = MS.people[id];
    const bank = MS.bank ? MS.bank('awayMessages') : [];
    const pool = (p.statuses || []).concat(bank, ['brb', 'g2g dinner', 'xX~*aWaY*~Xx', 'showering (mentally)']);
    return pool[Math.floor(Math.random() * pool.length)];
  },

  audible() {
    const bl = document.querySelector('.window[data-app="buddylist"]');
    const ch = document.querySelector('.window[data-app="chat"]');
    const vis = el => el && !el.classList.contains('closed') && !el.classList.contains('minimized');
    return vis(bl) || vis(ch);
  },

  tick() {
    if (Math.random() < 0.45) return;
    const ids = Object.keys(MS.people).filter(i => i !== 'todd' && !MS.people[i].owner);
    // drift toward the target headcount: a coin flip per random resident would fill the room at 92 residents
    const on = ids.filter(i => this.online[i]), off = ids.filter(i => !this.online[i]);
    const goal = this.target();
    const pJoin = on.length < goal - 2 ? 0.8 : on.length > goal + 2 ? 0.15 : 0.45;
    const friends = new Set(MS.state.friends || []);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const offFriends = off.filter(i => friends.has(i));
    const id = (off.length && (!on.length || Math.random() < pJoin))
      ? ((offFriends.length && Math.random() < 0.5) ? pick(offFriends) : pick(off))
      : pick(on);
    if (!id) return;
    if (this.online[id]) {
      // nobody signs off in the middle of a scripted conversation with you
      if (Math.random() < 0.35 && !(MS.activeTreeFor && MS.activeTreeFor(id))) {
        delete this.online[id];
        delete this.away[id];
        if (this.audible()) Sfx.doorSlam();
        Chat.sysLine(`← ${MS.people[id].name} has quit (${Chat.quitReason(id)})`);
      } else if (this.away[id]) {
        delete this.away[id];
        Chat.sysLine(`${MS.people[id].name} is back`);
      } else {
        this.away[id] = this.awayMsg(id);
      }
    } else {
      this.online[id] = true;
      if (this.audible()) Sfx.doorOpen();
      Chat.sysLine(`→ ${MS.people[id].name} has joined #ourspace`);
    }
    BuddyList.paint();
    Chat.paintNicks();
  },

  ensureOnline(id) {
    if (!this.online[id]) {
      this.online[id] = true;
      delete this.away[id];
      if (this.audible()) Sfx.doorOpen();
      Chat.sysLine(`→ ${MS.people[id].name} has joined #ourspace`);
      BuddyList.paint();
      Chat.paintNicks();
    }
  },
};

/* ========================== BUDDY LIST ========================== */
const BuddyList = {
  build(container) {
    const body = container || document.querySelector('.window[data-app="buddylist"] .window-body');
    if (!body) return;
    const me = (MS.state && MS.state.me) || null;
    body.innerHTML = `
      <div class="bl-me">🟣 <b></b><div class="bl-mystatus"></div></div>
      <div id="bl-list"></div>
      <div class="bl-foot">${Object.keys(MS.people).length} buddies · sounds on</div>`;
    // the visitor's own screen name + mood (text nodes: a name is user input)
    body.querySelector('.bl-me b').textContent = MS.myName ? MS.myName() : 'you';
    body.querySelector('.bl-mystatus').textContent = me ? 'online — ' + (me.mood || 'here') : 'online — signing up…';
    this.paint();
  },

  paint() {
    const list = document.getElementById('bl-list');
    if (!list) return;
    list.innerHTML = '';
    const ids = Object.keys(MS.people);
    // ✉ = a scripted conversation is waiting on you (several can be open at once); those float to the top,
    // then your friends, then everyone else
    const mail = new Set(MS.activeTreeIds ? MS.activeTreeIds().map(tid => MS.trees[tid].with) : []);
    const friends = new Set(MS.state.friends || []);
    const rank = id => (mail.has(id) ? 0 : friends.has(id) ? 1 : 2);
    const sorted = arr => arr.map((id, i) => [id, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
    const on = sorted(ids.filter(id => Presence.online[id] && !Presence.away[id]));
    const away = sorted(ids.filter(id => Presence.away[id]));
    const off = sorted(ids.filter(id => !Presence.online[id]));
    // with the full ~92-resident roster the offline group is ~70 rows: it starts folded, click the header to open
    if (this.showOffline === undefined) this.showOffline = ids.length <= 45;

    const group = (label, arr, cls, folded) => {
      const g = document.createElement('div');
      g.className = 'bl-group';
      g.textContent = `${folded ? '►' : '▼'} ${label} (${arr.length})`;
      list.appendChild(g);
      if (cls === 'off') {
        g.classList.add('bl-fold');
        g.addEventListener('click', () => { this.showOffline = !this.showOffline; Sfx.click(); this.paint(); });
      }
      if (folded) return;
      arr.forEach(id => {
        const p = MS.people[id];
        const row = document.createElement('div');
        row.className = 'bl-row ' + cls;
        const activeConvo = mail.has(id);
        row.innerHTML = `<span class="bl-dot"></span>${p.name}${p.owner ? ' <span class="bl-owner" title="built this desktop">★</span>' : ''}${activeConvo ? ' <span class="bl-mail blink">✉</span>' : ''}`;
        if (cls === 'away') row.title = 'away: ' + MS.t(Presence.away[id]);
        else if (p.owner) row.title = 'malten built this desktop — click for his page';
        row.addEventListener('click', () => {
          if (cls === 'away' && !row.dataset.shown) {
            row.dataset.shown = '1';
            const msg = document.createElement('div');
            msg.className = 'bl-awaymsg';
            msg.textContent = '⏳ ' + MS.t(Presence.away[id]);
            row.insertAdjacentElement('afterend', msg);
            Sfx.click();
            return;
          }
          WM.open('myspace');
          if (p.owner) MS.show('profile', id);     // a real person: no inbox bot, his page has the guestbook
          else MS.show('inbox', id);
        });
        list.appendChild(row);
      });
    };
    group('Buddies', on, 'on');
    group('Away', away, 'away');
    group('Offline', off, 'off', !this.showOffline);
  },
};

/* ========================= #OURSPACE CHAT ========================= */
const Chat = {
  log: [], timer: null, open: false, chatUsed: {},

  quitReason(id) {
    const generic = ['connection reset by peer', 'ping timeout', 'mom needed the phone line', 'dinner', 'rebooting for updates (year 3 of updates)'];
    const special = { tina: 'connection reset by vampire', dave: 'firewall breach (his own)', zorp: 'beamed up (normal reasons)', wes: 'friendlies', herp: 'herp' };
    return special[id] || generic[Math.floor(Math.random() * generic.length)];
  },

  build(container) {
    const body = container || document.querySelector('.window[data-app="chat"] .window-body');
    if (!body) return;
    body.innerHTML = `
      <div class="chat-topic">💬 <b>#ourspace</b> — todd set the topic: be normal. this is the only rule.</div>
      <div class="chat-wrap">
        <div id="chat-log"></div>
        <div id="chat-nicks"></div>
      </div>
      <div class="ms-commentform chat-form">
        <input id="chat-input" placeholder="say something to the room…" maxlength="200">
        <button class="btn98" id="chat-send">Send</button>
      </div>`;
    const send = () => this.userSend();
    document.getElementById('chat-send').addEventListener('click', send);
    document.getElementById('chat-input').addEventListener('keypress', e => { if (e.key === 'Enter') send(); });
    if (!this.log.length) this.backfill();
    this.paintLog();
    this.paintNicks();
  },

  onOpen(container) {
    this.open = true;
    this.build(container);
    this.paintLog(true);
    this.paintNicks();
    if (!this.timer) this.timer = setInterval(() => { if (Math.random() < 0.75) this.synth(); }, 11000);
  },
  onClose() {
    this.open = false;
    clearInterval(this.timer);
    this.timer = null;
  },

  addLine(line) {
    this.log.push(line);
    if (this.log.length > 130) this.log = this.log.slice(-130);
    if (this.open) this.paintLog(true);
  },
  sysLine(text) { this.addLine({ kind: 'sys', text }); },

  backfill() {
    // fake scrollback so the room never feels dead on arrival
    for (let i = 0; i < 14; i++) this.synth(true);
    this.sysLine('→ you have joined #ourspace');
  },

  synth(silent) {
    const ids = Object.keys(MS.people).filter(id => !MS.people[id].owner);   // malten is in the room, but nobody types for him
    const onlineIds = ids.filter(id => Presence.online[id]);
    const pool = onlineIds.length >= 3 ? onlineIds : ids;
    const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
    const roll = Math.random();

    if (roll < 0.5) {
      // banter line aimed at someone, maybe answered
      const pairs = [];
      pool.forEach(a => {
        const b = MS.people[a].banter || {};
        Object.keys(b).forEach(t => {
          if (!MS.people[t]) return;       // banter aimed at a resident whose content isn't loaded
          b[t].forEach((line, i) => {
            const key = `${a}>${t}:${i}`;
            if (!this.chatUsed[key]) pairs.push({ a, t, line, key });
          });
        });
      });
      if (!pairs.length) { this.chatUsed = {}; return; }
      const p = rnd(pairs);
      this.chatUsed[p.key] = 1;
      this.addLine({ kind: 'msg', from: p.a, text: `${MS.people[p.t] ? MS.people[p.t].name : p.t}: ${p.line}` });
      if (MS.people[p.t] && !MS.people[p.t].owner && (MS.people[p.t].replies || []).length && Math.random() < 0.55) {
        const reply = rnd(MS.people[p.t].replies || ['lol']);
        const say = () => this.addLine({ kind: 'msg', from: p.t, text: reply });
        silent ? say() : setTimeout(say, 2000 + Math.random() * 4000);
      }
    } else if (roll < 0.78) {
      // /me action from a status
      const withS = pool.filter(id => (MS.people[id].statuses || []).length);
      if (!withS.length) return;
      const id = rnd(withS);
      this.addLine({ kind: 'me', from: id, text: rnd(MS.people[id].statuses) });
    } else if (roll < 0.86 && MS.bank && MS.bank('chatLines').length) {
      // authored 2006 chatroom one-liners from the line bank (written in the original cast's voice, so they say them)
      const cast = pool.filter(id => !MS.people[id].isNew);
      this.addLine({ kind: 'msg', from: rnd(cast.length ? cast : pool), text: rnd(MS.bank('chatLines')) });
    } else if (roll < 0.9) {
      this.addLine({ kind: 'msg', from: 'herp', text: rnd(['herp.', 'herp herp.', 'HERP.', 'herp?', '...herp 💜']) });
    } else {
      // somebody nudges somebody
      const a = rnd(pool), b = rnd(pool);
      if (a !== b) this.sysLine(`〰 ${MS.people[a].name} sent ${MS.people[b].name} a nudge`);
    }
  },

  userSend() {
    const inp = document.getElementById('chat-input');
    const text = Guestbook.filter((inp.value || '').trim());
    if (!text) return;
    inp.value = '';
    this.addLine({ kind: 'msg', from: 'you', text });
    Sfx.click();
    // who answers? name/keyword match first, otherwise maybe a random reaction
    const lower = text.toLowerCase();
    const ids = Object.keys(MS.people).filter(id => !MS.people[id].owner);   // malten never auto-answers
    // named = whole words only: with ~92 residents, ids like "min", "tim", "wes" hide inside ordinary words
    const words = new Set(lower.split(/[^a-z0-9_]+/));
    let target = ids.find(id => {
      const name = (MS.people[id].name || '').toLowerCase();
      return words.has(id) || words.has(name) || (name.length >= 6 && lower.includes(name));
    });
    if (!target) {
      // keyword match: any resident who has one (not just the first in the roster), people in the room first
      const hits = ids.filter(id => Object.keys(MS.people[id].keywords || {}).some(k => lower.includes(k)));
      const here = hits.filter(id => Presence.online[id]);
      const pool = here.length ? here : hits;
      target = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!target && Math.random() < 0.45) {
      const online = ids.filter(id => Presence.online[id]);
      target = online[Math.floor(Math.random() * online.length)];
    }
    if (target) {
      Presence.ensureOnline(target);
      setTimeout(() => {
        this.addLine({ kind: 'msg', from: target, text: MS.botReply(target, text) });
        Sfx.beep(880, .08, 'sine', .04);
      }, 1800 + Math.random() * 4200);
    }
  },

  paintLog(stick) {
    const el = document.getElementById('chat-log');
    if (!el) return;
    const atBottom = stick || el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.innerHTML = '';
    // lines are stored raw; the visitor's name (and {you} in what residents say) is filled in here, so a rename shows
    const nameOf = id => (id === 'you' ? MS.myName() : MS.people[id] ? MS.people[id].name : id);
    this.log.forEach(l => {
      const row = document.createElement('div');
      row.className = 'chat-line ' + l.kind;
      if (l.kind === 'sys') row.textContent = MS.t(l.text);
      else if (l.kind === 'me') row.textContent = `* ${nameOf(l.from)} ${MS.t(l.text)}`;
      else {
        const nick = document.createElement('b');
        nick.className = 'chat-nick' + (l.from === 'you' ? ' me' : '');
        nick.textContent = `<${nameOf(l.from)}>`;
        nick.addEventListener('click', () => { WM.open('myspace'); if (l.from === 'you') MS.show('home'); else MS.show('profile', l.from); });
        row.appendChild(nick);
        row.appendChild(document.createTextNode(' ' + MS.t(l.text)));
      }
      el.appendChild(row);
    });
    if (atBottom) el.scrollTop = el.scrollHeight;
  },

  paintNicks() {
    const el = document.getElementById('chat-nicks');
    if (!el) return;
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'chat-nickhead';
    const online = Object.keys(MS.people).filter(id => Presence.online[id]);
    head.textContent = `online (${online.length + 1})`;
    el.appendChild(head);
    const you = document.createElement('div');
    you.className = 'chat-nickrow';
    you.textContent = MS.myName() + ' (you)';
    el.appendChild(you);
    online.forEach(id => {
      const row = document.createElement('div');
      row.className = 'chat-nickrow' + (Presence.away[id] ? ' away' : '');
      // the owner gets the channel-operator @ (it's his server)
      row.textContent = (Presence.away[id] ? '⏳ ' : '') + (MS.people[id].owner ? '@' : '') + MS.people[id].name;
      row.addEventListener('click', () => { WM.open('myspace'); MS.show('profile', id); });
      el.appendChild(row);
    });
  },
};

/* ============================= NUDGE ============================= */
const Nudge = {
  shake() {
    const win = document.querySelector('.window[data-app="myspace"]');
    if (!win || win.classList.contains('closed')) return false;
    win.classList.remove('nudging');
    void win.offsetWidth;                 // restart the animation
    win.classList.add('nudging');
    return true;
  },

  fromResident() {
    const online = Object.keys(MS.people).filter(id => Presence.online[id] && MS.state.friends.includes(id) && !MS.people[id].owner);
    if (!online.length) return;
    const id = online[Math.floor(Math.random() * online.length)];
    Sfx.buzz();
    const shook = this.shake();
    MS.toast(MS.people[id].name + ' sent you a nudge!!' + (shook ? '' : ' (open OurSpace)'), 'inbox', id);
  },

  sendTo(id) {
    Sfx.buzz();
    this.shake();
    MS.toast('you nudged ' + MS.people[id].name + '.');
    setTimeout(() => {
      const t = MS.state.inbox[id] = MS.state.inbox[id] || { unread: false, msgs: [] };
      const last = t.msgs[t.msgs.length - 1];
      // they answer a nudge in words once (a line this thread hasn't seen); nudging again before you say anything
      // just gets a nudge back — and never a stock line dropped into the middle of a scripted conversation
      const wordless = (last && last.n) || (MS.activeTreeFor && MS.activeTreeFor(id));
      if (!wordless) {
        t.msgs.push({ who: 'them', text: MS.botReply(id, 'nudge', t), time: MS.now(), n: 1 });
        t.at = Date.now();
        MS.save();
        if (MS.view.page === 'inbox' && MS.view.arg === id) MS.render();
        else { t.unread = true; MS.paintTabs(); }
      }
      if (wordless || Math.random() < 0.5) { Sfx.buzz(); this.shake(); MS.toast(MS.people[id].name + ' nudged you back. obviously.'); }
    }, 2500 + Math.random() * 3000);
  },

  init() {
    setInterval(() => { if (Math.random() < 0.12) this.fromResident(); }, 65000);
  },
};

/* =========================== HOROSCOPE =========================== */
const Horoscope = {
  build(container) {
    const body = container || document.querySelector('.window[data-app="horoscope"] .window-body');
    if (!body) return;
    const d = new Date();
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const rng = this.mulberry(seed);
    const pick = arr => arr[Math.floor(rng() * arr.length)];

    const moods = ['chaotic good', 'suspiciously lucky', 'protagonist of the week', 'cozy with a chance of drama', 'unstoppable (mildly)', 'sparkly', 'contemplative (rare)'];
    const items = ['a backup capri sun', 'your rock', 'side B of anything', 'one (1) unspent materia', 'the good CRT', 'a fresh 88x31 badge', 'exact change', 'the third slice of pizza'];
    const dos = [
      'say hi to someone first for once. the stars are tired of doing it for you.',
      'play one (1) game of minesweeper. the mines know what you did.',
      'compliment a stranger\'s profile song. this creates 12 units of good karma.',
      'log off at a reasonable hour. (the stars know you won\'t. they respect the bit.)',
      'rearrange a window on your desktop. feng shui counts digitally.',
    ];
    const avoids = [
      'forwarding chain letters after midnight. that\'s when the curses are load-bearing.',
      'arguing with wes about tiers. you will lose. everyone loses.',
      'reading part 7 of the jenova essay unprepared.',
      'the fourth capri sun. tony knows why.',
      'checking who viewed your profile. (it was tony. it\'s always tony.)',
    ];
    const targeted = rng() < 0.25;
    // the visitor's sign from their page; no sign yet = starxgazer guesses (scorpio, she's sure)
    const signs = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'];
    const mine = String((MS.state && MS.state.me && MS.state.me.zodiac) || '').trim().toLowerCase();
    const sign = signs.includes(mine) ? mine : 'scorpio';
    const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const special = pick([
      'the stars say check your guestbook. someone meant what they wrote.',
      'mercury says your minesweeper record falls today. mercury is rarely wrong about minesweeper.',
      'someone viewed your profile 4 times today. the stars know who. (it was tony)',
      'your top 5 will be validated by a stranger this week. hold the line.',
      `a ${sign} named ${esc(MS.myName ? MS.myName() : 'you')} will have a great day. draw your own conclusions.`,
    ]);

    body.innerHTML = `
      <div class="horo-head">🔮 daily forecast — <b>${sign}</b>${signs.includes(mine) ? '' : ' <span class="horo-guess">(a guess)</span>'}</div>
      <div class="horo-line">mood: <b>${pick(moods)}</b></div>
      <div class="horo-line">lucky item: <b>${pick(items)}</b></div>
      <div class="horo-line">lucky number: <b>${Math.floor(rng() * 88) + 1}</b></div>
      <div class="horo-line">✅ do: ${pick(dos)}</div>
      <div class="horo-line">❌ avoid: ${pick(avoids)}</div>
      ${targeted ? `<div class="horo-line horo-special">✨ ${special}</div>` : ''}
      <div class="horo-foot">— starxgazer ✨ (she did this without being asked)</div>
      <button class="btn98" id="horo-tomorrow">ask for tomorrow's early</button>`;
    document.getElementById('horo-tomorrow').addEventListener('click', () => {
      Sfx.error();
      MS.toast('starxgazer: the stars don\'t do early. come back tomorrow ✨');
    });
  },
  mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  },
};

/* ============================ WEBRING ============================ */
const Webring = {
  idx: 0,
  sites: [
    { id: 'todd', title: "Todd's Server Status Page", url: 'http://ourspace.ring/todd', bg: '#f4f4f4', fg: '#000', html: `<h2>SERVER STATUS: <span style="color:green">UP*</span></h2><p>*mostly</p><pre>uptime: 3 days 4 hrs (personal record)\nlaptop temperature: warm but loved\nrain forecast: MOVED AWAY FROM WINDOW ✔</pre><p>uptime graph:</p><pre>▁▂▄█▆▄▁▁▁█▇▇▇▁▄█ ← (the dips are naps)</pre><p style="font-size:11px">this page auto-refreshes never. refresh it with your heart.</p>` },
    { id: 'wes', title: "wes's FRAME DATA ZONE", url: 'http://ourspace.ring/framedata', bg: '#0d1b0d', fg: '#7fff7f', html: `<h2>FRAME DATA ZONE</h2><p>all characters ranked by one metric: are they fox</p><table border="1" cellpadding="4" style="border-color:#7fff7f"><tr><td>fox</td><td>frame 1 (beautiful)</td></tr><tr><td>falco</td><td>basically fox (acceptable)</td></tr><tr><td>everyone else</td><td>see: not fox</td></tr></table><p style="font-size:11px">20XX countdown: soon</p>` },
    { id: 'tina', title: "tina's Midnight Shrine", url: 'http://ourspace.ring/midnight', bg: '#0a0a0a', fg: '#c3002f', html: `<h2>~ the midnight shrine ~</h2><p>days since last chain letter: <b>0</b></p><p>edward quote of the day: "..." (he says so much by saying nothing)</p><p>team edward member count: 1 (quality over quantity)</p><p style="font-size:11px">this page is best viewed at midnight. you are viewing it wrong right now. that's ok.</p>` },
    { id: 'dave', title: "dave's h4x0r t3rm1n4l", url: 'http://ourspace.ring/h4x', bg: '#000', fg: '#00ff66', html: `<h2>&gt; ACCESS GRANTED</h2><p>&gt; (to this webpage) (that is all)</p><pre>> running trace...\n> firewall status: ON (mom's rules)\n> password strength: hunter2 (uncrackable)\n> current project: hacking the school bell to ring 4 min early\n> project status: grounded</pre>` },
    { id: 'meg', title: 'HORSE FACTS DAILY', url: 'http://ourspace.ring/horsefacts', bg: '#fff8f0', fg: '#5c3a1a', html: `<h2>🐴 HORSE FACTS DAILY 🐴</h2><p><b>fact #341:</b> horses can sleep standing up. i too have done this, in class.</p><p><b>fact #342:</b> a horse named chestnut blessed an email today. maybe yours!!</p><p>💖 today's featured horse: ALL OF THEM 💖</p>` },
    { id: 'zorp', title: 'Totally Normal Human Blog', url: 'http://ourspace.ring/normal', bg: '#031403', fg: '#7fff7f', html: `<h2>my normal day, by zorp (human)</h2><p>today i consumed nutrients through my FACE HOLE (normal). i stood in a field for 4 hours (normal amount). i observed the moon and gave it a 9/10 (it knows what it did).</p><p style="font-size:11px">comments are disabled because the government reads them. haha just kidding. (delete this)</p>` },
    { id: 'herp', title: "herp's homepage", url: 'http://ourspace.ring/herp', bg: '#eaffea', fg: '#1a4d1a', html: `<div style="text-align:center;padding:40px 0"><h1 style="font-size:44px">herp.</h1></div>` },
  ],

  go(dir) {
    if (dir === 'random') this.idx = Math.floor(Math.random() * this.sites.length);
    else this.idx = (this.idx + dir + this.sites.length) % this.sites.length;
    WM.open('webring');
    this.paint();
    Sfx.click();
  },

  paint() {
    const win = document.querySelector('.window[data-app="webring"]');
    const body = win && win.querySelector('.window-body');
    if (!body) return;
    const site = this.sites[this.idx];
    win.querySelector('.title-bar-text').textContent = '🌐 Maltenscape Navigator';
    body.innerHTML = `
      <div class="wr-chrome">
        <button class="btn98" id="wr-back">←</button>
        <button class="btn98" id="wr-fwd">→</button>
        <span class="wr-url">${site.url}</span>
      </div>
      <div class="wr-page" style="background:${site.bg};color:${site.fg}">${site.html}</div>
      <div class="wr-ringbar">
        <b>malten webring</b> · site ${this.idx + 1} of ${this.sites.length}
        <button class="btn98" id="wr-prev">← prev</button>
        <button class="btn98" id="wr-rand">🎲 random</button>
        <button class="btn98" id="wr-next">next →</button>
      </div>`;
    body.querySelector('#wr-prev').addEventListener('click', () => this.go(-1));
    body.querySelector('#wr-next').addEventListener('click', () => this.go(1));
    body.querySelector('#wr-rand').addEventListener('click', () => this.go('random'));
    body.querySelector('#wr-back').addEventListener('click', () => this.go(-1));
    body.querySelector('#wr-fwd').addEventListener('click', () => this.go(1));
  },

  initWidgets() {
    document.querySelectorAll('.webring-widget').forEach(w => {
      w.innerHTML = `<span class="wr-label">🕸 malten webring:</span>
        <button class="btn98" data-wr="-1">← prev</button>
        <button class="btn98" data-wr="random">RANDOM</button>
        <button class="btn98" data-wr="1">next →</button>`;
      w.querySelectorAll('[data-wr]').forEach(b =>
        b.addEventListener('click', () => this.go(b.dataset.wr === 'random' ? 'random' : +b.dataset.wr)));
    });
  },
};

/* ========================= GLITTER STUDIO ========================= */
const Glitter = {
  style: 'rainbow',
  styles: {
    rainbow: { cls: 'glit-rainbow', label: '🌈 rainbow' },
    pink:    { cls: 'glit-pink', label: '💖 pink' },
    gold:    { cls: 'glit-gold', label: '⭐ gold' },
    toxic:   { cls: 'glit-toxic', label: '☣ toxic' },
  },

  build() {
    const body = document.querySelector('.window[data-app="glitter"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = `
      <div class="paint-toolbar" id="glit-styles"></div>
      <input id="glit-input" class="glit-input" placeholder="type something sparkly…" maxlength="60">
      <div class="glit-preview" id="glit-preview"></div>
      <div class="paint-toolbar">
        <button class="btn98" id="glit-wall">📌 post to my wall</button>
        <button class="btn98" id="glit-gb">📖 sign the guestbook</button>
        <button class="btn98" id="glit-copy">📋 copy</button>
      </div>`;
    body.querySelector('#glit-input').value = (MS.myName ? MS.myName() : 'ourspace') + ' rules ok';
    const stylesBar = body.querySelector('#glit-styles');
    Object.entries(this.styles).forEach(([key, s]) => {
      const b = document.createElement('button');
      b.className = 'btn98' + (key === this.style ? ' tool-on' : '');
      b.textContent = s.label;
      b.addEventListener('click', () => {
        this.style = key;
        stylesBar.querySelectorAll('.btn98').forEach(x => x.classList.remove('tool-on'));
        b.classList.add('tool-on');
        this.paint();
      });
      stylesBar.appendChild(b);
    });
    body.querySelector('#glit-input').addEventListener('input', () => this.paint());
    body.querySelector('#glit-wall').addEventListener('click', () => this.post('wall'));
    body.querySelector('#glit-gb').addEventListener('click', () => this.post('gb'));
    body.querySelector('#glit-copy').addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(this.wrapped()).then(() => MS.toast('copied, sparkles included ✨'));
    });
    this.paint();
  },

  text() { return (document.getElementById('glit-input') || {}).value || ''; },
  wrapped() { return '·˚₊✨ ' + this.text().trim() + ' ✨₊˚·'; },

  paint() {
    const prev = document.getElementById('glit-preview');
    if (!prev) return;
    prev.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'glit-text ' + this.styles[this.style].cls;
    this.text().split('').forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.animationDelay = (i * 0.08) + 's';
      wrap.appendChild(s);
    });
    for (let i = 0; i < 6; i++) {
      const sp = document.createElement('span');
      sp.className = 'glit-spark';
      sp.textContent = '✨';
      sp.style.left = (5 + Math.random() * 90) + '%';
      sp.style.top = (Math.random() * 80) + '%';
      sp.style.animationDelay = (Math.random() * 2) + 's';
      prev.appendChild(sp);
    }
    prev.appendChild(wrap);
  },

  post(where) {
    const text = Guestbook.filter(this.wrapped());
    if (text.replace(/[·˚₊✨ ]/g, '').length === 0) { Sfx.error(); return; }
    if (where === 'wall') {
      MS.state.myWall.push({ from: 'you', text, time: MS.now() });
      MS.pushFeed({ type: 'status', from: 'you', text, time: MS.now() });
      MS.toast('posted to your wall, at maximum sparkle');
    } else {
      Guestbook.postExternal(MS.myName(), text);         // signed as the visitor (malten owns the guestbook)
      MS.toast('the guestbook has been glitterized', 'guestbook');
    }
    Sfx.tada();
  },
};

/* ======================= PROFILE CUSTOMIZER ======================= */
// "Edit My Page": the editor for everything on the visitor's page (MS.state.me), as ONE scrolling page of compact
// sections — 📷 picture & name · 👤 about · 🎨 look (theme, background, font, decor gifs, 88x31 buttons) · 🎵 my top 5
// (searchable through SongSearch in apps.js) · ⭐ top 8 — above a save bar that stays in reach. Edits a draft; 💾 save
// writes state.me and the neighborhood reacts. Every open starts at the top; MS.openEditor(section) scrolls to one.
const Customizer = {
  jump: null,               // a section to scroll to on the next open: 'pic' | 'about' | 'blog' | 'look' | 'music' | 'friends'
  built: false,
  swatches: [
    { bg: '#eef3fb', fg: '#000000', accent: '#3b6fb6', name: 'ourspace blue' },
    { bg: '#f3eefb', fg: '#000000', accent: '#9370DB', name: 'classic purple' },
    { bg: '#0a0a0a', fg: '#e0d5f5', accent: '#c3002f', name: 'midnight' },
    { bg: '#e8f4ff', fg: '#003366', accent: '#ff6600', name: 'sk8r blue' },
    { bg: '#fffbe0', fg: '#5c4a00', accent: '#ffcc00', name: 'banana' },
    { bg: '#0d1b0d', fg: '#c8f5c8', accent: '#7fff7f', name: 'CRT green' },
    { bg: '#ffe8f0', fg: '#5c1a33', accent: '#ff71ce', name: 'bubblegum' },
    { bg: '#1a0033', fg: '#00ffff', accent: '#ff44cc', name: 'nightcore' },
    { bg: '#fff8f0', fg: '#5c3a1a', accent: '#cc8844', name: 'horse girl' },
    { bg: '#000000', fg: '#ff99cc', accent: '#ff0066', name: 'scene queen' },
  ],
  tiles: [
    ['', 'plain color'], ['assets/bg_stars_tile.gif', 'twinkling stars'], ['assets/tiles/tile_skulls.png', '☠ rainbow skulls'],
    ['assets/tiles/tile_skulls_pink.png', '☠ pink skulls'], ['assets/tiles/tile_hearts.png', '♥ hearts'],
    ['assets/tiles/tile_checker.png', 'checkerboard'], ['assets/tiles/tile_checker_pink.png', 'pink checker'],
    ['assets/tiles/tile_leopard.png', 'pink leopard'], ['assets/tiles/tile_leopard_tan.png', 'leopard'],
    ['assets/tiles/tile_zebra.png', 'zebra'], ['assets/tiles/tile_zebra_pink.png', 'pink zebra'], ['assets/tiles/tile_web.png', '🕸 spider webs'],
    ['assets/tiles/tile_stars_neon.png', '★ neon stars'], ['assets/tiles/tile_flowers.png', '✿ flowers'], ['assets/tiles/tile_bolts.png', '⚡ bolts'],
  ],
  fonts: [
    { v: '', label: 'MS Sans (default)' },
    { v: '"Comic Sans MS", cursive', label: 'Comic Sans (the people\'s font)' },
    { v: '"Courier New", monospace', label: 'Courier (h4x0r)' },
    { v: '"Times New Roman", serif', label: 'Times (fancy. suspicious.)' },
    { v: 'Verdana, sans-serif', label: 'Verdana (the sensible one)' },
    { v: 'Georgia, serif', label: 'Georgia (poetry blog)' },
    { v: '"Trebuchet MS", sans-serif', label: 'Trebuchet (layout site energy)' },
    { v: '"Lucida Console", monospace', label: 'Lucida Console (terminal goth)' },
  ],
  // decor gifs for under the picture (pick up to 3) and 88x31 buttons (up to 12)
  decorGifs: ['deco_welcome_banner', 'deco_new', 'deco_new_blue', 'deco_sparkle_bunny', 'deco_hearts_bar', 'deco_rainbow_bar', 'deco_flames_bar',
    'deco_smiley', 'deco_skull', 'deco_moon', 'deco_fairy', 'deco_dragon', 'deco_hamster', 'deco_dancing_baby', 'deco_email_bear',
    'deco_email_roses', 'deco_record_dj', 'deco_banana_tiny', 'deco_blinkie_zim', 'deco2_atom', 'deco2_mushroom', 'deco2_goth_inside',
    'deco2_ska_checker', 'deco2_downloadvirus'].map(n => `assets/${n}.gif`),
  badgeGifs: ['badge_best_viewed_with_eyes', 'badge_aim', 'badge_icq', 'badge_netscape', 'badge_ie_anim', 'badge_ie_sucks', 'badge_firefoxget',
    'badge_anybrowser', 'badge_geocities', 'badge_GuestWorldbutton', 'badge_winamp', 'badge_midi_files_now', 'badge_mspaint',
    'badge_built_with_microsoft_notepad', 'badge_hello_kitty', 'badge_8bit', 'badge_Sega-Elite', 'badge_coffee', 'badge_blink',
    'badge_aol-sucks'].map(n => `assets/${n}.gif`),
  zodiac: [['Aries', '♈'], ['Taurus', '♉'], ['Gemini', '♊'], ['Cancer', '♋'], ['Leo', '♌'], ['Virgo', '♍'], ['Libra', '♎'],
    ['Scorpio', '♏'], ['Sagittarius', '♐'], ['Capricorn', '♑'], ['Aquarius', '♒'], ['Pisces', '♓']],
  statuses: ['Single', 'In a Relationship', 'It\'s Complicated', 'Married to my Wacom', 'Engaged to my Xbox', 'Taken (by my homework)',
    'Swiss (neutral)', 'Divorced from my Tamagotchi', 'Saving myself for my Top 8', 'Married'],
  hereFor: ['Friends', 'Networking', 'Pen pals', 'The bulletins', 'Top 8 drama', 'Free layouts', 'Music', 'Glitter', 'Minesweeper', 'Gossip (respectfully)'],
  genders: ['Male', 'Female', 'Nonbinary', 'Prefer not to say', 'Robot (beep)', 'Cryptid'],
  reactions: [
    { from: 'brittany', text: "{you}'s new layout is giving 2004 and i mean that as the highest compliment xoxo" },
    { from: 'todd', text: 'I see you customized your page! The server noticed too. It is coping.' },
    { from: 'darkangel', text: 'your new page palette speaks to the void. the void says "nice."' },
    { from: 'nikki', text: 'NEW LAYOUT?? ok now your top 5 needs faster songs. i can fix that. i WILL fix that.' },
    { from: 'patrick', text: 'i clicked your page three times just to watch it load. it\'s beautiful' },
  ],
  comicReaction: { from: 'wes', text: 'comic sans on your profile. bold pick. frame data on that font is actually incredible, look it up' },

  // Open/refresh: called on every app-open. Already open → keep the unsaved edits (and scroll only if a section was
  // asked for); otherwise build the page fresh from state.me, starting at its top.
  build() {
    const body = document.querySelector('.window[data-app="customize"] .window-body');
    if (!body) return;
    body.dataset.built = '1';
    if (this.built && MS.state && MS.state.me) { this.scrollTo(body); return; }
    body.innerHTML = '';
    if (!MS.state || !MS.state.me) {
      // nobody to edit yet: the sign-up comes first
      this.jump = null;
      body.innerHTML = '<div class="cz-nome"><p><b>you don\'t have a page yet!</b></p><p>pick a screen name in OurSpace first, then come back here to decorate.</p><button class="btn98" id="cz-gosign">👥 go sign up</button></div>';
      body.querySelector('#cz-gosign').addEventListener('click', () => { WM.close('customize'); WM.open('myspace'); MS.show('home'); });
      return;
    }
    this.built = true;
    const me = MS.state.me;
    const d = JSON.parse(JSON.stringify(me));          // the draft; read back from the form on save
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    body.innerHTML = `
      <section class="cz-sec cz-block" data-sec="pic">
        <h3 class="cz-h">📷 picture &amp; name</h3>
        <div class="cz-avrow">
          <img class="cz-avnow" alt="your picture">
          <div class="cz-avside">
            <label class="cz-lbl" for="cz-name">screen name</label>
            <div class="cz-namerow"><input id="cz-name" maxlength="20" autocomplete="off" spellcheck="false"><button class="btn98" id="cz-dice" type="button" title="pick one for me">🎲 pick one for me</button></div>
            <div class="cz-err" id="cz-nameerr" role="alert"></div>
            <div class="cz-avbtns">
              <label class="btn98 cz-upload">📂 upload a picture<input type="file" accept="image/*" id="cz-file"></label>
              <button class="btn98" id="cz-paintav" type="button">🎨 use my Paint drawing</button>
            </div>
            <div class="cz-note">uploads get shrunk to 120px. animated gifs freeze (bandwidth reasons).</div>
          </div>
        </div>
        <div id="cz-gallery"></div>
        <div class="cz-fields">
          <label>tagline<input id="cz-tag" maxlength="80"></label>
          <label>mood<input id="cz-mood" maxlength="40" list="cz-moods"></label>
          <datalist id="cz-moods"></datalist>
        </div>
      </section>
      <section class="cz-sec cz-block" data-sec="about">
        <h3 class="cz-h">👤 about</h3>
        <div class="cz-fields">
          <label>gender<input id="cz-gender" maxlength="30" list="cz-genders" placeholder="(optional)"></label>
          <label>age<input id="cz-age" type="number" min="1" max="120" placeholder="(optional)"></label>
          <label>hometown<input id="cz-home" maxlength="40" placeholder="Somewhere, USA"></label>
          <label>zodiac sign<select id="cz-zodiac" class="cz-select"></select><input id="cz-zodiac-x" maxlength="30" placeholder="your own sign" hidden></label>
          <label>status<select id="cz-status" class="cz-select"></select><input id="cz-status-x" maxlength="40" placeholder="it's complicated (describe)" hidden></label>
          <datalist id="cz-genders"></datalist>
        </div>
        <div class="cz-lbl">here for</div>
        <div class="cz-checks" id="cz-herefor"></div>
        <div class="cz-fields cz-wide">
          <label>about me<textarea id="cz-about" rows="3" maxlength="1500"></textarea></label>
          <label>who i'd like to meet<textarea id="cz-meet" rows="2" maxlength="500"></textarea></label>
        </div>
        <div class="cz-lbl">interests</div>
        <div class="cz-fields" id="cz-ints"></div>
        <div class="cz-fields cz-wide" data-sec="blog">
          <label>blog title<input id="cz-blogtitle" maxlength="60" placeholder="my thoughts (unedited)"></label>
        </div>
      </section>
      <section class="cz-sec cz-block" data-sec="look">
        <h3 class="cz-h">🎨 look</h3>
        <div class="cz-lbl">theme</div>
        <div class="cz-swatches cz-themes" id="cz-swatches"></div>
        <div class="cz-lbl">background</div>
        <div class="cp-row cz-tiles" id="cz-tiles"></div>
        <div class="cz-lbl">font</div>
        <select id="cz-font" class="cz-select" aria-label="font"></select>
        <div class="cz-lbl">decor gifs <span class="cz-count" id="cz-decorn"></span> <span class="cz-note">under your picture</span></div>
        <div class="cz-gifgrid" id="cz-decor"></div>
        <div class="cz-lbl">my buttons (88x31s) <span class="cz-count" id="cz-badgen"></span></div>
        <div class="cz-gifgrid cz-badges" id="cz-badges"></div>
      </section>
      <section class="cz-sec cz-block" data-sec="music">
        <h3 class="cz-h">🎵 my top 5 <span class="cz-hnote">on your page, with ▶ previews</span></h3>
        <div id="cz-top5"></div>
      </section>
      <section class="cz-sec cz-block" data-sec="friends">
        <h3 class="cz-h">⭐ top 8 <span class="cz-hnote">friends only. choose wisely.</span></h3>
        <div class="cz-swatches" id="cz-top8"></div>
        <div class="cz-note">picking someone who's already ranked swaps the two. the drama is not our responsibility.</div>
      </section>
      <div class="cz-foot">
        <button class="btn98" id="cz-save">💾 save my page</button>
        <button class="btn98" id="cz-reset" title="theme, background, font, decor and buttons back to the defaults (right away)">↩ reset layout</button>
        <span class="cz-warn">warning: the neighborhood WILL have opinions about your redesign.</span>
      </div>`;
    const $ = sel => body.querySelector(sel);

    /* ---- picture: the preset gallery (MS.avatarGallery, shared with the sign-up), upload, Paint ---- */
    const avNow = $('.cz-avnow');
    const gallery = MS.avatarGallery(d.avatar, src => { setAvatar(src); Sfx.click(); });
    $('#cz-gallery').replaceWith(gallery);
    const setAvatar = src => {
      d.avatar = src;
      avNow.src = src;
      gallery.select(src);
    };
    setAvatar(d.avatar || MS.myAvatar());
    // any image (or canvas) → fits in 120x120, as a data URL small enough for localStorage
    const toAvatar = (source, w, h) => {
      const k = Math.min(1, 120 / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.imageSmoothingQuality = 'high';
      x.drawImage(source, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.88);
    };
    $('#cz-file').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type) || f.size > 15 * 1024 * 1024) { Sfx.error(); MS.toast('that doesn\'t look like a picture (or it\'s huge). try a .jpg, .png or .gif'); return; }
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => { setAvatar(toAvatar(img, img.naturalWidth, img.naturalHeight)); Sfx.click(); MS.toast('picture uploaded! (hit 💾 save to keep it)'); };
        img.onerror = () => { Sfx.error(); MS.toast('your computer says that picture is broken. try another one?'); };
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    });
    $('#cz-paintav').addEventListener('click', () => {
      const cv = document.getElementById('paint-canvas');
      if (!cv || !cv.width) { Sfx.error(); MS.toast('open Paint and draw something first 🎨 (then come back here)'); WM.open('paint'); return; }
      setAvatar(toAvatar(cv, cv.width, cv.height));
      Sfx.click();
      MS.toast('your Paint masterpiece is your picture now (hit 💾 save to keep it)');
    });

    /* ---- screen name + the profile fields ---- */
    const nameInp = $('#cz-name'), nameErr = $('#cz-nameerr');
    nameInp.value = d.guest ? '' : d.name;
    nameInp.placeholder = d.guest ? 'pick a screen name!' : d.name;
    nameInp.addEventListener('input', () => { nameErr.textContent = ''; });
    $('#cz-dice').addEventListener('click', () => { nameInp.value = MS.randomName(); nameErr.textContent = ''; Sfx.click(); });
    const fill = (sel, v) => { $(sel).value = v == null ? '' : v; };
    fill('#cz-tag', d.tag); fill('#cz-mood', d.mood); fill('#cz-gender', d.gender); fill('#cz-age', d.age);
    fill('#cz-home', d.hometown); fill('#cz-blogtitle', d.blogTitle); fill('#cz-about', d.about); fill('#cz-meet', d.meet);
    MS.moodPresets.forEach(m => { const o = mk('option'); o.value = m; $('#cz-moods').appendChild(o); });
    this.genders.forEach(g => { const o = mk('option'); o.value = g; $('#cz-genders').appendChild(o); });
    // a <select> of presets with a "custom…" option that reveals a text box
    const pickOrType = (selId, xId, options, value, blank) => {
      const sel = $(selId), x = $(xId);
      if (blank) { const o = mk('option', null, blank); o.value = ''; sel.appendChild(o); }
      options.forEach(([v, label]) => { const o = mk('option', null, label); o.value = v; sel.appendChild(o); });
      const cu = mk('option', null, 'custom…'); cu.value = '__x'; sel.appendChild(cu);
      const known = !value || options.some(([v]) => v === value);
      sel.value = known ? (value || '') : '__x';
      x.value = known ? '' : value;
      x.hidden = known;
      sel.addEventListener('change', () => { x.hidden = sel.value !== '__x'; if (!x.hidden) x.focus(); });
      return () => (sel.value === '__x' ? x.value.trim() : sel.value);
    };
    const zodiacVal = pickOrType('#cz-zodiac', '#cz-zodiac-x', this.zodiac.map(([s, g]) => [s, `${g} ${s}`]), d.zodiac, '(not telling)');
    const statusVal = pickOrType('#cz-status', '#cz-status-x', this.statuses.map(s => [s, s]), d.status, null);
    const here = new Set(String(d.hereFor || '').split(',').map(s => s.trim()).filter(Boolean));
    const hfBox = $('#cz-herefor');
    [...this.hereFor, ...[...here].filter(h => !this.hereFor.includes(h))].forEach(h => {
      const l = mk('label', 'cz-check');
      const cb = mk('input'); cb.type = 'checkbox'; cb.value = h; cb.checked = here.has(h);
      l.append(cb, ' ' + h);
      hfBox.appendChild(l);
    });
    const ints = $('#cz-ints');
    const intKeys = ['General', 'Music', 'Movies', 'Television', 'Books', 'Heroes'];
    const intPh = { General: 'video games, the mall, staying up too late', Music: 'bands, burned CDs, the one song you play on repeat', Movies: 'anything with a training montage',
      Television: 'what you rush home for', Books: 'the last thing you read (cereal boxes count)', Heroes: 'todd, probably' };
    intKeys.forEach(k => {
      const l = mk('label', null, k.toLowerCase());
      const ta = mk('textarea'); ta.rows = 2; ta.maxLength = 300; ta.dataset.k = k; ta.placeholder = intPh[k];
      ta.value = (d.interests && d.interests[k]) || '';
      l.appendChild(ta);
      ints.appendChild(l);
    });

    /* ---- look: theme (the preset swatches), tile, font, decor, buttons — each settable again by ↩ reset ---- */
    const sw = $('#cz-swatches');
    const colors = s => ({ bg: s.bg, fg: s.fg, accent: s.accent });
    const same = (a, b) => ['bg', 'fg', 'accent'].every(k => String(a[k] || '').toLowerCase() === String(b[k] || '').toLowerCase());
    let theme = colors(d.theme || this.swatches[0]);
    // colours from the old custom pickers stay on offer as a swatch of their own, so saving never repaints a page by surprise
    const themes = this.swatches.some(s => same(s, theme)) ? this.swatches : [{ ...theme, name: '✎ my own colours' }, ...this.swatches];
    const markSwatch = () => sw.querySelectorAll('.cz-swatch').forEach((b, i) => {
      const on = same(themes[i], theme);
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', on);
    });
    themes.forEach(s => {
      const b = mk('button', 'cz-swatch', s.name);
      b.type = 'button';
      b.style.background = s.bg; b.style.color = s.fg; b.style.borderColor = s.accent;
      b.addEventListener('click', () => { theme = colors(s); markSwatch(); Sfx.click(); });
      sw.appendChild(b);
    });
    const tilesBox = $('#cz-tiles');
    this.tiles.forEach(([v, label]) => {
      const l = mk('label');
      const r = mk('input'); r.type = 'radio'; r.name = 'cz-tile'; r.value = v;
      l.append(r, ' ' + label);
      if (v) { const im = mk('span', 'cz-tileprev'); im.style.backgroundImage = `url(${v})`; l.appendChild(im); }
      tilesBox.appendChild(l);
    });
    const setTile = v => {
      const radios = [...tilesBox.querySelectorAll('input')];
      (radios.find(r => r.value === (v || '')) || radios[0]).checked = true;
    };
    const fontSel = $('#cz-font');
    this.fonts.forEach(f => {
      const o = mk('option', null, f.label);
      o.value = f.v;
      fontSel.appendChild(o);
    });
    const setFont = v => { fontSel.value = v || ''; if (fontSel.selectedIndex < 0) fontSel.value = ''; };
    // toggle grids (decor ≤3, buttons ≤12): .picked is the live choice, .set(list) replaces it
    const gifPicker = (boxSel, countSel, all, max, full) => {
      const box = $(boxSel), count = $(countSel);
      const picked = [];
      const paint = () => { count.textContent = `(${picked.length}/${max})`; box.querySelectorAll('.cz-gif').forEach(b => b.classList.toggle('sel', picked.includes(b.dataset.src))); };
      const tile = src => {
        const b = mk('button', 'cz-gif');
        b.type = 'button'; b.dataset.src = src; b.title = src.split('/').pop().replace(/\.\w+$/, '').replace(/^(deco2?|badge)_/, '').replace(/_/g, ' ');
        const im = mk('img'); im.loading = 'lazy'; im.alt = b.title; im.src = src;
        b.appendChild(im);
        b.addEventListener('click', () => {
          const i = picked.indexOf(src);
          if (i >= 0) picked.splice(i, 1);
          else if (picked.length >= max) { Sfx.error(); MS.toast(full); return; }
          else picked.push(src);
          Sfx.click(); paint();
        });
        box.appendChild(b);
      };
      all.forEach(tile);
      const set = list => {
        const srcs = [...new Set((Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s))].slice(0, max);
        picked.splice(0, picked.length, ...srcs);
        srcs.forEach(src => { if (![...box.children].some(b => b.dataset.src === src)) tile(src); });   // one that isn't on offer any more
        paint();
      };
      return { picked, set };
    };
    const decor = gifPicker('#cz-decor', '#cz-decorn', this.decorGifs, 3, 'three gifs max. your page is not a gif museum. (yet.)');
    const badges = gifPicker('#cz-badges', '#cz-badgen', this.badgeGifs, 12, 'twelve buttons max. the badge wall has a weight limit.');
    const setLook = m => {
      theme = colors(m.theme || this.swatches[0]);
      markSwatch();
      setTile(m.bgTile);
      setFont(m.font);
      decor.set(m.decor);
      badges.set(m.badges);
    };
    setLook(d);

    /* ---- music: the top 5 (visitors have no profile song — the top 5 is the soundtrack) ---- */
    if (window.SongSearch && SongSearch.picker) {
      $('#cz-top5').appendChild(SongSearch.picker({
        max: 5, picked: (d.top5 || []).slice(0, 5), placeholder: 'search a song for your top 5…',
        onChange: picked => { d.top5 = picked.slice(0, 5); },
      }));
    } else {
      $('#cz-top5').appendChild(mk('div', 'cz-note', '🔎 song search is still loading… close and reopen Edit My Page in a sec.'));
    }

    /* ---- top 8: one dropdown per slot; picking someone who's already ranked swaps the two slots ---- */
    const t8 = $('#cz-top8');
    const top8 = MS.myTop8();
    const pool = [...new Set([...top8, ...MS.state.friends.filter(id => MS.people[id])])];
    top8.forEach((id, i) => {
      const sel = mk('select', 'cz-select');
      pool.forEach(fid => {
        const o = mk('option', null, `#${i + 1} ${MS.people[fid].name}`);
        o.value = fid;
        if (fid === id) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        const j = top8.indexOf(sel.value);
        if (j >= 0 && j !== i) { top8[j] = top8[i]; t8.children[j].value = top8[j]; }
        top8[i] = sel.value;
      });
      t8.appendChild(sel);
    });

    /* ---- save / reset ---- */
    $('#cz-save').addEventListener('click', () => {
      const cur = MS.state.me;
      if (!cur) { WM.close('customize'); return; }
      let name = nameInp.value.trim();
      if (!name && d.guest) name = cur.name;          // a guest who didn't pick a name stays "guest"
      if (name !== cur.name) {
        const err = MS.validName(name);
        if (err) { nameErr.textContent = err; Sfx.error(); this.scrollTo(body, 'pic'); nameInp.focus({ preventScroll: true }); return; }
      }
      const old = { name: cur.name, font: cur.font };
      d.name = name;
      if (name !== old.name) delete d.guest;
      d.tag = $('#cz-tag').value.trim();
      d.mood = $('#cz-mood').value.trim();
      d.gender = $('#cz-gender').value.trim();
      const age = parseInt($('#cz-age').value, 10);
      d.age = age >= 1 && age <= 120 ? age : '';
      d.hometown = $('#cz-home').value.trim();
      d.zodiac = zodiacVal();
      d.status = statusVal() || 'Single';
      d.hereFor = [...hfBox.querySelectorAll('input:checked')].map(c => c.value).join(', ') || 'Friends';
      d.about = $('#cz-about').value.trim();
      d.meet = $('#cz-meet').value.trim();
      d.blogTitle = $('#cz-blogtitle').value.trim();
      d.interests = {};
      ints.querySelectorAll('textarea').forEach(ta => { d.interests[ta.dataset.k] = ta.value.trim(); });
      d.theme = { ...theme };
      const tile = tilesBox.querySelector('input:checked');
      d.bgTile = tile ? tile.value : '';
      d.font = fontSel.value;
      d.decor = decor.picked.slice();
      d.badges = badges.picked.slice();
      d.top8 = top8.slice();
      d.blog = cur.blog;                                // entries written while the editor was open stay
      delete d.song;                                    // (no profile songs for visitors)
      MS.state.me = d;
      MS.save();
      MS.meChanged();
      if (name !== old.name && window.Chat) Chat.sysLine(`* ${old.name} is now known as ${name}`);
      Sfx.tada();
      MS.toast('your page has been renovated ✨');
      const r = (d.font && d.font.includes('Comic') && !(old.font || '').includes('Comic')) ? this.comicReaction
        : this.reactions[Math.floor(Math.random() * this.reactions.length)];
      if (MS.people[r.from]) setTimeout(() => {
        MS.pushFeed({ type: 'status', from: r.from, text: r.text, time: MS.now() });
        MS.state.myWall.push({ from: r.from, text: r.text, time: MS.now() });
        MS.save();
        if (MS.view.page === 'home') MS.render();
        MS.toast(MS.people[r.from].name + ' has opinions about your new layout!', 'home');
      }, 7000 + Math.random() * 8000);
      WM.close('customize');
      WM.open('myspace');
      MS.show('home');
    });
    // ↩ reset: the layout goes back to the defaults right away (saved); the look section follows, and everything else
    // on the page keeps its unsaved edits
    $('#cz-reset').addEventListener('click', () => {
      const cur = MS.state.me;
      if (!cur) return;
      const def = MS.defaultMe();
      Object.assign(cur, { theme: def.theme, bgTile: '', font: '', decor: def.decor, badges: def.badges });
      MS.save();
      setLook(cur);
      this.scrollTo(body, 'look');
      Sfx.click();
      MS.toast('layout back to factory settings. respectable.');
      if (MS.view.page === 'home') MS.render();
    });

    body.scrollTop = 0;                                 // a fresh open starts at the top (or wherever openEditor asked)
    gallery.reveal();
    this.scrollTo(body);
  },

  // scroll the editor to a section (data-sec) — the one asked for, else the pending this.jump (used up either way)
  scrollTo(body, sec) {
    const want = sec || this.jump;
    this.jump = null;
    const el = want && body.querySelector(`[data-sec="${want}"]`);
    if (!el) return;
    const pad = el.tagName === 'SECTION' ? 0 : 30;      // inside a section: clear its sticky heading
    if (body.scrollHeight > body.clientHeight + 4) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - pad;
    else el.scrollIntoView({ block: 'start' });
    if (want === 'blog') { const t = body.querySelector('#cz-blogtitle'); if (t) t.focus({ preventScroll: true }); }
  },
};

/* ========================= CONTROL PANEL ========================= */
const ControlPanel = {
  build() {
    const body = document.querySelector('.window[data-app="settings"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    const curCursor = localStorage.getItem('malten_cursor') || 'default';
    const curTrail = localStorage.getItem('malten_trail') || 'stars';
    const curSaver = localStorage.getItem('malten_saver') || 'pipes';

    const radio = (name, value, label, checked) =>
      `<label class="cp-opt"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}> ${label}</label>`;

    body.innerHTML = `
      <div class="cz-sec"><b>🖱 cursor</b><div class="cp-row">
        ${radio('cp-cursor', 'default', '↖ default', curCursor === 'default')}
        ${radio('cp-cursor', 'wand', '🪄 wand', curCursor === 'wand')}
        ${radio('cp-cursor', 'sword', '🗡️ sword', curCursor === 'sword')}
        ${radio('cp-cursor', 'banana', '🍌 banana', curCursor === 'banana')}
        ${radio('cp-cursor', 'heart', '💜 heart', curCursor === 'heart')}
        ${radio('cp-cursor', 'dino', '🦖 dino', curCursor === 'dino')}
      </div></div>
      <div class="cz-sec"><b>✨ mouse trail</b><div class="cp-row">
        ${radio('cp-trail', 'stars', '✦ stars', curTrail === 'stars')}
        ${radio('cp-trail', 'comet', '☄ comet', curTrail === 'comet')}
        ${radio('cp-trail', 'bubbles', '○ bubbles', curTrail === 'bubbles')}
        ${radio('cp-trail', 'hearts', '💜 hearts', curTrail === 'hearts')}
      </div><p style="font-size:10px;color:#666;margin:2px 0 0;">(toggle trails on/off with ✨ in the tray)</p></div>
      <div class="cz-sec"><b>🌌 screensaver</b><div class="cp-row">
        ${radio('cp-saver', 'starfield', '🌠 starfield', curSaver === 'starfield')}
        ${radio('cp-saver', 'pipes', '🧵 pipes', curSaver === 'pipes')}
        ${radio('cp-saver', 'toasters', '🍞 flying toast', curSaver === 'toasters')}
        ${radio('cp-saver', 'matrix', '🟩 the matrix', curSaver === 'matrix')}
      </div>
      <button class="btn98" id="cp-preview">▶ preview screensaver</button></div>`;

    body.querySelectorAll('input[name="cp-cursor"]').forEach(r =>
      r.addEventListener('change', () => { setCursor(r.value); Sfx.click(); }));
    body.querySelectorAll('input[name="cp-trail"]').forEach(r =>
      r.addEventListener('change', () => { setTrail(r.value); Sfx.click(); }));
    body.querySelectorAll('input[name="cp-saver"]').forEach(r =>
      r.addEventListener('change', () => { Screensaver.setMode(r.value); Sfx.click(); }));
    body.querySelector('#cp-preview').addEventListener('click', () => Screensaver.start());
  },
};

/* ========================= SPAM DRIP ========================= */
const SpamDrip = {
  init() {
    setInterval(() => {
      if (Math.random() > 0.15) return;
      const have = new Set((MS.state.spam || []).map(s => s.subject));
      const fresh = MS.spamLetters.filter(s => !have.has(s.subject));
      if (!fresh.length) return;
      const s = fresh[Math.floor(Math.random() * fresh.length)];
      MS.state.spam.push({ ...s, time: MS.now(), read: false });
      MS.save();
      MS.toast('new spam from ' + (MS.people[s.from] ? MS.people[s.from].name : s.from) + '… it\'s probably a curse', 'inbox', '__spam');
      MS.paintTabs();
    }, 70000);
  },
};

/* ============================ BOOT ============================ */
// top-level const doesn't attach to window — export explicitly for the other modules' guards
Object.assign(window, { Presence, BuddyList, Chat, Nudge, Horoscope, Webring, Glitter, Customizer, ControlPanel, SpamDrip });

document.addEventListener('DOMContentLoaded', () => {
  // wait until MS has loaded state (ourspace.js boot runs first)
  const boot = () => {
    if (!MS.state) { setTimeout(boot, 300); return; }
    Presence.init();
    Nudge.init();
    SpamDrip.init();
    Webring.initWidgets();
    BuddyList.paint();          // sidebar list was built before presence existed
    if (MS.paintSidebar) MS.paintSidebar();

    document.addEventListener('app-open', e => {
      if (e.detail === 'glitter') Glitter.build();
      if (e.detail === 'customize') Customizer.build();
      if (e.detail === 'settings') ControlPanel.build();
      if (e.detail === 'webring') Webring.paint();
    });
    document.addEventListener('app-close', e => {
      if (e.detail === 'myspace') Chat.onClose();
      if (e.detail === 'customize') {
        Customizer.built = false;                                // the next open starts from the saved page again
        if (window.TopSongs && TopSongs.stop) TopSongs.stop();   // the pickers' ▶ previews
      }
    });
  };
  boot();
});
