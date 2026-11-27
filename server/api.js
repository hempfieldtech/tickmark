// The REST API for scripts: /api/v1/… (README → REST API; Settings → API lists and tries it).
// Signed in with a personal token (`Authorization: Bearer tm_…`), or with the app's own session.
// Every endpoint takes and returns JSON; notes are named by their vault path in `?path=`.

import { changeItem, insertInSection, localDate, TASK_LINE } from '../public/shared/tasks.js';

export const API_VERSION = 1;
const STATES = { todo: ' ', doing: '/', done: 'x', cancelled: '-' };
const STATE_NAME = { ' ': 'todo', '/': 'doing', x: 'done', X: 'done', '-': 'cancelled' };
const PRIORITIES = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
const DATE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const needPath = (q) => {
  const p = String(q.get('path') || '').trim().replace(/^\/+/, '');
  if (!p) throw bad('Give the note as ?path=Folder/Note.md');
  return /\.md$/i.test(p) ? p : p + '.md';
};

/** Every checklist item in a note's text, as the API shows them. */
function itemsOf(path, text) {
  const out = [];
  const lines = text.split('\n');
  let heading = null, fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) { heading = h[1].replace(/\s+#[\p{L}\p{N}_/-]+/gu, '').trim(); continue; }
    const m = lines[i].match(TASK_LINE);
    if (!m) continue;
    const body = m[4] || '';
    out.push({
      path, line: i, indent: m[1].replace(/>\s*/g, '').length, state: STATE_NAME[m[3]], text: body.replace(/\s*\^[A-Za-z0-9-]+\s*$/, ''),
      heading, blockId: body.match(/\^([A-Za-z0-9-]+)\s*$/)?.[1] || null,
      due: body.match(/(?:📅|due:)\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)/u)?.[1] || null,
      priority: Object.entries(PRIORITIES).find(([, e]) => body.includes(e))?.[0] || null,
    });
  }
  return out;
}

/** The line of the item `body` names: by blockId, or by line (checked against `text` when given). */
function findItem(text, body) {
  const items = itemsOf('', text);
  let it = null;
  if (body.blockId) it = items.find((x) => x.blockId === String(body.blockId).replace(/^\^/, ''));
  else if (Number.isInteger(body.line)) {
    it = items.find((x) => x.line === body.line);
    if (it && body.expect != null && !it.text.includes(String(body.expect))) throw bad(`Line ${body.line} isn't “${body.expect}” any more (the note changed): list the tasks again`, 409);
  } else if (body.match) {
    const found = items.filter((x) => x.text.toLowerCase().includes(String(body.match).toLowerCase()));
    if (found.length > 1) throw bad(`${found.length} items match “${body.match}”: use blockId or line`, 409);
    it = found[0];
  } else throw bad('Say which item: blockId, line, or match (text it contains)');
  if (!it) throw bad('No such checklist item in that note', 404);
  return it;
}

