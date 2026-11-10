/* widgets/hide.js — "not interested" (✕): hides a suggestion with Undo. It writes browse_hidden and nothing else. */

import { h, enc } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast, oops } from '../core/ui.js';
import { S } from '../core/state.js';
import { needLogin } from '../core/router.js';

// kind: 'person' | 'board' | 'post'; ref: user id, slug or post id; el: what goes while it's hidden (back on Undo)
export function hideButton(kind, ref, el, label = 'not interested') {
  const url = `/browse/hidden/${kind}/${enc(ref)}`;
  const btn = h('button', { class: 'btn98 ms-hidebtn', type: 'button', title: label, 'aria-label': label, text: '✕' });
  btn.addEventListener('click', async () => {
    if (!S.me) { needLogin(); return; }
    btn.disabled = true;
    try {
      await api.post(url);
      el.hidden = true;
      toast('okay, hidden. click here to undo.', false, async () => {
        try { await api.del(url); el.hidden = false; } catch (e) { oops(e); }
      });
    } catch (e) { oops(e); }
    btn.disabled = false;
  });
  return btn;
}
