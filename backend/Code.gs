/**
 * Bucky Publisher backend. Lives in the AssetManager sheet: Extensions > Apps Script.
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 *
 * The website (GitHub Pages) calls this with fetch(). Everything that touches the
 * sheet or Drive happens here, as Eduardo. Artists never sign in with Google.
 *
 * Script properties (Project Settings > Script properties), one webhook per feedback channel:
 *   DISCORD_WEBHOOK_DESIGN, _CHARACTERS, _ANIMATION, _ENVIRONMENT, _UI, _AUDIO, _BUILDS
 *   (DISCORD_WEBHOOK, if set, is used for any channel without its own webhook)
 * Which channel a task goes to: the "Discord channel" column of the Naming tab (by prefix),
 * or the "Discord channel for <Area>" rows of the Settings tab for tasks with no prefix.
 * Each task gets one forum post; its ID is kept in the Tasks "Discord thread" column.
 * Settings tab in the sheet:
 *   Site password            1234
 *   Drive root folder ID     the ID of BuckyAway2026 (from its URL)
 */

var VERSION = '1.4.0';
var HOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\//;
var LEADS = ['eduardo', 'luna'];
var TOKEN_DAYS = 30;
var UPLOAD_PREFIX = 'https://www.googleapis.com/upload/drive/';
var STATUS = { todo: 'To do', prog: 'In progress', review: 'Pending review', retake: 'Retake', done: 'Approved' };
var COL = {
  id: 'ID', milestone: 'Milestone', name: 'Task', prefix: 'Prefix', asset: 'Asset', dod: 'Definition of done',
  owners: 'Owner', approvers: 'Approver', file1: 'File 1', file2: 'File 2', file3: 'File 3', labels: 'File labels',
  deps: 'Depends on', due: 'Due', status: 'Status', version: 'Version', feedback: 'Feedback', note: 'Note', updated: 'Updated',
  area: 'Area', thread: 'Discord thread'
};
var MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB hard stop, the team limit is 500 MB
var MAX_VIDEO = 8 * 1024 * 1024;

// ---------------------------------------------------------------- entry points

/** Open the /exec URL in a browser to check the backend.
    Add ?test=discord&pass=<site password> to post a test message in every feedback channel
    (&msg=... sets its text). */
function doGet(e) {
  var p = (e && e.parameter) || {}, out = ['Bucky Publisher backend ' + VERSION + ' is running.', ''];
  var props = PropertiesService.getScriptProperties().getProperties();
  var hooks = Object.keys(props).filter(function (k) { return k.indexOf('DISCORD_WEBHOOK') === 0; }).sort();
  out.push('Discord webhooks set: ' + (hooks.length ? hooks.join(', ') : 'none'));
  if (p.test === 'discord') {
    try {
      checkSitePass(p.pass);
      var msg = String(p.msg || 'Bucky is connected.').slice(0, 500);
      out.push('');
      hooks.forEach(function (k) {
        if (!HOOK_RE.test(props[k])) { out.push(k + ': NOT A WEBHOOK URL. It must start with https://discord.com/api/webhooks/ (it is "' + String(props[k]).slice(0, 40) + '")'); return; }
        var r = post(props[k] + (props[k].indexOf('?') === -1 ? '?' : '&') + 'wait=true',
          { username: 'Bucky', content: msg, thread_name: String(msg).slice(0, 100) });
        out.push(k + ': ' + (r.code < 300 ? 'OK, check the channel' : 'FAILED ' + r.code + ' ' + JSON.stringify(r.body)));
      });
    } catch (err) { out.push('Test refused: ' + (err.userMessage || err)); }
  }
  return ContentService.createTextOutput(out.join('\n'));
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    out = { ok: true, data: handle(req) };
  } catch (err) {
    out = { ok: false, error: err && err.userMessage ? err.userMessage : String(err && err.message || err) };
    if (!(err && err.userMessage)) console.error(err && err.stack || err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  var a = req.action;
  if (a === 'gate') { checkSitePass(req.sitePass); return { ok: true }; }
  if (a === 'login') return login(req.sitePass, req.email, req.password);
  if (a === 'forgot') return forgot(req.sitePass, req.email);
  var me = whoIs(req.token);
  switch (a) {
    case 'state': return { state: state(me) };
    case 'logout': PropertiesService.getScriptProperties().deleteProperty('tok_' + req.token); return {};
    case 'start': return withLock(function () { return start(me, req.taskId); });
    case 'unstart': return withLock(function () { return unstart(me, req.taskId); });
    case 'beginUpload': return withLock(function () { return beginUpload(me, req); });
    case 'chunk': return chunk(req);
    case 'finishUpload': return withLock(function () { return finishUpload(me, req); });
    case 'approve': return withLock(function () { return review(me, req, true); });
    case 'retake': return withLock(function () { return review(me, req, false); });
    case 'files': var FD = loadData(); return { files: filesFor(FD, FD.task(req.taskId)) };
  }
  fail('Unknown action: ' + a);
}

function fail(msg) { var e = new Error(msg); e.userMessage = msg; throw e; }

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail('Bucky is busy with someone else. Try again in a few seconds.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- sheet

function tab(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) fail('The sheet has no "' + name + '" tab.');
  var values = sh.getDataRange().getDisplayValues();
  var head = (values[0] || []).map(function (h) { return String(h).trim(); });
  var rows = values.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { if (h) o[h] = String(r[j] == null ? '' : r[j]).trim(); });
    return o;
  });
  return { sheet: sh, head: head, rows: rows };
}

