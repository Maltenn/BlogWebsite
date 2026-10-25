/* pages/rules.js — House Rules & Privacy. */

import { h } from '../core/dom.js';
import { pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';

export async function renderRules(root) {
  root.append(pageTitle('House Rules & Privacy'));
  const li = t => h('li', { text: t });
  root.append(h('div', { class: 'os-doc' },
    h('p', { text: 'OurSpace is a small, friendly place. Keep it that way.' }),
    h('h2', { text: 'the rules' }),
    h('ol', null,
      li(`You have to be ${S.minAge} or older to have a page, and the birthday you give has to be your real one.`),
      li('Be nice. No harassment, bullying, threats or hate.'),
      li('No sexual content, ever.'),
      li('No spam, scams or chain letters.'),
      li('Don\'t pretend to be someone you\'re not.'),
      li('Don\'t post anyone\'s private information.')),
    h('p', { text: 'Break them and a moderator can hide what you posted or suspend your account.' }),
    h('h2', { text: 'blocking and reporting' }),
    h('ul', null,
      li('Block User (on every page): they can\'t message you, comment on your wall, friend you or see your page, and you stop seeing each other\'s posts. They aren\'t told. Unblock any time in Settings.'),
      li('Report (on every page, post, comment and message): sends it to the moderators with a copy of what it said. Reports are private.'),
      li('In Settings you can also limit wall comments and messages to friends only.')),
    h('h2', { text: 'what we keep' }),
    h('ul', null,
      li('Your email, your birthday, a hashed password, your page, and what you post or send.'),
      li('Your birthday stays private. Your page shows your age and star sign, and you can hide either one.'),
      li('If you sign in with Google, Apple, Microsoft, Discord or GitHub: their id for you and the email they share. We never see your password there.'),
      li('If you connect Spotify: an encrypted key that lets us read your top tracks, and the tracks themselves. Nothing else.'),
      li('A salted hash of your IP address, used only to stop spam (rate limits). We never store the address itself.'),
      li('No ads, no tracking scripts. Song previews stream from Apple only when you press play.'),
      li('Deleting your account (Settings) deletes your page, posts, messages, friendships and connections. Reports other people made about you keep a copy of the reported text for the moderators.')),
    h('h2', { text: 'about the horoscopes' }),
    h('p', { text: 'The positions of the Sun, Moon and planets are real, calculated for your day. What they "mean" is astrology: for fun.' })));
}
