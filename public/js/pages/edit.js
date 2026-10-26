/* pages/edit.js — Edit My Page. */

import { h, enc, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops, pageTitle } from '../core/ui.js';
import { S, options } from '../core/state.js';
import { go } from '../core/router.js';
import { avatarGallery } from '../widgets/auth-forms.js';
import { prepareImage, readDataUrl } from '../widgets/photos.js';

export async function renderEdit(root) {
  const [opts, d, fr] = await Promise.all([options(), api.get('/users/' + enc(S.me.name)), api.get(`/users/${enc(S.me.name)}/friends`)]);
  const p = d.profile;
  const draft = {
    avatar: d.user.avatar, tag: p.tag, mood: p.mood, gender: p.gender, hometown: p.hometown, status: p.status,
    hereFor: p.hereFor, about: p.about, meet: p.meet, blogTitle: p.blogTitle, interests: { ...p.interests },
    showAge: p.showAge !== false, showSign: p.showSign !== false,
    theme: p.themeKey, bgTile: p.bgTile || '', font: p.font || '', decor: [...(p.decor || [])], badges: [...(p.badges || [])],
    top8: d.top8.map(f => f.id),
  };
  const sec = (title, note, ...kids) => h('div', { class: 'cz-block' }, h('div', { class: 'cz-h' }, title, note ? h('span', { class: 'cz-hnote', text: note }) : null), kids);
  const field = (label, key, { max = 60, list = null, area = false } = {}) => {
    const id = 'cz-' + key;
    const inp = area ? h('textarea', { id, maxLength: max, value: draft[key] || '' }) : h('input', { id, maxLength: max, value: draft[key] || '', list: list ? id + '-list' : null });
    inp.addEventListener('input', () => { draft[key] = inp.value; });
    return h('label', { for: id }, label, inp, list ? h('datalist', { id: id + '-list' }, list.map(v => h('option', { value: v }))) : null);
  };
  const check = (key, label) => {
    const cb = h('input', { type: 'checkbox', checked: draft[key] });
    cb.addEventListener('change', () => { draft[key] = cb.checked; });
    return h('label', { class: 'cz-check' }, cb, label);
  };

  const avNow = h('img', { class: 'cz-avnow', src: draft.avatar, alt: 'your picture' });
  let loose = null;                                  // the picture you uploaded in this visit and haven't saved (its upload id)
  const dropLoose = () => { if (loose != null) api.del('/media/' + loose).catch(() => {}); loose = null; };
  const gallery = avatarGallery(opts.avatars, draft.avatar, f => { dropLoose(); draft.avatar = f; avNow.src = f; });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'choose a picture', tabindex: -1 });
  const upBtn = h('button', { class: 'btn98', type: 'button', text: '📷 Upload my own picture', onclick: () => fileIn.click() });
  const upNote = h('span', { class: 'os-hint', text: 'it\'s cropped to a square and shrunk to 300 px.' });
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!file) return;
    upBtn.disabled = true;
    upNote.textContent = 'getting it ready…';
    try {
      const prep = await prepareImage(file, { avatar: true });
      avNow.src = await readDataUrl(prep.blob);                    // the crop, as it will look
      upNote.textContent = 'uploading…';
      const m = await api.upload('/media?purpose=avatar', prep.blob).then(r => r.media);
      dropLoose();
      loose = m.id;
      draft.avatar = m.url;
      gallery.querySelectorAll('.su-av').forEach(x => x.classList.remove('sel'));
      upNote.textContent = 'looking good. save your page to keep it.';
    } catch (e) { avNow.src = draft.avatar; upNote.textContent = 'it\'s cropped to a square and shrunk to 300 px.'; oops(e); }
    upBtn.disabled = false;
  });
  const picSec = sec('📷 picture', 'pick one of the presets, or upload your own',
    h('div', { class: 'cz-avrow' }, avNow, h('div', { class: 'cz-avside' },
      h('div', { class: 'cz-upload' }, upBtn, fileIn, upNote),
      gallery)));

  const aboutSec = sec('👤 about you', 'all optional',
    h('div', { class: 'cz-fields' },
      field('tagline', 'tag', { max: 90 }), field('mood', 'mood', { max: 40, list: opts.moods }),
      field('gender', 'gender', { max: 30, list: opts.genders }), field('hometown', 'hometown', { max: 60 }),
      field('status', 'status', { max: 50, list: opts.statuses }), field('here for', 'hereFor', { max: 80, list: opts.hereFor }),
      field('blog title', 'blogTitle', { max: 60 })),
    h('div', { class: 'cz-lbl', text: 'from your birthday (which stays private)' }),
    h('div', { class: 'cz-checks' }, check('showAge', 'show my age'), check('showSign', `show my star sign (${S.me.sign.glyph} ${S.me.sign.name})`)),
    h('div', { class: 'cz-fields cz-wide' }, field('about me', 'about', { max: 2000, area: true }), field('who I\'d like to meet', 'meet', { max: 800, area: true })),
    h('div', { class: 'cz-lbl', text: 'interests' }),
    h('div', { class: 'cz-fields' }, opts.interestKeys.map(k => {
      const inp = h('textarea', { maxLength: 400, rows: 2, value: draft.interests[k] || '' });
      inp.addEventListener('input', () => { draft.interests[k] = inp.value; });
      return h('label', null, k, inp);
    })));

  const swatches = h('div', { class: 'cz-swatches' }, opts.themes.map(t => {
    const b = h('button', { class: 'cz-swatch' + (t.key === draft.theme ? ' sel' : ''), type: 'button', text: t.name, dataset: { key: t.key } });
    b.style.background = t.bg; b.style.color = t.fg; b.style.borderColor = t.accent;
    b.addEventListener('click', () => { draft.theme = t.key; swatches.querySelectorAll('.cz-swatch').forEach(x => x.classList.toggle('sel', x.dataset.key === t.key)); });
    return b;
  }));
  const tiles = h('div', { class: 'cz-tiles' }, opts.tiles.map(t => {
    const r = h('input', { type: 'radio', name: 'cz-tile', checked: t.v === draft.bgTile });
    r.addEventListener('change', () => { draft.bgTile = t.v; });
    const prev = h('span', { class: 'cz-tileprev' });
    if (t.v) prev.style.backgroundImage = `url("${t.v}")`;
    return h('label', null, r, prev, t.label);
  }));
  const font = h('select', { 'aria-label': 'font' }, opts.fonts.map(f => h('option', { value: f.v, text: f.label, selected: f.v === draft.font })));
  font.addEventListener('change', () => { draft.font = font.value; });
  const picker = (list, key, max, cls) => {
    const count = h('span', { class: 'cz-count' });
    const paintCount = () => { count.textContent = ` (${draft[key].length}/${max})`; };
    const grid = h('div', { class: 'cz-gifgrid ' + cls }, list.map(src => h('button', {
      class: 'cz-gif' + (draft[key].includes(src) ? ' sel' : ''), type: 'button', 'aria-label': src.split('/').pop(),
      onclick: e => {
        const b = e.currentTarget;
        if (draft[key].includes(src)) draft[key] = draft[key].filter(x => x !== src);
        else if (draft[key].length >= max) { toast(`up to ${max}. unpick one first.`); return; }
        else draft[key].push(src);
        b.classList.toggle('sel', draft[key].includes(src));
        paintCount();
      },
    }, h('img', { src, alt: '', loading: 'lazy' }))));
    paintCount();
    return [count, grid];
  };
  const [decorCount, decorGrid] = picker(opts.decor, 'decor', 3, '');
  const [badgeCount, badgeGrid] = picker(opts.badges, 'badges', 12, 'cz-badges');
  const lookSec = sec('🎨 the look', 'colors, background, font, glitter',
    h('div', { class: 'cz-lbl', text: 'color theme' }), swatches,
    h('div', { class: 'cz-lbl', text: 'background' }), tiles,
    h('div', { class: 'cz-lbl', text: 'font' }), h('div', { class: 'cz-fields' }, h('label', null, font)),
    h('div', { class: 'cz-lbl' }, 'decorations under your picture', decorCount), decorGrid,
    h('div', { class: 'cz-lbl' }, '88x31 buttons', badgeCount), badgeGrid);

  const musicSec = sec('🎵 top songs', 'from your own Spotify',
    h('p', { class: 'cz-note' }, S.providers.spotify
      ? ['your page shows your Spotify top songs once you connect it: ', h('a', { href: '/settings#spotify', text: 'Settings → Spotify' }), '.']
      : 'Spotify connections aren\'t set up on this server yet.'));

  const top8 = h('div', { class: 'cz-top8' });
  const paintTop8 = () => {
    top8.replaceChildren(...fr.people.map(f => {
      const pos = draft.top8.indexOf(f.id);
      const cb = h('input', { type: 'checkbox', checked: pos >= 0 });
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (draft.top8.length >= 8) { cb.checked = false; toast('top 8 means 8. unpick someone first.'); return; }
          draft.top8.push(f.id);
        } else draft.top8 = draft.top8.filter(x => x !== f.id);
        paintTop8();
      });
      return h('label', null, cb, h('img', { src: f.avatar, alt: '' }), (pos >= 0 ? `#${pos + 1} ` : '') + f.name);
    }));
  };
  paintTop8();
  const friendsSec = sec('⭐ top 8', 'friends only: tick them in the order you want them shown',
    fr.people.length ? top8 : h('div', { class: 'ms-empty', text: 'no friends yet. friends are people who follow each other: follow some people!' }));

  const save = h('button', { class: 'btn98 go', type: 'button', text: '💾 save my page' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api.put('/me/profile', draft);
      loose = null;                                  // saved: the picture is attached now
      S.me.avatar = r.avatar;
      toast('saved! looking good.');
      go(userPath(S.me.name));
    } catch (e) { oops(e); save.disabled = false; }
  });
  root.append(pageTitle('Edit My Page', h('a', { class: 'btn98', href: userPath(S.me.name), text: '← my page (without saving)' })),
    h('div', { class: 'cz' }, picSec, aboutSec, lookSec, musicSec, friendsSec,
      h('div', { class: 'cz-foot' }, save, h('span', { class: 'os-hint', text: 'your screen name can\'t be changed yet.' }))));
}