function settings() {
  var out = {};
  tab('Settings').rows.forEach(function (r) { var k = r['Setting'] || r['Key']; if (k) out[k] = r['Value']; });
  return out;
}

function splitNames(t) {
  return String(t || '').replace(/&/g, ',').split(',').map(function (s) { return s.trim(); }).filter(String);
}

var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseDate(text, yearHint, startMonth) {
  text = String(text || '').trim();
  if (!text) return null;
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  var p = text.replace(',', ' ').split(/\s+/);
  var d = parseInt(p[0], 10), m = MONTHS[(p[1] || '').slice(0, 3).toLowerCase()];
  if (isNaN(d) || m == null) return null;
  var y = p[2] && /^\d+$/.test(p[2]) ? +p[2] : (yearHint || new Date().getFullYear());
  if (!(p[2] && /^\d+$/.test(p[2])) && startMonth != null && m < startMonth) y += 1;
  return new Date(y, m, d);
}

function loadData() {
  var types = {};
  tab('File types').rows.forEach(function (r) { if (r['Type']) types[r['Type']] = (r['Extension'] || '').replace(/^\./, '').toLowerCase(); });
  var naming = {};
  var channels = {};
  tab('Naming').rows.forEach(function (r) { if (r['Prefix']) { naming[r['Prefix']] = r['Drive folder'] || ''; channels[r['Prefix']] = r['Discord channel'] || ''; } });
  var team = {};
  tab('Team').rows.forEach(function (r) {
    var name = r['Name'] || String(r['Full name'] || '').split(' ')[0];
    if (!name) return;
    team[name.toLowerCase()] = { key: name.toLowerCase(), name: name, full: r['Full name'] || name, role: r['Role'] || '',
      email: String(r['Gmail'] || '').toLowerCase(), discord: r['Discord ID'] || '', discordName: String(r['Discord username'] || '').replace(/^@/, ''), password: r['Password'] || '' };
  });
  var milestones = tab('Milestones').rows.filter(function (r) { return r['Milestone']; }).map(function (r) {
    return { id: r['Milestone'], name: r['Name'] || r['Milestone'], start: parseDate(r['Start']), end: parseDate(r['End']) };
  });
  var msById = {};
  milestones.forEach(function (m) { msById[m.id] = m; });
  var T = tab('Tasks');
  var tasks = T.rows.filter(function (r) { return r[COL.id] && r[COL.name]; }).map(function (r) {
    var ms = msById[r[COL.milestone]];
    var labels = splitNames(r[COL.labels]);
    var slots = [COL.file1, COL.file2, COL.file3].map(function (c) { return r[c]; }).filter(String).map(function (type, i) {
      return { label: labels[i] || '', type: type, ext: types[type] || '' };
    });
    return {
      id: r[COL.id], ms: r[COL.milestone], name: r[COL.name], prefix: r[COL.prefix], asset: r[COL.asset], dod: r[COL.dod],
      owners: splitNames(r[COL.owners]), approvers: splitNames(r[COL.approvers]), slots: slots, deps: splitNames(r[COL.deps]),
      due: r[COL.due], dueDate: parseDate(r[COL.due], ms && ms.start ? ms.start.getFullYear() : null, ms && ms.start ? ms.start.getMonth() : null),
      startDate: parseDate(r['Start'], ms && ms.start ? ms.start.getFullYear() : null, ms && ms.start ? ms.start.getMonth() : null),
      status: r[COL.status] || STATUS.todo, version: parseInt(r[COL.version] || '0', 10) || 0,
      feedback: r[COL.feedback] || '', note: r[COL.note] || '', row: r._row, area: r[COL.area] || '', thread: r[COL.thread] || ''
    };
  });
  var log = tab('Log').rows.filter(function (r) { return r['Task ID']; }).map(function (r) {
    return { when: r['Time'], task: r['Task ID'], version: parseInt(r['Version'] || '0', 10) || 0, who: r['Who'],
      from: r['From status'], to: r['To status'], text: r['Note or feedback'] };
  });
  return {
    team: team, tasks: tasks, milestones: milestones, naming: naming, channels: channels, log: log, head: T.head, sheet: T.sheet,
    task: function (id) { for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i]; fail('No task ' + id + ' in the sheet.'); }
  };
}

