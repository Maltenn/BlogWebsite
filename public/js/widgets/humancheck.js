/* widgets/humancheck.js — "verify you are a person", for sign-up, finishing a sign-up, log in and password reset
   (src/trust/form.js, src/trust/turnstile.js). One of these per form:

     const hc = humanCheck('signup');          // 'signup' | 'finish' | 'login' | 'reset'
     form.append(hc.el);                       // the hidden honeypot, Turnstile's box and the "checking…" line
     onLeave(hc.destroy);                      // stops the proof of work and removes the widget when the page is left
     body = { ...fields, ...await hc.payload() };   // waits for the check to finish; throws a friendly Error if it can't
     catch (e) { err.textContent = hc.refused(e); }  // says what went wrong, and gets a fresh form / widget when needed

   The form (GET /api/form/:purpose) is fetched at once and the proof of work starts in the background; the Turnstile
   widget (loaded from challenges.cloudflare.com, the one outside script the site allows) is drawn when its script is
   there. The honeypot is a text input with a name that changes on every load, in an aria-hidden wrapper moved off-screen
   by a class (never display:none: bots skip those), tabindex -1, autocomplete off. */

import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { solvePow } from './pow.js';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const BLOCKED = 'the "verify you are human" box couldn\'t load from Cloudflare. if you use an ad or tracker blocker, allow challenges.cloudflare.com for this site, then reload the page.';

// what each refusal from the server means for a person (anything else shows the server's own words)
export const REFUSALS = {
  disposable_email: 'please use a regular email address. throwaway addresses can\'t be used here: we send your confirmation link to it.',
  form: 'that form went stale. we loaded a fresh one: send it again in a moment.',
  form_expired: 'that form went stale. we loaded a fresh one: send it again in a moment.',
  form_used: 'that form was already used. we loaded a fresh one: send it again in a moment.',
  too_fast: 'whoa, that was fast! check your details, then send it again.',
  pow: 'your browser hadn\'t finished its check yet. wait for the "checking" line to finish, then send it again.',
  turnstile: 'the "verify you are human" check didn\'t go through. do it again, then send it.',
  turnstile_unavailable: 'we couldn\'t run the human check just now. try again in a minute.',
  automation: 'automated sign-ups aren\'t allowed here. please create your account yourself, in a browser.',
};
const FRESH_FORM = ['form', 'form_expired', 'form_used', 'too_fast', 'pow', 'automation', 'disposable_email', 'email_domain', 'turnstile', 'turnstile_unavailable'];

let script = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!script) {
    script = new Promise((resolve, reject) => {
      const s = h('script', { src: TURNSTILE_SRC, async: true });
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error(BLOCKED)));
      s.onerror = () => { script = null; reject(new Error(BLOCKED)); };
      document.head.append(s);
    });
  }
  return script;
}

