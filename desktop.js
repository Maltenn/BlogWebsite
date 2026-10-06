/* ============================================================
   desktop.js — window manager, taskbar, start menu, and all the
   ambient early-internet magic (sparkles, CRT, screensaver, BSOD)
   ============================================================ */

// ---------- tiny retro sound engine (no audio files needed) ----------
const Sfx = {
  ctx: null,
  muted: localStorage.getItem('malten_muted') === '1',
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  beep(freq, dur = 0.07, type = 'square', vol = 0.04, when = 0) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  open()  { this.beep(520, .06); this.beep(780, .09, 'square', .04, .06); },
  close() { this.beep(660, .06); this.beep(392, .1, 'square', .04, .06); },
  click() { this.beep(1000, .03, 'square', .025); },
  error() { this.beep(180, .18, 'sawtooth', .05); },
  tada()  { [523, 659, 784, 1047].forEach((f, i) => this.beep(f, .12, 'triangle', .05, i * .09)); },
  // AIM-style presence sounds
  doorOpen()  { [196, 294, 392].forEach((f, i) => this.beep(f, .07, 'triangle', .05, i * .055)); },
  doorSlam()  { this.beep(95, .14, 'square', .09); this.beep(62, .2, 'sawtooth', .07, .03); },
  // MSN-style nudge buzz
  buzz() { for (let i = 0; i < 7; i++) this.beep(i % 2 ? 68 : 92, .05, 'sawtooth', .06, i * .05); },
};

