/* ============================================================
   apps.js — the programs: Minesweeper, Paint, Winamp-style
   player (Spotify + built-in chiptune fallback), Guestbook,
   and the My Pictures gallery.
   ============================================================ */

/* =========================== MINESWEEPER =========================== */
const Mines = {
  W: 9, H: 9, N: 10,
  grid: [], open: [], flag: [],
  alive: true, won: false, started: false,
  time: 0, timer: null,

  init() {
    const body = document.querySelector('.window[data-app="mines"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = `
      <div class="mines-top">
        <span class="lcd" id="mines-count">010</span>
        <button class="btn98" id="mines-face">🙂</button>
        <span class="lcd" id="mines-time">000</span>
      </div>
      <div id="mines-grid"></div>
      <p style="font-size:10px;color:#666;margin:6px 0 0;">left click: dig &nbsp;•&nbsp; right click: flag 🚩</p>`;
    document.getElementById('mines-face').addEventListener('click', () => this.newGame());
    document.getElementById('mines-grid').addEventListener('contextmenu', e => e.preventDefault());
    this.newGame();
  },

  newGame() {
    this.alive = true; this.won = false; this.started = false;
    this.time = 0;
    clearInterval(this.timer);
    this.grid = Array(this.W * this.H).fill(0);
    this.open = Array(this.W * this.H).fill(false);
    this.flag = Array(this.W * this.H).fill(false);
    document.getElementById('mines-face').textContent = '🙂';
    document.getElementById('mines-time').textContent = '000';
    this.render();
  },

  plant(safe) {
    let planted = 0;
    while (planted < this.N) {
      const i = Math.floor(Math.random() * this.W * this.H);
      if (i !== safe && this.grid[i] !== 9) { this.grid[i] = 9; planted++; }
    }
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === 9) continue;
      this.grid[i] = this.neighbors(i).filter(n => this.grid[n] === 9).length;
    }
  },

  neighbors(i) {
    const x = i % this.W, y = Math.floor(i / this.W), out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < this.W && ny >= 0 && ny < this.H) out.push(ny * this.W + nx);
    }
    return out;
  },

  dig(i) {
    if (!this.alive || this.won || this.open[i] || this.flag[i]) return;
    if (!this.started) {
      this.started = true;
      this.plant(i);
      this.timer = setInterval(() => {
        this.time = Math.min(999, this.time + 1);
        document.getElementById('mines-time').textContent = String(this.time).padStart(3, '0');
      }, 1000);
    }
    const stack = [i];
    while (stack.length) {
      const c = stack.pop();
      if (this.open[c] || this.flag[c]) continue;
      this.open[c] = true;
      if (this.grid[c] === 0) this.neighbors(c).forEach(n => { if (!this.open[n]) stack.push(n); });
    }
    if (this.grid[i] === 9) {
      this.alive = false;
      clearInterval(this.timer);
      document.getElementById('mines-face').textContent = '💀';
      Sfx.error();
    } else {
      Sfx.click();
      const closed = this.open.filter(o => !o).length;
      if (closed === this.N) {
        this.won = true;
        clearInterval(this.timer);
        document.getElementById('mines-face').textContent = '😎';
        Sfx.tada();
      }
    }
    this.render();
  },

  toggleFlag(i) {
    if (!this.alive || this.won || this.open[i]) return;
    this.flag[i] = !this.flag[i];
    Sfx.click();
    this.render();
  },

  render() {
    const grid = document.getElementById('mines-grid');
    grid.innerHTML = '';
    const flags = this.flag.filter(Boolean).length;
    document.getElementById('mines-count').textContent = String(Math.max(0, this.N - flags)).padStart(3, '0');
    for (let i = 0; i < this.W * this.H; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      if (this.open[i]) {
        c.classList.add('open');
        if (this.grid[i] === 9) { c.classList.add('boom'); c.textContent = '💣'; }
        else if (this.grid[i] > 0) { c.textContent = this.grid[i]; c.classList.add('m' + this.grid[i]); }
      } else if (this.flag[i]) {
        c.textContent = '🚩';
      } else if (!this.alive && this.grid[i] === 9) {
        c.textContent = '💣';
      }
      c.addEventListener('click', () => this.dig(i));
      c.addEventListener('contextmenu', e => { e.preventDefault(); this.toggleFlag(i); });
      grid.appendChild(c);
    }
  },
};

/* ============================== PAINT ============================== */
const Paint = {
  tool: 'brush', color: '#4b2d83', size: 4, drawing: false,

  init() {
    const body = document.querySelector('.window[data-app="paint"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = `
      <div class="paint-toolbar">
        <button class="btn98 tool-on" data-tool="brush">🖌 brush</button>
        <button class="btn98" data-tool="pencil">✏ pencil</button>
        <button class="btn98" data-tool="spray">💨 spray</button>
        <button class="btn98" data-tool="eraser">🧽 eraser</button>
        <input type="range" id="paint-size" min="1" max="24" value="4" title="brush size">
        <button class="btn98" id="paint-clear">🗑 clear</button>
        <button class="btn98" id="paint-save">💾 save</button>
      </div>
      <canvas id="paint-canvas" width="336" height="220"></canvas>
      <div class="paint-palette"></div>`;

    const canvas = document.getElementById('paint-canvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const colors = ['#000000','#7f7f7f','#c0c0c0','#ffffff','#880015','#ed1c24','#ff7f27','#fff200',
                    '#22b14c','#00a2e8','#3f48cc','#4b2d83','#9370DB','#ffaec9','#b97a57','#C3B1E1'];
    const pal = body.querySelector('.paint-palette');
    colors.forEach((col, idx) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (col === this.color ? ' sel' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => {
        this.color = col;
        pal.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
        sw.classList.add('sel');
      });
      pal.appendChild(sw);
    });

    body.querySelectorAll('[data-tool]').forEach(btn => btn.addEventListener('click', () => {
      this.tool = btn.dataset.tool;
      body.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('tool-on'));
      btn.classList.add('tool-on');
    }));
    document.getElementById('paint-size').addEventListener('input', e => { this.size = +e.target.value; });
    document.getElementById('paint-clear').addEventListener('click', () => {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    });
    document.getElementById('paint-save').addEventListener('click', () => {
      const a = document.createElement('a');
      a.download = 'malten-masterpiece.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
      Sfx.tada();
    });

    const pos = e => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
    };
    let prev = null;
    canvas.addEventListener('pointerdown', e => {
      this.drawing = true; prev = pos(e);
      canvas.setPointerCapture(e.pointerId);
      this.stroke(ctx, prev, prev);
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drawing) return;
      const p = pos(e);
      this.stroke(ctx, prev, p);
      prev = p;
    });
    canvas.addEventListener('pointerup', () => { this.drawing = false; });
  },

  stroke(ctx, a, b) {
    if (this.tool === 'spray') {
      ctx.fillStyle = this.color;
      for (let i = 0; i < this.size * 3; i++) {
        const ang = Math.random() * Math.PI * 2, r = Math.random() * this.size * 1.6;
        ctx.fillRect(b.x + Math.cos(ang) * r, b.y + Math.sin(ang) * r, 1, 1);
      }
      return;
    }
    ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color;
    ctx.lineWidth = this.tool === 'pencil' ? 1 : (this.tool === 'eraser' ? this.size * 2 : this.size);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  },
};

/* ======================= WINAMP-STYLE PLAYER ======================= */
const Amp = {
  // element lookups scoped to the player root so they work even while it's detached from the page
  $(id) { return (this.rootEl && this.rootEl.querySelector('#' + id)) || document.getElementById(id); },
  setText(id, text) { const el = this.$(id); if (el) el.textContent = text; },
  tracks: [], current: 0, playing: false, demo: false,
  audio: null, vol: 0.35,
  chipTimer: null, chipStep: 0,
  visRaf: null,

  // one persistent player element that can be re-parented (My Page re-renders often;
  // moving the node keeps playback going)
  mount(container) {
    if (!this.rootEl) {
      this.rootEl = document.createElement('div');
      this.rootEl.className = 'wa-root';
      container.appendChild(this.rootEl);   // must be in the document before init wires its buttons by id
      this.init(this.rootEl);
      return;
    }
    container.appendChild(this.rootEl);
  },

  async init(container) {
    const body = container || document.querySelector('.window[data-app="winamp"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.classList.add('winamp-body');
    body.innerHTML = `
      <div class="wa-lcd"><span class="wa-title" id="wa-title">*** MALTEN AMP v5.0 ***</span><span id="wa-time">--:--</span></div>
      <canvas class="wa-vis" id="wa-vis" width="300" height="40"></canvas>
      <div class="wa-controls">
        <button class="btn98" id="wa-prev">⏮</button>
        <button class="btn98" id="wa-play">▶</button>
        <button class="btn98" id="wa-stop">⏹</button>
        <button class="btn98" id="wa-next">⏭</button>
        <input type="range" id="wa-vol" min="0" max="100" value="35" title="volume">
      </div>
      <div class="wa-playlist" id="wa-playlist">loading playlist…</div>`;

    this.$('wa-prev').addEventListener('click', () => this.skip(-1));
    this.$('wa-next').addEventListener('click', () => this.skip(1));
    this.$('wa-play').addEventListener('click', () => this.playing ? this.pause() : this.play());
    this.$('wa-stop').addEventListener('click', () => this.stop());
    this.$('wa-vol').addEventListener('input', e => {
      this.vol = e.target.value / 100;
      if (this.audio) this.audio.volume = this.vol * 0.5;
    });

    await this.loadTracks();
    this.renderPlaylist();
    this.setTitle();
    this.visLoop();
  },

  async loadTracks() {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch('http://localhost:8080/top-tracks', { signal: ctrl.signal });
      if (!res.ok) throw new Error('server said no');
      const data = await res.json();
      this.tracks = data.map(t => ({ name: t.name, artist: t.artist, url: t.preview_url }));
      this.demo = false;
    } catch {
      // spotify server offline — fall back to the built-in chiptune "demos"
      this.demo = true;
      this.tracks = [
        { name: 'untitled banger.mid', artist: 'malten', chip: [0, 3, 7, 3, 10, 7, 12, 7] },
        { name: 'groove machine.mid', artist: 'malten', chip: [0, 0, 7, 5, 3, 5, 7, 10] },
        { name: '4am insomnia loop.mid', artist: 'malten', chip: [12, 10, 7, 10, 5, 7, 3, 0] },
      ];
    }
  },

  renderPlaylist() {
    const pl = this.$('wa-playlist');
    if (!pl) return;
    pl.innerHTML = '';
    if (this.demo) {
      const note = document.createElement('div');
      note.className = 'wa-row';
      note.style.color = '#557';
      note.textContent = '[spotify server offline — playing built-in MIDI demos]';
      pl.appendChild(note);
    }
    this.tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'wa-row' + (i === this.current ? ' current' : '');
      row.innerHTML = `${i + 1}. ${t.name} - ${t.artist}<span class="dur">${t.url || t.chip ? '▸' : 'no preview'}</span>`;
      row.addEventListener('click', () => { this.current = i; this.play(); });
      pl.appendChild(row);
    });
  },

  setTitle() {
    const t = this.tracks[this.current];
    const el = this.$('wa-title');
    if (t && el) el.textContent = `${this.current + 1}. ${t.name} - ${t.artist} `;
  },

  play() {
    const t = this.tracks[this.current];
    if (!t) return;
    this.stop(true);
    this.playing = true;
    this.setText('wa-play', '⏸');
    this.setTitle();
    this.renderPlaylist();
    if (t.chip) this.chipPlay(t.chip);
    else if (t.url) {
      this.audio = new Audio(t.url);
      this.audio.volume = this.vol * 0.5;
      this.audio.play().catch(() => this.stop());
      this.audio.addEventListener('ended', () => this.skip(1));
      this.audio.addEventListener('timeupdate', () => {
        if (!this.audio) return;
        const s = Math.floor(this.audio.currentTime);
        this.setText('wa-time', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      });
    } else {
      this.setText('wa-title', `${t.name} — no preview available for this one, alas`);
      this.playing = false;
      this.setText('wa-play', '▶');
    }
  },

  pause() {
    this.playing = false;
    this.setText('wa-play', '▶');
    if (this.audio) this.audio.pause();
    clearInterval(this.chipTimer);
  },

  stop(silent) {
    this.playing = false;
    this.setText('wa-play', '▶');
    if (this.audio) { this.audio.pause(); this.audio = null; }
    clearInterval(this.chipTimer);
    if (!silent) this.setText('wa-time', '--:--');
  },

  skip(dir) {
    this.current = (this.current + dir + this.tracks.length) % this.tracks.length;
    if (this.playing || this.demo) this.play(); else { this.setTitle(); this.renderPlaylist(); }
  },

  // 8-step chiptune loop rendered with plain oscillators — the "MIDI" of demo mode
  chipPlay(pattern) {
    const base = 220;
    this.chipStep = 0;
    let sec = 0;
    const stepFn = () => {
      const semis = pattern[this.chipStep % pattern.length];
      const freq = base * Math.pow(2, semis / 12);
      Sfx.beep(freq, 0.16, 'square', 0.05 * this.vol * 2);
      Sfx.beep(freq / 2, 0.2, 'triangle', 0.04 * this.vol * 2);
      if (this.chipStep % 2 === 0) Sfx.beep(60, 0.05, 'sawtooth', 0.05 * this.vol * 2);
      this.chipStep++;
      sec += 0.22;
      const s = Math.floor(sec);
      this.setText('wa-time', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    };
    stepFn();
    this.chipTimer = setInterval(stepFn, 220);
  },

  visLoop() {
    const cv = this.$('wa-vis');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const bars = 24;
    const heights = Array(bars).fill(2);
    const draw = () => {
      ctx.fillStyle = '#0a0a12';
      ctx.fillRect(0, 0, cv.width, cv.height);
      for (let i = 0; i < bars; i++) {
        const target = this.playing ? 4 + Math.random() * 34 : 2;
        heights[i] += (target - heights[i]) * 0.3;
        const h = heights[i];
        const grad = ctx.createLinearGradient(0, cv.height - h, 0, cv.height);
        grad.addColorStop(0, '#ff71ce');
        grad.addColorStop(0.5, '#9370DB');
        grad.addColorStop(1, '#00ff66');
        ctx.fillStyle = grad;
        ctx.fillRect(i * (cv.width / bars) + 2, cv.height - h, cv.width / bars - 4, h);
      }
      this.visRaf = requestAnimationFrame(draw);
    };
    draw();
  },
};

/* ============================ GUESTBOOK ============================ */
const Guestbook = {
  API: 'http://localhost:3001',
  online: false,
  pollTimer: null,

  filter(message) {
    message = message.replace(/https?:\/\/\S+/gi, '[link removed]');
    const blocked = ['nigger', 'nigga', 'retard', 'retarded', 'chink', 'nazi', 'hitler', 'swastika',
      'fag', 'faggot', 'fucktard', 'rape', 'incest', 'aids', 'legend', 'birthday'];
    blocked.forEach(w => {
      message = message.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
    });
    return message;
  },

  async init() {
    const body = document.querySelector('.window[data-app="guestbook"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = `
      <img src="assets/deco_guestbook_sign.gif" alt="sign the guestbook" class="deco-center" height="70">
      <div class="gb-status" id="gb-status">connecting…</div>
      <div id="messages" class="messages"></div>
      <div class="emoticons" id="gb-emotes"></div>
      <div class="message-input">
        <input type="text" id="screenName" placeholder="Screen Name" maxlength="20">
        <input type="text" id="message" placeholder="say something nice" maxlength="200">
        <button class="btn98" id="sendButton">Send</button>
      </div>`;

    ['🙂','😎','😭','🔥','💜','⭐','💀','🤘'].forEach(e => {
      const b = document.createElement('button');
      b.textContent = e;
      b.addEventListener('click', () => {
        const inp = document.getElementById('message');
        inp.value += e;
        inp.focus();
      });
      document.getElementById('gb-emotes').appendChild(b);
    });

    const saved = localStorage.getItem('malten_sn');
    if (saved) document.getElementById('screenName').value = saved;

    document.getElementById('sendButton').addEventListener('click', () => this.send());
    document.getElementById('message').addEventListener('keypress', e => {
      if (e.key === 'Enter') this.send();
    });

    await this.checkOnline();
    this.load();
    this.pollTimer = setInterval(() => { if (this.online) this.load(); }, 5000);
  },

  async checkOnline() {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${this.API}/messages`, { signal: ctrl.signal });
      this.online = res.ok;
    } catch { this.online = false; }
    const st = document.getElementById('gb-status');
    st.textContent = this.online
      ? '● connected — messages are live'
      : '○ offline mode — messages saved in your browser (start msgserver for live mode)';
    st.classList.toggle('online', this.online);
  },

  localMsgs() {
    try { return JSON.parse(localStorage.getItem('malten_guestbook') || '[]'); }
    catch { return []; }
  },

  async load() {
    let msgs = [];
    if (this.online) {
      try {
        const res = await fetch(`${this.API}/messages`);
        msgs = (await res.json()).slice().reverse();
      } catch { this.online = false; msgs = this.localMsgs(); }
    } else {
      msgs = this.localMsgs();
    }
    if (!msgs.length) {
      msgs = [{ screenName: 'malten', message: 'first!! welcome to my guestbook 💜', timestamp: new Date().toISOString() }];
    }
    const box = document.getElementById('messages');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
    box.innerHTML = '';
    msgs.forEach(m => {
      const d = document.createElement('div');
      d.className = 'msg';
      const sn = document.createElement('span'); sn.className = 'sn'; sn.textContent = m.screenName + ': ';
      const tx = document.createElement('span'); tx.textContent = m.message;
      const tm = document.createElement('span'); tm.className = 'tm';
      tm.textContent = m.timestamp ? new Date(m.timestamp).toLocaleDateString() : '';
      d.append(sn, tx, tm);
      box.appendChild(d);
    });
    if (stick) box.scrollTop = box.scrollHeight;
  },

  // post without the form UI (used by Glitter Studio and friends)
  async postExternal(screenName, message) {
    if (this.online) {
      try {
        await fetch(`${this.API}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screenName, message }),
        });
      } catch { this.online = false; }
    }
    if (!this.online) {
      const msgs = this.localMsgs();
      msgs.push({ screenName, message, timestamp: new Date().toISOString() });
      localStorage.setItem('malten_guestbook', JSON.stringify(msgs.slice(-50)));
    }
    if (document.getElementById('messages')) this.load();
  },

  async send() {
    const snInp = document.getElementById('screenName');
    const msgInp = document.getElementById('message');
    const screenName = snInp.value.trim();
    let message = msgInp.value.trim();
    if (!screenName || !message) { Sfx.error(); return; }
    message = this.filter(message);
    localStorage.setItem('malten_sn', screenName);

    if (this.online) {
      try {
        await fetch(`${this.API}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screenName, message }),
        });
      } catch { this.online = false; }
    }
    if (!this.online) {
      const msgs = this.localMsgs();
      msgs.push({ screenName, message, timestamp: new Date().toISOString() });
      localStorage.setItem('malten_guestbook', JSON.stringify(msgs.slice(-50)));
    }
    msgInp.value = '';
    Sfx.click();
    this.load();
  },
};

