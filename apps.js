/* ============================================================
   apps.js — the programs: Minesweeper, Paint, the Spotify
   top-songs list + Guestbook (both live inside OurSpace),
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
      <div class="mines-board">
        <div class="mines-top">
          <span class="lcd" id="mines-count">010</span>
          <button class="btn98" id="mines-face">🙂</button>
          <span class="lcd" id="mines-time">000</span>
        </div>
        <div id="mines-grid"></div>
      </div>
      <p style="font-size:10px;color:#666;margin:6px 0 0;">left click: dig &nbsp;•&nbsp; right click: flag 🚩</p>`;
    document.getElementById('mines-face').addEventListener('click', () => this.newGame());
    document.getElementById('mines-grid').addEventListener('contextmenu', e => e.preventDefault());
    this.newGame();
    ['app-open', 'app-resize'].forEach(ev =>
      document.addEventListener(ev, e => { if (e.detail === 'mines') this.fit(); }));
    this.fit();
  },

  // maximized: scale the cells (--cell, see styles.css) so the board fills the window;
  // otherwise fall back to the stylesheet's 24px
  fit() {
    const win = document.querySelector('.window[data-app="mines"]');
    const body = win && win.querySelector('.window-body');
    if (!body || !body.dataset.built) return;
    let cell = '';
    if (win.classList.contains('maximized') && window.innerWidth > 820 && body.clientHeight) {
      // the LCD bar scales with the cells and is about one row tall; 64px covers padding + the hint line
      const room = Math.min((body.clientWidth - 32) / this.W, (body.clientHeight - 64) / (this.H + 1));
      cell = Math.max(24, Math.min(64, Math.floor(room))) + 'px';
    }
    body.style.setProperty('--cell', cell);
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
      <div class="paint-stage"><canvas id="paint-canvas" width="240" height="220"></canvas></div>
      <div class="paint-palette"></div>`;

    const canvas = document.getElementById('paint-canvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ['app-open', 'app-resize'].forEach(ev =>
      document.addEventListener(ev, e => { if (e.detail === 'paint') this.fit(); }));

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
      canvas.width = canvas.height = 1;      // a fresh sheet is the size of the window again
      this.fit();
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
    this.fit();
  },

  // Grow the sheet to fill the stage (e.g. when the window is maximized). The bitmap only
  // ever grows and the old pixels are copied across 1:1, so the drawing is never stretched
  // or cropped; when the window shrinks again the stage scrolls, like real Paint.
  fit() {
    const canvas = document.getElementById('paint-canvas');
    const stage = canvas && canvas.parentElement;
    if (!stage || !stage.clientWidth) return;            // window not on screen yet
    const w = Math.max(canvas.width, stage.clientWidth);
    const h = Math.max(canvas.height, stage.clientHeight);
    if (w === canvas.width && h === canvas.height) return;
    const keep = document.createElement('canvas');
    keep.width = canvas.width;
    keep.height = canvas.height;
    keep.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(keep, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';        // resizing a canvas resets its context
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

/* ================= SPOTIFY TOP SONGS (OurSpace → My Page) ================= */
// A public page poking at a visitor's own localhost only earns them a "wants to access your local
// network" browser prompt, so the optional local backends are only tried when the site itself is
// running locally (or once the API constant points at a real host).
function localBackendOk(api) {
  const isLocal = h => h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  try { return !isLocal(new URL(api).hostname) || isLocal(location.hostname); }
  catch { return false; }
}

