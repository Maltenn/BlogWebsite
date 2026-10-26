/* widgets/modqueues.js — the phase 7 sections of the Moderation page: sign-ups held for a look (approve / refuse with a
   reason), alerts (clusters, duplicate text, ban reviews: dismiss / release / ban), AI-strike appeals (uphold / remove) and
   the AI scans list (every score, with what it led to). Each section loads and redraws itself. */

import { h, userPath } from '../core/dom.js';
import { api } from '../core/api.js';
import { when, ago } from '../core/format.js';
import { toast, oops, dialog, errorCard } from '../core/ui.js';
import { loadMe } from '../core/state.js';
import { nameLink } from './people.js';
import { blogPath } from './postlinks.js';

const STEP = { warning: 'a warning', timeout: 'a posting timeout', review: 'a moderator\'s review' };

// a dialog with a text box: → the text, or null when cancelled (or empty when it is required)
export async function askNote({ title, text, ok = 'OK', danger = false, required = false, label = 'note for the log' + (required ? '' : ' (optional)') }) {
  const box = h('input', { class: 'os-input', maxLength: 500, 'aria-label': label, placeholder: label });
  const yes = await dialog({ title, text, icon: danger ? '⚠' : '❔', ok, danger, body: box });
  if (!yes) return null;
  const v = box.value.trim();
  if (required && !v) { oops(new Error('a reason is needed.')); return null; }
  return v;
}

const postHref = (p, author) => (p && !p.deleted && author && p.kind === 'blog' ? blogPath(author.name, p.id)
  : p && !p.deleted && author && ['status', 'reply', 'quote'].includes(p.kind) ? userPath(author.name) + '/post/' + p.id : null);

// one titled section that loads itself: build(body, redraw) fills `body`; a failed load says so in the section
function section(title, hint, build) {
  const body = h('div', { class: 'mod-q-body' });
  const box = h('div', { class: 'os-panel mod-q' }, h('div', { class: 'ms-boxtitle', text: title }), hint ? h('div', { class: 'os-hint mod-q-hint', text: hint }) : null, body);
  const draw = async () => {
    try { await build(body, draw); } catch (e) { body.replaceChildren(errorCard(e)); }
  };
  draw();
  return box;
}
const done = async (draw, said) => { toast(said); loadMe().catch(() => {}); await draw(); };

/* ---- held sign-ups ---- */
const REASON = {
  hosting_network: 'cloud / hosting network', same_network_24h: 'same network signed up today', provider_burst: 'provider burst',
  domain_burst: 'email domain burst', fast_form: 'filled the form fast', old_protocol_browser: 'old protocol from a browser', no_accept_language: 'no language header',
  no_verified_email: 'signed in with a provider that vouched for no email',
};
function heldSection() {
  return section('⏳ held sign-ups', 'new accounts the checks scored 3 or more (or that signed in with a provider vouching for no email). they can set up a page but not post, comment or message until you approve them.', async (body, draw) => {
    const { accounts } = await api.get('/admin/held');
    if (!accounts.length) { body.replaceChildren(h('div', { class: 'ms-empty', text: 'nobody is waiting. ✨' })); return; }
    body.replaceChildren(...accounts.map(a => {
      const net = a.network || {};
      return h('div', { class: 'mod-report mod-held', dataset: { name: a.user.name } },
        h('div', { class: 'mod-head' }, nameLink(a.user), h('span', { class: 'ms-chip', text: `risk ${a.risk}` }), h('span', { class: 'ms-time', text: ago(a.created) })),
        h('div', { class: 'mod-meta' },
          `email ${a.verified ? 'confirmed' : 'not confirmed'} · @${a.emailDomain || '?'} · `,
          [net.asOrg, net.asn ? 'AS' + net.asn : null, net.country].filter(Boolean).join(' · ') || 'network unknown',
          a.formMs != null ? ` · form open ${(a.formMs / 1000).toFixed(1)}s` : ''),
        h('div', { class: 'mod-meta', text: 'why: ' + ((a.reasons || []).map(r => REASON[r] || r).join(', ') || '—') }),
        h('div', { class: 'mod-btns' },
          h('button', { class: 'btn98 go', type: 'button', text: '✔ approve', onclick: async () => {
            try { await api.post('/admin/held/' + encodeURIComponent(a.user.name), { action: 'approve', reason: '' }); await done(draw, `${a.user.name} approved.`); } catch (e) { oops(e); }
          } }),
          h('button', { class: 'btn98 danger', type: 'button', text: '⛔ refuse…', onclick: async () => {
            const reason = await askNote({ title: 'Refuse sign-up', text: `Refuse ${a.user.name}? The account is suspended (a ban). Say why: it goes in the log, and the member can ask about it.`, ok: 'Refuse', danger: true, required: true, label: 'reason' });
            if (!reason) return;
            try { await api.post('/admin/held/' + encodeURIComponent(a.user.name), { action: 'refuse', reason }); await done(draw, `${a.user.name} refused.`); } catch (e) { oops(e); }
          } })));
    }));
  });
}

