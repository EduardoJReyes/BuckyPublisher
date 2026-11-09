// Runs backend/Code.gs on the fake Google in dev/gas-mock.js and walks the whole task loop.
// node tests/backend.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
global.window = globalThis;
for (const f of ['dev/fixture.js', 'dev/gas-mock.js', 'backend/Code.gs']) (0, eval)(fs.readFileSync(path.join(root, f), 'utf8'));

let token = null;
function call(action, extra) {
  const out = JSON.parse(doPost({ postData: { contents: JSON.stringify(Object.assign({ action, token, sitePass: '1234' }, extra || {})) } }).getContent());
  return out;
}
const ok = (action, extra) => { const r = call(action, extra); assert.ok(r.ok, action + ': ' + r.error); return r.data; };
const bad = (action, extra, re) => { const r = call(action, extra); assert.ok(!r.ok, action + ' should fail'); if (re) assert.match(r.error, re); return r.error; };
const login = (email) => { const d = ok('login', { email, password: '1234' }); token = d.token; return d.state; };
function uploadAll(taskId, files) {
  const b = ok('beginUpload', { taskId, origin: 'https://x.github.io', files });
  b.uploads.forEach((u, k) => {
    const size = files[k].size, CH = 8 * 1024 * 1024;
    for (let s = 0; s < size; s += CH) {
      const n = Math.min(CH, size - s);
      ok('chunk', { url: u.url, start: s, total: size, data: Buffer.alloc(n).toString('base64') });
    }
  });
  return b;
}
const task = (st, id) => st.tasks.find((t) => t.id === id);

// gate + login
bad('gate', { sitePass: 'nope' }, /site password/);
ok('gate', { sitePass: '1234' });
bad('login', { email: 'eduardojosereyesperez@gmail.com', password: 'x' }, /email or password/);
bad('state', {}, /SIGNED_OUT/);
let st = login('EduardoJoseReyesPerez@gmail.com');
assert.equal(st.me.key, 'eduardo');
assert.ok(st.isReviewer);

// start + publish a 20 MB pdf in chunks
ok('start', { taskId: '0.1' });
bad('beginUpload', { taskId: '0.1', files: [{ i: 0, name: 'a.png', size: 10 }] }, /needs a \.pdf/);
let b = uploadAll('0.1', [{ i: 0, name: 'agreement.pdf', size: 20 * 1024 * 1024 + 5, type: 'application/pdf' }]);
assert.equal(b.uploads[0].name, 'ADM_TeamAgreement_01.pdf');
let d = ok('finishUpload', { taskId: '0.1', version: b.version, note: 'page 2 unsigned', gif: 'party' });
assert.equal(task(d.state, '0.1').status, 'Pending review');
assert.match(d.event.mention, /@Luna/);
assert.ok(mockDiscord.at(-1).content.includes('ready for review'));
const pdf = Object.values(mockDrive.items).find((x) => x.name === 'ADM_TeamAgreement_01.pdf');
assert.ok(pdf && pdf.shared && pdf.size === 20 * 1024 * 1024 + 5);

// send again: same version, same file replaced
b = uploadAll('0.1', [{ i: 0, name: 'agreement-fixed.pdf', size: 1000, type: 'application/pdf' }]);
assert.equal(b.version, 1);
d = ok('finishUpload', { taskId: '0.1', version: 1, note: 'fixed' });
assert.equal(Object.values(mockDrive.items).filter((x) => x.name === 'ADM_TeamAgreement_01.pdf').length, 1);
assert.equal(task(d.state, '0.1').log[0].text, 'Eduardo re-sent 01');

// Marc can't review, Luna can
st = login('marctragant@gmail.com');
assert.ok(!st.isReviewer);
st = login('lunaghiso@gmail.com');
const q = task(st, '0.1');
assert.ok(q.inQueue && q.files.length === 1 && q.files[0].label === 'Signed agreement');
bad('retake', { taskId: '0.1', comment: '' }, /needs a comment/);
d = ok('retake', { taskId: '0.1', comment: 'Sign page 2 as well', gif: 'fine' });
assert.match(mockDiscord.at(-1).content, /retake on Team agreement 01/);