function writeTask(D, t, values) {
  Object.keys(values).forEach(function (h) {
    var c = D.head.indexOf(h);
    if (c === -1) fail('The Tasks tab has no "' + h + '" column.');
    D.sheet.getRange(t.row, c + 1).setValue(values[h]);
  });
  // keep the Gantt in step (script writes don't fire onEdit)
  try {
    var g = {};
    Object.keys(values).forEach(function (h) { if (TASKS_TO_GANTT[h]) g[TASKS_TO_GANTT[h]] = values[h]; });
    if (Object.keys(g).length) writeRow(GANTT, t.id, g);
  } catch (e) { console.warn('Gantt sync failed', e); }
}

// ---------------------------------------------------------------- Gantt <-> Tasks
// PreStart_Gantt is where tasks are planned and edited. Every column below is copied to
// the Tasks tab (the full record the website reads), and changes from the website are
// written back. A new ID typed in an empty Gantt row creates the task in Tasks.
var GANTT = 'PreStart_Gantt';
var GANTT_MILESTONE = 'Pre-start';
var GANTT_TO_TASKS = {
  'Task': 'Task', 'Owner': 'Owner', 'Status': 'Status', 'Start': 'Start', 'End': 'Due', 'Area': 'Area', 'Prefix': 'Prefix',
  'Approver': 'Approver', 'Description': 'Definition of done', 'Output': 'Output', 'File 1': 'File 1', 'File 2': 'File 2',
  'File 3': 'File 3', 'File labels': 'File labels', 'Depends on': 'Depends on'
};
var TASKS_TO_GANTT = {};
Object.keys(GANTT_TO_TASKS).forEach(function (k) { TASKS_TO_GANTT[GANTT_TO_TASKS[k]] = k; });

function headersOf(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
}

/** Write values (by header) into the row of sheet `name` whose ID (column A) is `id`.
    With create=true and no such row, the ID goes in the first empty row first. */
function writeRow(name, id, values, create) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return false;
  var head = headersOf(sh);
  var last = Math.max(sh.getLastRow(), 1);
  var ids = sh.getRange(1, 1, last, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); });
  var row = ids.indexOf(String(id).trim());
  if (row < 1) {
    if (!create) return false;
    var empty = ids.indexOf('', 1);
    row = empty === -1 ? last : empty;
    sh.getRange(row + 1, 1).setValue(id);
  }
  Object.keys(values).forEach(function (h) {
    var c = head.indexOf(h);
    if (c !== -1 && h !== 'Asset') sh.getRange(row + 1, c + 1).setValue(values[h]);
  });
  return true;
}

