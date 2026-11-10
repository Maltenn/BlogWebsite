/* widgets/privatecard.js — what you get instead of someone's posts when their page is private and you don't follow them. */

import { h } from '../core/dom.js';
import { S } from '../core/state.js';
import { followButton } from './followbutton.js';

// user: { name }. relation: the profile's relation (null when logged out). opts.onChange(relation) after a follow change.
export function privateCard(user, relation, opts = {}) {
  const pending = relation && relation.following === 'pending';
  return h('div', { class: 'ms-privatecard' },
    h('div', { class: 'ms-privatelock', text: '🔒' }),
    h('div', null,
      h('b', { text: `this profile is private — follow to see their posts.` }),
      h('p', { text: pending ? `you've asked to follow ${user.name}. their posts show up here once they say yes.`
        : S.me ? `${user.name} approves each follower. ask, and their statuses, blog and comments are yours once they say yes.`
        : `log in (or join) and ask to follow ${user.name}. their statuses, blog and comments show up here once they say yes.` }),
      opts.noButton ? null : followButton(user, relation, { isPrivate: true, onChange: opts.onChange })));
}
