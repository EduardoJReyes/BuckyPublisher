// Talks to the Apps Script backend, and uploads files straight to Drive in chunks.
// Open the site with ?mock to run everything in the browser on fake data (no Google needed).
(function () {
  const MOCK = /[?&]mock\b/.test(location.search);
  const CHUNK = 8 * 1024 * 1024;           // must be a multiple of 256 KB for Drive
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  };
  let mockReady = null;
  let viaScript = MOCK;                       // switches on if the browser can't reach Drive directly

  async function loadMock() {
    if (!mockReady) {
      mockReady = (async () => {
        for (const src of ['dev/fixture.js', 'dev/gas-mock.js']) {
          await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
        }
        const src = await (await fetch('backend/Code.gs')).text();
        (0, eval)(src);                       // defines doPost and friends on window
      })();
    }
    return mockReady;
  }

  async function call(action, payload) {
    const req = Object.assign({ action, token: store.get('bucky.token'), sitePass: store.get('bucky.site') }, payload || {});
    let res;
    if (MOCK) {
      await loadMock();
      await new Promise((r) => setTimeout(r, 250));
      res = JSON.parse(window.doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
    } else {
      if (!window.BUCKY_API || /PASTE_/.test(window.BUCKY_API)) throw new Error('The site isn’t connected yet: paste the Apps Script URL into config.js.');
      let r;
      try {
        r = await fetch(window.BUCKY_API, { method: 'POST', body: JSON.stringify(req), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
      } catch (e) { throw new Error('Can’t reach Bucky’s backend. Check your connection.'); }
      res = await r.json();
    }
    if (!res.ok) { const e = new Error(res.error); e.signedOut = res.error === 'SIGNED_OUT'; throw e; }
    return res.data;
  }

  // ---- chunked upload -------------------------------------------------
  function putDirect(url, blob, start, total) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Range', 'bytes ' + start + '-' + (start + blob.size - 1) + '/' + total);
      x.upload.onprogress = (e) => putDirect.onbytes && putDirect.onbytes(e.loaded);
      x.onload = () => {
        if (x.status === 308) {
          const r = x.getResponseHeader('Range');
          resolve({ next: r ? Number(r.split('-')[1]) + 1 : start + blob.size });
        } else if (x.status === 200 || x.status === 201) {
          let file = {}; try { file = JSON.parse(x.responseText); } catch (e) {}
          resolve({ next: total, file });
        } else reject(Object.assign(new Error('Drive said ' + x.status), { status: x.status }));
      };
      x.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }));
      x.send(blob);
    });
  }

  function b64(blob) {
    return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(blob); });
  }

  async function putViaScript(url, blob, start, total) {
    const out = await call('chunk', { url, start, total, data: await b64(blob) });
    putDirect.onbytes && putDirect.onbytes(blob.size);
    if (out.file) return { next: total, file: out.file };
    return { next: out.range ? Number(out.range.split('-')[1]) + 1 : start + blob.size };
  }

  // onProgress(sentBytes, totalBytes)
  async function upload(file, url, onProgress) {
    const total = file.size;
    let start = 0, tries = 0, result = null;
    while (start < total) {
      const blob = file.slice(start, Math.min(start + CHUNK, total));
      putDirect.onbytes = (n) => onProgress(Math.min(total, start + n), total);
      try {
        result = viaScript ? await putViaScript(url, blob, start, total) : await putDirect(url, blob, start, total);
        start = result.next; tries = 0;
        onProgress(start, total);
      } catch (e) {
        if (!viaScript && e.status === 0 && start === 0 && tries === 0) { viaScript = true; continue; } // blocked by the browser: go through the script
        if (++tries > 5) throw new Error('Upload kept failing. Check your connection and press Publish again.');
        await new Promise((r) => setTimeout(r, 1000 * tries * tries));
      }
    }
    return result && result.file;
  }

  window.BuckyAPI = { call, upload, store, MOCK };
})();