/** Simple trigger: runs when someone edits the sheet by hand. */
function onEdit(e) {
  try {
    var range = e.range, sh = range.getSheet(), name = sh.getName();
    var fromGantt = name === GANTT, map = fromGantt ? GANTT_TO_TASKS : name === 'Tasks' ? TASKS_TO_GANTT : null;
    if (!map) return;
    var head = headersOf(sh);
    var r0 = range.getRow(), c0 = range.getColumn(), nr = range.getNumRows(), nc = range.getNumColumns();
    var idEdited = c0 === 1;
    var cols = [];
    for (var c = c0; c < c0 + nc; c++) if (map[head[c - 1]]) cols.push(c);
    if (!cols.length && !(fromGantt && idEdited)) return;
    for (var i = 0; i < nr; i++) {
      var r = r0 + i;
      if (r < 2) continue;
      var id = String(sh.getRange(r, 1).getDisplayValue()).trim();
      if (!id) continue;
      var out = {};
      // a new ID in the Gantt (or a row whose ID is not in Tasks yet): copy the whole row
      var rowCols = cols;
      if (fromGantt && (idEdited || !writeRow('Tasks', id, {}, false))) {
        rowCols = [];
        head.forEach(function (h, j) { if (map[h]) rowCols.push(j + 1); });
      }
      rowCols.forEach(function (c) { out[map[head[c - 1]]] = sh.getRange(r, c).getValue(); });
      if (fromGantt) {
        var created = !writeRow('Tasks', id, {}, false);
        if (created) {
          if (!out[COL.status]) { out[COL.status] = STATUS.todo; sh.getRange(r, head.indexOf('Status') + 1).setValue(STATUS.todo); }
          out[COL.milestone] = GANTT_MILESTONE;
          out[COL.version] = 0;
        }
        if (out[COL.status] !== undefined) out[COL.updated] = stamp();
        writeRow('Tasks', id, out, created);
      } else {
        writeRow(GANTT, id, out, false);
      }
    }
  } catch (err) { console.warn('onEdit sync failed', err); }
}

function stamp() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }

function addLog(t, version, who, from, to, text, sent) {
  tab('Log').sheet.appendRow([stamp(), t.id, version, who, from, to, text || '', sent === true ? 'yes' : (sent || '')]);
}

// ---------------------------------------------------------------- login

function checkSitePass(p) {
  if (String(p || '') !== String(settings()['Site password'] || '')) fail('Wrong site password.');
}

function login(sitePass, email, password) {
  checkSitePass(sitePass);
  var D = loadData();
  email = String(email || '').trim().toLowerCase();
  var me = null;
  Object.keys(D.team).forEach(function (k) { if (D.team[k].email === email) me = D.team[k]; });
  if (!me || !me.password || String(password || '') !== me.password) fail('Wrong email or password.');
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(function (k) {   // drop expired logins
    if (k.indexOf('tok_') === 0) { try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } }
  });
  var token = Utilities.getUuid();
  props.setProperty('tok_' + token, JSON.stringify({ u: me.key, exp: now + TOKEN_DAYS * 864e5 }));
  return { token: token, state: state(me.key) };
}

/** "Did you forget your password?": tells Eduardo on Discord (DISCORD_WEBHOOK_ADMIN), if set.
    Always answers the same, so it can't be used to find out who is on the team. */
function forgot(sitePass, email) {
  checkSitePass(sitePass);
  email = String(email || '').trim().toLowerCase();
  if (!email) fail('Type your Gmail first.');
  var D = loadData(), who = null;
  Object.keys(D.team).forEach(function (k) { if (D.team[k].email === email) who = D.team[k]; });
  var hook = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_ADMIN');
  if (hook && HOOK_RE.test(hook)) {
    var text = (who ? who.full + ' (' + email + ')' : 'Someone using ' + email + ' (not in the Team tab)') + ' forgot their Bucky Publisher password.';
    post(hook, { username: 'Bucky', content: mention(D, 'eduardo') + ' ' + text, allowed_mentions: { parse: ['users'] } });
  }
  return { ok: true };
}

function whoIs(token) {
  var raw = token && PropertiesService.getScriptProperties().getProperty('tok_' + token);
  if (!raw) { var e = new Error('Signed out'); e.userMessage = 'SIGNED_OUT'; throw e; }
  var t = JSON.parse(raw);
  if (t.exp < Date.now()) { var e2 = new Error('Signed out'); e2.userMessage = 'SIGNED_OUT'; throw e2; }
  return t.u;
}

// ---------------------------------------------------------------- rules

function isOwner(t, k) { return t.owners.some(function (o) { return o.toLowerCase() === k; }); }

function reviewers(t) {
  var keys = t.approvers.map(function (a) { return a.toLowerCase(); });
  if (!keys.length) keys = LEADS.slice();
  var others = keys.filter(function (k) { return !isOwner(t, k); });
  return others.length ? others : keys;
}

function blockers(D, t) {
  return t.deps.map(function (id) { return D.tasks.filter(function (x) { return x.id === id; })[0]; })
    .filter(function (x) { return x && x.status !== STATUS.done; });
}

function camel(text) {
  var words = String(text || '').replace(/\(.*?\)|\[.*?\]/g, ' ').match(/[A-Za-z0-9]+/g) || [];
  return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
}

function vtag(v) { return (v < 10 ? '0' : '') + v; }

