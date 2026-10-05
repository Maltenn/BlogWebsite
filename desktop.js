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

  init() {
    const desktop = document.getElementById('desktop');
    if (!desktop) return;

    document.querySelectorAll('.window[data-app]').forEach(el => {
      const id = el.dataset.app;
      this.wins.set(id, { el, taskBtn: null });
      el.style.left = (el.dataset.x || 100) + 'px';
      el.style.top = (el.dataset.y || 60) + 'px';
      if (el.dataset.w) el.style.width = el.dataset.w + 'px';

      el.addEventListener('pointerdown', () => this.focus(id));
      this.wireTitleBar(id, el);
      this.makeDraggable(id, el);

      if (el.classList.contains('open-on-load')) this.open(id, true);
      else el.classList.add('closed');
    });

    this.clampAll();
    window.addEventListener('resize', () => this.clampAll());
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

  clampAll() {
    if (window.innerWidth <= 820) return;
    const desk = document.getElementById('desktop');
    this.wins.forEach(({ el }) => {
      el.style.left = Math.max(0, Math.min(el.offsetLeft, desk.clientWidth - el.offsetWidth - 4)) + 'px';
      el.style.top = Math.max(0, Math.min(el.offsetTop, desk.clientHeight - 60)) + 'px';
    });
  },

  open(id, silent) {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.classList.remove('closed', 'minimized');
    if (!w.taskBtn) {
      const btn = document.createElement('button');
      btn.className = 'btn98';
      btn.textContent = w.el.dataset.title || id;
      btn.addEventListener('click', () => {
        if (w.el.classList.contains('minimized') || !w.el.classList.contains('focused')) {
          w.el.classList.remove('minimized');
          this.focus(id);
        } else this.minimize(id);
      });
      document.getElementById('task-buttons').appendChild(btn);
      w.taskBtn = btn;
    }
    this.focus(id);
    if (!silent) Sfx.open();
    document.dispatchEvent(new CustomEvent('app-open', { detail: id }));
  },

  close(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.classList.add('closed');
    w.el.classList.remove('focused', 'maximized');
    if (w.taskBtn) { w.taskBtn.remove(); w.taskBtn = null; }
    Sfx.close();
    document.dispatchEvent(new CustomEvent('app-close', { detail: id }));
  },

  minimize(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.classList.add('minimized');
    w.el.classList.remove('focused');
    if (w.taskBtn) w.taskBtn.classList.remove('pressed');
    Sfx.click();
  },

  maximize(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.classList.toggle('maximized');
    this.focus(id);
    Sfx.click();
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
  menu.querySelectorAll('li[data-open]').forEach(li =>
    li.addEventListener('click', () => { WM.open(li.dataset.open); menu.hidden = true; btn.classList.remove('pressed'); }));
  menu.querySelectorAll('li[data-href]').forEach(li =>
    li.addEventListener('click', () => { window.location.href = li.dataset.href; }));
  menu.querySelectorAll('li[data-mstab]').forEach(li =>
    li.addEventListener('click', () => {
      menu.hidden = true; btn.classList.remove('pressed');
      WM.open('myspace');
      if (window.MS && MS.state) MS.show(li.dataset.mstab, li.dataset.msarg || undefined);
    }));
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

// ---------- screensaver (idle starfield + bouncing pfp) ----------
const Screensaver = {
  idleMs: 90000,
  timer: null,
  raf: null,
  armed: false,

  init() {
    const cv = document.getElementById('screensaver');
    if (!cv) return;
    this.armed = true;
    const reset = () => {
      clearTimeout(this.timer);
      if (!cv.hidden) this.stop();
      this.timer = setTimeout(() => this.start(), this.idleMs);
    };
    ['mousemove', 'keydown', 'pointerdown', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, reset, { passive: true }));
    reset();
  },

  mode() { return localStorage.getItem('malten_saver') || 'starfield'; },
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
    const step = (scenes[mode] || this.sceneStarfield).call(this, cv, ctx);
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

  scenePipes(cv, ctx) {
    const G = 24;
    const colors = ['#9370DB', '#05ffa1', '#ff71ce', '#01cdfe', '#fffb96', '#ff9933'];
    const newPipe = () => ({
      x: Math.floor(Math.random() * (cv.width / G)) * G,
      y: Math.floor(Math.random() * (cv.height / G)) * G,
      dir: [[G, 0], [-G, 0], [0, G], [0, -G]][Math.floor(Math.random() * 4)],
      color: colors[Math.floor(Math.random() * colors.length)],
    });
    let pipes = [newPipe(), newPipe(), newPipe()];
    let segments = 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.lineCap = 'round';
    let frame = 0;
    return () => {
      if (++frame % 3) return;                     // pipe speed
      pipes.forEach(p => {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        if (Math.random() < 0.25) {                // turn: pick a perpendicular direction
          p.dir = p.dir[0] === 0 ? [[G, 0], [-G, 0]][Math.floor(Math.random() * 2)] : [[0, G], [0, -G]][Math.floor(Math.random() * 2)];
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8, 0, 7);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
        }
        p.x += p.dir[0]; p.y += p.dir[1];
        if (p.x < 0 || p.x > cv.width || p.y < 0 || p.y > cv.height) Object.assign(p, newPipe());
        else { ctx.lineTo(p.x, p.y); ctx.stroke(); }
      });
      if (++segments > 900) {                      // screen full — classic wipe and restart
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cv.width, cv.height);
        segments = 0;
        pipes = [newPipe(), newPipe(), newPipe()];
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
  WM.init();
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