/* ---- alerts ---- */
const ALERT = { cluster: 'sign-up cluster', duplicate: 'duplicate text', held_signup: 'held sign-up', ban_review: 'ban review (5th strike)' };
const RULE = { same_network: 'one network', hosting_burst: 'cloud network burst', same_moment: 'many at the same moment', email_domain: 'one email domain', same_text: 'same text' };
function alertsSection() {
  return section('🚨 alerts', 'clusters of sign-ups, text several new accounts posted at once, and members on their fifth strike. nothing here is banned automatically.', async (body, draw) => {
    const { alerts } = await api.get('/admin/alerts?status=open');
    if (!alerts.length) { body.replaceChildren(h('div', { class: 'ms-empty', text: 'no open alerts. ✨' })); return; }
    body.replaceChildren(...alerts.map(a => {
      const act = async (action, said, extra) => {
        try { await api.post('/admin/alerts/' + a.id, { action, note: extra || '' }); await done(draw, said); } catch (e) { oops(e); }
      };
      const detail = Object.entries(a.details || {}).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ');
      return h('div', { class: 'mod-report mod-alert', dataset: { id: String(a.id), kind: a.kind } },
        h('div', { class: 'mod-head' }, h('span', { class: 'mod-reason', text: ALERT[a.kind] || a.kind }), a.rule ? h('span', { class: 'ms-chip', text: RULE[a.rule] || a.rule }) : null, h('span', { class: 'ms-time', text: ago(a.created) })),
        a.users.length ? h('div', { class: 'mod-meta' }, 'accounts: ', a.users.flatMap((u, i) => [i ? ', ' : '', nameLink(u), u.banned ? ' (banned)' : u.held ? ' (held)' : ''])) : null,
        a.posts.map(p => h('div', { class: 'mod-snap', dataset: { state: p.held ? 'held' : p.hidden ? 'hidden' : 'shown' } },
          h('div', { class: 'os-hint', text: `${p.kind} by ${p.author ? p.author.name : '?'}${p.held ? ' (held: waiting for you)' : ''}${p.hidden ? ' (hidden by a moderator)' : ''}${p.deleted ? ' (deleted)' : ''}` }),
          p.excerpt, postHref(p, p.author) ? h('div', null, h('a', { href: postHref(p, p.author), text: 'open the post' })) : null)),
        detail ? h('div', { class: 'mod-meta', text: detail }) : null,
        h('div', { class: 'mod-btns' },
          a.kind === 'duplicate' && a.posts.some(p => p.held) ? h('button', { class: 'btn98 go', type: 'button', text: '👁 release (show the held posts)', onclick: () => act('release', 'released: the held posts are visible again. posts a moderator hid stay hidden.') }) : null,
          a.kind === 'ban_review' ? h('button', { class: 'btn98 danger', type: 'button', text: '⛔ ban…', onclick: async () => {
            const who = a.users[0] ? a.users[0].name : 'this member';
            const note = await askNote({ title: 'Ban', text: `Ban ${who}? They are logged out, can't log in, and what they wrote disappears. It can be undone from Moderation.`, ok: 'Ban', danger: true });
            if (note !== null) act('ban', `${who} banned.`, note);
          } }) : null,
          h('button', { class: 'btn98', type: 'button', text: '✔ dismiss', onclick: () => act('dismiss', 'dismissed.') })));
    }));
  });
}