function assetName(t) {
  if (t.asset) return t.asset;
  if (!t.prefix) fail('Task ' + t.id + ' has no Prefix, so its files can\'t be named.');
  return t.prefix + '_' + camel(t.name);
}

function fileNames(t, v) {
  var base = assetName(t), byExt = {}, seen = {};
  t.slots.forEach(function (s) { byExt[s.ext] = (byExt[s.ext] || 0) + 1; });
  return t.slots.map(function (s) {
    seen[s.type] = (seen[s.type] || 0) + 1;
    if (byExt[s.ext] > 1) return base + '_' + (camel(s.label) || camel(s.type) + seen[s.type]) + '_' + vtag(v) + '.' + s.ext;
    return base + '_' + vtag(v) + '.' + s.ext;
  });
}

function folderParts(D, t, v) {
  var f = D.naming[t.prefix];
  if (!f) fail('Prefix "' + t.prefix + '" isn\'t in the Naming tab.');
  return f.split('/').filter(String).concat([assetName(t), v === '_Approved' ? '_Approved' : vtag(v)]);
}

function slotLabel(s) { return s.label || s.type; }

function pack(text, gif) { text = String(text || '').trim(); return gif ? text + '\n[gif:' + gif + ']' : text; }

function unpack(text) {
  text = String(text || '');
  var m = text.match(/\n?\[gif:([^\]]+)\]\s*$/);
  return m ? { text: text.slice(0, m.index).trim(), gif: m[1] } : { text: text.trim(), gif: null };
}

// ---------------------------------------------------------------- drive

function root() {
  var id = settings()['Drive root folder ID'];
  if (!id) fail('Set "Drive root folder ID" in the Settings tab.');
  return DriveApp.getFolderById(id);
}

function folder(parts, create) {
  var f = root();
  for (var i = 0; i < parts.length; i++) {
    var it = f.getFoldersByName(parts[i]);
    if (it.hasNext()) f = it.next();
    else if (create) f = f.createFolder(parts[i]);
    else return null;
  }
  return f;
}

function share(f) {
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('share failed', e); }
}

function fileInfo(f) {
  var id = f.getId(), mime = f.getMimeType();
  return { id: id, name: f.getName(), mime: mime, size: f.getSize(),
    view: 'https://drive.google.com/file/d/' + id + '/view',
    download: 'https://drive.google.com/uc?export=download&id=' + id,
    preview: /^video\//.test(mime) ? 'https://drive.google.com/file/d/' + id + '/preview' : '',
    thumb: /^image\//.test(mime) ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600' : '' };
}

function filesFor(D, t) {
  if (!t.slots.length || !t.version) return [];
  var f = folder(folderParts(D, t, t.version), false);
  if (!f) return [];
  var names = fileNames(t, t.version), out = [];
  names.forEach(function (n, i) {
    var it = f.getFilesByName(n);
    if (it.hasNext()) { var info = fileInfo(it.next()); info.label = slotLabel(t.slots[i]); out.push(info); }
  });
  return out;
}

// ---------------------------------------------------------------- discord

function mention(D, key) {
  var p = D.team[key];
  if (!p) return '';
  // A real ping needs the numeric Discord ID; a username alone shows as text
  if (/^\d{5,}$/.test(String(p.discord))) return '<@' + p.discord + '>';
  return '@' + (p.discordName || p.name);
}

function channelFor(D, t) {
  if (t.prefix && D.channels[t.prefix]) return D.channels[t.prefix];
  var S = settings();
  return S['Discord channel for ' + t.area] || S['Discord channel for other tasks'] || 'design';
}

function post(url, body) {
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(body) });
  var out = { code: res.getResponseCode(), body: {} };
  try { out.body = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  return out;
}

/** One forum post per task in its feedback channel. The first message opens the post,
    the rest reply inside it. Returns true if Discord took the message. */