// malten's real top tracks, from the optional spotifyserver/ (GET /top-tracks). Visitors almost
// never have that server, so the list degrades: live → last good result (localStorage) →
// baked-in snapshot → "the server is napping". It never sits on "loading…".
const Spotify = {
  API: 'http://localhost:8080',                 // <-- the Spotify server's base URL lives here and only here
  PROFILE: 'https://open.spotify.com/user/moltennebula',
  CACHE_KEY: 'malten_spotify_top',
  LIMIT: 10,                                    // tracks to ask the server for
  SHOW: 5,                                      // rows shown before "show all"
  // Last-resort fallback: the real top 5, captured from the server on the date below.
  // To refresh it, paste the first 5 objects of http://localhost:8080/top-tracks in here.
  SNAPSHOT: {
    at: '2026-10-05T12:00:00',
    tracks: [
      { name: 'WannaCry', artist: 'Ninajirachi, Porter Robinson', album: 'WannaCry',
        preview_url: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/4f/95/ad/4f95ad42-3159-70f5-0e1d-74e41bf2aeaf/mzaf_10985369354936899334.plus.aac.p.m4a',
        image_url: 'https://i.scdn.co/image/ab67616d0000b273a4cd3b67b8747f787068b366',
        image_small: 'https://i.scdn.co/image/ab67616d00004851a4cd3b67b8747f787068b366',
        url: 'https://open.spotify.com/track/7JW8FRWVCOQDs40IjEXdPi' },
      { name: 'bag TF up', artist: 'bbno$', album: 'bbno$',
        preview_url: null,
        image_url: 'https://i.scdn.co/image/ab67616d0000b2739cd48ea54f12cdd1a244ce51',
        image_small: 'https://i.scdn.co/image/ab67616d000048519cd48ea54f12cdd1a244ce51',
        url: 'https://open.spotify.com/track/5moS96HyivwASueSMzhSBh' },
      { name: 'Delete', artist: 'Ninajirachi', album: 'I Love My Computer',
        preview_url: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/4d/b0/99/4db0997d-feb6-2ccd-d573-2d31cd3de7cb/mzaf_6097604859715329249.plus.aac.p.m4a',
        image_url: 'https://i.scdn.co/image/ab67616d0000b2733b9b742c5c525af6e6767d87',
        image_small: 'https://i.scdn.co/image/ab67616d000048513b9b742c5c525af6e6767d87',
        url: 'https://open.spotify.com/track/0CVbCtcdXAIw00YBXXbneu' },
      { name: 'iPod Touch', artist: 'Ninajirachi', album: 'I Love My Computer',
        preview_url: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/40/01/02/400102b7-3b53-3e4b-3d4d-cf6f0ca50fb8/mzaf_12409370184411059069.plus.aac.p.m4a',
        image_url: 'https://i.scdn.co/image/ab67616d0000b2733b9b742c5c525af6e6767d87',
        image_small: 'https://i.scdn.co/image/ab67616d000048513b9b742c5c525af6e6767d87',
        url: 'https://open.spotify.com/track/1xqT27jSG1Y15vOXfsV0gv' },
      { name: 'Fuck My Computer', artist: 'Ninajirachi', album: 'I Love My Computer',
        preview_url: null,
        image_url: 'https://i.scdn.co/image/ab67616d0000b2733b9b742c5c525af6e6767d87',
        image_small: 'https://i.scdn.co/image/ab67616d000048513b9b742c5c525af6e6767d87',
        url: 'https://open.spotify.com/track/5ZbztTcvj6QWWbeYsL4GTa' },
    ],
  },

  tracks: [], source: 'none', at: null,         // source: live | cache | snapshot | none
  checking: false, checkedAt: 0, expanded: false,
  audio: null, playing: -1, box: null,

  cached() {
    try {
      const c = JSON.parse(localStorage.getItem(this.CACHE_KEY) || 'null');
      if (c && Array.isArray(c.tracks) && c.tracks.length) return c;
    } catch { /* corrupted cache — ignore it */ }
    return null;
  },

  // the best list we have without touching the network
  fallback() {
    const c = this.cached();
    if (c) return { tracks: c.tracks, source: 'cache', at: c.at };
    if (this.SNAPSHOT.tracks.length) return { tracks: this.SNAPSHOT.tracks, source: 'snapshot', at: this.SNAPSHOT.at };
    return { tracks: [], source: 'none', at: null };
  },

  // Draw the list into `box` (My Page re-renders a lot, so this is cheap and repeatable), then
  // quietly ask the live server — at most once every 10 minutes.
  mount(box) {
    this.box = box;
    if (!this.tracks.length) Object.assign(this, this.fallback());
    this.paint();
    if (Date.now() - this.checkedAt > 10 * 60000) this.refresh();
  },

  async refresh() {
    if (this.checking || !localBackendOk(this.API)) return;
    this.checking = true;
    this.paint();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${this.API}/top-tracks?limit=${this.LIMIT}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error('server said no');
      const data = await res.json();
      const tracks = (Array.isArray(data) ? data : []).filter(t => t && t.name);
      if (!tracks.length) throw new Error('no tracks');
      const now = this.tracks[this.playing];
      if (now && (tracks[this.playing] || {}).name !== now.name) this.stop(true);   // the list moved under the playing row
      Object.assign(this, { tracks, source: 'live', at: new Date().toISOString() });
      try { localStorage.setItem(this.CACHE_KEY, JSON.stringify({ at: this.at, tracks })); } catch { /* storage full — fine */ }
    } catch {
      // server offline — the normal case for visitors. keep showing what we have.
      if (this.source === 'live') this.source = 'cache';
    }
    clearTimeout(timer);
    this.checking = false;
    this.checkedAt = Date.now();
    this.paint();
  },

  when(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d)) return 'a while ago';
    const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return withTime ? `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : day;
  },

  paint() {
    const box = this.box;
    if (!box) return;
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    box.innerHTML = '';

    if (!this.tracks.length) {
      const nap = mk('div', 'sp-nap');
      if (this.checking) nap.textContent = 'dialing up spotify… (this takes 2 seconds, tops)';
      else {
        nap.appendChild(mk('b', null, '💤 the spotify server is napping.'));
        nap.appendChild(mk('div', null, 'it lives on my computer, and my computer sleeps more than i do. check back later — or go snoop through '));
        const a = mk('a', null, 'my actual spotify');
        a.href = this.PROFILE; a.target = '_blank'; a.rel = 'noopener';
        nap.lastChild.append(a, document.createTextNode(' yourself.'));
      }
      box.appendChild(nap);
      return;
    }

    const list = mk('ol', 'sp-list');
    const n = this.expanded ? this.tracks.length : Math.min(this.SHOW, this.tracks.length);
    this.tracks.slice(0, n).forEach((t, i) => {
      const row = mk('li', 'sp-row' + (this.playing === i ? ' sp-on' : ''));
      row.appendChild(mk('span', 'sp-rank', String(i + 1)));

      const thumb = t.image_small || t.image_url;
      const noArt = () => mk('span', 'sp-art sp-noart', '♪');
      if (thumb) {
        const art = mk('img', 'sp-art');
        art.src = thumb; art.alt = t.album || ''; art.loading = 'lazy';
        art.title = t.album ? `from “${t.album}”` : '';
        art.addEventListener('error', () => art.replaceWith(noArt()));
        if (window.ImageViewer) {
          art.classList.add('sp-zoom');
          art.addEventListener('click', () => ImageViewer.open(t.image_url || thumb, `${t.name} — ${t.artist}`));
        }
        row.appendChild(art);
      } else row.appendChild(noArt());

      const meta = mk('div', 'sp-meta');
      const name = mk('a', 'sp-name', t.name);
      name.href = t.url || 'https://open.spotify.com/search/' + encodeURIComponent(`${t.name} ${t.artist || ''}`.trim());
      name.target = '_blank'; name.rel = 'noopener';
      name.title = 'open in spotify ↗';
      meta.appendChild(name);
      meta.appendChild(mk('div', 'sp-artist', t.artist || ''));
      row.appendChild(meta);

      if (t.preview_url) {
        const on = this.playing === i;
        const btn = mk('button', 'btn98 sp-play', on ? '⏹' : '▶');
        btn.title = on ? 'stop' : 'play the 30 second preview';
        btn.setAttribute('aria-label', `${on ? 'stop' : 'play'} the preview of ${t.name}`);
        btn.addEventListener('click', () => this.toggle(i));
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
    box.appendChild(list);

    if (this.tracks.length > this.SHOW) {
      const more = mk('a', 'sp-more', this.expanded ? `▲ just the top ${this.SHOW}` : `▼ show all ${this.tracks.length}`);
      more.href = '#';
      more.addEventListener('click', e => { e.preventDefault(); this.expanded = !this.expanded; this.paint(); });
      box.appendChild(more);
    }

    const status = mk('div', 'sp-status' + (this.source === 'live' ? ' live' : ''));
    status.textContent = this.checking ? '… checking in with spotify'
      : this.source === 'live' ? '● live from my spotify — this month\'s most played'
      : this.source === 'cache' ? `○ spotify server is napping — last updated ${this.when(this.at, true)}`
      : `○ spotify server is napping — snapshot from ${this.when(this.at)}`;
    box.appendChild(status);

    const prof = mk('a', 'sp-profile', 'my spotify profile ↗');
    prof.href = this.PROFILE; prof.target = '_blank'; prof.rel = 'noopener';
    box.appendChild(prof);
  },

  // play / stop a track's 30s preview (only rows whose preview_url isn't null get a button)
  toggle(i) {
    if (this.playing === i) { this.stop(); return; }
    this.stop(true);
    const t = this.tracks[i];
    if (!t || !t.preview_url) return;
    if (window.MS && MS.stopSong) MS.stopSong();      // one song at a time around here
    const a = new Audio(t.preview_url);
    a.volume = 0.2;
    this.audio = a;
    this.playing = i;
    const done = () => { if (this.audio === a) this.stop(); };
    a.addEventListener('ended', done);
    a.addEventListener('error', () => { if (this.audio === a) { t.preview_url = null; this.stop(); } });   // dead link: drop the button
    a.play().catch(done);
    this.paint();
  },

  stop(quiet) {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    const was = this.playing;
    this.playing = -1;
    if (!quiet && was !== -1) this.paint();
  },
};

/* ============================ GUESTBOOK ============================ */
// Lives inside OurSpace now (the Guestbook tab + a teaser box on My Page): it renders into
// whatever container it's handed instead of owning a desktop window.
const Guestbook = {
  API: 'http://localhost:3001',
  online: false,
  onlineCheck: null,     // promise of the one-time "is the API up?" probe
  probed: false,         // …and whether it has finished
  pollTimer: null,
  rootEl: null,          // the persistent guestbook UI (built once, re-parented by mount)
  msgs: null,            // last loaded entries, oldest → newest

  filter(message) {
    message = message.replace(/https?:\/\/\S+/gi, '[link removed]');
    const blocked = ['nigger', 'nigga', 'retard', 'retarded', 'chink', 'nazi', 'hitler', 'swastika',
      'fag', 'faggot', 'fucktard', 'rape', 'incest', 'aids', 'legend', 'birthday'];
    blocked.forEach(w => {
      message = message.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
    });
    return message;
  },

  $(sel) { return this.rootEl ? this.rootEl.querySelector(sel) : null; },

  // has this visitor signed before? (send() has always remembered their screen name)
  hasSigned() { return !!localStorage.getItem('malten_sn'); },

  // Put the full guestbook inside `container`. The same root element is re-parented on every
  // call, so a half-typed entry survives OurSpace re-rendering the tab.
  mount(container) {
    if (!this.rootEl) this.build();
    container.appendChild(this.rootEl);
    this.paint(this.msgs || this.seeded(this.localMsgs()));
    const box = this.$('#messages');
    box.scrollTop = box.scrollHeight;
    this.load();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { if (this.online && this.rootEl.isConnected) this.load(); }, 5000);
    }
  },

  build() {
    const root = this.rootEl = document.createElement('div');
    root.className = 'gb-root';
    root.innerHTML = `
      <img src="assets/deco_guestbook_sign.gif" alt="sign the guestbook" class="deco-center" height="70">
      <div class="gb-status" id="gb-status">connecting…</div>
      <div id="messages" class="messages"></div>
      <div class="emoticons" id="gb-emotes"></div>
      <div class="message-input">
        <input type="text" id="screenName" placeholder="Screen Name" maxlength="20">
        <input type="text" id="message" placeholder="say something nice" maxlength="200">
        <button class="btn98" id="sendButton">Sign!</button>
      </div>`;

    ['🙂','😎','😭','🔥','💜','⭐','💀','🤘'].forEach(e => {
      const b = document.createElement('button');
      b.textContent = e;
      b.addEventListener('click', () => {
        const inp = this.$('#message');
        inp.value += e;
        inp.focus();
      });
      this.$('#gb-emotes').appendChild(b);
    });

    const saved = localStorage.getItem('malten_sn');
    if (saved) this.$('#screenName').value = saved;

    this.$('#sendButton').addEventListener('click', () => this.send());
    this.$('#message').addEventListener('keypress', e => {
      if (e.key === 'Enter') this.send();
    });
    this.paintStatus();
  },

  checkOnline() {
    if (!this.onlineCheck) {
      this.onlineCheck = (async () => {
        if (localBackendOk(this.API)) {
          try {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 1500);
            const res = await fetch(`${this.API}/messages`, { signal: ctrl.signal });
            this.online = res.ok;
          } catch { this.online = false; }
        }
        this.probed = true;
        this.paintStatus();
      })();
    }
    return this.onlineCheck;
  },

  paintStatus() {
    const st = this.$('#gb-status');
    if (!st || !this.probed) return;
    st.textContent = this.online
      ? '● connected — messages are live'
      : '○ offline mode — messages saved in your browser (start msgserver for live mode)';
    st.classList.toggle('online', this.online);
  },

  localMsgs() {
    try { return JSON.parse(localStorage.getItem('malten_guestbook') || '[]'); }
    catch { return []; }
  },

  // an empty guestbook is a sad guestbook
  seeded(msgs) {
    return msgs.length ? msgs
      : [{ screenName: 'malten', message: 'first!! welcome to my guestbook 💜', timestamp: new Date().toISOString() }];
  },

  // every entry, oldest → newest: from the API when it's up, else this browser's localStorage
  async fetchAll() {
    await this.checkOnline();
    let msgs = [];
    if (this.online) {
      try {
        const res = await fetch(`${this.API}/messages`);
        msgs = (await res.json()).slice().reverse();
      } catch { this.online = false; this.paintStatus(); msgs = this.localMsgs(); }
    } else {
      msgs = this.localMsgs();
    }
    this.msgs = this.seeded(msgs);
    return this.msgs;
  },

  // newest-first slice of what we already know — for teasers (My Page). Never waits on the network.
  latest(n) {
    return (this.msgs || this.seeded(this.localMsgs())).slice(-n).reverse();
  },

  async load() {
    this.paint(await this.fetchAll());
  },

  paint(msgs) {
    const box = this.$('#messages');
    if (!box) return;
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

  // store one entry: the API when it's up, else localStorage
  async store(screenName, message) {
    await this.checkOnline();
    if (this.online) {
      try {
        await fetch(`${this.API}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screenName, message }),
        });
      } catch { this.online = false; this.paintStatus(); }
    }
    if (!this.online) {
      const msgs = this.localMsgs();
      msgs.push({ screenName, message, timestamp: new Date().toISOString() });
      localStorage.setItem('malten_guestbook', JSON.stringify(msgs.slice(-50)));
    }
  },

  // post without the form UI (used by Glitter Studio and friends)
  async postExternal(screenName, message) {
    await this.store(screenName, message);
    await this.load();
  },

  async send() {
    const snInp = this.$('#screenName');
    const msgInp = this.$('#message');
    const screenName = snInp.value.trim();
    let message = msgInp.value.trim();
    if (!screenName || !message) { Sfx.error(); return; }
    message = this.filter(message);
    localStorage.setItem('malten_sn', screenName);

    msgInp.value = '';
    await this.store(screenName, message);
    Sfx.tada();
    await this.load();
    const box = this.$('#messages');
    box.scrollTop = box.scrollHeight;
    const st = this.$('#gb-status');
    st.textContent = `✔ signed!! thanks ${screenName} — malten reads every entry at least twice`;
    st.classList.add('online');
    setTimeout(() => this.paintStatus(), 6000);
  },
};

