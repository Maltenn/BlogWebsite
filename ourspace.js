/* ============================================================
   ourspace.js — OurSpace: a place for friends™
   A fully fake social network in a window. 25 residents with
   profiles, comment walls, an inbox that writes back, friend
   requests, bulletins, and a live activity feed where the
   residents interact with each other. Persists in localStorage.
   ============================================================ */

const MS = {
  KEY: 'ourspace_v1',
  state: null,
  view: { page: 'feed', arg: null },
  songTimer: null,
  songAudio: null,
  ambientTimer: null,
  hist: [],
  browseFilter: 'all',
  browseQuery: '',
  viewDmArmed: {},
  typingLock: false,

  /* ------------------------- THE RESIDENTS ------------------------- */
  people: {},         // every resident comes from content-pack.js (content-src/base/residents + residents)

  /* --------------------------- state --------------------------- */
  // A newcomer's world. The visitor is NOT malten (malten is a resident now): seeds talk to them as {you}, and their
  // own page (state.me) doesn't exist until the sign-up — see renderSignup / createMe.
  defaultState() {
    const st = {
      friends: ['malten', 'todd', 'patrick', 'herp', 'banana', 'darkangel', 'starxgazer', 'wes', 'vinyl_witch'],
      pending: ['sk8rboi', 'zorp', 'tony', 'riley', 'tina'].filter(id => this.people[id]),
      denied: [],
      profileViews: 0,
      feed: [],
      usedBanter: {},
      walls: {},          // extra comments per person id (user + generated)
      myWall: [
        { from: 'todd', text: 'Thanks for making OurSpace your home page! (You didn\'t. Please consider it.)', time: 'Jun 27 2026 10:00 AM' },
        { from: 'patrick', text: 'hi {you}!! i clicked every button on your page. i am so sorry', time: 'Jul 3 2026 2:22 PM' },
        { from: 'herp', text: 'herp. (welcome)', time: 'Jul 3 2026 4:20 PM' },
      ],
      // todd's welcome is not seeded: it arrives once the visitor has a name (welcomeDm)
      inbox: {
        starxgazer: {
          unread: true,
          msgs: [{ who: 'them', text: 'ok {you}, i did your chart without asking. scorpio. OBVIOUSLY. don\'t check, i\'m never wrong. anyway the guestbook drama next week is NOT your fault but you will make it worse. welcome to ourspace ✨', time: 'Jul 3 2026 10:30 PM' }],
        },
        wes: {
          unread: true,
          msgs: [{ who: 'them', text: '{you}. welcome. one question before we can be friends: do you play melee, and who do you main. choose carefully, this determines the friendship tier.', time: 'Jul 4 2026 1:15 AM' }],
        },
      },
      youMigrated: true,  // a fresh save never had a "malten" player to rewrite (see migrate)
      bulletins: [
        { from: 'darkangel', subject: 'REPOST THIS OR THE GLITTER GHOST VISITS AT 3AM', body: 'in 1997 a girl ignored a bulletin like this one. that night her profile song changed BY ITSELF to smooth jazz. repost in 13 seconds or face the glitter ghost. i do not make the rules. the ghost does.', time: 'Jul 3 2026 11:13 PM', reposts: 4 },
        { from: 'banana', subject: 'SURVEY: 50 THINGS ABOUT ME (I DID 11 AND FELL ASLEEP)', body: '1. NAME: BANANA_PHONE 2. FEAR: SMOOTHIES 3. HEIGHT: TALL ENOUGH 4. CRUSH: THE CONCEPT OF VELOCITY 5. FAVORITE WORD: RING 6-11: RING 12-50: [ASLEEP]', time: 'Jul 2 2026 2:47 AM', reposts: 2 },
        { from: 'todd', subject: 'PSA: scheduled downtime', body: 'OurSpace will be down Sunday 3-4 AM while I move the laptop away from the window. Rain is forecast. Thank you for your patience.', time: 'Jul 1 2026 5:00 PM', reposts: 0 },
        { from: 'zorp', subject: 'totally normal survey for humans', body: '1. where do you keep your skeleton? 2. how many teeth is normal (asking to confirm i am normal) 3. if a light appeared over your house you would: a) wave b) run c) get in. please answer honestly. this is for a school project. i am in school. human school.', time: 'Jun 30 2026 3:33 AM', reposts: 1 },
        { from: 'sk8rboi', subject: 'LOST: one shoe (the good one)', body: 'lost my left shoe attempting the mall gap. if found pls return. it has character. and my house key.', time: 'Jun 29 2026 4:20 PM', reposts: 0 },
      ],
      reposted: [],
    };

    // data-driven seeds from the resident roster — SAMPLED: the roster is ~92 now, "one from everyone" would bury the feed
    const DM_OPENERS = ['tony', 'tina', 'sephiroth', 'nikki'];  // only the most in-character cold-DMers
    const sample = (n, ok) => new Set(this.shuffled(Object.keys(this.people).filter(id => ok(this.people[id]))).slice(0, n));
    const hours = ['9:14 AM', '10:02 AM', '11:11 AM', '12:40 PM', '1:26 PM', '2:15 PM', '3:33 PM', '4:20 PM', '5:05 PM', '6:47 PM', '7:31 PM', '8:08 PM', '9:23 PM', '10:10 PM', '11:38 PM'];
    let h = 0;
    const bulletinFrom = sample(12, p => p.bulletins && p.bulletins.length);
    Object.keys(this.people).forEach(id => {
      const p = this.people[id];
      // opening DMs (flirts, chain letters, welcomes)
      if (DM_OPENERS.includes(id) && p.dmSeed && p.dmSeed.length && !st.inbox[id]) {
        st.inbox[id] = { unread: true, msgs: p.dmSeed.map(m => ({ who: 'them', text: m.text, time: m.time || 'Jul 3 2026 8:00 PM' })) };
      }
      // a bulletin from a dozen residents (tickEvent posts everyone else's over time)
      if (bulletinFrom.has(id)) {
        const b = p.bulletins[0];
        st.bulletins.push({ from: id, subject: b.subject, body: b.body, time: b.time || 'Jul 3 2026 ' + hours[h++ % hours.length], reposts: Math.floor(Math.random() * 5) });
      }
    });

    // seed the activity feed: a status from two dozen residents + 14 wall banter posts
    const stamp = () => 'Jul 4 2026 ' + hours[h++ % hours.length];
    const statusFrom = sample(24, p => p.statuses && p.statuses.length);
    const banterFrom = sample(14, p => p.banter && Object.keys(p.banter).some(t => this.people[t]));
    Object.keys(this.people).forEach(id => {
      const p = this.people[id];
      if (statusFrom.has(id)) {
        st.feed.push({ type: 'status', from: id, text: p.statuses[0], time: stamp() });
      }
    });
    Object.keys(this.people).forEach(id => {
      const p = this.people[id];
      if (!banterFrom.has(id)) return;
      const targets = Object.keys(p.banter).filter(t => this.people[t]);
      if (!targets.length) return;
      const t = targets[0];
      const line = p.banter[t][0];
      st.feed.push({ type: 'wall', from: id, to: t, text: line, time: stamp() });
      st.usedBanter[`${id}>${t}:0`] = 1;
      (st.walls[t] = st.walls[t] || []).push({ from: id, text: line, time: 'Jul 4 2026 ' + hours[(h - 1) % hours.length] });
    });
    // shuffle the seed feed so statuses and wall posts interleave
    for (let i = st.feed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [st.feed[i], st.feed[j]] = [st.feed[j], st.feed[i]];
    }
    st.unreadFeed = 0;
    return st;
  },

  /* ---------- your Top 8 (lives on My Page now) ---------- */
  // Default order: 8 real residents, all friends from day one — malten (who built the place) first. A custom
  // order saved from "Edit My Page" lives in state.me.top8 (state.top8 on saves from before the sign-up).
  top8: ['malten', 'todd', 'patrick', 'wes', 'vinyl_witch', 'banana', 'herp', 'starxgazer'],
  // the Top 8 as shown: the saved order first, then the defaults, then anyone else you're friends with
  myTop8() {
    const st = this.state || {};
    const saved = (st.me && Array.isArray(st.me.top8) && st.me.top8.length) ? st.me.top8 : (st.top8 || []);
    const seen = new Set();
    return [...saved, ...this.top8, ...(st.friends || [])]
      .filter(id => this.people[id] && !seen.has(id) && seen.add(id)).slice(0, 8);
  },

  /* ---------- the visitor (state.me) ---------- */
  // Whoever opened the site. They pick a screen name + picture at the sign-up; Edit My Page edits everything else.
  // Resident-written text says {you} (or {YOU}, shouted) wherever it talks to them — swapped at RENDER time by t(),
  // so a rename shows up everywhere at once and the save keeps the raw token.
  // The pictures to pick from (sign-up + Edit My Page): the 12 generated silhouettes ("basics"), then every preset
  // from the pack (content-src/avatar-presets*.json → pack.avatarPresets [{ file, desc, group }]; no group = "icons"),
  // then the avatar-ish decor gifs ("decor"). buildAvatarPresets() fills MS.avatarPresets (files, each once, in
  // gallery order — see avatarGroups) and avatarPresetInfo (file → { file, desc, group }: headings and tooltips).
  avatarBasics: ['gray silhouette (the classic "no photo")', 'blue silhouette', 'pink silhouette', 'green silhouette',
    'purple silhouette on midnight', 'orange silhouette', 'teal silhouette', 'red silhouette on black', 'lavender silhouette',
    'neon green silhouette on black', 'sky blue silhouette', 'brown silhouette']
    .map((desc, i) => ({ file: `assets/avatars/preset_${String(i + 1).padStart(2, '0')}.png`, desc })),
  avatarDecor: ['deco_smiley', 'deco_skull', 'deco_moon', 'deco_dragon', 'deco_fairy', 'deco_hamster', 'deco_sparkle_bunny',
    'deco_dancing_baby', 'deco_email_bear', 'deco_record_dj', 'deco2_atom', 'deco2_mushroom', 'deco2_goth_inside',
    'deco_banana_tiny', 'deco_blinkie_zim'].map(n => `assets/${n}.gif`),
  packAvatars: [],          // { file, desc, group } from every applied pack, in pack order
  avatarPresets: [],
  avatarPresetInfo: {},
  // gallery headings: these first, in this order; any other pack group after them, alphabetically; "decor" last
  avatarGroupOrder: ['basics', 'people', 'animals', 'smileys', 'glitter', 'goth', 'kawaii', 'space', 'tech', 'food', 'music'],
  avatarGroups() {
    const have = new Set(Object.values(this.avatarPresetInfo).map(i => i.group));
    const rest = [...have].filter(g => g !== 'decor' && !this.avatarGroupOrder.includes(g)).sort();
    return [...this.avatarGroupOrder, ...rest, 'decor'].filter(g => have.has(g));
  },
  buildAvatarPresets() {
    const info = {};
    const put = (file, desc, group) => {
      if (typeof file === 'string' && file && !info[file]) info[file] = { file, desc: typeof desc === 'string' ? desc : '', group };
    };
    this.avatarBasics.forEach(b => put(b.file, b.desc, 'basics'));
    this.packAvatars.forEach(p => put(p.file, p.desc, p.group));
    this.avatarDecor.forEach(f => put(f, f.split('/').pop().replace(/\.\w+$/, '').replace(/^deco2?_/, '').replace(/_/g, ' '), 'decor'));
    this.avatarPresetInfo = info;
    const files = Object.keys(info);                            // basics, pack (pack order), decor
    this.avatarPresets = this.avatarGroups().flatMap(g => files.filter(f => info[f].group === g));
  },
  // The picture chooser shared by the sign-up and Edit My Page: one fixed-height scrolling box, one sticky heading per
  // group (avatarGroups order), every tile titled with its desc, pictures loaded lazily. onPick(src) on a click;
  // .select(src) moves the highlight (an uploaded picture highlights nothing); .reveal() scrolls the highlighted tile
  // into view once the box is on the page.
  avatarGallery(selected, onPick) {
    const box = this.el('div', 'av-gallery');
    const info = this.avatarPresetInfo;
    this.avatarGroups().forEach(group => {
      const files = this.avatarPresets.filter(f => info[f] && info[f].group === group);
      if (!files.length) return;
      const sec = this.el('div', 'av-sec');                    // its own box: the sticky heading leaves with its group
      sec.appendChild(this.el('div', 'av-group', `${group} (${files.length})`));
      const grid = this.el('div', 'su-avatars');
      files.forEach(src => {
        const b = this.el('button', 'su-av' + (src === selected ? ' sel' : ''));
        b.type = 'button';
        b.dataset.src = src;
        b.title = info[src].desc || src.split('/').pop().replace(/\.\w+$/, '').replace(/_/g, ' ');
        b.setAttribute('aria-label', b.title);
        const im = this.el('img'); im.loading = 'lazy'; im.alt = ''; im.src = src;   // lazy BEFORE src, or it fetches now
        b.appendChild(im);
        b.addEventListener('click', () => { box.select(src); if (onPick) onPick(src); });
        grid.appendChild(b);
      });
      sec.appendChild(grid);
      box.appendChild(sec);
    });
    box.select = src => box.querySelectorAll('.su-av').forEach(e => e.classList.toggle('sel', e.dataset.src === src));
    box.reveal = () => {
      const s = box.querySelector('.su-av.sel');
      if (s) box.scrollTop = Math.max(0, s.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 24);
    };
    return box;
  },
  myName() {
    const me = this.state && this.state.me;
    return (me && me.name) || 'guest';
  },
  myAvatar() {
    const me = this.state && this.state.me;
    return (me && me.avatar) || this.avatarBasics[0].file;
  },
  // {you} → the screen name, {YOU} → the screen name in caps. Display only: never run it on text that gets saved.
  t(text) {
    if (typeof text !== 'string' || text.indexOf('{') < 0) return text;
    const n = this.myName();
    return text.replace(/\{you\}/g, () => n).replace(/\{YOU\}/g, () => n.toUpperCase());
  },
  // "name's" / "names'" — for box titles
  poss(name) { return name + (/s$/i.test(name) ? "'" : "'s"); },

  // a fresh page for a newcomer; the sign-up fills in name + avatar
  defaultMe() {
    return {
      name: 'guest', avatar: this.avatarBasics[0].file, tag: 'new here. be nice.', mood: 'curious',
      gender: '', age: '', hometown: '', zodiac: '', status: 'Single', hereFor: 'Friends',
      about: 'i just got here. still figuring out where all the buttons are. say hi!',
      meet: 'anyone who says hi first. and whoever built this desktop, apparently that\'s malten.',
      interests: { General: 'still figuring that out', Music: '', Movies: '', Television: '', Books: '', Heroes: '' },
      blogTitle: '', theme: { bg: '#eef3fb', fg: '#000000', accent: '#3b6fb6' }, bgTile: '', font: '',
      decor: ['assets/deco_new.gif'], badges: ['assets/badge_best_viewed_with_eyes.gif', 'assets/badge_aim.gif'],
      top5: [], top8: this.top8.slice(), blog: [], createdAt: Date.now(),
    };
  },
  // Make the visitor's page. Saves from before the sign-up existed carry over their Edit My Page layout + Top 8.
  createMe(name, avatar, extra) {
    const st = this.state;
    const me = this.defaultMe();
    const mp = st.myProfile || {};
    if (mp.theme) me.theme = { ...mp.theme };
    if (mp.bgTile) me.bgTile = mp.bgTile;
    if (mp.font) me.font = mp.font;                 // (its profile song stays behind: visitors have a top 5 instead)
    if (Array.isArray(st.top8) && st.top8.length) me.top8 = st.top8.slice();
    st.myProfile = null;                            // carried over once; a later Switch user starts from scratch
    delete st.top8;
    st.me = Object.assign(me, { name, avatar }, extra || {});
    if (this.people.todd && !st.friends.includes('todd')) st.friends.push('todd');
    this.save();
    return st.me;
  },
  // screen-name rules: 3–20 characters, letters/digits/_ plus the xX~*.- styling, not somebody else's name
  validName(name) {
    const n = String(name || '').trim();
    if (n.length < 3) return 'screen names need at least 3 characters.';
    if (n.length > 20) return 'max 20 characters. this isn\'t a novel.';
    if (!/^[A-Za-z0-9_~*.\-]+$/.test(n)) return 'letters, numbers and _ only (plus ~ * . - for styling). no spaces!';
    if ((n.match(/[A-Za-z0-9]/g) || []).length < 2) return 'needs at least a couple of letters or numbers in there.';
    const low = n.toLowerCase();
    if (low === 'you' || low === 'guest') return 'that one\'s reserved. pick something with more personality.';
    const taken = Object.keys(this.people).find(id => id.toLowerCase() === low || String(this.people[id].name || '').toLowerCase() === low);
    if (taken) return `"${n}" is taken (by ${this.people[taken].name}). try adding some xX's.`;
    return '';
  },
  // 2006-grade screen names: xX_name_Xx, name+numbers, l33t, ~*sparkles*~
  randomName() {
    const a = ['sparkle', 'sk8r', 'emo', 'pixel', 'glitter', 'moon', 'ninja', 'pirate', 'kitty', 'punk', 'star', 'dream', 'rawr',
      'cupcake', 'zombie', 'angel', 'lil', 'dark', 'cosmic', 'bubble', 'dino', 'gamer', 'neon', 'midnight', 'cherry', 'vamp', 'frog', 'disco', 'cookie', 'storm'];
    const b = ['girl', 'boi', 'kid', 'heart', 'bunny', 'dude', 'princess', 'lord', 'queen', 'king', 'freak', 'monkey', 'wolf', 'panda',
      'ghost', 'pants', 'chick', 'master', 'sk8r', 'fairy', 'pop', 'bear', 'tastic', 'face'];
    const nums = ['87', '89', '91', '93', '95', '4ever', '101', '2000', '13', '777', '247', '1337', '88', '42'];
    const r = arr => arr[Math.floor(Math.random() * arr.length)];
    const cap = s => s[0].toUpperCase() + s.slice(1);
    const leet = s => s.replace(/[aeiost]/g, c => Math.random() < 0.6 ? ({ a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' })[c] : c);
    const shapes = [
      (x, y) => `xX_${x}${cap(y)}_Xx`, (x, y) => `${x}${y}${r(nums)}`, (x, y) => leet(x + y), (x, y) => `~*${x}${y}*~`,
      (x, y) => `${x}_${y}${r(nums)}`, (x, y) => `x${x}${y}x`, (x, y) => `${cap(x)}${cap(y)}`, (x, y) => `${x}.${y}`,
    ];
    for (let i = 0; i < 30; i++) {
      const x = r(a);
      let y = r(b);
      if (y === x) continue;
      const n = r(shapes)(x, y);
      if (!this.validName(n)) return n;
    }
    return 'newkid' + Math.floor(100 + Math.random() * 900);
  },
  // the visitor's page as a profile object, shaped like a resident (renderProfile / skin / blog)
  mePage() {
    const m = this.state.me || this.defaultMe();
    return {
      ...m, loc: m.hometown, lastLogin: 'you are literally here right now',
      age: (m.age === '' || m.age == null) ? '??' : m.age,
      interests: m.interests || {}, friends: this.state.friends,
    };
  },
  // their name / avatar / mood changed: repaint everything that shows them outside the page itself
  meChanged() {
    if (this.paintSidebar) this.paintSidebar();
    if (window.Chat && Chat.paintNicks) { Chat.paintNicks(); if (Chat.open) Chat.paintLog(); }
  },

  /* ---------- pinned bulletins (always on top of the board, never trimmed, never reposted) ---------- */
  pinnedBulletins: [
    { pin: 'malten_hello', from: 'malten', subject: 'hi, i\'m malten. this is my desktop.',
      body: 'this is my desktop — i\'m malten, the guy who built it. my page has the real blog, my real spotify top 5 and the guestbook (the one thing on here written by actual humans). everybody else on ourspace lives here: they post, they gossip, they WILL message you. be nice to todd. make your page your own. and sign the guestbook before you go :]',
      link: { label: '★ visit malten\'s page', page: 'profile', arg: 'malten' }, time: 'Oct 5 2026 9:00 PM' },
    { pin: 'todd_rules', from: 'todd', subject: 'WELCOME TO OURSPACE — house rules (please read) (please)',
      body: 'Welcome, {you}! I\'m Todd. I run OurSpace from a laptop in my room. House rules: 1. Be nice. 2. Do not unplug anything. 3. Your Top 8 is a legally binding document. 4. If the site goes down, it is raining. 5. Make your page your own (Edit My Page, top left of your profile). That\'s it. Welcome home. — Todd',
      link: { label: '🎨 edit my page', app: 'customize' }, time: 'Jun 27 2026 9:00 AM' },
  ],
  seedPins() {
    const st = this.state;
    const done = st.pins = Array.isArray(st.pins) ? st.pins : [];
    this.pinnedBulletins.forEach(b => {
      if (done.includes(b.pin) || !this.people[b.from]) return;
      done.push(b.pin);
      st.bulletins.push({ ...b, link: { ...b.link }, pinned: true, reposts: 0 });   // position doesn't matter: pins render first
    });
  },

  /* ---------- malten's real blog posts (the Blog tab + My Page's "Latest Blog Entry") ---------- */
  // Newest first. A new post = one new line here (plus blog-hub.html, see blog-post-template.html).
  blogPosts: [
    { title: 'What does it mean to have changed?', href: 'what-does-it-mean-to-have-changed.html', date: 'post #002 · October 22, 2026', img: 'pfp.png',
      blurb: 'the ship of theseus, a $400 computer, and a dinner with my grandparents. on leaving georgia, and whether you can be someone if you never stay someone.' },
    { title: 'Why do I create?', href: 'why-do-i-create.html', date: 'post #001 · October 5, 2026', img: 'pfp.png',
      blurb: 'why i spent two years on a website nobody asked for. losing my faith, finding poetry, and what making things gives back.' },
  ],

  /* ---------- chain-letter spam (the FW: FW: FW: economy) ---------- */
  spamLetters: [
    { from: 'tina', subject: 'FW: FW: FW: RE: RE: DO NOT BREAK THE CHAIN 🦇', body: 'in 1897 a girl named mildred received this letter and did NOT forward it. her crush never texted her back. phones had not been invented yet. THAT is how strong this curse is. forward to 10 friends or face a fate worse than team jacob.' },
    { from: 'banana', subject: 'RE: RE: RE: FREE POTASSIUM (NOT A SCAM) (A LIFESTYLE)', body: 'HELLO FRIEND. YOU HAVE BEEN SELECTED TO RECEIVE ONE (1) FREE BANANA*. *THE BANANA IS SPIRITUAL. FORWARD THIS TO 10 PEOPLE AND THE BANANA WILL FIND YOU WHEN YOU LEAST EXPECT IT. THE BANANA ALWAYS FINDS YOU.' },
    { from: 'randy', subject: 'FWD: 10 FACTS THAT WILL SHOCK U (fact 7 is pie)', body: 'fact 1: you cannot lick your own elbow. fact 2: you just tried. fact 3: chuck norris CAN. facts 4-6: classified. fact 7: PIE. fact 8: 90% of people forward this. fact 9: you are the 10%. fact 10: statistically the funniest email ever written (source: me)' },
    { from: 'brittany', subject: 'quiz!! which sparkle r u?? send to 10 ppl xoxo', body: 'omg ok: 1. pick a color 2. pick a song 3. pick a feeling. if u picked ANY answers ur a GLITTER SPARKLE!! we\'re all glitter sparkles!! isn\'t that beautiful. send to 10 ppl or ur top 8 gets shuffled by fate (not me) (fate) xoxo' },
    { from: 'zorp', subject: 'totally normal survey (do not forward to the government)', body: 'greetings. please complete this NORMAL survey from a NORMAL sender: 1. at what time do you power down for maintenance (sleep) 2. rate the moon (be honest, it reads these) 3. have you seen anything unusual in any fields recently (if yes, you have not). thank you. delete after reading. or don\'t. i am not the boss of you (yet).' },
    { from: 'meg', subject: '🐴 a horse has blessed this email 🐴', body: 'this is chestnut. chestnut is a good horse who blesses one email per day and today she chose YOURS. forward to keep the blessing. if you do not forward it that\'s ok too, chestnut does not do curses, she\'s just a horse. but WOW would it be nice. 🐴💖' },
  ],

  seedSpam() {
    return this.spamLetters.slice(0, 4).map((s, i) => ({
      ...s, time: ['Jun 29 2026 3:33 AM', 'Jul 1 2026 11:11 AM', 'Jul 2 2026 6:06 PM', 'Jul 3 2026 9:09 PM'][i], read: false,
    }));
  },

  migrate() {
    const st = this.state;
    // shape guards: every save since v1 should have these, but a half-written one must not take the page down
    ['friends', 'pending', 'denied', 'feed', 'myWall', 'bulletins', 'reposted', 'fxQueue'].forEach(k => { if (!Array.isArray(st[k])) st[k] = []; });
    ['usedBanter', 'walls', 'inbox', 'usedDms', 'dialogueState'].forEach(k => { if (!st[k] || typeof st[k] !== 'object') st[k] = {}; });
    if (!this.state.spam) this.state.spam = this.seedSpam();
    if (!this.state.myProfile) this.state.myProfile = null;
    this.migrateV2();
    // era pack arrivals: seed a batch of OurTube posts and let the new kids send friend requests
    const ytIdx = (this.posts || []).map((p, i) => p.kind === 'yt' ? i : -1).filter(i => i >= 0);
    if (ytIdx.length && !this.state.ytSeeded) {
      this.state.ytSeeded = true;
      this.state.postedIdx = this.state.postedIdx || [];
      const pick = ytIdx.sort(() => Math.random() - 0.5).slice(0, 8);
      const hours = ['9:02 AM', '10:47 AM', '12:15 PM', '2:38 PM', '4:04 PM', '6:21 PM', '8:16 PM', '10:33 PM'];
      pick.forEach((i, n) => {
        if (this.state.postedIdx.includes(i)) return;
        this.state.postedIdx.push(i);
        const item = this.postFromSource(i, 'Sep 5 2026 ' + hours[n % hours.length]);
        // spread them through the existing feed instead of stacking on top
        const at = Math.max(0, this.state.feed.length - Math.floor(Math.random() * 30));
        this.state.feed.splice(at, 0, item);
      });
    }
    if (!this.state.eraRequests) {
      this.state.eraRequests = true;
      ['kittyxcore', 'epic', 'smoove', 'paige'].forEach(id => {
        if (this.people[id] && !this.state.friends.includes(id) && !this.state.pending.includes(id) && !this.state.denied.includes(id)) this.state.pending.push(id);
      });
    }
    if (!this.state.postsSeeded && this.posts && this.posts.length) {
      // first run with media posts: seed a batch of photos/gifs into the feed, interleaved with what's there
      this.state.postsSeeded = true;
      const already = new Set(this.state.postedIdx || []);
      const idxs = this.posts.map((p, i) => (p.kind !== 'yt' && !already.has(i)) ? i : -1).filter(i => i >= 0)
        .sort(() => Math.random() - 0.5).slice(0, 22);
      this.state.postedIdx = (this.state.postedIdx || []).concat(idxs);
      const hours = ['8:12 AM', '9:40 AM', '11:11 AM', '12:03 PM', '1:27 PM', '2:50 PM', '3:33 PM', '4:44 PM', '6:15 PM', '7:08 PM', '8:52 PM', '10:10 PM', '11:38 PM'];
      idxs.forEach((i, n) => this.state.feed.push(this.postFromSource(i, 'Sep 4 2026 ' + hours[n % hours.length])));
      for (let i = this.state.feed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.state.feed[i], this.state.feed[j]] = [this.state.feed[j], this.state.feed[i]];
      }
    }
    // content-pack arrivals: the newcomers do NOT all knock at once — a few friend requests now, the rest
    // trickle in through tickEvent. Runs once per save, and only once a pack with residents has actually loaded.
    const newIds = Object.keys(this.people).filter(id => this.people[id].isNew);
    if (newIds.length && !st.packArrived) {
      st.packArrived = true;
      const known = new Set([...st.friends, ...st.pending, ...st.denied]);
      const mine = new Set(st.friends);
      const fresh = newIds.filter(id => !known.has(id));
      for (let n = st.pending.length >= 9 ? 2 : 3; n > 0 && fresh.length; n--) {
        // friends of your friends find you first
        const id = this.pickWeighted(fresh, c => 1 + 2 * (this.people[c].friends || []).filter(f => mine.has(f)).length);
        fresh.splice(fresh.indexOf(id), 1);
        st.pending.push(id);
      }
      if (this.people.todd) {
        st.feed.push({ type: 'status', from: 'todd', text: `Todd is welcoming ${newIds.length} new members to OurSpace! Everyone say hi. The laptop fan is now audible from the driveway. This is fine.`, time: this.now() });
      }
    }
    // the visitor stopped being malten (Oct 2026): malten is a resident now, and everybody's friend from day one
    if (this.people.malten && !st.maltenFriend) {
      st.maltenFriend = true;
      st.pending = st.pending.filter(x => x !== 'malten');
      st.denied = st.denied.filter(x => x !== 'malten');
      if (!st.friends.includes('malten')) st.friends.unshift('malten');
    }
    this.seedPins();
    if (!st.youMigrated) this.migrateYou();
    // visitors don't have a profile song any more (their page plays their top 5): drop it from older saves
    if (st.me && typeof st.me === 'object' && 'song' in st.me) delete st.me.song;
  },

  // A save from when the visitor WAS malten: residents' messages to them said "malten". Rewrite what was addressed
  // to them (DMs they received, comments on their own wall — not the feed, that's public record) to {you}, so it
  // reads right under their new screen name. Runs once; a save that already has state.me is left alone.
  migrateYou() {
    const st = this.state;
    st.youMigrated = true;
    if (st.me) return;
    st.wasMalten = true;                              // the sign-up says "ourspace got a makeover" instead of "welcome"
    const re = /\bmalten\b(?!'s (?:guestbook|blog|desktop|spotify))/gi;   // malten's own things keep his name
    const swap = s => (typeof s === 'string' ? s.replace(re, m => (m === m.toUpperCase() ? '{YOU}' : '{you}')) : s);
    // the two seed DMs that assumed things about the old player (aries, melee) get the newcomer versions
    const seeds = {
      'ok i did your chart without asking (aries sun, OBVIOUSLY) and i need you to know the guestbook drama next week is NOT your fault but you will make it worse. anyway love the site ✨':
        'ok {you}, i did your chart without asking. scorpio. OBVIOUSLY. don\'t check, i\'m never wrong. anyway the guestbook drama next week is NOT your fault but you will make it worse. welcome to ourspace ✨',
      'saw melee in your about me. this is the most important friend request of your life. also who do you main. choose carefully, this determines the friendship tier.':
        '{you}. welcome. one question before we can be friends: do you play melee, and who do you main. choose carefully, this determines the friendship tier.',
    };
    Object.keys(st.inbox).forEach(id => {
      const t = st.inbox[id];
      (t && Array.isArray(t.msgs) ? t.msgs : []).forEach(m => { if (m && m.who === 'them') m.text = seeds[m.text] || swap(m.text); });
    });
    // darkangel's "why do i create?" essay comment lives on malten's wall now
    st.myWall = st.myWall.filter(c => !(c && c.from === 'darkangel' && /why do i create/i.test(c.text || '')));
    st.myWall.forEach(c => {
      if (!c || c.from === 'you') return;
      c.text = c.text === 'hi malten!! i clicked every button on your desktop. i am so sorry'
        ? 'hi {you}!! i clicked every button on your page. i am so sorry' : swap(c.text);
    });
    // DMs already sent are remembered by a hash of their text (usedDms): re-key the ones whose content says {you} now,
    // or they'd count as unsent and arrive a second time
    const used = st.usedDms || {};
    Object.keys(used).forEach(id => {
      const p = this.people[id];
      if (!p || !Array.isArray(used[id])) return;
      [...(p.dms || []), ...(p.ambient || []), ...(p.dmSeed || []).map(m => m && m.text)].forEach(l => {
        if (typeof l !== 'string' || !/\{you\}/i.test(l)) return;
        const old = this.hash(l.replace(/\{you\}/g, 'malten').replace(/\{YOU\}/g, 'MALTEN'));
        const h = this.hash(l);
        if (used[id].includes(old) && !used[id].includes(h)) used[id].push(h);
      });
    });
  },

  // one-time (and idempotent) upgrades for the v2 engine: tree-keyed dialogue state, no-repeat inbox
  migrateV2() {
    const st = this.state;
    // dialogue progress used to be keyed by RESIDENT id (one tree each); the registry is keyed by TREE id now
    const ds = st.dialogueState;
    Object.keys(ds).forEach(k => {
      if (!this.trees[k] && this.trees[k + '_original'] && !ds[k + '_original']) { ds[k + '_original'] = ds[k]; delete ds[k]; }
    });
    // the old engine saved the new node BEFORE their answer was typed out: if the page closed mid-reply, the answer
    // never arrived (and an end node was never closed). Mark those as owed so playNode delivers what's missing.
    Object.keys(ds).forEach(tid => {
      const d = ds[tid], tree = this.trees[tid];
      if (!d || d.done || !tree) return;
      const node = tree.nodes[d.node];
      if (!node) { d.done = true; return; }
      const msgs = (st.inbox[tree.with] && st.inbox[tree.with].msgs) || [];
      const tail = msgs.slice(msgs.map(m => m && m.who).lastIndexOf('you') + 1).map(m => m && m.text);
      if (!(node.choices || []).length || (d.node !== 'start' && (node.them || []).some(l => !tail.includes(l)))) d.pend = 1;
    });
    // "the NPCs sent lots of repeats": old saves have the same generic line many times per thread. Keep the first of
    // each; never touch lines that belong to a scripted conversation (those are a transcript).
    if (!st.dmDeduped) {
      st.dmDeduped = true;
      Object.keys(st.inbox).forEach(id => {
        const t = st.inbox[id];
        if (!t || !Array.isArray(t.msgs)) { delete st.inbox[id]; return; }
        const scripted = this.scriptedLines(id);
        const seen = new Set();
        t.msgs = t.msgs.filter(m => {
          if (!m || typeof m.text !== 'string') return false;
          if (m.who === 'you' || scripted.has(m.text)) return true;
          if (seen.has(m.text)) return false;
          seen.add(m.text);
          return true;
        });
      });
    }
    // the "Top 10 Favorite Things" post is gone; darkangel's seeded wall comment was about it
    st.myWall.forEach(c => {
      if (c && c.from === 'darkangel' && c.text === 'your favorites list moved me. #1 was poetry. radiant, glittering poetry.') {
        c.text = 'i read "why do i create?" three times by candlelight. we create because the void will not decorate itself. radiant. glittering. correct.';
      }
      // the first post was retitled from "Why do we create?" to "Why do I create?"
      if (c && typeof c.text === 'string') c.text = c.text.replace(/(why do) we (create\?)/i, '$1 i $2');
    });
  },

  postFromSource(i, time) {
    const src = this.posts[i];
    return { type: 'post', postIdx: i, from: src.from, kind: src.kind, src: src.src, credit: src.credit,
      ytId: src.ytId, title: src.title, added: src.added, rating: src.rating,
      caption: src.caption, kudos: src.kudos || 0, views: src.views || 0,
      comments: (src.comments || []).map(c => ({ ...c })), time: time || this.now() };
  },

  /* ---------------- content packs (content-pack.js → window.MS_PACK → MS.applyPack) ---------------- */
  trees: {},            // conversation-tree registry keyed by TREE id: { id, with, opener, nodes } (see registerTree)
  contentReady: false,

  // small shared helpers
  hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; },
  shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  },
  pickWeighted(items, weightOf) {
    const w = items.map(x => Math.max(0, weightOf(x) || 0));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) { r -= w[i]; if (r < 0) return items[i]; }
    return items[items.length - 1];
  },
  // a made-up but stable timestamp for comments that arrive without one (wallExtra): Aug → early Oct, ascending with i
  fakeTime(seed, i, n) {
    const h = this.hash(seed);
    const d = new Date(Date.UTC(2026, 7, 2) + Math.floor(((i + (h % 100) / 100) / Math.max(1, n)) * 60) * 86400000);
    const hr = 9 + (h >>> 8) % 15, min = (h >>> 16) % 60;
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    return `${mon} ${d.getUTCDate()} 2026 ${hr % 12 || 12}:${String(min).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`;
  },

  // One-time prep of anything still defined inline (nothing is, since every resident, tree, storyline and line bank
  // moved to content-src/base/ and arrives through the pack): fold statusesExtra/banterExtra, register `this.dialogues`.
  prepContent() {
    if (this.contentReady) return;
    this.contentReady = true;
    Object.keys(this.people).forEach(id => this.mergeDepth(id, this.people[id]));
    Object.keys(this.dialogues).forEach(pid => this.registerTree({ ...this.dialogues[pid], id: pid + '_original', with: pid }));
    this.buildAvatarPresets();                                 // silhouettes + decor until a pack adds its presets
    // (no pruneRefs here: pack residents aren't in yet — applyPack and load() prune once they are)
  },

  // Merge a content pack. Idempotent (the same pack object is applied once; lines are de-duplicated, residents/trees
  // are keyed by id), tolerant of missing sections, and safe to call before or after boot. load() also applies
  // window.MS_PACK itself in case the pack file's own `if (window.MS && …)` call never fired.
  appliedPacks: [],
  applyPack(pack) {
    this.prepContent();
    if (!pack || typeof pack !== 'object' || this.appliedPacks.includes(pack)) return;
    this.appliedPacks.push(pack);
    const P = this.people;
    Object.keys(pack.people || {}).forEach(id => {
      const src = pack.people[id];
      if (!src || typeof src !== 'object' || !src.name) return;
      if (P[id] && !P[id].isNew) return;                       // a pack never replaces a built-in resident
      P[id] = this.normalizeResident(src);
      if (src.base) {                                          // one of the 38 originals (content-src/base/residents): not a newcomer
        P[id].isNew = false;
        this.mergeDepth(id, P[id]);                            // fold its own statusesExtra/banterExtra, as prepContent did when it was inline
      }
    });
    if (Array.isArray(pack.storylines) && !this.storylines.length) this.storylines = pack.storylines;
    if (pack.banks && typeof pack.banks === 'object' && !Object.keys(this.banks).length) this.banks = pack.banks;
    Object.keys(pack.depth || {}).forEach(id => this.mergeDepth(id, pack.depth[id]));
    (Array.isArray(pack.dialogues) ? pack.dialogues : []).forEach(tree => this.registerTree(tree));
    if (Array.isArray(pack.posts)) {
      this.posts = this.posts || [];
      const key = p => [p.from, p.kind, p.src || p.ytId, p.caption].join('|');
      const have = new Set(this.posts.map(key));
      pack.posts.forEach(p => {
        if (!p || !P[p.from] || !p.kind || have.has(key(p))) return;
        have.add(key(p));
        this.posts.push(p);                                    // appended: saved postedIdx indexes stay valid
      });
    }
    // visitor picture presets ([{ file, desc, group }], content-src/avatar-presets*.json): between the silhouettes and the decor
    (Array.isArray(pack.avatarPresets) ? pack.avatarPresets : []).forEach(a => {
      if (!a || typeof a.file !== 'string' || !a.file) return;
      const group = typeof a.group === 'string' && a.group.trim() ? a.group.trim().toLowerCase() : 'icons';
      this.packAvatars.push({ file: a.file, desc: typeof a.desc === 'string' ? a.desc : '', group });
    });
    this.buildAvatarPresets();
    this.pruneRefs();
    if (this.state) { this.migrate(); this.save(); }           // applied after boot: let the newcomers arrive
  },

  // pack residents are validated at build time, but never trust a file: fill whatever the renderers dereference
  normalizeResident(src) {
    const p = { tag: '', mood: '', about: '', loc: '', age: '??', lastLogin: 'recently', thanksAdd: 'thanks for the add!!', saltyDm: 'ok. wow. noted.', ...src, isNew: true };
    ['decor', 'friends', 'wall', 'replies', 'ambient', 'statuses', 'bulletins', 'pcComments', 'dms'].forEach(k => {
      p[k] = Array.isArray(src[k]) ? src[k].slice() : [];
    });
    if (!p.replies.length && !p.owner) p.replies = ['lol', 'haha ok', 'omg', 'true'];   // the owner is a real person: no bot lines
    if (!Array.isArray(p.dmSeed) || !p.dmSeed.length) delete p.dmSeed;
    p.banter = {};
    Object.keys(src.banter || {}).forEach(t => { if (Array.isArray(src.banter[t])) p.banter[t] = src.banter[t].slice(); });
    p.keywords = {};
    Object.keys(src.keywords || {}).forEach(k => { p.keywords[k.toLowerCase()] = src.keywords[k]; });
    p.theme = Object.assign({ bg: '#1b1530', fg: '#f0eaff', accent: '#ff7ad9' }, src.theme);
    p.interests = src.interests || {};
    p.avatar = src.avatar || 'assets/deco_smiley.gif';
    if (p.owner && !(p.song && p.song.name)) delete p.song;    // malten's music is his live Spotify box, no midi
    else if (!p.song || !p.song.name) p.song = { name: 'untitled.mid', artist: '', url: '', pattern: [0, 4, 7, 12, 7, 4, 0, null], bpm: 120 };
    return p;
  },

  // depth pack → existing resident: arrays append (no duplicates), objects merge, plain fields are set
  mergeDepth(id, d) {
    const p = this.people[id];
    if (!p || !d || typeof d !== 'object') return;
    const add = (key, lines) => {
      if (!Array.isArray(lines)) return;
      const list = p[key] = Array.isArray(p[key]) ? p[key] : [];
      lines.forEach(l => { if (typeof l === 'string' && l.trim() && !list.includes(l)) list.push(l); });
    };
    add('replies', d.repliesExtra);
    add('statuses', d.statusesExtra);
    if (d !== p) add('dms', d.dms);
    if (d.banterExtra && typeof d.banterExtra === 'object') {
      p.banter = p.banter || {};
      Object.keys(d.banterExtra).forEach(t => {
        if (!Array.isArray(d.banterExtra[t])) return;
        const list = p.banter[t] = p.banter[t] || [];
        d.banterExtra[t].forEach(l => { if (typeof l === 'string' && l.trim() && !list.includes(l)) list.push(l); });
      });
    }
    if (d.keywordsExtra && typeof d.keywordsExtra === 'object') {
      p.keywords = p.keywords || {};
      Object.keys(d.keywordsExtra).forEach(k => { p.keywords[k.toLowerCase()] = d.keywordsExtra[k]; });
    }
    if (Array.isArray(d.wallExtra)) {
      p.wall = p.wall || [];
      const fresh = d.wallExtra.filter(c => c && c.from && typeof c.text === 'string' && !p.wall.some(w => w.from === c.from && w.text === c.text));
      fresh.forEach((c, i) => p.wall.push({ from: c.from, text: c.text, time: c.time || this.fakeTime(id + c.text, i, fresh.length) }));
    }
    if (d === p) { delete p.statusesExtra; delete p.banterExtra; return; }   // built-in fold: the Extra fields are spent
    ['aboutMore', 'blog', 'survey', 'avatar'].forEach(k => { if (d[k] !== undefined && d[k] !== null && d[k] !== '') p[k] = d[k]; });
  },

  registerTree(tree) {
    if (!tree || typeof tree !== 'object' || typeof tree.id !== 'string' || typeof tree.with !== 'string') return false;
    if (!Array.isArray(tree.opener) || !tree.opener.length || !tree.nodes || !tree.nodes.start) return false;
    this.trees[tree.id] = tree;
    return true;
  },

  // every line a resident can say inside any of their scripted conversations
  scriptedLines(pid) {
    const out = new Set();
    Object.keys(this.trees).forEach(tid => {
      const tree = this.trees[tid];
      if (tree.with !== pid) return;
      tree.opener.forEach(l => out.add(l));
      Object.keys(tree.nodes).forEach(n => (tree.nodes[n].them || []).forEach(l => out.add(l)));
    });
    return out;
  },

  // content lands incrementally and some files fail validation: drop references to residents that aren't loaded,
  // so nothing downstream has to care (friends lists, seeded wall comments, banter targets, post comments)
  pruneRefs() {
    const P = this.people;
    Object.keys(P).forEach(id => {
      const p = P[id];
      if (Array.isArray(p.friends)) p.friends = p.friends.filter(f => P[f] && f !== id);
      if (Array.isArray(p.wall)) p.wall = p.wall.filter(c => c && (P[c.from] || c.from === 'you'));
      if (p.banter) Object.keys(p.banter).forEach(t => { if (!P[t] || t === id || !Array.isArray(p.banter[t])) delete p.banter[t]; });
    });
    (this.posts || []).forEach(post => {
      if (Array.isArray(post.comments)) post.comments = post.comments.filter(c => c && (P[c.from] || c.from === 'you'));
    });
  },

  /* ---------------- drama storylines (multi-beat arcs that play out over time) ---------------- */
  storylines: [],     // content-src/base/storylines.json (via the pack)

  tickStory() {
    if (!this.storylines.length) return false;
    const ss = this.state.storyState = this.state.storyState || {};
    const active = Object.entries(ss).filter(([, s]) => !s.done);
    if (active.length < 2) {
      const next = this.storylines.find(a => !ss[a.id]);
      if (next && (active.length === 0 || Math.random() < 0.4)) ss[next.id] = { beat: 0, wait: 0, refs: {}, done: false };
    }
    const live = Object.entries(ss).filter(([, s]) => !s.done);
    if (!live.length) return false;
    const [id, st] = live[Math.floor(Math.random() * live.length)];
    const arc = this.storylines.find(a => a.id === id);
    if (!arc) { st.done = true; this.save(); return false; }
    if (st.wait > 0) { st.wait--; this.save(); return true; }
    const beat = arc.beats[st.beat];
    if (!beat) { st.done = true; this.save(); return true; }
    this.playBeat(arc, st, beat, st.beat);
    st.beat++;
    const nextBeat = arc.beats[st.beat];
    st.wait = nextBeat ? Math.max(0, (nextBeat.wait || 1) - 1) : 0;
    if (!nextBeat) { st.done = true; this.toast('📖 that storyline wrapped up: ' + arc.title, 'feed'); }
    this.save();
    return true;
  },

  playBeat(arc, st, beat, idx) {
    const p = this.people[beat.from];
    if (!p) return;
    const t = this.now();
    let item = null;
    if (beat.type === 'status') {
      item = { type: 'status', from: beat.from, text: beat.text, time: t };
    } else if (beat.type === 'wall') {
      const to = (beat.to === 'you' || !this.people[beat.to]) ? 'you' : beat.to;
      if (to === 'you') { this.state.myWall.push({ from: beat.from, text: beat.text, time: t }); this.toast(p.name + ' posted on your wall!', 'home'); }
      else this.pushWall(to, { from: beat.from, text: beat.text, time: t });
      item = { type: 'wall', from: beat.from, to, text: beat.text, time: t };
    } else if (beat.type === 'bulletin') {
      this.state.bulletins.push({ from: beat.from, subject: beat.subject || 'bulletin from ' + p.name, body: beat.text, time: t, reposts: Math.floor(Math.random() * 6) });
      item = { type: 'bulletin', from: beat.from, text: (beat.subject ? beat.subject + ' — ' : '') + beat.text, time: t };
      if (this.view.page === 'bulletins') this.render();
    } else if (beat.type === 'dm') {
      this.deliverDm(beat.from, beat.text, { unprompted: true });
    } else if (beat.type === 'photo') {
      item = { type: 'post', from: beat.from, kind: 'photo', src: beat.src || 'assets/posts/photo_sunset.jpg', caption: beat.text, kudos: 5 + Math.floor(Math.random() * 40), comments: [], time: t };
    } else if (beat.type === 'comment') {
      const key = st.refs[beat.ref];
      const target = key ? this.state.feed.find(f => f.storyKey === key) : null;
      if (target && target.type === 'post') {
        target.comments = target.comments || [];
        target.comments.push({ from: beat.from, text: beat.text });
        this.save();
        if (this.view.page === 'feed') this.render();
        return;
      }
      if (target) {
        const to = target.from === 'you' ? 'you' : target.from;
        if (to !== 'you' && this.people[to]) this.pushWall(to, { from: beat.from, text: beat.text, time: t });
        item = { type: 'wall', from: beat.from, to, text: beat.text, time: t };
      } else item = { type: 'status', from: beat.from, text: beat.text, time: t };
    }
    if (item) {
      item.storyKey = arc.id + ':' + idx;
      st.refs[idx] = item.storyKey;
      this.pushFeed(item);
      if (this.view.page === 'profile' && item.to && this.view.arg === item.to) this.render();
    }
  },

  /* ---------------- line banks (filled at integration) ---------------- */
  banks: {},          // content-src/base/banks.json (via the pack)
  bank(name) { return (this.banks && this.banks[name]) || []; },

  // era comments came with glitter graphics stapled on — pick one deterministically per line
  decoFor(text, from) {
    const gifs = ['assets/deco_sparkle_bunny.gif', 'assets/deco_hearts_bar.gif', 'assets/deco_rainbow_bar.gif', 'assets/deco_smiley.gif',
      'assets/deco_blinkie_zim.gif', 'assets/deco_skull.gif', 'assets/posts/gif_rose.gif', 'assets/posts/gif_sparkle_heart.gif',
      'assets/badge_hello_kitty.gif', 'assets/deco_email_roses.gif', 'assets/deco_banana_tiny.gif', 'assets/deco_fairy.gif', 'assets/deco_moon.gif'];
    let h = 0;
    const s = (from || '') + (text || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    if (h % 100 >= 22) return null;
    return gifs[h % gifs.length];
  },

  dripPost() {
    if (!this.posts || !this.posts.length) return false;
    const posted = this.state.postedIdx || [];
    // pack posts are appended after posts.js, so a re-built pack can shift their indexes: also skip what's in the feed
    const key = p => p.from + '|' + (p.src || p.ytId);
    const inFeed = new Set(this.state.feed.filter(f => f.type === 'post').map(key));
    const avail = this.posts.map((_, i) => i).filter(i => !posted.includes(i) && this.people[this.posts[i].from] && !inFeed.has(key(this.posts[i])));
    if (!avail.length) return false;
    const i = avail[Math.floor(Math.random() * avail.length)];
    this.state.postedIdx = posted.concat(i);
    const item = this.postFromSource(i);
    this.pushFeed(item);
    if (Math.random() < 0.5) this.toast(this.people[item.from].name + ' posted a ' + (item.kind === 'video' ? 'video' : item.kind) + '!', 'feed');
    return true;
  },

  load() {
    // content-pack.js normally applies itself (window.MS is exported above the boot code); if it loaded but its
    // `if (window.MS && …)` guard didn't fire, apply it here — before any state is built
    this.prepContent();
    if (window.MS_PACK) this.applyPack(window.MS_PACK);
    this.pruneRefs();
    this.state = null;
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) { this.state = JSON.parse(raw); this.migrate(); }
    } catch { this.state = null; /* corrupted — start fresh */ }
    if (!this.state) { this.state = this.defaultState(); this.migrate(); }
    // scripted conversations are paced by timestamps in state: the first one of a visit arrives ~25s after load
    // (or after a longer settle-in if one is already waiting for an answer)
    const now = Date.now();
    this.state.dlgNextAt = this.activeTreeIds().length
      ? Math.min(Math.max(this.state.dlgNextAt || 0, now + 90000), now + 8 * 60000)
      : now + 24000;
    this.save();
  },
  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); }
    catch {
      // storage full: shed the bulkiest history and try once more rather than throwing mid-event
      try {
        this.state.feed = this.state.feed.slice(-80);
        Object.keys(this.state.walls).forEach(k => { this.state.walls[k] = this.state.walls[k].slice(-10); });
        localStorage.setItem(this.KEY, JSON.stringify(this.state));
      } catch { /* still full — keep running in memory */ }
    }
  },

  /* --------------------------- helpers --------------------------- */
  // every piece of text that goes through here gets {you} swapped for the visitor's screen name (see t)
  el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = MS.t(text);
    return e;
  },
  now() {
    const d = new Date();
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
  },
  // a resident's avatar (click → their profile); id null / 'you' = the visitor's own (click → My Page)
  avatarEl(id, size) {
    const img = this.el('img', 'ms-avatar');
    const mine = id === null || id === undefined || id === 'you';
    const p = mine ? null : this.people[id];
    img.src = p ? p.avatar : (mine ? this.myAvatar() : 'assets/deco_smiley.gif');
    img.alt = p ? p.name : (mine ? this.myName() : String(id));
    if (size) { img.style.width = size + 'px'; img.style.height = size + 'px'; }
    img.addEventListener('click', () => (mine ? this.show('home') : this.show('profile', id)));
    return img;
  },
  toast(text, page, arg) {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const t = this.el('div', 'toast', text);
    t.addEventListener('click', () => {
      WM.open('myspace');
      if (page) this.show(page, arg);
      t.remove();
    });
    wrap.appendChild(t);
    Sfx.beep(880, .08, 'sine', .05); Sfx.beep(1320, .12, 'sine', .05, .09);
    setTimeout(() => t.remove(), 7000);
  },

  /* ------------------------ profile songs ------------------------ */
  songLabel(p) {
    return p.song.artist ? `${p.song.name} — ${p.song.artist}` : p.song.name;
  },
  playSong(id) {
    const p = this.people[id];
    if (!p || !p.song) return;
    this.playSongObj(p.song);
  },
  // A resident's profile song: { name, artist, url?, pattern, bpm }. The real 30s preview (url) loops like a true
  // profile song; no url, or one that won't play, ends in the chiptune loop. (Visitors have no profile song: their
  // page plays the top 5 they picked, through TopSongs in apps.js.)
  playSongObj(song) {
    this.stopSong();
    if (!song) return;
    if (window.Spotify) Spotify.stop();
    if (window.TopSongs && TopSongs.stop) TopSongs.stop();
    const btn = document.getElementById('ms-song-btn');
    if (btn) btn.textContent = '⏹ ' + (song.artist ? `${song.name} — ${song.artist}` : song.name);
    if (!song.url) { this.chipLoop(song); return; }
    const a = new Audio(song.url);
    a.volume = 0.175;
    a.loop = true;
    this.songAudio = a;
    const fail = () => {
      if (this.songAudio !== a) return;
      this.songAudio = null;
      this.chipLoop(song);
    };
    a.play().catch(fail);
    a.addEventListener('error', fail);
  },
  chipLoop(song) {
    // fallback: the original chiptune rendition (a song without a pattern gets one made from its title)
    let pattern = song.pattern;
    if (!Array.isArray(pattern) || !pattern.length) {
      const scale = [0, 3, 5, 7, 10, 12, null];
      const h = this.hash(String(song.name || '') + String(song.artist || ''));
      pattern = Array.from({ length: 8 }, (_, i) => scale[(h >>> (i * 3)) % scale.length]);
    }
    const base = 330;
    let step = 0;
    this.songTimer = setInterval(() => {
      const s = pattern[step % pattern.length];
      if (s !== null) {
        Sfx.beep(base * Math.pow(2, s / 12), 0.14, 'square', 0.035);
        Sfx.beep(base / 2 * Math.pow(2, s / 12), 0.18, 'triangle', 0.03);
      }
      step++;
    }, 60000 / (song.bpm || 120) / 2);
  },
  songPlaying() { return !!(this.songTimer || this.songAudio); },
  // everything that makes noise in OurSpace, off (page changes, the window closing)
  stopMusic() {
    this.stopSong();
    if (window.Spotify) Spotify.stop();
    if (window.TopSongs && TopSongs.stop) TopSongs.stop();
  },
  stopSong() {
    clearInterval(this.songTimer);
    this.songTimer = null;
    if (this.songAudio) { this.songAudio.pause(); this.songAudio = null; }
    const btn = document.getElementById('ms-song-btn');
    if (btn && btn.textContent.startsWith('⏹')) {
      btn.textContent = '▶' + btn.textContent.slice(1);
    }
  },

  /* --------------------------- bot brain --------------------------- */
  replyMem: {},         // botReply memory for callers without a thread (walls, chat, post comments): recent lines per resident

  // An answer to something the visitor typed. Pass the inbox `thread` when there is one: a line already in that thread is
  // never said again until the whole pool (`replies`, incl. merged repliesExtra) has been used, and a keyword reply
  // never fires twice in a row for the same keyword. Without a thread the same rules apply to their recent lines.
  botReply(id, userText, thread) {
    const p = this.people[id];
    if (!p) return 'cool!';
    if (p.owner) return 'malten is away from the keyboard. (he reads every guestbook entry though — sign it!)';   // a real person: no bot lines
    const lower = String(userText || '').toLowerCase();
    const mem = this.replyMem[id] = this.replyMem[id] || { said: [], kw: null };
    const inThread = !!(thread && Array.isArray(thread.msgs));
    const said = inThread ? thread.msgs.filter(m => m.who !== 'you').map(m => m.text) : mem.said;
    const lastKw = inThread ? thread.kw : mem.kw;
    const remember = (text, kw) => {
      if (inThread) thread.kw = kw || null;
      else { mem.kw = kw || null; mem.said.push(text); if (mem.said.length > 60) mem.said.shift(); }
      return text;
    };
    if (lower && p.keywords) {
      // whole words only (plurals allowed): a keyword like 'nap' or 'tip' must not fire inside 'snap' or 'multiple'
      const hasWord = k => new RegExp('(^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:e?s)?(?=$|[^a-z0-9])').test(lower);
      for (const k of Object.keys(p.keywords)) {
        if (hasWord(k.toLowerCase()) && k !== lastKw && !said.includes(p.keywords[k])) return remember(p.keywords[k], k);
      }
    }
    const all = (p.replies || []).filter(r => typeof r === 'string' && r);
    if (!all.length) return remember('lol', null);
    let pool = all.filter(r => !said.includes(r));
    if (!pool.length) {
      // they have said everything they've got: go round again, oldest lines first, never the one they just used
      const last = said[said.length - 1];
      const byAge = all.filter(r => r !== last || all.length === 1).sort((a, b) => said.lastIndexOf(a) - said.lastIndexOf(b));
      pool = byAge.slice(0, Math.max(1, Math.ceil(byAge.length / 3)));
    }
    return remember(pool[Math.floor(Math.random() * pool.length)], null);
  },

  /* ---------------- the inbox: unprompted DMs (never repeated, never a monologue) ---------------- */
  // which standalone lines each resident has already sent the visitor, per save (hashes, so the save stays small)
  dmUsed(id, text) { return ((this.state.usedDms || {})[id] || []).includes(this.hash(text)); },
  markDmUsed(id, text) {
    const u = this.state.usedDms = this.state.usedDms || {};
    const h = this.hash(text);
    if (!(u[id] = u[id] || []).includes(h)) u[id].push(h);
  },

  // A fresh standalone message from this resident, or null if they have nothing new to say. Comes from their `dms`
  // pool (content packs); a resident with no `dms` at all may use an unposted `ambient` musing. NEVER from `replies` —
  // those are answers, and answering nothing over and over was the "repeated inbox messages" bug.
  freshDm(id) {
    const p = this.people[id];
    if (!p) return null;
    const t = this.state.inbox[id];
    const said = new Set(t ? t.msgs.filter(m => m.who !== 'you').map(m => m.text) : []);
    const ok = l => typeof l === 'string' && l && !said.has(l) && !this.dmUsed(id, l);
    let pool = (p.dms || []).filter(ok);
    if (!pool.length && !(p.dms || []).length) {
      const posted = new Set(this.state.myWall.map(c => c.text).concat(this.state.bulletins.map(b => b.body)));
      pool = (p.ambient || []).filter(l => ok(l) && !posted.has(l));
    }
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  },

  // May this resident message the visitor out of the blue right now? Not while a scripted conversation with them is open,
  // not on top of mail they haven't read, not twice in a row without an answer, and not more than every 8 minutes.
  canColdDm(id) {
    if (!this.people[id] || this.activeTreeFor(id) || this.convo[id]) return false;
    const t = this.state.inbox[id];
    if (!t || !t.msgs.length) return true;
    const last = t.msgs[t.msgs.length - 1];
    if (t.unread || (last.who !== 'you' && last.u)) return false;
    return !(t.dmAt && Date.now() - t.dmAt < 8 * 60000);
  },

  // A message from a resident lands in the visitor's inbox: marks the thread unread (unless it is open), toasts, repaints.
  // opts.unprompted → counts toward the "not twice in a row" limit; opts.toast → custom text, or false for none.
  deliverDm(id, text, opts = {}) {
    const p = this.people[id];
    if (!p || !text) return false;
    // an out-of-the-blue line never lands in the middle of a scripted conversation with them: it waits in the saved
    // effect queue, and pumpEffects holds a dm until that conversation is over
    if (opts.unprompted && (this.activeTreeFor(id) || this.convo[id])) {
      this.state.fxQueue.push({ at: Date.now(), from: id, e: { type: 'dm', text } });
      this.save();
      return true;
    }
    const t = this.state.inbox[id] = this.state.inbox[id] || { unread: false, msgs: [] };
    const msg = { who: 'them', text, time: this.now() };
    if (opts.unprompted) { msg.u = 1; t.dmAt = Date.now(); }
    if (t.msgs.length && (!t.at || Date.now() - t.at > 10 * 60000)) msg.sep = 1;   // long silence → reads as a new conversation
    t.msgs.push(msg);
    t.at = Date.now();
    const open = this.view.page === 'inbox' && this.view.arg === id;
    if (!open) t.unread = true;
    this.save();
    if (opts.toast !== false) this.toast(opts.toast || ('New message from ' + p.name + '!'), 'inbox', id);
    if (this.view.page === 'inbox' && (open || !this.view.arg)) this.render(); else this.paintTabs();
    return true;
  },

  /* ================= scripted dialogue trees (Emily-is-Away style) ================= */
  // Filled at integration time: { personId: {opener: [...], nodes: {start: {choices}, ...}} }
  dialogues: {},      // the 6 original trees now live in content-src/base/dialogues/<id>_original.json

  /* ---- conversation engine v2 ----
     MS.trees is the registry (TREE id → { id, with, opener, nodes }); the 6 built-ins above are registered as
     `<residentId>_original`, content packs add the rest (several per resident). state.dialogueState is keyed by tree
     id: { node, done?, pend?, fx?, at, end }. At most one tree per resident and two overall are in progress; who is
     next is a weighted draw, paced by state.dlgNextAt. Effects on ANY node are queued in state.fxQueue and fired by
     the pump (see queueEffects / pumpEffects), so a reload never loses them. */
  convo: {},            // live typing state per resident while an exchange plays out: { you: 'text so far' | null, them: bool }
  drafts: {},           // unsent free-text per thread, so a repaint doesn't eat what the visitor was typing

  dialogueStateFor(treeId) {
    this.state.dialogueState = this.state.dialogueState || {};
    return this.state.dialogueState[treeId];
  },

  // tree ids with a conversation in progress. A tree that is not in the registry right now (its pack file failed
  // validation, or the pack did not load) is simply not active — its progress is kept for when it comes back.
  activeTreeIds() {
    const ds = this.state.dialogueState = this.state.dialogueState || {};
    return Object.keys(ds).filter(tid => {
      const d = ds[tid], tree = this.trees[tid];
      return d && !d.done && tree && this.people[tree.with] && tree.nodes[d.node];
    });
  },

  // the tree id of the scripted conversation in progress with this resident, or null (BuddyList's ✉ uses this)
  activeTreeFor(pid) {
    return this.activeTreeIds().find(tid => this.trees[tid].with === pid) || null;
  },

  // Start one tree (by tree id; a resident id starts their next unplayed tree). Refuses if it was already played,
  // the resident isn't loaded, or they already have a scripted conversation open.
  startDialogue(treeId) {
    if (!this.trees[treeId] && this.people[treeId]) {
      const mine = Object.keys(this.trees).filter(tid => this.trees[tid].with === treeId && !this.dialogueStateFor(tid));
      treeId = mine.find(tid => tid.endsWith('_original')) || mine[0];
    }
    const tree = this.trees[treeId];
    if (!tree) return false;
    const pid = tree.with;
    const ds = this.state.dialogueState = this.state.dialogueState || {};
    if (!this.people[pid] || ds[treeId] || this.activeTreeFor(pid)) return false;
    if (window.Presence) Presence.ensureOnline(pid); // they sign on before messaging you
    ds[treeId] = { node: 'start', at: Date.now() };
    const t = this.state.inbox[pid] = this.state.inbox[pid] || { unread: false, msgs: [] };
    tree.opener.forEach((m, i) => {
      const msg = { who: 'them', text: m, time: this.now() };
      if (i === 0 && t.msgs.length) msg.sep = 1;      // a later tree with the same resident reads as a new conversation
      t.msgs.push(msg);
    });
    t.at = Date.now();
    t.unread = true;
    this.queueEffects(tree, 'start');
    // a second conversation may overlap this one, but not for a few minutes
    this.state.dlgNextAt = Date.now() + (4 + Math.random() * 4) * 60000;
    this.save();
    Sfx.beep(660, .09, 'sine', .05); Sfx.beep(880, .12, 'sine', .05, .1);
    this.toast(this.people[pid].name + ' sent you a message…', 'inbox', pid);
    if (this.view.page === 'inbox') this.render();
    this.paintTabs();
    if (window.BuddyList) BuddyList.paint();
    return true;
  },

  // Called by the pump every few seconds, by ticks, and by the boot timer: starts the next conversation when one is
  // due (state.dlgNextAt), fewer than two are open, and somebody eligible has an unplayed tree.
  maybeStartNextDialogue() {
    const st = this.state;
    if (this.typingLock || Date.now() < (st.dlgNextAt || 0)) return false;
    const active = this.activeTreeIds();
    if (active.length >= 2) return false;
    const ds = st.dialogueState;
    const busy = new Set(active.map(tid => this.trees[tid].with));
    const played = {}, lastEnd = {};
    Object.keys(ds).forEach(tid => {
      const tree = this.trees[tid];
      if (!tree) return;
      played[tree.with] = (played[tree.with] || 0) + 1;
      lastEnd[tree.with] = Math.max(lastEnd[tree.with] || 0, ds[tid].end || 0);
    });
    // unplayed trees, grouped by resident; nobody who is mid-conversation (scripted or typed) gets a new one
    const byRes = {};
    Object.keys(this.trees).forEach(tid => {
      const pid = this.trees[tid].with;
      const t = st.inbox[pid];
      if (ds[tid] || !this.people[pid] || busy.has(pid) || this.convo[pid]) return;
      if (t && t.at && Date.now() - t.at < 45000) return;
      (byRes[pid] = byRes[pid] || []).push(tid);
    });
    const who = Object.keys(byRes);
    if (!who.length) return false;
    // prefer people the visitor is friends with or has actually talked to; spread trees across the cast before repeating
    const pid = this.pickWeighted(who, id => {
      const t = st.inbox[id];
      let w = st.friends.includes(id) ? 4 : st.pending.includes(id) ? 2 : st.denied.includes(id) ? 0.3 : 0.6;
      if (t && t.msgs.some(m => m.who === 'you')) w += 3;
      else if (t && t.msgs.length) w += 1;
      w *= Math.pow(0.55, played[id] || 0);
      if (lastEnd[id] && Date.now() - lastEnd[id] < 10 * 60000) w *= 0.1;
      return w;
    });
    const mine = byRes[pid];
    const treeId = mine.find(tid => tid.endsWith('_original')) || mine[Math.floor(Math.random() * mine.length)];
    return this.startDialogue(treeId);
  },

  // the visitor picked a reply: type it out old-school, then let them answer (playNode)
  async chooseOption(treeId, choice) {
    const tree = this.trees[treeId];
    const ds = this.dialogueStateFor(treeId);
    if (!tree || !ds || ds.done || !choice) return;
    const pid = tree.with;
    // one reply is typed at a time (typingLock), and each conversation waits for its own answer (convo[pid]) —
    // but while THEY are typing, the visitor is free to answer the other conversation
    if (this.typingLock || this.convo[pid]) return;
    const t = this.state.inbox[pid] = this.state.inbox[pid] || { unread: false, msgs: [] };
    const c = this.convo[pid] = { you: '', them: false };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    this.typingLock = true;
    let sent = false;
    try {
      const raw = String(choice.say || '');
      const text = this.t(raw);                       // typed out with their name in it; saved with the raw {you}
      for (let i = 1; i <= text.length; i++) {
        c.you = text.slice(0, i);
        this.paintTyper(pid);
        Sfx.key(text[i - 1] === ' ');              // old-school keyboard clack (the space bar thunks lower)
        await sleep(34 + Math.random() * 40);
      }
      await sleep(250);
      Sfx.beep(520, .06, 'sine', .05); Sfx.beep(784, .1, 'sine', .05, .07); // sent!
      t.msgs.push({ who: 'you', text: raw, time: this.now() });
      t.at = Date.now();
      ds.node = choice.next;
      ds.pend = 1;                                    // their answer is owed (survives a reload, see playNode)
      this.save();
      sent = true;
    } finally {
      c.you = null;
      this.typingLock = false;
      if (!sent) delete this.convo[pid];
    }
    // repaint this thread — or whichever one is open, its buttons were waiting on the typing lock
    if (this.view.page === 'inbox') this.render();
    await this.playNode(treeId);
  },

  // Their side of the exchange for the node the conversation is on: "is typing…", each line, then the node's
  // effects, then the ending if it is one. Also resumes an answer that a page reload interrupted (ds.pend).
  async playNode(treeId) {
    const tree = this.trees[treeId];
    const ds = this.dialogueStateFor(treeId);
    if (!tree || !ds || ds.done) return;
    const pid = tree.with;
    if (this.convo[pid] && this.convo[pid].playing) return;
    const c = this.convo[pid] = this.convo[pid] || { you: null, them: false };
    c.playing = true;
    const t = this.state.inbox[pid] = this.state.inbox[pid] || { unread: false, msgs: [] };
    const open = () => this.view.page === 'inbox' && this.view.arg === pid;
    try {
      const nodeName = ds.node;
      const node = tree.nodes[nodeName];
      const them = (node && node.them) || [];
      // skip lines that already arrived before an interruption
      const tail = t.msgs.slice(t.msgs.map(m => m.who).lastIndexOf('you') + 1).map(m => m.text);
      let k = 0;
      while (k < them.length && tail.includes(them[k])) k++;
      if (window.Presence) Presence.ensureOnline(pid);
      let toasted = false;
      for (; k < them.length; k++) {
        await this.showTypingIndicator(pid, 1300 + Math.random() * 1700);
        t.msgs.push({ who: 'them', text: them[k], time: this.now() });
        t.at = Date.now();
        Sfx.beep(880, .1, 'sine', .05);
        this.save();
        if (open()) this.render();
        else {
          t.unread = true; this.paintTabs(); if (this.view.page === 'inbox' && !this.view.arg) this.render();
          // the visitor is reading the other conversation (or elsewhere): one toast per answer, not per line
          if (!toasted) { toasted = true; this.toast(this.people[pid].name + ' replied…', 'inbox', pid); }
        }
      }
      if (node) this.queueEffects(tree, nodeName);
      delete ds.pend;
      if (!node || node.end || !(node.choices || []).length) {
        ds.done = true;
        ds.end = Date.now();
        // a human gap before anybody else pipes up
        this.state.dlgNextAt = Date.now() + (90 + Math.random() * 120) * 1000;
      }
      this.save();
    } finally {
      delete this.convo[pid];
      if (open() || (this.view.page === 'inbox' && !this.view.arg)) this.render();
      if (window.BuddyList) BuddyList.paint();
    }
  },

  // the reply being typed, drawn under the open thread (re-created if the thread was repainted mid-word)
  paintTyper(pid) {
    const c = this.convo[pid];
    if (!c || c.you == null || this.view.page !== 'inbox' || this.view.arg !== pid) return;
    const box = document.querySelector('#ms-content .ms-thread');
    if (!box) return;
    let typer = document.querySelector('#ms-content .ms-typer');
    if (!typer) {
      const choices = document.querySelector('#ms-content .ms-choices');
      if (choices) choices.remove();
      typer = this.el('div', 'ms-typer');
      box.insertAdjacentElement('afterend', typer);
    }
    typer.textContent = c.you + '▌';
  },

  showTypingIndicator(pid, ms) {
    return new Promise(res => {
      const c = this.convo[pid] = this.convo[pid] || { you: null, them: false };
      c.them = true;
      this.paintTypingInd(pid);
      setTimeout(() => {
        c.them = false;
        if (this.view.page === 'inbox' && this.view.arg === pid) document.querySelectorAll('#ms-content .ms-typing-ind').forEach(e => e.remove());
        res();
      }, ms);
    });
  },

  paintTypingInd(pid) {
    const box = document.querySelector('#ms-content .ms-thread');
    if (!box || !this.people[pid] || this.view.page !== 'inbox' || this.view.arg !== pid || box.querySelector('.ms-typing-ind')) return;
    const ind = this.el('div', 'ms-dm them ms-typing-ind', this.people[pid].name + ' is typing');
    ind.appendChild(this.el('span', 'ms-dots', ' …'));
    box.appendChild(ind);
    box.scrollTop = box.scrollHeight;
  },

  // A node was reached: line its effects up in SAVED state so a reload can't lose them. `effects: [...]` on any node
  // (or the legacy single `effect`). Default timing: public effects a few seconds apart, a `dm` 30–90s later;
  // an explicit `delay` (seconds) wins. `from` defaults to the tree's resident.
  queueEffects(tree, nodeName) {
    const node = tree.nodes[nodeName];
    const ds = this.dialogueStateFor(tree.id);
    if (!node || !ds) return;
    const list = Array.isArray(node.effects) ? node.effects : (node.effect ? [node.effect] : []);
    if (!list.length || (ds.fx || []).includes(nodeName)) return;   // a node's effects fire once per playthrough
    ds.fx = (ds.fx || []).concat(nodeName);
    const q = this.state.fxQueue = this.state.fxQueue || [];
    let stagger = 2500;
    list.forEach(e => {
      if (!e || typeof e !== 'object' || !e.type) return;
      let delay;
      if (typeof e.delay === 'number' && e.delay >= 0) delay = e.delay * 1000;
      else if (e.type === 'dm') delay = (30 + Math.random() * 60) * 1000;
      else { delay = stagger; stagger += 4000 + Math.random() * 5000; }
      q.push({ at: Date.now() + delay, from: e.from || tree.with, tree: tree.id, e: { type: e.type, to: e.to, text: e.text, subject: e.subject } });
    });
    this.save();
  },

  // Fire at most ONE due effect per call (the pump calls this every 4s), so effects that came due together — or
  // while the page was closed — still land a few seconds apart. A `dm` waits while its sender is mid-conversation.
  pumpEffects() {
    const q = this.state.fxQueue;
    if (!q || !q.length) return false;
    const now = Date.now();
    let best = -1;
    q.forEach((x, i) => {
      if (!x || !x.e || x.at > now) return;
      if (x.e.type === 'dm' && (this.activeTreeFor(x.from) || this.convo[x.from])) return;
      if (best < 0 || x.at < q[best].at) best = i;
    });
    if (best < 0) return false;
    const x = q.splice(best, 1)[0];
    this.save();
    this.applyDialogueEffect(x.from, x.e);
    return true;
  },

  // Make one effect happen now. `from` is who acts. Unknown residents (content that hasn't landed) are skipped.
  // Feed items use the shapes renderFeed already knows: status / wall (from → to, 'you' = the visitor) / bulletin.
  // (`to: 'malten'` means malten's own wall now — he's a resident.)
  applyDialogueEffect(from, eff) {
    const p = this.people[from];
    if (!eff || !p) return false;
    const now = this.now();
    const text = eff.text;
    const toYou = !eff.to || eff.to === 'you';
    if (eff.type === 'friend') {
      if (this.state.friends.includes(from)) return false;
      this.state.friends.push(from);
      this.state.pending = this.state.pending.filter(x => x !== from);
      this.state.denied = this.state.denied.filter(x => x !== from);
      this.toast(p.name + ' added you as a friend!', 'profile', from);
      Sfx.tada();
      if (this.view.page === 'requests') this.render();
    } else if (!text) {
      return false;
    } else if (eff.type === 'status') {
      this.pushFeed({ type: 'status', from, text, time: now });
      this.toast(p.name + ' just updated their status…', 'feed');
    } else if (eff.type === 'wallpost' && !toYou) {
      if (!this.people[eff.to] || eff.to === from) return false;
      this.pushWall(eff.to, { from, text, time: now });
      this.pushFeed({ type: 'wall', from, to: eff.to, text, time: now });
      this.toast(p.name + ' wrote on ' + this.people[eff.to].name + '\'s wall…', 'profile', eff.to);
      if (this.view.page === 'profile' && this.view.arg === eff.to) this.render();
    } else if (eff.type === 'wall' || eff.type === 'wallpost') {
      this.state.myWall.push({ from, text, time: now });
      this.pushFeed({ type: 'wall', from, to: 'you', text, time: now });
      this.toast(p.name + ' posted on your wall!', 'home');
      if (this.view.page === 'home') this.render();
    } else if (eff.type === 'bulletin') {
      this.state.bulletins.push({ from, subject: eff.subject || ('bulletin from ' + p.name), body: text, time: now, reposts: 0 });
      this.pushFeed({ type: 'bulletin', from, text: (eff.subject ? eff.subject + ' — ' : '') + text, time: now });
      this.toast(p.name + ' posted a new bulletin!', 'bulletins');
      if (this.view.page === 'bulletins') this.render();
    } else if (eff.type === 'dm') {
      this.markDmUsed(from, text);
      this.deliverDm(from, text, { unprompted: true });
    } else {
      return false;
    }
    this.save();
    return true;
  },

  // engine heartbeat (every 4s, started by startAmbient): delayed effects, then maybe the next conversation
  pump() {
    this.pumpEffects();
    this.maybeStartNextDialogue();
  },

  /* ============================ RENDERING ============================ */
  // Pages: feed | home (My Page = the visitor's own) | blog (no arg = malten's Blog tab, 'me' = the visitor's blog,
  // else a resident's) | guestbook | browse | chat | requests | inbox | bulletins | profile (id; 'malten' = the owner's
  // page with the Spotify box, real blog, guestbook teaser) | pics (id) | videos (id) | post (MS.posts index)
  show(page, arg) {
    this.stopMusic();
    if (this.view && this.view.page === 'chat' && page !== 'chat' && window.Chat) Chat.onClose();
    const moved = !this.view || this.view.page !== page || this.view.arg !== arg;
    if (this.view && moved) {
      this.hist.push({ ...this.view, scroll: this.scrollBox().scrollTop });   // so back() can drop you where you were
      if (this.hist.length > 20) this.hist.shift();
    }
    this.view = { page, arg };
    this.render();
    if (moved) this.scrollBox().scrollTop = 0;      // a new page starts at its top, not wherever the last one was scrolled
  },

  back() {
    const prev = this.hist.pop();
    this.stopMusic();
    if (this.view && this.view.page === 'chat' && window.Chat) Chat.onClose();
    this.view = prev ? { page: prev.page, arg: prev.arg } : { page: 'feed', arg: null };
    this.render();
    this.scrollBox().scrollTop = (prev && prev.scroll) || 0;
  },

  // the element that actually scrolls OurSpace (the window body); a harmless stand-in before build()
  scrollBox() {
    return document.querySelector('.window[data-app="myspace"] .window-body') || { scrollTop: 0 };
  },

  // Scroll a named profile box into view and flash it — e.g. MS.jumpTo('spotify'). An anchor that isn't on the
  // current page opens the page it lives on first (anchorPages: malten's boxes; anything else = My Page).
  // Safe to call right after show(), from any page, with anchors that don't exist, and while the sign-up is up
  // (then it waits for the sign-up to finish).
  anchorPages: { spotify: ['profile', 'malten'], guestbook: ['profile', 'malten'], hits: ['profile', 'malten'] },
  jumpTo(anchor, tries = 0) {
    if (!this.state) return;
    if (!this.state.me || this.signupOpen) { this.pendingJump = anchor; return; }
    const here = () => [...document.querySelectorAll('#ms-content [data-anchor]')].some(e => e.dataset.anchor === anchor);
    if (!tries && !here()) {
      const [page, arg] = this.anchorPages[anchor] || ['home'];
      if (this.view.page !== page || (arg && this.view.arg !== arg)) this.show(page, arg);
    }
    const el = [...document.querySelectorAll('#ms-content [data-anchor]')].find(e => e.dataset.anchor === anchor);
    if (!el) {
      if (tries < 8) setTimeout(() => this.jumpTo(anchor, tries + 1), 150);   // My Page may still be painting
      return;
    }
    this.reveal(el);
  },

  // scroll an element into view inside the window and flash it (jumpTo, and the feed's click-throughs)
  reveal(el) {
    const box = this.scrollBox();
    const align = behavior => {
      if (!el.isConnected) return;
      if (box.scrollHeight > box.clientHeight + 4) {
        const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: Math.max(0, top - 60), behavior });               // 60px: clear the sticky tab bar
      } else if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });   // stacked mobile layout: the page scrolls
    };
    align('smooth');
    // pictures above the box may still be loading and nudging it down: settle once more, without animation
    setTimeout(() => align('auto'), 900);
    el.classList.remove('ms-flash');
    void el.offsetWidth;                                                      // restart the animation if it's mid-flash
    el.classList.add('ms-flash');
    setTimeout(() => el.classList.remove('ms-flash'), 2600);
  },

  // A feed line about a bulletin / a wall comment is only a summary: open the page it lives on and flash the thing
  // itself. Bulletins (data-bkey) and wall comments (data-wkey) are tagged from + time, the same pair the feed item
  // was pushed with.
  goToFeedItem(item) {
    const key = item.from + '|' + item.time;
    if (item.type === 'bulletin') {
      // the board is paged: make sure it shows far enough down to include this one
      const rest = this.state.bulletins.filter(b => !b.pinned).reverse();
      const pos = rest.findIndex(b => b.from === item.from && b.time === item.time);
      if (pos >= 0) { this.shown = this.shown || {}; this.shown.bulletins = Math.max(this.shown.bulletins || 0, pos + 1); }
      this.show('bulletins');
      this.flashKeyed('bkey', key);
    } else if (item.type === 'wall') {
      if (item.to === 'you') this.show('home'); else this.show('profile', item.to);
      this.flashKeyed('wkey', key);
    }
  },
  flashKeyed(attr, key, tries = 0) {
    const el = [...document.querySelectorAll(`#ms-content [data-${attr}]`)].find(e => e.dataset[attr] === key);
    if (el) { this.reveal(el); return; }
    if (tries < 8) setTimeout(() => this.flashKeyed(attr, key, tries + 1), 150);   // the page may still be painting
    else this.toast(attr === 'bkey' ? 'that bulletin has scrolled off the board' : 'that comment isn\'t on the wall anymore');
  },

  render() {
    const root = document.getElementById('ms-content');
    if (!root) return;
    // no page yet (or "make your page" from a guest): the sign-up sits in the content area until it's done. The view
    // underneath is kept (a deep link lands there afterwards); repaints while it's up leave the half-typed form alone.
    if (!this.state.me || this.signupOpen) {
      this.paintTabs();
      if (root.dataset.page !== 'signup' || !root.querySelector('.ms-signup')) {
        root.innerHTML = '';
        root.dataset.page = 'signup';
        this.renderSignup(root);
      }
      return;
    }
    // a feed-over-feed refresh keeps its children: renderFeed re-uses the cards of playing videos, and detaching
    // a YouTube <iframe> would reload it. Every other page change starts from an empty root.
    if (!(this.view.page === 'feed' && root.dataset.page === 'feed')) root.innerHTML = '';
    root.dataset.page = this.view.page;
    if (this.view.page === 'feed') this.state.unreadFeed = 0;
    if (this.view.page === 'guestbook') localStorage.setItem('malten_gb_seen', '1');
    this.paintTabs();
    const { page, arg } = this.view;
    if (page === 'feed') this.renderFeed(root);
    else if (page === 'home') this.renderProfile(root, null);
    else if (page === 'profile') this.renderProfile(root, arg == null || arg === 'you' ? null : arg);   // no id = your own page
    else if (page === 'blog') { if (arg) this.renderResidentBlog(root, arg); else this.renderBlog(root); }   // arg 'me' = yours
    else if (page === 'guestbook') this.renderGuestbook(root);
    else if (page === 'pics' || page === 'videos') this.renderMedia(root, arg, page);
    else if (page === 'post') this.renderPostPage(root, arg);
    else if (page === 'browse') this.renderBrowse(root);
    else if (page === 'chat') {
      if (window.Chat) Chat.onOpen(root);
      else root.appendChild(this.el('p', 'ms-empty', 'the chatroom is warming up…'));
    }
    else if (page === 'requests') this.renderRequests(root);
    else if (page === 'inbox') this.renderInbox(root, arg);
    else if (page === 'bulletins') this.renderBulletins(root);
    if (page === 'home' || page === 'profile') {
      if (window.initHitCounter) initHitCounter();   // only does something where the counter is (malten's page)
      if (window.Webring) Webring.initWidgets();
    }
    this.save();
  },

  paintTabs() {
    const reqN = this.state.pending.length;
    const inbN = Object.values(this.state.inbox).filter(t => t.unread).length;
    const badge = (id, n) => {
      const t = document.querySelector(`.ms-tab[data-page="${id}"]`);
      if (t) t.textContent = t.dataset.label + (n ? ` (${n})` : '');
    };
    badge('requests', reqN);
    badge('inbox', inbN);
    badge('feed', this.state.unreadFeed || 0);
    document.querySelectorAll('.ms-tab').forEach(t =>
      t.classList.toggle('on', t.dataset.page === this.view.page &&
        (t.dataset.arg ? this.view.arg === t.dataset.arg       // Malten's Page = profile + arg malten
          : !(t.dataset.page === 'blog' && this.view.arg))));  // a resident's blog isn't malten's Blog tab
    this.paintUrl();
    // NEW! marker on the Guestbook tab until this visitor has opened it (or already signed)
    const gb = document.querySelector('.ms-tab[data-page="guestbook"]');
    if (gb) gb.classList.toggle('ms-tab-new', !localStorage.getItem('malten_gb_seen') && !(window.Guestbook && Guestbook.hasSigned()));
  },

  // the pretend address for the current page (the Address bar in the window chrome; same host as the
  // "OurSpace URL" box on every profile)
  urlFor() {
    const base = 'http://ourspace.ring/';
    if (!this.state || !this.state.me || this.signupOpen) return base + 'join';
    const { page, arg } = this.view || { page: 'feed' };
    const me = 'you/' + encodeURIComponent(this.myName());
    const who = arg == null || arg === 'you' || arg === 'me' ? me : encodeURIComponent(arg);
    const paths = {
      feed: 'feed', home: me, profile: who, blog: arg ? who + '/blog' : 'malten/blog',
      guestbook: 'malten/guestbook', browse: 'browse' + (this.browseQuery ? '?q=' + encodeURIComponent(this.browseQuery) : ''),
      chat: 'chat/%23ourspace', requests: 'friends/requests', inbox: 'inbox' + (arg ? '/' + encodeURIComponent(arg) : ''),
      bulletins: 'bulletins', pics: who + '/pics', videos: who + '/videos', post: 'post/' + (arg == null ? '' : arg),
    };
    return base + (paths[page] !== undefined ? paths[page] : page);
  },
  paintUrl() {
    const u = document.getElementById('ms-url');
    if (u) u.textContent = this.urlFor();
  },

  // one gentle, one-time toast pointing visitors who haven't found the guestbook at it
  nudgeGuestbook() {
    if (localStorage.getItem('malten_gb_nudged') || localStorage.getItem('malten_gb_seen')) return;
    if ((window.Guestbook && Guestbook.hasSigned()) || this.view.page === 'guestbook') return;
    localStorage.setItem('malten_gb_nudged', '1');
    this.toast('📖 psst — the guestbook is open!! sign it, it takes 10 seconds (malten reads every entry twice)', 'guestbook');
  },

  /* ---------- the sign-up: "join ourspace" ---------- */
  // Shown in the content area by render() while there is no state.me (first visit, or after Switch user), and when a
  // guest clicks "make your page" (signupOpen). Screen name + picture; everything else is Edit My Page's job.
  renderSignup(root) {
    const st = this.state;
    const upgrading = !!st.me;                       // a guest making their page for real
    const box = this.el('div', 'ms-signup');
    const bar = this.el('div', 'title-bar');
    bar.appendChild(this.el('div', 'title-bar-text', '👥 join ourspace — it\'s free and always will be*'));
    const x = this.el('button', 'btn98 su-x', '✕');
    x.title = 'maybe later'; x.setAttribute('aria-label', 'Close');
    bar.appendChild(x);
    box.appendChild(bar);

    const body = this.el('div', 'su-body');
    const head = this.el('div', 'su-head');
    const logo = this.el('span', 'ms-logo', 'ourspace');
    logo.appendChild(this.el('span', 'ms-logo-dot', '.'));
    head.append(logo, this.el('span', 'su-slogan', 'a place for friends'));
    body.appendChild(head);
    body.appendChild(this.el('p', 'su-lead', st.wasMalten && !upgrading
      ? 'ourspace got a makeover! this desktop belongs to malten (he built it), and now YOU get a page of your own. everybody you\'ve met is still here. pick a screen name and a picture:'
      : 'everybody here has a page. make yours in about ten seconds: pick a screen name and a picture. you can change all of it later in Edit My Page.'));

    const form = this.el('div', 'su-form');
    const lab = this.el('label', 'su-label', 'screen name:');
    lab.htmlFor = 'su-name';
    const row = this.el('div', 'su-namerow');
    const inp = this.el('input', 'su-name');
    inp.id = 'su-name'; inp.maxLength = 20; inp.placeholder = 'xX_your_name_Xx'; inp.autocomplete = 'off'; inp.spellcheck = false;
    const dice = this.el('button', 'btn98', '🎲 pick one for me');
    row.append(inp, dice);
    const err = this.el('div', 'su-err');
    err.setAttribute('role', 'alert');
    form.append(lab, row, err, this.el('div', 'su-hint', '3–20 characters: letters, numbers and _ (plus ~ * . - for styling)'));

    form.appendChild(this.el('div', 'su-label', 'pick a picture:'));
    const basics = this.avatarBasics;
    let avatar = upgrading ? st.me.avatar : basics[Math.floor(Math.random() * basics.length)].file;
    const gallery = this.avatarGallery(avatar, src => { avatar = src; Sfx.click(); });
    form.appendChild(gallery);
    form.appendChild(this.el('div', 'su-hint', 'want your own picture? upload one (or use your Paint masterpiece) in Edit My Page.'));
    body.appendChild(form);

    const btns = this.el('div', 'su-btns');
    const go = this.el('button', 'btn98 su-go', upgrading ? '✔ make my page!' : '✔ join ourspace!');
    const later = this.el('a', 'su-later', upgrading ? 'never mind, stay a guest' : 'maybe later — just look around as a guest');
    later.href = '#';
    btns.append(go, later);
    body.appendChild(btns);
    body.appendChild(this.el('div', 'su-fine', '*todd says the server costs $4 a month and he\'s "fine".'));
    box.appendChild(body);
    root.appendChild(box);

    const join = () => {
      const name = inp.value.trim();
      const e = this.validName(name);
      if (e) { err.textContent = e; Sfx.error(); inp.focus(); return; }
      this.finishSignup(name, avatar);
    };
    go.addEventListener('click', join);
    inp.addEventListener('keypress', e => { if (e.key === 'Enter') join(); });
    inp.addEventListener('input', () => { err.textContent = ''; });
    dice.addEventListener('click', () => { inp.value = this.randomName(); err.textContent = ''; Sfx.click(); });
    const skip = e => { if (e) e.preventDefault(); this.skipSignup(); };
    later.addEventListener('click', skip);
    x.addEventListener('click', skip);
    gallery.reveal();                                 // a guest upgrading: their current picture may be further down
    setTimeout(() => { if (inp.isConnected && window.innerWidth > 820) inp.focus({ preventScroll: true }); }, 50);
  },

  finishSignup(name, avatar) {
    const st = this.state;
    if (!st.me) this.createMe(name, avatar);
    else { st.me.name = name; st.me.avatar = avatar; delete st.me.guest; }
    this.signupOpen = false;
    this.save();
    Sfx.tada();
    this.toast(`welcome to ourspace, ${name}!! ✨ your page is ready (click to see it)`, 'home');
    this.welcomeDm();
    this.afterSignup();
  },
  // "maybe later" / ✕: browse as `guest` (My Page nags about it). A guest who backs out of upgrading stays a guest.
  skipSignup() {
    this.signupOpen = false;
    if (!this.state.me) {
      this.createMe('guest', this.avatarBasics[0].file, { guest: true });
      this.welcomeDm();
    }
    Sfx.click();
    this.afterSignup();
  },
  afterSignup() {
    this.render();                                    // whatever page was asked for underneath (a deep link, the feed)
    this.meChanged();
    if (this.pendingJump) { const a = this.pendingJump; this.pendingJump = null; this.jumpTo(a); }
  },

  // todd says hi to every new screen name (once per line — a guest who signs up later keeps the same welcome)
  welcomeDm() {
    const st = this.state;
    if (!this.people.todd) return;
    const line = st.switchedFrom
      ? 'oh hey {you}! new screen name? I updated the member database. (It is a sticky note on my monitor.)'
      : 'Welcome to OurSpace, {you}! I\'m Todd. I\'ll be your first friend. This is not optional, but it is heartfelt.';
    delete st.switchedFrom;
    const t = st.inbox.todd;
    if (t && (t.msgs || []).some(m => m && m.text === line)) return;
    setTimeout(() => this.deliverDm('todd', line, { toast: 'New message from Todd!' }), 2500);
  },

  // Contacting box → "Switch user": forget the page (state.me), keep the world, back to the sign-up
  switchUser() {
    const name = this.myName();
    this.confirm98('Switch user', `sign out of "${name}" and start a brand new page? your page (name, picture, layout, blog, top 5) gets wiped. your friends, messages and everybody else stay right where they are.`, [
      ['✔ yes, switch', () => {
        this.stopMusic();
        if (window.WM && WM.wins && WM.wins.has('customize')) WM.close('customize');   // it was editing the old page
        this.state.switchedFrom = name;
        delete this.state.me;
        this.signupOpen = false;
        this.hist = [];
        this.view = { page: 'feed', arg: null };
        this.save();
        this.render();
        this.meChanged();
      }],
      ['✖ no, stay', null],
    ]);
  },

  // a small Win98 message box over everything: buttons = [[label, fn or null], …]; Esc / clicking outside = cancel
  confirm98(title, text, buttons) {
    const wrap = this.el('div', 'ms-modal');
    const box = this.el('div', 'ms-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', title);
    const bar = this.el('div', 'title-bar');
    bar.appendChild(this.el('div', 'title-bar-text', title));
    box.appendChild(bar);
    const body = this.el('div', 'ms-dialog-body');
    body.append(this.el('span', 'ms-dialog-icon', '⚠'), this.el('div', null, text));
    box.appendChild(body);
    const btns = this.el('div', 'ms-dialog-btns');
    const onKey = e => { if (e.key === 'Escape') close(); };
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    buttons.forEach(([label, fn]) => {
      const b = this.el('button', 'btn98', label);
      b.addEventListener('click', () => { close(); if (fn) fn(); });
      btns.appendChild(b);
    });
    box.appendChild(btns);
    wrap.appendChild(box);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    if (Sfx.error) Sfx.error();
    if (btns.lastChild) btns.lastChild.focus();
  },

  /* ---------- profile pages — classic 2006 anatomy ----------
     id === null → YOUR page (built from state.me; Edit My Page edits it). A resident id → theirs. The owner (malten,
     `owner: true`) gets what My Page used to be: his live Spotify top songs, the real blog, the guestbook teaser,
     the hit counter, his 88x31 buttons + the webring. */
  renderProfile(root, id) {
    const me = id === null;
    const p = me ? this.mePage() : this.people[id];
    if (!p) return;
    const owner = !me && !!p.owner;
    const st = this.state;
    if (me) st.profileViews = (st.profileViews || 0) + 1;
    if (owner) st.ownerViews = (st.ownerViews || 1336) + 1;
    const nm = p.name;
    const poss = this.poss(nm);

    if (!me) {
      this.backBar(root);
      // lurking has consequences: strangers may notice you viewed their page
      if (p.dmSeed && !st.inbox[id] && !this.viewDmArmed[id] && Math.random() < 0.35) {
        this.viewDmArmed[id] = true;
        setTimeout(() => {
          if (this.state.inbox[id]) return;
          this.state.inbox[id] = { unread: true, msgs: p.dmSeed.map(m => ({ who: 'them', text: m.text, time: this.now() })) };
          this.save();
          this.toast(p.name + ' noticed you on their page and sent a message!', 'inbox', id);
          this.paintTabs();
        }, 8000 + Math.random() * 15000);
      }
    }

    const prof = this.el('div', 'ms-profile' + (owner ? ' is-owner' : '') + (me ? ' is-me' : ''));
    this.skin(prof, p);

    /* ================= LEFT COLUMN ================= */
    const left = this.el('div', 'ms-left');
    const idcard = this.el('div', 'ms-idcard');
    left.appendChild(idcard);
    idcard.appendChild(this.el('div', 'ms-name', nm));
    const av = this.el('img', 'ms-bigavatar'); av.src = p.avatar; av.alt = nm;
    if (me) {
      av.title = 'change your picture in Edit My Page';
      av.style.cursor = 'pointer';
      av.addEventListener('click', () => WM.open('customize'));
    }
    idcard.appendChild(av);
    if (me) {
      // the button first-timers hunt for: big, right under the picture, impossible to miss
      const edit = this.el('button', 'btn98 ms-editbig', '🎨 Edit My Page');
      edit.title = 'picture, name, about me, colours, top 5, top 8 — all of it';
      edit.addEventListener('click', () => { Sfx.click(); WM.open('customize'); });
      idcard.appendChild(edit);
    }

    // gender / age / hometown / last login stack (the classic under-photo block)
    const stack = this.el('div', 'ms-idstack');
    const gender = me ? p.gender : (p.gender || (p.age === '??' ? '???' : 'Human'));   // yours: only if you said
    if (gender) stack.appendChild(this.el('div', null, gender));
    stack.appendChild(this.el('div', null, p.age === '??' && me ? 'age: classified' : `${p.age} years old`));
    stack.appendChild(this.el('div', null, p.hometown || p.loc || 'Somewhere, USA'));
    stack.appendChild(this.el('div', 'ms-lastlogin', 'Last Login: ' + p.lastLogin));
    idcard.appendChild(stack);

    if (!me && window.Presence) {
      if (Presence.away[id]) idcard.appendChild(this.el('div', 'online-dot away', '⏳ away: ' + Presence.away[id]));
      else if (Presence.online[id]) idcard.appendChild(this.el('div', 'online-dot blink', '🟢 ONLINE NOW!'));
      else idcard.appendChild(this.el('div', 'online-dot off', '⚪ offline'));
    }

    const viewMy = this.el('div', 'ms-viewmy');
    if (owner) {
      // malten's page: no pics/videos links, just one button straight to the real blog
      const b = this.el('button', 'btn98 ms-viewblog', '📁 Blog');
      b.addEventListener('click', () => { Sfx.click(); this.show('blog'); });
      viewMy.appendChild(b);
    } else {
      viewMy.appendChild(document.createTextNode('View My: '));
      // residents: their own media posts / blog pages. you: My Pictures, the feed's media, your blog.
      const pics = this.el('a', null, 'Pics'); pics.href = '#';
      pics.addEventListener('click', e => {
        e.preventDefault();
        if (!me) this.show('pics', id);
        else if (window.WM && WM.wins.has('pics')) WM.open('pics');
        else { this.feedFilter = 'media'; this.show('feed'); }
      });
      const vids = this.el('a', null, 'Videos'); vids.href = '#';
      vids.addEventListener('click', e => {
        e.preventDefault();
        if (!me) this.show('videos', id);
        else { this.feedFilter = 'media'; this.show('feed'); }
      });
      const blog = this.el('a', null, 'Blog'); blog.href = '#';
      blog.addEventListener('click', e => { e.preventDefault(); this.show('blog', me ? 'me' : id); });
      viewMy.append(pics, document.createTextNode(' | '), vids, document.createTextNode(' | '), blog);
    }
    idcard.appendChild(viewMy);
    idcard.appendChild(this.el('div', 'ms-moodline', 'Mood: ' + (p.mood || '')));
    idcard.appendChild(this.el('div', 'ms-tagline', '"' + (p.tag || '') + '"'));

    const decor = (Array.isArray(p.decor) ? p.decor : []).filter(src => typeof src === 'string' && src);
    if (decor.length) {
      const dec = this.el('div', 'ms-decor');
      decor.forEach(src => { const im = this.el('img'); im.src = src; im.alt = ''; dec.appendChild(im); });
      left.appendChild(dec);
    }

    // Contacting box — the eight sacred links
    const contact = this.el('div', 'ms-contactbox');
    contact.appendChild(this.el('div', 'ms-boxtitle', 'Contacting ' + nm));
    const cgrid = this.el('div', 'ms-contactgrid');
    const link = (icon, label, fn) => {
      const a = this.el('a', 'ms-clink'); a.href = '#';
      a.appendChild(this.el('span', 'ms-cicon', icon));
      a.appendChild(document.createTextNode(label));
      a.addEventListener('click', e => { e.preventDefault(); fn(); });
      cgrid.appendChild(a);
    };
    if (!me) {
      const isFriend = st.friends.includes(id);
      const favs = st.favorites = st.favorites || [];
      // malten is a real person: no inbox bot. His messages go in the guestbook.
      const dm = owner
        ? () => { this.toast('malten doesn\'t really do DMs — he reads the guestbook (every entry, twice). sign it!', 'guestbook'); this.jumpTo('guestbook'); }
        : () => this.show('inbox', id);
      link('✉', 'Send Message', dm);
      link('👤', isFriend ? 'Your Friend ✔' : 'Add to Friends', () => {
        if (this.state.friends.includes(id)) { this.toast(p.name + ' is already your friend. good news twice.'); return; }
        this.state.friends.push(id);
        this.state.pending = this.state.pending.filter(x => x !== id);
        this.toast(p.name + ' is now your friend!');
        this.scheduleThanks(id);
        this.save();
        this.render();
      });
      link('💬', 'Instant Message', owner ? dm : () => { if (window.Presence) Presence.ensureOnline(id); this.show('chat'); });
      link('👥', 'Add to Group', () => this.toast('there is one group. it\'s called ourspace. you\'re already in it.'));
      link('➡', 'Forward to Friend', () => this.toast('forwarded to todd. todd already knew.'));
      link('★', favs.includes(id) ? 'Favorited ★' : 'Add to Favorites', () => {
        if (!favs.includes(id)) { favs.push(id); this.toast(p.name + ' added to your favorites'); Sfx.click(); this.save(); this.render(); }
      });
      link('🚫', 'Block User', () => this.toast(owner ? 'you can\'t block malten. it\'s his desktop. you\'re in his living room.' : 'blocking is disabled on ourspace. we are all stuck here together.'));
      link('⚑', 'Report User', () => this.toast(owner ? 'reported malten to malten. he says thanks for the feedback.' : 'reported to todd. todd says: "noted."'));
    } else {
      link('🎨', 'Edit My Page', () => WM.open('customize'));
      link('✏', 'Update Status', () => this.show('feed'));
      link('📖', 'Guestbook', () => this.show('guestbook'));
      link('✨', 'Glitter Studio', () => WM.open('glitter'));
      link('🖼', 'My Pictures', () => WM.open('pics'));
      link('📁', 'My Blog', () => this.show('blog', 'me'));
      link('🎛', 'Control Panel', () => WM.open('settings'));
      link('🔁', 'Switch user', () => this.switchUser());
    }
    contact.appendChild(cgrid);
    left.appendChild(contact);

    const urlbox = this.el('div', 'ms-urlbox');
    urlbox.appendChild(this.el('div', 'ms-boxtitle', 'OurSpace URL:'));
    urlbox.appendChild(this.el('div', 'ms-urltext', 'http://ourspace.ring/' + (me ? nm : id)));
    left.appendChild(urlbox);

    // music: malten's page leads with his real Spotify top songs (Spotify in apps.js: live / cached / snapshot /
    // napping); yours shows just the top 5 you picked in Edit My Page (TopSongs); residents have a profile song
    const musicBox = this.el('div', 'ms-section ms-musicbox');
    if (owner) {
      musicBox.dataset.anchor = 'spotify';          // MS.jumpTo('spotify')
      const mt = this.el('div', 'ms-boxtitle', poss + ' Top Songs');
      mt.appendChild(this.el('span', 'ms-boxsub', '  [this month, via spotify]'));
      musicBox.appendChild(mt);
      const host = this.el('div', 'sp-box');
      if (window.Spotify) Spotify.mount(host);
      else host.appendChild(this.el('div', 'sp-nap', '💤 the spotify server is napping. check back later.'));
      musicBox.appendChild(host);
    } else if (me) {
      musicBox.dataset.anchor = 'music';
      const title = poss + ' Top 5';
      musicBox.appendChild(this.el('div', 'ms-boxtitle', title));
      const host = this.el('div', 'ms-top5');
      const top5 = (p.top5 || []).filter(s => s && s.name);
      if (top5.length && window.TopSongs && TopSongs.mount) TopSongs.mount(host, top5);   // no title: the box has ours
      else if (top5.length) {
        const ol = this.el('ol', 'ms-top5-list');
        top5.forEach(s => ol.appendChild(this.el('li', null, s.artist ? `${s.name} — ${s.artist}` : s.name)));
        host.appendChild(ol);
      } else {
        const none = this.el('div', 'ms-songnote ms-top5-none', 'no top 5 yet. a page without a top 5 is just a list of facts. ');
        const pick = this.el('a', null, '[pick your 5 songs]'); pick.href = '#';
        pick.addEventListener('click', e => { e.preventDefault(); this.openEditor('music'); });
        none.appendChild(pick);
        host.appendChild(none);
      }
      musicBox.appendChild(host);
    } else musicBox.appendChild(this.el('div', 'ms-boxtitle', poss + ' Music Player'));
    if (!me && p.song && p.song.name) {
      const songBtn = this.el('button', 'btn98 ms-songbtn');
      songBtn.id = 'ms-song-btn';
      songBtn.textContent = '▶ ' + this.songLabel(p);
      songBtn.addEventListener('click', () => {
        if (this.songPlaying()) this.stopSong();
        else this.playSongObj(p.song);
      });
      musicBox.appendChild(songBtn);
      musicBox.appendChild(this.el('div', 'ms-songnote', 'profile song — plays on loop like it\'s 2006'));
    } else if (!me && !owner) musicBox.appendChild(this.el('div', 'ms-songnote', 'no profile song. the silence is a statement.'));
    left.appendChild(musicBox);

    // Interests table (your page always lists all six, blanks included — they're an invitation)
    const intBox = this.el('div', 'ms-section');
    intBox.appendChild(this.el('div', 'ms-boxtitle', poss + ' Interests'));
    const intr = this.el('table', 'ms-interests');
    const order = ['General', 'Music', 'Movies', 'Television', 'Books', 'Heroes'];
    const ints = p.interests || {};
    const keys = me ? order : order.filter(k => ints[k] !== undefined).concat(Object.keys(ints).filter(k => !order.includes(k)));
    keys.forEach(k => {
      const tr = this.el('tr');
      tr.appendChild(this.el('td', 'ms-int-k', k));
      tr.appendChild(this.el('td', me && !ints[k] ? 'ms-blank' : null, ints[k] || (me ? '(nothing yet)' : '')));
      intr.appendChild(tr);
    });
    intBox.appendChild(intr);
    left.appendChild(intBox);

    // Details table
    const detBox = this.el('div', 'ms-section');
    detBox.appendChild(this.el('div', 'ms-boxtitle', poss + ' Details'));
    const det = this.el('table', 'ms-interests');
    const rows = [['Status', p.status || 'Single'], ['Here for', p.hereFor || 'Friends'], ['Hometown', p.hometown || p.loc || '—'],
      ['Zodiac Sign', p.zodiac || '—']];
    if (p.enneagram) rows.push(['Enneagram', p.enneagram]);
    if (me) rows.push(['Member Since', new Date(p.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })]);
    else rows.push(['Occupation', p.occupation || 'professional ourspace user']);
    rows.forEach(([k, v]) => {
      const tr = this.el('tr');
      tr.appendChild(this.el('td', 'ms-int-k', k));
      tr.appendChild(this.el('td', null, v));
      det.appendChild(tr);
    });
    detBox.appendChild(det);
    left.appendChild(detBox);

    /* ================= RIGHT COLUMN ================= */
    const right = this.el('div', 'ms-right');
    if (me && p.guest) {
      // skipped the sign-up: one box nobody can miss
      const nag = this.el('div', 'ms-section ms-guestnag');
      nag.appendChild(this.el('div', 'ms-boxtitle', '👋 you\'re browsing as "guest"'));
      const nb = this.el('div', 'ms-guestnag-row');
      nb.appendChild(this.el('span', null, 'everybody on ourspace has a page with their own name on it. yours is one click away:'));
      const mk = this.el('button', 'btn98 ms-guestnag-btn', '✨ make your page!!');
      mk.addEventListener('click', () => { Sfx.click(); this.signupOpen = true; this.render(); this.scrollBox().scrollTop = 0; });
      nb.appendChild(mk);
      nag.appendChild(nb);
      right.appendChild(nag);
    }
    right.appendChild(this.el('div', 'ms-banner', me ? 'This is YOUR page. Everyone else is just visiting.'
      : owner ? 'malten built this whole desktop. you\'re standing in his living room.' : nm + ' is in your extended network'));

    // Latest blog entry
    const blogBox = this.el('div', 'ms-section');
    const bt = this.el('div', 'ms-boxtitle', poss + ' Latest Blog Entry');
    bt.appendChild(this.el('span', 'ms-boxsub', me ? '  [your blog]' : '  [Subscribe to this Blog]'));
    blogBox.appendChild(bt);
    const blogBody = this.el('div', 'ms-blogentry');
    const blogLink = (label, fn) => {
      const all = this.el('a', null, label); all.href = '#';
      all.addEventListener('click', e => { e.preventDefault(); fn(); });
      blogBody.appendChild(all);
      return all;
    };
    const entries = owner ? [] : me ? (p.blog || []).filter(e => e && (e.title || e.body)) : this.blogSorted(p);
    if (owner) {
      // malten's real posts (MS.blogPosts) — the whole list lives on the Blog tab
      const post = this.blogPosts[0];
      if (post) {
        const a = this.el('a', 'ms-blogtitle', post.title); a.href = post.href;
        blogBody.appendChild(a);
        blogBody.appendChild(this.el('div', 'ms-blogexcerpt', [post.date, post.blurb].filter(Boolean).join(' — ')));
      } else blogBody.appendChild(this.el('div', 'ms-blogexcerpt', 'nothing posted yet. the drafts folder is thriving though.'));
      blogLink(`[View All Blog Entries (${this.blogPosts.length})]`, () => this.show('blog'));
    } else if (entries.length) {
      // newest real entry: title, date + mood, a short excerpt
      const latest = entries[0];
      const a = this.el('a', 'ms-blogtitle', latest.title || 'untitled'); a.href = '#';
      a.addEventListener('click', e => { e.preventDefault(); this.show('blog', me ? 'me' : id); });
      blogBody.appendChild(a);
      const meta = [latest.date, latest.mood && 'mood: ' + latest.mood].filter(Boolean).join(' · ');
      if (meta) blogBody.appendChild(this.el('div', 'ms-boxsub', meta));
      blogBody.appendChild(this.el('div', 'ms-blogexcerpt', this.excerpt(this.t(latest.body), 180)));
      blogLink(`[View All Blog Entries (${entries.length})]`, () => this.show('blog', me ? 'me' : id));
      if (me) { blogBody.appendChild(document.createTextNode(' ')); blogLink('[✎ write a new entry]', () => this.show('blog', 'me')); }
    } else if (me) {
      blogBody.appendChild(this.el('div', 'ms-blogexcerpt', p.blogTitle
        ? `"${p.blogTitle}" — no entries yet. the first one is the hardest. (it's also the only one anyone reads.)`
        : 'no entries yet. the first one is the hardest. (it\'s also the only one anyone reads.)'));
      blogLink('[✎ write your first entry]', () => this.show('blog', 'me'));
    } else {
      const title = p.blogTitle || ((p.statuses && p.statuses[0]) || 'untitled (still thinking)');
      const a = this.el('a', null, title); a.href = '#';
      a.addEventListener('click', e => { e.preventDefault(); this.toast(p.name + '\'s blog is "under construction" (since 2006).'); });
      blogBody.appendChild(a);
      blogBody.appendChild(this.el('span', 'ms-boxsub', ' (view more)'));
      blogLink('[View All Blog Entries]', () => this.show('blog', id));
    }
    blogBox.appendChild(blogBody);
    right.appendChild(blogBox);

    // Blurbs
    const aboutBox = this.el('div', 'ms-section ms-blurbs');
    aboutBox.appendChild(this.el('div', 'ms-boxtitle', poss + ' Blurbs'));
    if (owner) {      // the glitter wordmark from the old desktop "About Me" window lives here
      const ag = this.el('img', 'ms-aboutgif'); ag.src = 'about.gif'; ag.alt = 'About Me';
      aboutBox.appendChild(ag);
    }
    aboutBox.appendChild(this.el('div', 'ms-abouthead', 'About me:'));
    aboutBox.appendChild(this.el('p', null, p.about || (me ? '(nothing yet — tell everyone something in Edit My Page)' : '')));
    if (p.aboutMore) aboutBox.appendChild(this.el('p', null, p.aboutMore));
    aboutBox.appendChild(this.el('div', 'ms-abouthead', 'Who I\'d like to meet:'));
    aboutBox.appendChild(this.el('p', null, p.meet || 'anyone who leaves a comment first. i\'m shy (i\'m not).'));
    right.appendChild(aboutBox);

    // Survey (the bulletin-survey kind, pinned to the profile)
    const qa = (p.survey && Array.isArray(p.survey.qa)) ? p.survey.qa.filter(Boolean) : [];
    if (qa.length) {
      const sv = this.el('div', 'ms-section ms-survey');
      sv.appendChild(this.el('div', 'ms-boxtitle', p.survey.title || poss + ' Survey'));
      const tbl = this.el('table', 'ms-interests');
      qa.forEach(pair => {
        const [q, a] = Array.isArray(pair) ? pair : [pair.q, pair.a];
        const tr = this.el('tr');
        tr.appendChild(this.el('td', 'ms-survey-q', q));
        tr.appendChild(this.el('td', null, a));
        tbl.appendChild(tr);
      });
      sv.appendChild(tbl);
      right.appendChild(sv);
    }

    // a Top 8 grid (avatars click through to the profile, the card too)
    const top8Box = (title, ids, foot) => {
      const box = this.el('div', 'ms-section');
      box.appendChild(this.el('div', 'ms-boxtitle', title));
      const grid = this.el('div', 'top8-grid');
      ids.filter(fid => this.people[fid]).slice(0, 8).forEach((fid, i) => {
        const card = this.el('div', 'friend');
        card.appendChild(this.avatarEl(fid));
        card.appendChild(this.el('span', 'fname', this.people[fid].name));
        card.title = `#${i + 1} — ${this.people[fid].name}`;
        card.style.cursor = 'pointer';
        card.addEventListener('click', e => { if (e.target.tagName !== 'IMG') this.show('profile', fid); });
        grid.appendChild(card);
      });
      box.appendChild(grid);
      if (foot) box.appendChild(foot);
      right.appendChild(box);
    };
    const badgeBox = (srcs, title, empty) => {
      const box = this.el('div', 'ms-section');
      box.appendChild(this.el('div', 'ms-boxtitle', title));
      const bw = this.el('div', 'ms-badgewall');
      srcs.forEach(src => { const im = this.el('img'); im.src = src; im.alt = src.split('/').pop().replace(/\.\w+$/, ''); bw.appendChild(im); });
      box.appendChild(bw);
      if (!srcs.length && empty) box.appendChild(empty);
      right.appendChild(box);
      return box;
    };

    if (owner) {
      // the guestbook teaser: the latest entries + a button nobody can miss
      const gbBox = this.el('div', 'ms-section ms-gbteaser');
      gbBox.dataset.anchor = 'guestbook';
      gbBox.appendChild(this.el('div', 'ms-boxtitle', '📖 sign my guestbook!!'));
      const gbRow = this.el('div', 'ms-gbteaser-row');
      const gbSign = this.el('img', 'ms-gbsign'); gbSign.src = 'assets/deco_guestbook_sign.gif'; gbSign.alt = 'sign the guestbook';
      const gbMid = this.el('div', 'ms-gbteaser-mid');
      const gbList = this.el('div', 'ms-gbteaser-list');
      const signed = !!(window.Guestbook && Guestbook.hasSigned());
      const fillGb = () => {
        gbList.innerHTML = '';
        (window.Guestbook ? Guestbook.latest(3) : []).forEach(m => {
          const row = this.el('div', 'ms-gbentry');
          row.appendChild(this.el('b', null, m.screenName + ': '));
          row.appendChild(document.createTextNode(m.message));
          if (m.timestamp) row.appendChild(this.el('span', 'ms-time', ' ' + new Date(m.timestamp).toLocaleDateString()));
          gbList.appendChild(row);
        });
      };
      fillGb();
      if (window.Guestbook && !Guestbook.msgs) Guestbook.fetchAll().then(() => { if (gbList.isConnected) fillGb(); });
      gbMid.appendChild(this.el('div', 'ms-gbteaser-lead', signed
        ? 'you signed it!! ♥ go see who else stopped by:'
        : 'real visitors, real messages. the latest ones:'));
      gbMid.appendChild(gbList);
      const cta = this.el('button', 'btn98 ms-gbcta', signed ? '📖 read the guestbook (or sign it again)' : '✍ SIGN THE GUESTBOOK!!');
      [gbSign, cta].forEach(x => x.addEventListener('click', () => { Sfx.click(); this.show('guestbook'); }));
      gbMid.appendChild(cta);
      gbRow.append(gbSign, gbMid);
      gbBox.appendChild(gbRow);
      right.appendChild(gbBox);

      const vitals = this.el('div', 'ms-section');
      vitals.dataset.anchor = 'hits';
      vitals.appendChild(this.el('div', 'ms-boxtitle', poss + ' vitals'));
      const row = this.el('div', 'ms-mypage-row');
      row.appendChild(this.el('span', null, 'you are visitor number:'));
      const hc = this.el('span', 'hit-counter'); hc.id = 'hit-counter';
      row.appendChild(hc);
      const uc = this.el('img'); uc.src = 'assets/under_construction_sign.gif'; uc.alt = ''; uc.height = 30;
      row.appendChild(uc);
      vitals.appendChild(row);
      vitals.appendChild(this.el('div', 'ms-mypage-row', `profile views: ${st.ownerViews} · friends: ${(p.friends || []).length} · ★ ALWAYS ONLINE ★`));
      right.appendChild(vitals);

      top8Box(poss + ' Top 8', p.top8 || p.friends || []);
      const bw = badgeBox(['badge_netscape', 'badge_best_viewed_with_eyes', 'badge_built_with_microsoft_notepad', 'badge_geocities', 'badge_winamp', 'badge_mspaint', 'badge_hello_kitty', 'badge_8bit']
        .map(b => `assets/${b}.gif`), 'my buttons');
      bw.appendChild(this.el('div', 'webring-widget'));
    } else if (me) {
      const vitals = this.el('div', 'ms-section');
      vitals.appendChild(this.el('div', 'ms-boxtitle', poss + ' vitals'));
      vitals.appendChild(this.el('div', 'ms-mypage-row', `profile views: ${st.profileViews} · friends: ${st.friends.length} · blog entries: ${entries.length}`));
      right.appendChild(vitals);

      const t8note = this.el('p', 'ms-mypage-links', 'if you\'re not on here, it\'s nothing personal (it\'s a little personal). ');
      const t8edit = this.el('a', null, '[rearrange in Edit My Page]'); t8edit.href = '#';
      t8edit.addEventListener('click', e => { e.preventDefault(); this.openEditor('friends'); });
      t8note.appendChild(t8edit);
      top8Box(poss + ' Top 8', this.myTop8(), t8note);

      const empty = this.el('p', 'ms-mypage-links', 'no buttons yet. ');
      const addB = this.el('a', null, '[pick some 88x31s]'); addB.href = '#';
      addB.addEventListener('click', e => { e.preventDefault(); this.openEditor('look'); });
      empty.appendChild(addB);
      badgeBox(p.badges || [], 'my buttons', empty);
    }

    // Friend Space
    const friendBox = this.el('div', 'ms-section');
    const fl = ((me ? st.friends : p.friends) || []).filter(fid => this.people[fid]);
    friendBox.appendChild(this.el('div', 'ms-boxtitle', `${poss} Friend Space`));
    friendBox.appendChild(this.el('div', 'ms-friendcount', `${nm} has ${fl.length} friends.`));
    const fgrid = this.el('div', 'ms-friendgrid');
    fl.slice(0, 8).forEach(fid => {
      const card = this.el('div', 'ms-minifriend');
      card.appendChild(this.avatarEl(fid, 60));
      card.appendChild(this.el('div', 'ms-minifriend-name', this.people[fid].name));
      fgrid.appendChild(card);
    });
    friendBox.appendChild(fgrid);
    const viewAll = this.el('a', 'ms-viewall', `View All of ${poss} Friends`); viewAll.href = '#';
    viewAll.addEventListener('click', e => { e.preventDefault(); this.browseFilter = me ? 'friends' : 'all'; this.show('browse'); });
    friendBox.appendChild(viewAll);
    right.appendChild(friendBox);

    // Friends Comments (the wall)
    const wallKey = me ? null : id;
    const seedWall = me ? [] : (p.wall || []);
    const extra = me ? st.myWall : (st.walls[wallKey] || []);
    const all = [...seedWall, ...extra];
    const wallBox = this.el('div', 'ms-section');
    wallBox.appendChild(this.el('div', 'ms-boxtitle', `${poss} Friends Comments`));
    const disp = this.el('div', 'ms-friendcount');
    disp.appendChild(document.createTextNode(`Displaying ${all.length} of ${all.length} comments ( `));
    const va = this.el('a', null, 'View All'); va.href = '#'; va.addEventListener('click', e => e.preventDefault());
    const ac = this.el('a', null, 'Add Comment'); ac.href = '#';
    disp.append(va, document.createTextNode(' | '), ac, document.createTextNode(' )'));
    wallBox.appendChild(disp);
    all.slice().reverse().forEach(c => {
      const row = this.el('div', 'ms-comment');
      row.dataset.wkey = c.from + '|' + c.time;
      const who = this.el('div', 'ms-comment-who');
      const mine = c.from === 'you';
      who.appendChild(this.avatarEl(mine ? null : c.from, 50));
      const b = this.el('b', null, mine ? this.myName() : (this.people[c.from] ? this.people[c.from].name : c.from));
      if (!mine && this.people[c.from]) b.addEventListener('click', () => this.show('profile', c.from));
      who.appendChild(b);
      row.appendChild(who);
      const bodyCol = this.el('div', 'ms-comment-col');
      bodyCol.appendChild(this.el('div', 'ms-time', c.time));
      bodyCol.appendChild(this.el('div', 'ms-comment-body', c.text));
      const g = !mine ? this.decoFor(c.text, c.from) : null;
      if (g) { const im = this.el('img', 'ms-glitter'); im.src = g; im.alt = ''; bodyCol.appendChild(im); }
      row.appendChild(bodyCol);
      wallBox.appendChild(row);
    });

    const form = this.el('div', 'ms-commentform');
    const inp = this.el('input');
    inp.placeholder = me ? 'write on your own wall (sure, why not)' : 'leave a comment for ' + p.name + '…';
    inp.maxLength = 200;
    ac.addEventListener('click', e => { e.preventDefault(); inp.focus(); });
    const post = this.el('button', 'btn98', 'Post');
    const submit = () => {
      const text = inp.value.trim();
      if (!text) return;
      const entry = { from: 'you', text: Guestbook.filter(text), time: this.now() };
      if (me) this.state.myWall.push(entry);
      else {
        (this.state.walls[wallKey] = this.state.walls[wallKey] || []).push(entry);
        if (owner) this.toast('malten will see it! (he\'s a real person, so no instant replies. the guestbook is where he answers.)', 'guestbook');
        else this.scheduleWallReply(id, text);
      }
      inp.value = '';
      Sfx.click();
      this.save();
      this.render();
    };
    post.addEventListener('click', submit);
    inp.addEventListener('keypress', e => { if (e.key === 'Enter') submit(); });
    form.append(inp, post);
    wallBox.appendChild(form);
    right.appendChild(wallBox);

    const foot = this.el('div', 'ms-footerbar');
    const bar = this.el('img');
    bar.src = 'assets/deco_rainbow_bar.gif'; bar.alt = '';
    foot.appendChild(bar);
    right.appendChild(foot);

    prof.append(left, right);
    root.appendChild(prof);
  },

  // open Edit My Page (one scrolling page, opens at its top). A section — 'pic' | 'about' | 'blog' | 'look' | 'music' |
  // 'friends' — scrolls there instead, this one time (links like "[pick your 5 songs]")
  openEditor(section) {
    if (window.Customizer) Customizer.jump = section || null;
    WM.open('customize');
  },

  scheduleWallReply(id, userText) {
    const delay = 4000 + Math.random() * 8000;
    setTimeout(() => {
      const reply = { from: id, text: this.botReply(id, userText), time: this.now() };
      (this.state.walls[id] = this.state.walls[id] || []).push(reply);
      this.save();
      if (this.view.page === 'profile' && this.view.arg === id) this.render();
      else this.toast(this.people[id].name + ' replied to your comment!', 'profile', id);
    }, delay);
  },

  scheduleThanks(id) {
    setTimeout(() => {
      this.state.myWall.push({ from: id, text: this.people[id].thanksAdd, time: this.now() });
      this.save();
      if (this.view.page === 'home') this.render();
      else this.toast(this.people[id].name + ' posted on your wall!', 'home');
    }, 5000 + Math.random() * 6000);
  },

  /* ---------- shared bits for profile-ish pages ---------- */
  // paint an element in a resident's colors (theme, tiled background, readable panels, font)
  skin(el, p) {
    const th = p.theme || { bg: '#ffffff', fg: '#000000', accent: '#6699cc' };
    el.style.background = th.bg;
    if (p.bgTile) el.style.background = `${th.bg} url(${p.bgTile}) repeat`;
    el.style.color = th.fg;
    el.style.setProperty('--ms-accent', th.accent);
    // content panels sit on a translucent plate so tiled backgrounds stay readable
    const hex = (th.bg || '#000').replace('#', '');
    const lum = hex.length >= 6 ? (parseInt(hex.slice(0, 2), 16) * 0.299 + parseInt(hex.slice(2, 4), 16) * 0.587 + parseInt(hex.slice(4, 6), 16) * 0.114) : 0;
    el.style.setProperty('--ms-panel', lum < 128 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.88)');
    if (p.font) el.style.fontFamily = p.font;
  },

  backBar(root) {
    const barNav = this.el('div', 'ms-backbar');
    const bk = this.el('button', 'btn98', '← back');
    bk.addEventListener('click', () => this.back());
    barNav.appendChild(bk);
    root.appendChild(barNav);
    return barNav;
  },

  // shorten text that gets SAVED (a repost note, a feed brief) without leaving half a {you} token at the end
  cut(text, n) { return String(text || '').slice(0, n).replace(/\{[A-Za-z]*$/, ''); },

  excerpt(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const cut = s.lastIndexOf(' ', max);
    return s.slice(0, cut > max * 0.6 ? cut : max).trimEnd() + '…';
  },

  // a resident's blog entries ({ title, date, mood, body }), newest first. Dates are free-form
  // strings: whatever Date.parse can't read keeps its authored order, after the dated ones.
  blogSorted(p) {
    const when = e => { const t = Date.parse(e.date); return isNaN(t) ? -Infinity : t; };
    return ((p && Array.isArray(p.blog)) ? p.blog : []).filter(e => e && (e.title || e.body))
      .map((e, i) => ({ e, i, t: when(e) }))
      .sort((a, b) => (b.t - a.t) || (a.i - b.i)).map(x => x.e);
  },

  // one resident's media posts from MS.posts, with their index: kind 'pics' (photo/gif) or 'videos' (yt/video)
  mediaOf(id, kind) {
    const want = kind === 'videos' ? ['yt', 'video'] : ['photo', 'gif'];
    return (this.posts || []).map((src, idx) => ({ src, idx })).filter(x => x.src.from === id && want.includes(x.src.kind));
  },

  /* ---------- Blog tab: malten's real posts (MS.blogPosts) ---------- */
  renderBlog(root) {
    root.appendChild(this.el('div', 'ms-pagetitle', '📝 malten\'s Blog — the real one, written by the real me'));
    const page = this.el('div', 'ms-blogpage');
    // same look as malten's page
    const owner = this.people.malten;
    this.skin(page, owner || { theme: { bg: '#f3eefb', fg: '#000000', accent: '#9370DB' } });

    const head = this.el('div', 'ms-section ms-bloghead');
    const av = this.el('img', 'ms-avatar'); av.src = owner ? owner.avatar : 'pfp.png'; av.alt = 'malten';
    av.title = 'malten\'s page';
    av.addEventListener('click', () => this.show('profile', 'malten'));
    head.appendChild(av);
    const hm = this.el('div', 'ms-bloghead-mid');
    hm.appendChild(this.el('div', 'ms-name', 'malten\'s Blog'));
    hm.appendChild(this.el('div', 'ms-tagline', 'long-form thoughts from the guy who built this desktop. each entry opens as its own page — hit 🖥️ Desktop (or close the window) to come back.'));
    const n = this.blogPosts.length;
    hm.appendChild(this.el('div', 'ms-boxsub', `${n} ${n === 1 ? 'entry' : 'entries'} so far · subscribers: todd (he subscribes to everyone)`));
    head.appendChild(hm);
    page.appendChild(head);

    this.blogPosts.forEach((post, i) => {
      const card = this.el('div', 'ms-section ms-blogcard');
      const bt = this.el('div', 'ms-boxtitle', post.date || 'blog entry');
      if (i === 0) { const nw = this.el('img', 'deco-inline'); nw.src = 'assets/deco_new.gif'; nw.alt = 'NEW!'; nw.height = 16; bt.appendChild(nw); }
      card.appendChild(bt);
      const row = this.el('a', 'ms-blogcard-row'); row.href = post.href;
      if (post.img) {
        const im = this.el('img', 'ms-blogcard-img'); im.src = post.img; im.alt = '';
        im.addEventListener('error', () => im.remove());
        row.appendChild(im);
      }
      const mid = this.el('div', 'ms-blogcard-mid');
      mid.appendChild(this.el('div', 'ms-blogpost-title', post.title));
      if (post.blurb) mid.appendChild(this.el('div', 'ms-blogexcerpt', post.blurb));
      mid.appendChild(this.el('div', 'ms-blogcard-more', 'read the whole thing »'));
      row.appendChild(mid);
      card.appendChild(row);
      page.appendChild(card);
    });
    if (!n) page.appendChild(this.el('p', 'ms-empty', 'no posts yet. the drafts folder is thriving though.'));

    const soon = this.el('div', 'ms-section ms-blogsoon');
    const uc = this.el('img'); uc.src = 'assets/under_construction_sign.gif'; uc.alt = 'under construction'; uc.height = 50;
    soon.appendChild(uc);
    const sm = this.el('div');
    sm.appendChild(this.el('b', null, 'more entries coming soon.'));
    sm.appendChild(this.el('div', null, 'i have like nine drafts and zero discipline. subscribe (in your heart) and check back.'));
    const hub = this.el('a', null, '→ open the full blog archive ←'); hub.href = 'blog-hub.html';
    sm.appendChild(hub);
    soon.appendChild(sm);
    page.appendChild(soon);
    root.appendChild(page);
  },

  /* ---------- a blog page: show('blog', id) — a resident's, or yours with id 'me' (you can write entries) ---------- */
  renderResidentBlog(root, id) {
    const mine = id === 'me';
    const p = mine ? (this.state.me && this.mePage()) : this.people[id];
    this.backBar(root);
    if (!p) { root.appendChild(this.el('p', 'ms-empty', 'this blog has been deleted. or never existed. hard to say.')); return; }
    const poss = this.poss(p.name);
    const page = this.el('div', 'ms-blogpage');
    this.skin(page, p);
    const link = (label, fn) => {
      const a = this.el('a', null, label); a.href = '#';
      a.addEventListener('click', e => { e.preventDefault(); fn(); });
      return a;
    };

    const entries = mine ? (p.blog || []).filter(e => e && (e.title || e.body)) : this.blogSorted(p);   // yours: newest first already
    const head = this.el('div', 'ms-section ms-bloghead');
    head.appendChild(this.avatarEl(mine ? null : id, 54));
    const hm = this.el('div', 'ms-bloghead-mid');
    hm.appendChild(this.el('div', 'ms-name', poss + ' Blog'));
    hm.appendChild(this.el('div', 'ms-tagline', '"' + ((mine && p.blogTitle) || p.tag || '') + '"'));
    const links = this.el('div', 'ms-boxsub', `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · `);
    if (mine) links.append(link('[View My Page]', () => this.show('home')), ' ', link('[name your blog]', () => this.openEditor('blog')));
    else links.append(link('[View Profile]', () => this.show('profile', id)), ' ',
      link('[Subscribe]', () => this.toast('subscribed to ' + poss + ' blog. you will be notified never. (it\'s 2006.)')));
    hm.appendChild(links);
    head.appendChild(hm);
    page.appendChild(head);

    if (mine) page.appendChild(this.blogComposer());
    if (!entries.length && mine) {
      page.appendChild(this.el('p', 'ms-empty', 'no entries yet. write one up there ↑ — todd subscribes to everyone, so you already have a reader.'));
    } else if (!entries.length) {
      const none = this.el('div', 'ms-section ms-blogpost');
      none.appendChild(this.el('div', 'ms-boxtitle', 'no entries yet'));
      none.appendChild(this.el('div', 'ms-blogpost-body',
        (p.blogTitle ? `"${p.blogTitle}" is still a draft. ` : '') + `${poss} blog has been "under construction" since 2006. leave a comment on their page and maybe they'll finish it.`));
      page.appendChild(none);
    }
    entries.forEach(e => {
      const post = this.el('div', 'ms-section ms-blogpost');
      post.appendChild(this.el('div', 'ms-boxtitle', e.date || 'sometime in 2006'));
      post.appendChild(this.el('div', 'ms-blogpost-title', e.title || 'untitled'));
      if (e.mood) post.appendChild(this.el('div', 'ms-blogpost-mood', 'Current mood: ' + e.mood));
      post.appendChild(this.el('div', 'ms-blogpost-body', e.body || ''));
      const foot = this.el('div', 'ms-blogpost-foot', 'posted by ' + p.name + ' · ');
      if (mine) {
        foot.append(link('delete', () => this.confirm98('Delete entry', `delete "${e.title || 'untitled'}"? there's no recycle bin on ourspace.`, [
          ['🗑 delete it', () => { this.state.me.blog = this.state.me.blog.filter(x => x !== e); this.save(); this.render(); }],
          ['keep it', null],
        ])));
      } else foot.append(link('Add Comment', () => this.show('profile', id)), ' · ', link('Send Message', () => this.show('inbox', id)));
      post.appendChild(foot);
      page.appendChild(post);
    });
    root.appendChild(page);
  },

  // the "write a new entry" box on your own blog: title / mood / body, newest first in state.me.blog
  blogComposer() {
    const box = this.el('div', 'ms-section ms-blogcompose');
    box.appendChild(this.el('div', 'ms-boxtitle', '✎ write a new entry'));
    const title = this.el('input', 'ms-bc-title');
    title.placeholder = 'title (e.g. "my first blog!!!1")'; title.maxLength = 80;
    const mood = this.el('input', 'ms-bc-mood');
    mood.placeholder = 'current mood'; mood.maxLength = 40;
    mood.setAttribute('list', 'ms-mood-list');
    const moods = this.el('datalist'); moods.id = 'ms-mood-list';
    this.moodPresets.forEach(m => { const o = this.el('option'); o.value = m; moods.appendChild(o); });
    const body = this.el('textarea', 'ms-bc-body');
    body.placeholder = 'dear diary… (well, dear internet)'; body.maxLength = 4000; body.rows = 6;
    const draft = this.blogDraft || {};
    title.value = draft.title || ''; mood.value = draft.mood || ''; body.value = draft.body || '';
    [title, mood, body].forEach(f => f.addEventListener('input', () => { this.blogDraft = { title: title.value, mood: mood.value, body: body.value }; }));
    const row = this.el('div', 'ms-bc-row');
    row.append(title, mood, moods);
    const post = this.el('button', 'btn98', '📝 post entry');
    post.addEventListener('click', () => {
      const b = body.value.trim(), tt = title.value.trim();
      if (!b) { Sfx.error(); body.focus(); return; }
      const me = this.state.me;
      me.blog = Array.isArray(me.blog) ? me.blog : [];
      me.blog.unshift({ title: Guestbook.filter(tt || 'untitled'), mood: Guestbook.filter(mood.value.trim()), body: Guestbook.filter(b), date: this.now(), at: Date.now() });
      this.blogDraft = null;
      this.save();
      Sfx.tada();
      this.toast('posted to your blog ✨');
      this.blogReaction();
      this.render();
    });
    box.append(row, body, post);
    return box;
  },
  moodPresets: ['curious', 'new here :]', 'sleepy', 'hyper!!', 'emo', 'bored', 'creative', 'giddy', 'mellow', 'blah', 'artistic',
    'mischievous', 'nostalgic', 'rawr', 'sparkly', 'grumpy', 'happy :D', 'confused o.O', 'accomplished', 'hungry', 'crushed', 'determined'],
  // somebody always reads it (and says so on your wall)
  blogReactions: [
    { from: 'todd', text: 'Read your new blog entry, {you}! I subscribed. I subscribe to everyone. It is my only hobby besides the server.' },
    { from: 'darkangel', text: 'i read your blog entry by candlelight, {you}. the void has been informed. it says "keep going."' },
    { from: 'patrick', text: 'i read ur blog!! i didnt understand all of it but i read ALL of it' },
    { from: 'starxgazer', text: 'saw your blog entry. very scorpio of you. (still not checking.) ✨' },
    { from: 'herp', text: 'herp. (good blog)' },
  ],
  blogReaction() {
    const pool = this.blogReactions.filter(r => this.people[r.from]);
    if (!pool.length) return;
    const r = pool[Math.floor(Math.random() * pool.length)];
    setTimeout(() => {
      const when = this.now();
      this.state.myWall.push({ from: r.from, text: r.text, time: when });
      this.pushFeed({ type: 'wall', from: r.from, to: 'you', text: r.text, time: when });
      this.toast(this.people[r.from].name + ' read your blog!', 'home');
      if (this.view.page === 'home') this.render();
    }, 6000 + Math.random() * 9000);
  },

  /* ---------- a resident's Pics / Videos: show('pics', id) / show('videos', id) ---------- */
  renderMedia(root, id, kind) {
    const p = this.people[id];
    this.backBar(root);
    if (!p) { root.appendChild(this.el('p', 'ms-empty', 'nobody by that name has uploaded anything. spooky.')); return; }
    const poss = p.name + (p.name.endsWith('s') ? "'" : "'s");
    const lists = { pics: this.mediaOf(id, 'pics'), videos: this.mediaOf(id, 'videos') };
    const title = this.el('div', 'ms-pagetitle');
    title.appendChild(this.avatarEl(id, 28));
    title.appendChild(this.el('span', null, `${poss} ${kind === 'videos' ? 'Videos' : 'Pics'}`));
    root.appendChild(title);

    const chips = this.el('div', 'ms-feedbar');
    [['pics', '📷 pics'], ['videos', '📼 videos']].forEach(([k, label]) => {
      const b = this.el('button', 'btn98' + (k === kind ? ' on' : ''), `${label} (${lists[k].length})`);
      // switching between the two isn't a new "place" — don't stack it in the back history
      b.addEventListener('click', () => { if (k === kind) return; Sfx.click(); this.view = { page: k, arg: id }; this.render(); });
      chips.appendChild(b);
    });
    root.appendChild(chips);

    const list = lists[kind] || [];
    if (!list.length) {
      root.appendChild(this.el('p', 'ms-empty', kind === 'videos'
        ? `${p.name} hasn't uploaded any videos yet. the camcorder is charging.`
        : `${p.name} hasn't uploaded any pics yet. the camera phone is charging.`));
      return;
    }
    const grid = this.el('div', 'ms-mediagrid');
    list.forEach(({ src, idx }) => {
      const cap = src.title || this.excerpt(this.t(src.caption), 70);
      const tile = this.el('div', 'ms-mediatile');
      tile.title = this.t(src.caption) || cap;
      const thumb = this.el('div', 'ms-mediathumb' + (src.kind === 'gif' ? ' gif' : ''));
      const still = src.kind === 'yt' ? `https://i.ytimg.com/vi/${src.ytId}/mqdefault.jpg` : (src.kind === 'video' ? null : src.src);
      if (still) { const im = this.el('img'); im.src = still; im.alt = ''; im.loading = 'lazy'; thumb.appendChild(im); }
      else thumb.appendChild(this.el('span', 'ms-mediathumb-tape', '📼'));
      if (kind === 'videos') thumb.appendChild(this.el('span', 'ms-mediaplay', '▶'));
      tile.appendChild(thumb);
      tile.appendChild(this.el('div', 'ms-mediacap', cap));
      tile.addEventListener('click', () => {
        // pictures open in the lightbox when it's around; everything else opens the post itself
        if (kind === 'pics' && window.ImageViewer) ImageViewer.open(src.src, this.t(src.caption) || cap);
        else this.show('post', idx);
      });
      grid.appendChild(tile);
    });
    root.appendChild(grid);
  },

  /* ---------- one media post on its own page: show('post', index into MS.posts) ---------- */
  renderPostPage(root, idx) {
    this.backBar(root);
    const src = (this.posts || [])[idx];
    if (!src) { root.appendChild(this.el('p', 'ms-empty', 'that post got deleted. or todd tripped over the server again.')); return; }
    // reuse the feed's copy when this post is already in the feed, so kudos + comments stay in sync;
    // otherwise keep a session copy (it hasn't been "posted" yet as far as the feed is concerned)
    this.loosePosts = this.loosePosts || {};
    const item = this.state.feed.find(f => f.type === 'post' && f.postIdx === idx)
      || (this.loosePosts[idx] = this.loosePosts[idx] || this.postFromSource(idx, 'from the archives'));
    root.appendChild(this.renderPost(item));
  },

  /* ---------- Guestbook tab: the real guestbook (UI + storage are Guestbook in apps.js) ---------- */
  renderGuestbook(root) {
    root.appendChild(this.el('div', 'ms-pagetitle', '📖 malten\'s Guestbook — say hi, leave your mark'));
    const page = this.el('div', 'ms-gbpage');
    page.appendChild(this.el('p', 'ms-gbintro', 'this one is REAL: no bots, no todd. pick a screen name, say something nice, and it stays here for the next visitor. malten reads every entry at least twice.'));
    const host = this.el('div', 'ms-gbhost');
    page.appendChild(host);
    root.appendChild(page);      // in the document first, so the guestbook can scroll itself to the newest entry
    if (window.Guestbook && Guestbook.mount) Guestbook.mount(host);
    else host.appendChild(this.el('p', 'ms-empty', 'the guestbook is out getting more pages. try again in a sec.'));
  },

  /* ---------- activity feed ---------- */
  pushFeed(item) {
    this.state.feed.push(item);
    if (this.state.feed.length > 160) this.state.feed = this.state.feed.slice(-160);
    if (this.view.page !== 'feed') this.state.unreadFeed = (this.state.unreadFeed || 0) + 1;
    this.save();
    if (this.view.page === 'feed') this.render(); else this.paintTabs();
  },

  // a comment lands on a RESIDENT's wall (state.walls[id]); capped so busy walls don't grow the save forever
  pushWall(to, entry) {
    const w = this.state.walls[to] = this.state.walls[to] || [];
    w.push(entry);
    if (w.length > 60) w.splice(0, w.length - 60);
  },

  // "show more" paging for long lists: renders `step` items into listEl now and appends a button after it that
  // reveals the next batch in place (no repaint, so the scroll position holds). `key` remembers how far you got.
  paged(listEl, key, items, step, renderItem) {
    const shown = this.shown = this.shown || {};
    const more = this.el('button', 'btn98 ms-more');
    let n = 0;
    const grow = upTo => {
      for (; n < Math.min(upTo, items.length); n++) {
        const node = renderItem(items[n], n);
        if (node) listEl.appendChild(node);
      }
      shown[key] = n;
      if (items.length > n) {
        more.textContent = `▼ show more (${items.length - n} more)`;
        if (!more.parentNode) listEl.insertAdjacentElement('afterend', more);
      } else more.remove();
    };
    more.addEventListener('click', () => { Sfx.click(); grow(n + step); });
    grow(Math.max(step, shown[key] || 0));
  },

  renderFeed(root) {
    this.pruneOrphanPosts();
    this.watchPlayers(root);
    // render() empties root before calling us; renderPost then hands back the SAME card for a post whose video is
    // running (see `players`). `put` appends in order, and if root still holds such a card it leaves it where it
    // is — detaching an <iframe> reloads it.
    const kept = new Set([...this.players.values()].map(p => p.card));
    [...root.children].forEach(n => { if (!kept.has(n)) n.remove(); });
    let at = root.firstChild;
    const put = node => { if (node === at) at = at.nextSibling; else root.insertBefore(node, at); };
    put(this.el('div', 'ms-pagetitle', 'The Feed — what everyone is up to'));

    const composer = this.el('div', 'ms-commentform');
    const inp = this.el('input');
    inp.placeholder = "update your status… what's on your mind?";
    inp.maxLength = 200;
    const share = this.el('button', 'btn98', 'Share');
    const submit = () => {
      const text = Guestbook.filter(inp.value.trim());
      if (!text) return;
      this.state.myWall.push({ from: 'you', text, time: this.now() });
      this.state.feed.push({ type: 'status', from: 'you', text, time: this.now() });
      inp.value = '';
      Sfx.click();
      this.save();
      this.render();
    };
    share.addEventListener('click', submit);
    inp.addEventListener('keypress', e => { if (e.key === 'Enter') submit(); });
    composer.append(inp, share);
    put(composer);

    const chips = this.el('div', 'ms-feedbar');
    [['all', 'everything'], ['media', '📷 photos & videos'], ['people', '💬 wall & statuses']].forEach(([key, label]) => {
      const b = this.el('button', 'btn98' + ((this.feedFilter || 'all') === key ? ' on' : ''), label);
      b.addEventListener('click', () => { this.feedFilter = key; Sfx.click(); this.render(); });
      chips.appendChild(b);
    });
    put(chips);

    const nameOf = id => id === 'you' ? this.myName() + ' (you)' : (this.people[id] ? this.people[id].name : id);
    const filter = this.feedFilter || 'all';
    this.state.feed.slice().reverse().forEach(item => {
      if (filter === 'media' && item.type !== 'post') return;
      if (filter === 'people' && item.type === 'post') return;
      if (item.type === 'post') { put(this.renderPost(item)); return; }
      const row = this.el('div', 'ms-feeditem');
      row.appendChild(this.avatarEl(item.from === 'you' ? null : item.from, 40));
      const mid = this.el('div', 'ms-reqmid');
      const head = this.el('div');
      const a = this.el('b', 'ms-feedname', nameOf(item.from));
      a.addEventListener('click', () => (item.from === 'you' ? this.show('home') : this.show('profile', item.from)));
      head.appendChild(a);
      if (item.type === 'wall') {
        head.appendChild(document.createTextNode(' ➜ '));
        const b = this.el('b', 'ms-feedname', (item.to === 'you' ? 'your' : nameOf(item.to) + "'s") + ' wall');
        b.addEventListener('click', () => item.to === 'you' ? this.show('home') : this.show('profile', item.to));
        head.appendChild(b);
      } else if (item.type === 'status') head.appendChild(document.createTextNode(' updated their status'));
      else if (item.type === 'bulletin') head.appendChild(document.createTextNode(' posted a bulletin'));
      else if (item.type === 'friends') head.appendChild(document.createTextNode(' made a new friend'));
      else if (item.type === 'song') head.appendChild(document.createTextNode(' changed their profile song'));
      mid.appendChild(head);
      const txt = this.el('div', 'ms-feedtext', item.text);
      if (item.type === 'bulletin' || item.type === 'wall') {
        // the feed line is a summary: click through to the bulletin itself / the comment on the wall it landed on
        txt.classList.add('ms-feedlink');
        txt.title = item.type === 'bulletin' ? 'read it on the bulletin board' : 'see it on the wall';
        txt.addEventListener('click', () => { Sfx.click(); this.goToFeedItem(item); });
      }
      mid.appendChild(txt);
      const g = item.from !== 'you' ? this.decoFor(item.text, item.from) : null;
      if (g) { const im = this.el('img', 'ms-glitter'); im.src = g; im.alt = ''; mid.appendChild(im); }
      mid.appendChild(this.el('div', 'ms-time', item.time));
      row.appendChild(mid);
      put(row);
    });
    while (at) { const gone = at; at = at.nextSibling; gone.remove(); }     // kept cards that are no longer shown
  },

  // Saved feeds (localStorage) outlive edits to posts.js. Once per session: drop posts whose media was removed from
  // MS.posts, and re-link the rest by src / ytId — the saved postIdx is only a position, and positions shift.
  pruneOrphanPosts() {
    if (this.postsChecked || !this.posts || !this.posts.length) return;     // posts.js not loaded: touch nothing
    this.postsChecked = true;
    const st = this.state, idxOf = {};
    this.posts.forEach((p, i) => [p.ytId || p.src].concat(p.was || []).forEach(k => { idxOf[k] = i; }));
    const seen = new Set();
    st.feed = st.feed.slice().reverse().filter(f => {
      if (f.type !== 'post' || typeof f.postIdx !== 'number') return true;   // statuses, walls, storyline photos (no postIdx)
      const i = idxOf[f.ytId || f.src];
      if (i === undefined || seen.has(i)) return false;                    // source is gone, or an older duplicate
      seen.add(i);
      f.postIdx = i;
      if (this.posts[i].src) f.src = this.posts[i].src;                    // follow re-encodes (`was`)
      return true;
    }).reverse();
    // postedIdx (what migrate/dripPost have used up) is positional too: when posts.js changed, re-derive it
    let h = 0;
    this.posts.forEach(p => { for (const c of (p.ytId || p.src || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    const sig = this.posts.length + ':' + h;
    if (st.postsSig !== sig) { st.postsSig = sig; st.postedIdx = [...seen]; }
    this.save();
  },

  // the posts.js entry behind a feed item — matched by ytId / src, never by the saved postIdx
  postSource(item) {
    return (this.posts || []).find(p => item.ytId ? p.ytId === item.ytId
      : !!item.src && (p.src === item.src || (p.was || []).includes(item.src))) || null;
  },

  // a photo/gif whose file is gone gets the hotlink placeholder everybody's page had in 2006
  mediaGone(src) {
    const box = this.el('div', 'ms-gone');
    box.appendChild(this.el('span', 'ms-gone-x', '✕'));
    const txt = this.el('span');
    txt.append(this.el('b', null, 'This image has been moved or deleted.'), this.el('br'),
      this.el('i', null, (String(src || 'picture').split('/').pop()) + ' — hosted on ourbucket'));
    box.appendChild(txt);
    return box;
  },

  /* ---------- media posts ---------- */
  renderPost(item) {
    // a post whose video is running keeps its card (and player) across feed re-renders
    const live = this.players.get(item);
    if (live) { live.refresh(); return live.card; }
    const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
    const p = this.people[item.from];
    const card = this.el('div', 'ms-post');
    const host = { card, refresh() {} };

    const head = this.el('div', 'ms-post-head');
    head.appendChild(this.avatarEl(item.from, 34));
    const nm = this.el('b', 'ms-feedname', item.from === 'you' ? this.myName() : p ? p.name : item.from);
    nm.addEventListener('click', () => (item.from === 'you' ? this.show('home') : this.show('profile', item.from)));
    head.appendChild(nm);
    head.appendChild(this.el('span', 'ms-kind', { photo: '📷 posted a photo', gif: '✨ posted a gif', video: '📼 uploaded a video', yt: '📺 posted a video' }[item.kind] || 'posted'));
    head.appendChild(this.el('span', 'ms-time', item.time));
    card.appendChild(head);

    card.appendChild(this.el('div', 'ms-post-caption', item.caption));

    const media = this.el('div', 'ms-post-media');
    if (item.kind === 'yt') media.appendChild(this.ytPlayer(item, host));
    else if (item.kind === 'video') media.appendChild(this.ourtube(item, host));
    else {
      const img = this.el('img', item.kind === 'gif' ? 'gif' : '');
      img.addEventListener('error', () => media.replaceChildren(this.mediaGone(item.src)));
      img.src = item.src || ''; img.alt = ''; img.loading = 'lazy';                 // '' → error → placeholder, no request
      if (window.ImageViewer) ImageViewer.attach(img, String(item.src).split('/').pop());   // click → Win98 picture viewer
      media.appendChild(img);
    }
    card.appendChild(media);
    if (item.credit) card.appendChild(this.el('div', 'ms-post-credit', '📷 ' + item.credit));

    const act = this.el('div', 'ms-post-actions');
    const kudos = this.el('button', 'btn98' + (item.liked ? ' liked' : ''), `♥ kudos (${item.kudos || 0})`);
    kudos.addEventListener('click', () => {
      item.liked = !item.liked;
      item.kudos = (item.kudos || 0) + (item.liked ? 1 : -1);
      kudos.textContent = `♥ kudos (${item.kudos})`;
      kudos.classList.toggle('liked', item.liked);
      Sfx.beep(item.liked ? 1200 : 600, .05, 'sine', .04);
      this.save();
    });
    const cBtn = this.el('button', 'btn98', `💬 comments (${(item.comments || []).length})`);
    const rp = this.el('button', 'btn98', item.reposted ? '✔ reposted' : '↻ repost');
    rp.addEventListener('click', () => {
      if (item.reposted) return;
      item.reposted = true;
      rp.textContent = '✔ reposted';
      this.state.myWall.push({ from: 'you', text: `reposted ${p ? p.name : item.from}'s ${item.kind}: "${this.cut(item.caption, 70)}…"`, time: this.now() });
      this.toast('reposted to your page');
      Sfx.click();
      this.save();
    });
    act.append(kudos, cBtn, rp);
    card.appendChild(act);

    const cbox = this.el('div', 'ms-post-comments');
    cbox.hidden = !item.commentsOpen;
    const paintComments = () => {
      cbox.innerHTML = '';
      (item.comments || []).forEach(c => {
        const row = this.el('div', 'ms-post-comment');
        row.appendChild(this.avatarEl(c.from === 'you' ? null : c.from, 24));
        const mid = this.el('div');
        const b = this.el('b', null, c.from === 'you' ? this.myName() : (this.people[c.from] ? this.people[c.from].name : c.from));
        if (c.from !== 'you') b.addEventListener('click', () => this.show('profile', c.from));
        mid.append(b, this.el('span', null, ' ' + c.text));
        row.appendChild(mid);
        cbox.appendChild(row);
      });
      const form = this.el('div', 'ms-commentform');
      const inp = this.el('input');
      inp.placeholder = 'add a comment…'; inp.maxLength = 160;
      const send = this.el('button', 'btn98', 'Post');
      const submit = () => {
        const text = Guestbook.filter(inp.value.trim());
        if (!text) return;
        item.comments = item.comments || [];
        item.comments.push({ from: 'you', text });
        cBtn.textContent = `💬 comments (${item.comments.length})`;
        Sfx.click(); this.save(); paintComments();
        const bots = Object.keys(this.people).filter(id => !this.people[id].owner);   // malten doesn't auto-reply
        const replier = (Math.random() < 0.65 && this.people[item.from] && !this.people[item.from].owner) ? item.from : rnd(bots);
        setTimeout(() => {
          item.comments.push({ from: replier, text: this.botReply(replier, text) });
          cBtn.textContent = `💬 comments (${item.comments.length})`;
          this.save();
          if (cbox.isConnected) paintComments();
          else this.toast(this.people[replier].name + ' replied to your comment!', 'feed');
        }, 3000 + Math.random() * 6000);
      };
      send.addEventListener('click', submit);
      inp.addEventListener('keypress', e => { if (e.key === 'Enter') submit(); });
      form.append(inp, send);
      cbox.appendChild(form);
    };
    paintComments();
    host.refresh = () => {                                                  // a kept card only needs new comments painted in
      const n = (item.comments || []).length;
      if (n === cbox.querySelectorAll('.ms-post-comment').length) return;
      cBtn.textContent = `💬 comments (${n})`;
      paintComments();
    };
    cBtn.addEventListener('click', () => { item.commentsOpen = !item.commentsOpen; cbox.hidden = !item.commentsOpen; Sfx.click(); });
    card.appendChild(cbox);
    return card;
  },

  /* ---------- players: plumbing shared by ytPlayer + ourtube ---------- */
  // Started players: feed item -> { card, refresh(), pause(), stop() }. While a post is in here renderPost returns
  // its existing card instead of building a new one, so a feed re-render (every ambient tick) can't kill the video.
  players: new Map(),

  watchPlayers(root) {
    if (this.playerRoot === root) return;
    this.playerRoot = root;
    if (this.playerWatch) this.playerWatch.disconnect();
    else document.addEventListener('app-close', e => { if (e.detail === 'myspace') this.players.forEach(p => p.pause()); });
    // a card that is still detached once a render has finished: the user left the feed, or filtered the post out
    this.playerWatch = new MutationObserver(() => this.players.forEach((p, item) => {
      if (!p.card.isConnected) { p.stop(); this.players.delete(item); }
    }));
    this.playerWatch.observe(root, { childList: true, subtree: true });
  },

  // a player started playing: keep its card (handle) and pause every other player — one soundtrack at a time
  playerOn(item, handle) {
    this.players.forEach((p, it) => { if (it !== item) p.pause(); });
    if (handle) this.players.set(item, handle);
  },

  // One volume for every player, remembered across reloads (localStorage `ourspace_volume`).
  // level = 1-100 (the last audible level), muted = silenced without forgetting it. Pass an object to change it.
  playerVolume(set) {
    if (!this.vol) {
      this.vol = { level: 70, muted: false };
      try {
        const s = JSON.parse(localStorage.getItem('ourspace_volume'));
        if (s && s.level >= 1 && s.level <= 100) this.vol = { level: Math.round(s.level), muted: !!s.muted };
      } catch { /* nothing saved yet */ }
    }
    if (set) {
      Object.assign(this.vol, set);
      try { localStorage.setItem('ourspace_volume', JSON.stringify(this.vol)); } catch { /* storage blocked */ }
      document.querySelectorAll('.yt06-bar').forEach(b => { if (b.syncVolume) b.syncVolume(this.vol); });
    }
    return this.vol;
  },

  // The control bar both players use: play · seek · time · mute + volume · fullscreen.
  // `on` = { toggle(), seek(fraction), full(), volume({ level, muted }) } supplied by the player.
  playerBar(on) {
    const bar = this.el('div', 'yt06-bar');
    bar.innerHTML = '<button class="yt06-btn" data-act="play" title="Play / pause">▶</button><div class="yt06-track"><div class="yt06-fill"></div></div><span class="yt06-time">0:00 / 0:00</span><button class="yt06-btn" data-act="mute" title="Mute">🔊</button><span class="yt06-vol"><input type="range" min="0" max="100" step="1" aria-label="Volume" title="Volume"></span><button class="yt06-btn" data-act="full" title="Full screen">⛶</button>';
    const fill = bar.querySelector('.yt06-fill'), timeEl = bar.querySelector('.yt06-time'), playBtn = bar.querySelector('[data-act="play"]');
    const muteBtn = bar.querySelector('[data-act="mute"]'), range = bar.querySelector('input');
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    playBtn.addEventListener('click', () => on.toggle());
    bar.querySelector('[data-act="full"]').addEventListener('click', () => on.full());
    bar.querySelector('.yt06-track').addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      on.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    });
    muteBtn.addEventListener('click', () => this.playerVolume({ muted: !this.playerVolume().muted }));
    let grabbed = null;                                    // the level when the current drag began
    range.addEventListener('input', () => {
      if (grabbed === null) grabbed = this.playerVolume().level;
      const x = +range.value;
      // dragged all the way down = mute (remembering where it came from); anything above 0 unmutes
      this.playerVolume(x > 0 ? { level: x, muted: false } : { level: grabbed, muted: true });
    });
    range.addEventListener('change', () => { grabbed = null; });
    bar.syncVolume = v => {                                // runs on every bar on the page when the shared volume changes
      const shown = v.muted ? 0 : v.level;
      range.value = shown;
      range.parentNode.style.setProperty('--v', shown + '%');
      muteBtn.textContent = shown === 0 ? '🔇' : shown < 40 ? '🔉' : '🔊';
      muteBtn.title = v.muted ? 'Unmute' : 'Mute';
      on.volume(v);
    };
    bar.syncVolume(this.playerVolume());
    return {
      bar,
      setPlaying(p) { playBtn.textContent = p ? '❚❚' : '▶'; },
      setTime(t, dur) {
        const d = isFinite(dur) && dur > 0 ? dur : 0;
        fill.style.width = (d ? Math.min(100, t / d * 100) : 0) + '%';
        timeEl.textContent = `${fmt(t || 0)} / ${fmt(d)}`;
      },
    };
  },

  // In-character failure card for a player screen — never a black box. `link` = [text, href or onclick] (optional).
  // `links`: one [text, hrefOrFn] pair or an array of them
  playerDead(wrap, screen, msg, note, links) {
    wrap.classList.add('dead');
    wrap.querySelectorAll('.yt06-bar button, .yt06-bar input').forEach(b => { b.disabled = true; });
    const box = this.el('div', 'yt06-dead');
    box.append(this.el('div', 'yt06-dead-icon', '⚠'), this.el('b', null, msg), this.el('span', null, note));
    const list = links && typeof links[0] === 'string' ? [links] : (links || []);
    list.forEach(link => {
      const a = this.el('a', null, link[0]);
      if (typeof link[1] === 'function') { a.href = '#'; a.addEventListener('click', e => { e.preventDefault(); link[1](); }); }
      else { a.href = link[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      box.appendChild(a);
    });
    screen.replaceChildren(box);
  },

  // YouTube, but it's 2006: gray chrome, click-to-load poster, fake control bar driven by the iframe API
  ytPlayer(item, host) {
    const wrap = this.el('div', 'yt06');
    const head = this.el('div', 'yt06-head');
    head.innerHTML = '<span class="yt06-logo">You<b>Tube</b></span><span class="yt06-tag">Broadcast Yourself™</span>';
    wrap.appendChild(head);
    wrap.appendChild(this.el('div', 'yt06-title', item.title || this.t(item.caption || '').slice(0, 70)));

    const screen = this.el('div', 'yt06-screen');
    const poster = this.el('img', 'yt06-poster');
    const play = this.el('div', 'yt06-play', '▶');
    screen.append(poster, play);
    wrap.appendChild(screen);

    let iframe = null, playing = false, dur = 0, cur = 0, ready = false, sent = 0, dead = false, abort = false, watchdog = 0;
    const onYouTube = ['watch it on youtube.com instead', 'https://www.youtube.com/watch?v=' + item.ytId];
    const cmd = (func, args) => { if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*'); };
    const ui = this.playerBar({
      toggle: () => {
        if (!iframe) return start();
        if (playing) { cmd('pauseVideo'); playing = false; ui.setPlaying(false); } else resume();
      },
      seek: f => { if (iframe && dur) cmd('seekTo', [dur * f, true]); },
      full: () => { if (iframe && iframe.requestFullscreen) Promise.resolve(iframe.requestFullscreen()).catch(() => {}); },
      volume: v => { if (!ready) return; sent = Date.now(); cmd(v.muted ? 'mute' : 'unMute'); cmd('setVolume', [v.level]); },
    });
    wrap.appendChild(ui.bar);

    const rating = Math.max(1, Math.min(5, item.rating || 4));
    const meta = this.el('div', 'yt06-meta');
    const who = this.people[item.from] ? this.people[item.from].name : item.from;
    meta.innerHTML = `<span>Added: <b>${item.added || 'June 12, 2006'}</b></span><span>From: <b>${who}</b></span><span>Views: <b>${(item.views || 0).toLocaleString()}</b></span><span class="yt06-stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
    wrap.appendChild(meta);
    wrap.appendChild(this.el('div', 'yt06-links', 'Share  |  Favorite  |  Add to Playlists  |  Flag'));

    const origin = /^https?:/.test(location.origin) ? `&origin=${encodeURIComponent(location.origin)}` : '';
    const frameUrl = () => `https://www.youtube-nocookie.com/embed/${item.ytId}?autoplay=1&controls=0&rel=0&modestbranding=1&enablejsapi=1&playsinline=1&iv_load_policy=3${origin}`
      + (cur > 1 ? `&start=${Math.floor(cur)}` : '') + (this.playerVolume().muted ? '&mute=1' : '');
    const fail = (msg, note, link) => {
      dead = true; playing = false; iframe = null;
      clearTimeout(watchdog);
      window.removeEventListener('message', onMsg);
      ui.setPlaying(false);
      this.playerDead(wrap, screen, msg, note, link || onYouTube);
    };
    // nothing at all from the frame for 15s = offline, or the embed is blocked: say so instead of showing a void
    const retry = ['try again', () => wrap.replaceWith(this.ytPlayer(item, host))];
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => fail('Could not connect to YouTube.', 'The tubes are clogged. Check your dial-up connection.', [retry, onYouTube]), 15000);
    };
    const onMsg = ev => {
      if (!iframe || ev.source !== iframe.contentWindow) return;
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      clearTimeout(watchdog);
      if (d.event === 'onError') {
        // 101/150 is YouTube's catch-all "not here": the uploader turned embedding off — OR YouTube suspects
        // the viewer is a robot and wants a sign-in first, which clears on its own after a while. 153 means the
        // page sent no Referer (opened from the file system instead of a web address), which YouTube now rejects.
        return d.info === 100 ? fail('This video has been removed by the user.', 'Sorry about that.')
          : (d.info === 101 || d.info === 150) ? fail('YouTube won\'t play this one here right now.',
              'Either the uploader turned embedding off, or YouTube wants to be sure you\'re not a robot (that passes on its own after a while).', [retry, onYouTube])
          : d.info === 153 ? fail('YouTube needs this page served from a web address.',
              'Open the site through http:// (not as a file on disk) and the videos come back.', onYouTube)
          : fail('This video is currently unavailable.', 'YouTube error ' + d.info + '. Please try again in 2007.', [retry, onYouTube]);
      }
      if (!ready) { ready = true; ui.bar.syncVolume(this.playerVolume()); }   // first sign of life: push our volume in
      const info = d.info;
      if (!info || typeof info !== 'object') return;
      if (info.duration) dur = info.duration;
      if (typeof info.currentTime === 'number') { cur = info.currentTime; ui.setTime(cur, dur); }
      if (typeof info.playerState === 'number') {            // 1 playing · 3 buffering · 2 paused · 0 ended
        const st = info.playerState;
        if (st === 1 || st === 3) { if (!playing) { playing = true; ui.setPlaying(true); this.playerOn(item, live); } }
        else if (st === 2 || st === 0) { playing = false; ui.setPlaying(false); if (st === 0) cur = 0; }
      }
      // volume changed from inside the frame (its keyboard shortcuts) — but not the echo of what we just sent
      if ((typeof info.volume === 'number' || typeof info.muted === 'boolean') && Date.now() - sent > 1500) {
        const v = this.playerVolume();
        const level = typeof info.volume === 'number' ? Math.round(info.volume) : v.level;
        const muted = typeof info.muted === 'boolean' ? info.muted : v.muted;
        if (level !== v.level || muted !== v.muted) this.playerVolume(level > 0 ? { level, muted } : { muted: true });
      }
    };
    const resume = () => { cmd('playVideo'); playing = true; ui.setPlaying(true); this.playerOn(item, live); };
    const start = () => {
      if (dead || play.classList.contains('buffering')) return;
      if (iframe) return resume();
      play.classList.add('buffering');
      play.textContent = 'buffering…';
      playing = true; ui.setPlaying(true);
      this.playerOn(item, live);                             // from here on the card survives re-renders
      setTimeout(() => {
        play.classList.remove('buffering');
        play.textContent = '▶';
        if (dead || abort) { abort = false; playing = false; ui.setPlaying(false); return; }   // paused / left while "buffering"
        iframe = this.el('iframe');
        iframe.allow = 'autoplay; encrypted-media; fullscreen';
        iframe.allowFullscreen = true;
        iframe.addEventListener('load', () => {
          if (!iframe) return;
          try {
            iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: item.ytId }), '*');
            cmd('addEventListener', ['onError']);
          } catch { /* cross-origin quirk */ }
        });
        iframe.src = frameUrl();
        window.addEventListener('message', onMsg);
        screen.replaceChildren(iframe);
        arm();
        item.views = (item.views || 0) + 1;
        this.save();
      }, 1200);
    };
    const drop = () => {                                     // back to the poster, remembering the position
      clearTimeout(watchdog);
      window.removeEventListener('message', onMsg);
      iframe = null; ready = false; playing = false;
      ui.setPlaying(false);
      if (!dead) screen.replaceChildren(...(screen.classList.contains('noposter') ? [play] : [poster, play]));
    };
    const live = host && {
      card: host.card,
      pause: () => {
        if (!playing) return;
        if (iframe) cmd('pauseVideo'); else abort = true;       // no frame yet = still "buffering": call it off
        playing = false; ui.setPlaying(false);
      },
      stop: () => { abort = true; drop(); },
      refresh: () => {
        // the card was detached by a feed re-render and is about to go back in. A detached iframe starts over, so
        // reload it at the position it had reached (or, if it was paused, fall back to the poster at that position).
        if (iframe && !host.card.isConnected) {
          if (playing) { ready = false; iframe.src = frameUrl(); arm(); } else drop();
        }
        host.refresh();
      },
    };

    play.addEventListener('click', start);
    poster.addEventListener('click', start);
    poster.addEventListener('error', () => { poster.remove(); screen.classList.add('noposter'); });
    // a deleted / private video still "loads" a thumbnail: YouTube's 120x90 gray placeholder
    poster.addEventListener('load', () => {
      if (poster.naturalWidth === 120 && poster.naturalHeight === 90 && !iframe) fail('This video has been removed by the user.', 'Sorry about that.');
    });
    poster.alt = '';
    poster.src = `https://i.ytimg.com/vi/${item.ytId}/hqdefault.jpg`;
    return wrap;
  },

  // OurTube: the same 2006 player for local video files. A fixed 4:3 screen with the clip letterboxed inside it
  // (whatever its real size), a poster frame before play, the shared control bar, and a "removed" card instead of
  // a black box when the file is missing or the browser can't decode it.
  ourtube(item, host) {
    const wrap = this.el('div', 'ourtube');
    const screen = this.el('div', 'ot-screen');
    const v = this.el('video');
    const meta = this.postSource(item);
    v.preload = 'metadata'; v.playsInline = true;
    if (meta && meta.poster) v.poster = meta.poster;
    const ov = this.el('div', 'ot-overlay');
    ov.appendChild(this.el('div', 'ot-play', '▶'));
    const buf = this.el('div', 'ot-buffer', '');
    ov.appendChild(buf);
    screen.append(v, ov);

    let started = false, want = false, dead = false;        // want = the user means it to be playing
    const ui = this.playerBar({
      toggle: () => {
        if (!started) return start();
        if (ov.isConnected) { want = !want; ui.setPlaying(want); }           // still "buffering"
        else if (v.paused) v.play().catch(() => {});
        else v.pause();
      },
      seek: f => { if (started && isFinite(v.duration)) v.currentTime = v.duration * f; },
      full: () => { if (started && v.requestFullscreen) Promise.resolve(v.requestFullscreen()).catch(() => {}); },
      volume: vol => { v.volume = vol.level / 100; v.muted = vol.muted; },
    });
    const views = this.el('span', null, `${(item.views || 0).toLocaleString()} views`);
    const foot = this.el('div', 'ot-bar');
    foot.innerHTML = '<span><b>OurTube</b> · 240p · buffering optional</span>';
    foot.appendChild(views);
    wrap.append(screen, ui.bar, foot);

    const fail = () => {
      if (dead) return;
      dead = true; want = false;
      v.pause();
      this.playerDead(wrap, screen, 'This video has been removed by the user.', 'OurTube error 404: tape not found. It may have been taped over.');
    };
    const live = host && {
      card: host.card,
      pause: () => { want = false; v.pause(); },
      stop: () => { want = false; v.pause(); },
      refresh: () => {
        // re-attached in the same tick as it was detached, a <video> keeps playing; if a browser paused it, carry on
        if (want && !host.card.isConnected) Promise.resolve().then(() => { if (want && v.isConnected && v.paused) v.play().catch(() => {}); });
        host.refresh();
      },
    };
    const start = () => {
      if (started || dead) return;
      started = true; want = true;
      ui.setPlaying(true);
      this.playerOn(item, live);
      let pct = 0;
      const t = setInterval(() => { pct = Math.min(99, pct + 7 + Math.floor(Math.random() * 12)); buf.textContent = `buffering… ${pct}%`; }, 180);
      setTimeout(() => {                                     // authentic 2006 wait
        clearInterval(t);
        if (dead) return;
        ov.remove();
        if (want) v.play().catch(() => {}); else ui.setPlaying(false);
        item.views = (item.views || 0) + 1;
        views.textContent = `${item.views.toLocaleString()} views`;
        this.save();
      }, 1500);
    };
    ov.addEventListener('click', start);
    v.addEventListener('click', () => {
      if (!started || ov.isConnected || v.controls) return;          // native controls (fullscreen) do their own toggling
      if (v.paused) v.play().catch(() => {}); else v.pause();
    });
    v.addEventListener('play', () => { want = true; ui.setPlaying(true); this.playerOn(item, live); });
    v.addEventListener('pause', () => { if (v.isConnected) want = false; ui.setPlaying(false); });
    v.addEventListener('ended', () => { want = false; ui.setPlaying(false); });
    v.addEventListener('timeupdate', () => ui.setTime(v.currentTime, v.duration));
    v.addEventListener('loadedmetadata', () => { if (v.videoWidth) ui.setTime(0, v.duration); else fail(); });   // sound but no picture = codec gone
    v.addEventListener('error', fail);
    v.addEventListener('fullscreenchange', () => { v.controls = document.fullscreenElement === v; });
    v.addEventListener('volumechange', () => {              // changed with the native controls (fullscreen): follow it
      const vol = this.playerVolume(), level = Math.round(v.volume * 100);
      if (level !== vol.level || v.muted !== vol.muted) this.playerVolume(level > 0 ? { level, muted: v.muted } : { muted: true });
    });
    if (item.src) v.src = item.src; else fail();
    return wrap;
  },

  /* ---------- sidebar (buddy list, horoscope, cool new people) ---------- */
  paintSidebar() {
    const b = document.getElementById('ms-side-buddies');
    const h = document.getElementById('ms-side-horo');
    const n = document.getElementById('ms-side-new');
    if (b && window.BuddyList) BuddyList.build(b);
    if (h && window.Horoscope) Horoscope.build(h);
    if (n) {
      n.innerHTML = '';
      const ids = Object.keys(this.people).slice(-13).reverse().slice(0, 6);
      ids.forEach(id => {
        const row = this.el('div', 'ms-newrow');
        row.appendChild(this.avatarEl(id, 30));
        const b2 = this.el('b', null, this.people[id].name);
        b2.addEventListener('click', () => this.show('profile', id));
        row.appendChild(b2);
        n.appendChild(row);
      });
    }
  },

  /* ---------- browse ---------- */
  renderBrowse(root) {
    root.appendChild(this.el('div', 'ms-pagetitle', 'Browse the residents of OurSpace'));

    const ids = Object.keys(this.people);
    const inFilter = {
      all: () => true,
      friends: id => this.state.friends.includes(id),
      pending: id => this.state.pending.includes(id),
      fresh: id => !!this.people[id].isNew,
    };
    const chipDefs = [['all', 'everyone'], ['friends', 'my friends'], ['pending', 'requests']];
    if (ids.some(inFilter.fresh)) chipDefs.push(['fresh', '✨ new here']);
    if (!inFilter[this.browseFilter] || !chipDefs.some(c => c[0] === this.browseFilter)) this.browseFilter = 'all';

    const bar = this.el('div', 'ms-filterbar');
    chipDefs.forEach(([key, label]) => {
      const b = this.el('button', 'btn98' + (this.browseFilter === key ? ' on' : ''), `${label} (${ids.filter(inFilter[key]).length})`);
      b.addEventListener('click', () => {
        this.browseFilter = key;
        bar.querySelectorAll('.btn98').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        this.shown.browse = 0;
        paint();
        Sfx.click();
      });
      bar.appendChild(b);
    });
    const search = this.el('input');
    search.placeholder = '🔎 find someone…';
    search.value = this.browseQuery;
    search.addEventListener('input', () => { this.browseQuery = search.value; this.shown.browse = 0; paint(); });
    bar.appendChild(search);
    root.appendChild(bar);

    const grid = this.el('div', 'ms-browsegrid');
    root.appendChild(grid);
    this.shown = this.shown || {};

    const paint = () => {
      grid.innerHTML = '';
      root.querySelectorAll('.ms-more').forEach(b => b.remove());
      const q = this.browseQuery.trim().toLowerCase();
      const match = ids.filter(id => {
        const p = this.people[id];
        if (!inFilter[this.browseFilter](id)) return false;
        return !q || [id, p.name, p.tag, p.about, p.hometown].join(' ').toLowerCase().includes(q);
      });
      // ~92 residents: two dozen cards at a time, "show more" for the rest
      this.paged(grid, 'browse', match, 24, id => {
        const p = this.people[id];
        const card = this.el('div', 'ms-browsecard' + (p.isNew ? ' is-new' : ''));
        if (p.isNew) card.appendChild(this.el('span', 'ms-newtag', 'NEW!'));
        card.appendChild(this.avatarEl(id, 62));
        card.appendChild(this.el('b', null, p.name));
        card.appendChild(this.el('div', 'ms-tagline', p.tag || ''));
        card.appendChild(this.el('div', 'ms-time', 'mood: ' + (p.mood || '—')));
        const st = this.state.friends.includes(id) ? '✔ friend'
          : this.state.pending.includes(id) ? '⏳ wants to be friends'
          : this.state.denied.includes(id) ? '✖ denied (harsh)' : '';
        if (st) card.appendChild(this.el('div', 'ms-time', st));
        const btn = this.el('button', 'btn98', 'View Profile');
        btn.addEventListener('click', () => this.show('profile', id));
        card.appendChild(btn);
        return card;
      });
      if (!match.length) grid.appendChild(this.el('p', 'ms-empty', 'nobody matches. they might be hiding.'));
    };
    paint();
  },

  /* ---------- requests ---------- */
  renderRequests(root) {
    root.appendChild(this.el('div', 'ms-pagetitle', 'Friend Requests'));
    // newest first; residents whose content isn't loaded right now are skipped (they stay pending)
    const pending = this.state.pending.filter(id => this.people[id]).reverse();
    if (!pending.length) {
      root.appendChild(this.el('p', 'ms-empty', 'no pending requests. everyone who wants you already has you.'));
      return;
    }
    const list = this.el('div');
    root.appendChild(list);
    this.paged(list, 'requests', pending, 8, id => {
      const p = this.people[id];
      const row = this.el('div', 'ms-reqrow');
      row.appendChild(this.avatarEl(id, 52));
      const mid = this.el('div', 'ms-reqmid');
      mid.appendChild(this.el('b', null, p.name));
      mid.appendChild(this.el('div', 'ms-tagline', p.tag));
      mid.appendChild(this.el('div', null, 'wants to be your friend!'));
      row.appendChild(mid);
      const ok = this.el('button', 'btn98', '✔ Approve');
      ok.addEventListener('click', () => {
        this.state.pending = this.state.pending.filter(x => x !== id);
        this.state.friends.push(id);
        this.toast(p.name + ' is now your friend!');
        Sfx.tada();
        this.scheduleThanks(id);
        this.render();
      });
      const no = this.el('button', 'btn98', '✖ Deny');
      no.addEventListener('click', () => {
        this.state.pending = this.state.pending.filter(x => x !== id);
        this.state.denied.push(id);
        Sfx.close();
        this.render();
        setTimeout(() => {
          this.deliverDm(id, p.saltyDm, { unprompted: true, toast: 'New message from ' + p.name + '…' });
        }, 6000 + Math.random() * 5000);
      });
      row.append(ok, no);
      return row;
    });
  },

  /* ---------- inbox ---------- */
  renderInbox(root, openId) {
    if (openId === '__spam') return this.renderSpam(root);
    if (openId) return this.renderThread(root, openId);
    root.appendChild(this.el('div', 'ms-pagetitle', 'Inbox'));

    const spamN = (this.state.spam || []).filter(s => !s.read).length;
    const tabs = this.el('div', 'ms-filterbar');
    const mBtn = this.el('button', 'btn98 on', '✉ Messages');
    const sBtn = this.el('button', 'btn98', '🗑 Spam' + (spamN ? ` (${spamN})` : ''));
    sBtn.addEventListener('click', () => this.show('inbox', '__spam'));
    tabs.append(mBtn, sBtn);
    root.appendChild(tabs);

    // conversations waiting on the visitor first, then unread, then most recent activity (threads from before the
    // v2 engine have no activity stamp and keep their old order underneath)
    const waiting = new Set(this.activeTreeIds().map(tid => this.trees[tid].with));
    const rank = id => (waiting.has(id) ? 2 : 0) + (this.state.inbox[id].unread ? 1 : 0);
    const ids = Object.keys(this.state.inbox)
      .filter(id => this.people[id] && this.state.inbox[id] && (this.state.inbox[id].msgs || []).length)
      .map((id, i) => ({ id, i }))
      .sort((a, b) => rank(b.id) - rank(a.id) || (this.state.inbox[b.id].at || 0) - (this.state.inbox[a.id].at || 0) || a.i - b.i)
      .map(x => x.id);
    if (!ids.length) { root.appendChild(this.el('p', 'ms-empty', 'no mail. suspicious.')); return; }
    const list = this.el('div');
    root.appendChild(list);
    this.paged(list, 'inbox', ids, 20, id => {
      const t = this.state.inbox[id];
      const p = this.people[id];
      const row = this.el('div', 'ms-reqrow ms-clickable');
      if (t.unread) row.classList.add('unread');
      row.appendChild(this.avatarEl(id, 44));
      const mid = this.el('div', 'ms-reqmid');
      mid.appendChild(this.el('b', null, p.name + (t.unread ? '  ● NEW' : '')));
      const last = t.msgs[t.msgs.length - 1];
      const lastText = this.t(String(last.text || ''));    // name swapped in BEFORE cutting, so no half tokens
      mid.appendChild(this.el('div', 'ms-tagline', (last.who === 'you' ? 'you: ' : '') + lastText.slice(0, 60) + (lastText.length > 60 ? '…' : '')));
      if (waiting.has(id)) {
        mid.appendChild(this.el('div', 'ms-waiting', this.convo[id] ? '✎ ' + p.name + ' is typing…' : '✉ waiting for your reply'));
      }
      mid.appendChild(this.el('div', 'ms-time', last.time));
      row.appendChild(mid);
      row.addEventListener('click', () => this.show('inbox', id));
      return row;
    });
  },

  renderSpam(root) {
    const head = this.el('div', 'ms-pagetitle');
    const back = this.el('button', 'btn98', '← Inbox');
    back.addEventListener('click', () => this.show('inbox'));
    head.appendChild(back);
    head.appendChild(document.createTextNode('  Spam Folder — the FW: FW: FW: economy'));
    root.appendChild(head);
    const spam = this.state.spam || [];
    if (!spam.length) { root.appendChild(this.el('p', 'ms-empty', 'no spam. this is somehow more concerning.')); return; }
    spam.slice().reverse().forEach(s => {
      const p = this.people[s.from];
      const card = this.el('div', 'ms-bulletin');
      const h = this.el('div', 'ms-comment-head');
      h.appendChild(this.avatarEl(s.from, 34));
      h.appendChild(this.el('b', null, (p ? p.name : s.from) + (s.read ? '' : '  ● NEW')));
      h.appendChild(this.el('span', 'ms-time', s.time));
      card.appendChild(h);
      card.appendChild(this.el('div', 'ms-bulletin-subj', s.subject));
      const body = this.el('div', 'ms-comment-body');
      const foot = this.el('div', 'ms-bulletin-foot');
      if (s.read) {
        body.textContent = this.t(s.body);
        const fwd = this.el('button', 'btn98', s.forwarded ? '✔ forwarded (curse lifted)' : '↪ forward to 10 friends');
        if (!s.forwarded) fwd.addEventListener('click', () => {
          s.forwarded = true;
          this.save();
          this.toast('you forwarded it to all ' + this.state.friends.length + ' of your friends. the curse is lifted. probably.');
          this.pushFeed({ type: 'status', from: 'you', text: 'forwarded a chain letter. not taking any chances.', time: this.now() });
          Sfx.tada();
          this.render();
        });
        foot.appendChild(fwd);
      } else {
        body.textContent = this.t(s.body).slice(0, 60) + '… ';
        const open = this.el('button', 'btn98', '📖 open (bravely)');
        open.addEventListener('click', () => { s.read = true; this.save(); Sfx.click(); this.render(); });
        foot.appendChild(open);
      }
      card.appendChild(body);
      card.appendChild(foot);
      root.appendChild(card);
    });
  },

  renderThread(root, id) {
    const p = this.people[id];
    if (!p) {
      // a resident whose content isn't loaded (pack file missing or failed validation)
      const head = this.el('div', 'ms-pagetitle');
      const back = this.el('button', 'btn98', '← Inbox');
      back.addEventListener('click', () => this.show('inbox'));
      head.appendChild(back);
      root.appendChild(head);
      root.appendChild(this.el('p', 'ms-empty', 'this resident has wandered off. maybe they\'ll be back.'));
      return;
    }
    if (p.owner && !(this.state.inbox[id] && this.state.inbox[id].msgs.length)) {
      // malten is a real person: no inbox bot. Point at the guestbook instead of a thread nobody answers.
      const head = this.el('div', 'ms-pagetitle');
      const back = this.el('button', 'btn98', '← Inbox');
      back.addEventListener('click', () => this.show('inbox'));
      head.append(back, document.createTextNode('  message ' + p.name));
      root.appendChild(head);
      const card = this.el('div', 'ms-section ms-ownernote');
      card.appendChild(this.el('div', 'ms-boxtitle', '✉ malten doesn\'t really do DMs'));
      card.appendChild(this.el('p', null, 'he\'s the actual human who built this desktop, so there\'s no bot on the other end of his inbox. the guestbook is where he reads (every entry, twice) and answers.'));
      const gb = this.el('button', 'btn98', '📖 sign the guestbook');
      gb.addEventListener('click', () => this.show('guestbook'));
      const pg = this.el('button', 'btn98', '★ visit his page');
      pg.addEventListener('click', () => this.show('profile', id));
      card.append(gb, document.createTextNode(' '), pg);
      root.appendChild(card);
      return;
    }
    const t = this.state.inbox[id] = this.state.inbox[id] || { unread: false, msgs: [] };
    t.unread = false;

    const head = this.el('div', 'ms-pagetitle');
    const back = this.el('button', 'btn98', '← Inbox');
    back.addEventListener('click', () => this.show('inbox'));
    head.appendChild(back);
    head.appendChild(document.createTextNode('  conversation with ' + p.name));
    if (window.Nudge) {
      const nb = this.el('button', 'btn98', '👋 nudge');
      nb.style.marginLeft = 'auto';
      nb.addEventListener('click', () => Nudge.sendTo(id));
      head.appendChild(nb);
    }
    root.appendChild(head);

    const box = this.el('div', 'ms-thread');
    t.msgs.forEach(m => {
      // a later conversation in the same thread starts under a dated divider
      if (m.sep) box.appendChild(this.el('div', 'ms-thread-sep', m.time ? '— ' + m.time + ' —' : '— later —'));
      const b = this.el('div', 'ms-dm ' + (m.who === 'you' ? 'me' : 'them'));
      b.appendChild(this.el('b', null, m.who === 'you' ? this.myName() : p.name));
      b.appendChild(this.el('div', null, m.text));
      b.appendChild(this.el('div', 'ms-time', m.time));
      box.appendChild(b);
    });
    root.appendChild(box);
    const live = this.convo[id];                      // an exchange is playing out in this thread right now
    if (live && live.them) this.paintTypingInd(id);
    box.scrollTop = box.scrollHeight;

    // scripted conversation in progress? offer choices instead of free text
    const treeId = this.activeTreeFor(id);
    if (treeId) {
      const ds = this.dialogueStateFor(treeId);
      const node = this.trees[treeId].nodes[ds.node];
      if (live) {
        if (live.you != null) this.paintTyper(id);
        return;
      }
      if (ds.pend) { this.playNode(treeId); return; } // their answer was cut off by a reload: pick it back up
      if ((node.choices || []).length) {
        const ch = this.el('div', 'ms-choices');
        if (this.typingLock) {
          // one reply is typed at a time; the buttons come back the moment the other one is sent
          ch.appendChild(this.el('div', 'ms-choices-label', '— hang on, you\'re still typing to someone else… —'));
        } else {
          ch.appendChild(this.el('div', 'ms-choices-label', '— choose your reply —'));
          node.choices.forEach(c => {
            const b = this.el('button', 'btn98', c.say);
            b.addEventListener('click', () => this.chooseOption(treeId, c));
            ch.appendChild(b);
          });
        }
        root.appendChild(ch);
        return;
      }
      ds.done = true;                                 // a dead end in the content: close it out, fall through to free text
      ds.end = Date.now();
      this.save();
    }

    const form = this.el('div', 'ms-commentform');
    const inp = this.el('input');
    inp.placeholder = 'reply to ' + p.name + '…';
    inp.maxLength = 300;
    inp.value = this.drafts[id] || '';
    inp.addEventListener('input', () => { this.drafts[id] = inp.value; });
    const send = this.el('button', 'btn98', 'Send');
    const submit = () => {
      const text = inp.value.trim();
      if (!text) return;
      t.msgs.push({ who: 'you', text: Guestbook.filter(text), time: this.now() });
      t.at = Date.now();
      inp.value = '';
      delete this.drafts[id];
      Sfx.click();
      this.save();
      this.render();
      setTimeout(() => {
        if (this.activeTreeFor(id)) return;           // a scripted conversation began meanwhile: don't talk over it
        t.msgs.push({ who: 'them', text: this.botReply(id, text, t), time: this.now() });
        t.at = Date.now();
        this.save();
        if (this.view.page === 'inbox' && this.view.arg === id) this.render();
        else { t.unread = true; this.toast('New message from ' + p.name + '!', 'inbox', id); this.paintTabs(); }
      }, 4000 + Math.random() * 9000);
    };
    send.addEventListener('click', submit);
    inp.addEventListener('keypress', e => { if (e.key === 'Enter') submit(); });
    form.append(inp, send);
    root.appendChild(form);
  },

  /* ---------- bulletins ---------- */
  renderBulletins(root) {
    root.appendChild(this.el('div', 'ms-pagetitle', 'Bulletin Board'));
    const all = this.state.bulletins.map((b, idx) => ({ b, idx }));     // idx = position in state (reposted[] uses it)
    // pinned ones (malten's hello, todd's house rules) always on top; then newest first, 15 at a time
    const pinned = all.filter(x => x.b.pinned && this.people[x.b.from]);
    const rest = all.filter(x => !x.b.pinned).reverse();
    const list = this.el('div');
    root.appendChild(list);
    pinned.forEach(({ b }) => {
      const card = this.el('div', 'ms-bulletin ms-pinned');
      card.dataset.bkey = b.from + '|' + b.time;
      const head = this.el('div', 'ms-comment-head');
      head.appendChild(this.avatarEl(b.from, 34));
      head.appendChild(this.el('b', null, this.people[b.from].name));
      head.appendChild(this.el('span', 'ms-pin', '📌 pinned'));
      card.appendChild(head);
      card.appendChild(this.el('div', 'ms-bulletin-subj', '📌 ' + b.subject));
      card.appendChild(this.el('div', 'ms-comment-body', b.body));
      if (b.link && b.link.label) {
        const foot = this.el('div', 'ms-bulletin-foot');
        const go = this.el('button', 'btn98', b.link.label);
        go.addEventListener('click', () => { Sfx.click(); if (b.link.app) WM.open(b.link.app); else this.show(b.link.page, b.link.arg); });
        foot.appendChild(go);
        card.appendChild(foot);
      }
      list.appendChild(card);
    });
    this.paged(list, 'bulletins', rest, 15, ({ b, idx }) => {
      const card = this.el('div', 'ms-bulletin');
      card.dataset.bkey = b.from + '|' + b.time;
      const head = this.el('div', 'ms-comment-head');
      head.appendChild(this.avatarEl(b.from, 34));
      head.appendChild(this.el('b', null, (this.people[b.from] ? this.people[b.from].name : b.from)));
      head.appendChild(this.el('span', 'ms-time', b.time));
      card.appendChild(head);
      card.appendChild(this.el('div', 'ms-bulletin-subj', b.subject));
      card.appendChild(this.el('div', 'ms-comment-body', b.body));
      const foot = this.el('div', 'ms-bulletin-foot');
      const rp = this.el('button', 'btn98',
        this.state.reposted.includes(idx) ? '✔ reposted' : `↻ Repost (${b.reposts})`);
      if (!this.state.reposted.includes(idx)) rp.addEventListener('click', () => {
        b.reposts++;
        this.state.reposted.push(idx);
        this.toast('bulletin reposted. the glitter ghost is appeased. for now.');
        this.save();
        this.render();
      });
      foot.appendChild(rp);
      card.appendChild(foot);
      return card;
    });
  },

  // keep the bulletin board (and the save) bounded: drop the oldest unpinned ones, re-pointing the "reposted" indexes
  trimBulletins() {
    const st = this.state;
    const loose = st.bulletins.filter(b => !b.pinned).length;
    if (loose <= 160) return;
    let drop = loose - 120;
    const map = {};                                   // old index → new index
    const kept = [];
    st.bulletins.forEach((b, i) => {
      if (!b.pinned && drop > 0) { drop--; return; }
      map[i] = kept.length;
      kept.push(b);
    });
    st.bulletins = kept;
    st.reposted = st.reposted.filter(i => map[i] !== undefined).map(i => map[i]);
  },

  /* ---------------------- ambient life ---------------------- */
  startAmbient() {
    if (this.ambientTimer) return;
    this.ambientTimer = setInterval(() => {
      if (Math.random() < 0.75) this.tickEvent();
    }, 30000);
    // conversation-engine heartbeat: delayed effects + the next scripted conversation, both paced by saved timestamps
    this.pumpTimer = setInterval(() => this.pump(), 4000);
    // an answer that a page reload cut off mid-typing gets finished now
    this.activeTreeIds().forEach(tid => { if (this.dialogueStateFor(tid).pend) this.playNode(tid); });
  },

  // One simulated social event: residents talk to EACH OTHER, not just you. A weighted draw over the event kinds;
  // if the drawn kind has nothing to do right now, a banter line or a status fills in. Rough odds per tick (one
  // tick ≈ every 40s): storyline beat 22% · resident→resident wall banter 18% · status 14% · media post 9% ·
  // pic comment 7% · DM from a friend 6% · bulletin 5% · comment on YOUR wall 5% · residents friending 4% ·
  // friend request 4% · stranger's opening DM 3% · nudge the conversation scheduler 3%.
  tickEvent(depth = 0) {
    if (depth > 3) return;
    const st = this.state;
    const P = this.people;
    const ids = Object.keys(P).filter(id => !P[id].owner);   // malten is a real person: the simulation never speaks for him
    const rnd = arr => arr[Math.floor(Math.random() * arr.length)];

    // resident-to-resident wall banter (authored pair-specific lines, each used once until all are spent)
    const banter = () => {
      const fresh = a => {
        const out = [];
        const b = P[a].banter || {};
        Object.keys(b).forEach(t => {
          if (!P[t]) return;
          b[t].forEach((line, i) => { const key = `${a}>${t}:${i}`; if (!st.usedBanter[key]) out.push({ a, t, line, key }); });
        });
        return out;
      };
      // a random speaker's unused lines; only if a few speakers in a row are spent do we scan the whole cast
      let pool = [];
      for (let tries = 0; tries < 6 && !pool.length; tries++) pool = fresh(rnd(ids));
      if (!pool.length) ids.forEach(a => { pool = pool.concat(fresh(a)); });
      if (!pool.length) {
        if (!Object.keys(st.usedBanter).length) return false;
        st.usedBanter = {};                           // everything has been said once: recycle
        return false;
      }
      const pick = rnd(pool);
      st.usedBanter[pick.key] = 1;
      const when = this.now();                      // the wall entry and its feed line share a time: the feed links back by it
      this.pushWall(pick.t, { from: pick.a, text: pick.line, time: when });
      this.pushFeed({ type: 'wall', from: pick.a, to: pick.t, text: pick.line, time: when });
      if (this.view.page === 'profile' && this.view.arg === pick.t) this.render();
      return true;
    };

    // status update (the vague-post bank is the original cast's voice, so newcomers stick to their own lines)
    const status = () => {
      const inFeed = new Set(st.feed.map(f => f.from + '|' + f.text));
      const vague = this.bank('vaguePosts');
      for (let tries = 0; tries < 8; tries++) {
        const id = rnd(ids);
        const own = (P[id].statuses || []).filter(s => !inFeed.has(id + '|' + s));
        const text = (vague.length && !P[id].isNew && Math.random() < 0.2) ? rnd(vague) : rnd(own);
        if (!text || inFeed.has(id + '|' + text)) continue;
        this.pushFeed({ type: 'status', from: id, text, time: this.now() });
        return true;
      }
      return false;
    };

    // somebody leaves a pic comment on a media post (usually a friend of whoever posted it)
    const picComment = () => {
      const posts = st.feed.filter(f => f.type === 'post' && (f.comments || []).length < 14);
      if (!posts.length || ids.length < 2) return false;
      const post = rnd(posts);
      const pals = ((P[post.from] || {}).friends || []).filter(f => P[f] && f !== post.from && !P[f].owner);
      const commenter = (pals.length && Math.random() < 0.6) ? rnd(pals) : rnd(ids.filter(x => x !== post.from));
      const said = new Set((post.comments || []).map(c => c.text));
      const pool = (P[commenter].pcComments || []).concat(P[commenter].isNew ? [] : this.bank('picComments')).filter(l => !said.has(l));
      if (!pool.length) return false;
      (post.comments = post.comments || []).push({ from: commenter, text: rnd(pool) });
      this.save();
      if (this.view.page === 'feed') this.render();
      return true;
    };

    // bulletin: an authored one nobody has seen yet, otherwise one of their musings
    const bulletin = () => {
      const bodies = new Set(st.bulletins.map(b => b.body));
      const onWall = new Set(st.myWall.map(c => c.text));
      for (let tries = 0; tries < 8; tries++) {
        const id = rnd(ids);
        const authored = (P[id].bulletins || []).find(b => b && b.body && !bodies.has(b.body));
        const musings = (P[id].ambient || []).filter(l => !bodies.has(l) && !onWall.has(l) && !this.dmUsed(id, l));
        if (!authored && !musings.length) continue;
        const subject = (authored && authored.subject) || 'bulletin from ' + P[id].name;
        const body = authored ? authored.body : rnd(musings);
        const when = this.now();
        st.bulletins.push({ from: id, subject, body, time: when, reposts: 0 });
        this.trimBulletins();
        const brief = body.length > 220 ? this.cut(body, 220).trimEnd() + '…' : body;
        this.pushFeed({ type: 'bulletin', from: id, text: authored ? subject + ' — ' + brief : brief, time: when });
        if (this.view.page === 'bulletins') this.render();
        return true;
      }
      return false;
    };

    // two residents become friends (a friend of a friend, most of the time)
    const friending = () => {
      const inFeed = new Set(st.feed.map(f => f.text));
      for (let tries = 0; tries < 8; tries++) {
        const a = rnd(ids);
        const mine = (P[a].friends || []).filter(f => P[f]);
        const viaFriend = mine.length ? ((P[rnd(mine)].friends || []).filter(f => P[f] && f !== a && !mine.includes(f))) : [];
        const t = (viaFriend.length && Math.random() < 0.8) ? rnd(viaFriend) : rnd(ids);
        if (a === t) continue;
        const text = `${P[a].name} and ${P[t].name} are now friends!`;
        if (inFeed.has(text) || inFeed.has(`${P[t].name} and ${P[a].name} are now friends!`)) continue;
        this.pushFeed({ type: 'friends', from: a, text, time: this.now() });
        return true;
      }
      return false;
    };

    // wall comment on YOUR page: a friend's musing that hasn't been posted anywhere yet
    const myWall = () => {
      const taken = new Set(st.myWall.map(c => c.text).concat(st.bulletins.map(b => b.body)));
      for (const id of this.shuffled(st.friends.filter(f => P[f]))) {
        const pool = (P[id].ambient || []).filter(l => !taken.has(l) && !this.dmUsed(id, l));
        if (!pool.length) continue;
        const text = rnd(pool);
        const when = this.now();
        st.myWall.push({ from: id, text, time: when });
        this.pushFeed({ type: 'wall', from: id, to: 'you', text, time: when });
        this.toast(P[id].name + ' commented on your wall!', 'home');
        if (this.view.page === 'home') this.render();
        return true;
      }
      return false;
    };

    // DM to you from a friend: a fresh standalone line from their `dms` pool, or nothing at all (see freshDm)
    const friendDm = () => {
      for (const id of this.shuffled(st.friends.filter(f => this.canColdDm(f)))) {
        const text = this.freshDm(id);
        if (!text) continue;
        this.markDmUsed(id, text);
        return this.deliverDm(id, text, { unprompted: true });
      }
      return false;
    };

    // a stranger slides into your DMs with their authored opener
    const strangerDm = () => {
      const strangers = ids.filter(id => (P[id].dmSeed || []).length && !(st.inbox[id] && st.inbox[id].msgs.length) && !this.activeTreeFor(id));
      if (!strangers.length) return false;
      const id = this.pickWeighted(strangers, s => st.pending.includes(s) ? 3 : st.friends.includes(s) ? 2 : st.denied.includes(s) ? 0.2 : 1);
      st.inbox[id] = { unread: true, at: Date.now(), dmAt: Date.now(), msgs: P[id].dmSeed.map(m => ({ who: 'them', text: m.text, time: this.now(), u: 1 })) };
      P[id].dmSeed.forEach(m => this.markDmUsed(id, m.text));
      this.save();
      this.toast(P[id].name + ' sent you a message!', 'inbox', id);
      if (this.view.page === 'inbox' && !this.view.arg) this.render();
      return true;
    };

    // a friend request trickles in (newcomers and friends-of-friends first) — never a flood: the list tops out at 12
    const friendRequest = () => {
      if (st.pending.length >= 12) return false;
      const known = new Set([...st.friends, ...st.pending, ...st.denied]);
      const cands = ids.filter(id => !known.has(id));
      if (!cands.length) return false;
      const mine = new Set(st.friends);
      const id = this.pickWeighted(cands, c => (P[c].isNew ? 3 : 1) * (1 + (P[c].friends || []).filter(f => mine.has(f)).length));
      st.pending.push(id);
      this.save();
      this.toast(P[id].name + ' wants to be your friend!', 'requests');
      if (this.view.page === 'requests') this.render();
      return true;
    };

    const events = [
      [22, () => this.tickStory()],
      [18, banter],
      [14, status],
      [9, () => this.dripPost()],
      [7, picComment],
      [6, friendDm],
      [5, bulletin],
      [5, myWall],
      [4, friending],
      [4, friendRequest],
      [3, strangerDm],
      [3, () => { this.maybeStartNextDialogue(); return true; }],
    ];
    const run = this.pickWeighted(events, e => e[0])[1];
    if (!run()) {
      // nothing to do for that kind right now: keep the feed moving instead
      const [first, second] = Math.random() < 0.55 ? [banter, status] : [status, banter];
      if (!first() && !second() && depth < 1) return this.tickEvent(depth + 1);
    }
    this.paintTabs();
  },

  /* ---------------------------- boot ---------------------------- */
  build() {
    const body = document.querySelector('.window[data-app="myspace"] .window-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    this.load();

    body.innerHTML = `
      <div class="ms-header">
        <span class="ms-logo">ourspace<span class="ms-logo-dot">.</span></span>
        <span class="ms-slogan">a place for friends</span>
        <input class="ms-search" id="ms-search" placeholder="🔎 search ourspace…">
      </div>
      <div class="ms-tabs">
        <button class="ms-tab" data-page="feed" data-label="Feed">Feed</button>
        <button class="ms-tab" data-page="home" data-label="My Page">My Page</button>
        <button class="ms-tab" data-page="profile" data-arg="malten" data-label="Malten's Page">Malten's Page</button>
        <button class="ms-tab" data-page="blog" data-label="Blog">Blog</button>
        <button class="ms-tab" data-page="guestbook" data-label="Guestbook">Guestbook</button>
        <button class="ms-tab" data-page="browse" data-label="Browse">Browse</button>
        <button class="ms-tab" data-page="chat" data-label="#ourspace">#ourspace</button>
        <button class="ms-tab" data-page="requests" data-label="Requests">Requests</button>
        <button class="ms-tab" data-page="inbox" data-label="Inbox">Inbox</button>
        <button class="ms-tab" data-page="bulletins" data-label="Bulletins">Bulletins</button>
      </div>
      <div class="ms-shell">
        <div id="ms-content"></div>
        <div id="ms-side">
          <div class="ms-sidebox"><div class="ms-boxtitle">🚪 buddy list</div><div id="ms-side-buddies"></div></div>
          <div class="ms-sidebox"><div class="ms-boxtitle">🔮 today, by starxgazer</div><div id="ms-side-horo"></div></div>
          <div class="ms-sidebox"><div class="ms-boxtitle">📣 cool new people</div><div id="ms-side-new"></div></div>
        </div>
      </div>`;

    body.querySelectorAll('.ms-tab').forEach(t =>
      t.addEventListener('click', () => { Sfx.click(); this.show(t.dataset.page, t.dataset.arg || undefined); }));
    const search = body.querySelector('#ms-search');
    search.addEventListener('keypress', e => {
      if (e.key !== 'Enter') return;
      this.browseQuery = search.value.trim();
      this.show('browse');
    });

    // collapse the sidebar when the window is narrow (the window's opening size is its own
    // data-start-fill attribute, handled by WM)
    const win = document.querySelector('.window[data-app="myspace"]');
    if (win && window.ResizeObserver) {
      new ResizeObserver(() => body.classList.toggle('ms-narrow', win.offsetWidth < 720)).observe(win);
    }
    // the Navigator-style Address bar above the page (index.html): ◀ Back, 🏠 the feed, and a URL that follows you
    const navBtn = (id, fn) => { const b = win && win.querySelector(id); if (b) b.addEventListener('click', () => { Sfx.click(); fn(); }); };
    navBtn('#ms-nav-back', () => this.back());
    navBtn('#ms-nav-home', () => this.show('feed'));

    this.paintSidebar();
    this.show('feed');
    this.startAmbient();
    // the first scripted conversation arrives shortly after you settle in
    setTimeout(() => this.maybeStartNextDialogue(), 25000);
    // …and a little later, one nudge toward the guestbook for visitors who haven't found it
    setTimeout(() => this.nudgeGuestbook(), 50000);
  },
};

// top-level const doesn't attach to window — export so `window.MS` guards elsewhere
// (the Start menu's data-mstab items in desktop.js, apps.js) actually see it
Object.assign(window, { MS });

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('app-open', e => { if (e.detail === 'myspace') MS.build(); });
  document.addEventListener('app-close', e => {
    if (e.detail !== 'myspace') return;
    MS.stopMusic();
  });

  const el = document.querySelector('.window[data-app="myspace"]');
  if (el && !el.classList.contains('closed')) MS.build();
});