export function humanCheck(purpose) {
  const el = h('div', { class: 'hc' });
  const slot = h('div', { class: 'hc-widget' });
  const status = h('div', { class: 'hc-status', role: 'status' });
  el.append(slot, status);
  let gen = 0, dead = false;
  let form = null, honey = null, openedAt = 0;
  let controller = null, widget = null, tsToken = null, tsWait = null, tsGive = null;
  let working = null, problem = '';
  const say = (text, state = '') => { status.textContent = text; status.className = 'hc-status' + (state ? ' ' + state : ''); };

  const stopWidget = () => {
    try { if (widget != null && window.turnstile) window.turnstile.remove(widget); } catch { /* already gone */ }
    widget = null;
    tsToken = null;
    slot.replaceChildren();
  };
  const newWait = () => { tsWait = new Promise(res => { tsGive = res; }); };

  async function load() {
    const mine = ++gen;
    if (controller) controller.abort();
    controller = new AbortController();
    stopWidget();
    if (honey) honey.wrapper.remove();
    form = honey = null;
    problem = '';
    newWait();
    say('checking you\'re a person…');
    let f;
    try { f = await api.get('/form/' + purpose); } catch (e) {
      if (mine !== gen || dead) return;
      problem = e.message;
      say(e.message, 'bad');
      return;
    }
    if (mine !== gen || dead) return;
    form = f;
    openedAt = Date.now();
    if (f.honeypot) {
      const input = h('input', { type: 'text', name: f.honeypot, tabindex: '-1', autocomplete: 'off' });
      honey = { input, wrapper: h('div', { class: 'hc-hp', 'aria-hidden': 'true' }, input) };
      el.prepend(honey.wrapper);
    }
    working = f.pow ? solvePow(f.token, f.pow.bits, { signal: controller.signal, onProgress: p => { if (mine === gen) say(`checking you're a person… ${Math.round(p * 100)}%`); } }) : Promise.resolve(null);
    working.catch(() => {});
    if (f.turnstile) {
      loadTurnstile().then(ts => {
        if (mine !== gen || dead) return;
        widget = ts.render(slot, {
          sitekey: f.turnstile.siteKey, action: f.turnstile.action, theme: 'light', size: slot.clientWidth && slot.clientWidth < 300 ? 'compact' : 'normal',
          callback: token => { tsToken = token; tsGive(token); },
          'expired-callback': () => { tsToken = null; newWait(); },
          'error-callback': () => { tsToken = null; },
        });
      }).catch(e => { if (mine === gen && !dead) { problem = e.message; say(e.message, 'bad'); tsGive(null); } });
    }
    if (f.pow) {
      working.then(() => { if (mine === gen && !problem) say('✓ checked: you look like a person.', 'ok'); },
        e => { if (mine === gen && !e.aborted) say('the browser check failed: ' + e.message, 'bad'); });
    } else say('');
  }
  const loading = load();

  return {
    el,
    ready: () => loading,
    // everything the server wants from the form, to merge into the request body. Waits for the proof of work, for the
    // Turnstile token (up to 12 s) and for the form's minimum open time; throws an Error with a message for a person.
    async payload() {
      await loading;
      if (!form) throw new Error(problem || 'the check didn\'t load. reload the page and try again.');
      const mine = gen;
      const out = {};
      if (form.pow) {
        if (mine === gen) say('checking you\'re a person…');
        out.pow = await working;
        out.form = form.token;
        out[form.honeypot] = honey ? honey.input.value : '';
        const wait = form.minMs + 400 - (Date.now() - openedAt);
        if (wait > 0) await new Promise(res => setTimeout(res, wait));
      }
      if (form.turnstile) {
        if (!tsToken && !problem) {
          say('waiting for the "verify you are human" box…');
          await Promise.race([tsWait, new Promise(res => setTimeout(res, 12000))]);
        }
        if (mine !== gen) throw new Error('the form was refreshed. send it again.');
        if (!tsToken) {
          const msg = problem || 'please finish the "verify you are human" check first.';
          say(msg, 'bad');
          throw new Error(msg);
        }
        out.turnstile = tsToken;
      }
      if (form.pow) say('✓ checked: you look like a person.', 'ok');
      return out;
    },
    // a failed send: the words to show. Refused for a reason the form can't survive (stale, used, failed check…), the
    // form is fetched again and Turnstile redrawn; on log in / reset every failure spends the Turnstile token, so it resets.
    refused(err) {
      const text = (err.code && err.code !== 'email_domain' && REFUSALS[err.code]) || err.message;
      if (dead) return text;
      if (purpose === 'login' || purpose === 'reset') {
        if (widget != null && window.turnstile) { try { window.turnstile.reset(widget); } catch { /* gone */ } }
        tsToken = null;
        newWait();
      } else if ((err.code && FRESH_FORM.includes(err.code)) || err.status >= 500) load();
      return text;
    },
    reload: load,
    destroy() {
      dead = true;
      gen++;
      if (controller) controller.abort();
      stopWidget();
    },
  };
}
