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
  assert.deepEqual(info.model, { title: 'A, b; c', done: true, status: null, due: '2026-11-25 09:00', priority: 5, recur: null });
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

test('a restored line goes at the end of its heading\'s own content', async () => {
  const { insertInSection } = await import('../public/shared/tasks.js');
  const lines = ['# Home', '', '## Groceries #sync', '- [ ] Eggs', '', '### Dairy', '- [ ] Butter', '', '## Chores', '- [ ] Vacuum', ''];
  assert.deepEqual(insertInSection(lines, 'Groceries', '- [ ] Milk').slice(2, 8),
    ['## Groceries #sync', '- [ ] Eggs', '- [ ] Milk', '', '### Dairy', '- [ ] Butter'], 'before its subsections');
  assert.deepEqual(insertInSection(['# Page', '- [ ] a', '', '## New', '- [ ] b'], 'Page', '- [ ] c'),
    ['# Page', '- [ ] a', '- [ ] c', '', '## New', '- [ ] b'], 'under the title, not the last ## of the note');
  assert.deepEqual(insertInSection(['## A', '---', '- [ ] a', '', '---', '', '## B'], 'A', '- [ ] c'),
    ['## A', '---', '- [ ] a', '- [ ] c', '', '---', '', '## B'], 'above a closing divider, below one under the heading');
  assert.deepEqual(insertInSection(['## A', '---', '', '## B'], 'A', '- [ ] c'), ['## A', '---', '- [ ] c', '', '## B']);
  assert.deepEqual(insertInSection(lines, 'Chores', '- [ ] Dust').slice(-3), ['- [ ] Vacuum', '- [ ] Dust', '']);
  assert.equal(insertInSection(lines, 'Garden', '- [ ] Mow'), null);
  assert.ok(insertInSection(['# Home', '### groceries', '- [ ] Eggs'], 'Groceries', 'x'), 'level and case don\'t matter');
  assert.ok(insertInSection(['## **Groceries** #sync', '- [ ] Eggs'], 'Groceries', 'x'), 'nor formatting');
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

test('word count ignores markdown syntax and task metadata', async () => {
  const { countWords } = await import('../public/shared/words.js');
  const c = (s) => countWords(s);
  assert.equal(c(''), 0);
  assert.equal(c('# Heading here'), 2);
  assert.equal(c('**bold** and _italic_ and ~~gone~~ and ==hi== and `code`'), 9);
  assert.equal(c('1. first\n2) second\n- third\n* [ ] fourth\n- [x] fifth'), 5);
  assert.equal(c('> quoted text\n> > nested'), 3);
  assert.equal(c('[link text](https://example.com/a/b) ![alt words](img/pic.png)'), 4);
  assert.equal(c('See [[Some Note]] and [[Other#Heading|alias]]'), 5);
  assert.equal(c('---\ntitle: Hello world\ntags: [a, b]\n---\nBody only'), 2);
  assert.equal(c('```js\nconst x = 1;\n```\nafter'), 4);
  assert.equal(c('| a | b |\n|---|:---:|\n| c | d |'), 4);
  assert.equal(c('***\n---\n\nText\n===='), 1);
  assert.equal(c('- [ ] Call dentist #task ⏫ 📅 2026-11-25 14:30 🔁 every week ✅ 2026-11-20 ^tabc123'), 3);
  assert.equal(c('snake_case word and a - dash'), 5);
  assert.equal(c('<span class="x">inside</span> <!-- hidden note -->'), 1);
  assert.equal(c('[ref]: https://example.com\nUse [it][ref]'), 2);
});

test('character count uses the same syntax stripping', async () => {
  const { textStats } = await import('../public/shared/words.js');
  assert.deepEqual(textStats(''), { words: 0, chars: 0 });
  assert.deepEqual(textStats('# Hi there'), { words: 2, chars: 8 });
  assert.deepEqual(textStats('**bold** [link](https://example.com)'), { words: 2, chars: 9 });
  assert.deepEqual(textStats('- [ ] Buy milk #task 📅 2026-11-25\n- [x] Café'), { words: 4, chars: 17 });
  assert.deepEqual(textStats('one - two'), { words: 2, chars: 7 });
});

test('renaming a note rewrites [[links]] to it', async () => {
  const { rewriteLinks, movedNotes } = await import('../server/links.js');
  const before = ['Ideas.md', 'Work/Plan.md', 'Home/Plan.md', 'Index.md'];
  const move = (from, to) => {
    const moved = movedNotes(from, to, before);
    return (text) => rewriteLinks(text, moved, before, before.map((p) => moved.get(p) || p));
  };
  const r = move('Ideas.md', 'Projects/Someday.md');
  assert.equal(r('See [[Ideas]], [[ideas#Later|my list]] and ![[Ideas.md]].'),
    'See [[Someday]], [[Someday#Later|my list]] and ![[Someday.md]].', 'by name stays by name; fragment, alias, .md kept');
  assert.equal(r('`[[Ideas]]` and\n```\n[[Ideas]]\n```\n'), null, 'code is left alone');
  assert.equal(r('[[Plan]] [[Other]]'), null, 'unrelated links untouched');
  assert.equal(move('Work/Plan.md', 'Work/Roadmap.md')('[[Work/Plan]] and [[Plan]]'), '[[Work/Roadmap]] and [[Roadmap]]');
  assert.equal(move('Home/Plan.md', 'Home/Ideas.md')('[[Home/Plan|home]]'), '[[Home/Ideas|home]]');
  const dupe = (() => { const b = ['Ideas.md', 'Work/Plan.md']; const m = movedNotes('Ideas.md', 'Archive/Plan.md', b);
    return rewriteLinks('[[Ideas]]', m, b, ['Archive/Plan.md', 'Work/Plan.md']); })();
  assert.equal(dupe, '[[Archive/Plan]]', 'a name that is now ambiguous becomes a path');
  assert.equal(move('Work', 'Office')('[[Work/Plan#Q1]] [[Plan]]'), '[[Office/Plan#Q1]] [[Plan]]', 'folder moves update paths');
});

test('checked items move under a "Complete" heading, and back when unchecked', async () => {
  const { fileCompleted, toggleLine } = await import('../public/shared/tasks.js');
  const check = (text, n) => fileCompleted(toggleLine(text, n, { stampDone: false }), n);
  let t = '# Work\n- [ ] A\n- [ ] B\n';
  t = check(t, 1);
  assert.equal(t, '# Work\n- [ ] B\n\n## Complete\n- [x] A\n');
  t = check(t, 1);
  assert.equal(t, '# Work\n\n## Complete\n- [x] A\n- [x] B\n', 'appends to the existing heading');
  t = check(t, 3);
  assert.equal(t, '# Work\n- [ ] A\n\n## Complete\n- [x] B\n', 'unchecked: back above the heading');
  t = check(t, 4);
  assert.equal(t, '# Work\n- [ ] A\n- [ ] B\n', 'empty heading removed');

  const home = '# Home\n\n## Groceries #sync\n- [ ] Milk\n  - [ ] 2%\n- [ ] Eggs\n\n### Dairy\n- [ ] Butter\n\n## Chores\n- [ ] Vacuum\n';
  assert.equal(check(home, 3), '# Home\n\n## Groceries #sync\n- [ ] Eggs\n\n### Dairy\n- [ ] Butter\n\n### Complete\n- [x] Milk\n  - [ ] 2%\n\n## Chores\n- [ ] Vacuum\n',
    'end of its section, after subsections, with its sub-items');
  assert.equal(check(home, 4), null, 'sub-items stay with their parent');
  assert.equal(check('- [ ] Loose\n- [ ] Other', 0), '- [ ] Other\n\n## Complete\n- [x] Loose', 'no heading at all');
  assert.equal(fileCompleted('# X\n\n## Complete\n- [x] Done\n', 3), null, 'already there');
  assert.equal(check('```\n- [ ] code\n```\n', 1), null, 'never inside code blocks');
});

test('cancelled items go under "Cancelled", after "Complete", and move across', async () => {
  const { fileCompleted, setTaskState, sameSection } = await import('../public/shared/tasks.js');
  const set = (text, n, ch) => fileCompleted(setTaskState(text, n, ch), n);
  let t = '# Work\n- [ ] A\n- [ ] B\n- [ ] C\n';
  t = set(t, 1, '-');
  assert.equal(t, '# Work\n- [ ] B\n- [ ] C\n\n## Cancelled\n- [-] A\n');
  t = fileCompleted(t.replace('- [ ] B', '- [x] B'), 1);
  assert.equal(t, '# Work\n- [ ] C\n\n## Complete\n- [x] B\n\n## Cancelled\n- [-] A\n', 'a new "Complete" goes before "Cancelled"');
  t = fileCompleted(t.replace('- [x] B', '- [-] B'), 4);
  assert.equal(t, '# Work\n- [ ] C\n\n## Cancelled\n- [-] A\n- [-] B\n', 'done → cancelled moves across; the empty "Complete" goes');
  t = fileCompleted(t.replace('- [-] A', '- [ ] A'), 4);
  assert.equal(t, '# Work\n- [ ] C\n- [ ] A\n\n## Cancelled\n- [-] B\n', 'reopened: back above the finished headings');
  t = fileCompleted('# W\n- [ ] C\n\n## Complete\n- [x] D\n\n## Cancelled\n- [ ] E\n- [-] F\n', 7);
  assert.equal(t, '# W\n- [ ] C\n- [ ] E\n\n## Complete\n- [x] D\n\n## Cancelled\n- [-] F\n', 'reopened under "Cancelled": above "Complete" too');
  assert.equal(fileCompleted('# W\n\n## Cancelled\n- [-] X\n', 3), null, 'already there');
  assert.ok(sameSection('🛒 Groceries:', 'groceries'), 'emoji and a colon don\'t matter');
  assert.ok(sameSection('[Trip](http://x) plans', 'trip plans'), 'link text counts, not the URL');
  assert.ok(!sameSection('Groceries', 'Chores'));
});

test('settings keep custom CSS and the move-completed switch', async () => {
  const { Config } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-cfg-'));
  const c = new Config(dir);
  assert.equal(c.get().moveCompleted, true, 'on by default');
  assert.equal(c.get().customCss, '');
  c.update({ customCss: ':root { --accent: hotpink; }', moveCompleted: false });
  const again = new Config(dir).public();
  assert.equal(again.customCss, ':root { --accent: hotpink; }');
  assert.equal(again.moveCompleted, false);
  assert.throws(() => c.update({ customCss: 'x'.repeat(100_001) }), /100 KB/);
});

test('sync intervals are off or at least a minute', async () => {
  const { Config, syncMinutes } = await import('../server/config.js');
  assert.deepEqual([0, -3, '', 'x', 0.0005, 0.5, 1, 5, '10', 1e9].map(syncMinutes), [0, 0, 0, 0, 1, 1, 1, 5, 10, 10080]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ serverSyncMinutes: 0.0005, clientSyncMinutes: 0.01 }));
  const c = new Config(dir);
  assert.equal(c.get().serverSyncMinutes, 1, 'an old tiny value is raised on load');
  assert.equal(c.update({ serverSyncMinutes: 0.0005 }).serverSyncMinutes, 1);
  assert.equal(c.update({ serverSyncMinutes: 0 }).serverSyncMinutes, 0);
});

