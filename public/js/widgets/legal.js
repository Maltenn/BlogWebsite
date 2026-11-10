/* widgets/legal.js — the pieces /rules, /terms and /privacy share: the contact address (S.contact, from /api/me, the
   CONTACT_EMAIL setting: while it's unset the pages show no address and say nothing that needs one), the "last
   updated" line, and the list helpers. */

import { h } from '../core/dom.js';
import { S } from '../core/state.js';

// bump this when the text of /terms or /privacy changes in a way a member should hear about
export const LEGAL_UPDATED = 'november 2026';

export const li = t => h('li', { text: t });
export const updatedLine = () => h('p', { class: 'os-hint', text: `last updated ${LEGAL_UPDATED}.` });

// the address as a mailto link, or null while none is set. (mailto: is not a same-origin link, so the router leaves it
// to the browser, and to the phone's mail app in the apps.)
export const emailLink = () => (S.contact ? h('a', { href: 'mailto:' + S.contact, text: S.contact }) : null);

// "write to us at <address>" with `lead` and `tail` around it, or nothing at all while no address is set
export const writeToUs = (lead, tail = '.') => (S.contact ? h('p', null, lead, emailLink(), tail) : null);

// how to ask us something, for the sentences that used to say "write to us (see contact, below)": that is only true once
// an address is set. Until then the one way to reach us is Report, so the sentence says so.
export const reach = () => (S.contact ? 'write to us (see contact, below)' : 'use Report on the site (see contact, below)');

// the contact section: members always have Report; the address is added once the owner has set one
export function contactSection(about) {
  return [
    h('h2', { text: 'contact' }),
    h('p', { text: `${about} if you're signed in and it is about a person or something they posted, use Report, on every page, post, comment and message: it goes straight to the moderators.` }),
    writeToUs('you can also write to ', ". you don't need an account for that.") || h('p', { text: 'there is no contact address yet. until there is, Report is the only way to reach us.' }),
  ];
}
