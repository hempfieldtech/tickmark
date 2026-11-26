// End-to-end sync test against a real CalDAV server.
//   CALDAV_TEST_URL=http://127.0.0.1:5232/ CALDAV_TEST_USER=test node --test 'test/*.test.js'
// Skipped when CALDAV_TEST_URL is unset. Creates (and leaves) a fresh calendar per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { Index } from '../server/db.js';
import { SyncEngine } from '../server/sync.js';
import { CalDAV } from '../server/caldav.js';
import { buildTodo, parseICS, findTodo, todoModel } from '../server/ical.js';

const URL_ = process.env.CALDAV_TEST_URL;
const USER = process.env.CALDAV_TEST_USER || 'test';
const PASS = process.env.CALDAV_TEST_PASS || '';

test('bi-directional sync', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-'));
  const calUrl = new URL(`/${USER}/tickmark-test-${Date.now()}/`, URL_).href;
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  await client.request('MKCALENDAR', calUrl, {
    body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Tickmark test</d:displayname>' +
      '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
  });

  const cfg = { accounts: [{ id: 'a1', name: 'Test', url: URL_, username: USER, password: PASS, calendarUrl: calUrl, itemTags: ['task'], sectionTags: ['sync'], inboxFile: 'Inbox.md' }] };
  const index = new Index(path.join(dir, 'data', 'index.sqlite'));
  const vault = new Vault(path.join(dir, 'vault'), { onWrite: (rel, c) => rel && c != null && index.indexFile(rel, c) });
  const engine = new SyncEngine({ vault, index, getConfig: () => cfg, log: () => {} });
  const read = (p) => fs.readFileSync(path.join(dir, 'vault', p), 'utf8');
  const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, 'vault', p)), { recursive: true }); fs.writeFileSync(path.join(dir, 'vault', p), s); };
  const remote = async () => (await client.listTodos(calUrl)).map((r) => ({ ...r, ...todoModel(findTodo(parseICS(r.ics))) }));
  const byTitle = async (title) => (await remote()).find((r) => r.model.title === title);
  const editRemote = async (title, patch) => {
    const r = await byTitle(title);
    await client.put(r.url, buildTodo({ existing: r.ics, uid: r.uid, model: { ...r.model, ...patch } }), { etag: r.etag });
  };

  write('Projects/Plan.md', `# Plan
- [ ] Call dentist #task 📅 2026-11-25
- [ ] Untagged item
## Groceries #sync
- [ ] Milk
- [x] Eggs ✅ 2026-11-20
`);

  await t.test('pushes tagged and section items with block ids', async () => {
    const r = await engine.run();
    assert.equal(r.created, 2, JSON.stringify(r));
    const text = read('Projects/Plan.md');
    assert.equal((text.match(/\^t[a-z0-9]{7}/g) || []).length, 2);
    assert.doesNotMatch(text, /Untagged item \^/);
    const dentist = await byTitle('Call dentist');
    assert.equal(dentist.model.due, '2026-11-25');
    // Already completed before it ever synced: stays in the note only.
    assert.match(text, /- \[x\] Eggs ✅ 2026-11-20\n/);
    assert.equal(await byTitle('Eggs'), undefined);
  });

  await t.test('second run is a no-op', async () => {
    const r = await engine.run();
    assert.deepEqual([r.created, r.pushed, r.pulled, r.imported], [0, 0, 0, 0]);
  });

  await t.test('the index stores no server URLs or user names', () => {
    const rows = index.db.prepare("SELECT href AS v FROM sync_states UNION ALL SELECT value FROM meta").all().map((r) => r.v);
    assert.ok(rows.length >= 3);
    for (const v of rows) assert.doesNotMatch(v, /^https?:|127\.0\.0\.1/, v);
  });

  await t.test('pulls remote completion and rename', async () => {
    await editRemote('Milk', { done: true, title: 'Oat milk' });
    const r = await engine.run();
    assert.equal(r.pulled, 1);
    assert.match(read('Projects/Plan.md'), /- \[x\] Oat milk ✅ \d{4}-\d\d-\d\d \^t/);
    assert.match(read('Projects/Plan.md'), /## Groceries #sync\n[^#]*\n### Complete\n- \[x\] Oat milk/, 'filed under Complete, still in its #sync section');
    assert.equal((await engine.run()).pushed, 0, 'moving it is not a change to send');
  });

  await t.test('pushes local edits', async () => {
    write('Projects/Plan.md', read('Projects/Plan.md').replace('📅 2026-11-25', '⏫ 📅 2026-12-02'));
    const r = await engine.run();
    assert.equal(r.pushed, 1);
    const d = await byTitle('Call dentist');
    assert.equal(d.model.due, '2026-12-02');
    assert.equal(d.model.priority, 1);
  });

  await t.test('merges concurrent edits to different fields', async () => {
    write('Projects/Plan.md', read('Projects/Plan.md').replace('Call dentist', 'Call the dentist'));
    await editRemote('Call dentist', { done: true });
    await engine.run();
    assert.match(read('Projects/Plan.md'), /- \[x\] Call the dentist #task/);
    const d = await byTitle('Call the dentist');
    assert.equal(d.model.done, true);
  });

  await t.test('a todo that names its note goes back to that note', async () => {
    const mk = async (uid, title, note) => client.put(calUrl + uid + '.ics',
      buildTodo({ uid, model: { title, done: false, due: null, priority: 0, recur: null }, description: `From note: ${note}` }), { create: true });
    await mk('from-1-' + Date.now(), 'Back to the plan', 'Projects/Plan.md');
    await mk('from-2-' + Date.now(), 'Note is gone', 'Old/Someday.md');
    await mk('from-3-' + Date.now(), 'Sneaky', '../../etc/passwd.md');
    await mk('from-4-' + Date.now(), 'Other case', 'projects/plan.md');
    const r = await engine.run();
    assert.equal(r.imported, 4);
    // Both land in Projects/Plan.md, in whatever order the server lists them.
    const open = read('Projects/Plan.md').split(/^## Complete$/m)[0];
    assert.match(open, /- \[ \] Back to the plan #task \^t\w+\n/, 'existing note, above its finished tasks');
    assert.match(open, /- \[ \] Other case #task \^t\w+\n/, 'a folder and note differing only in case are reused');
    assert.match(read('Projects/Plan.md'), /\n\n## Complete\n- \[x\] Call the dentist/);
    assert.equal(fs.existsSync(path.join(dir, 'vault', 'projects')), false);
    assert.equal(read('Old/Someday.md').replace(/\^t\w+/, '^id'), '# Someday\n\n- [ ] Note is gone #task ^id\n', 'new note, folder created');
    assert.match(read('Inbox.md'), /- \[ \] Sneaky #task/, 'paths outside the vault go to the inbox');
  });

  await t.test('a task with unchecked sub-items stays open when completed elsewhere', async () => {
    write('Projects/Trip.md', '- [ ] Pack #task\n  - [ ] Socks\n  - [x] Passport\n');
    await engine.run();
    await editRemote('Pack', { done: true });
    await engine.run();
    assert.match(read('Projects/Trip.md'), /^- \[ \] Pack #task \^t\w+\n/, 'still open in the note');
    assert.equal((await byTitle('Pack')).model.done, false, 'and reopened on the server');
    write('Projects/Trip.md', read('Projects/Trip.md').replace('- [ ] Socks', '- [x] Socks'));
    await engine.run();
    await editRemote('Pack', { done: true });
    await engine.run();
    assert.match(read('Projects/Trip.md'), /- \[x\] Pack #task/, 'completes once its sub-items are done');
  });

  await t.test('cancelling a task elsewhere cancels its unfinished sub-items', async () => {
    write('Projects/Party.md', '- [ ] Plan party #task\n  - [ ] Invites\n  - [/] Cake\n  - [x] Venue ✅ 2026-01-02\n');
    await engine.run();
    await editRemote('Plan party', { done: true, status: 'cancelled' });
    await engine.run();
    const note = read('Projects/Party.md');
    assert.match(note, /- \[-\] Plan party #task \^t\w+\n  - \[-\] Invites\n  - \[-\] Cake\n  - \[x\] Venue ✅ 2026-01-02/, note);
    assert.equal((await byTitle('Plan party')).model.status, 'cancelled', 'stays cancelled on the server');
  });

  await t.test('in progress and cancelled sync both ways', async () => {
    write('Projects/States.md', '- [/] Write report #task\n- [ ] Book venue #task\n');
    await engine.run();
    assert.match((await byTitle('Write report')).ics, /STATUS:IN-PROCESS/);
    await editRemote('Book venue', { status: 'in-progress' });
    await engine.run();
    assert.match(read('Projects/States.md'), /- \[\/\] Book venue #task/);
    write('Projects/States.md', read('Projects/States.md').replace('- [/] Write report', '- [-] Write report'));
    await engine.run();
    const r = await byTitle('Write report');
    assert.deepEqual([r.model.done, r.model.status], [true, 'cancelled']);
    assert.match(r.ics, /STATUS:CANCELLED/);
  });

  await t.test('renaming a note updates "From note:" on its todos', async () => {
    write('Projects/Old name.md', '- [ ] Follow up #task\n');
    await engine.run();
    assert.match((await byTitle('Follow up')).ics, /DESCRIPTION:From note: Projects\/Old name\.md/);
    vault.rename('Projects/Old name.md', 'Archive/New name.md');
    const r = await engine.run();
    assert.equal(r.created, 0);
    assert.match((await byTitle('Follow up')).ics, /DESCRIPTION:From note: Archive\/New name\.md/);
    assert.equal((await engine.run()).pushed, 0, 'only once');
  });

  await t.test('notes in the Templates folder never sync', async () => {
    write('Templates/Weekly.md', '# Week of {{date}}\n- [ ] Plan the week #task\n');
    await engine.run();
    assert.equal(await byTitle('Plan the week'), undefined);
    assert.equal(read('Templates/Weekly.md'), '# Week of {{date}}\n- [ ] Plan the week #task\n', 'no block id either');
  });

  await t.test('imports todos created on the server', async () => {
    const uid = 'remote-' + Date.now();
    await client.put(calUrl + uid + '.ics', buildTodo({ uid, model: { title: 'From phone', done: false, due: null, priority: 9 } }), { create: true });
    const r = await engine.run();
    assert.equal(r.imported, 1);
    assert.deepEqual(r.importedNotes, ['Inbox.md'], 'so the app can offer to open it');
    assert.match(read('Inbox.md'), /- \[ \] From phone #task 🔽 \^t[a-z0-9]{7}/);
    assert.ok((await byTitle('From phone')).tickmarkId);
  });

  await t.test('local line removal deletes the remote todo', async () => {
    write('Inbox.md', read('Inbox.md').replace(/^- \[ \] From phone.*$/m, ''));
    const r = await engine.run();
    assert.equal(r.deletedRemote, 1);
    assert.equal(await byTitle('From phone'), undefined);
  });

  await t.test('remote deletion removes the unchanged line', async () => {
    const d = await byTitle('Call the dentist');
    await client.delete(d.url, d.etag);
    const r = await engine.run();
    assert.equal(r.deletedLocal, 1);
    assert.doesNotMatch(read('Projects/Plan.md'), /Call the dentist/);
  });

  await t.test('editor save merges with a concurrent sync write', async () => {
    const base = read('Projects/Plan.md');
    await editRemote('Oat milk', { done: false });
    await engine.run();
    const res = vault.save('Projects/Plan.md', base + 'A new paragraph\n', { baseContent: base });
    assert.equal(res.merged, true);
    assert.equal(res.conflicts, 0);
    assert.match(res.content, /- \[ \] Oat milk/);
    assert.match(res.content, /A new paragraph/);
  });

  await t.test('refuses mass deletion without force', async () => {
    write('More.md', Array.from({ length: 6 }, (_, i) => `- [ ] bulk ${i} #task`).join('\n'));
    await engine.run();
    for (const r of await remote()) await client.delete(r.url, r.etag);
    await assert.rejects(engine.run(), /Refusing to sync/);
  });
});

test('multiple accounts route by tag', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-'));
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  const mk = async (name) => {
    const url = new URL(`/${USER}/tickmark-${name}-${Date.now()}/`, URL_).href;
    await client.request('MKCALENDAR', url, {
      body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
        '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
    });
    return url;
  };
  const home = await mk('home'), work = await mk('work');
  const acct = (id, calendarUrl, itemTags, sectionTags, inboxFile) => ({ id, name: id, url: URL_, username: USER, password: PASS, calendarUrl, itemTags, sectionTags, inboxFile });
  const cfg = { accounts: [acct('home', home, ['task'], ['sync'], 'Inbox.md'), acct('work', work, ['work'], ['job'], 'Work inbox.md')] };
  const index = new Index(path.join(dir, 'data', 'index.sqlite'));
  const vault = new Vault(path.join(dir, 'vault'), { onWrite: (rel, c) => rel && c != null && index.indexFile(rel, c) });
  const engine = new SyncEngine({ vault, index, getConfig: () => cfg, log: () => {} });
  const read = (p) => fs.readFileSync(path.join(dir, 'vault', p), 'utf8');
  const write = (p, s) => fs.writeFileSync(path.join(dir, 'vault', p), s);
  const titles = async (cal) => (await client.listTodos(cal)).map((r) => todoModel(findTodo(parseICS(r.ics))).model.title).sort();

  write('Mixed.md', `- [ ] Laundry #task
- [ ] Expense report #work
## Sprint #job
- [ ] Review PR
- [ ] Buy cake #task
`);

  await t.test('each item lands in its account (item tag beats section tag)', async () => {
    const r = await engine.run();
    assert.equal(r.created, 4);
    assert.deepEqual(r.accounts.map((a) => [a.id, a.created]), [['home', 2], ['work', 2]]);
    assert.deepEqual(await titles(home), ['Buy cake', 'Laundry']);
    assert.deepEqual(await titles(work), ['Expense report', 'Review PR']);
  });

  await t.test('retagging moves an item to the other account', async () => {
    write('Mixed.md', read('Mixed.md').replace('Laundry #task', 'Laundry #work'));
    const r = await engine.run();
    assert.equal(r.deletedRemote, 1);
    assert.equal(r.created, 1);
    assert.deepEqual(await titles(home), ['Buy cake']);
    assert.deepEqual(await titles(work), ['Expense report', 'Laundry', 'Review PR']);
    assert.equal((read('Mixed.md').match(/\^t/g) || []).length, 4);
  });

  await t.test('remote todos import into that account’s inbox with its tag', async () => {
    const uid = 'w-' + Date.now();
    await client.put(work + uid + '.ics', buildTodo({ uid, model: { title: 'Standup notes', done: false, due: null, priority: 0 } }), { create: true });
    const r = await engine.run();
    assert.equal(r.imported, 1);
    assert.match(read('Work inbox.md'), /- \[ \] Standup notes #work \^t/);
    assert.equal(fs.existsSync(path.join(dir, 'vault', 'Inbox.md')), false);
  });

  await t.test('one failing account does not block the other', async () => {
    cfg.accounts[0] = { ...cfg.accounts[0], calendarUrl: new URL('/nope/missing/', URL_).href };
    write('Mixed.md', read('Mixed.md') + '- [ ] Ship it #work\n');
    await assert.rejects(engine.run(), (e) => {
      assert.match(e.message, /^home: /);
      assert.equal(e.result.accounts.find((a) => a.id === 'work').created, 1);
      return true;
    });
    assert.ok((await titles(work)).includes('Ship it'));
  });
});

test('recurring tasks', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-'));
  const calUrl = new URL(`/${USER}/tickmark-recur-${Date.now()}/`, URL_).href;
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  await client.request('MKCALENDAR', calUrl, {
    body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
      '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
  });
  const cfg = { accounts: [{ id: 'a1', name: 'Test', url: URL_, username: USER, password: PASS, calendarUrl: calUrl, itemTags: ['task'], sectionTags: [], inboxFile: 'Inbox.md' }] };
  const index = new Index(path.join(dir, 'data', 'index.sqlite'));
  const vault = new Vault(path.join(dir, 'vault'), { onWrite: (rel, c) => rel && c != null && index.indexFile(rel, c) });
  const engine = new SyncEngine({ vault, index, getConfig: () => cfg, log: () => {} });
  const read = (p) => fs.readFileSync(path.join(dir, 'vault', p), 'utf8');
  const write = (p, s) => fs.writeFileSync(path.join(dir, 'vault', p), s);
  const remote = async () => (await client.listTodos(calUrl)).map((r) => ({ ...r, ...todoModel(findTodo(parseICS(r.ics))) }));
  const byTitle = async (title) => (await remote()).find((r) => r.model.title === title);
  write('Home.md', '- [ ] Water plants #task 🔁 every week 📅 2026-11-24\n- [ ] Pay rent #task 🔁 every month on the 1st 📅 2026-12-01\n');

  await t.test('the rule syncs as an RRULE anchored at the due date', async () => {
    assert.equal((await engine.run()).created, 2);
    const w = await byTitle('Water plants');
    assert.equal(w.model.recur, 'FREQ=WEEKLY');
    assert.match(w.ics, /RRULE:FREQ=WEEKLY\r\n/);
    assert.match(w.ics, /DTSTART;VALUE=DATE:20261124/);
    assert.equal((await byTitle('Pay rent')).model.recur, 'FREQ=MONTHLY;BYMONTHDAY=1');
  });

  await t.test('completing it in the note moves it on, here and on the server', async () => {
    write('Home.md', read('Home.md').replace('- [ ] Water plants', '- [x] Water plants'));
    await engine.run();
    const text = read('Home.md');
    assert.match(text, /^- \[ \] Water plants #task 🔁 every week 📅 2026-12-01 \^t\w+\n- \[x\] Water plants #task 📅 2026-11-24 ✅ \d{4}-\d\d-\d\d\n/);
    const w = await byTitle('Water plants');
    assert.deepEqual([w.model.done, w.model.due, w.model.recur], [false, '2026-12-01', 'FREQ=WEEKLY']);
    assert.match(w.ics, /DTSTART;VALUE=DATE:20261201/);
    assert.equal((await remote()).length, 2, 'the history line is not uploaded');
  });

  await t.test('completing it in another app moves it on and records history', async () => {
    const r = await byTitle('Pay rent');
    await client.put(r.url, buildTodo({ existing: r.ics, uid: r.uid, model: { ...r.model, done: true }, doneDate: '2026-12-02' }), { etag: r.etag });
    const res = await engine.run();
    assert.equal(res.pulled, 1);
    assert.match(read('Home.md'), /- \[ \] Pay rent #task 🔁 every month on the 1st 📅 2027-01-01 \^t\w+\n- \[x\] Pay rent #task 📅 2026-12-01 ✅ 2026-12-02/);
    const after = await byTitle('Pay rent');
    assert.deepEqual([after.model.done, after.model.due], [false, '2027-01-01']);
  });

  await t.test('an app that completes one occurrence as an exception is understood', async () => {
    const w = await byTitle('Water plants');
    const ics = w.ics.replace('END:VCALENDAR', `BEGIN:VTODO\r\nUID:${w.uid}\r\nRECURRENCE-ID;VALUE=DATE:20261201\r\nSUMMARY:Water plants\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261201T090000Z\r\nDTSTAMP:20261201T090000Z\r\nEND:VTODO\r\nEND:VCALENDAR`);
    await client.put(w.url, ics, { etag: w.etag });
    await engine.run();
    assert.match(read('Home.md'), /- \[ \] Water plants #task 🔁 every week 📅 2026-12-08/);
    const after = await byTitle('Water plants');
    assert.equal(after.model.due, '2026-12-08');
    assert.doesNotMatch(after.ics, /RECURRENCE-ID/, 'stale exception removed');
  });

  await t.test('recurring todos created elsewhere import with their rule', async () => {
    const uid = 'rr-' + Date.now();
    await client.put(calUrl + uid + '.ics', buildTodo({ uid, model: { title: 'Standup', done: false, due: '2026-11-23 09:30', priority: 0, recur: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' } }), { create: true });
    await engine.run();
    assert.match(read('Inbox.md'), /- \[ \] Standup #task 🔁 every weekday 📅 2026-11-23 09:30 \^t/);
  });

  await t.test('cancelling a recurring item in the note ends the series, once', async () => {
    write('Home.md', read('Home.md').replace('- [ ] Water plants #task 🔁 every week', '- [-] Water plants #task 🔁 every week'));
    await engine.run();
    await engine.run();
    const text = read('Home.md');
    assert.equal(text.match(/Water plants/g).length, 3, 'no new copies'); // the open item + 2 history lines
    assert.match(text, /^- \[-\] Water plants #task 📅 2026-12-08 \^t\w+$/m);
    const w = await byTitle('Water plants');
    assert.deepEqual([w.model.status, w.model.recur], ['cancelled', null]);
    assert.doesNotMatch(w.ics, /RRULE/);
  });

  await t.test('cancelling a recurring todo in another app ends the series in the note', async () => {
    const r = await byTitle('Pay rent');
    await client.put(r.url, buildTodo({ existing: r.ics, uid: r.uid, model: { ...r.model, done: true, status: 'cancelled' } }), { etag: r.etag });
    await engine.run();
    await engine.run();
    const text = read('Home.md');
    assert.equal(text.match(/Pay rent/g).length, 2, 'no new copies');
    assert.match(text, /^- \[-\] Pay rent #task 📅 2027-01-01 \^t\w+$/m);
    assert.doesNotMatch((await byTitle('Pay rent')).ics, /RRULE/);
  });

  await t.test('a finished series stays completed', async () => {
    write('Home.md', read('Home.md') + '- [ ] Course #task 🔁 every week until 2026-11-30 📅 2026-11-26\n');
    await engine.run();
    write('Home.md', read('Home.md').replace('- [ ] Course', '- [x] Course'));
    await engine.run();
    // The next date (Dec 3) is past the end date, so it just stays checked, rule and all.
    assert.match(read('Home.md'), /- \[x\] Course #task 🔁 every week until 2026-11-30 📅 2026-11-26 \^t\w+\n$/);
    assert.equal((await byTitle('Course')).model.done, true);
  });
});

test('recently deleted tasks can be restored', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-'));
  const calUrl = new URL(`/${USER}/tickmark-trash-${Date.now()}/`, URL_).href;
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  await client.request('MKCALENDAR', calUrl, {
    body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
      '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
  });
  const cfg = { accounts: [{ id: 'a1', name: 'Test', url: URL_, username: USER, password: PASS, calendarUrl: calUrl, itemTags: ['task'], sectionTags: ['sync'], inboxFile: 'Inbox.md' }] };
  const index = new Index(path.join(dir, 'data', 'index.sqlite'));
  const vault = new Vault(path.join(dir, 'vault'), { onWrite: (rel, c) => rel && c != null && index.indexFile(rel, c) });
  const engine = new SyncEngine({ vault, index, getConfig: () => cfg, log: () => {} });
  const read = (p) => fs.readFileSync(path.join(dir, 'vault', p), 'utf8');
  const write = (p, s) => fs.writeFileSync(path.join(dir, 'vault', p), s);
  const remote = async () => (await client.listTodos(calUrl)).map((r) => ({ ...r, ...todoModel(findTodo(parseICS(r.ics))) }));
  const byTitle = async (title) => (await remote()).find((r) => r.model.title === title);

  write('Work.md', '# Work\n- [ ] Send invoice #task 📅 2026-12-01\n- [ ] Book flights #task\n- [ ] Call Sam #task\n');
  await engine.run();

  await t.test('a line removed from the note is kept, with the server copy', async () => {
    const before = await byTitle('Send invoice');
    // Something another app added, to prove restoring brings back the exact todo.
    const eol = before.ics.includes('\r\n') ? '\r\n' : '\n';
    await client.put(before.url, before.ics.replace('END:VTODO', `LOCATION:Accounts office${eol}END:VTODO`), { etag: before.etag });
    await engine.run();
    write('Work.md', read('Work.md').replace(/^- \[ \] Send invoice.*\n/m, ''));
    const r = await engine.run();
    assert.equal(r.deletedRemote, 1);
    assert.equal(r.trashed, 1);
    const [d] = index.listDeleted();
    assert.deepEqual([d.title, d.source, d.hasCopy, d.path], ['Send invoice', 'notes', true, 'Work.md']);
  });

  await t.test('restoring puts back the line and the exact todo', async () => {
    const [d] = index.listDeleted();
    const res = await engine.restore(d.id);
    assert.deepEqual(res, { path: 'Work.md', section: 'Work', server: 'restored' });
    assert.match(read('Work.md'), /- \[ \] Send invoice #task 📅 2026-12-01 \^t\w+\n$/);
    assert.match((await byTitle('Send invoice')).ics, /LOCATION:Accounts office/);
    const r = await engine.run();
    assert.equal(r.created, 0, 'linked back up, not duplicated');
    assert.equal((await remote()).filter((x) => x.model.title === 'Send invoice').length, 1);
    assert.equal(index.listDeleted().length, 0);
  });

  await t.test('a todo deleted in the task app is kept with its original line', async () => {
    const b = await byTitle('Book flights');
    await client.delete(b.url, b.etag);
    assert.equal((await engine.run()).deletedLocal, 1);
    const [d] = index.listDeleted();
    assert.equal(d.source, 'remote');
    await engine.restore(d.id);
    assert.match(read('Work.md'), /- \[ \] Book flights #task \^t\w+/);
    assert.equal((await engine.run()).created, 1);
    assert.ok(await byTitle('Book flights'));
  });

  await t.test('removing the tag is not a deletion to recover', async () => {
    write('Work.md', read('Work.md').replace('Call Sam #task', 'Call Sam'));
    const r = await engine.run();
    assert.equal(r.deletedRemote, 1);
    assert.equal(r.trashed, 0, 'so no "tasks were deleted" notice');
    assert.equal(index.listDeleted().length, 0);
  });

  await t.test('the heading a task was under is kept, and restoring puts it back under it', async () => {
    write('Home.md', '# Home\n\n## Groceries #sync\n- [ ] Milk\n- [ ] Eggs\n\n## Chores\n- [ ] Vacuum #task\n');
    await engine.run();
    write('Home.md', read('Home.md').replace(/^- \[ \] Milk.*\n/m, ''));
    await engine.run();
    const v = await byTitle('Vacuum');
    await client.delete(v.url, v.etag);
    await engine.run();
    const byName = Object.fromEntries(index.listDeleted().map((d) => [d.title, d]));
    assert.equal(byName.Milk.section, 'Groceries', 'deleted in the notes: section from the last sync');
    assert.equal(byName.Vacuum.section, 'Chores', 'deleted in a task app: section from the line');
    const r = await engine.restore(byName.Milk.id);
    assert.equal(r.section, 'Groceries');
    // Back inside its #sync section (not at the end of the note, where it wouldn't sync).
    assert.match(read('Home.md'), /## Groceries #sync\n- \[ \] Eggs \^t\w+\n- \[ \] Milk \^t\w+\n\n## Chores/);
    assert.equal((await engine.run()).created, 0, 'still linked to its todo');
  });

  await t.test('if its heading is gone, it comes back under "Restored tasks"', async () => {
    write('Home.md', read('Home.md').replace('## Chores', '## Housework'));
    const d = index.listDeleted().find((x) => x.title === 'Vacuum');
    assert.equal((await engine.restore(d.id)).section, 'Restored tasks');
    assert.match(read('Home.md'), /## Housework\n\n## Restored tasks\n- \[ \] Vacuum #task \^t\w+\n$/);
  });

  await t.test('if the note is gone, the task comes back in the inbox', async () => {
    write('Errands.md', '- [ ] Pick up parcel #task\n');
    await engine.run();
    fs.unlinkSync(path.join(dir, 'vault', 'Errands.md'));
    await engine.run();
    const d = index.listDeleted().find((x) => x.title === 'Pick up parcel');
    assert.equal((await engine.restore(d.id)).path, 'Inbox.md');
    assert.match(read('Inbox.md'), /- \[ \] Pick up parcel #task \^t\w+/);
  });
});

test('notes changed outside Tickmark sync on their own', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async () => {
  const { Workspace } = await import('../server/workspace.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-'));
  const calUrl = new URL(`/${USER}/tickmark-watch-${Date.now()}/`, URL_).href;
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  await client.request('MKCALENDAR', calUrl, {
    body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
      '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
  });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'vault'));
  fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({ accounts: [
    { id: 'a1', name: 'Test', url: URL_, username: USER, password: PASS, calendarUrl: calUrl, itemTags: ['task'], sectionTags: ['sync'], inboxFile: 'Inbox.md' }] }));
  const ws = new Workspace({ dataDir: path.join(dir, 'data'), vaultDir: path.join(dir, 'vault') });
  try {
    // Another editor writes the note; nothing in Tickmark saves it.
    fs.writeFileSync(path.join(dir, 'vault', 'Outside.md'), '- [ ] Written elsewhere #task\n');
    let todos = [];
    for (let i = 0; i < 40 && !todos.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      todos = await client.listTodos(calUrl);
    }
    assert.equal(todos.length, 1, 'the new task reached the server');
    assert.match(todos[0].ics, /SUMMARY:Written elsewhere/);
    await ws.sync.running?.catch(() => {});
    assert.match(fs.readFileSync(path.join(dir, 'vault', 'Outside.md'), 'utf8'), /#task \^t\w+\n$/);
  } finally { ws.close(); }
});

test('a new task list can be created from Settings', { skip: !URL_ && 'set CALDAV_TEST_URL to run' }, async () => {
  const client = new CalDAV({ url: URL_, username: USER, password: PASS });
  const before = await client.discover();
  const c = await client.createCalendar('Errands & "Stuff"');
  assert.match(c.url, /\/errands-stuff-[0-9a-f]{8}\/$/);
  const after = await client.discover();
  assert.equal(after.length, before.length + 1);
  assert.equal(after.find((x) => x.url.replace(/\/$/, '') === c.url.replace(/\/$/, '') || x.url.endsWith(new URL(c.url).pathname))?.name, 'Errands & "Stuff"');
  // Pointing the account at a calendar directly: the new one goes next to it.
  const direct = new CalDAV({ url: c.url, username: USER, password: PASS });
  const d = await direct.createCalendar('Sibling');
  assert.equal(new URL('..', d.url).href, new URL('..', c.url).href);
});