test('custom themes are checked before they are saved', async () => {
  const { Config } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-cfg-'));
  const c = new Config(dir);
  assert.deepEqual(c.get().customThemes, []);
  const colors = Object.fromEntries(['bg', 'panel', 'surface', 'line', 'text', 'muted', 'accent', 'accentSoft', 'danger', 'warn', 'mark', 'codeBg'].map((k) => [k, '#AABBCC']));
  c.update({ customThemes: [{ id: 'my-abc123', name: '  Ocean  ', dark: true, colors, extra: 'x' }] });
  assert.deepEqual(new Config(dir).get().customThemes, [{ id: 'my-abc123', name: 'Ocean', dark: true, colors: Object.fromEntries(Object.keys(colors).map((k) => [k, '#aabbcc'])) }]);
  assert.throws(() => c.update({ customThemes: [{ id: 'my-abc123', name: 'x', colors: { ...colors, bg: 'red; } body { display:none' } }] }), /bad colour/);
  assert.throws(() => c.update({ customThemes: [{ id: '"] { x', name: 'x', colors }] }), /bad id/);
  assert.throws(() => c.update({ customThemes: [{ id: 'my-abcd', colors }, { id: 'my-abcd', colors }] }), /bad id/);
  assert.throws(() => c.update({ customThemes: Array.from({ length: 31 }, (_, i) => ({ id: 'my-t' + String(i).padStart(3, '0'), colors })) }), /30 themes/);
  assert.equal(new Config(dir).get().customThemes[0].name, 'Ocean', 'a refused update changes nothing');
});