/* ---- AI-strike appeals ---- */
function appealsSection() {
  return section('✋ strike appeals', 'a member says a flagged post was their own writing. upholding keeps the strike; removing it ends its timeout at once and exempts them from automatic strikes for 180 days.', async (body, draw) => {
    const { strikes } = await api.get('/admin/appeals');
    if (!strikes.length) { body.replaceChildren(h('div', { class: 'ms-empty', text: 'no appeals waiting. ✨' })); return; }
    body.replaceChildren(...strikes.map(s => {
      const decide = (action, said) => async () => {
        const note = await askNote({ title: action === 'remove' ? 'Remove strike' : 'Uphold strike', text: action === 'remove' ? `Remove strike ${s.level} from ${s.user.name}? Its timeout ends now.` : `Keep strike ${s.level} on ${s.user.name}?`, ok: action === 'remove' ? 'Remove it' : 'Uphold it' });
        if (note === null) return;
        try { await api.post('/admin/strikes/' + s.id, { action, note }); await done(draw, said); } catch (e) { oops(e); }
      };
      return h('div', { class: 'mod-report mod-appeal', dataset: { id: String(s.id) } },
        h('div', { class: 'mod-head' }, nameLink(s.user), h('span', { class: 'mod-reason', text: `strike ${s.level}: ${STEP[s.step] || s.step}` }), h('span', { class: 'ms-time', text: s.appeal ? 'appealed ' + ago(s.appeal.at) : '' })),
        h('div', { class: 'mod-snap', text: s.text || '(text cleared)' }),
        h('div', { class: 'mod-meta', text: `scored ${Math.round(s.score * 100)}% (${s.label}, ${s.model}) · flagged ${when(s.created)}` }),
        s.appeal ? h('div', { class: 'mod-meta' }, h('b', { text: 'they say: ' }), s.appeal.note) : null,
        h('div', { class: 'mod-btns' },
          h('button', { class: 'btn98 go', type: 'button', text: '↩ remove the strike', onclick: decide('remove', 'strike removed.') }),
          h('button', { class: 'btn98', type: 'button', text: 'uphold it', onclick: decide('uphold', 'strike upheld.') })));
    }));
  });
}

/* ---- AI scans ---- */
const DECISIONS = ['', 'would_strike', 'strike', 'clear', 'same_incident', 'exempt', 'error'];
function scansSection() {
  let decision = '', next = null;
  const mode = h('div', { class: 'os-hint mod-q-hint' });
  const rows = h('div', { class: 'mod-scans' });
  const more = h('button', { class: 'btn98', type: 'button', text: 'show older', hidden: true });
  const pick = h('select', { 'aria-label': 'decision', onchange: () => { decision = pick.value; rows.replaceChildren(); next = null; load(); } },
    DECISIONS.map(d => h('option', { value: d, text: d ? d.replace('_', ' ') : 'every decision' })));
  const box = h('div', { class: 'os-panel mod-q' }, h('div', { class: 'ms-boxtitle', text: '🤖 AI scans' }), mode,
    h('div', { class: 'mod-pq-bar' }, pick), rows, h('div', { class: 'mod-btns' }, more));
  const row = x => {
    const link = x.post && postHref(x.post, x.user);
    return h('div', { class: 'mod-scan', dataset: { id: String(x.id), decision: x.decision } },
      h('span', { class: 'mod-scan-score', text: Math.round(x.score * 100) + '%' }),
      h('span', { class: 'ms-chip', text: x.label }),
      h('span', { class: 'ms-chip mod-scan-decision', text: x.decision.replace('_', ' ') }),
      nameLink(x.user), h('span', { class: 'os-hint', text: ` ${x.kind}, ${x.words} words · ${ago(x.created)} · ${x.model}` }),
      link ? h('a', { href: link, text: 'open' }) : null);
  };
  async function load() {
    more.disabled = true;
    try {
      const query = [next ? 'before=' + next : '', decision ? 'decision=' + decision : ''].filter(Boolean).join('&');
      const r = await api.get('/admin/ai-scans' + (query ? '?' + query : ''));
      mode.textContent = r.detector !== 'on' ? 'the detector is off: nothing is scored.' : r.enforcement === 'enforce' ? 'detector on, enforcing: a 95%+ AI score is a strike.' : 'detector on, in shadow mode: scores are recorded and nobody is struck. read these before switching to enforce.';
      rows.querySelectorAll('.ms-empty').forEach(e => e.remove());
      r.scans.forEach(x => rows.append(row(x)));
      next = r.next;
      more.hidden = !next;
      if (!rows.children.length) rows.append(h('div', { class: 'ms-empty', text: 'no scores yet.' }));
    } catch (e) { rows.append(errorCard(e)); more.hidden = true; }
    more.disabled = false;
  }
  more.addEventListener('click', load);
  load();
  return box;
}

export function modQueues() {
  return h('div', { class: 'mod-queues' }, heldSection(), alertsSection(), appealsSection(), scansSection());
}
