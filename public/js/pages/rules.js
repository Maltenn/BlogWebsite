/* pages/rules.js — House Rules & Privacy: the rules, blocking and reporting, how to ask for an intimate image to be
   taken down (members or not), the contact address, and a short privacy summary that points at /privacy. The long
   texts are /terms and /privacy. */

import { h } from '../core/dom.js';
import { pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';
import { li, contactSection, emailLink } from '../widgets/legal.js';

export async function renderRules(root) {
  root.append(pageTitle('House Rules & Privacy'));
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
    h('p', null, 'the longer versions: ', h('a', { href: '/terms', text: 'terms of service' }), ' and ', h('a', { href: '/privacy', text: 'privacy policy' }), '.'),
    h('h2', { text: 'blocking and reporting' }),
    h('ul', null,
      li('Block User (on every page): they can\'t message you, follow you, comment on your page or see it, you stop seeing each other\'s posts, and any follows between you end. They aren\'t told. Unblock any time in Settings.'),
      li('Report (on every page, post, comment and message): sends it to the moderators with a copy of what it said. Reports are private.'),
      li('Anyone can follow you, or you can make your page private in Settings so people have to ask. Friends are people who follow each other: only they can write on your Friends\' Comments, and in Settings you can limit messages to friends too.')),
    h('p', { text: 'If a photo is child sexual abuse material, report it with that reason: its photos are hidden the moment the report comes in, and we report it to the NCMEC CyberTipline.' }),
    takeItDown(),
    ...contactSection('questions, or something that needs a person?'),
    h('h2', { text: 'what we keep' }),
    h('ul', null,
      li('Your email, your birthday, a hashed password, your page, and what you post or send.'),
      li('Your birthday stays private. Your page shows your age and star sign, and you can hide either one.'),
      li('No ads, no tracking scripts, and we don\'t sell anything about you.'),
      li('Deleting your account (Settings) deletes your page, posts, messages, follows and connections.')),
    h('p', null, 'everything we collect, why, who handles it and for how long is in the ', h('a', { href: '/privacy', text: 'privacy policy' }), '.'),
    h('h2', { text: 'about the horoscopes' }),
    h('p', { text: 'The positions of the Sun, Moon and planets are real, calculated for your day. What they "mean" is astrology: for fun.' })));
}

// the Take It Down notice. Reports need an account (POST /api/reports answers 401 to anyone signed out), so the way in
// for someone without one is the contact address: that part appears only once CONTACT_EMAIL is set.
function takeItDown() {
  const mail = emailLink();
  return [
    h('h2', { text: 'taking down an intimate image' }),
    h('p', { text: 'If a nude or sexual picture or video of you was put on OurSpace without your consent, you can ask for it to be removed. That includes a real one someone shared after you sent it to them privately, and a fake one made to look like you. You can ask for it yourself or for someone you\'re acting for.' }),
    h('p', { text: 'We act on a valid request within 48 hours: a moderator takes the image off the site (removing it, not just hiding it). If it is posted again, tell us and we\'ll remove that too.' }),
    h('p', { text: 'If the person in the picture may be under 18, say so. A report about someone who may be under 18 is handled as a child-safety report, not as a takedown request.' }),
    h('ul', null,
      li('If you have an account: Report the post, pick "sexual content" and say in the details that it is an intimate image shared without consent.'),
      mail ? h('li', null, 'With or without an account: write to ', mail, ' and include:',
        h('ul', null,
          li('where it is: a link to the post or page (the address in your browser\'s bar), or the screen name of the person who posted it;'),
          li('that the image is of you (or of the person you are writing for) and was shared without consent;'),
          li('a way for us to answer you.')),
        'Please don\'t attach the image itself.') : null),
  ];
}