test('an empty checkbox is not synced (and gets no block id) until it has text', () => {
  const text = '## Groceries #sync\n- [ ] \n- [ ]\n- [ ] #task\n- [ ] Milk\n';
  assert.deepEqual(parseTasks(text, opts).map((t) => [t.title, t.synced]), [['', false], ['', false], ['', false], ['Milk', true]]);
});

test('new lines go above a "Complete" section at the end of a note', async () => {
  const { appendLines } = await import('../public/shared/tasks.js');
  assert.deepEqual(appendLines(['# Inbox', '- [ ] A', '', '## Complete', '- [x] B', ''], ['- [ ] C']),
    ['# Inbox', '- [ ] A', '- [ ] C', '', '## Complete', '- [x] B', '']);
  assert.deepEqual(appendLines(['# Inbox', '- [ ] A', '', ''], ['- [ ] C']), ['# Inbox', '- [ ] A', '- [ ] C']);
  assert.deepEqual(appendLines(['## Complete', '- [x] B', '## Later', '- [ ] D'], ['- [ ] C']),
    ['## Complete', '- [x] B', '## Later', '- [ ] D', '- [ ] C'], 'a Complete section that isn\'t last doesn\'t count');
  assert.deepEqual(appendLines(['# I', '- [ ] A', '', '## Complete', '- [x] B', '', '## Cancelled', '- [-] X'], ['- [ ] C']),
    ['# I', '- [ ] A', '- [ ] C', '', '## Complete', '- [x] B', '', '## Cancelled', '- [-] X'], 'above "Complete" and "Cancelled"');
});