/* ========================== MY PICTURES ============================ */
// Win98-style picture viewer overlay. Shared: the OurSpace feed (ourspace.js) opens photos/gifs in it too,
// via window.ImageViewer — always guard with `window.ImageViewer &&`.
const ImageViewer = {
  el: null,
  back: null,

  open(src, title) {
    this.close();
    const name = title || decodeURIComponent(String(src).split(/[?#]/)[0].split(/[\\/]/).pop()) || 'picture';
    this.back = document.activeElement;
    const ov = this.el = document.createElement('div');
    ov.className = 'imgview';
    ov.innerHTML = '<div class="imgview-win" role="dialog" aria-modal="true">' +
      '<div class="title-bar"><div class="title-bar-text">🖼️ <span></span></div>' +
      '<button class="imgview-x" type="button" aria-label="Close" title="Close"><img src="Close.png" alt=""></button></div>' +
      '<div class="imgview-stage"><img alt=""></div><div class="imgview-status">loading…</div></div>';
    const img = ov.querySelector('.imgview-stage img');
    const status = ov.querySelector('.imgview-status');
    const x = ov.querySelector('.imgview-x');
    ov.querySelector('.title-bar-text span').textContent = ov.querySelector('.title-bar-text').title = name + ' - Picture Viewer';
    ov.querySelector('.imgview-win').setAttribute('aria-label', name);
    img.alt = name;

    // photos: as big as fits in ~90% of the viewport (max 3x). gifs / tiny pixel art: whole-number zoom up to 4x.
    this.fit = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) return;
      const pixel = /\.gif$/i.test(String(src).split(/[?#]/)[0]) || (nw <= 160 && nh <= 160);
      let z = Math.min((window.innerWidth * 0.9 - 16) / nw, (window.innerHeight * 0.9 - 60) / nh);
      if (pixel && z >= 1) z = Math.min(4, Math.floor(z));
      else if (!pixel) z = Math.min(3, z);
      img.classList.toggle('pixel', pixel);
      img.style.width = Math.max(1, Math.round(nw * z)) + 'px';
      img.style.height = Math.max(1, Math.round(nh * z)) + 'px';
      status.textContent = `${nw} × ${nh} pixels · ${Math.round(z * 100)}%`;
    };
    img.addEventListener('load', this.fit);
    img.addEventListener('error', () => { img.remove(); status.textContent = 'This picture cannot be displayed.'; });
    img.src = src;

    ov.addEventListener('click', e => { if (e.target === ov) this.close(); });      // click outside the viewer window
    x.addEventListener('click', () => this.close());
    this.onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      else if (e.key === 'Tab') { e.preventDefault(); x.focus(); }                   // one control: focus stays in the dialog
    };
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.fit);
    document.documentElement.classList.add('imgview-open');                        // no page scroll behind the overlay
    document.body.appendChild(ov);
    x.focus();
    Sfx.click();
  },

  close() {
    if (!this.el) return;
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.fit);
    document.documentElement.classList.remove('imgview-open');
    this.el.remove();
    this.el = null;
    if (this.back && this.back.isConnected) this.back.focus({ preventScroll: true });
    this.back = null;
  },

  // Make a thumbnail zoomable — but only once it has really loaded, so the zoom-in cursor (.zoomable) never
  // shows up on a broken image: click or Enter/Space opens the viewer, focus comes back to the thumbnail.
  attach(img, title) {
    const arm = () => {
      if (!img.naturalWidth || img.classList.contains('zoomable')) return;
      const show = () => this.open(img.currentSrc || img.src, title);
      img.classList.add('zoomable');
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.title = 'click to view larger';
      img.addEventListener('click', show);
      img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
    };
    if (img.complete) arm(); else img.addEventListener('load', arm, { once: true });
  },
};
window.ImageViewer = ImageViewer;

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
    ImageViewer.attach(img, src.split('/').pop());
    grid.appendChild(img);
  });
  body.appendChild(grid);
}

// top-level const doesn't attach to window — export for ourspace.js / extras.js guards
Object.assign(window, { Mines, Paint, Spotify, Guestbook });

/* ---------- boot: build apps lazily when their window first opens ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const builders = {
    'mines': () => Mines.init(),
    'paint': () => Paint.init(),
    'pics': () => initGallery(),
  };
  document.addEventListener('app-open', e => {
    const b = builders[e.detail];
    if (b) b();
  });
});
