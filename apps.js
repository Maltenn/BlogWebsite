/* ============================================================
   apps.js — the programs: Minesweeper, Paint, the Spotify
   top-songs list + Guestbook (both live inside OurSpace),
   the song search + a visitor's own top songs (SongSearch /
   TopSongs), and the My Pictures gallery.
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

// The song-list kit shared by Spotify (malten's list), TopSongs (a visitor's list) and the
// SongSearch picker: one row per song (rank · cover · title/artist · where the sound comes from · ▶),
// the volume row under a list, the <audio> preview player and the JSONP helper. Everything that
// lists songs paints through here, so the lists can't drift apart.
const SongKit = {
  mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  },

  // one <li class="sp-row">. r = { rank?, name, artist, album, art, artBig?, href?, hrefTitle?,
  // on, busy, via (label, shown while on), viaHref?, canPlay, onToggle, key? (keeps focus across
  // repaints), tools? (extra buttons after ▶) }
  row(r) {
    const mk = this.mk;
    const row = mk('li', 'sp-row' + (r.on ? ' sp-on' : ''));
    if (r.rank !== undefined) row.appendChild(mk('span', 'sp-rank', String(r.rank)));

    const noArt = () => mk('span', 'sp-art sp-noart', '♪');
    if (r.art) {
      const art = mk('img', 'sp-art');
      art.src = r.art; art.alt = r.album || ''; art.loading = 'lazy';
      art.title = r.album ? `from “${r.album}”` : '';
      art.addEventListener('error', () => art.replaceWith(noArt()));
      if (r.artBig && window.ImageViewer) {
        art.classList.add('sp-zoom');
        art.addEventListener('click', () => ImageViewer.open(r.artBig, `${r.name} — ${r.artist}`));
      }
      row.appendChild(art);
    } else row.appendChild(noArt());

    const meta = mk('div', 'sp-meta');
    const name = mk(r.href ? 'a' : 'span', 'sp-name', r.name);
    if (r.href) { name.href = r.href; name.target = '_blank'; name.rel = 'noopener'; name.title = r.hrefTitle || ''; }
    meta.appendChild(name);
    meta.appendChild(mk('div', 'sp-artist', r.artist || ''));
    if (r.on && r.via) {
      // say where the sound is coming from (Spotify asks for it; Deezer and Apple get the same courtesy)
      const via = mk(r.viaHref ? 'a' : 'div', 'sp-via', r.via);
      if (r.viaHref) { via.href = r.viaHref; via.target = '_blank'; via.rel = 'noopener'; }
      meta.appendChild(via);
    }
    row.appendChild(meta);

    if (r.canPlay) {
      const btn = mk('button', 'btn98 sp-play', r.on ? (r.busy ? '…' : '⏹') : '▶');
      btn.type = 'button';
      btn.title = r.on ? 'stop' : 'play a 30 second preview';
      btn.setAttribute('aria-label', `${r.on ? 'stop' : 'play'} the preview of ${r.name}`);
      if (r.key) btn.dataset.focus = r.key + ':play';
      btn.addEventListener('click', r.onToggle);
      row.appendChild(btn);
    }
    (r.tools || []).forEach(el => row.appendChild(el));
    return row;
  },

  // volume: mute · the wedge the video players use · level. There is one setting for every list
  // (Spotify.volume()); `off` greys the row out (with `note`) while Spotify's own player is the one
  // making sound, since that player can't be told a volume.
  volumeRow(off, note) {
    const mk = this.mk;
    const volRow = mk('div', 'sp-vol-row');
    const mute = mk('button', 'btn98 sp-mute');
    mute.type = 'button';
    const wedge = mk('span', 'yt06-vol sp-vol');
    const range = mk('input');
    range.type = 'range'; range.min = 0; range.max = 100; range.step = 1;
    range.setAttribute('aria-label', 'preview volume');
    wedge.appendChild(range);
    const pct = mk('span', 'sp-vol-pct');
    volRow.append(mute, wedge, pct);
    if (note) volRow.appendChild(mk('span', 'sp-vol-note', note));
    volRow.classList.toggle('off', !!off);
    mute.disabled = range.disabled = !!off;
    let grabbed = null;                              // the level when the current drag began
    range.addEventListener('input', () => {
      if (grabbed === null) grabbed = Spotify.volume().level;
      const x = +range.value;
      // dragged all the way down = mute (remembering where it came from); anything above 0 unmutes
      Spotify.volume(x > 0 ? { level: x, muted: false } : { level: grabbed, muted: true });
    });
    range.addEventListener('change', () => { grabbed = null; });
    mute.addEventListener('click', () => Spotify.volume({ muted: !Spotify.volume().muted }));
    volRow.sync = () => {                            // volume() calls this instead of repainting (a repaint would eat the drag)
      const v = Spotify.volume(), shown = v.muted ? 0 : v.level;
      range.value = shown;
      wedge.style.setProperty('--v', shown + '%');
      pct.textContent = shown + '%';
      mute.textContent = shown === 0 ? '🔇' : shown < 40 ? '🔉' : '🔊';
      mute.title = off ? note : v.muted ? 'unmute' : 'mute';
      range.title = off ? note : 'preview volume';
    };
    volRow.sync();
    return volRow;
  },

  // plain <audio> preview for `owner` (Spotify or TopSongs — anything with audio / playToken / via /
  // paint() / stop()). Resolves true once it is actually playing, false if the link is dead.
  playAudio(owner, url, token, via) {
    return new Promise(resolve => {
      const a = new Audio(url);
      a.volume = Spotify.gain();
      a.muted = Spotify.volume().muted;
      owner.audio = a;
      let settled = false;
      const settle = ok => { if (!settled) { settled = true; resolve(ok); } };
      a.addEventListener('playing', () => {
        if (token !== owner.playToken) { a.pause(); return settle(true); }
        owner.via = via; owner.paint(); settle(true);
      });
      a.addEventListener('ended', () => { if (owner.audio === a) owner.stop(); });
      const failed = () => { if (owner.audio === a) owner.audio = null; settle(false); };
      a.addEventListener('error', failed);
      a.play().catch(failed);
      setTimeout(() => { if (!settled) { a.pause(); failed(); } }, 6000);   // never sit on "finding a preview…"
    });
  },

  // one song at a time around here: whoever starts playing quiets everybody else first
  hush(except) {
    if (window.MS && MS.stopSong) MS.stopSong();
    if (except !== Spotify) Spotify.stop();
    if (except !== TopSongs) TopSongs.stop();
  },

  // Deezer's API sends no CORS headers, so it is read through a <script> tag (JSONP), and so is
  // iTunes, to keep one code path. Resolves with the data; rejects when the script is blocked or
  // takes longer than `ms`, so nothing ever waits forever.
  jsonp(url, ms = 5000) {
    return new Promise((resolve, reject) => {
      const cb = '__ss' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const s = document.createElement('script');
      let timer = 0;
      const finish = late => {
        clearTimeout(timer);
        s.remove();
        // a script that answers after we gave up must find something to call, or it throws
        if (late) window[cb] = () => { delete window[cb]; };
        else delete window[cb];
      };
      window[cb] = data => { finish(false); resolve(data); };
      s.onerror = () => { finish(false); reject(new Error('blocked')); };
      timer = setTimeout(() => { finish(true); reject(new Error('timed out')); }, ms);
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(s);
    });
  },

  // repaint `el` without losing the keyboard's place: the focused button (by data-focus) and the
  // scroll position come back afterwards
  keepFocus(el, paint) {
    const a = document.activeElement;
    const f = a && a !== document.body && el.contains(a) ? a.dataset.focus : null;
    const top = el.scrollTop;
    paint();
    el.scrollTop = top;
    if (f) {
      const b = [...el.querySelectorAll('[data-focus]')].find(x => x.dataset.focus === f);
      if (b && !b.disabled) b.focus({ preventScroll: true });
    }
  },
};

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

  VOL_KEY: 'malten_spotify_volume',             // the slider's level, remembered across reloads

  tracks: [], source: 'none', at: null,         // source: live | cache | snapshot | none
  checking: false, checkedAt: 0, expanded: false,
  audio: null, playing: -1, box: null, vol: null,
  // Every row is playable. A click tries, in order: the track's own 30s preview (Spotify's, or the
  // Apple one the server found) → a Deezer preview looked up on the spot → Spotify's own embedded
  // player, driven by OUR button through Spotify's iFrame API while the embed itself sits off-screen.
  via: null,                                    // what the playing row is using: loading | preview | deezer | spotify | spotify-wait
  playToken: 0,                                 // bumped on every play/stop so a slow lookup can't start a stale song
  dz: {},                                       // Deezer matches this session: "title|artist" → (promise of) a Deezer id or null
  SHOW_EMBED: false,                            // true = always show Spotify's little player instead of hiding it
  embed: { api: null, ctl: null, host: null, started: false, timer: 0 },

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
    const mk = SongKit.mk;
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

    // the rows themselves are SongKit's (TopSongs paints visitors' lists with the same ones)
    const list = mk('ol', 'sp-list');
    const n = this.expanded ? this.tracks.length : Math.min(this.SHOW, this.tracks.length);
    const label = { loading: 'finding a preview…', preview: '♪ 30 second preview', deezer: '♪ 30 second preview · via Deezer',
      spotify: '♪ playing on Spotify ↗', 'spotify-wait': 'press play in the little Spotify player ↘' }[this.via] || '';
    this.tracks.slice(0, n).forEach((t, i) => {
      const on = this.playing === i;
      list.appendChild(SongKit.row({
        rank: i + 1, name: t.name, artist: t.artist, album: t.album,
        art: t.image_small || t.image_url, artBig: t.image_url || t.image_small,
        href: t.url || 'https://open.spotify.com/search/' + encodeURIComponent(`${t.name} ${t.artist || ''}`.trim()),
        hrefTitle: 'open in spotify ↗',
        on, busy: on && this.via === 'loading',
        via: label, viaHref: this.via === 'spotify' ? t.url : null,
        canPlay: !!(t.preview_url || this.trackId(t)),
        onToggle: () => this.toggle(i),
      }));
    });
    box.appendChild(list);

    // the volume reaches the <audio> previews only — Spotify's player can't be told a volume — so
    // the row greys out while the embed is what's playing
    box.appendChild(SongKit.volumeRow(this.via === 'spotify' || this.via === 'spotify-wait', 'spotify\'s player sets its own volume'));

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

  // play / stop a row. Works its way down the sources until one of them makes sound.
  async toggle(i) {
    if (this.playing === i) { this.stop(); return; }
    this.stop(true);
    const t = this.tracks[i];
    if (!t) return;
    SongKit.hush(this);                               // one song at a time around here
    const token = ++this.playToken;
    const mine = () => token === this.playToken;
    this.playing = i;
    this.via = 'loading';
    this.paint();

    if (t.preview_url) {
      if (await this.playAudio(t.preview_url, token, 'preview')) return;
      if (!mine()) return;
      t.preview_url = null;                            // dead link: don't try it again
    }
    const dz = await this.deezerPreview(t);
    if (!mine()) return;
    if (dz && await this.playAudio(dz, token, 'deezer')) return;
    if (!mine()) return;
    if (await this.playEmbed(t, token)) return;
    if (mine()) {
      this.stop();
      if (window.MS && MS.toast) MS.toast('couldn\'t find a preview for that one — the title opens it in spotify');
    }
  },

  // The slider's setting: level = 1-100 (the last audible level), muted = silenced without forgetting
  // it. One setting for every song list (TopSongs uses it too). Pass an object to change it; the
  // playing preview — this list's or TopSongs' — and every volume row follow at once. Spotify's own
  // player never hears about it: its iFrame API knows play / pause / seek and nothing about volume,
  // and a cross-origin iframe's sound can't be reached from the page.
  volume(set) {
    if (!this.vol) {
      this.vol = { level: 45, muted: false };
      try {
        const s = JSON.parse(localStorage.getItem(this.VOL_KEY));
        if (s && s.level >= 1 && s.level <= 100) this.vol = { level: Math.round(s.level), muted: !!s.muted };
      } catch { /* nothing saved yet */ }
    }
    if (set) {
      Object.assign(this.vol, set);
      try { localStorage.setItem(this.VOL_KEY, JSON.stringify(this.vol)); } catch { /* storage blocked */ }
      [this.audio, TopSongs.audio].forEach(a => { if (a) { a.volume = this.gain(); a.muted = this.vol.muted; } });
      document.querySelectorAll('.sp-vol-row').forEach(row => { if (row.sync) row.sync(); });
    }
    return this.vol;
  },

  // slider level → <audio>.volume. Squared, so the quiet end (where a loud 30s clip actually sounds
  // right) gets most of the slider; the default 45 lands on the 0.2 the previews used to be fixed at.
  gain() { return (this.volume().level / 100) ** 2; },

  // plain <audio> preview (SongKit's player). Resolves true once it is actually playing, false if the link is dead.
  playAudio(url, token, via) { return SongKit.playAudio(this, url, token, via); },

  // Deezer has previews for a lot of what Apple lacks. Its API has no CORS headers, so this is a
  // JSONP call, made only when someone presses play on a track with no preview. Exact title +
  // artist only — a remix or a cover is worse than no preview. The match (its Deezer id) is kept
  // for the session; the link itself expires after ~15 minutes, so SongSearch.deezerUrl() hands
  // back the one we have while it's good and fetches a fresh one after that.
  async deezerPreview(t) {
    const artist = String(t.artist || '').split(',')[0].trim();
    const key = `${t.name}|${artist}`;
    if (!(key in this.dz)) {
      const norm = s => SongSearch.norm(s);
      const want = norm(t.name), who = norm(artist);
      this.dz[key] = !want ? null : SongKit.jsonp(`https://api.deezer.com/search?limit=25&output=jsonp&q=${encodeURIComponent(`${artist} ${t.name}`.trim())}`, 4000)
        .then(data => {
          const hit = ((data && data.data) || []).find(r => r && r.preview && norm(r.title) === want && (!who || norm((r.artist || {}).name) === who));
          if (!hit) return null;
          SongSearch.remember(String(hit.id), hit.preview);
          return String(hit.id);
        }, () => { delete this.dz[key]; return null; });     // blocked or slow: the next click may ask again
    }
    const id = await this.dz[key];
    return id ? SongSearch.deezerUrl(id) : null;
  },

  trackId(t) {
    const m = /(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]+)/.exec((t && (t.uri || t.url)) || '');
    return m ? m[1] : (t && /^[A-Za-z0-9]{22}$/.test(t.id || '') ? t.id : null);
  },

  // Spotify's iFrame API: one script, then IFrameAPI.createController() hands back a controller
  // (loadUri / play / pause + playback_update events) for an embed we never have to show.
  embedApi() {
    const e = this.embed;
    if (!e.api) {
      e.api = new Promise((resolve, reject) => {
        const prev = window.onSpotifyIframeApiReady;
        window.onSpotifyIframeApiReady = api => { if (typeof prev === 'function') prev(api); resolve(api); };
        const s = document.createElement('script');
        s.src = 'https://open.spotify.com/embed/iframe-api/v1';
        s.async = true;
        s.onerror = () => reject(new Error('spotify embed api blocked'));
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('spotify embed api timed out')), 8000);
      });
      e.api.catch(() => { e.api = null; });            // let the next click try again
    }
    return e.api;
  },

  // The embed lives in a tiny Win98 window that is in the viewport but invisible (opacity 0, inert).
  // It can't be display:none or parked off-screen: Spotify creates its iframe with loading="lazy",
  // so an iframe the browser considers out of view never even loads. showEmbed(true) reveals it
  // when the browser insists on a click inside Spotify's own frame.
  showEmbed(on) {
    const host = this.embed.host;
    if (!host) return;
    host.classList.toggle('show', !!on);
    host.inert = !on;
  },

  embedHost() {
    const e = this.embed;
    if (!e.host) {
      const host = document.createElement('div');
      host.className = 'sp-embed';
      host.innerHTML = '<div class="title-bar"><div class="title-bar-text">🎧 Spotify</div>' +
        '<button type="button" class="sp-embed-x" aria-label="stop and close the Spotify player">✕</button></div><div class="sp-embed-body"><div></div></div>';
      host.querySelector('.sp-embed-x').addEventListener('click', () => this.stop());
      host.inert = true;
      document.body.appendChild(host);
      e.host = host;
    }
    return e.host;
  },

  async playEmbed(t, token) {
    const id = this.trackId(t);
    if (!id) return false;
    let api;
    try { api = await this.embedApi(); } catch { return false; }
    if (token !== this.playToken) return true;         // superseded while the script loaded
    const e = this.embed, uri = 'spotify:track:' + id;
    const host = this.embedHost();
    e.started = false;
    this.via = 'spotify';
    if (this.SHOW_EMBED) this.showEmbed(true);
    if (e.ctl) { e.ctl.loadUri(uri); e.ctl.play(); }
    else {
      api.createController(host.querySelector('.sp-embed-body > div'), { uri, width: 300, height: 80 }, ctl => {
        e.ctl = ctl;
        // Spotify builds its iframe with loading="lazy"; an invisible one may never count as "in
        // view", so switch it to eager, which makes the browser load it right away.
        const frame = host.querySelector('iframe');
        if (frame) frame.loading = 'eager';
        ctl.addListener('playback_update', ev => this.onEmbedUpdate(ev && ev.data));
        // play() is queued by the controller until the embed is ready; 'ready' is a second chance
        const go = () => { if (this.via === 'spotify' && this.playing !== -1 && !e.started) ctl.play(); };
        ctl.addListener('ready', go);
        go();
      });
    }
    // some browsers (iPhones especially) only let Spotify start from a tap inside its own frame:
    // if nothing is playing after a few seconds, bring the little player into view instead.
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      if (token === this.playToken && !e.started) { this.showEmbed(true); this.via = 'spotify-wait'; this.paint(); }
    }, 7000);
    this.paint();
    return true;
  },

  onEmbedUpdate(d) {
    const e = this.embed;
    if (!d || !e.ctl) return;
    const ours = this.playing !== -1 && (this.via === 'spotify' || this.via === 'spotify-wait');
    if (!ours) { if (!d.isPaused) e.ctl.pause(); return; }      // it started after we'd moved on
    if (!d.isPaused && d.position > 0) {
      if (!e.started || this.via !== 'spotify') { e.started = true; this.via = 'spotify'; this.paint(); }
      // The embed reports about once a second while it plays and simply goes quiet when the preview
      // runs out, so "no news for a few seconds" (or the last second of the clip) means it's over.
      const token = this.playToken;
      const left = d.duration ? d.duration - d.position : Infinity;
      clearTimeout(e.timer);
      e.timer = setTimeout(() => { if (token === this.playToken) this.stop(); }, left < 1500 ? Math.max(300, left + 200) : 4000);
    } else if (e.started && d.isPaused && !d.isBuffering) this.stop();   // paused inside the player
  },

  stop(quiet) {
    this.playToken++;
    if (this.audio) { this.audio.pause(); this.audio = null; }
    const e = this.embed;
    clearTimeout(e.timer);
    const wasEmbed = this.via === 'spotify' || this.via === 'spotify-wait';
    const was = this.playing;
    this.playing = -1;
    this.via = null;
    e.started = false;
    if (wasEmbed && e.ctl) { try { e.ctl.pause(); } catch { /* embed already gone */ } }
    this.showEmbed(false);
    if (!quiet && was !== -1) this.paint();
  },
};