test('open sub-items under an item', async () => {
  const { openSubtasks } = await import('../public/shared/tasks.js');
  const t = '- [ ] Pack\n  - [ ] Socks\n  - [x] Passport\n    - [ ] deep\n  notes\n- [ ] Next\n  - [ ] child';
  assert.equal(openSubtasks(t, 0), 2);
  assert.equal(openSubtasks(t, 2), 1);
  assert.equal(openSubtasks(t, 5), 1);
  assert.equal(openSubtasks('- [ ] Alone\n- [ ] Sibling', 0), 0);
});

test('checkbox states: in progress and cancelled', async () => {
  const { setTaskState, fileCompleted } = await import('../public/shared/tasks.js');
  const text = '- [/] Draft #task\n- [-] Old idea #task\n- [x] Done #task\n- [ ] Todo #task';
  assert.deepEqual(parseTasks(text, opts).map((t) => [t.done, t.status]), [[false, 'in-progress'], [true, 'cancelled'], [true, null], [false, null]]);
  const [prog, canc] = parseTasks(text, opts);
  assert.equal(buildTaskLine(prog, taskModel(prog)), '- [/] Draft #task');
  assert.equal(buildTaskLine(canc, { ...taskModel(canc) }, { doneDate: '2026-01-01' }), '- [-] Old idea #task', 'no ✅ date on cancelled');
  assert.match(toggleLine(text, 0).split('\n')[0], /^- \[x\] Draft #task ✅ \d{4}/, 'in progress → done');
  assert.equal(toggleLine(text, 1).split('\n')[1], '- [ ] Old idea #task', 'cancelled → to do');
  assert.equal(setTaskState(text, 3, '/').split('\n')[3], '- [/] Todo #task');
  assert.equal(setTaskState('- [x] Done ✅ 2026-01-01', 0, '-'), '- [-] Done');
  assert.match(setTaskState('- [-] X', 0, 'x'), /^- \[x\] X ✅ /);
  assert.deepEqual(checkboxLines(text), [0, 1, 2, 3]);
  assert.equal(fileCompleted('# A\n- [-] Gone\n- [ ] Stay', 1), '# A\n- [ ] Stay\n\n## Cancelled\n- [-] Gone', 'cancelled goes under its own heading');
  // CalDAV
  const ics = buildTodo({ uid: 'u', model: { title: 'Draft', done: false, status: 'in-progress', due: null, priority: 0, recur: null } });
  assert.match(ics, /STATUS:IN-PROCESS/);
  assert.equal(todoModel(findTodo(parseICS(ics))).model.status, 'in-progress');
  const c = buildTodo({ existing: ics, uid: 'u', model: { title: 'Draft', done: true, status: 'cancelled', due: null, priority: 0, recur: null } });
  assert.match(c, /STATUS:CANCELLED/);
  assert.doesNotMatch(c, /COMPLETED:/);
  assert.deepEqual([todoModel(findTodo(parseICS(c))).model.done, todoModel(findTodo(parseICS(c))).model.status], [true, 'cancelled']);
});

test('merge3: edits to neighbouring lines from both sides merge without a conflict', () => {
  const base = '# Collab\nline one\nline two\n';
  assert.deepEqual(merge3(base, '# Collab\nline ONE\nline two\n', '# Collab\nline one\nline TWO\n'), { text: '# Collab\nline ONE\nline TWO\n', conflicts: 0 });
  assert.equal(merge3(base, '# Collab\nA\nline two\n', '# Collab\nB\nline two\n').conflicts, 1, 'the same line changed two ways still conflicts');
});

test('frontmatter: properties out and back without losing what it does not understand', async () => {
  const { parseFrontmatter, writeFrontmatter } = await import('../public/shared/frontmatter.js');
  const text = '---\ntitle: Trip plans\ntags: [travel, "a, b"]\naliases:\n  - Trip\n  - Holiday\n# a comment\nmeta:\n  nested: 1\n  other: two\n---\n# Body\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.body, '# Body\n');
  assert.deepEqual(fm.entries.map((e) => [e.key, e.kind]), [['title', 'text'], ['tags', 'inline'], ['aliases', 'list'], [null, 'other'], ['meta', 'raw']]);
  assert.deepEqual(fm.entries[1].value, ['travel', 'a, b'], 'commas in quotes stay');
  assert.equal(writeFrontmatter(fm.body, fm.entries), text, 'unchanged properties write back the same');
  const changed = fm.entries.filter((e) => e.key !== 'meta').map((e) => (e.key === 'aliases' ? { ...e, value: ['Trip', 'Getaway'] } : e));
  assert.equal(writeFrontmatter(fm.body, changed), '---\ntitle: Trip plans\ntags: [travel, "a, b"]\naliases:\n  - Trip\n  - Getaway\n# a comment\n---\n# Body\n');
  assert.equal(writeFrontmatter('# Body\n', []), '# Body\n', 'no properties: no frontmatter');
  assert.equal(writeFrontmatter('x', [{ key: 'due', kind: 'text', value: '2026-12-01' }]), '---\ndue: 2026-12-01\n---\nx');
  assert.equal(parseFrontmatter('no frontmatter').has, false);
});

test('cancelling a recurring item drops its rule', async () => {
  const { setTaskState } = await import('../public/shared/tasks.js');
  assert.equal(setTaskState('- [ ] Bins #task 🔁 every week 📅 2026-12-01 ^tabc1234', 0, '-'), '- [-] Bins #task 📅 2026-12-01 ^tabc1234');
  assert.equal(setTaskState('- [x] Bins 🔁 every day ✅ 2026-12-01', 0, '-'), '- [-] Bins');
  assert.equal(setTaskState('- [ ] Bins 🔁 whenever', 0, '-'), '- [-] Bins 🔁 whenever', 'an unknown rule is just text');
});

test('links in notes: only schemes that cannot run code', async () => {
  const { safeUrl } = await import('../public/shared/url.js');
  for (const ok of ['https://example.com', 'http://x', 'mailto:a@b.c', 'Notes/Plan.md', '#heading', '/s/abc', '?q=1', '']) assert.ok(safeUrl(ok), ok);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:x', 'java\tscript:x', 'java\nscript:x', '\x01javascript:x',
    'vbscript:x', 'data:text/html,<script>', 'jav\rascript:x', 'file:///etc/passwd']) assert.ok(!safeUrl(bad), JSON.stringify(bad));
});