// back to Eduardo: sees feedback, uploads 02, Luna approves
st = login('eduardojosereyesperez@gmail.com');
assert.deepEqual([task(st, '0.1').feedback, task(st, '0.1').feedbackGif, task(st, '0.1').retakeBy], ['Sign page 2 as well', 'fine', 'Luna']);
b = uploadAll('0.1', [{ i: 0, name: 'agreement.pdf', size: 3000, type: 'application/pdf' }]);
assert.equal(b.version, 2);
ok('finishUpload', { taskId: '0.1', version: 2 });
st = login('lunaghiso@gmail.com');
d = ok('approve', { taskId: '0.1', comment: '' });
const approved = Object.values(mockDrive.items).find((x) => x.name === 'ADM_TeamAgreement_02.pdf' && mockDrive.items[x.parent].name === '_Approved');
assert.ok(approved, 'copied to _Approved');
st = login('eduardojosereyesperez@gmail.com');
assert.equal(task(st, '0.1').status, 'Approved');
assert.equal(st.milestones[0].pct, 5);

// two files with same extension get labels, no-file task needs a note
login('lunaghiso@gmail.com');
ok('start', { taskId: '2.1' });
b = uploadAll('2.1', [{ i: 0, name: 'a.png', size: 10, type: 'image/png' }, { i: 1, name: 'b.png', size: 10, type: 'image/png' }]);
assert.deepEqual(b.uploads.map((u) => u.name), ['CHR_BuckyDesign_Turnaround_01.png', 'CHR_BuckyDesign_Expressions_01.png']);
login('eduardojosereyesperez@gmail.com');
ok('start', { taskId: '0.2' });
bad('finishUpload', { taskId: '0.2', note: '' }, /find it/);
ok('finishUpload', { taskId: '0.2', note: 'Pinned in #start-here' });

// stale action: sheet edited by hand
ok('start', { taskId: '0.3' });
window.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tasks').getRange(4, 19).setValue('Approved');
bad('finishUpload', { taskId: '0.3', note: 'x' }, /Someone changed it/);
bad('chunk', { url: 'https://evil.example/x', start: 0, total: 1, data: '' }, /Bad upload/);

// Discord: one forum post per task, in the right channel, reused after the first message
const tm = mockDiscord.filter((m) => m.content.includes('Team agreement'));
assert.ok(tm.every((m) => m.hook === 'https://discord.com/api/webhooks/test/design'), 'ADM goes to design');
assert.equal(tm.filter((m) => m.title).length, 1, 'post opened once');
assert.ok(tm.slice(1).every((m) => m.thread === tm[0].thread), 'later messages reply in the same post');
assert.ok(mockDiscord.some((m) => m.hook === 'https://discord.com/api/webhooks/test/characters' && m.title === '2.1 \u00b7 Bucky design (Sketchs, Color, Poses)'));
console.log('backend: all good,', mockDiscord.length, 'Bucky messages');

// move back to To do, usernames in Discord text, docs links
login('eduardojosereyesperez@gmail.com');
ok('start', { taskId: '1.2' });
let st2 = ok('unstart', { taskId: '1.2' }).state;
assert.equal(task(st2, '1.2').status, 'To do');
assert.equal(task(st2, '1.2').log[0].text, 'Eduardo moved it back to To do');
bad('unstart', { taskId: '1.2' }, /Someone changed it/);
assert.ok(mockDiscord.some((m) => /@hir0roo/.test(m.content)), 'Luna tagged by Discord username');
assert.deepEqual(st2.links.map((l) => !!l.url), [true, true, false]);
console.log('backend: extra checks good');

// Gantt <-> Tasks: the app writes both; hand edits in either one copy across
const ss = window.SpreadsheetApp.getActiveSpreadsheet();
const ganttRow = (id) => ss.getSheetByName('PreStart_Gantt').getDataRange().getDisplayValues().find((r) => r[0] === id);
const taskRow = (id) => { const v = ss.getSheetByName('Tasks').getDataRange().getDisplayValues(); return [v[0], v.find((r) => r[0] === id)]; };
assert.equal(ganttRow('0.1')[3], 'Approved', 'app status reaches the Gantt');
const G = ss.getSheetByName('PreStart_Gantt');
const gr = G.getDataRange().getDisplayValues().findIndex((r) => r[0] === '4.2') + 1;
G.getRange(gr, 4).setValue('In progress'); G.getRange(gr, 6).setValue('20 Nov');
onEdit({ range: G.getRange(gr, 4, 1, 3) });
let [th, tr] = taskRow('4.2');
assert.equal(tr[th.indexOf('Status')], 'In progress');
assert.equal(tr[th.indexOf('Due')], '20 Nov');
const TS = ss.getSheetByName('Tasks'), trow = TS.getDataRange().getDisplayValues().findIndex((r) => r[0] === '4.3') + 1;
TS.getRange(trow, th.indexOf('Start') + 1).setValue('5 Nov');
onEdit({ range: TS.getRange(trow, th.indexOf('Start') + 1) });
assert.equal(ganttRow('4.3')[4], '5 Nov');
console.log('backend: gantt sync good');
