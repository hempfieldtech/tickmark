import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, buildTaskLine, taskModel, toggleLine, checkboxLines } from '../public/shared/tasks.js';
import { buildTodo, parseICS, findTodo, todoModel } from '../server/ical.js';
import { merge3 } from '../server/merge.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const opts = { itemTags: ['task'], sectionTags: ['sync'] };

test('per-item tag, metadata and block id', () => {
  const [t] = parseTasks('- [ ] Call #work dentist #task ⏫ 📅 2026-11-25 ^tabc123', opts);
  assert.equal(t.synced, true);
  assert.equal(t.title, 'Call #work dentist');
  assert.equal(t.due, '2026-11-25');
  assert.equal(t.priority, 1);
  assert.equal(t.blockId, 'tabc123');
  assert.equal(buildTaskLine(t, taskModel(t)), '- [ ] Call #work dentist #task ⏫ 📅 2026-11-25 ^tabc123');
});

test('section tags scope to the heading and its children', () => {
  const md = `# Home
- [ ] not synced
## Groceries #sync
- [ ] milk
### Dairy
- [x] cheese
## Other
- [ ] nope
\`\`\`
- [ ] in code #task
\`\`\``;
  const ts = parseTasks(md, opts);
  assert.deepEqual(ts.map((t) => [t.title, t.synced]), [['not synced', false], ['milk', true], ['cheese', true], ['nope', false]]);
});

test('frontmatter tag syncs the whole note', () => {
  const ts = parseTasks('---\ntags: [sync, x]\n---\n- [ ] a\n', opts);
  assert.equal(ts[0].synced, true);
});

test('due date with time; toggle stamps completion before block id', () => {
  const [t] = parseTasks('- [ ] meet due:2026-12-01 14:30 #task', opts);
  assert.equal(t.due, '2026-12-01 14:30');
  const toggled = toggleLine('- [ ] x #task ^tq', 0);
  assert.match(toggled, /^- \[x\] x #task ✅ \d{4}-\d\d-\d\d \^tq$/);
  assert.equal(toggleLine(toggled, 0), '- [ ] x #task ^tq');
});

test('checkbox lines include blockquotes and skip fences', () => {
  assert.deepEqual(checkboxLines('- [ ] a\n```\n- [ ] b\n```\n> - [x] c\n1. [ ] d'), [0, 4, 5]);
});

test('ical round trip preserves foreign properties', () => {
  const ics = buildTodo({ uid: 'u1', model: { title: 'A, b; c', done: false, due: '2026-11-25', priority: 5 }, tickmarkId: 't1' });
  const withAlarm = ics.replace('END:VTODO', 'X-FOO:bar\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VTODO');
  const next = buildTodo({ existing: withAlarm, uid: 'u1', model: { title: 'A, b; c', done: true, due: '2026-11-25 09:00', priority: 5 } });
  const info = todoModel(findTodo(parseICS(next)));
  assert.deepEqual(info.model, { title: 'A, b; c', done: true, due: '2026-11-25 09:00', priority: 5, recur: null });
  assert.equal(info.tickmarkId, 't1');
  assert.match(next, /X-FOO:bar/);
  assert.match(next, /BEGIN:VALARM/);
});

test('merge3 combines non-overlapping edits', () => {
  const base = 'a\nb\nc\nd';
  assert.equal(merge3(base, 'a\nB\nc\nd', 'a\nb\nc\nD').text, 'a\nB\nc\nD');
  assert.equal(merge3(base, 'x\na\nb\nc\nd', 'a\nb\nc\nd\ny').text, 'x\na\nb\nc\nd\ny');
  assert.equal(merge3(base, 'a\nX\nc\nd', 'a\nY\nc\nd').conflicts, 1);
});

test('items route to one account: item tag first, then innermost section, then frontmatter', async () => {
  const { accountFor } = await import('../server/sync.js');
  const A = { id: 'home', itemTags: ['task'], sectionTags: ['sync'] };
  const B = { id: 'work', itemTags: ['work'], sectionTags: ['job'] };
  const opts = { itemTags: ['task', 'work'], sectionTags: ['sync', 'job'] };
  const md = `---
tags: [sync]
---
- [ ] Note-wide
# Office #job
- [ ] Under job
- [ ] Personal errand #Task
## Nested #sync
- [ ] Inner heading wins
`;
  const route = Object.fromEntries(parseTasks(md, opts).map((t) => [t.title, accountFor(t, [A, B])?.id]));
  assert.deepEqual(route, { 'Note-wide': 'home', 'Under job': 'work', 'Personal errand': 'home', 'Inner heading wins': 'home' });
});

test('settings reject ambiguous accounts and migrate the old single-account format', async () => {
  const { Config } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ caldav: { url: 'https://d/', username: 'u', password: 'p', calendarUrl: 'https://d/c/', calendarName: 'Tasks' }, itemTags: ['todo'], sectionTags: ['sync'], inboxFile: 'In.md' }));
  const c = new Config(dir);
  assert.deepEqual(c.get().accounts.map((a) => [a.id, a.name, a.itemTags, a.inboxFile, a.password]), [['a1', 'Tasks', ['todo'], 'In.md', 'p']]);
  assert.equal(c.public().accounts[0].password, undefined);
  const keep = { id: 'a1', password: '' };
  assert.throws(() => c.update({ accounts: [keep, { name: 'W', itemTags: 'todo' }] }), /#todo is used by both/);
  assert.throws(() => c.update({ accounts: [keep, { name: 'W', itemTags: 'w', calendarUrl: 'https://d/c' }] }), /same task list/);
  assert.throws(() => c.update({ accounts: [keep, { name: 'W' }] }), /needs at least one tag/);
  c.update({ accounts: [keep, { name: 'Work', itemTags: '#Work, job' }] });
  assert.equal(c.get().accounts[0].password, 'p', 'blank password keeps the saved one');
  assert.deepEqual(c.get().accounts[1].itemTags, ['work', 'job']);
  assert.equal(c.get().accounts[1].inboxFile, 'Inbox (Work).md');
});

