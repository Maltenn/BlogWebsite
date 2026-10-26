/* core/api.js — the JSON API (/api/*, the Worker in src/). A failed call throws
   an Error with the server's message, .status and the server's .code (and .until for a posting timeout). A write the
   gate refuses (403 unverified / held / timeout) carries a clear message, so any page that shows the error shows that.
   A new post that was held for a quick review (the answer says held: true) says so in a toast. */

import { toast } from './ui.js';
import { when } from './format.js';

const HELD_POST = 'your post is held for a quick review. a moderator will look at it, usually within a day.';
export function gateMessage(code, until, fallback) {
  if (code === 'unverified') return 'confirm your email first: we sent you a link when you signed up. use "send it again" in the yellow bar at the top if it never came.';
  if (code === 'held') return 'a moderator will take a quick look at your new account, usually within a day. until then you can set up your page and look around.';
  if (code === 'timeout') return `you can't post or comment until ${until ? when(until) : 'your posting timeout ends'}. you can still read, like and chat.`;
  return fallback;
}   // (the server's own words for every other refusal)

export const api = {
  async call(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const code = data && data.code;
      const e = new Error(gateMessage(code, data && data.until, data && data.error) || `something went wrong (${res.status})`);
      e.status = res.status;
      if (code) e.code = code;
      if (data && data.until) e.until = data.until;
      throw e;
    }
    if (method === 'POST' && data && data.held === true && !path.startsWith('/signup')) toast(HELD_POST);   // (a held sign-up is handled by its page)
    return data;
  },
  // A photo: the raw file as the body (Content-Type image/…), so the Worker sees exactly the bytes. fetch can't report
  // upload progress, so this one uses XMLHttpRequest. onProgress(0..1); signal (an AbortSignal) cancels it.
  upload(path, blob, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api' + path);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      if (onProgress && xhr.upload) xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* empty body */ }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
        const e = new Error((data && data.error) || `something went wrong (${xhr.status})`);
        e.status = xhr.status;
        reject(e);
      };
      xhr.onerror = () => reject(new Error('the upload didn\'t go through. check your connection and try again.'));
      xhr.onabort = () => { const e = new Error('cancelled'); e.aborted = true; reject(e); };
      if (signal) signal.addEventListener('abort', () => xhr.abort());
      xhr.send(blob);
    });
  },
  get: p => api.call('GET', p),
  post: (p, b = {}) => api.call('POST', p, b),
  put: (p, b) => api.call('PUT', p, b),
  del: (p, b) => api.call('DELETE', p, b),
};
