/* pages/privacy.js — /privacy: the privacy policy. A DRAFT for a lawyer to read. Every statement here is checked
   against the code: what src/ collects, how long the cron keeps it, who it is sent to. It has to be checked again when
   the code changes. The minimum age is the server's MIN_AGE (S.minAge). Where a statement depends on a setting that may
   be off (AI scans, email, push, sign-in providers), it says "if". */

import { h } from '../core/dom.js';
import { pageTitle } from '../core/ui.js';
import { S } from '../core/state.js';
import { li, updatedLine, contactSection, reach } from '../widgets/legal.js';

export async function renderPrivacy(root) {
  root.append(pageTitle('Privacy Policy'));
  root.append(h('div', { class: 'os-doc' },
    updatedLine(),
    h('p', null, 'this is what ourspace (the website and the apps) collects about you, why, who else handles it, and how long we keep it. it goes with the ', h('a', { href: '/terms', text: 'terms of service' }), ' and the ', h('a', { href: '/rules', text: 'house rules' }), '.'),
    h('p', { text: 'the short version: we collect what ourspace needs to work and to keep bots and bad actors out. there are no ads, no analytics and no tracking scripts, and we don\'t sell information about you.' }),

    h('h2', { text: 'what we collect, and why' }),
    h('ul', null,
      li('your account: your email address (to confirm your account, reset your password and sign you in), your screen name, a hashed password (we can\'t read it), your birthday (to check your age, to keep teens and adults apart in suggestions, and to work out your star sign; it is never shown, only the age and sign you choose to show), and when you were last active (it is what the "online" marker is made from).'),
      li('what you put on ourspace: your page, statuses, replies, comments, blog posts, board threads, chat messages (direct, group and #ourspace), likes, follows, blocks, bookmarks, and photos with their descriptions. we take the hidden details out of every photo you upload, including where it was taken.'),
      li('staying signed in: a cookie called os_sid, which says who you are, lasts 30 days on the website and is "HttpOnly" (pages can\'t read it). in the apps the sign-in key sits in the phone\'s secure storage (Keychain or Keystore) and lasts up to 90 days from when you last used the app, and at most 180 days. three other cookies are short: os_oauth for the ten minutes a Google, Discord or Spotify sign-in takes, os_signup for up to half an hour while you pick a screen name and give your birthday after a first sign-in with Google or Discord, and os_agegate for a day after a sign-up with a birthday under the minimum age. they are the only cookies ourspace itself sets.'),
      li('if you sign in with Google or Discord: their id for you and the email address they share. we never see your password there.'),
      li('if you connect Spotify: your Spotify id and display name, an encrypted key that lets us read your top tracks (the only permission we ask for), and the tracks themselves. to play song previews, our server looks the song and artist up on Apple\'s iTunes search. nothing about you goes with it.'),
      li('when you join, to catch bots: a scrambled (salted, one-way hashed) version of your network address (for IPv6, of your network\'s first half), the name, number and country of your internet provider, a scrambled version of your browser\'s identity, the domain of your email (not the whole address), how long the sign-up form was open, and a risk score with the reasons for it. moderators use it to review sign-ups that look like bots. we never store your actual address, or your browser\'s full identity.'),
      li('to slow down guessing and spam we count recent tries (wrong passwords, password resets, new accounts, reports, uploads). the counters are filed under your account, a scrambled network address, or the login or email address you typed.'),
      li('to spot copied posts: a fingerprint of the words of each post you write that has 8 words or more (a status, reply, quote, comment, board thread or blog post), wherever it is shown, even on a private page (a scrambled summary, not the words).'),
      li('when several sign-ups or posts look related (the same network provider, the same email domain, the same text), moderators get an alert. it names the member numbers involved, and, depending on the kind, the provider\'s name and number, the email domain, the post numbers or the risk reasons.'),
      li('if the site has the AI-writing check switched on: your statuses, replies, quotes, comments, board threads and blog posts of 100 words or more (150 for blog posts) are scored for text that looks written by an AI. that includes posts on a page you made private. the words, without links, quotes, code or @mentions, and without your name, go to the company that does the scoring. we keep the score, the verdict and a scrambled copy of the text. direct messages and chat are never scanned. if a post earns a strike we also keep the flagged words so you and the moderators can see what was flagged and you can appeal.'),
      li('when someone reports something: the moderators get a copy of what was reported (the post, message or page, and the addresses of its photos) and who reported it, so the evidence survives if it\'s deleted.'),
      li('in the apps, if you allow notifications: your phone\'s notification token, whether it is an iPhone or an Android, the device\'s name, and when it was last used. a notification says only who it\'s from and what kind it is ("kat sent you a message"), never what was written. the app keeps a small copy of your last account details (your name and counts) on the phone so it can open without a connection, and clears it when you log out. it uses your camera or photo library only when you choose a picture, and never reads your location.')),

    h('h2', { text: 'who else handles your information' }),
    h('ul', null,
      li('Cloudflare runs ourspace: it hosts the site, the database, the photos and the live chat, so it handles everything above. it also sees your network address and browser details whenever you visit, and keeps its own logs. it runs the "verify you are human" check on the sign-up, log-in and forgot-password pages, which loads a Cloudflare script in your browser and gets your network address and browser signals. we also ask Cloudflare\'s DNS whether a new email address\'s domain can receive mail (just the domain).'),
      li('Resend sends our emails (confirming your address, resetting your password) if email is switched on. it gets your email address and the message.'),
      li('Google or Discord, if you sign in with them; Spotify, if you connect it. each follows its own privacy policy for what it does on its side.'),
      li('Apple and Spotify, for song previews and album art: when your browser plays a preview or shows a cover on a page that has a Spotify "top tracks" box, it contacts them directly, and they see your network address.'),
      li('Apple (APNs) and Google (FCM) deliver notifications to the apps if you allow them. they get your phone\'s token and the short text above, not your messages.'),
      li('if the AI-writing check is on, the scoring company: Pangram, GPTZero or Cloudflare\'s Workers AI, whichever the site uses.'),
      li('the authorities, where the law requires it. for example, child sexual abuse material is reported to the NCMEC CyberTipline.'),
      li('everything is stored with Cloudflare, so it may be handled on servers outside your country.')),

    h('h2', { text: 'how long we keep it' }),
    h('ul', null,
      li('your account, page, posts, photos, messages, likes, follows and connections: until you delete them or your account. #ourspace keeps only the last 24 hours and at most 500 messages (reported messages stay with the report).'),
      li('login cookies: 30 days (website), up to 90 days unused (apps). log out and it ends at once. confirmation links last 24 hours and password reset links one hour.'),
      li('the sign-up signals above, and the AI scans (the score, verdict and scrambled copy): 90 days, then they are deleted. a strike\'s own record (when it was given, the score and verdict, and any appeal) is kept for as long as your account exists, and goes when you delete it. its flagged words: while the strike counts (90 clean days), then 30 days more. the fingerprints of posts: 7 days.'),
      li('moderator alerts about sign-ups and copied posts: until a moderator closes them, then 90 days. an alert nobody has closed has no end date. deleting your account does not take your member number out of an alert.'),
      li('the counters that slow down guessing and spam: two days.'),
      li('notifications waiting to be sent to a phone: about a day at most, and the text is a fixed phrase.'),
      li('reports and the moderators\' log: we have no set date for deleting them. when an account is deleted they stop being linked to it, but the copy of the reported text (which can include screen names) stays.'),
      li('a photo hidden because of a report, or by a moderator: it stays, out of sight, until a moderator decides what happens to it, even if you delete the post or your account.'),
      li('where the law requires it, we keep material, and information about it, for as long as the law says, even after the item or the account it came from has been deleted.'),
      li('Cloudflare and Resend keep their own logs and backups under their own rules, so a deleted item may linger there for a short time.')),

    h('h2', { text: 'who can see what' }),
    h('ul', null,
      li('other members see your page as your privacy settings allow: you can make it private so people have to ask to follow you, limit who can message you, and hide your age and star sign. your email and birthday are never shown.'),
      li('moderators can see reports, held sign-ups and their signals, AI scores and strikes, and photos. their tools don\'t let them browse private messages: a message reaches them only if someone reports it, and then the person who runs the site may read the messages around it in that chat, by hand, to understand the report. like on any site, whoever runs the database could technically read what is in it.')),

    h('h2', { text: 'members under 18' }),
    h('ul', null,
      li(`you have to be ${S.minAge} or older to join. a sign-up with a younger birthday is refused. if you think a member is under that age, Report them ("this person may be under the minimum age") and a moderator will look.`),
      li('ourspace\'s suggestions (Browse: for you, mutuals, who to follow) never put a member under 18 in front of an adult, or an adult in front of a member under 18. that is about what the site suggests: pages and boards follow the privacy settings above.'),
      li('there are no ads, and no data about members of any age is sold.'),
      li('a parent or guardian who wants to ask about a child\'s account can ' + reach() + '.')),

    h('h2', { text: 'deleting your account' }),
    h('p', { text: 'in Settings (on the website or in the app), "delete my account" asks for your password (or, if you sign in only with Google or Discord, your screen name). it can\'t be undone, and it deletes at once, apart from what has to stay (below): your page and profile, your posts and the comments others left on your page and on your board threads, your messages (and your direct chats, for both people), your follows, likes, blocks, bookmarks and connections, your login sessions and phones, your photos, your Spotify connection, your sign-up signals, your AI scans and strikes, and your email address and birthday.' }),
    h('p', { text: 'what stays: reports you made or that were made about you (a copy of the reported text, no longer linked to your account), the moderators\' log, moderator alerts that name your member number, and any photo a moderator is holding as evidence (out of sight and no longer linked to you). where the law requires it, we also keep material, and information about it, even after you delete your account. what others wrote in replies and quotes is theirs.' }),
    h('p', { text: 'if you can\'t log in and need something deleted, ' + reach() + '.' }),

    h('h2', { text: 'your choices' }),
    h('ul', null,
      li('in Settings you can make your page private, hide your age and star sign, choose who may message you and follow you, block people, disconnect Google, Discord or Spotify, and delete your account.'),
      li('turn notifications off in your phone\'s settings, or log out in the app. logging out ends that phone\'s sign-in and deletes its notification token from our records. if the phone couldn\'t reach us when you logged out, notifications can keep arriving until that sign-in runs out (up to 90 days), or until you change your password or delete your account.'),
      li('to ask what we hold about you, or to fix something you can\'t fix yourself, ' + reach() + ', and a person will answer.')),

    h('h2', { text: 'changes to this policy' }),
    h('p', { text: 'we may change this policy as ourspace changes. the date at the top says when it last changed, and if a change matters we\'ll tell members on the site.' }),
    ...contactSection('questions about your privacy?')));
}