function discord(D, t, keys, text, quote) {
  var props = PropertiesService.getScriptProperties(), ch = channelFor(D, t);
  var hook = props.getProperty('DISCORD_WEBHOOK_' + String(ch).toUpperCase().replace(/[^A-Z0-9]/g, '_')) || props.getProperty('DISCORD_WEBHOOK');
  if (!hook) return 'no webhook for ' + ch;
  if (!HOOK_RE.test(hook)) return 'the webhook for ' + ch + ' is not a Discord webhook URL';
  var content = keys.map(function (k) { return mention(D, k); }).filter(String).join(' ');
  content = (content ? content + ' ' : '') + text + (quote ? '\n> ' + quote.replace(/\n/g, '\n> ') : '');
  var body = { username: 'Bucky', content: content.slice(0, 1900), allowed_mentions: { parse: ['users'] } };
  var sep = hook.indexOf('?') === -1 ? '?' : '&';
  try {
    if (t.thread) {
      var r = post(hook + sep + 'wait=true&thread_id=' + encodeURIComponent(t.thread), body);
      if (r.code < 300) return true;
      if (r.code !== 404 && r.code !== 400) return 'Discord ' + r.code + ': ' + JSON.stringify(r.body).slice(0, 150);
      // the post was deleted: open a new one below
    }
    var title = (t.id + ' · ' + t.name).slice(0, 100);
    var made = post(hook + sep + 'wait=true', Object.assign({ thread_name: title }, body));
    if (made.code < 300) {
      var id = made.body.channel_id;
      if (id) { try { writeTask(D, t, objOf(COL.thread, id)); t.thread = id; } catch (e) { console.warn('no Discord thread column', e); } }
      return true;
    }
    // not a forum channel: post a normal message
    var plain = post(hook + sep + 'wait=true', body);
    if (plain.code < 300) return true;
    return 'Discord ' + made.code + ': ' + JSON.stringify(made.body).slice(0, 150);
  } catch (e) { return 'Discord error: ' + String(e).slice(0, 150); }
}

function names(D, keys) { return keys.map(function (k) { return '@' + (D.team[k] ? D.team[k].name : k); }).join(' '); }

// ---------------------------------------------------------------- actions

function fresh(D, id, allowed) {
  var t = D.task(id);
  if (allowed.indexOf(t.status) === -1) fail(t.name + ' is now "' + t.status + '". Someone changed it, so nothing was sent.');
  return t;
}

function done(me, ev) { return { state: state(me), event: ev }; }

function start(me, id) {
  var D = loadData(), t = fresh(D, id, [STATUS.todo]);
  if (!isOwner(t, me)) fail('Only the task\'s owner can start it.');
  writeTask(D, t, objOf(COL.status, STATUS.prog, COL.updated, stamp()));
  var who = D.team[me].name, msg = who + ' started ' + t.name + '.';
  addLog(t, t.version, who, t.status, STATUS.prog, '', discord(D, t, [], msg));
  return done(me, { mention: '', text: msg });
}

function unstart(me, id) {
  var D = loadData(), t = fresh(D, id, [STATUS.prog]);
  if (!isOwner(t, me)) fail('Only the task\'s owner can do that.');
  writeTask(D, t, objOf(COL.status, STATUS.todo, COL.updated, stamp()));
  var who = D.team[me].name, msg = who + ' moved ' + t.name + ' back to To do.';
  addLog(t, t.version, who, t.status, STATUS.todo, '', discord(D, t, [], msg));
  return done(me, { mention: '', text: msg });
}

function objOf() { var o = {}; for (var i = 0; i < arguments.length; i += 2) o[arguments[i]] = arguments[i + 1]; return o; }

/** Step 1 of publishing: check everything, make the folder, open one resumable upload per file. */
function beginUpload(me, req) {
  var D = loadData(), t = fresh(D, req.taskId, [STATUS.prog, STATUS.retake, STATUS.review]);
  if (!isOwner(t, me)) fail('Only the task\'s owner can publish it.');
  var files = req.files || [];
  if (files.length !== t.slots.length) fail('Add every file first.');
  var again = t.status === STATUS.review, v = again ? t.version : t.version + 1;
  var names = fileNames(t, v), dir = folder(folderParts(D, t, v), true);
  var origin = String(req.origin || '');
  var token = ScriptApp.getOAuthToken();
  var uploads = files.map(function (f) {
    var s = t.slots[f.i];
    if (!s) fail('Unknown file slot.');
    if (s.ext && String(f.name || '').toLowerCase().slice(-(s.ext.length + 1)) !== '.' + s.ext) fail(slotLabel(s) + ' needs a .' + s.ext + ' file.');
    if (!(f.size > 0)) fail(slotLabel(s) + ' is empty.');
    if (f.size > MAX_BYTES) fail(slotLabel(s) + ' is over 2 GB.');
    if (s.ext === 'mp4' && f.size > MAX_VIDEO) fail('Videos must be under 8 MB so Discord can show them.');
    var name = names[f.i], existing = dir.getFilesByName(name);
    var replaceId = existing.hasNext() ? existing.next().getId() : null;   // send again: same name, replace content
    var url = replaceId
      ? UPLOAD_PREFIX + 'v3/files/' + replaceId + '?uploadType=resumable&supportsAllDrives=true'
      : UPLOAD_PREFIX + 'v3/files?uploadType=resumable&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, {
      method: replaceId ? 'patch' : 'post',
      contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, 'X-Upload-Content-Type': f.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(f.size), Origin: origin },
      payload: JSON.stringify(replaceId ? { name: name } : { name: name, parents: [dir.getId()] })
    });
    if (res.getResponseCode() >= 300) fail('Drive refused the upload: ' + res.getContentText().slice(0, 200));
    var loc = res.getHeaders()['Location'] || res.getHeaders()['location'];
    return { i: f.i, name: name, url: loc };
  });
  return { version: v, again: again, uploads: uploads };
}

