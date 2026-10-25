/* core/api.js — the JSON API (/api/*, the Worker in src/). A failed call throws
   an Error with the server's message and .status. */

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
      const e = new Error((data && data.error) || `something went wrong (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  },
  get: p => api.call('GET', p),
  post: (p, b = {}) => api.call('POST', p, b),
  put: (p, b) => api.call('PUT', p, b),
  del: (p, b) => api.call('DELETE', p, b),
};