// ---------- window manager (desktop pages only) ----------
const WM = {
  z: 100,
  wins: new Map(),
  zoomSteps: 9,       // the Win95 "zoom" animation draws this many outline frames…
  zoomStepMs: 24,     // …this far apart (about 220ms in all)

  init() {
    const desktop = document.getElementById('desktop');
    if (!desktop) return;

    const onLoad = [];
    document.querySelectorAll('.window[data-app]').forEach(el => {
      const id = el.dataset.app;
      this.wins.set(id, { el, taskBtn: null, opened: false, zoom: null });
      el.style.left = (el.dataset.x || 100) + 'px';
      el.style.top = (el.dataset.y || 60) + 'px';
      if (el.dataset.w) el.style.width = el.dataset.w + 'px';

      el.addEventListener('pointerdown', () => this.focus(id));
      this.wireTitleBar(id, el);
      this.makeDraggable(id, el);

      if (el.classList.contains('open-on-load')) onLoad.push(id);
      else el.classList.add('closed');
    });
    document.body.classList.add('wm-ready');   // styles.css keeps windows hidden until they are placed
    // only the front window (the last open-on-load one) zooms up from the Start button
    onLoad.forEach((id, i) => this.open(id, true, i === onLoad.length - 1 ? null : false));

    window.addEventListener('resize', () => this.reflow());
  },

  wireTitleBar(id, el) {
    const controls = el.querySelectorAll('.title-bar-controls img');
    controls.forEach(img => {
      img.addEventListener('click', e => {
        e.stopPropagation();
        const act = (img.alt || '').toLowerCase();
        if (act.includes('min')) this.minimize(id);
        else if (act.includes('max')) this.maximize(id);
        else if (act.includes('close')) this.close(id);
      });
    });
  },

  makeDraggable(id, el) {
    const bar = el.querySelector('.title-bar');
    if (!bar) return;
    bar.addEventListener('dblclick', e => {
      if (e.target.closest('.title-bar-controls')) return;
      this.maximize(id);
    });
    bar.addEventListener('pointerdown', e => {
      if (e.target.closest('.title-bar-controls')) return;
      if (window.innerWidth <= 820 || el.classList.contains('maximized')) return;
      const startX = e.clientX, startY = e.clientY;
      const origX = el.offsetLeft, origY = el.offsetTop;
      bar.setPointerCapture(e.pointerId);
      const move = ev => {
        el.style.left = Math.max(-el.offsetWidth + 60, origX + ev.clientX - startX) + 'px';
        el.style.top = Math.max(0, origY + ev.clientY - startY) + 'px';
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  },

  shown(el) { return !el.classList.contains('closed') && !el.classList.contains('minimized'); },

  // keep a floating window reachable. Hidden and maximized windows report no real
  // offsets, so they are left alone (their saved position must survive).
  clamp(el) {
    if (window.innerWidth <= 820 || !this.shown(el) || el.classList.contains('maximized')) return;
    const desk = document.getElementById('desktop');
    el.style.left = Math.max(0, Math.min(el.offsetLeft, desk.clientWidth - el.offsetWidth - 4)) + 'px';
    el.style.top = Math.max(0, Math.min(el.offsetTop, desk.clientHeight - 60)) + 'px';
  },

  clampAll() {
    this.wins.forEach(({ el }) => this.clamp(el));
  },

  // tell an app its window changed size (maximize / restore, or the viewport moved under it)
  resized(id) {
    document.dispatchEvent(new CustomEvent('app-resize', { detail: id }));
  },

  // the viewport (or one of the marquee bars) changed size
  reflow() {
    this.clampAll();
    this.wins.forEach(({ el }, id) => {
      if (this.shown(el) && (el.classList.contains('maximized') || window.innerWidth <= 820)) this.resized(id);
    });
  },

  // from: the element (or rect) the window zooms out of — defaults to the Start button.
  // Pass false to skip the animation.
  open(id, silent, from) {
    const w = this.wins.get(id);
    if (!w) return;
    const wasMin = w.el.classList.contains('minimized');
    const wasHidden = !w.opened || !this.shown(w.el);
    w.el.classList.remove('closed', 'minimized');
    if (!w.opened) {
      // data-start-maximized: born maximized on the first open, no small frame first
      w.opened = true;
      if (w.el.hasAttribute('data-start-maximized') && window.innerWidth > 820) w.el.classList.add('maximized');
    }
    if (!w.taskBtn) {
      const btn = document.createElement('button');
      btn.className = 'btn98';
      btn.textContent = w.el.dataset.title || id;
      btn.addEventListener('click', () => {
        if (w.el.classList.contains('minimized')) this.restore(id);
        else if (!w.el.classList.contains('focused')) this.focus(id);
        else this.minimize(id);
      });
      document.getElementById('task-buttons').appendChild(btn);
      w.taskBtn = btn;
    }
    this.clamp(w.el);
    this.focus(id);
    if (!silent) Sfx.open();
    document.dispatchEvent(new CustomEvent('app-open', { detail: id }));
    if (wasHidden && from !== false) {
      const start = document.getElementById('start-btn');
      const origin = wasMin ? w.taskBtn : (from && this.rect(from).width ? from : start);
      this.zoom(w, origin, w.el, true);
    }
  },

  close(id) {
    const w = this.wins.get(id);
    if (!w) return;
    this.endZoom(w);
    w.el.classList.add('closed');
    w.el.classList.remove('focused', 'minimized');   // 'maximized' stays: it reopens the way it was closed
    if (w.taskBtn) { w.taskBtn.remove(); w.taskBtn = null; }
    Sfx.close();
    document.dispatchEvent(new CustomEvent('app-close', { detail: id }));
  },

  minimize(id) {
    const w = this.wins.get(id);
    if (!w) return;
    const from = w.el.getBoundingClientRect();
    w.el.classList.add('minimized');
    w.el.classList.remove('focused');
    if (w.taskBtn) w.taskBtn.classList.remove('pressed');
    this.zoom(w, from, w.taskBtn, false);
    Sfx.click();
  },

  // bring a minimized window back up out of its taskbar button
  restore(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.classList.remove('minimized');
    this.clamp(w.el);
    this.focus(id);
    this.zoom(w, w.taskBtn, w.el, true);
    if (w.el.classList.contains('maximized')) this.resized(id);
  },

  // toggles by default; pass on = true / false to force a state (a no-op if already there)
  maximize(id, on) {
    const w = this.wins.get(id);
    if (!w) return;
    const max = typeof on === 'boolean' ? on : !w.el.classList.contains('maximized');
    if (max === w.el.classList.contains('maximized')) return;
    w.el.classList.toggle('maximized', max);
    this.clamp(w.el);
    this.focus(id);
    Sfx.click();
    this.resized(id);
  },

  rect(r) { return r && r.getBoundingClientRect ? r.getBoundingClientRect() : (r || {}); },

  // The classic Win95/98 window zoom: a title-bar-coloured outline steps from one rect to
  // another (taskbar button / launcher <-> window). Zooming IN keeps the real window
  // invisible until the outline lands on it, so nothing flashes at the final position.
  zoom(w, from, to, zoomIn) {
    this.endZoom(w);
    const a = this.rect(from), b = this.rect(to);
    if (!a.width || !b.width || document.hidden || window.innerWidth <= 820 ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ghost = document.createElement('div');
    ghost.className = 'wm-zoom';
    ghost.appendChild(document.createElement('span')).textContent = w.el.dataset.title || '';
    const place = t => ['left', 'top', 'width', 'height'].forEach(k => {
      ghost.style[k] = Math.round(a[k] + (b[k] - a[k]) * t) + 'px';
    });
    place(0);
    document.body.appendChild(ghost);
    if (zoomIn) w.el.classList.add('wm-zooming');
    let step = 0;
    const timer = setInterval(() => {
      if (++step >= this.zoomSteps || document.hidden) this.endZoom(w);
      else place(step / this.zoomSteps);
    }, this.zoomStepMs);
    w.zoom = { ghost, timer };
  },

  endZoom(w) {
    if (!w.zoom) return;
    clearInterval(w.zoom.timer);
    w.zoom.ghost.remove();
    w.zoom = null;
    w.el.classList.remove('wm-zooming');
  },

  focus(id) {
    this.wins.forEach((w, wid) => {
      const on = wid === id;
      w.el.classList.toggle('focused', on);
      if (w.taskBtn) w.taskBtn.classList.toggle('pressed', on);
    });
    const w = this.wins.get(id);
    if (w) w.el.style.zIndex = ++this.z;
  },
};

// ---------- launchers (desktop icons, Start menu items, in-window links) ----------
// data-open="app" opens that window. data-mstab="tab" opens OurSpace on that tab
// (data-msarg = the tab's argument, data-msjump = a section to scroll to via MS.jumpTo).
// `from` is where the window zooms out of.
// On sub-pages (blog, 404) there are no windows to open, so the same launcher walks back to the
// desktop with a deep link (index.html?open=paint / ?tab=guestbook&jump=…) that openDeepLink() honours.
function launch(el, from) {
  if (!document.getElementById('desktop')) {
    const q = new URLSearchParams();
    if (el.dataset.mstab) {
      q.set('tab', el.dataset.mstab);
      if (el.dataset.msarg) q.set('arg', el.dataset.msarg);
      if (el.dataset.msjump) q.set('jump', el.dataset.msjump);
    } else if (el.dataset.open) q.set('open', el.dataset.open);
    window.location.href = 'index.html' + (String(q) ? '?' + q : '');
    return;
  }
  if (el.dataset.mstab) {
    WM.open('myspace', false, from);
    // ourspace.js declares MS with a top-level const, which is NOT a window property —
    // a window.MS guard is always false, so test the bare name instead
    const ms = typeof MS !== 'undefined' ? MS : null;
    if (ms && ms.state) ms.show(el.dataset.mstab, el.dataset.msarg || undefined);
    if (ms && ms.jumpTo && el.dataset.msjump) ms.jumpTo(el.dataset.msjump);
  } else if (el.dataset.open) {
    WM.open(el.dataset.open, false, from);
  }
}

function initLaunchers() {
  document.querySelectorAll('.desk-icon[data-open], .desk-icon[data-mstab], a.launcher').forEach(el =>
    el.addEventListener('click', e => { e.preventDefault(); launch(el, el); }));
}

// index.html?open=<app>  ·  index.html?tab=<ourspace tab>[&arg=…][&jump=<My Page box>]
// Runs after every script has booted (OurSpace builds itself on DOMContentLoaded too).
function openDeepLink() {
  if (!document.getElementById('desktop')) return;
  const q = new URLSearchParams(window.location.search);
  const el = { dataset: {} };
  if (q.get('tab')) Object.assign(el.dataset, { mstab: q.get('tab'), msarg: q.get('arg') || '', msjump: q.get('jump') || '' });
  else if (q.get('open')) el.dataset.open = q.get('open');
  else return;
  launch(el, document.getElementById('start-btn'));
  // a reload should land on the plain desktop again, not re-run the link
  if (window.history && history.replaceState) history.replaceState(null, '', window.location.pathname);
}

// ---------- sub-pages (blog posts, blog hub, 404) ----------
// They are ordinary scrolling pages, but they get the desktop's taskbar, Start menu, tray and
// easter eggs so they feel like part of the same machine. index.html ships this markup itself;
// everywhere else it is injected here — keep the two Start menus in step when you change one.
function ensureShell() {
  if (document.getElementById('taskbar')) return false;
  document.body.classList.add('subpage');
  document.body.insertAdjacentHTML('beforeend', `
    <div id="taskbar">
      <button class="btn98" id="start-btn"><span class="logo">💜</span> Start</button>
      <div id="task-buttons"></div>
      <div id="tray">
        <span class="tray-ico" id="tray-mute" title="mute sounds">🔊</span>
        <span class="tray-ico" id="tray-sparkle" title="toggle sparkles">✨</span>
        <span class="tray-ico" id="tray-crt" title="toggle CRT mode">📺</span>
        <span id="clock"></span>
      </div>
    </div>
    <div id="start-menu" hidden>
      <div class="side">MALTEN 98</div>
      <ul>
        <li data-href="index.html"><span class="mi">🖥️</span> Desktop</li>
        <li data-href="blog-hub.html"><span class="mi">📁</span> Blog Posts</li>
        <li data-open="myspace"><span class="mi">👥</span> OurSpace</li>
        <li data-mstab="guestbook"><span class="mi">📖</span> Guestbook</li>
        <li data-mstab="profile" data-msarg="malten" data-msjump="spotify"><span class="mi">🎧</span> MaltenAmp — my Spotify top 5</li>
        <li class="sep"></li>
        <li data-open="mines"><span class="mi">💣</span> Minesweeper</li>
        <li data-open="paint"><span class="mi">🎨</span> Paint</li>
        <li data-open="glitter"><span class="mi">✨</span> Glitter Studio</li>
        <li data-open="internet"><span class="mi">🌐</span> The Internet</li>
        <li class="sep"></li>
        <li data-open="settings"><span class="mi">🎛</span> Control Panel</li>
        <li data-action="sparkles"><span class="mi">✨</span> Toggle Sparkles</li>
        <li data-action="crt"><span class="mi">📺</span> Toggle CRT Mode</li>
        <li data-action="screensaver"><span class="mi">🌌</span> Start Screensaver</li>
        <li class="sep"></li>
        <li data-action="shutdown"><span class="mi">🔌</span> Shut Down…</li>
      </ul>
    </div>
    <div id="bsod" hidden>
      <div>
        <p><span class="bsod-title">MALTEN.EXE</span></p>
        <p>A fatal exception 0xC0FFEE has occurred at 0028:C0DE1337.
        The current application (your visit) will be terminated.</p>
        <p>*&nbsp; It is now safe to close this tab.<br>
           *&nbsp; Or press any key to keep hanging out. honestly? preferred.</p>
        <p class="blink">Press any key to continue _</p>
      </div>
    </div>
    <canvas id="screensaver" hidden></canvas>`);
  return true;
}

// The page's one window behaves like a real one: a taskbar button for it (plus one that walks
// back to the desktop), minimize tucks it into the taskbar, maximize widens the reading column,
// and close goes home to the desktop.
function initSubpage() {
  const win = document.querySelector('.page-window') || document.querySelector('.container .window');
  const tasks = document.getElementById('task-buttons');
  if (!win || !tasks) return;
  const mk = (label, title) => {
    const b = document.createElement('button');
    b.className = 'btn98';
    b.textContent = label;
    if (title) b.title = title;
    tasks.appendChild(b);
    return b;
  };
  mk('🖥️ Desktop', 'back to the desktop').addEventListener('click', () => { Sfx.click(); window.location.href = 'index.html'; });
  const label = win.dataset.task || (win.querySelector('.title-bar-text') || {}).textContent || document.title;
  const mine = mk(label.trim());
  const setMin = on => {
    win.classList.toggle('minimized', on);
    mine.classList.toggle('pressed', !on);
    Sfx.click();
  };
  mine.classList.add('pressed');
  mine.addEventListener('click', () => setMin(!win.classList.contains('minimized')));
  win.querySelectorAll('.title-bar-controls img').forEach(img => {
    const act = (img.alt || '').toLowerCase();
    img.addEventListener('click', () => {
      if (act.includes('min')) setMin(true);
      else if (act.includes('max')) { document.body.classList.toggle('page-wide'); Sfx.click(); }
      else if (act.includes('close')) { Sfx.close(); window.location.href = win.dataset.close || 'index.html'; }
    });
  });
  const bar = win.querySelector('.title-bar');
  if (bar) bar.addEventListener('dblclick', e => { if (!e.target.closest('.title-bar-controls')) document.body.classList.toggle('page-wide'); });
}

// ---------- start menu ----------
function initStartMenu() {
  const btn = document.getElementById('start-btn');
  const menu = document.getElementById('start-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.classList.toggle('pressed', !menu.hidden);
    Sfx.click();
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
      btn.classList.remove('pressed');
    }
  });
  menu.querySelectorAll('li[data-open], li[data-mstab]').forEach(li =>
    li.addEventListener('click', () => { menu.hidden = true; btn.classList.remove('pressed'); launch(li, btn); }));
  menu.querySelectorAll('li[data-href]').forEach(li =>
    li.addEventListener('click', () => { window.location.href = li.dataset.href; }));
  menu.querySelectorAll('li[data-action]').forEach(li =>
    li.addEventListener('click', () => {
      menu.hidden = true;
      btn.classList.remove('pressed');
      const act = li.dataset.action;
      if (act === 'screensaver') Screensaver.start();
      if (act === 'shutdown') showBsod();
      if (act === 'crt') Toggles.crt();
      if (act === 'sparkles') Toggles.sparkles();
    }));
}

// ---------- tray toggles / clock ----------
const Toggles = {
  sparklesOn: localStorage.getItem('malten_sparkles') !== '0',
  crtOn: localStorage.getItem('malten_crt') === '1',
  tickerOn: localStorage.getItem('malten_ticker') !== '0',
  badgesOn: localStorage.getItem('malten_badges') !== '0',
  // the two marquee bars fold down to a slim strip; the desktop takes the freed space
  ticker() {
    this.tickerOn = !this.tickerOn;
    localStorage.setItem('malten_ticker', this.tickerOn ? '1' : '0');
    this.paintBars();
    Sfx.click();
  },
  badges() {
    this.badgesOn = !this.badgesOn;
    localStorage.setItem('malten_badges', this.badgesOn ? '1' : '0');
    this.paintBars();
    Sfx.click();
  },
  paintBars() {
    const paint = (id, cls, on, hide, show, what) => {
      document.body.classList.toggle(cls, !on);
      const b = document.getElementById(id);
      if (!b) return;
      b.textContent = on ? hide : show;
      b.title = (on ? 'hide the ' : 'show the ') + what;
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    paint('ticker-toggle', 'ticker-off', this.tickerOn, '▲', '▼', 'news ticker');
    paint('badgebar-toggle', 'badges-off', this.badgesOn, '▼', '▲', 'badge bar');
    WM.reflow();
  },
  crt() {
    this.crtOn = !this.crtOn;
    document.body.classList.toggle('crt', this.crtOn);
    localStorage.setItem('malten_crt', this.crtOn ? '1' : '0');
    this.paintTray();
    Sfx.click();
  },
  sparkles() {
    this.sparklesOn = !this.sparklesOn;
    localStorage.setItem('malten_sparkles', this.sparklesOn ? '1' : '0');
    this.paintTray();
    Sfx.click();
  },
  mute() {
    Sfx.muted = !Sfx.muted;
    localStorage.setItem('malten_muted', Sfx.muted ? '1' : '0');
    this.paintTray();
  },
  paintTray() {
    const s = document.getElementById('tray-sparkle');
    const c = document.getElementById('tray-crt');
    const m = document.getElementById('tray-mute');
    if (s) s.classList.toggle('off', !this.sparklesOn);
    if (c) c.classList.toggle('off', !this.crtOn);
    if (m) m.textContent = Sfx.muted ? '🔇' : '🔊';
  },
  init() {
    document.body.classList.toggle('crt', this.crtOn);
    const s = document.getElementById('tray-sparkle');
    const c = document.getElementById('tray-crt');
    const m = document.getElementById('tray-mute');
    if (s) s.addEventListener('click', () => this.sparkles());
    if (c) c.addEventListener('click', () => this.crt());
    if (m) m.addEventListener('click', () => this.mute());
    this.paintTray();
    const t = document.getElementById('ticker-toggle');
    const b = document.getElementById('badgebar-toggle');
    if (t) t.addEventListener('click', () => this.ticker());
    if (b) b.addEventListener('click', () => this.badges());
    if (t || b) this.paintBars();
  },
};

function initClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => {
    const d = new Date();
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    el.textContent = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
  };
  tick();
  setInterval(tick, 15000);
}

// ---------- mouse trail (multiple styles) ----------
const TRAIL_STYLES = {
  stars:   { chars: ['✦', '✧', '⋆', '✩', '·'], colors: ['#fff', '#ffd6ff', '#b967ff', '#01cdfe', '#fffb96', '#ff71ce'], anim: 'sparkle-fall', every: 45 },
  comet:   { chars: ['●', '•', '·'], colors: ['#ffdd55', '#ff9933', '#ff5555', '#ffee99'], anim: 'sparkle-fall', every: 28 },
  bubbles: { chars: ['○', 'º', '◦', 'o'], colors: ['#aee6ff', '#d6f0ff', '#c8b6ff', '#b6ffd8'], anim: 'sparkle-rise', every: 55 },
  hearts:  { chars: ['💜', '💖', '✨', '💕'], colors: ['#ff71ce', '#b967ff'], anim: 'sparkle-fall', every: 70 },
};

function setTrail(name) {
  Toggles.trailStyle = TRAIL_STYLES[name] ? name : 'stars';
  localStorage.setItem('malten_trail', Toggles.trailStyle);
}

function initSparkles() {
  Toggles.trailStyle = localStorage.getItem('malten_trail') || 'stars';
  if (!TRAIL_STYLES[Toggles.trailStyle]) Toggles.trailStyle = 'stars';
  let last = 0;
  document.addEventListener('mousemove', e => {
    if (!Toggles.sparklesOn) return;
    const st = TRAIL_STYLES[Toggles.trailStyle] || TRAIL_STYLES.stars;
    const now = performance.now();
    if (now - last < st.every) return;
    last = now;
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.style.animationName = st.anim;
    s.textContent = st.chars[Math.floor(Math.random() * st.chars.length)];
    s.style.color = st.colors[Math.floor(Math.random() * st.colors.length)];
    s.style.left = e.clientX + (Math.random() * 14 - 7) + 'px';
    s.style.top = e.clientY + (Math.random() * 14 - 7) + 'px';
    document.body.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  });
}

// ---------- custom cursors (emoji rendered to canvas) ----------
const CURSORS = { default: null, wand: '🪄', sword: '🗡️', banana: '🍌', heart: '💜', dino: '🦖' };

function setCursor(name) {
  const emoji = CURSORS[name];
  localStorage.setItem('malten_cursor', name in CURSORS ? name : 'default');
  if (!emoji) { document.body.style.cursor = ''; return; }
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d');
  x.font = '24px serif';
  x.textBaseline = 'top';
  x.fillText(emoji, 2, 2);
  document.body.style.cursor = `url(${c.toDataURL()}) 4 4, auto`;
}

function initCursor() {
  const saved = localStorage.getItem('malten_cursor');
  if (saved && saved !== 'default') setCursor(saved);
}

// ---------- hit counter ----------
function initHitCounter() {
  const el = document.getElementById('hit-counter');
  if (!el) return;
  let hits = window.__maltenHits;
  if (!hits) {                      // count the visit once per page load, re-render freely
    hits = parseInt(localStorage.getItem('malten_hits') || '0', 10);
    if (!hits) hits = 13336 + Math.floor(Math.random() * 500);
    hits += 1;
    localStorage.setItem('malten_hits', String(hits));
    window.__maltenHits = hits;
  }
  el.innerHTML = '';
  String(hits).padStart(6, '0').split('').forEach(d => {
    const s = document.createElement('span');
    s.textContent = d;
    el.appendChild(s);
  });
}

// ---------- BSOD easter egg ----------
function showBsod() {
  const b = document.getElementById('bsod');
  if (!b) return;
  b.hidden = false;
  Sfx.error();
  const hide = () => { b.hidden = true; document.removeEventListener('keydown', hide); };
  b.addEventListener('click', hide, { once: true });
  document.addEventListener('keydown', hide, { once: true });
}

// ---------- screensaver (idle: 3D pipes by default; starfield + bouncing pfp, toasters, matrix) ----------
const Screensaver = {
  idleMs: 90000,
  timer: null,
  raf: null,
  armed: false,

  init() {
    const cv = document.getElementById('screensaver');
    if (!cv) return;
    this.armed = true;
    // someone reading a long blog post sits still for minutes at a time — don't pounce on them
    if (!document.getElementById('desktop')) this.idleMs = 10 * 60000;
    const reset = () => {
      clearTimeout(this.timer);
      if (!cv.hidden) this.stop();
      this.timer = setTimeout(() => this.start(), this.idleMs);
    };
    ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll'].forEach(ev =>
      document.addEventListener(ev, reset, { passive: true }));
    reset();
  },

  mode() { return localStorage.getItem('malten_saver') || 'pipes'; },   // pipes unless the Control Panel says otherwise
  setMode(m) { localStorage.setItem('malten_saver', m); },

  start(forceMode) {
    const cv = document.getElementById('screensaver');
    if (!cv || !cv.hidden) return;
    cv.hidden = false;
    cv.width = innerWidth;
    cv.height = innerHeight;
    const ctx = cv.getContext('2d');
    const mode = forceMode || this.mode();
    const scenes = { starfield: this.sceneStarfield, pipes: this.scenePipes, toasters: this.sceneToasters, matrix: this.sceneMatrix };
    const step = (scenes[mode] || this.scenePipes).call(this, cv, ctx);
    const draw = () => { step(); this.raf = requestAnimationFrame(draw); };
    draw();
  },

  sceneStarfield(cv, ctx) {
    const stars = Array.from({ length: 140 }, () => ({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      s: Math.random() * 2 + 0.4, v: Math.random() * 1.6 + 0.3,
    }));
    const img = new Image();
    img.src = 'pfp.png';
    const logo = { x: 80, y: 80, vx: 2.2, vy: 1.8, w: 96, h: 96 };
    return () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#fff';
      stars.forEach(st => {
        st.x -= st.v;
        if (st.x < 0) { st.x = cv.width; st.y = Math.random() * cv.height; }
        ctx.fillRect(st.x, st.y, st.s, st.s);
      });
      logo.x += logo.vx; logo.y += logo.vy;
      if (logo.x < 0 || logo.x + logo.w > cv.width) logo.vx *= -1;
      if (logo.y < 0 || logo.y + logo.h > cv.height - 24) logo.vy *= -1;
      if (img.complete && img.naturalWidth) ctx.drawImage(img, logo.x, logo.y, logo.w, logo.h);
      ctx.fillStyle = '#9370DB';
      ctx.font = 'bold 13px Courier New';
      ctx.fillText('MALTEN.EXE', logo.x + 12, logo.y + logo.h + 16);
    };
  },

  // 3D Pipes on a flat canvas: pipes wander a 3D lattice drawn in oblique projection (the
  // depth axis runs diagonally), never re-enter a used cell, and get a ball joint at every
  // turn. One run draws for about five minutes (or until the lattice is half full), then
  // fades to black and starts over on a fresh lattice.
  scenePipes(cv, ctx) {
    const W = cv.width, H = cv.height;
    const G = Math.max(22, Math.min(44, Math.round(Math.min(W, H) / 28)));   // lattice pitch, px
    const ZX = 0.37 * G, ZY = -0.29 * G;            // one step "into" the screen, as drawn
    const NZ = 12, X0 = -6, Y0 = -1;                // 12 layers deep; X0/Y0 pad the lattice so every layer covers the screen
    const NX = Math.ceil(W / G) + 8, NY = Math.ceil(H / G) + 7;
    const R = G * 0.16;                             // pipe radius
    const SPEED = 9;                                // cells per second, per pipe
    const COUNT = Math.max(3, Math.min(6, Math.round(W * H / 700000)));
    const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const used = new Uint8Array(NX * NY * NZ);      // fixed-size occupancy map: nothing grows while it runs
    const at = (i, j, k) => i + NX * (j + NY * k);
    const sx = (i, k) => (i + X0) * G + k * ZX;
    const sy = (j, k) => (j + Y0) * G + k * ZY;
    const onScreen = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < NX && j < NY && k < NZ &&
      sx(i, k) > -G && sx(i, k) < W + G && sy(j, k) > -G && sy(j, k) < H + G;
    const free = (i, j, k) => onScreen(i, j, k) && !used[at(i, j, k)];
    const rand = n => Math.floor(Math.random() * n);

    const tint = (hex, f) => {                      // f < 0 darkens toward black, f > 0 lightens toward white
      const n = parseInt(hex.slice(1), 16), to = f < 0 ? 0 : 255, a = Math.abs(f);
      const ch = shift => Math.round(((n >> shift) & 255) * (1 - a) + to * a);
      return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
    };
    const palette = ['#9370DB', '#05ffa1', '#ff71ce', '#01cdfe', '#fffb96', '#ff9933', '#ff5c5c', '#d8cfe8']
      .map(c => ({ dark: tint(c, -0.55), base: c, light: tint(c, 0.6) }));

    const ball = (x, y, c) => {
      const r = R * 1.5;
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.08, x, y, r);
      g.addColorStop(0, c.light);
      g.addColorStop(0.45, c.base);
      g.addColorStop(1, c.dark);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const tube = (x1, y1, x2, y2, c) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.5) return;
      let nx = (y1 - y2) / len, ny = (x2 - x1) / len;      // unit normal, flipped to face the light (upper left)
      if (nx * 0.5 + ny * 0.85 > 0) { nx = -nx; ny = -ny; }
      const line = (off, width, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x1 + nx * off, y1 + ny * off);
        ctx.lineTo(x2 + nx * off, y2 + ny * off);
        ctx.stroke();
      };
      line(0, R * 2, c.dark);
      line(R * 0.18, R * 1.4, c.base);
      line(R * 0.5, R * 0.5, c.light);
    };

    // choose the next cell: mostly straight on, sometimes a turn (which gets a ball joint).
    // false = boxed in, or the pipe has reached its length
    const advance = p => {
      const open = [];
      for (let d = 0; d < 6; d++) if (free(p.i + DIRS[d][0], p.j + DIRS[d][1], p.k + DIRS[d][2])) open.push(d);
      if (!open.length || p.len >= p.max) return false;
      const d = open.includes(p.d) && Math.random() < 0.6 ? p.d : open[rand(open.length)];
      if (p.d >= 0 && d !== p.d) ball(sx(p.i, p.k), sy(p.j, p.k), p.c);
      p.d = d;
      p.ni = p.i + DIRS[d][0]; p.nj = p.j + DIRS[d][1]; p.nk = p.k + DIRS[d][2];
      used[at(p.ni, p.nj, p.nk)] = 1;
      return true;
    };
    const start = p => {
      for (let tries = 0; tries < 80; tries++) {
        const i = rand(NX), j = rand(NY), k = rand(NZ);
        if (!free(i, j, k)) continue;
        Object.assign(p, { i, j, k, d: -1, t: 0, len: 0, max: 40 + rand(160), c: palette[rand(palette.length)] });
        if (!advance(p)) continue;
        used[at(i, j, k)] = 1;
        ball(sx(i, k), sy(j, k), p.c);
        return (p.alive = true);
      }
      return false;                                 // no room left anywhere
    };

    let cells = 0;
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) if (onScreen(i, j, k)) cells++;
    const budget = Math.min(cells * 0.5, COUNT * SPEED * 300);   // segments per run
    const FADE = 2.5;                               // seconds to dissolve a finished run
    let pipes, drawn, fade = 0, snap = null, last = performance.now();
    const reset = () => {
      used.fill(0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      drawn = 0;
      pipes = Array.from({ length: COUNT }, (_, n) => ({ alive: false, wait: n * 0.7 }));
    };
    reset();

    return () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (fade > 0) {                               // run over: dissolve the finished picture, then begin again
        fade -= dt;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        if (fade > 0) {
          ctx.globalAlpha = fade / FADE;
          ctx.drawImage(snap, 0, 0);
          ctx.globalAlpha = 1;
        } else {
          snap = null;
          reset();
        }
        return;
      }
      ctx.lineCap = 'butt';
      let jammed = false;
      pipes.forEach(p => {
        if (!p.alive) {
          p.wait -= dt;
          if (p.wait <= 0 && !start(p)) jammed = true;
          return;
        }
        p.t += dt * SPEED;
        const x1 = sx(p.i, p.k), y1 = sy(p.j, p.k), x2 = sx(p.ni, p.nk), y2 = sy(p.nj, p.nk);
        const t = Math.min(1, p.t);
        tube(x1, y1, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, p.c);
        if (p.t < 1) return;
        p.i = p.ni; p.j = p.nj; p.k = p.nk;
        p.t -= 1; p.len++; drawn++;
        if (!advance(p)) {                          // dead end: cap it, a new pipe starts elsewhere shortly
          ball(x2, y2, p.c);
          p.alive = false;
          p.wait = 0.5 + Math.random();
        }
      });
      if (jammed || drawn >= budget) {
        snap = document.createElement('canvas');    // one screen-sized copy, only for the fade
        snap.width = W;
        snap.height = H;
        snap.getContext('2d').drawImage(cv, 0, 0);
        fade = FADE;
      }
    };
  },

  sceneToasters(cv, ctx) {
    const things = Array.from({ length: 14 }, (_, i) => ({
      x: Math.random() * cv.width * 1.5, y: -Math.random() * cv.height,
      v: 1 + Math.random() * 2.2, flap: Math.random() * 6.28, toast: i % 3 === 0,
    }));
    return () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
      things.forEach(t => {
        t.x -= t.v; t.y += t.v * 0.8; t.flap += 0.25;
        if (t.x < -60 || t.y > cv.height + 60) { t.x = cv.width + Math.random() * cv.width * 0.5; t.y = -60 - Math.random() * cv.height * 0.5; }
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.font = '34px serif';
        if (t.toast) ctx.fillText('🍞', -17, 12);
        else {
          ctx.fillText('🍞', -17, 12);
          const w = Math.sin(t.flap) * 14;          // flapping chrome wings
          ctx.fillStyle = '#ddd';
          ctx.beginPath(); ctx.moveTo(-14, -8); ctx.lineTo(-30, -8 - w); ctx.lineTo(-16, 2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(14, -8); ctx.lineTo(30, -8 - w); ctx.lineTo(16, 2); ctx.fill();
        }
        ctx.restore();
      });
      ctx.fillStyle = '#666';
      ctx.font = '12px Courier New';
      ctx.fillText('after dark, sort of', 20, cv.height - 20);
    };
  },

  sceneMatrix(cv, ctx) {
    const size = 16;
    const cols = Math.ceil(cv.width / size);
    const drops = Array.from({ length: cols }, () => Math.random() * -50);
    const glyphs = 'アイウエオ01ｱｶﾊﾏﾔﾗﾜ01<>/\\{}';
    let frame = 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    return () => {
      if (++frame % 2) return;
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = size + 'px monospace';
      drops.forEach((d, i) => {
        const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
        ctx.fillStyle = '#7fff7f';
        ctx.fillText(ch, i * size, d * size);
        drops[i] = d * size > cv.height && Math.random() > 0.975 ? 0 : d + 1;
      });
    };
  },

  stop() {
    const cv = document.getElementById('screensaver');
    if (!cv || cv.hidden) return;
    cv.hidden = true;
    cancelAnimationFrame(this.raf);
  },
};