/** Fallback when the browser can't talk to Drive directly: the script forwards one chunk. */
function chunk(req) {
  if (String(req.url || '').indexOf(UPLOAD_PREFIX) !== 0) fail('Bad upload address.');
  var bytes = Utilities.base64Decode(req.data || '');
  var end = req.start + bytes.length - 1;
  var res = UrlFetchApp.fetch(req.url, { method: 'put', muteHttpExceptions: true, contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + req.start + '-' + end + '/' + req.total }, payload: bytes });
  var code = res.getResponseCode(), h = res.getHeaders();
  var out = { status: code, range: h['Range'] || h['range'] || '' };
  if (code === 200 || code === 201) out.file = JSON.parse(res.getContentText() || '{}');
  else if (code !== 308) fail('Upload chunk failed (' + code + ').');
  return out;
}

/** Step 2: the files are on Drive. Check them, share them, update the row, tell Bucky. */
function finishUpload(me, req) {
  var D = loadData(), t = fresh(D, req.taskId, [STATUS.prog, STATUS.retake, STATUS.review]);
  if (!isOwner(t, me)) fail('Only the task\'s owner can publish it.');
  var note = String(req.note || '').trim();
  var again = t.status === STATUS.review, v = t.slots.length ? Number(req.version) : (again ? t.version : t.version + 1);
  if (t.slots.length) {
    var dir = folder(folderParts(D, t, v), false);
    if (!dir) fail('The upload folder is missing on Drive.');
    fileNames(t, v).forEach(function (n) {
      var it = dir.getFilesByName(n);
      if (!it.hasNext()) fail(n + ' didn\'t arrive on Drive. Try again.');
      share(it.next());
    });
    share(dir);
  } else if (!note) {
    fail('Write where the reviewer can find it.');
  }
  writeTask(D, t, objOf(COL.status, STATUS.review, COL.version, v, COL.note, pack(note, req.gif), COL.updated, stamp()));
  var tag = vtag(v), revs = reviewers(t);
  var msg = t.name + ' ' + tag + (again ? ' was sent again with fixes. Review this one instead.' : ' is ready for review.');
  var sent = discord(D, t, revs, msg, note);
  addLog(t, v, D.team[me].name, t.status, STATUS.review, (again ? 're-sent: ' : '') + note, sent);
  return done(me, { mention: names(D, revs), text: msg, quote: note, gif: req.gif || null, kind: 'good' });
}

function review(me, req, ok) {
  var D = loadData(), t = fresh(D, req.taskId, [STATUS.review]);
  if (reviewers(t).indexOf(me) === -1) fail('You\'re not a reviewer on this task.');
  var comment = String(req.comment || '').trim();
  if (!ok && !comment) fail('A retake needs a comment.');
  var who = D.team[me].name, tag = vtag(t.version), owners = t.owners.map(function (o) { return o.toLowerCase(); });
  if (ok && t.slots.length) {
    var src = folder(folderParts(D, t, t.version), false);
    if (!src) fail('That version\'s folder isn\'t on Drive.');
    var dst = folder(folderParts(D, t, '_Approved'), true);
    var old = dst.getFiles();
    while (old.hasNext()) old.next().setTrashed(true);
    var it = src.getFiles();
    while (it.hasNext()) { var f = it.next(); share(f.makeCopy(f.getName(), dst)); }
    share(dst);
  }
  var status = ok ? STATUS.done : STATUS.retake;
  writeTask(D, t, objOf(COL.status, status, COL.feedback, pack(comment, req.gif), COL.updated, stamp()));
  var msg = ok ? t.name + ' ' + tag + ' approved by ' + who + '.' : 'retake on ' + t.name + ' ' + tag + ', from ' + who + ':';
  var sent = discord(D, t, owners, msg, comment);
  addLog(t, t.version, who, t.status, status, comment, sent);
  return done(me, { mention: names(D, owners), text: msg, quote: comment, gif: req.gif || null, kind: ok ? 'good' : 'retake' });
}