/* ============== SONG SEARCH + VISITOR TOP SONGS (OurSpace) ============== */
// Visitors pick their own top songs for their My Page. No API keys anywhere: Deezer and iTunes both
// answer searches from the browser through JSONP. Every song is a Track:
//   { src: 'dz' | 'it', id, name, artist, album, art (small cover), artBig, url, link }
// `url` is a playable 30 second preview only where it keeps working: iTunes links do, Deezer links
// expire after ~15 minutes, so a Deezer track is stored with url: null and SongSearch.preview()
// looks its preview up again (by id) when someone presses play.
const SongSearch = {
  LIMIT: 10,                                    // songs per search (each source is asked for this many)
  cache: {},                                    // query → promise of Track[] (this session only)
  live: {},                                     // Deezer id → { url, until }: preview links we know are still good
  twins: {},                                    // title|artist → promise of an iTunes preview (Deezer's backup)

  // lowercase, no "(feat. …)", no punctuation: what two spellings of one song have in common
  norm(s) {
    return String(s || '').toLowerCase().replace(/[(\[]\s*(feat|ft|with)\b[^)\]]*[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  },
  // Deezer lists the main artist only ("Ninajirachi"), iTunes everybody ("Ninajirachi & Porter Robinson")
  firstArtist(s) { return String(s || '').split(/\s*(?:,|&|\s(?:feat\.?|ft\.?|with|x)\s)\s*/i)[0].trim(); },
  // same title + same (first) artist = the same song, whichever site it came from
  dupKey(t) { return this.norm(t && t.name) + '|' + this.norm(this.firstArtist(t && t.artist)); },
  // what "is this one playing?" compares
  key(t) { return t && t.src && t.id ? `${t.src}:${t.id}` : 'song:' + this.dupKey(t); },

  fromDeezer(r) {
    const al = r.album || {};
    return { src: 'dz', id: String(r.id), name: r.title, artist: (r.artist || {}).name || '', album: al.title || '',
      art: al.cover_small || al.cover_medium || '', artBig: al.cover_medium || al.cover_small || '',
      url: null, link: r.link || `https://www.deezer.com/track/${r.id}` };
  },
  fromItunes(r) {
    const big = r.artworkUrl100 || r.artworkUrl60 || '';
    return { src: 'it', id: String(r.trackId), name: r.trackName, artist: r.artistName || '', album: r.collectionName || '',
      art: r.artworkUrl60 || big, artBig: big.replace(/\/\d+x\d+bb\./, '/300x300bb.'),   // Apple sizes covers by URL
      url: r.previewUrl, link: r.trackViewUrl || '' };
  },

  // Deezer preview links carry their own expiry (…?hdnea=exp=<unix seconds>~acl=…, ~15 minutes out)
  remember(id, url) {
    const m = /exp=(\d+)/.exec(url);
    this.live[id] = { url, until: m ? m[1] * 1000 - 60000 : Date.now() + 5 * 60000 };
    return url;
  },
  forget(t) { if (t && t.src === 'dz') delete this.live[t.id]; },

  // each source → Track[] (only songs that come with a preview); rejects when the site can't be reached
  async deezer(q) {
    const d = await SongKit.jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${this.LIMIT}&output=jsonp`);
    if (!d || d.error || !Array.isArray(d.data)) throw new Error('deezer said no');
    return d.data.filter(r => r && r.id && r.title && r.preview).map(r => {
      this.remember(String(r.id), r.preview);        // so ▶ right after a search needn't ask again
      return this.fromDeezer(r);
    });
  },
  async itunes(q) {
    const d = await SongKit.jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${this.LIMIT}`);
    if (!d || !Array.isArray(d.results)) throw new Error('itunes said no');
    return d.results.filter(r => r && r.trackId && r.trackName && r.previewUrl && (!r.kind || r.kind === 'song'))
      .map(r => this.fromItunes(r));
  },

  // Search both sites at once → up to 10 Tracks, Deezer's first, each song once. Rejects only when
  // neither site answered (offline, or a blocker ate both). Debouncing is the caller's job.
  search(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim();
    if (!q) return Promise.resolve([]);
    const k = q.toLowerCase();
    if (!this.cache[k]) {
      this.cache[k] = Promise.allSettled([this.deezer(q), this.itunes(q)]).then(([dz, it]) => {
        if (dz.status === 'rejected' && it.status === 'rejected') throw new Error('neither music site answered');
        if (dz.status === 'rejected' || it.status === 'rejected') delete this.cache[k];   // half an answer: ask again next time
        const seen = new Set(), out = [];
        [...(dz.value || []), ...(it.value || [])].forEach(t => {
          const d = this.dupKey(t);
          if (!seen.has(d) && out.length < this.LIMIT) { seen.add(d); out.push(t); }
        });
        return out;
      });
      this.cache[k].catch(() => { delete this.cache[k]; });
    }
    return this.cache[k].then(list => list.map(t => ({ ...t })));   // copies: callers may keep and change them
  },

  // a playable Deezer link for a track id: the one we have while it's good, else a fresh lookup
  async deezerUrl(id) {
    id = String(id || '');
    const l = this.live[id];
    if (l && l.until > Date.now()) return l.url;
    if (!/^\d+$/.test(id)) return null;
    try {
      const d = await SongKit.jsonp(`https://api.deezer.com/track/${id}?output=jsonp`);
      return d && !d.error && d.preview ? this.remember(id, d.preview) : null;
    } catch { return null; }
  },

  // the same song on iTunes (exact title + first artist): the backup when Deezer won't play one
  itunesTwin(t) {
    const k = this.dupKey(t);
    if (!(k in this.twins)) {
      this.twins[k] = this.itunes(`${this.firstArtist(t.artist)} ${t.name}`.trim())
        .then(list => { const hit = list.find(x => this.dupKey(x) === k); return hit ? hit.url : null; },
          () => { delete this.twins[k]; return null; });
    }
    return this.twins[k];
  },

  // → { url, via: 'dz' | 'it' | 'preview' } or null. TopSongs uses `via` for its "· via …" label.
  async resolve(t) {
    if (!t || !t.name) return null;
    if (t.src !== 'dz') return t.url ? { url: t.url, via: t.src === 'it' ? 'it' : 'preview' } : null;
    const url = await this.deezerUrl(t.id);
    if (url) return { url, via: 'dz' };
    const twin = await this.itunesTwin(t);
    return twin ? { url: twin, via: 'it' } : null;
  },

  // a playable 30 second preview url for a Track, or null when nothing will play
  preview(t) { return this.resolve(t).then(r => (r ? r.url : null), () => null); },

  // The song chooser for Edit My Page: a search box (Enter or the button; typing searches too, after
  // a pause) → results (cover, title/artist, ▶ preview, add) → the chosen list (▲ ▼ to reorder,
  // ✕ to remove). onChange(picked) gets a fresh copy of the chosen Tracks after every change; the
  // element also has .getPicked(). Previews play through TopSongs (one song at a time, everywhere).
  picker({ max = 5, picked = [], onChange, placeholder } = {}) {
    const mk = SongKit.mk;
    const chosen = (Array.isArray(picked) ? picked : []).filter(t => t && t.name).map(t => ({ ...t }));
    let results = [], seq = 0, timer = 0, lastQ = '';

    const root = mk('div', 'ss-picker ts-view');
    const bar = mk('div', 'ss-bar');
    const input = mk('input', 'ss-q');
    input.type = 'text'; input.maxLength = 80; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = placeholder || 'song title or band…';
    input.setAttribute('aria-label', 'search for a song');
    const go = mk('button', 'btn98 ss-go', 'Search');
    go.type = 'button';
    bar.append(input, go);
    const HINT = 'type a song or a band, then hit search. ▶ plays 30 seconds, + add puts it on your page.';
    const msg = mk('div', 'ss-msg', HINT);
    msg.setAttribute('role', 'status');
    const list = mk('ol', 'sp-list ss-results');
    const head = mk('div', 'ss-head');
    const mine = mk('ol', 'sp-list ss-picked');
    root.append(bar, msg, list, head, mine);

    const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('bad', !!bad); };
    const has = t => chosen.some(c => SongSearch.key(c) === SongSearch.key(t) || SongSearch.dupKey(c) === SongSearch.dupKey(t));
    const changed = () => {
      paintResults(); paintPicked();
      if (typeof onChange === 'function') onChange(chosen.map(t => ({ ...t })));
    };

    const paintResults = () => SongKit.keepFocus(list, () => {
      list.innerHTML = '';
      list.hidden = !results.length;
      results.forEach(t => {
        const got = has(t), full = chosen.length >= max;
        const add = mk('button', 'btn98 ss-add', got ? '✔ added' : '+ add');
        add.type = 'button';
        add.disabled = got || full;
        add.title = got ? 'already on your list' : full ? `that's ${max} already. take one off first` : 'add it to your top songs';
        add.setAttribute('aria-label', got ? `${t.name} is already on your list` : `add ${t.name} to your top songs`);
        add.dataset.focus = SongSearch.key(t) + ':add';
        add.addEventListener('click', () => { if (!has(t) && chosen.length < max) { chosen.push({ ...t }); changed(); } });
        list.appendChild(TopSongs.row(t, { tools: [add] }));
      });
    });

    const move = (i, by) => {
      const j = i + by;
      if (j < 0 || j >= chosen.length) return;
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
      changed();
    };
    const paintPicked = () => SongKit.keepFocus(mine, () => {
      head.textContent = chosen.length ? `your top songs (${chosen.length} of ${max}):` : `your top songs: none yet. you get ${max}.`;
      mine.innerHTML = '';
      mine.hidden = !chosen.length;
      chosen.forEach((t, i) => {
        const tool = (txt, label, fn, off) => {
          const b = mk('button', 'btn98 ss-tool', txt);
          b.type = 'button'; b.title = label; b.disabled = !!off;
          b.setAttribute('aria-label', `${label}: ${t.name}`);
          b.dataset.focus = SongSearch.key(t) + ':' + txt;
          b.addEventListener('click', fn);
          return b;
        };
        mine.appendChild(SongKit.row({
          rank: i + 1, name: t.name, artist: t.artist, album: t.album, art: t.art, href: t.link,
          tools: [tool('▲', 'move up', () => move(i, -1), i === 0),
            tool('▼', 'move down', () => move(i, 1), i === chosen.length - 1),
            tool('✕', 'remove', () => { chosen.splice(i, 1); changed(); })],
        }));
      });
    });

    // now = Enter / the button (always searches, even the same words again); otherwise it's typing
    const run = async now => {
      clearTimeout(timer);
      const q = input.value.replace(/\s+/g, ' ').trim();
      if (!q) {
        lastQ = ''; seq++; results = []; paintResults();
        say(now ? 'type a song name or a band first. even one word works.' : HINT, now);
        return;
      }
      if (!now && (q === lastQ || q.length < 2)) return;
      lastQ = q;
      const ticket = ++seq;
      say(`searching for “${q}”…`);
      try {
        const found = await SongSearch.search(q);
        if (ticket !== seq) return;                   // a newer search is on its way
        results = found;
        say(found.length ? `${found.length} song${found.length === 1 ? '' : 's'} found for “${q}”.`
          : `no songs found for “${q}”. check the spelling, or try just the band name.`, !found.length);
      } catch {
        if (ticket !== seq) return;
        results = [];
        say('couldn\'t reach the music sites (deezer + itunes). the internet or a blocker is in the way. try again in a minute.', true);
      }
      paintResults();
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(false), 700); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(true); } });
    go.addEventListener('click', () => run(true));

    root._tsPaint = paintResults;                     // TopSongs repaints the ▶ buttons as songs start and stop
    root.getPicked = () => chosen.map(t => ({ ...t }));
    paintResults(); paintPicked();
    return root;
  },
};

