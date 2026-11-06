// Just enough of a browser for the page code in public/js to run under node: elements with children, attributes,
// classes, styles and click events, text nodes, document, location, history, and fetch answered by the test. No layout
// and no innerHTML (the pages never use it). Used by frontend.test.mjs.

class Node {
  constructor() { this.parentNode = null; this.childNodes = []; }
  remove() { if (this.parentNode) this.parentNode.drop(this); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
}

class Text extends Node {
  constructor(data) { super(); this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  get names() { return this.el.className.split(/\s+/).filter(Boolean); }
  contains(c) { return this.names.includes(c); }
  add(...cs) { this.el.className = [...new Set([...this.names, ...cs])].join(' '); }
  remove(...cs) { this.el.className = this.names.filter(n => !cs.includes(n)).join(' '); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

// selectors: tag, .class, #id, or a mix (a.ms-mention), with commas, and a space for "somewhere inside" (.box a)
function matches(el, sel) {
  return sel.split(',').some(one => {
    const parts = one.trim().split(/\s+/);
    if (parts.length > 1) {
      if (!matches(el, parts.pop())) return false;
      let up = el.parentNode;
      while (parts.length && up instanceof Element) { if (matches(up, parts[parts.length - 1])) parts.pop(); up = up.parentNode; }
      return !parts.length;
    }
    const m = one.trim().match(/^([a-z0-9]*)((?:[.#][\w-]+)*)$/i);
    if (!m) throw new Error('fake-dom can\'t match ' + one);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    return (m[2].match(/[.#][\w-]+/g) || []).every(p => (p[0] === '.' ? el.classList.contains(p.slice(1)) : el.id === p.slice(1)));
  });
}

class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.className = '';
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }
  get id() { return this.attributes.get('id') || ''; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  get textContent() { return super.textContent; }
  set textContent(v) { this.replaceChildren(...(String(v) === '' ? [] : [String(v)])); }
  get children() { return this.childNodes.filter(n => n instanceof Element); }
  get firstChild() { return this.childNodes[0] || null; }
  append(...kids) {
    for (const k of kids) {
      const n = k instanceof Node ? k : new Text(k);
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  prepend(...kids) {
    const rest = this.childNodes.slice();
    this.replaceChildren(...kids, ...rest);
  }
  replaceChildren(...kids) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...kids);
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    n.remove();
    p.childNodes.splice(p.childNodes.indexOf(this), 1, n);
    n.parentNode = p;
    this.parentNode = null;
  }
  drop(n) { this.childNodes = this.childNodes.filter(x => x !== n); n.parentNode = null; }
  contains(n) {
    for (; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  matches(sel) { return matches(this, sel); }
  closest(sel) {
    for (let e = this; e instanceof Element; e = e.parentNode) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = e => e.children.forEach(k => { if (k.matches(sel)) out.push(k); walk(k); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  // the event goes to the element, then up through its parents, then to the document
  dispatch(type, extra = {}) {
    let stopped = false;
    const ev = { type, target: this, button: 0, preventDefault() {}, stopPropagation() { stopped = true; }, ...extra };
    for (let e = this; e && !stopped; e = e.parentNode) for (const fn of e.listeners?.[type] || []) fn(ev);
    if (!stopped) for (const fn of doc.listeners[type] || []) fn(ev);
  }
  click() { this.dispatch('click'); }
  focus() {}
  blur() {}
  scrollIntoView() {}
}

const doc = {
  listeners: {},
  createElement: tag => new Element(tag),
  createTextNode: t => new Text(t),
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); },
  // an event straight to the document's listeners (a key press: dispatch('keydown', { key: 'Escape' }))
  dispatch(type, extra = {}) {
    let stopped = false;
    const ev = { type, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; }, ...extra };
    for (const fn of [...(this.listeners[type] || [])]) { if (stopped) break; fn(ev); }
  },
  querySelector: sel => doc.body.querySelector(sel),
  querySelectorAll: sel => doc.body.querySelectorAll(sel),
};

// A WebSocket the test drives by hand: FakeSocket.all is every one made (newest last); .open() / .emit(event) / .shut(code)
// play what the server does; .sent is what the page sent. Put it in place with globalThis.WebSocket = FakeSocket.
export class FakeSocket {
  static all = [];
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; FakeSocket.all.push(this); }
  send(data) { this.sent.push(data); }
  close(code) { this.shut(code); }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  emit(event) { this.onmessage && this.onmessage({ data: typeof event === 'string' ? event : JSON.stringify(event) }); }
  shut(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({ code }); }
}

// A fake Response for fetch.
export const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

// Puts the pretend browser in place: document (with a #toasts box), Node, window, location, history and a fetch that
// asks `onFetch(method, path, body)` (path without /api) for its answer, which may be a promise. Timers are unref'd so a
// toast's five seconds don't keep the test run alive.
export function installDom(onFetch = () => answer(404, { error: 'not here' })) {
  doc.body = new Element('body');
  doc.head = new Element('head');
  const toasts = new Element('div');
  toasts.setAttribute('id', 'toasts');
  doc.body.append(toasts);
  const location = { pathname: '/', search: '', origin: 'http://localhost', hash: '', href: 'http://localhost/', protocol: 'http:', host: 'localhost' };
  const timer = globalThis.setTimeout;
  const every = globalThis.setInterval;
  Object.assign(globalThis, {
    document: doc, Node, location,
    window: { scrollTo() {}, addEventListener() {}, removeEventListener() {}, getSelection: () => null, location },
    history: { pushState() {}, replaceState() {} },
    setTimeout: (fn, ms, ...args) => { const t = timer(fn, ms, ...args); t.unref?.(); return t; },
    setInterval: (fn, ms, ...args) => { const t = every(fn, ms, ...args); t.unref?.(); return t; },     // a page's refresh timer doesn't keep the run alive either
  });
  const dom = {
    onFetch,
    // let every answer that's ready arrive, and the code waiting on it run
    settle: () => new Promise(res => timer(res, 0)),
  };
  globalThis.fetch = async (url, init = {}) => dom.onFetch(init.method || 'GET', String(url).replace(/^\/api/, ''), init.body ? JSON.parse(init.body) : undefined);
  return dom;
}
