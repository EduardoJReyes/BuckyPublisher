// Bucky Publisher UI. Data and actions go through BuckyAPI (api.js) to the Apps Script
// backend. This file renders S (state from the backend) and U (local UI state).
(function () {
  const VERSION = '1.4.0';
  const API = window.BuckyAPI;
  let S = { me: null };         // state from the backend
  const U = { view: 'progress', ms: 'Pre-start', sel: null, note: '', noteOpen: false, noteGif: null,
    fb: '', resend: null, busy: null, loading: false, error: '',
    gateOk: !!API.store.get('bucky.site'), picks: {}, up: null, booted: false, prog: 0, progText: '' };
  let lastKey = '', lastScreenKey = '', countT = null, toastT = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PILL = { 'To do': 'todo', 'In progress': 'prog', 'Pending review': 'review', 'Retake': 'retake', 'Approved': 'done' };
  const label = (st) => (st === 'Pending review' ? 'In review' : st);
  const pill = (st) => '<span class="pill ' + PILL[st] + '">' + label(st) + '</span>';
  const names = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1] : a.join(''));
  const kinetic = (txt, delay) => '<span class="k" style="animation-delay:' + (delay || 0) + 'ms">' + esc(txt) + '</span>';
  // a button that fills with orange goo while something is loading, with the % inside
  const fill = (txt) => '<span class="liq" style="width:' + Math.round(U.prog) + '%"></span><span class="liqtxt">' + txt + ' ' + Math.round(U.prog) + '%</span>';
  let progT = null;
  function startProg(text, from, to) {
    clearInterval(progT);
    U.progText = text; U.prog = from || 0;
    const top = to || 90;
    progT = setInterval(() => { U.prog += (top - U.prog) * 0.06; paintProg(); }, 120);
  }
  function setProg(p, text) { clearInterval(progT); U.prog = p; if (text) U.progText = text; paintProg(); }
  function paintProg() {
    const b = $('busybtn');
    if (!b) return;
    const l = b.querySelector('.liq'), t = b.querySelector('.liqtxt');
    if (l) l.style.width = Math.round(U.prog) + '%';
    if (t) t.textContent = U.progText + ' ' + Math.round(U.prog) + '%';
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const blobs = (txt) => '<span class="busy"><span class="loader" aria-hidden="true"><i></i><i></i><i></i></span>' + txt + '</span>';
  // "DUE 4 NOV · 3 DAYS LEFT" / "DUE TODAY" / "2 DAYS LATE"
  const dueText = (t) => {
    let out = 'DUE ' + esc(t.due).toUpperCase();
    if (!t.dueIso || t.status === 'Approved') return out;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(t.dueIso); d1.setHours(0, 0, 0, 0);
    const n = Math.round((d1 - d0) / 864e5);
    return out + ' \u00b7 ' + (n > 1 ? n + ' DAYS LEFT' : n === 1 ? '1 DAY LEFT' : n === 0 ? 'TODAY' : (-n) + (n === -1 ? ' DAY' : ' DAYS') + ' LATE');
  };
  const isLate = (t) => { if (!t.dueIso || t.status === 'Approved' || t.status === 'Pending review') return false; const d0 = new Date(); d0.setHours(0, 0, 0, 0); return new Date(t.dueIso) < d0; };
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
  // oldest start first; tasks without a start date go last
  const sorted = (l) => l.slice().sort((a, b) => (a.startIso || 9e15) - (b.startIso || 9e15) || (a.dueIso || 9e15) - (b.dueIso || 9e15) || order[a.status] - order[b.status]);
  function list() { return U.view === 'review' ? queue() : sorted(mine(U.ms)); }
  function current() { const l = list(); return l.find((t) => t.id === U.sel) || l[0] || null; }
  function clean() { Object.assign(U, { note: '', noteOpen: false, fb: '', resend: null }); }

  // ---- screens --------------------------------------------------------
  function signinScreen() {
    const err = U.error ? '<span class="formerr" role="alert">' + esc(U.error) + '</span>' : '';
    const busyBtn = (txt) => '<button class="btn cream primary filling" id="busybtn" type="submit" disabled>' + fill(txt) + '</button>';
    let inner;
    if (!U.booted) inner = '<div class="btn cream primary filling" id="busybtn" aria-busy="true">' + fill('Waking Bucky up') + '</div>';
    else if (!U.gateOk) {
      inner = '<form class="form" data-form="gate">' +
        '<input type="password" id="sitepass" autocomplete="off" placeholder="Site password" aria-label="Site password" required>' + err +
        (U.loading ? busyBtn('Checking') : '<button class="btn cream primary" type="submit">Enter</button>') + '</form>';
    } else {
      inner = '<form class="form" data-form="login">' +
        '<input type="email" id="email" autocomplete="username" placeholder="Gmail" aria-label="Gmail" value="' + esc(API.store.get('bucky.email') || '') + '" required>' +
        '<input type="password" id="pass" autocomplete="current-password" placeholder="Password" aria-label="Password" required>' + err +
        (U.loading ? busyBtn('Signing in') : '<button class="btn cream primary" type="submit">Sign in</button>') +
        '<button class="link forgot" type="button" data-act="forgot">Did you forget your password?</button></form>';
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
      '<button class="nav ' + (U.view === 'docs' ? 'on' : '') + '" data-act="view" data-v="docs">DOCS</button>' +
      '<button class="navx signout" data-act="signout">SIGN OUT</button></nav>';
  }

  function progressScreen() {
    const cur = (S.milestones || [])[0] || { id: 'Pre-start', name: 'Pre-start', mineOpen: 0 };
    const now = (S.milestones || []).find((m) => m.mineOpen) || cur;
    const rows = (S.milestones || []).map((m, i) =>
      '<button class="msrow rowin" data-act="ms" data-ms="' + esc(m.id) + '" style="animation-delay:' + (500 + i * 90) + 'ms">' +
      (m.pct > 0 ? '<span class="msliq" style="--w:' + m.pct + '%;animation-delay:' + (700 + i * 90) + 'ms"></span>' : '') +
      '<span style="grid-column:span 4;font-weight:600;font-size:22px;text-transform:uppercase;letter-spacing:.02em">' + esc(m.name) + '</span>' +
      '<span style="grid-column:span 3;font-family:var(--mono);font-size:12px">' + esc(m.dates) + '</span>' +
      '<span style="grid-column:span 2;font-weight:700;font-size:22px;text-align:right;color:var(--cream)">' + m.pct + '%</span>' +
      '<span style="grid-column:span 3;font-size:14px;text-align:right">' + (!m.planned ? 'Not planned yet' : m.mineOpen ? plural(m.mineOpen, 'task for you', 'tasks for you') : 'Tasks finished') + '</span></button>').join('');
    return '<div class="grid">' + nav() +
      '<h1 class="z" style="grid-column:1/span 8;margin-top:28px;font-size:84px" aria-label="Current progress">' + kinetic('Current progress') + '</h1>' +
      '<div class="z" style="grid-column:1/span 8;display:flex;align-items:flex-end;gap:40px;margin-top:14px;z-index:2">' +
      '<div class="rise" id="hero" style="font-weight:700;font-size:210px;line-height:.85;letter-spacing:-.03em;color:var(--orange)">0%</div>' +
      '<button class="glass current pin" data-act="ms" data-ms="' + esc(now.id) + '" style="animation-delay:600ms"><span style="display:flex;flex-direction:column;gap:2px"><span class="lbl" style="font-size:10px">' + esc(now.name).toUpperCase() + '</span>' +
      '<span style="font-size:17px;font-weight:600">' + (now.mineOpen ? plural(now.mineOpen, 'task for you', 'tasks for you') : 'TASKS FINISHED') + '</span></span><span aria-hidden="true" style="font-size:20px">&#8594;</span></button></div>' +
      '<div class="glass ms z">' + rows + '</div></div>';
  }

  function taskCard(t) {
    const busy = U.busy === t.id;
    const isPending = t.status === 'Pending review';
    const picks = U.picks[t.id] || {};
    const up = U.up && U.up.task === t.id ? U.up : null;
    const editing = t.status === 'In progress' || t.status === 'Retake' || (isPending && U.resend === t.id);
    let h = '<div class="glass card pin z" style="animation-delay:400ms">' +
      '<div class="head"><h2>' + esc(t.name) + '</h2>' + pill(t.status) + '</div>' +
      '<span class="body">' + esc(t.dod) + '</span>';
    if (t.status === 'Retake') {
      h += '<div class="feedback"><span class="field" style="flex:1"><span class="lbl">' + esc((t.retakeBy || 'REVIEWER').toUpperCase()) + ' ASKED FOR CHANGES</span>' +
        '<span class="body">' + esc(t.feedback) + '</span></span></div>';
    }
    if (isPending) {
      h += '<div class="field" style="gap:6px"><span class="big">Sent.</span><span class="muted">Waiting for ' + esc(names(t.reviewers)) + '. Bucky will ping you on Discord when it\u2019s reviewed.</span></div>';
      if (U.resend !== t.id) h += '<div><button class="outline" data-act="resend">Update what I sent</button></div>';
      else h += '<span class="muted" style="font-size:15px">Replace what\u2019s wrong and send it again. It stays the same version, and the reviewer gets told to look at the new one.</span>';
    }
    if (t.status === 'Approved') h += '<div class="field" style="gap:6px"><span class="big" style="color:var(--orange)">Approved.</span><span class="muted">Nothing left to do here.</span></div>';
    if (t.status === 'To do') {
      if (t.blockers.length) h += '<span style="font-size:14px;color:var(--stone)">Usually starts after ' + esc(t.blockers.join(', ')) + '.</span>';
      h += '<div>' + (busy ? '<button class="btn primary filling" id="busybtn" disabled>' + fill('Starting') + '</button>' : '<button class="btn primary" data-act="start">Start task</button>') + '</div>';
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
        h += '<div class="field"><label class="lbl" for="note">' + (noFiles ? 'COMMENT' : 'NOTE FOR THE REVIEWER') + '</label>' +
          '<textarea id="note" rows="2">' + esc(U.note) + '</textarea></div>';
      }
      const ready = !busy && (noFiles ? !!U.note.trim() : missing === 0);
      const lbl = (!noFiles && missing) ? plural(missing, 'file missing', 'files missing') : isPending ? 'Send again' : noFiles ? 'Send for review' : 'Publish for review';
      const pubBusy = busy && U.busyAct !== 'unstart';
      h += '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        (pubBusy ? '<button class="btn primary filling" id="busybtn" disabled>' + fill(U.progText || 'Sending') + '</button>'
                 : '<button class="btn primary" id="publish" data-act="publish" data-nofiles="' + (noFiles ? 1 : 0) + '" data-missing="' + missing + '" ' + (ready && !busy ? '' : 'disabled') + '>' + lbl + '</button>') +
        (isPending && !busy ? '<button class="link" style="align-self:center" data-act="noresend">Cancel</button>' : '') +
        (t.status === 'In progress' && !pubBusy ? (U.busyAct === 'unstart' && busy ? '<button class="outline filling" id="busybtn" disabled>' + fill('Going back') + '</button>' : '<button class="outline" data-act="unstart"' + (busy ? ' disabled' : '') + '>Go back</button>') : '') + '</div>';
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
      '<div class="head"><h2>' + esc(t.name) + ' <span class="lbl">' + t.vtag + '</span></h2>' + pill('Pending review') + '</div>' +
      '<span class="body">' + esc(t.dod) + '</span>';
    if (t.note) {
      h += '<span class="field" style="gap:6px"><span class="lbl">NOTE FROM ' + esc(t.owners.toUpperCase()) + '</span>' +
        '<span class="body">\u201c' + esc(t.note) + '\u201d</span></span>';
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
    h += '<div class="field"><label class="lbl" for="fb">COMMENT</label><textarea id="fb" rows="2" placeholder="Needed for a retake. Optional to approve.">' + esc(U.fb) + '</textarea></div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap">' +
      (busy && U.busyAct === 'approve' ? '<button class="btn primary filling" id="busybtn" disabled>' + fill('Approving') + '</button>' : '<button class="btn primary" data-act="approve" ' + (busy ? 'disabled' : '') + '>Approve</button>') +
      (busy && U.busyAct === 'retake' ? '<button class="btn line filling" id="busybtn" disabled>' + fill('Sending') + '</button>' : '<button class="btn line" id="retake" data-act="retake" ' + (busy || empty ? 'disabled' : '') + '>Retake</button>') +
      '</div>' + historyBlock(t) + '</div>';
    return h;
  }

  function docsScreen() {
    const links = S.links || [];
    return '<div class="grid">' + nav() + '<div style="grid-column:1/span 12;height:24px"></div>' +
      '<h1 class="z" style="grid-column:1/span 8;margin-top:6px;font-size:96px" aria-label="Docs">' + kinetic('Docs') + '</h1>' +
      '<div class="docs z">' + links.map((l, i) => l.url
        ? '<a class="glass doc pin" href="' + esc(l.url) + '" target="_blank" rel="noopener" style="animation-delay:' + (250 + i * 120) + 'ms"><span class="lbl">' + esc(l.kind) + '</span><span class="docname">' + esc(l.label) + '</span><span class="arrow" aria-hidden="true">&#8599;</span></a>'
        : '<div class="glass doc off pin" style="animation-delay:' + (250 + i * 120) + 'ms"><span class="lbl">NOT SET YET</span><span class="docname">' + esc(l.label) + '</span><span class="muted" style="font-size:13px">Add the link in the Settings tab of the sheet</span></div>').join('') + '</div></div>';
  }

  function workScreen() {
    const l = list(), t = current(), isTasks = U.view === 'tasks';
    const ms = (S.milestones || []).find((m) => m.id === U.ms);
    const title = isTasks ? (ms ? ms.name : U.ms) : 'To review';
    const rows = l.map((x) => '<button class="row ' + (t && x.id === t.id ? 'sel' : '') + '" data-act="sel" data-id="' + esc(x.id) + '">' +
      '<span class="top"><span class="nm">' + esc(x.name) + '</span>' + pill(x.status) + '</span>' +
      '<span class="sub ' + (x.status === 'Retake' || isLate(x) ? 'hot' : '') + '">' + (isTasks ? dueText(x) + (x.version ? ' \u00b7 ' + x.vtag : '') : 'FROM ' + esc(x.owners).toUpperCase() + ' \u00b7 ' + x.vtag + ' \u00b7 ' + dueText(x)) + '</span></button>').join('');
    return '<div class="grid">' + nav() +
      '<div style="grid-column:1/span 12;height:24px"></div>' +
      '<h1 class="z" style="grid-column:1/span 8;margin-top:6px;font-size:96px" aria-label="' + esc(title) + '">' + kinetic(title) + '</h1>' +
      '<div class="glass list pin z" style="animation-delay:250ms">' + (rows || '<div class="empty">' + (isTasks ? 'No tasks for you here yet.' : 'Nothing to review. Bucky will ping you when something lands.') + '</div>') + '</div>' +
      (t ? (isTasks ? taskCard(t) : reviewCard(t)) : '') + '</div>';
  }

  // ---- render ---------------------------------------------------------
  function render() {
    const scr = $('screen');
    // screen = which page; key = page + selected task. Picking another task only animates the right pane.
    const screenKey = !S.me ? 'signin' + U.gateOk + U.booted : U.view + '|' + U.ms;
    const key = screenKey + '|' + (S.me ? (current() || {}).id : '');
    const same = key === lastKey, sameScreen = screenKey === lastScreenKey;
    lastKey = key; lastScreenKey = screenKey;
    const keepScroll = same && scr.querySelector('.card') ? scr.querySelector('.card').scrollTop : 0;
    const listScroll = sameScreen && scr.querySelector('.list') ? scr.querySelector('.list').scrollTop : 0;
    if (!S.me) { scr.innerHTML = signinScreen(); Bucky.setPose('signin'); }
    else if (U.view === 'progress') { scr.innerHTML = progressScreen(); Bucky.setPose('progress'); if (!same) countUp(); else $('hero').textContent = S.avg + '%'; }
    else if (U.view === 'docs') { scr.innerHTML = docsScreen(); Bucky.setPose('peek'); }
    else { scr.innerHTML = workScreen(); Bucky.setPose('peek'); }
    scr.classList.toggle('calm', sameScreen);
    const card = scr.querySelector('.card');
    if (card) { card.classList.toggle('fresh', sameScreen && !same); if (keepScroll) card.scrollTop = keepScroll; }
    const list = scr.querySelector('.list');
    if (list && listScroll) list.scrollTop = listScroll;
    const selRow = scr.querySelector('.row.sel');
    if (selRow && !sameScreen) selRow.scrollIntoView({ block: 'nearest' });
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
    if (!S.me) { c.innerHTML = ''; return; }
    let h = '<span>v' + VERSION + ' \u00b7 \u00a9 Eduardo J. Reyes 2026</span>';
    if (API.MOCK) h += '<span><b>TEST DATA</b></span><button class="navx" style="margin:0" data-act="reset">RESET TEST DATA</button>';
    c.innerHTML = h;
  }

  function toast(ev) {
    const el = $('toast');
    clearTimeout(toastT);
    el.innerHTML = '<div class="glass toast ' + (ev.kind === 'retake' ? 'shake' : '') + ' ' + (ev.kind === 'error' ? 'error' : '') + '" role="status">' +
      '<span class="av">' + (ev.kind === 'error' ? '!' : 'B') + '</span><span style="display:flex;flex-direction:column;gap:6px;min-width:0">' +
      '<span class="lbl">' + (ev.kind === 'error' ? 'BUCKY \u00b7 HEADS UP' : 'BUCKY \u00b7 DISCORD') + '</span>' +
      '<span class="msg">' + (ev.mention ? '<span class="who">' + esc(ev.mention) + '</span> ' : '') + esc(ev.text) + '</span>' +
      (ev.quote ? '<span class="quote">' + esc(ev.quote) + '</span>' : '') + '</span></div>';
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

  async function run(action, payload, progText) {
    if (progText) startProg(progText);
    try {
      const data = await API.call(action, payload);
      if (progText) { setProg(100); await sleep(250); }
      apply(data);
      return data;
    } catch (e) {
      if (e.signedOut) signedOut(); else toast({ text: e.message, kind: 'error' });
      return null;
    } finally {
      clearInterval(progT); U.prog = 0;
      U.busy = null; U.loading = false; U.up = null; U.busyAct = null;
      render();
    }
  }

  function signedOut() { API.store.set('bucky.token', null); S = { me: null }; lastKey = ''; lastScreenKey = ''; }

  async function publish(t) {
    const picks = U.picks[t.id] || {};
    U.busy = t.id; U.sel = t.id; U.busyAct = 'publish'; U.prog = 0; U.progText = 'Sending'; render();
    if (!t.slots.length) { await run('finishUpload', { taskId: t.id, note: U.note }, 'Sending'); return; }
    startProg('Preparing', 0, 5);
    let begun;
    try {
      begun = await API.call('beginUpload', { taskId: t.id, origin: location.origin,
        files: t.slots.map((s, i) => ({ i, name: picks[i].name, size: picks[i].size, type: picks[i].type })) });
    } catch (e) {
      clearInterval(progT); U.busy = null; U.busyAct = null; if (e.signedOut) signedOut(); else toast({ text: e.message, kind: 'error' }); render(); return;
    }
    U.up = { task: t.id, done: {}, total: t.slots.reduce((a, s, i) => a + picks[i].size, 0) };
    setProg(5, 'Uploading');
    render();
    try {
      for (const u of begun.uploads) {
        await API.upload(picks[u.i], u.url, (sent) => { U.up.done[u.i] = sent; paintProgress(t); });
      }
    } catch (e) {
      clearInterval(progT); U.busy = null; U.busyAct = null; U.up = null; toast({ text: e.message, kind: 'error' }); render(); return;
    }
    const note = U.note;
    delete U.picks[t.id];
    Bucky.burst();
    startProg('Finishing', 95, 99);
    try {
      const data = await API.call('finishUpload', { taskId: t.id, version: begun.version, note });
      setProg(100); await sleep(250);
      apply(data);
    } catch (e) {
      if (e.signedOut) signedOut(); else toast({ text: e.message, kind: 'error' });
    } finally {
      clearInterval(progT); U.prog = 0; U.busy = null; U.busyAct = null; U.up = null; render();
    }
  }

  function paintProgress(t) {
    const up = U.up, picks = U.picks[t.id] || {};
    if (!up) return;
    Object.keys(up.done).forEach((i) => {
      const f = picks[i], bar = $('upfill-' + i), txt = $('uptext-' + i);
      if (bar && f) bar.style.width = pctOf(up.done[i], f.size) + '%';
      if (txt) txt.textContent = upText(up, Number(i), f);
    });
    setProg(5 + 90 * sum(up.done) / (up.total || 1), 'Uploading');
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
      case 'reset': try { ['bucky.mock', 'bucky.mockprops', 'bucky.mockdrive', 'bucky.token'].forEach((k) => localStorage.removeItem(k)); } catch (e) {} location.reload(); break;
      case 'view': U.view = el.dataset.v; U.sel = null; clean(); render(); break;
      case 'ms': U.view = 'tasks'; U.ms = el.dataset.ms; U.sel = null; clean(); render(); break;
      case 'sel': U.sel = el.dataset.id; clean(); render(); break;
      case 'start': U.sel = t.id; U.busy = t.id; U.busyAct = 'start'; U.prog = 0; U.progText = 'Starting'; render(); run('start', { taskId: t.id }, 'Starting'); break;
      case 'forgot': forgot(); break;
      case 'pick': pickFile(t, Number(el.dataset.i)); break;
      case 'note': U.noteOpen = true; render(); $('note').focus(); break;
      case 'resend': U.resend = t.id; U.note = t.note || ''; U.noteOpen = !!t.note; render(); break;
      case 'noresend': U.resend = null; delete U.picks[t.id]; render(); break;
      case 'unstart': U.busy = t.id; U.busyAct = 'unstart'; U.prog = 0; U.progText = 'Going back'; render(); run('unstart', { taskId: t.id }, 'Going back'); break;
      case 'publish': publish(t); break;
      case 'approve': U.busy = t.id; U.busyAct = 'approve'; U.prog = 0; U.progText = 'Approving'; render(); Bucky.burst(); run('approve', { taskId: t.id, comment: U.fb }, 'Approving'); break;
      case 'retake': if (!U.fb.trim()) return; U.busy = t.id; U.busyAct = 'retake'; U.prog = 0; U.progText = 'Sending'; render(); run('retake', { taskId: t.id, comment: U.fb }, 'Sending'); break;
    }
  }

  async function submit(form) {
    U.error = '';
    if (form === 'gate') {
      const p = $('sitepass').value;
      U.loading = true; U.prog = 0; U.progText = 'Checking'; render(); startProg('Checking');
      try { await API.call('gate', { sitePass: p }); setProg(100); await sleep(200); API.store.set('bucky.site', p); U.gateOk = true; }
      catch (e) { U.error = e.message; }
      clearInterval(progT); U.loading = false; render();
      const em = $('email'); if (em) (em.value ? $('pass') : em).focus();
      else if ($('sitepass')) $('sitepass').focus();
    } else {
      const email = $('email').value.trim(), password = $('pass').value;
      API.store.set('bucky.email', email);
      U.loading = true; U.prog = 0; U.progText = 'Signing in'; render(); startProg('Signing in');
      try {
        const d = await API.call('login', { email, password });
        setProg(100); await sleep(250);
        API.store.set('bucky.token', d.token);
        apply(d);
      } catch (e) {
        U.error = e.message;
        if (/site password/i.test(e.message)) { API.store.set('bucky.site', null); U.gateOk = false; }
      }
      clearInterval(progT); U.loading = false; render();
      if (!S.me && $('pass')) $('pass').focus();
    }
  }

  // "Did you forget your password?": Bucky tells Eduardo on Discord
  async function forgot() {
    const em = $('email'), email = em ? em.value.trim() : '';
    if (!email) { U.error = 'Type your Gmail first, then press "Did you forget your password?"'; render(); if ($('email')) $('email').focus(); return; }
    API.store.set('bucky.email', email);
    try {
      await API.call('forgot', { email });
      U.error = '';
      toast({ text: 'Eduardo got a message. He’ll send you a new password.', kind: 'good' });
    } catch (e) { U.error = e.message; render(); }
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
      }
    });
    window.addEventListener('beforeunload', (e) => { if (U.up) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function boot() {
    startProg('Waking Bucky up', 0, 90);
    render();
    if (API.store.get('bucky.token')) {
      try { apply(await API.call('state')); } catch (e) { if (e.signedOut) signedOut(); else U.error = e.message; }
    }
    setProg(100);
    await sleep(250);
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