// A visitor's own top songs on their My Page, in the same look as malten's list (SongKit rows +
// the shared volume row). This is also the one player for every visitor-picked song: list rows and
// the picker's ▶ buttons all play through here, so one song plays at a time.
const TopSongs = {
  audio: null, playing: null, via: null,        // playing = SongSearch.key() of the song making sound
  playToken: 0,                                 // bumped on every play/stop so a slow lookup can't start a stale song

  // Paint `tracks` into `box` (cheap and repeatable — My Page re-renders a lot). `title` is an
  // optional heading inside the box. An empty list gets one quiet line and nothing else.
  mount(box, tracks, { title } = {}) {
    const songs = (Array.isArray(tracks) ? tracks : []).filter(t => t && t.name).map(t => ({ ...t }));
    box.classList.add('sp-box', 'ts-box', 'ts-view');
    box._tsPaint = () => SongKit.keepFocus(box, () => {
      box.innerHTML = '';
      if (title) box.appendChild(SongKit.mk('div', 'ts-title', title));
      if (!songs.length) { box.appendChild(SongKit.mk('div', 'ts-empty', '♪ no top songs picked yet. the jukebox is empty.')); return; }
      const list = SongKit.mk('ol', 'sp-list');
      songs.forEach((t, i) => list.appendChild(this.row(t, { rank: i + 1 })));
      box.append(list, SongKit.volumeRow());
    });
    box._tsPaint();
    return box;
  },

  // every list and picker on the page that shows our ▶ buttons
  paint() { document.querySelectorAll('.ts-view').forEach(el => { if (el._tsPaint) el._tsPaint(); }); },

  label() {
    return { loading: 'finding a preview…', dz: '♪ 30 second preview · via Deezer',
      it: '♪ 30 second preview · via iTunes', preview: '♪ 30 second preview' }[this.via] || '';
  },

  // a SongKit row for a Track, wired to this player (`extra` adds/overrides row fields: rank, tools)
  row(t, extra) {
    const key = SongSearch.key(t), on = this.playing === key;
    const site = { dz: 'open on deezer ↗', it: 'open in itunes ↗' }[t.src] || '';
    return SongKit.row(Object.assign({
      name: t.name, artist: t.artist, album: t.album, art: t.art, artBig: t.artBig || t.art,
      href: t.link, hrefTitle: site,
      on, busy: on && this.via === 'loading', via: this.label(),
      canPlay: t.src === 'dz' ? !!t.id : !!t.url,
      onToggle: () => this.toggle(t), key,
    }, extra));
  },

  // play / stop a Track. Deezer links are looked up fresh (SongSearch.resolve); a Deezer link that
  // turns out dead gets one more lookup before we give up.
  async toggle(t) {
    const key = SongSearch.key(t);
    if (this.playing === key) { this.stop(); return; }
    SongKit.hush(this);
    this.stop(true);
    const token = ++this.playToken;
    const mine = () => token === this.playToken;
    this.playing = key;
    this.via = 'loading';
    this.paint();
    for (let tries = 0; tries < 2; tries++) {
      const got = await SongSearch.resolve(t).catch(() => null);
      if (!mine()) return;
      if (got && await SongKit.playAudio(this, got.url, token, got.via)) return;
      if (!mine()) return;
      if (!got || got.via !== 'dz') break;
      SongSearch.forget(t);
    }
    this.stop();
    if (window.MS && MS.toast) MS.toast('couldn\'t find a preview for that one — the title opens the song instead');
  },

  // stops whatever visitor song is playing (lists and picker alike). OurSpace calls it when you leave a page.
  stop(quiet) {
    this.playToken++;
    if (this.audio) { this.audio.pause(); this.audio = null; }
    const was = this.playing;
    this.playing = null;
    this.via = null;
    if (!quiet && was !== null) this.paint();
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
    this.prefillName();
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
    if (saved) this.$('#screenName').value = saved;      // (no saved name: mount() offers the profile name)

    this.$('#sendButton').addEventListener('click', () => this.send());
    this.$('#message').addEventListener('keypress', e => {
      if (e.key === 'Enter') this.send();
    });
    this.paintStatus();
  },

  // Nobody has signed from this browser yet (no malten_sn): offer the name from their OurSpace
  // profile, if they made one. Only an empty box gets filled, and only what they actually sign
  // with is remembered (send() saves it).
  prefillName() {
    const sn = this.$('#screenName');
    if (!sn || sn.value || localStorage.getItem('malten_sn')) return;
    let name = '';
    try { name = window.MS && MS.myName ? String(MS.myName() || '').trim() : ''; } catch { /* no profile yet */ }
    if (name.toLowerCase() === 'guest') return;      // myName()'s stand-in before the sign-up: not a name anyone chose
    sn.value = name.slice(0, 20);
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
Object.assign(window, { Mines, Paint, Spotify, Guestbook, SongSearch, TopSongs });

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