/* ========================== MY PICTURES ============================ */
function initGallery() {
  const body = document.querySelector('.window[data-app="pics"] .window-body');
  if (!body || body.dataset.built) return;
  body.dataset.built = '1';
  const pics = ['about.gif', 'banana.gif', 'heart-glitter.gif', 'herp.gif', 'patrick.gif',
    'stars.gif', 'dartmonkey.png', 'pfp.png', 'assets/under_repair_dog.gif',
    'assets/deco_dancing_baby.gif', 'assets/deco_dragon.gif', 'assets/deco_fairy.gif',
    'assets/deco_hamster.gif', 'assets/deco_skull.gif', 'assets/deco_record_dj.gif',
    'assets/deco_sparkle_bunny.gif', 'assets/deco_moon.gif', 'assets/deco_welcome_banner.gif'];
  const grid = document.createElement('div');
  grid.className = 'gif-grid';
  pics.forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = src;
    img.loading = 'lazy';
    img.addEventListener('click', () => img.classList.toggle('big'));
    grid.appendChild(img);
  });
  body.appendChild(grid);
}

// top-level const doesn't attach to window — export for ourspace.js / extras.js guards
Object.assign(window, { Mines, Paint, Amp, Guestbook });

/* ---------- boot: build apps lazily when their window first opens ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const builders = {
    'mines': () => Mines.init(),
    'paint': () => Paint.init(),
    'winamp': () => Amp.init(),
    'guestbook': () => Guestbook.init(),
    'pics': () => initGallery(),
  };
  document.addEventListener('app-open', e => {
    const b = builders[e.detail];
    if (b) b();
  });
  // windows that are open on load fire before this listener attaches — build them now
  ['winamp', 'guestbook'].forEach(id => {
    const el = document.querySelector(`.window[data-app="${id}"]`);
    if (el && !el.classList.contains('closed')) builders[id]();
  });
});
