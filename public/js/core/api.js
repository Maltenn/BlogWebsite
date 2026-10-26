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
