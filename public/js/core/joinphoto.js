/* core/joinphoto.js — "use a photo of my own" on the sign-up screen, in the app only.

   Why it exists. App Store Guideline 4.2 is answered by what a reviewer can SEE, and a reviewer gives an app about
   ninety seconds. The native tab bar (core/tabbar.js) is tap zero; this is tap two: the sign-up page offers the
   phone's own camera / photo-library sheet above the fold, so the first native sheet appears before the reviewer has
   read a single form field. (docs/mobile/redteam.md, the 4.2 section, item 3; deviations.md D24.)

   Why it is here and not in pages/auth.js. The site's sign-up takes one of the preset pictures and nothing else —
   `POST /api/signup` only accepts a preset (`isAvatar()` in src/profiles/profiles.js), and there is no account to own
   an upload until the form has been sent. Adding an upload to the web page would be a change to the site and to the
   server contract; doing it here is a change to the app alone, injected by core/native.js, invisible to the web build
   and to every reference plate (native.js exports isApp = false in a browser, so none of this runs there).

   So the picture is picked BEFORE there is an account and attached straight after there is one:
     1. the member taps the button; the phone's sheet opens; the file is cropped to the same 300px square the page's
        own uploader makes (core/image.js `prepareImage`, so the bytes are identical to what Settings would send);
     2. the form is sent as it always was, with whichever preset is selected;
     3. core/native.js calls `attach()` when `POST /api/signup` or `/api/signup/finish` has answered 200 — the account
        now exists and the session token is in hand — and the photo goes up as `POST /api/media?purpose=avatar`
        followed by `PUT /api/me/profile { avatar }`. Both routes are `free` (src/index.js:81,127), so this works for
        an email sign-up whose address is not confirmed yet, which is exactly the reviewer's case.

   If anything fails the account is already made and signed in; the member keeps the preset they chose and gets one
   plain line about it. Nothing here can stop a sign-up. */

import { h } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { prepareImage, readDataUrl } from './image.js';

const ROW = 'os-nativepic';                     // the injected row, so it is only ever added once per form

export function wireJoinPhoto({ pick, doc = document } = {}) {
  if (typeof pick !== 'function') return false;

  let chosen = null;                            // { blob }: the cropped picture, picked before there was an account

  const clear = () => { chosen = null; };

  function row() {
    const preview = h('img', { class: 'cz-avnow', alt: 'the picture you picked', hidden: true });
    const hint = h('span', { class: 'su-hint', text: 'straight from your camera or your photos. cropped to a square.' });
    const btn = h('button', {
      class: 'btn98', type: 'button', text: '📷 use a photo of my own',
      onclick: async () => {
        btn.disabled = true;
        try {
          const files = await pick({ multiple: false });
          const file = files && files[0];
          if (!file) return;                                  // cancelled: the presets are still there
          hint.textContent = 'getting it ready…';
          const prepped = await prepareImage(file, { avatar: true });
          chosen = { blob: prepped.blob };
          preview.src = await readDataUrl(prepped.blob);
          preview.hidden = false;
          btn.textContent = '📷 use a different photo';
          hint.textContent = 'this is the picture your page will start with. it goes up when you join.';
        } catch (e) {
          clear();
          preview.hidden = true;
          btn.textContent = '📷 use a photo of my own';
          hint.textContent = (e && e.message) || 'that picture didn\'t work. pick one of the ones below instead.';
        } finally { btn.disabled = false; }
      },
    });
    return h('div', { class: `${ROW} su-btns` }, preview, h('div', null, btn, h('div', null, hint)));
  }

  /* The sign-up card is painted by pages/auth.js after this module is wired, and again on every visit, so the row is
     injected by observing #ms-content rather than by calling into the page. The anchor is the card's first lead
     paragraph, which puts the button above the fold on both /join and /join/finish. */
  function inject() {
    for (const card of doc.querySelectorAll('.ms-signup .su-body')) {
      if (card.querySelector('.' + ROW)) continue;
      // only the two cards that actually ask for a picture. `.ms-signup` + `.su-lead` is also the shape of the
      // "check your email" card (widgets/checkemail.js) and of pages/verify.js, and a camera button on either of
      // those would be offering to do something there is no longer any step for. The avatar gallery is the test.
      if (!card.querySelector('.av-gallery')) continue;
      const lead = card.querySelector('.su-lead');
      if (!lead) continue;
      clear();                 // a card painted fresh (a new visit, a failed submit) starts with no picture pending
      lead.after(row());
    }
  }

  const content = doc.getElementById('ms-content');
  if (!content) return false;
  const watch = new MutationObserver(() => inject());
  watch.observe(content, { childList: true, subtree: true });
  inject();

  /**
   * Called by core/native.js when a sign-up has just succeeded. Resolves to the new avatar's URL, or null when there
   * was no photo to attach or it could not be attached — never rejects, because by this point the account exists and
   * the member is in.
   *
   * `PUT /api/me/profile` takes the WHOLE profile and resets what is missing, so this may only ever be called on an
   * account that was created seconds ago and whose profile is still the default. That is the only place it is called
   * from, and the reason it is not a general "set my picture" helper.
   */
  async function attach() {
    const photo = chosen;
    clear();
    if (!photo) return null;
    try {
      const { media } = await api.upload('/media?purpose=avatar', photo.blob);
      await api.put('/me/profile', { avatar: media.url });
      return media.url;
    } catch (e) {
      toast('your page is made, but that picture didn\'t upload: ' + ((e && e.message) || 'try again in Settings.'), true);
      return null;
    }
  }

  return { attach, clear, pending: () => !!chosen, stop: () => watch.disconnect() };
}
