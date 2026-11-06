// Bucky Publisher UI. Data and actions go through BuckyAPI (api.js) to the Apps Script
// backend. This file renders S (state from the backend) and U (local UI state).
(function () {
  const API = window.BuckyAPI;
  let S = { me: null };         // state from the backend
  const U = { view: 'progress', ms: 'Pre-start', sel: null, note: '', noteOpen: false, noteGif: null,
    fb: '', fbGif: null, gifFor: null, gifQuery: '', resend: null, busy: null, loading: false, error: '',
    gateOk: !!API.store.get('bucky.site'), picks: {}, up: null, booted: false };
  let lastKey = '', countT = null, toastT = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PILL = { 'To do': 'todo', 'In progress': 'prog', 'Pending review': 'review', 'Retake': 'retake', 'Approved': 'done' };
  const label = (st) => (st === 'Pending review' ? 'In review' : st);
  const pill = (st) => '<span class="pill ' + PILL[st] + '">' + label(st) + '</span>';
  const names = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1] : a.join(''));
  const kinetic = (txt, delay) => '<span class="k" style="animation-delay:' + (delay || 0) + 'ms">' + esc(txt) + '</span>';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const pctOf = (a, b) => (b ? Math.min(100, Math.floor(a * 100 / b)) : 0);
  const upText = (up, i, f) => (f ? (up.done[i] >= f.size ? 'Done \u00b7 ' + mb(f.size) : (up.done[i] ? mb(up.done[i]) + ' / ' + mb(f.size) + ' \u00b7 ' + pctOf(up.done[i], f.size) + '%' : 'Waiting\u2026')) : '');

  // ---- scale the 1280x800 stage to the window -------------------------
  function fit() {
    const k = Math.min(window.innerWidth / 1280, window.innerHeight / 800);
    $('stage').style.transform = 'scale(' + k + ')';
  }

  // ---- data helpers ---------------------------------------------------
  const tasks = () => S.tasks || [];
  const mine = (ms) => tasks().filter((t) => t.mine && (!ms || t.ms === ms));
  const queue = () => tasks().filter((t) => t.inQueue);
  const order = { 'Retake': 0, 'In progress': 1, 'To do': 2, 'Pending review': 3, 'Approved': 4 };
  const sorted = (l) => l.slice().sort((a, b) => order[a.status] - order[b.status]);
  function list() { return U.view === 'review' ? queue() : sorted(mine(U.ms)); }
  function current() { const l = list(); return l.find((t) => t.id === U.sel) || l[0] || null; }
  function clean() { Object.assign(U, { note: '', noteOpen: false, noteGif: null, fb: '', fbGif: null, gifFor: null, gifQuery: '', resend: null }); }

  // ---- screens --------------------------------------------------------
  function signinScreen() {
    const err = U.error ? '<span class="formerr" role="alert">' + esc(U.error) + '</span>' : '';
    let inner;
    if (!U.booted) inner = '<span class="lbl">WAKING BUCKY UP…</span>';
    else if (!U.gateOk) {
      inner = '<form class="form" data-form="gate"><label class="lbl" for="sitepass">SITE PASSWORD</label>' +
        '<input type="password" id="sitepass" autocomplete="off" required>' + err +
        '<button class="btn cream primary" type="submit" ' + (U.loading ? 'disabled' : '') + '>' + (U.loading ? 'Checking…' : 'Enter') + '</button></form>';
    } else {
      inner = '<form class="form" data-form="login"><label class="lbl" for="email">GMAIL</label>' +
        '<input type="email" id="email" autocomplete="username" value="' + esc(API.store.get('bucky.email') || '') + '" required>' +
        '<label class="lbl" for="pass">PASSWORD</label><input type="password" id="pass" autocomplete="current-password" required>' + err +
        '<button class="btn cream primary" type="submit" ' + (U.loading ? 'disabled' : '') + '>' + (U.loading ? 'Signing in…' : 'Sign in') + '</button></form>';
    }
    return '<div class="grid"><h1 class="z" style="grid-column:1/span 7;margin-top:110px;font-size:128px;line-height:.92" aria-label="Bucky Publisher">' +
      kinetic('Bucky') + '<br>' + kinetic('Publisher', 150) + '</h1>' +
      '<div class="glass pin z" style="grid-column:1/span 5;margin-top:54px;padding:24px 26px;display:flex;flex-direction:column;gap:10px;animation-delay:400ms">' + inner + '</div></div>';
  }

  function nav() {
    const open = mine().filter((t) => t.status !== 'Approved').length;
    return '<nav><button class="nav ' + (U.view === 'progress' ? 'on' : '') + '" data-act="view" data-v="progress">MILESTONES</button>' +
      '<button class="nav ' + (U.view === 'tasks' ? 'on' : '') + '" data-act="view" data-v="tasks">MY TASKS ' + open + '</button>' +
      (S.isReviewer ? '<button class="nav ' + (U.view === 'review' ? 'on' : '') + '" data-act="view" data-v="review">TO REVIEW ' + queue().length + '</button>' : '') +
      '</nav>';
  }

  function progressScreen() {
    const cur = (S.milestones || [])[0] || { id: 'Pre-start', name: 'Pre-start', mineOpen: 0 };
    const now = (S.milestones || []).find((m) => m.mineOpen) || cur;
    const rows = (S.milestones || []).map((m, i) =>
      '<button class="msrow rowin" data-act="ms" data-ms="' + esc(m.id) + '" style="animation-delay:' + (500 + i * 90) + 'ms">' +
      '<span class="lbl" style="grid-column:span 1;font-size:12px">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<span style="grid-column:span 3;font-weight:600;font-size:22px;text-transform:uppercase;letter-spacing:.02em">' + esc(m.name) + '</span>' +
      '<span style="grid-column:span 2;font-family:var(--mono);font-size:12px">' + esc(m.dates) + '</span>' +
      '<span class="track"><span class="fill bar" style="width:' + m.pct + '%;animation-delay:' + (700 + i * 90) + 'ms"></span></span>' +
      '<span style="grid-column:span 1;font-weight:700;font-size:22px;text-align:right;color:' + (i === 0 ? 'var(--orange)' : 'var(--stone)') + '">' + m.pct + '%</span>' +
      '<span style="grid-column:span 2;font-size:14px;text-align:right">' + (!m.planned ? 'Not planned yet' : m.mineOpen ? plural(m.mineOpen, 'task for you', 'tasks for you') : 'Nothing open for you') + '</span></button>').join('');
    return '<div class="grid">' + nav() +
      '<h1 class="z" style="grid-column:1/span 8;margin-top:28px;font-size:84px" aria-label="Current progress">' + kinetic('Current progress') + '</h1>' +
      '<div class="z" style="grid-column:1/span 8;display:flex;align-items:flex-end;gap:40px;margin-top:14px;z-index:2">' +
      '<div class="rise" id="hero" style="font-weight:700;font-size:210px;line-height:.85;letter-spacing:-.03em;color:var(--orange)">0%</div>' +
      '<button class="glass current pin" data-act="ms" data-ms="' + esc(now.id) + '" style="animation-delay:600ms"><span style="display:flex;flex-direction:column;gap:2px"><span class="lbl" style="font-size:10px">' + esc(now.name).toUpperCase() + '</span>' +
      '<span style="font-size:17px;font-weight:600">' + (now.mineOpen ? plural(now.mineOpen, 'task for you', 'tasks for you') : 'Nothing open for you') + '</span></span><span aria-hidden="true" style="font-size:20px">&#8594;</span></button></div>' +
      '<div class="glass ms z">' + rows + '</div></div>';
  }

  function gifPicker() {
    const q = U.gifQuery.trim().toLowerCase();
    const hits = window.GIFS.filter((g) => !q || (g.label + ' ' + g.tags).toLowerCase().includes(q));
    return '<div class="picker"><input type="text" id="gifq" placeholder="Search GIFs" value="' + esc(U.gifQuery) + '">' +
      '<div class="tiles">' + hits.map((g, i) => window.gifTile(g.id, 'data-act="gif" data-id="' + g.id + '" style="animation-delay:' + i * 40 + 'ms"', 'tile')).join('') + '</div></div>';
  }

  function gifRow(field) {
    const sel = U[field + 'Gif'];
    return '<div class="gifrow">' + (sel ? window.gifTile(sel) + '<button class="link" style="color:var(--stone);font-size:13px" data-act="nogif" data-f="' + field + '">Remove</button>' : '') +
      '<button class="gifbtn" data-act="gifs" data-f="' + field + '">GIF</button></div>' + (U.gifFor === field ? gifPicker() : '');
  }

  function taskCard(t) {
    const busy = U.busy === t.id;
    const isPending = t.status === 'Pending review';
    const picks = U.picks[t.id] || {};
    const up = U.up && U.up.task === t.id ? U.up : null;
    const editing = t.status === 'In progress' || t.status === 'Retake' || (isPending && U.resend === t.id);
    let h = '<div class="glass card pin z" style="animation-delay:400ms">' +
      '<div class="head"><h2>' + esc(t.name) + '</h2>' + pill(t.status) + '</div>' +
      '<div class="field"><span class="lbl">DESCRIPTION</span><span class="body">' + esc(t.dod) + '</span></div>';
    if (t.status === 'Retake') {
      h += '<div class="feedback"><span class="field" style="flex:1"><span class="lbl">' + esc((t.retakeBy || 'REVIEWER').toUpperCase()) + ' ASKED FOR CHANGES</span>' +
        '<span class="body">' + esc(t.feedback) + '</span></span>' + (t.feedbackGif ? window.gifTile(t.feedbackGif) : '') + '</div>';
    }
    if (isPending) {
      h += '<div class="field" style="gap:6px"><span class="big">Sent.</span><span class="muted">Waiting for ' + esc(names(t.reviewers)) + '. Bucky will ping you on Discord when it\u2019s reviewed.</span></div>';
      if (U.resend !== t.id) h += '<button class="link" data-act="resend">Made a mistake? Send it again</button>';
    }
    if (t.status === 'Approved') h += '<div class="field" style="gap:6px"><span class="big" style="color:var(--orange)">Approved.</span><span class="muted">Nothing left to do here.</span></div>';
    if (t.status === 'To do') {
      if (t.blockers.length) h += '<span style="font-size:14px;color:var(--stone)">Usually starts after ' + esc(t.blockers.join(', ')) + '.</span>';
      h += '<div><button class="btn primary" data-act="start" ' + (busy ? 'disabled' : '') + '>' + (busy ? 'Starting\u2026' : 'Start task') + '</button></div>';
    }
    if (editing) {
      const noFiles = !t.slots.length, missing = t.slots.filter((s, i) => !picks[i]).length;
      t.slots.forEach((s, i) => {
        const f = picks[i];
        h += '<div class="slot ' + (f ? 'filled' : '') + '" data-drop="' + i + '"><span class="nm">' + (f ? '<span class="tick" aria-hidden="true">&#10003;</span>' : '') +
          '<span style="display:flex;flex-direction:column;gap:2px">' + esc(s.label) + '<span class="file">' + (f ? esc(f.name) + ' \u00b7 ' + mb(f.size) : '.' + esc(s.ext) + ' \u00b7 drop it here or') + '</span></span></span>' +
          (up ? '' : '<button class="outline" data-act="pick" data-i="' + i + '">' + (f ? 'Replace' : 'Add file') + '</button>') + '</div>';
        if (up) h += '<div class="upbar"><div class="upfill" id="upfill-' + i + '" style="width:' + pctOf(up.done[i] || 0, f ? f.size : 1) + '%"></div><span class="uptext" id="uptext-' + i + '">' + upText(up, i, f) + '</span></div>';
      });
      if (!noFiles && !U.noteOpen) h += '<button class="link" data-act="note">+ Add a note</button>';
      if (noFiles || U.noteOpen) {
        h += '<div class="field"><label class="lbl" for="note">' + (noFiles ? 'WHERE CAN THE REVIEWER FIND IT?' : 'NOTE FOR THE REVIEWER') + '</label>' +
          '<textarea id="note" rows="2">' + esc(U.note) + '</textarea>' + gifRow('note') + '</div>';
      }
      const ready = !busy && (noFiles ? !!U.note.trim() : missing === 0);
      const lbl = busy ? (up ? 'Uploading ' + pctOf(sum(up.done), up.total) + '%' : 'Sending\u2026') : (!noFiles && missing) ? plural(missing, 'file missing', 'files missing') : isPending ? 'Send again' : noFiles ? 'Send for review' : 'Publish for review';
      h += '<div><button class="btn primary" id="publish" data-act="publish" data-nofiles="' + (noFiles ? 1 : 0) + '" data-missing="' + missing + '" ' + (ready ? '' : 'disabled') + '>' + lbl + '</button></div>';
    }
    h += historyBlock(t) + '</div>';
    return h;
  }

  function historyBlock(t) {
    return '<details><summary class="lbl">HISTORY (' + t.log.length + ')</summary><div class="hist">' +
      (t.log.length ? t.log.map((l) => '<div><span>' + esc(l.when) + '</span><span>' + esc(l.text) + '</span></div>').join('') : '<div><span>No changes yet.</span></div>') + '</div></details>';
  }

  function reviewCard(t) {
    const busy = U.busy === t.id, empty = !U.fb.trim();
    let h = '<div class="glass card pin z" style="gap:18px;animation-delay:400ms">' +
      '<div class="head"><h2>' + esc(t.name) + '</h2>' + pill('Pending review') + '<span class="lbl">' + t.vtag + '</span></div>' +
      '<div class="field"><span class="lbl">DESCRIPTION</span><span class="body">' + esc(t.dod) + '</span></div>';
    if (t.note || t.noteGif) {
      h += '<div style="display:flex;gap:16px;align-items:center"><span class="field" style="flex:1;gap:6px"><span class="lbl">NOTE FROM ' + esc(t.owners.toUpperCase()) + '</span>' +
        '<span class="body">' + (t.note ? '\u201c' + esc(t.note) + '\u201d' : '') + '</span></span>' + (t.noteGif ? window.gifTile(t.noteGif) : '') + '</div>';
    }
    if (t.slots.length) {
      const files = t.files || [];
      if (!files.length) h += '<div class="slot"><span class="nm" style="font-weight:400;color:var(--stone)">Files not found on Drive yet.</span></div>';
      h += files.map((f) => '<div class="filebox">' +
        (f.thumb ? '<a href="' + esc(f.view) + '" target="_blank" rel="noopener"><img class="thumb" src="' + esc(f.thumb) + '" alt="' + esc(f.label) + '" loading="lazy"></a>' : '') +
        (f.preview ? '<iframe class="vid" src="' + esc(f.preview) + '" allow="autoplay" title="' + esc(f.label) + '"></iframe>' : '') +
        '<div class="slot filled"><span class="nm"><span style="display:flex;flex-direction:column;gap:2px">' + esc(f.label) + '<span class="file">' + esc(f.name) + ' \u00b7 ' + mb(f.size) + '</span></span></span>' +
        '<span style="display:flex;gap:8px"><a class="outline linkbtn" href="' + esc(f.view) + '" target="_blank" rel="noopener">Open</a><a class="outline linkbtn" href="' + esc(f.download) + '" target="_blank" rel="noopener">Download</a></span></div></div>').join('');
    }
    h += '<div class="field"><label class="lbl" for="fb">COMMENT</label><textarea id="fb" rows="2" placeholder="Needed for a retake. Optional to approve.">' + esc(U.fb) + '</textarea>' + gifRow('fb') + '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap"><button class="btn primary" data-act="approve" ' + (busy ? 'disabled' : '') + '>Approve</button>' +
      '<button class="btn line" id="retake" data-act="retake" ' + (busy || empty ? 'disabled' : '') + '>Retake</button></div>' + historyBlock(t) + '</div>';
    return h;
  }

  function workScreen() {
    const l = list(), t = current(), isTasks = U.view === 'tasks';
    const ms = (S.milestones || []).find((m) => m.id === U.ms);
    const title = isTasks ? (ms ? ms.name : U.ms) : 'To review';
    const rows = l.map((x) => '<button class="row ' + (t && x.id === t.id ? 'sel' : '') + '" data-act="sel" data-id="' + esc(x.id) + '">' +
      '<span class="top"><span class="nm">' + esc(x.name) + '</span>' + pill(x.status) + '</span>' +
      '<span class="sub ' + (x.status === 'Retake' ? 'hot' : '') + '">' + (isTasks ? 'DUE ' + esc(x.due).toUpperCase() + (x.version ? ' \u00b7 ' + x.vtag : '') : 'FROM ' + esc(x.owners).toUpperCase() + ' \u00b7 ' + x.vtag + ' \u00b7 DUE ' + esc(x.due).toUpperCase()) + '</span></button>').join('');
    return '<div class="grid">' + nav() +
      (isTasks ? '<button class="link mono z" style="grid-column:1/span 3;justify-self:start;margin-top:24px" data-act="view" data-v="progress">&lt; MILESTONES</button>' : '<div style="grid-column:1/span 12;height:24px"></div>') +
      '<h1 class="z" style="grid-column:1/span 8;margin-top:6px;font-size:96px" aria-label="' + esc(title) + '">' + kinetic(title) + '</h1>' +
      '<div class="glass list pin z" style="animation-delay:250ms">' + (rows || '<div class="empty">' + (isTasks ? 'No tasks for you here yet.' : 'Nothing to review. Bucky will ping you when something lands.') + '</div>') + '</div>' +
      (t ? (isTasks ? taskCard(t) : reviewCard(t)) : '') + '</div>';
  }

  // ---- render ---------------------------------------------------------
  function render() {
    const scr = $('screen');
    const key = !S.me ? 'signin' + U.gateOk + U.booted : U.view + '|' + U.ms + '|' + (current() || {}).id;
    const same = key === lastKey;
    lastKey = key;
    const keepScroll = same && scr.querySelector('.card') ? scr.querySelector('.card').scrollTop : 0;
    if (!S.me) { scr.innerHTML = signinScreen(); Bucky.setPose('signin'); }
    else if (U.view === 'progress') { scr.innerHTML = progressScreen(); Bucky.setPose('progress'); if (!same) countUp(); else $('hero').textContent = S.avg + '%'; }
    else { scr.innerHTML = workScreen(); Bucky.setPose('peek'); }
    scr.classList.toggle('calm', same);
    const card = scr.querySelector('.card');
    if (card && keepScroll) card.scrollTop = keepScroll;
    const selRow = scr.querySelector('.row.sel');
    if (selRow && !same) selRow.scrollIntoView({ block: 'nearest' });
    const det = scr.querySelector('details');
    if (det && U.histOpen) det.open = true;
    chip();
  }

  function countUp() {
    clearInterval(countT);
    const target = S.avg || 0, t0 = Date.now();
    countT = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / 1600), el = $('hero');
      if (!el) return clearInterval(countT);
      el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + '%';
      if (k >= 1) clearInterval(countT);
    }, 33);
  }

  function chip() {
    const c = $('chip');
    let h = '';
    if (S.me) h += '<span>' + esc(S.me.full).toUpperCase() + '</span><button class="navx" style="margin:0" data-act="refresh">REFRESH</button>' +
      '<button class="navx" style="margin:0" data-act="signout">SIGN OUT</button>';
    if (API.MOCK) h += '<span><b>TEST DATA</b> \u00b7 NOTHING HERE TOUCHES GOOGLE</span><button class="navx" style="margin:0" data-act="reset">RESET TEST DATA</button>';
    c.innerHTML = h;
  }

  function toast(ev) {
    const el = $('toast');
    clearTimeout(toastT);
    el.innerHTML = '<div class="glass toast ' + (ev.kind === 'retake' ? 'shake' : '') + ' ' + (ev.kind === 'error' ? 'error' : '') + '" role="status">' +
      '<span class="av">' + (ev.kind === 'error' ? '!' : 'B') + '</span><span style="display:flex;flex-direction:column;gap:6px;min-width:0">' +
      '<span class="lbl">' + (ev.kind === 'error' ? 'BUCKY \u00b7 HEADS UP' : 'BUCKY \u00b7 #TASK-FEED') + '</span>' +
      '<span class="msg">' + (ev.mention ? '<span class="who">' + esc(ev.mention) + '</span> ' : '') + esc(ev.text) + '</span>' +
      (ev.quote ? '<span class="quote">' + esc(ev.quote) + '</span>' : '') + (ev.gif ? window.gifTile(ev.gif) : '') + '</span></div>';
    toastT = setTimeout(() => { el.innerHTML = ''; }, ev.kind === 'error' ? 7000 : 5000);
  }

  // ---- talking to the backend -----------------------------------------
  function apply(data) {
    if (data && data.state) {
      const prev = S.me && S.me.key;
      S = data.state;
      if (prev !== S.me.key) { U.view = 'progress'; U.sel = null; clean(); U.picks = {}; }
    }
    if (data && data.event) { if (data.event.kind !== 'error') clean(); toast(data.event); if (data.event.kind === 'good') Bucky.burst(); }
  }

  async function run(action, payload) {
    try {
      const data = await API.call(action, payload);
      apply(data);
      return data;
    } catch (e) {
      if (e.signedOut) signedOut(); else toast({ text: e.message, kind: 'error' });
      return null;
    } finally {
      U.busy = null; U.loading = false; U.up = null;
      render();
    }
  }

  function signedOut() { API.store.set('bucky.token', null); S = { me: null }; lastKey = ''; }

  async function publish(t) {
    const picks = U.picks[t.id] || {};
    U.busy = t.id; U.sel = t.id; render();
    if (!t.slots.length) { await run('finishUpload', { taskId: t.id, note: U.note, gif: U.noteGif || '' }); return; }
    let begun;
    try {
      begun = await API.call('beginUpload', { taskId: t.id, origin: location.origin,
        files: t.slots.map((s, i) => ({ i, name: picks[i].name, size: picks[i].size, type: picks[i].type })) });
    } catch (e) {
      U.busy = null; if (e.signedOut) signedOut(); else toast({ text: e.message, kind: 'error' }); render(); return;
    }
    U.up = { task: t.id, done: {}, total: t.slots.reduce((a, s, i) => a + picks[i].size, 0) };
    render();
    try {
      for (const u of begun.uploads) {
        await API.upload(picks[u.i], u.url, (sent) => { U.up.done[u.i] = sent; paintProgress(t); });
      }
    } catch (e) {
      U.busy = null; U.up = null; toast({ text: e.message, kind: 'error' }); render(); return;
    }
    const note = U.note, gif = U.noteGif || '';
    delete U.picks[t.id];
    Bucky.burst();
    await run('finishUpload', { taskId: t.id, version: begun.version, note, gif });
  }

  function paintProgress(t) {
    const up = U.up, picks = U.picks[t.id] || {};
    if (!up) return;
    Object.keys(up.done).forEach((i) => {
      const f = picks[i], fill = $('upfill-' + i), txt = $('uptext-' + i);
      if (fill && f) fill.style.width = pctOf(up.done[i], f.size) + '%';
      if (txt) txt.textContent = upText(up, Number(i), f);
    });
    const b = $('publish');
    if (b) b.textContent = 'Uploading ' + pctOf(sum(up.done), up.total) + '%';
  }

  function pickFile(t, i) {
    const s = t.slots[i], inp = document.createElement('input');
    inp.type = 'file';
    if (s.ext) inp.accept = '.' + s.ext;
    inp.onchange = () => inp.files[0] && setPick(t, i, inp.files[0]);
    inp.click();
  }

  function setPick(t, i, f) {
    const s = t.slots[i];
    if (s.ext && !f.name.toLowerCase().endsWith('.' + s.ext)) { toast({ text: s.label + ' needs a .' + s.ext + ' file.', kind: 'error' }); return; }
    if (s.ext === 'mp4' && f.size > 8 * 1024 * 1024) { toast({ text: 'Videos must be under 8 MB so Discord can show them.', kind: 'error' }); return; }
    if (!f.size) { toast({ text: 'That file is empty.', kind: 'error' }); return; }
    (U.picks[t.id] = U.picks[t.id] || {})[i] = f;
    render();
  }

  // ---- events ---------------------------------------------------------
  function act(a, el) {
    const t = current();
    switch (a) {
      case 'signout': API.call('logout').catch(() => {}); signedOut(); render(); break;
      case 'refresh': run('state'); break;
      case 'reset': try { ['bucky.mock', 'bucky.mockprops', 'bucky.mockdrive', 'bucky.token'].forEach((k) => localStorage.removeItem(k)); } catch (e) {} location.reload(); break;
      case 'view': U.view = el.dataset.v; U.sel = null; clean(); render(); break;
      case 'ms': U.view = 'tasks'; U.ms = el.dataset.ms; U.sel = null; clean(); render(); break;
      case 'sel': U.sel = el.dataset.id; clean(); render(); break;
      case 'start': U.sel = t.id; U.busy = t.id; render(); run('start', { taskId: t.id }); break;
      case 'pick': pickFile(t, Number(el.dataset.i)); break;
      case 'note': U.noteOpen = true; render(); $('note').focus(); break;
      case 'resend': U.resend = t.id; render(); break;
      case 'gifs': U.gifFor = U.gifFor === el.dataset.f ? null : el.dataset.f; U.gifQuery = ''; render(); break;
      case 'gif': U[U.gifFor + 'Gif'] = el.dataset.id; U.gifFor = null; render(); break;
      case 'nogif': U[el.dataset.f + 'Gif'] = null; render(); break;
      case 'publish': publish(t); break;
      case 'approve': U.busy = t.id; render(); Bucky.burst(); run('approve', { taskId: t.id, comment: U.fb, gif: U.fbGif || '' }); break;
      case 'retake': if (!U.fb.trim()) return; U.busy = t.id; render(); run('retake', { taskId: t.id, comment: U.fb, gif: U.fbGif || '' }); break;
    }
  }

  async function submit(form) {
    U.error = '';
    if (form === 'gate') {
      const p = $('sitepass').value;
      U.loading = true; render();
      try { await API.call('gate', { sitePass: p }); API.store.set('bucky.site', p); U.gateOk = true; }
      catch (e) { U.error = e.message; }
      U.loading = false; render();
      const em = $('email'); if (em) (em.value ? $('pass') : em).focus();
      else if ($('sitepass')) $('sitepass').focus();
    } else {
      const email = $('email').value.trim(), password = $('pass').value;
      U.loading = true; render();
      try {
        const d = await API.call('login', { email, password });
        API.store.set('bucky.token', d.token); API.store.set('bucky.email', email);
        apply(d);
      } catch (e) {
        U.error = e.message;
        if (/site password/i.test(e.message)) { API.store.set('bucky.site', null); U.gateOk = false; }
      }
      U.loading = false; render();
      if (!S.me && $('pass')) $('pass').focus();
    }
  }

  function wire() {
    const scr = document.getElementById('stage');
    scr.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled) act(el.dataset.act, el);
    });
    scr.addEventListener('submit', (e) => { const f = e.target.closest('[data-form]'); if (f) { e.preventDefault(); submit(f.dataset.form); } });
    scr.addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS') U.histOpen = e.target.open; }, true);
    scr.addEventListener('dragover', (e) => { const d = e.target.closest('[data-drop]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
    scr.addEventListener('dragleave', (e) => { const d = e.target.closest('[data-drop]'); if (d) d.classList.remove('over'); });
    scr.addEventListener('drop', (e) => {
      const d = e.target.closest('[data-drop]');
      if (!d) return;
      e.preventDefault(); d.classList.remove('over');
      const f = e.dataTransfer.files[0], t = current();
      if (f && t && !U.up) setPick(t, Number(d.dataset.drop), f);
    });
    // typing must not re-render (focus would be lost), so update buttons in place
    scr.addEventListener('input', (e) => {
      if (e.target.id === 'note') {
        U.note = e.target.value;
        const p = $('publish');
        if (p && p.dataset.nofiles === '1') p.disabled = !U.note.trim() || !!U.busy;
      } else if (e.target.id === 'fb') {
        U.fb = e.target.value;
        const r = $('retake');
        if (r) r.disabled = !U.fb.trim() || !!U.busy;
      } else if (e.target.id === 'gifq') {
        U.gifQuery = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const q = $('gifq'); q.focus(); q.setSelectionRange(pos, pos);
      }
    });
    window.addEventListener('beforeunload', (e) => { if (U.up) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function boot() {
    render();
    if (API.store.get('bucky.token')) {
      try { apply(await API.call('state')); } catch (e) { if (e.signedOut) signedOut(); else U.error = e.message; }
    }
    U.booted = true;
    render();
    const first = $('sitepass') || ($('email') && ($('email').value ? $('pass') : $('email')));
    if (first) first.focus();
  }

  // pick up changes from teammates; skipped while typing or uploading
  setInterval(() => {
    const typing = document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName);
    if (S.me && !U.busy && !U.up && !typing) run('state');
  }, 60000);

  window.addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', () => { fit(); Bucky.init(); wire(); boot(); });
})();
