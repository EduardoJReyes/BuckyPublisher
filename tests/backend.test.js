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

// New task typed into the Gantt shows up in Tasks and on the website
{
  const G2 = ss.getSheetByName('PreStart_Gantt'), gh = G2.getDataRange().getDisplayValues()[0];
  const row = G2.getLastRow() + 1;
  const put = (h, v) => G2.getRange(row, gh.indexOf(h) + 1).setValue(v);
  put('Task', 'Bucky idle animation'); put('Owner', 'Luna'); put('Start', '16 Nov'); put('End', '18 Nov');
  put('Area', 'Art'); put('Prefix', 'ANIM'); put('Approver', 'Eduardo'); put('Description', 'Idle loop, 2 s'); put('File 1', 'Video');
  G2.getRange(row, 1).setValue('2.9');
  onEdit({ range: G2.getRange(row, 1) });
  const [h2, t2] = taskRow('2.9');
  assert.ok(t2, 'task created in Tasks');
  assert.equal(t2[h2.indexOf('Status')], 'To do');
  assert.equal(t2[h2.indexOf('Milestone')], 'Pre-start');
  assert.equal(t2[h2.indexOf('Definition of done')], 'Idle loop, 2 s');
  assert.equal(ganttRow('2.9')[gh.indexOf('Status')], 'To do', 'Gantt gets the default status');
  // description edited in the Gantt
  put('Description', 'Idle loop, 3 s'); onEdit({ range: G2.getRange(row, gh.indexOf('Description') + 1) });
  assert.equal(taskRow('2.9')[1][h2.indexOf('Definition of done')], 'Idle loop, 3 s');
  const st3 = login('lunaghiso@gmail.com');
  const nt = task(st3, '2.9');
  assert.ok(nt && nt.slots[0].ext === 'mp4' && nt.startIso > 0, 'Luna sees it with its file slot and start date');
  assert.deepEqual(ok('forgot', { email: 'marctragant@gmail.com' }), { ok: true });
  console.log('backend: new tasks from the Gantt good');
}

// Manager View: only Eduardo gets the plan and can save tasks
{
  const stL = login('lunaghiso@gmail.com');
  assert.ok(!stL.isManager && !stL.plan, 'Luna gets no plan');
  bad('saveTask', { isNew: true, task: { id: '9.9', name: 'Sneaky' } }, /Only the manager/);
  const stE = login('eduardojosereyesperez@gmail.com');
  assert.ok(stE.isManager && stE.plan.tasks.length > 10, 'Eduardo gets the plan');
  assert.ok(stE.plan.team.includes('Nerina') && stE.plan.types.includes('Image') && stE.plan.prefixes.includes('ENV'));
  const p42 = stE.plan.tasks.find((t) => t.id === '4.2');
  assert.match(p42.start, /^\d{4}-\d\d-\d\d$/);
  // new task
  bad('saveTask', { isNew: true, task: { id: '4.2', name: 'Dup' } }, /already a task 4.2/);
  bad('saveTask', { isNew: true, task: { id: '2.10', name: 'X', start: '2026-11-20', due: '2026-11-18' } }, /before the start/);
  let d = ok('saveTask', { isNew: true, task: { id: '2.10', name: 'Fields props', owners: 'Nerina', approvers: 'Eduardo, Luna', area: 'Art', prefix: 'PROP',
    dod: 'Props for the Fields', file1: 'Image', labels: 'Props', deps: '2.2', start: '2026-11-19', due: '2026-11-20' } });
  const [h, r] = taskRow('2.10');
  assert.ok(r, 'created in Tasks');
  assert.equal(r[h.indexOf('Status')], 'To do');
  assert.equal(r[h.indexOf('Start')], '19 Nov');
  assert.equal(r[h.indexOf('Milestone')], 'Pre-start');
  assert.equal(r[h.indexOf('Version')], '0');
  assert.ok(taskRow('2.1')[1], 'the 2.1 row is untouched');
  const g = ganttRow('2.10'), gh = ss.getSheetByName('PreStart_Gantt').getDataRange().getDisplayValues()[0];
  assert.ok(g, 'mirrored to the Gantt');
  assert.equal(g[gh.indexOf('End')], '20 Nov');
  assert.equal(g[gh.indexOf('Owner')], 'Nerina');
  assert.ok(d.state.plan.tasks.find((t) => t.id === '2.10'));
  // edit it
  d = ok('saveTask', { task: { id: '2.10', name: 'Fields props', owners: 'Luna', status: 'In progress', start: '2026-11-19', due: '2026-11-24', dod: 'Props for the Fields, 6 of them' } });
  assert.equal(taskRow('2.10')[1][h.indexOf('Owner')], 'Luna');
  assert.equal(ganttRow('2.10')[gh.indexOf('Status')], 'In progress');
  assert.equal(ganttRow('2.10')[gh.indexOf('Description')], 'Props for the Fields, 6 of them');
  bad('saveTask', { task: { id: '7.7', name: 'Ghost' } }, /not in the sheet/);
  const stN = login('lunaghiso@gmail.com');
  assert.ok(task(stN, '2.10'), 'Luna sees her new task');
  console.log('backend: manager view good');
}
