/* pages/terms.js — /terms: the terms of service, in plain language. A DRAFT for a lawyer to read (docs/roadmap.md).
   Deliberately no company name, governing law or jurisdiction: the owner has not chosen them. The minimum age is the
   server's MIN_AGE (S.minAge), never a number written here. */

import { h } from '../core/dom.js';
import { pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';
import { li, updatedLine, writeToUs, contactSection } from '../widgets/legal.js';

export async function renderTerms(root) {
  root.append(pageTitle('Terms of Service'));
  root.append(h('div', { class: 'os-doc' },
    updatedLine(),
    h('p', null, 'these are the terms for using ourspace, the website and the apps. by making an account or using ourspace you agree to them. please also read the ', h('a', { href: '/rules', text: 'house rules' }), ' and the ', h('a', { href: '/privacy', text: 'privacy policy' }), '. if you don\'t agree, please don\'t use ourspace.'),

    h('h2', { text: 'who can join' }),
    h('ul', null,
      li(`you have to be ${S.minAge} or older. if you're under 18, make sure a parent or guardian is okay with you using ourspace.`),
      li('the birthday you give has to be your real one. we use it to check your age, to keep teens and adults apart in suggestions, and to work out your star sign.'),
      li('you need an email address, and you have to confirm it before you can post, comment, message or follow.'),
      li('keep your password to yourself. what happens on your account is on you, so tell us if someone else got into it.')),

    h('h2', { text: 'the rules' }),
    h('p', null, 'the ', h('a', { href: '/rules', text: 'house rules' }), ' are part of these terms. in short: be nice, no sexual content, no spam or scams, don\'t pretend to be someone else, don\'t post anyone\'s private information. don\'t break the law here either, and don\'t try to break the site, get around its limits or spam checks, or sign up again after being removed.'),
    h('p', { text: 'ourspace is for people writing in their own words. long posts (statuses, replies, comments, board threads and blog posts, including on a private page) may be checked for text that looks written by an AI (when that check is switched on), see moderation below.' }),

    h('h2', { text: 'what is yours, and what you let us do with it' }),
    h('ul', null,
      li('what you write, post and upload is yours. we don\'t claim to own it.'),
      li('to run ourspace we need your permission to store it, copy it, strip the hidden details from photos, and show it to the people who are allowed to see it, on the website and in the apps. you give us that permission, for free, everywhere, and without exclusivity, for as long as it is on ourspace. it is only for running, protecting and improving ourspace, nothing else.'),
      li('only post what you have the right to post: your own words and photos, or ones you have permission for. don\'t post someone else\'s private or intimate pictures.'),
      li('when you delete something, or your account, it comes off the site. a few copies can stay for a while where we need them to keep people safe, described in the privacy policy. a copy of anything that was reported stays with the moderators, and where the law requires it we keep material, and information about it, even after you delete it or your account.'),
      li('pictures and other things on the site that other people made are credited on the credits page linked in the footer.')),

    h('h2', { text: 'moderators, strikes and what can happen to you' }),
    h('ul', null,
      li('anyone can report a post, a comment, a message or a person. moderators look at reports and can hide a post or message, remove a photo, or suspend an account. they decide; we try to be fair, but we don\'t have to give a reason every time.'),
      li('a suspended account is signed out at once and can\'t log in again.'),
      li('child sexual abuse material is hidden at once and reported to the NCMEC CyberTipline, and intimate images shared without consent are removed within 48 hours. accounts that post them can be suspended.'),
      li('when the AI-writing check is switched on, a long post that scores as very likely AI-written earns a strike: the first is a warning, then no public posting for a day, then a week, then 30 days, and from the fifth a moderator decides what happens. a strike doesn\'t take the post down, it stops counting after 90 clean days, and you can appeal each one from your strikes page. while the check is in test mode or switched off, nobody gets strikes.'),
      li('if you think a moderator got something wrong, tell us.')),
    writeToUs('you can write to us at '),

    h('h2', { text: 'ending your account' }),
    h('ul', null,
      li('you can delete your account whenever you like, in Settings (on the website or in the app). it can\'t be undone. what goes with it is in the privacy policy.'),
      li('we can suspend or delete an account that breaks these terms or the rules, that puts people at risk, or that the law makes us act on. we don\'t have to give notice first if someone is in danger.'),
      li('we can also stop running ourspace, or part of it. we\'ll say so on the site if we do.')),

    h('h2', { text: 'no warranty' }),
    h('ul', null,
      li('ourspace is a small site, free to use, offered as it is. it might break, change or go down, and we can\'t promise it will always be there or free of mistakes.'),
      li('we don\'t check or endorse what members post, and we aren\'t responsible for it. be careful with what you share, and with people you meet here.'),
      li('the horoscopes are for fun. they are astrology, not advice.'),
      li('music previews come from other companies (Apple, Spotify) and can change or disappear.'),
      li('to the extent the law allows, we aren\'t liable for losses from using ourspace. nothing here limits rights the law says you always have.')),

    h('h2', { text: 'changes to these terms' }),
    h('p', { text: 'we may change these terms. the date at the top says when they last changed. if a change matters, we\'ll put a notice on the site, and if you keep using ourspace after a change you accept it. if you don\'t, you can delete your account.' }),
    ...contactSection('questions about these terms?')));
}
