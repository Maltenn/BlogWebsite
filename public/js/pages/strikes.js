/* pages/strikes.js — /me/strikes: the AI-writing strikes on your account. Each one with the text that was flagged, its
   score, when it happened and when it stops counting, what it led to, and an appeal (one per strike, with a note).
   GET /api/me/strikes, POST /api/me/strikes/:id/appeal. */

import { h, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago } from '../core/format.js';
import { toast, oops, pageTitle } from '../core/ui.js';
import { S, loadMe } from '../core/state.js';
import { blogPath } from '../widgets/postlinks.js';

export const STEP = { warning: 'a warning', timeout: 'a posting timeout', review: 'a moderator\'s review' };
const STATUS = { active: 'counting', appealed: 'appeal sent', removed: 'removed', expired: 'expired' };

// the sentence about an appeal's state
export function appealLine(a) {
  if (!a) return '';
  if (a.result === 'removed') return `you appealed ${when(a.at)}. a moderator agreed: this strike was removed${a.decidedAt ? ' ' + when(a.decidedAt) : ''}.`;
  if (a.result === 'upheld') return `you appealed ${when(a.at)}. a moderator looked and the strike stands${a.decidedAt ? ' (' + when(a.decidedAt) + ')' : ''}.`;
  return `you appealed ${when(a.at)}. a moderator will decide soon; any timeout stands until then.`;
}

function strikeCard(s) {
  const post = s.post && !s.post.deleted && (s.post.kind === 'status' || s.post.kind === 'reply' || s.post.kind === 'quote' || s.post.kind === 'blog')
    ? h('a', { href: s.post.kind === 'blog' ? blogPath(S.me.name, s.post.id) : userPath(S.me.name) + '/post/' + s.post.id, text: 'see the post' }) : null;
  const timeout = s.timeout ? (s.timeout.until > Date.now() ? `posting paused until ${when(s.timeout.until)}` : 'its posting timeout is over') : null;
  const card = h('div', { class: 'mod-report st-strike' + (s.counting ? '' : ' closed'), dataset: { id: String(s.id), status: s.status } },
    h('div', { class: 'mod-head' },
      h('span', { class: 'mod-reason', text: `strike ${s.level}: ${STEP[s.step] || s.step}` }),
      h('span', { class: 'ms-chip', text: STATUS[s.status] || s.status }),
      h('span', { class: 'ms-time', title: when(s.created), text: ago(s.created) })),
    s.text ? h('div', { class: 'mod-snap', text: s.text }) : h('div', { class: 'mod-meta', text: '(the text was cleared 30 days after this strike stopped counting.)' }),
    h('div', { class: 'mod-meta' },
      `scored ${Math.round(s.score * 100)}% likely AI-written · ${when(s.created)} · `,
      s.counting ? `counts until ${when(s.expires)}` : s.status === 'removed' ? 'removed' : `stopped counting ${when(s.expires)}`,
      timeout ? ' · ' + timeout : '', post ? ' · ' : '', post),
    s.appeal ? h('div', { class: 'ms-note st-appeal' }, h('b', { text: appealLine(s.appeal) }), h('div', { class: 'os-hint st-note', text: s.appeal.note ? 'what you said: ' + s.appeal.note : '' })) : null);
  if (s.canAppeal) {
    const note = h('textarea', { class: 'os-input', rows: 4, maxLength: 1000, 'aria-label': 'why this was your own writing', placeholder: 'tell the moderators why this was your own writing: how you wrote it, drafts, anything that helps.' });
    const send = h('button', { class: 'btn98 go', type: 'submit', text: 'Send appeal' });
    const form = h('form', { class: 'os-form st-form', onsubmit: async e => {
      e.preventDefault();
      if (!note.value.trim()) { oops(new Error('tell the moderators why this was your own writing.')); return; }
      send.disabled = true;
      try {
        const r = await api.post(`/me/strikes/${s.id}/appeal`, { note: note.value.trim() });
        toast('appeal sent. a moderator will look at it.');
        card.replaceWith(strikeCard(r.strike));
        loadMe().catch(() => {});
      } catch (ex) { oops(ex); send.disabled = false; }
    } }, note, h('div', { class: 'row' }, send, h('span', { class: 'os-hint', text: 'one appeal per strike. a moderator reads every one.' })));
    form.hidden = true;
    const open = h('button', { class: 'btn98', type: 'button', text: 'Appeal this strike', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) note.focus(); } });
    card.append(h('div', { class: 'mod-btns' }, open), form);
  }
  return card;
}

export async function renderStrikes(root) {
  const d = await api.get('/me/strikes');
  root.append(pageTitle('My strikes', h('a', { class: 'btn98', href: '/settings', text: 'Settings' })));
  root.append(h('div', { class: 'ms-note', text: 'ourspace is for people writing in their own words. long public posts are checked for text that looks written by an AI. a flagged post stays up. the first strike is a warning, then posting pauses for a day, a week, a month, and after that a moderator decides. strikes stop counting after 90 clean days.' }));
  if (d.detector === 'off') root.append(h('div', { class: 'ms-note st-mode', text: 'the AI-writing check is switched off on this server right now, so nobody gets strikes.' }));
  else if (d.enforcement === 'shadow') root.append(h('div', { class: 'ms-note st-mode', text: 'the AI-writing check is in test mode: posts are scored so the moderators can see how well it works, but nobody is struck. no new strikes are given while this note is here.' }));
  if (d.timeoutUntil && d.timeoutUntil > Date.now()) root.append(h('div', { class: 'ms-error st-timeout', text: `posting and commenting are paused until ${when(d.timeoutUntil)}. you can still read, like, follow and chat.` }));
  if (!d.strikes.length) { root.append(h('div', { class: 'ms-empty', text: 'no strikes. ✨' })); return; }
  d.strikes.forEach(s => root.append(strikeCard(s)));
}