/** A new checklist line from the API's fields. */
function buildItem(body) {
  const text = String(body.text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (!text) throw bad('An item needs text');
  if (text.length > 2000) throw bad('That item is too long');
  const ch = STATES[body.state || 'todo'];
  if (ch === undefined) throw bad('state is todo, doing, done or cancelled');
  let line = `- [${ch}] ${text}`;
  if (body.priority != null) {
    if (!PRIORITIES[body.priority]) throw bad('priority is highest, high, medium, low or lowest');
    line += ' ' + PRIORITIES[body.priority];
  }
  if (body.due != null) {
    if (!DATE.test(String(body.due))) throw bad('due is YYYY-MM-DD, or YYYY-MM-DD HH:MM');
    line += ' 📅 ' + body.due;
  }
  if (ch === 'x') line += ' ✅ ' + localDate(new Date());
  return line;
}

/** Put `line` in the text: under `heading` (added at the end if it's not there), or at the end. */
function addLine(text, line, heading) {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  if (heading) {
    const name = String(heading).replace(/^#+\s*/, '').trim();
    const placed = insertInSection(lines, name, line);
    if (placed) return { text: placed.join('\n') + '\n', line: placed.indexOf(line, 0) };
    if (lines.length) lines.push('');
    lines.push(`## ${name}`, line);
  } else lines.push(line);
  return { text: lines.join('\n') + '\n', line: lines.lastIndexOf(line) };
}

/**
 * The endpoints. Each is { method, path, scope, summary, params, body, run(ctx, q, body) }; the list
 * doubles as the API's own description (GET /api/v1), which Settings → API uses to show and try them.
 */
export const ENDPOINTS = [
  { method: 'GET', path: '/api/v1', scope: 'read', summary: 'This list of endpoints, and who you are.',
    run: ({ who }) => ({ version: API_VERSION, user: who, endpoints: ENDPOINTS.map(({ run, ...e }) => e) }) },

  { method: 'GET', path: '/api/v1/notes', scope: 'read', summary: 'List notes (path, size, modified time). Optionally only those in a folder.',
    params: { folder: 'Only notes in this folder (and its subfolders)' },
    run: ({ ws }, q) => {
      const folder = String(q.get('folder') || '').replace(/^\/+|\/+$/g, '');
      return ws.vault.list().files.filter((f) => !folder || f.path.startsWith(folder + '/'))
        .map((f) => ({ path: f.path, size: f.size, modified: new Date(f.mtime).toISOString() }));
    } },

  { method: 'GET', path: '/api/v1/note', scope: 'read', summary: "A note's text, and its hash (send it back as baseContent's hash to detect clashes).",
    params: { path: 'The note, e.g. Projects/Plan.md (".md" may be left off)' },
    run: ({ ws }, q) => { const r = ws.vault.read(needPath(q)); return { path: r.path, content: r.content, hash: r.hash, modified: new Date(r.mtime).toISOString() }; } },

  { method: 'PUT', path: '/api/v1/note', scope: 'write', summary: "Create a note, or replace its text. With baseContent (the text you started from), others' changes since are merged in instead of lost.",
    params: { path: 'The note' }, body: { content: 'The whole text (required)', baseContent: 'Optional: the text you last read' },
    run: ({ ws }, q, b) => {
      if (typeof b.content !== 'string') throw bad('Send { "content": "…" }');
      if (b.content.length > 2 * 1024 * 1024) throw bad('That note is too large', 413);
      const p = needPath(q);
      const created = !ws.vault.exists(p);
      const r = ws.vault.save(p, b.content, { baseContent: typeof b.baseContent === 'string' ? b.baseContent : null });
      ws.scheduleExternalSync();
      return { path: r.path, hash: r.hash, created, merged: !!r.merged, conflicts: r.conflicts || 0 };
    } },

  { method: 'POST', path: '/api/v1/note/append', scope: 'write', summary: 'Add text to the end of a note, or under one of its headings (made if missing). Creates the note if needed.',
    params: { path: 'The note' }, body: { text: 'The text to add (required)', heading: 'Optional: put it at the end of this heading\'s section' },
    run: ({ ws }, q, b) => {
      const add = String(b.text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      if (!add.trim()) throw bad('Send { "text": "…" }');
      const p = needPath(q);
      let at = null;
      ws.vault.modify(p, (cur) => {
        if (b.heading) { const r = addLine(cur, add, b.heading); at = r.line; return r.text; }
        const base = cur.replace(/\n+$/, '');
        at = base ? base.split('\n').length : 0;
        return (base ? base + '\n' : '') + add + '\n';
      });
      ws.scheduleExternalSync();
      return { path: p, line: at };
    } },

  { method: 'DELETE', path: '/api/v1/note', scope: 'write', summary: 'Move a note to the trash (it can be put back from the Trash).',
    params: { path: 'The note' },
    run: ({ ws, onTrash }, q) => { const p = needPath(q); ws.vault.trash(p); onTrash?.(p); return { ok: true, path: p }; } },

  { method: 'GET', path: '/api/v1/tasks', scope: 'read', summary: 'Checklist items, filtered. Each has its note, line, state, text, heading, due date, priority and blockId (synced items).',
    params: { path: 'Only this note', state: 'todo, doing, done or cancelled (comma-separated for several)', q: 'Text the item contains',
      due_before: 'Due on or before this date (YYYY-MM-DD)', due_after: 'Due on or after this date', limit: 'At most this many (default 500)' },
    run: ({ ws }, q) => {
      const states = String(q.get('state') || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of states) if (!STATES[s]) throw bad('state is todo, doing, done or cancelled');
      const text = String(q.get('q') || '').toLowerCase();
      const before = q.get('due_before'), after = q.get('due_after');
      const limit = Math.min(5000, Math.max(1, Number(q.get('limit')) || 500));
      const paths = q.get('path') ? [needPath(q)] : ws.index.allTasks().map((t) => t.path).filter((p, i, a) => a.indexOf(p) === i);
      const out = [];
      for (const p of paths) {
        if (/^Templates\//i.test(p) && !q.get('path')) continue;
        let content;
        try { content = ws.vault.read(p).content; } catch (e) { if (q.get('path')) throw e; continue; }
        for (const it of itemsOf(p, content)) {
          if (states.length && !states.includes(it.state)) continue;
          if (text && !it.text.toLowerCase().includes(text)) continue;
          if (before && !(it.due && it.due.slice(0, 10) <= before)) continue;
          if (after && !(it.due && it.due.slice(0, 10) >= after)) continue;
          out.push(it);
          if (out.length >= limit) return out;
        }
      }
      return out;
    } },

  { method: 'POST', path: '/api/v1/tasks', scope: 'write', summary: 'Add a checklist item to a note (made if needed), at the end or under a heading. Add #task (or your sync tag) to the text to sync it.',
    params: { path: 'The note' },
    body: { text: 'The item (required)', heading: 'Optional: under this heading (made if missing)', state: 'Optional: todo (default), doing, done, cancelled',
      due: 'Optional: YYYY-MM-DD or YYYY-MM-DD HH:MM', priority: 'Optional: highest, high, medium, low, lowest' },
    run: ({ ws }, q, b) => {
      const p = needPath(q);
      const line = buildItem(b);
      let at = null;
      ws.vault.modify(p, (cur) => { const r = addLine(cur, line, b.heading); at = r.line; return r.text; });
      ws.scheduleExternalSync();
      return itemsOf(p, ws.vault.read(p).content).find((x) => x.line === at) || { path: p, line: at };
    } },

  { method: 'PUT', path: '/api/v1/task', scope: 'write', summary: "Change an item: its state (as clicking it would: sub-items first, filed under Complete), and/or its text. Name it by blockId, line (+ expect), or match.",
    params: { path: 'The note' },
    body: { blockId: 'The item\'s ^id (synced items have one)', line: 'Or its line number (from GET /api/v1/tasks)', expect: 'With line: text it must still contain',
      match: 'Or: text only that item contains', state: 'Optional: todo, doing, done, cancelled', text: 'Optional: new text (its due date, tags and id are kept unless you write them)' },
    run: ({ ws }, q, b) => {
      const p = needPath(q);
      if (!ws.vault.exists(p)) throw bad('No such note', 404);
      let result = null;
      ws.vault.modify(p, (cur) => {
        const it = findItem(cur, b);
        let text = cur;
        if (b.text != null) {
          const t = String(b.text).replace(/\s*\n\s*/g, ' ').trim();
          if (!t) throw bad('An item needs text');
          const lines = text.split('\n');
          const m = lines[it.line].match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[.\]\s?)(.*)$/);
          const keepId = it.blockId && !/\^[A-Za-z0-9-]+\s*$/.test(t) ? ` ^${it.blockId}` : '';
          lines[it.line] = m[1] + t + keepId;
          text = lines.join('\n');
        }
        let line = it.line;
        if (b.state != null) {
          const ch = STATES[b.state];
          if (ch === undefined) throw bad('state is todo, doing, done or cancelled');
          const before = text;
          const r = changeItem(text, it.line, ch, { moveCompleted: ws.config.get().moveCompleted !== false });
          if (r.open) throw bad(`Finish its ${r.open} sub-item${r.open > 1 ? 's' : ''} first`, 409);
          text = r.text;
          if (text !== before) {
            // It may have moved (under Complete / Cancelled): find it again by id or text.
            const after = itemsOf(p, text);
            const again = (it.blockId && after.find((x) => x.blockId === it.blockId)) ||
              after.find((x) => x.text.startsWith(it.text.replace(/\s*✅\s*\d{4}-\d\d-\d\d/u, '').slice(0, 40)) && x.state === STATE_NAME[ch]);
            if (again) line = again.line;
          }
        }
        result = { line };
        return text;
      });
      ws.scheduleExternalSync();
      const now = itemsOf(p, ws.vault.read(p).content).find((x) => x.line === result.line);
      return now || { path: p, line: result.line };
    } },

  { method: 'DELETE', path: '/api/v1/task', scope: 'write', summary: 'Remove an item (with its sub-items) from its note. A synced item is deleted in your task app too, and can be restored from Deleted tasks.',
    params: { path: 'The note', blockId: 'The item\'s ^id', line: 'Or its line number', expect: 'With line: text it must still contain', match: 'Or: text only that item contains' },
    run: ({ ws }, q) => {
      const p = needPath(q);
      if (!ws.vault.exists(p)) throw bad('No such note', 404);
      const sel = { blockId: q.get('blockId') || undefined, line: /^\d+$/.test(q.get('line') || '') ? Number(q.get('line')) : undefined, expect: q.get('expect') ?? undefined, match: q.get('match') || undefined };
      let removed = 0;
      ws.vault.modify(p, (cur) => {
        const it = findItem(cur, sel);
        const lines = cur.split('\n');
        const ind = (l) => l.match(/^\s*/)[0].length;
        let end = it.line + 1;
        while (end < lines.length && lines[end].trim() && ind(lines[end]) > ind(lines[it.line])) end++;
        removed = end - it.line;
        lines.splice(it.line, removed);
        return lines.join('\n');
      });
      ws.scheduleExternalSync();
      return { ok: true, removedLines: removed };
    } },

  { method: 'GET', path: '/api/v1/search', scope: 'read', summary: 'Full-text search over note names and text.',
    params: { q: 'What to look for (required)' },
    run: ({ ws }, q) => {
      if (!String(q.get('q') || '').trim()) throw bad('Give ?q=');
      return ws.index.search(q.get('q')).map((r) => ({ path: r.path, snippet: r.snippet.replace(/<\/?mark>/g, '**') }));
    } },

  { method: 'POST', path: '/api/v1/sync', scope: 'write', summary: 'Sync with your CalDAV task lists now, and wait for it to finish.',
    run: async ({ ws }) => {
      const r = await ws.sync.run();
      const { log, ...counts } = r;
      return counts;
    } },
];

const byKey = new Map(ENDPOINTS.map((e) => [`${e.method} ${e.path}`, e]));
export const apiEndpoint = (method, pathname) => byKey.get(`${method} ${pathname.replace(/\/+$/, '') || '/'}`) || null;
