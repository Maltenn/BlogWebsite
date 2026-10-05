/* ============================================================
   extras.js — the era pack: Presence + AIM buddy list, #ourspace
   IRC chatroom, MSN nudges, daily horoscope, webring, glitter
   text studio, profile customizer, control panel, spam drip.
   Loads after ourspace.js (needs MS, Sfx, WM, Guestbook).
   ============================================================ */

/* ============================ PRESENCE ============================ */
const Presence = {
  online: {}, away: {},

  init() {
    Object.keys(MS.people).forEach(id => {
      if (Math.random() < 0.55) {
        this.online[id] = true;
        if (Math.random() < 0.3) this.away[id] = this.awayMsg(id);
      }
    });
    this.online.todd = true;               // todd is always online. he is load-bearing.
    delete this.away.todd;
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
    const ids = Object.keys(MS.people).filter(i => i !== 'todd');
    const id = ids[Math.floor(Math.random() * ids.length)];
    if (this.online[id]) {
      if (Math.random() < 0.35) {
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
    body.innerHTML = `
      <div class="bl-me">🟣 <b>malten</b><div class="bl-mystatus">online — building the site</div></div>
      <div id="bl-list"></div>
      <div class="bl-foot">${Object.keys(MS.people).length} buddies · sounds on</div>`;
    this.paint();
  },

  paint() {
    const list = document.getElementById('bl-list');
    if (!list) return;
    list.innerHTML = '';
    const ids = Object.keys(MS.people);
    const on = ids.filter(id => Presence.online[id] && !Presence.away[id]);
    const away = ids.filter(id => Presence.away[id]);
    const off = ids.filter(id => !Presence.online[id]);

    const group = (label, arr, cls) => {
      const g = document.createElement('div');
      g.className = 'bl-group';
      g.textContent = `▼ ${label} (${arr.length})`;
      list.appendChild(g);
      arr.forEach(id => {
        const p = MS.people[id];
        const row = document.createElement('div');
        row.className = 'bl-row ' + cls;
        const ds = (MS.state.dialogueState || {})[id];
        const activeConvo = MS.dialogues[id] && ds && !ds.done;
        row.innerHTML = `<span class="bl-dot"></span>${p.name}${activeConvo ? ' <span class="bl-mail blink">✉</span>' : ''}`;
        if (cls === 'away') row.title = 'away: ' + Presence.away[id];
        row.addEventListener('click', () => {
          if (cls === 'away' && !row.dataset.shown) {
            row.dataset.shown = '1';
            const msg = document.createElement('div');
            msg.className = 'bl-awaymsg';
            msg.textContent = '⏳ ' + Presence.away[id];
            row.insertAdjacentElement('afterend', msg);
            Sfx.click();
            return;
          }
          WM.open('myspace');
          MS.show('inbox', id);
        });
        list.appendChild(row);
      });
    };
    group('Buddies', on, 'on');
    group('Away', away, 'away');
    group('Offline', off, 'off');
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
    const ids = Object.keys(MS.people);
    const onlineIds = ids.filter(id => Presence.online[id]);
    const pool = onlineIds.length >= 3 ? onlineIds : ids;
    const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
    const roll = Math.random();

    if (roll < 0.5) {
      // banter line aimed at someone, maybe answered
      const pairs = [];
      pool.forEach(a => {
        const b = MS.people[a].banter || {};
        Object.keys(b).forEach(t => b[t].forEach((line, i) => {
          const key = `${a}>${t}:${i}`;
          if (!this.chatUsed[key]) pairs.push({ a, t, line, key });
        }));
      });
      if (!pairs.length) { this.chatUsed = {}; return; }
      const p = rnd(pairs);
      this.chatUsed[p.key] = 1;
      this.addLine({ kind: 'msg', from: p.a, text: `${MS.people[p.t] ? MS.people[p.t].name : p.t}: ${p.line}` });
      if (MS.people[p.t] && Math.random() < 0.55) {
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
      // authored 2006 chatroom one-liners from the line bank
      this.addLine({ kind: 'msg', from: rnd(pool), text: rnd(MS.bank('chatLines')) });
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
    const ids = Object.keys(MS.people);
    let target = ids.find(id => lower.includes(id) || lower.includes((MS.people[id].name || '').toLowerCase()));
    if (!target) {
      target = ids.find(id => {
        const kw = MS.people[id].keywords || {};
        return Object.keys(kw).some(k => lower.includes(k));
      });
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
    this.log.forEach(l => {
      const row = document.createElement('div');
      row.className = 'chat-line ' + l.kind;
      if (l.kind === 'sys') row.textContent = l.text;
      else if (l.kind === 'me') row.textContent = `* ${l.from === 'you' ? 'malten' : MS.people[l.from].name} ${l.text}`;
      else {
        const nick = document.createElement('b');
        nick.className = 'chat-nick' + (l.from === 'you' ? ' me' : '');
        nick.textContent = `<${l.from === 'you' ? 'malten' : MS.people[l.from].name}>`;
        if (l.from !== 'you') nick.addEventListener('click', () => { WM.open('myspace'); MS.show('profile', l.from); });
        row.appendChild(nick);
        row.appendChild(document.createTextNode(' ' + l.text));
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
    you.textContent = '@malten (you)';
    el.appendChild(you);
    online.forEach(id => {
      const row = document.createElement('div');
      row.className = 'chat-nickrow' + (Presence.away[id] ? ' away' : '');
      row.textContent = (Presence.away[id] ? '⏳ ' : '') + MS.people[id].name;
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
    const online = Object.keys(MS.people).filter(id => Presence.online[id] && MS.state.friends.includes(id));
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
      t.msgs.push({ who: 'them', text: MS.botReply(id, 'nudge'), time: MS.now() });
      MS.save();
      if (MS.view.page === 'inbox' && MS.view.arg === id) MS.render();
      else { t.unread = true; MS.paintTabs(); }
      if (Math.random() < 0.5) { Sfx.buzz(); this.shake(); MS.toast(MS.people[id].name + ' nudged you back. obviously.'); }
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

    const moods = ['chaotic good', 'suspiciously lucky', 'main character', 'cozy with a chance of drama', 'unstoppable (mildly)', 'sparkly', 'contemplative (rare)'];
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
    const special = pick([
      'the stars say check your guestbook. someone meant what they wrote.',
      'mercury says your minesweeper record falls today. mercury is rarely wrong about minesweeper.',
      'someone viewed your profile 4 times today. the stars know who. (it was tony)',
      'your profile song choice will be validated by a stranger this week. hold the line.',
      'an aries with your exact name will have a great day. draw your own conclusions.',
    ]);

    body.innerHTML = `
      <div class="horo-head">🔮 daily forecast — <b>aries</b></div>
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
      <input id="glit-input" class="glit-input" placeholder="type something sparkly…" maxlength="60" value="malten rules ok">
      <div class="glit-preview" id="glit-preview"></div>
      <div class="paint-toolbar">
        <button class="btn98" id="glit-wall">📌 post to my wall</button>
        <button class="btn98" id="glit-gb">📖 sign the guestbook</button>
        <button class="btn98" id="glit-copy">📋 copy</button>
      </div>`;
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
      Guestbook.postExternal('malten', text);
      MS.toast('the guestbook has been glitterized');
    }
    Sfx.tada();
  },
};

/* ======================= PROFILE CUSTOMIZER ======================= */
const Customizer = {
  swatches: [
    { bg: '#f3eefb', fg: '#000000', accent: '#9370DB', name: 'classic purple' },
    { bg: '#0a0a0a', fg: '#e0d5f5', accent: '#c3002f', name: 'midnight' },
    { bg: '#e8f4ff', fg: '#003366', accent: '#ff6600', name: 'sk8r blue' },
    { bg: '#fffbe0', fg: '#5c4a00', accent: '#ffcc00', name: 'banana' },
    { bg: '#0d1b0d', fg: '#c8f5c8', accent: '#7fff7f', name: 'CRT green' },
    { bg: '#ffe8f0', fg: '#5c1a33', accent: '#ff71ce', name: 'bubblegum' },
    { bg: '#1a0033', fg: '#00ffff', accent: '#ff44cc', name: 'nightcore' },
    { bg: '#fff8f0', fg: '#5c3a1a', accent: '#cc8844', name: 'horse girl' },
  ],
  fonts: [
    { v: '', label: 'MS Sans (default)' },
    { v: '"Comic Sans MS", cursive', label: 'Comic Sans (the people\'s font)' },
    { v: '"Courier New", monospace', label: 'Courier (h4x0r)' },
    { v: '"Times New Roman", serif', label: 'Times (fancy. suspicious.)' },
  ],
  reactions: [
    { from: 'brittany', text: "malten's new layout is giving 2004 and i mean that as the highest compliment xoxo" },
    { from: 'todd', text: 'I see you customized your page! The server noticed too. It is coping.' },
    { from: 'darkangel', text: 'your new page palette speaks to the void. the void says "nice."' },
    { from: 'nikki', text: 'NEW LAYOUT?? ok now it needs a faster profile song. i can fix that. i WILL fix that.' },
    { from: 'patrick', text: 'i clicked your page three times just to watch it load. it\'s beautiful' },
  ],
  comicReaction: { from: 'wes', text: 'comic sans on your profile. bold pick. frame data on that font is actually incredible, look it up' },

  build() {
    const body = document.querySelector('.window[data-app="customize"] .window-body');
    if (!body) return;
    body.dataset.built = '1';
    const mp = MS.state.myProfile || {};
    const songs = [
      { name: 'malten_theme.mid', pattern: [0, 0, 7, 5, 3, 5, 7, 10], bpm: 140 },
      { name: 'untitled banger.mid', pattern: [0, 3, 7, 3, 10, 7, 12, 7], bpm: 130 },
      { name: '4am insomnia loop.mid', pattern: [12, 10, 7, 10, 5, 7, 3, 0], bpm: 96 },
      ...Object.values(MS.people).filter(p => p.song && p.song.url).map(p => p.song),
    ];

    body.innerHTML = `
      <div class="cz-sec"><b>🎨 page theme</b><div class="cz-swatches" id="cz-swatches"></div></div>
      <div class="cz-sec"><b>🌌 background</b><div class="cp-row">
        <label><input type="radio" name="cz-tile" value=""> plain color</label>
        <label><input type="radio" name="cz-tile" value="assets/bg_stars_tile.gif"> twinkling stars</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_skulls.png"> ☠ rainbow skulls</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_skulls_pink.png"> ☠ pink skulls</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_hearts.png"> ♥ hearts</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_checker.png"> checkerboard</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_checker_pink.png"> pink checker</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_leopard.png"> pink leopard</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_zebra.png"> zebra</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_web.png"> 🕸 spider webs</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_stars_neon.png"> ★ neon stars</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_flowers.png"> ✿ flowers</label>
        <label><input type="radio" name="cz-tile" value="assets/tiles/tile_bolts.png"> ⚡ bolts</label>
      </div></div>
      <div class="cz-sec"><b>🔤 font</b><select id="cz-font" class="cz-select"></select></div>
      <div class="cz-sec"><b>🎵 profile song</b><select id="cz-song" class="cz-select"></select></div>
      <div class="paint-toolbar">
        <button class="btn98" id="cz-save">💾 save my page</button>
        <button class="btn98" id="cz-reset">↩ reset to default</button>
      </div>
      <p style="font-size:10px;color:#666;margin:4px 0 0;">warning: the neighborhood WILL have opinions about your redesign.</p>`;

    const sw = body.querySelector('#cz-swatches');
    this.swatches.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'cz-swatch' + ((mp.theme && mp.theme.bg === s.bg) ? ' sel' : '');
      b.style.background = s.bg;
      b.style.color = s.fg;
      b.style.borderColor = s.accent;
      b.textContent = s.name;
      b.dataset.i = i;
      b.addEventListener('click', () => {
        sw.querySelectorAll('.cz-swatch').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      sw.appendChild(b);
    });
    const tiles = body.querySelectorAll('input[name="cz-tile"]');
    tiles.forEach(t => { t.checked = (mp.bgTile || '') === t.value; });
    if (!mp.bgTile) tiles[0].checked = true;

    const fontSel = body.querySelector('#cz-font');
    this.fonts.forEach(f => {
      const o = document.createElement('option');
      o.value = f.v; o.textContent = f.label;
      if ((mp.font || '') === f.v) o.selected = true;
      fontSel.appendChild(o);
    });
    const songSel = body.querySelector('#cz-song');
    songs.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = s.artist ? `${s.name} — ${s.artist}` : s.name;
      if (mp.song && mp.song.name === s.name) o.selected = true;
      songSel.appendChild(o);
    });

    body.querySelector('#cz-save').addEventListener('click', () => {
      const selSwatch = sw.querySelector('.cz-swatch.sel');
      const theme = selSwatch ? this.swatches[+selSwatch.dataset.i] : null;
      const tile = [...tiles].find(t => t.checked);
      const font = fontSel.value;
      const song = songs[+songSel.value];
      MS.state.myProfile = {
        theme: theme ? { bg: theme.bg, fg: theme.fg, accent: theme.accent } : (MS.state.myProfile || {}).theme,
        bgTile: tile && tile.value ? tile.value : undefined,
        font: font || undefined,
        song,
      };
      MS.save();
      Sfx.tada();
      MS.toast('your page has been renovated ✨');
      const r = (font && font.includes('Comic')) ? this.comicReaction
        : this.reactions[Math.floor(Math.random() * this.reactions.length)];
      setTimeout(() => {
        MS.pushFeed({ type: 'status', from: r.from, text: r.text, time: MS.now() });
        MS.state.myWall.push({ from: r.from, text: r.text, time: MS.now() });
        MS.save();
        MS.toast(MS.people[r.from].name + ' has opinions about your new layout!', 'home');
      }, 7000 + Math.random() * 8000);
      WM.close('customize');
      WM.open('myspace');
      MS.show('home');
    });
    body.querySelector('#cz-reset').addEventListener('click', () => {
      MS.state.myProfile = null;
      MS.save();
      MS.toast('back to factory settings. respectable.');
      if (MS.view.page === 'home') MS.render();
    });
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
    const curSaver = localStorage.getItem('malten_saver') || 'starfield';

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
    });
  };
  boot();
});