// ---------- desktop buddy ----------
function initBuddy() {
  const buddy = document.getElementById('buddy');
  if (!buddy) return;
  const bubble = buddy.querySelector('.bubble');
  const lines = [
    'welcome to the site!! make yourself at home, the windows all drag around',
    'pro tip: the windows drag around. rearrange my life for me',
    'sign the guestbook!! i read every entry at least twice',
    'try the Start menu. yes there is a shut down button. yes you should press it',
    'minesweeper record: 43 seconds. beat it and tell me in the guestbook',
    'this site is best viewed at 800x600 with your eyes',
    'i only sleep 4 hours so this website never sleeps either',
    'the sparkles follow your mouse because they like you',
    'CRT mode in the tray makes everything look like 1998. that\'s the point',
  ];
  let t = null;
  const say = () => {
    bubble.textContent = lines[Math.floor(Math.random() * lines.length)];
    bubble.hidden = false;
    clearTimeout(t);
    t = setTimeout(() => { bubble.hidden = true; }, 6000);
    Sfx.click();
  };
  buddy.addEventListener('click', say);
  setTimeout(say, 12000);
}

// top-level const doesn't attach to window — export for the other modules' guards
Object.assign(window, { Sfx, WM, Toggles, Screensaver });

// ---------- boot ----------
document.addEventListener('DOMContentLoaded', () => {
  const subpage = ensureShell();        // blog pages & co. borrow the desktop's taskbar before anything wires it up
  WM.init();
  initLaunchers();
  if (subpage) initSubpage();
  window.addEventListener('load', () => setTimeout(openDeepLink, 0));
  initStartMenu();
  Toggles.init();
  initClock();
  initSparkles();
  initCursor();
  initHitCounter();
  initBuddy();
  Screensaver.init();

  // for the 3 people who open the console. you are the real ones.
  console.log('%c★ hey. you opened the console. you are officially one of the 3.', 'color:#9370DB;font-size:14px;font-weight:bold;');
  console.log('%cthere is nothing hidden down here. except maltenSecrets(). which is nothing. probably.', 'color:#888;');
  window.maltenSecrets = () => {
    console.log('%c  ᕕ( ᐛ )ᕗ  you ran the function. incredible instincts.', 'color:#ff71ce;font-size:13px;');
    console.log('secret log: the dancing baby has a name. it is Gerald. tell no one.');
    return '🏆 achievement unlocked: curiosity (worth 0 points)';
  };

  // browsers block audio until first interaction — greet with a chime then
  if (document.body.classList.contains('desktop')) {
    const greet = () => Sfx.tada();
    document.addEventListener('pointerdown', greet, { once: true });
  }
});