test('recurrence rules: text ⇄ RRULE', async () => {
  const { parseRecurrence: P, describeRecurrence: D } = await import('../public/shared/recur.js');
  const cases = {
    'every day': 'FREQ=DAILY', 'every 3 days': 'FREQ=DAILY;INTERVAL=3', 'every other week': 'FREQ=WEEKLY;INTERVAL=2',
    'every weekday': 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'every Friday and Monday': 'FREQ=WEEKLY;BYDAY=MO,FR',
    'every month on the 1st and 15th': 'FREQ=MONTHLY;BYMONTHDAY=1,15', 'every month on the last day': 'FREQ=MONTHLY;BYMONTHDAY=-1',
    'every month on the last Friday': 'FREQ=MONTHLY;BYDAY=-1FR', 'every year on March 3': 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3',
    'every week until 2027-06-01': 'FREQ=WEEKLY;UNTIL=20270601', 'every 2 days when done': 'FREQ=DAILY;INTERVAL=2;X-WHEN=DONE',
    'RRULE:FREQ=weekly;byday=FR,MO;interval=1': 'FREQ=WEEKLY;BYDAY=MO,FR',
  };
  for (const [text, rule] of Object.entries(cases)) assert.equal(P(text), rule, text);
  for (const bad of ['every fortnight', 'daily', 'every month on the 32nd', '']) assert.equal(P(bad), null, bad);
  // Every rule reads back as text that parses to the same rule.
  for (const rule of Object.values(cases)) assert.equal(P(D(rule)), rule, D(rule));
  assert.equal(D('FREQ=WEEKLY;COUNT=3'), 'FREQ=WEEKLY;COUNT=3', 'no phrase → raw rule');
});

test('recurrence: next occurrence', async () => {
  const { nextOccurrence } = await import('../public/shared/recur.js');
  const next = (rule, due, doneDate) => nextOccurrence(rule, { due, doneDate, today: '2026-11-21' })?.due ?? null;
  assert.equal(next('FREQ=DAILY;INTERVAL=3', '2026-11-21 10:30'), '2026-11-24 10:30');
  assert.equal(next('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-11-20'), '2026-11-23'); // Fri → Mon
  assert.equal(next('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR', '2026-11-27'), '2026-12-07');
  assert.equal(next('FREQ=MONTHLY', '2027-01-31'), '2027-02-28');
  assert.equal(next('FREQ=MONTHLY;BYDAY=-1FR', '2026-11-27'), '2026-12-25');
  assert.equal(next('FREQ=MONTHLY;BYDAY=2TU', '2026-11-10'), '2026-12-08');
  assert.equal(next('FREQ=YEARLY', '2028-02-29'), '2029-02-28');
  assert.equal(next('FREQ=DAILY;INTERVAL=2;X-WHEN=DONE', '2026-11-10', '2026-11-21'), '2026-11-23');
  assert.equal(next('FREQ=WEEKLY', null, '2026-11-21'), '2026-11-28');
  assert.equal(next('FREQ=WEEKLY;UNTIL=20261125', '2026-11-21'), null);
  assert.deepEqual(nextOccurrence('FREQ=WEEKLY;COUNT=2', { due: '2026-11-21', today: '2026-11-21' }), { due: '2026-11-28', rule: 'FREQ=WEEKLY;COUNT=1' });
  assert.equal(next('FREQ=WEEKLY;COUNT=1', '2026-11-21'), null);
  assert.equal(next('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', '2026-11-02'), null, "can't compute → stop, never guess");
});