// ---------------------------------------------------------------- state for the page

function fmtDay(d) { return d ? d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] : ''; }

function historyText(e) {
  var v = vtag(e.version);
  if (e.from === STATUS.todo && e.to === STATUS.prog) return e.who + ' started the task';
  if (e.from === STATUS.prog && e.to === STATUS.todo) return e.who + ' moved it back to To do';
  if (e.from === STATUS.review && e.to === STATUS.review) return e.who + ' re-sent ' + v;
  if (e.to === STATUS.review) return e.who + ' sent ' + v;
  if (e.to === STATUS.done) return e.who + ' approved ' + v;
  if (e.to === STATUS.retake) return e.who + ' asked for a retake on ' + v;
  return e.who + ' set it to ' + e.to;
}

function state(me) {
  var D = loadData(), p = D.team[me];
  if (!p) fail('SIGNED_OUT');
  var reviewer = D.tasks.some(function (t) { return reviewers(t).indexOf(me) !== -1; }) || LEADS.indexOf(me) !== -1;
  var pct = {};
  D.milestones.forEach(function (m) {
    var ts = D.tasks.filter(function (t) { return t.ms === m.id; });
    pct[m.id] = ts.length ? ts.filter(function (t) { return t.status === STATUS.done; }).length / ts.length : 0;
  });
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var milestones = D.milestones.map(function (m) {
    return { id: m.id, name: m.name, pct: Math.round(pct[m.id] * 100),
      dates: m.start && m.end ? pad(m.start.getDate()) + '.' + pad(m.start.getMonth() + 1) + ' / ' + pad(m.end.getDate()) + '.' + pad(m.end.getMonth() + 1) : '',
      planned: D.tasks.some(function (t) { return t.ms === m.id; }),
      mineOpen: D.tasks.filter(function (t) { return t.ms === m.id && isOwner(t, me) && t.status !== STATUS.done; }).length };
  });
  var ids = Object.keys(pct), avg = ids.length ? Math.round(ids.reduce(function (a, k) { return a + pct[k]; }, 0) / ids.length * 100) : 0;
  var tasks = [];
  D.tasks.forEach(function (t) {
    var mine = isOwner(t, me), inQueue = t.status === STATUS.review && reviewers(t).indexOf(me) !== -1;
    if (!mine && !inQueue) return;
    var fb = unpack(t.feedback), nt = unpack(t.note);
    var hist = D.log.filter(function (e) { return e.task === t.id; }).reverse();
    var retakeBy = (hist.filter(function (e) { return e.to === STATUS.retake; })[0] || {}).who || '';
    tasks.push({
      id: t.id, name: t.name, ms: t.ms, status: t.status, dod: t.dod, due: fmtDay(t.dueDate) || t.due,
      dueIso: t.dueDate ? t.dueDate.getTime() : 0, startIso: t.startDate ? t.startDate.getTime() : 0, version: t.version, vtag: vtag(t.version),
      owners: t.owners.join(' & '), reviewers: reviewers(t).map(function (k) { return D.team[k] ? D.team[k].name : k; }),
      feedback: fb.text, feedbackGif: fb.gif, retakeBy: retakeBy, note: nt.text, noteGif: nt.gif,
      slots: t.slots.map(function (s) { return { label: slotLabel(s), ext: s.ext }; }),
      blockers: blockers(D, t).map(function (b) { return b.name; }),
      log: hist.map(function (e) { return { when: e.when, text: historyText(e) }; }),
      mine: mine, inQueue: inQueue, files: inQueue ? filesFor(D, t) : null
    });
  });
  var S = settings();
  var links = [['One Page', 'PITCH', 'Link: One Page'], ['Bucky Bible', 'GAME DESIGN DOC', 'Link: Bucky Bible'], ['Discord server', 'CHAT', 'Link: Discord server']]
    .map(function (l) { return { label: l[0], kind: l[1], url: /^https?:\/\//.test(S[l[2]] || '') ? S[l[2]] : '' }; });
  return { me: { key: p.key, name: p.name, full: p.full }, isReviewer: reviewer, milestones: milestones, avg: avg, tasks: tasks, links: links, backend: VERSION };
}
