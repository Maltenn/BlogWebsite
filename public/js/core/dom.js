/* core/dom.js — building the page. Everything people wrote goes on it
   with textContent (never innerHTML). */

// h('div', { class: 'x', text: 'hi', onclick: fn }, child, 'text', [more]) → element
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (['value', 'checked', 'disabled', 'selected', 'maxLength', 'rows', 'loading'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const content = () => $('#ms-content');
export const enc = encodeURIComponent;
export const userPath = name => '/u/' + enc(name);
export const poss = name => name + (/s$/i.test(name) ? "'" : "'s");
