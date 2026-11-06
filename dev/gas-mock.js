// Fake Google Apps Script services, so backend/Code.gs runs in the browser (or Node)
// on test data. Used by ?mock and by the tests. Nothing here talks to Google.
(function (G) {
  const LS = (() => { try { return G.localStorage; } catch (e) { return null; } })();
  const load = (k, d) => { try { const v = LS && LS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { LS && LS.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---- spreadsheet ----------------------------------------------------
  let book = load('bucky.mock', null) || clone(G.BUCKY_FIXTURE);
  const persist = () => save('bucky.mock', book);
  function sheet(name) {
    if (!book[name]) return null;
    return {
      getDataRange: () => ({
        getDisplayValues: () => {
          const rows = book[name], w = Math.max(...rows.map((r) => r.length));
          return rows.map((r) => Array.from({ length: w }, (_, i) => (r[i] == null ? '' : String(r[i]))));
        }
      }),
      getRange: (r, c) => ({ setValue: (v) => { const rows = book[name]; while (rows.length < r) rows.push([]); const row = rows[r - 1]; while (row.length < c) row.push(''); row[c - 1] = String(v); persist(); } }),
      appendRow: (arr) => { book[name].push(arr.map(String)); persist(); }
    };
  }
  G.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: sheet }) };

  // ---- properties, locks, misc -----------------------------------------
  const props = load('bucky.mockprops', { DISCORD_WEBHOOK: 'https://discord.test/webhook' });
  G.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); save('bucky.mockprops', props); },
    deleteProperty: (k) => { delete props[k]; save('bucky.mockprops', props); },
    getProperties: () => Object.assign({}, props)
  }) };
  G.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  G.Session = { getScriptTimeZone: () => 'Europe/Madrid' };
  G.ScriptApp = { getOAuthToken: () => 'mock-token' };
  const pad = (n) => String(n).padStart(2, '0');
  G.Utilities = {
    getUuid: () => (G.crypto && G.crypto.randomUUID ? G.crypto.randomUUID() : String(Math.random()).slice(2)),
    formatDate: (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
    base64Decode: (s) => { const bin = (G.atob || ((x) => Buffer.from(x, 'base64').toString('binary')))(s); return { length: bin.length }; }
  };
  G.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }) };

  // ---- drive ----------------------------------------------------------
  const drive = load('bucky.mockdrive', { n: 1, items: { 'mock-root': { id: 'mock-root', name: 'BuckyAway2026', folder: true, parent: null, shared: false } } });
  const saveDrive = () => save('bucky.mockdrive', drive);
  const newId = () => 'm' + (drive.n++);
  const kids = (pid, folderOnly) => Object.values(drive.items).filter((x) => x.parent === pid && !x.trashed && (folderOnly == null || !!x.folder === folderOnly));
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function fileObj(x) {
    return { getId: () => x.id, getName: () => x.name, getMimeType: () => x.mime || 'application/octet-stream', getSize: () => x.size || 0,
      setSharing: () => { x.shared = true; saveDrive(); }, setTrashed: (v) => { x.trashed = !!v; saveDrive(); },
      makeCopy: (name, dst) => { const id = newId(); drive.items[id] = Object.assign({}, x, { id, name, parent: dst.getId(), shared: false }); saveDrive(); return fileObj(drive.items[id]); } };
  }
  function folderObj(x) {
    return { getId: () => x.id, getName: () => x.name,
      getFoldersByName: (n) => iter(kids(x.id, true).filter((k) => k.name === n).map(folderObj)),
      getFilesByName: (n) => iter(kids(x.id, false).filter((k) => k.name === n).map(fileObj)),
      getFiles: () => iter(kids(x.id, false).map(fileObj)),
      createFolder: (n) => { const id = newId(); drive.items[id] = { id, name: n, folder: true, parent: x.id }; saveDrive(); return folderObj(drive.items[id]); },
      setSharing: () => { x.shared = true; saveDrive(); } };
  }
  G.DriveApp = { Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
    getFolderById: (id) => { if (!drive.items[id]) throw new Error('No folder ' + id); return folderObj(drive.items[id]); } };

  // ---- url fetch: Discord + Drive resumable uploads --------------------
  const sessions = {};
  G.mockDiscord = [];
  G.mockDrive = drive;
  const resp = (code, headers, body) => ({ getResponseCode: () => code, getHeaders: () => headers || {}, getContentText: () => body || '' });
  G.UrlFetchApp = { fetch: (url, o) => {
    o = o || {};
    if (url === props.DISCORD_WEBHOOK) { G.mockDiscord.push(JSON.parse(o.payload).content); (G.console || console).log('[Bucky -> Discord]', JSON.parse(o.payload).content); return resp(204); }
    if (url.indexOf('https://www.googleapis.com/upload/drive/v3/files') === 0 && (o.method === 'post' || o.method === 'patch')) {
      const meta = JSON.parse(o.payload), sid = 'mock-' + newId();
      const replace = (url.match(/files\/([^?]+)\?/) || [])[1];
      sessions[sid] = { name: meta.name, parent: meta.parents && meta.parents[0], replace, size: Number(o.headers['X-Upload-Content-Length']), mime: o.headers['X-Upload-Content-Type'], got: 0 };
      return resp(200, { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + sid });
    }
    const sid = (url.match(/upload_id=([^&]+)/) || [])[1];
    if (sid && o.method === 'put') {
      const s = sessions[sid];
      if (!s) return resp(404);
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(o.headers['Content-Range']);
      s.got = Number(m[2]) + 1;
      if (s.got < s.size) return resp(308, { Range: 'bytes=0-' + m[2] });
      let x;
      if (s.replace && drive.items[s.replace]) { x = drive.items[s.replace]; x.size = s.size; x.mime = s.mime; }
      else { const id = newId(); x = drive.items[id] = { id, name: s.name, parent: s.parent, size: s.size, mime: s.mime }; }
      saveDrive();
      return resp(200, {}, JSON.stringify({ id: x.id, name: x.name }));
    }
    throw new Error('mock UrlFetchApp: unexpected ' + url);
  } };
})(typeof window !== 'undefined' ? window : globalThis);
