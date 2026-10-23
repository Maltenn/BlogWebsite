// The choices a person has when decorating their page. One list, two users: the page's editor shows them (GET
// /api/options) and the API only ever accepts values from them (validate.js) — so nobody can write arbitrary CSS or
// image URLs into a profile. Copied from the original site's Edit My Page (extras.js Customizer). tools/build.mjs
// copies every image named here into public/assets. Avatar presets live in generated/avatars.js.

export const THEMES = [
  { key: 'ourspace-blue', name: 'ourspace blue', bg: '#eef3fb', fg: '#000000', accent: '#3b6fb6' },
  { key: 'classic-purple', name: 'classic purple', bg: '#f3eefb', fg: '#000000', accent: '#9370DB' },
  { key: 'midnight', name: 'midnight', bg: '#0a0a0a', fg: '#e0d5f5', accent: '#c3002f' },
  { key: 'sk8r-blue', name: 'sk8r blue', bg: '#e8f4ff', fg: '#003366', accent: '#ff6600' },
  { key: 'banana', name: 'banana', bg: '#fffbe0', fg: '#5c4a00', accent: '#ffcc00' },
  { key: 'crt-green', name: 'CRT green', bg: '#0d1b0d', fg: '#c8f5c8', accent: '#7fff7f' },
  { key: 'bubblegum', name: 'bubblegum', bg: '#ffe8f0', fg: '#5c1a33', accent: '#ff71ce' },
  { key: 'nightcore', name: 'nightcore', bg: '#1a0033', fg: '#00ffff', accent: '#ff44cc' },
  { key: 'horse-girl', name: 'horse girl', bg: '#fff8f0', fg: '#5c3a1a', accent: '#cc8844' },
  { key: 'scene-queen', name: 'scene queen', bg: '#000000', fg: '#ff99cc', accent: '#ff0066' },
];

export const TILES = [
  { v: '', label: 'plain color' },
  { v: '/assets/bg_stars_tile.gif', label: 'twinkling stars' },
  { v: '/assets/tiles/tile_skulls.png', label: '☠ rainbow skulls' },
  { v: '/assets/tiles/tile_skulls_pink.png', label: '☠ pink skulls' },
  { v: '/assets/tiles/tile_hearts.png', label: '♥ hearts' },
  { v: '/assets/tiles/tile_checker.png', label: 'checkerboard' },
  { v: '/assets/tiles/tile_checker_pink.png', label: 'pink checker' },
  { v: '/assets/tiles/tile_leopard.png', label: 'pink leopard' },
  { v: '/assets/tiles/tile_leopard_tan.png', label: 'leopard' },
  { v: '/assets/tiles/tile_zebra.png', label: 'zebra' },
  { v: '/assets/tiles/tile_zebra_pink.png', label: 'pink zebra' },
  { v: '/assets/tiles/tile_web.png', label: '🕸 spider webs' },
  { v: '/assets/tiles/tile_stars_neon.png', label: '★ neon stars' },
  { v: '/assets/tiles/tile_flowers.png', label: '✿ flowers' },
  { v: '/assets/tiles/tile_bolts.png', label: '⚡ bolts' },
];

export const FONTS = [
  { v: '', label: 'MS Sans (default)' },
  { v: '"Comic Sans MS", cursive', label: 'Comic Sans (the people\'s font)' },
  { v: '"Courier New", monospace', label: 'Courier (h4x0r)' },
  { v: '"Times New Roman", serif', label: 'Times (fancy. suspicious.)' },
  { v: 'Verdana, sans-serif', label: 'Verdana (the sensible one)' },
  { v: 'Georgia, serif', label: 'Georgia (poetry blog)' },
  { v: '"Trebuchet MS", sans-serif', label: 'Trebuchet (layout site energy)' },
  { v: '"Lucida Console", monospace', label: 'Lucida Console (terminal goth)' },
];

export const DECOR = ['deco_welcome_banner', 'deco_new', 'deco_new_blue', 'deco_sparkle_bunny', 'deco_hearts_bar', 'deco_rainbow_bar',
  'deco_flames_bar', 'deco_smiley', 'deco_skull', 'deco_moon', 'deco_fairy', 'deco_dragon', 'deco_hamster', 'deco_dancing_baby',
  'deco_email_bear', 'deco_email_roses', 'deco_record_dj', 'deco_banana_tiny', 'deco_blinkie_zim', 'deco2_atom', 'deco2_mushroom',
  'deco2_goth_inside', 'deco2_ska_checker', 'deco2_downloadvirus'].map(n => `/assets/${n}.gif`);

export const BADGES = ['badge_best_viewed_with_eyes', 'badge_aim', 'badge_icq', 'badge_netscape', 'badge_ie_anim', 'badge_ie_sucks',
  'badge_firefoxget', 'badge_anybrowser', 'badge_geocities', 'badge_winamp', 'badge_midi_files_now',
  'badge_mspaint', 'badge_built_with_microsoft_notepad', 'badge_hello_kitty', 'badge_8bit', 'badge_Sega-Elite', 'badge_coffee',
  'badge_blink', 'badge_aol-sucks'].map(n => `/assets/${n}.gif`);

export const STATUSES = ['Single', 'In a Relationship', 'It\'s Complicated', 'Married to my Wacom', 'Engaged to my Xbox',
  'Taken (by my homework)', 'Swiss (neutral)', 'Divorced from my Tamagotchi', 'Saving myself for my Top 8', 'Married'];
export const HERE_FOR = ['Friends', 'Networking', 'Pen pals', 'The bulletins', 'Top 8 drama', 'Free layouts', 'Music', 'Glitter', 'Gossip (respectfully)'];
export const GENDERS = ['Male', 'Female', 'Nonbinary', 'Prefer not to say', 'Robot (beep)', 'Cryptid'];
export const MOODS = ['curious', 'new here :]', 'sleepy', 'hyper!!', 'emo', 'bored', 'creative', 'giddy', 'mellow', 'blah', 'artistic',
  'mischievous', 'nostalgic', 'rawr', 'sparkly', 'grumpy', 'happy :D', 'confused o.O', 'accomplished', 'hungry', 'crushed', 'determined'];
export const INTEREST_KEYS = ['General', 'Music', 'Movies', 'Television', 'Books', 'Heroes'];

export const REPORT_REASONS = [
  { v: 'spam', label: 'spam or scam' },
  { v: 'harassment', label: 'harassment or bullying' },
  { v: 'hate', label: 'hate speech' },
  { v: 'sexual', label: 'sexual content' },
  { v: 'violence', label: 'violence or threats' },
  { v: 'self_harm', label: 'self-harm or suicide' },
  { v: 'impersonation', label: 'pretending to be someone else' },
  { v: 'underage', label: 'this person may be under the minimum age' },
  { v: 'other', label: 'something else' },
];

// every image an option points at (tools/build.mjs copies them)
export const OPTION_ASSETS = [...TILES.map(t => t.v).filter(Boolean), ...DECOR, ...BADGES];