test('CalDAV XML: hostile replies parse in linear time, and normal ones as before', async () => {
  const { parseXML } = await import('../server/caldav.js');
  const t = Date.now();
  for (const s of ['<a'.repeat(100000), '<!--'.repeat(100000), '<![CDATA['.repeat(50000), '<a b="'.repeat(50000), '<?'.repeat(100000)]) parseXML(s);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  const r = parseXML('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><!-- c --><d:response><d:href>/a/</d:href>' +
    '<d:propstat><d:prop><d:displayname>Tasks &amp; more</d:displayname><x:empty a=\'1\'/><d:raw><![CDATA[<b>]]></d:raw></d:prop></d:propstat></d:response></d:multistatus>');
  const prop = r.children[0].children[0].children[1].children[0];
  assert.deepEqual(prop.children.map((c) => c.name), ['displayname', 'empty', 'raw']);
  assert.equal(prop.children[0].text, 'Tasks & more');
  assert.equal(prop.children[1].attrs.a, '1');
  assert.equal(prop.children[2].text, '<b>');
});

test('private addresses, for who may point CalDAV inside the network', async () => {
  const { isPrivateAddress } = await import('../server/caldav.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1'])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) assert.ok(!isPrivateAddress(ip), ip);
});

test('"From note:" in a task description is read quickly whatever it holds', () => {
  const ics = (desc) => `BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:T\r\nDESCRIPTION:${desc}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
  assert.equal(todoModel(findTodo(parseICS(ics('From note: Work/Plan.md')))).fromNote, 'Work/Plan.md');
  const t = Date.now();
  todoModel(findTodo(parseICS(ics('From note:' + ' '.repeat(300000) + 'x'))));
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});

test('a sync asked for while one runs gets a follow-up run that sees the newer notes', async () => {
  const { SyncEngine } = await import('../server/sync.js');
  const e = new SyncEngine({ vault: null, index: null, getConfig: () => ({}), log: () => {} });
  let version = 1, runs = [];
  e._run = async (opts) => {
    const saw = version;
    await new Promise((r) => setTimeout(r, 30));
    runs.push({ saw, force: !!opts.force });
    return { accounts: [], saw };
  };
  const first = e.run();
  await new Promise((r) => setTimeout(r, 5));
  version = 2; // a note is saved mid-sync (Vim :w), then sync is asked for
  const second = e.run(), third = e.run({ force: true });
  assert.equal(second, third, 'calls during one sync share one follow-up');
  assert.equal((await first).saw, 1);
  assert.equal((await second).saw, 2, 'the follow-up read the newer notes');
  assert.deepEqual(runs, [{ saw: 1, force: false }, { saw: 2, force: true }]);
  assert.equal(e.running, null);
});