test('checking a recurring item moves it on and keeps a completed copy', () => {
  const text = '- [ ] Water plants #task 🔁 every week 📅 2026-11-24 ^tabc1234\n  - [ ] sub';
  const out = toggleLine(text, 0).split('\n');
  assert.equal(out[0], '- [ ] Water plants #task 🔁 every week 📅 2026-12-01 ^tabc1234');
  assert.match(out[1], /^- \[x\] Water plants #task 📅 2026-11-24 ✅ \d{4}-\d\d-\d\d$/);
  assert.equal(out[2], '  - [ ] sub');
  const [t] = parseTasks('- [ ] Odd 🔁 every fortnight #task', opts);
  assert.equal(t.title, 'Odd 🔁 every fortnight', 'unknown rules stay in the text');
  assert.equal(t.recur, null);
});

test('settings encryption: round trip, wrong secret, rotation, binding to the user', async () => {
  const { SettingsCipher } = await import('../server/secrets.js');
  const a = new SettingsCipher({ current: 'secret-one' });
  const blob = a.seal([{ url: 'https://dav.example/', password: 'p' }], 'tickmark:accounts:alex');
  assert.doesNotMatch(JSON.stringify(blob), /dav\.example|password/);
  assert.deepEqual(a.open(blob, 'tickmark:accounts:alex'), { value: [{ url: 'https://dav.example/', password: 'p' }], stale: false });
  assert.throws(() => a.open(blob, 'tickmark:accounts:bob'), /different OIDC client secret/, "can't be moved to another user");
  assert.throws(() => new SettingsCipher({ current: 'secret-two' }).open(blob, 'tickmark:accounts:alex'), /TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET/);
  assert.throws(() => new SettingsCipher().open(blob, 'tickmark:accounts:alex'), /TICKMARK_OIDC_CLIENT_SECRET is not set/);
  const rotated = new SettingsCipher({ current: 'secret-two', readable: ['secret-one'] }).open(blob, 'tickmark:accounts:alex');
  assert.equal(rotated.stale, true);
});

test('config.json keeps CalDAV accounts encrypted when a cipher is on', async () => {
  const { Config } = await import('../server/config.js');
  const { SettingsCipher } = await import('../server/secrets.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-enc-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ accounts: [{ id: 'a1', name: 'Home', url: 'https://dav.example/', username: 'alex', password: 'pw', calendarUrl: 'https://dav.example/alex/tasks/', itemTags: ['task'] }], clientSyncMinutes: 7 }));
  const on = new SettingsCipher({ current: 's3cret' });
  const c = new Config(dir, { cipher: on, owner: 'alex' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /dav\.example|alex|"pw"|Home/, 'existing plain settings are encrypted on load');
  assert.equal(JSON.parse(raw).clientSyncMinutes, 7, 'non-sensitive settings stay readable');
  assert.equal(c.get().accounts[0].password, 'pw');
  assert.equal(c.public().encrypted, true);
  c.update({ accounts: [{ id: 'a1', password: '' }, { name: 'Work', url: 'https://work.example/', itemTags: 'work', calendarUrl: 'https://work.example/c/' }] });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /work\.example/);
  assert.equal(new Config(dir, { cipher: on, owner: 'alex' }).get().accounts[1].name, 'Work');
  // SSO turned off, secret still known: settings are decrypted back to plain JSON.
  new Config(dir, { cipher: new SettingsCipher({ readable: ['s3cret'] }), owner: 'alex' });
  assert.match(fs.readFileSync(file, 'utf8'), /work\.example/);
});

test('a restored line goes at the end of its section', async () => {
  const { insertInSection } = await import('../public/shared/tasks.js');
  const lines = ['# Home', '', '## Groceries #sync', '- [ ] Eggs', '', '### Dairy', '- [ ] Butter', '', '## Chores', '- [ ] Vacuum', ''];
  assert.deepEqual(insertInSection(lines, 'Groceries', '- [ ] Milk').slice(2, 9),
    ['## Groceries #sync', '- [ ] Eggs', '', '### Dairy', '- [ ] Butter', '- [ ] Milk', ''], 'after subsections, before the next same-level heading');
  assert.deepEqual(insertInSection(lines, 'Chores', '- [ ] Dust').slice(-3), ['- [ ] Vacuum', '- [ ] Dust', '']);
  assert.equal(insertInSection(lines, 'Garden', '- [ ] Mow'), null);
  assert.equal(insertInSection(['```', '## Groceries', '```'], 'Groceries', 'x'), null, 'headings in code blocks don’t count');
});

test('older index databases gain the section columns', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Index } = await import('../server/db.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-db-')), 'index.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sync_states (account TEXT, block_id TEXT, uid TEXT, href TEXT, etag TEXT, base TEXT, path TEXT, PRIMARY KEY (account, block_id));
    CREATE TABLE deleted_tasks (id INTEGER PRIMARY KEY, account TEXT, block_id TEXT, title TEXT, model TEXT, line TEXT, path TEXT, ics TEXT, href TEXT, source TEXT, deleted_at TEXT);
    INSERT INTO sync_states VALUES ('a1', 't1', 'u1', 'x.ics', null, '{}', 'A.md');`);
  old.close();
  const ix = new Index(file);
  assert.equal(ix.getStates('a1')[0].section, null);
  ix.putState('a1', { block_id: 't2', uid: 'u2', href: 'y.ics', base: {}, path: 'A.md', section: 'Groceries' });
  assert.equal(ix.getStates('a1').find((x) => x.block_id === 't2').section, 'Groceries');
});
