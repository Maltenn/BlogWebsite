/* widgets/followbutton.js — the Follow button: ★ Follow / ⏳ Requested / ✔ Following / 👥 Friends.
   It works from a `relation` ({ following, followsMe, friends, … }, null when logged out) and keeps itself up to date
   from the answers. Unfollowing a friend asks first; so does unfollowing someone whose page is private (following them
   again needs their yes). */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops, dialog } from '../core/ui.js';
import { S } from '../core/state.js';
import { needLogin } from '../core/router.js';

// where the two of you stand: 'none' | 'pending' | 'following' | 'friends'
function followState(rel) {
  if (!rel || rel.following === 'none') return 'none';
  if (rel.following === 'pending') return 'pending';
  return rel.friends ? 'friends' : 'following';
}

// opts.isPrivate: their page is private. opts.onChange(relation) runs after every change.
export function followButton(user, relation, opts = {}) {
  let rel = relation;
  let hover = false;
  const btn = h('button', { class: 'btn98 ms-followbtn', type: 'button' });
  const paint = () => {
    const st = followState(rel);
    btn.classList.toggle('go', st === 'none' || st === 'friends');
    btn.classList.toggle('pressed', st === 'pending');
    btn.dataset.state = st;
    if (st === 'none') btn.textContent = rel && rel.followsMe ? '★ Follow back' : '★ Follow';
    else if (st === 'pending') btn.textContent = '⏳ Requested';
    else if (st === 'following') btn.textContent = hover ? '✖ Unfollow' : '✔ Following';
    else btn.textContent = hover ? '✖ Unfollow' : '👥 Friends';
    btn.title = st === 'pending' ? 'click to cancel your request' : st === 'none' ? '' : 'click to unfollow';
  };
  const hoverTo = on => { hover = on; paint(); };
  btn.addEventListener('mouseenter', () => hoverTo(true));
  btn.addEventListener('mouseleave', () => hoverTo(false));
  btn.addEventListener('focus', () => hoverTo(true));
  btn.addEventListener('blur', () => hoverTo(false));
  btn.addEventListener('click', async () => {
    if (!S.me) { needLogin(); return; }
    const st = followState(rel);
    const url = '/follows/' + enc(user.name);
    if (st === 'friends' && !await dialog({ title: 'Unfollow', icon: '💔', ok: 'Unfollow', danger: true,
      text: `Stop following ${user.name}? You won't be friends any more.` })) return;
    if (st === 'following' && opts.isPrivate && !await dialog({ title: 'Unfollow', icon: '🔒', ok: 'Unfollow', danger: true,
      text: `${user.name}'s page is private. If you unfollow, you'll have to ask again (and they'll have to say yes).` })) return;
    btn.disabled = true;
    try {
      const r = st === 'none' ? await api.post(url) : await api.del(url);
      rel = r.relation;
      const now = followState(rel);
      toast(now === 'pending' ? `request sent. ${user.name} has to say yes.`
        : now === 'friends' ? `you and ${user.name} are friends!`
        : now === 'following' ? `you're following ${user.name}.`
        : st === 'pending' ? 'request cancelled.' : `you unfollowed ${user.name}.`);
      if (opts.onChange) opts.onChange(rel);
    } catch (e) { oops(e); }
    btn.disabled = false;
    hover = false;
    paint();
  });
  paint();
  return btn;
}
