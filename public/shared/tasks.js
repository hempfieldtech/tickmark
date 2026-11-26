// Shared checklist parser — imported by both the server (sync/index) and the PWA (preview).
//
// A checklist item syncs to CalDAV when:
//   * it carries one of the item tags            - [ ] Call dentist #task
//   * it sits under a heading with a section tag   ## Groceries #sync
//   * the note's frontmatter tags include a section tag
//
// Inline metadata (Obsidian Tasks-plugin compatible):
//   📅 2026-11-25  or  due:2026-11-25   (optional time: 📅 2026-11-25 14:30)
//   ⏫ high  🔼 medium  🔽 low  (🔺 / ⏬ also accepted)
//   🔁 every week  recurrence (see recur.js); checking the item moves it to the next date
//   ✅ 2026-11-21  completion date
//   ^abc123        block id — written by the sync engine to link the line to a CalDAV todo

import { parseRecurrence, describeRecurrence, nextOccurrence } from './recur.js';

// Checkbox states: [ ] to do, [/] in progress, [x] done, [-] cancelled (counts as finished).
export const TASK_LINE = /^(\s*(?:>\s*)*)([-*+]|\d+[.)])\s+\[([ xX/-])\](?:\s+(.*))?$/;
export const ANY_CHECKBOX = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX/-]\](?:\s|$)/;
/** A state character's meaning: done (finished, either way) and status (in-progress / cancelled / null). */
export const STATE = {
  ' ': { done: false, status: null }, '/': { done: false, status: 'in-progress' },
  x: { done: true, status: null }, X: { done: true, status: null }, '-': { done: true, status: 'cancelled' },
};
export const stateChar = ({ done, status }) => (status === 'cancelled' ? '-' : done ? 'x' : status === 'in-progress' ? '/' : ' ');
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const TAG = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const DUE = /(?:^|\s)(?:📅|due:)\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?(?=\s|$)/u;
const DONE_DATE = /(?:^|\s)✅\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
const PRIORITY = /(?:^|\s)(🔺|⏫|🔼|🔽|⏬)(?=\s|$)/u;
// The rule runs until the next metadata marker, tag or end of line.
const RECUR = /(?:^|\s)🔁\s*(.+?)(?=\s+(?:📅|due:|✅|⏫|🔼|🔽|🔺|⏬|#[\p{L}_/-])|\s*$)/u;
const PRIORITY_VALUE = { '🔺': 1, '⏫': 1, '🔼': 5, '🔽': 9, '⏬': 9 };

export const normTag = (t) => String(t).replace(/^#/, '').trim().toLowerCase();

export function priorityEmoji(p) {
  if (!p) return '';
  if (p <= 4) return '⏫';
  if (p === 5) return '🔼';
  return '🔽';
}

export function extractTags(s) {
  const tags = [];
  for (const m of s.matchAll(TAG)) tags.push(m[2]);
  return tags;
}

function frontmatterTags(lines) {
  if (lines[0]?.trim() !== '---') return { tags: [], end: 0 };
  let end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { tags: [], end: 0 };
  const tags = [];
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^tags\s*:\s*(.*)$/i);
    if (!m) continue;
    if (m[1].trim()) {
      tags.push(...m[1].replace(/[[\]"']/g, '').split(/[,\s]+/).filter(Boolean));
    } else {
      for (let j = i + 1; j < end && /^\s*-\s+/.test(lines[j]); j++) {
        tags.push(lines[j].replace(/^\s*-\s+/, '').replace(/["']/g, '').trim());
      }
    }
  }
  return { tags: tags.map(normTag), end: end + 1 };
}

/** Parse the text after "[ ] " into its parts. */
export function parseTaskBody(body, itemTagSet = new Set()) {
  let s = body ?? '';
  let blockId = null;
  const b = s.match(BLOCK_ID);
  if (b) { blockId = b[1]; s = s.slice(0, b.index); }

  // Unrecognised rules stay in the title, so nothing typed is lost.
  let recur = null;
  const rc = s.match(RECUR);
  if (rc) { recur = parseRecurrence(rc[1]); if (recur) s = s.replace(RECUR, ' '); }

  let due = null;
  const d = s.match(DUE);
  if (d) { due = d[2] ? `${d[1]} ${d[2]}` : d[1]; s = s.replace(DUE, ' '); }

  let doneDate = null;
  const dd = s.match(DONE_DATE);
  if (dd) { doneDate = dd[1]; s = s.replace(DONE_DATE, ' '); }

  let priority = 0;
  const p = s.match(PRIORITY);
  if (p) { priority = PRIORITY_VALUE[p[1]]; s = s.replace(PRIORITY, ' '); }

  const tags = extractTags(s);
  const syncTags = tags.filter((t) => itemTagSet.has(normTag(t)));
  // Only the sync tags are stripped from the title; other #tags stay as part of the text.
  if (syncTags.length) {
    s = s.replace(TAG, (all, pre, tag) => (itemTagSet.has(normTag(tag)) ? pre : all));
  }
  const title = s.replace(/\s+/g, ' ').trim();
  return { title, due, doneDate, priority, recur, blockId, tags, syncTags };
}

/**
 * Parse every checklist item in a markdown document.
 * Returns [{ line, prefix, bullet, done, title, due, doneDate, priority, blockId, tags, syncTags, synced, scopeTags, section }]
 */
export function parseTasks(text, { itemTags = ['task'], sectionTags = ['sync'] } = {}) {
  const lines = text.split('\n');
  const itemSet = new Set(itemTags.map(normTag));
  const sectionSet = new Set(sectionTags.map(normTag));
  const fm = frontmatterTags(lines);
  const fileScope = fm.tags.filter((t) => sectionSet.has(t));

  const stack = [];
  let fence = null;
  const out = [];
  for (let i = fm.end; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }

    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const htags = extractTags(h[2]).map(normTag);
      stack.push({ level, scope: htags.filter((t) => sectionSet.has(t)), text: h[2] });
      continue;
    }

    const m = line.match(TASK_LINE);
    if (!m) continue;
    const t = parseTaskBody(m[4], itemSet);
    // Section tags in effect, innermost heading first, then the note's frontmatter.
    const scopeTags = [...[...stack].reverse().flatMap((s) => s.scope), ...fileScope];
    // An empty checkbox (still being written, or a placeholder) has nothing to sync yet.
    const synced = !!t.title.trim() && (t.syncTags.length > 0 || scopeTags.length > 0);
    out.push({
      line: i,
      prefix: m[1],
      bullet: m[2],
      done: STATE[m[3]].done,
      status: STATE[m[3]].status,
      ...t,
      synced,
      scopeTags,
      section: stack.length ? sectionName(stack.at(-1).text) : null,
    });
  }
  return out;
}

/** A heading's text as a task's `section`: the heading without its #tags. */
export function sectionName(headingText) {
  return headingText.replace(TAG, '$1').replace(/\s+/g, ' ').trim();
}

/** Whether two headings are "the same" for putting tasks back: level, case, spacing and **formatting** don't matter. */
export function sameSection(a, b) {
  // Also ignores emoji, punctuation and a trailing colon, so "## 🛒 Groceries:" is "### groceries".
  const norm = (x) => String(x ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const x = norm(a), y = norm(b);
  return x || y ? x === y : String(a ?? '').trim() === String(b ?? '').trim(); // emoji-only headings: as written
}

/**
 * Insert `line` under the heading named `section` (as in a task's `section`, its innermost heading):
 * at the end of that heading's own content, before its first subheading (so an item that sat right
 * under a note's "# Title" doesn't land under the last "##" of the note), and before trailing blank
 * lines and a closing --- divider. Returns the new lines, or null if no such heading exists.
 */
export function insertInSection(lines, section, line) {
  let fence = null, start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = lines[i].match(HEADING);
    if (!h) continue;
    if (start >= 0) { end = i; break; }
    if (sameSection(sectionName(h[2]), section)) start = i;
  }
  if (start < 0) return null;
  let at = end;
  const skipBlank = () => { while (at > start + 1 && lines[at - 1].trim() === '') at--; };
  skipBlank();
  // A divider that closes the section (not one right under the heading) stays below the item.
  if (at > start + 2 && /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[at - 1]) && lines.slice(start + 1, at - 1).some((l) => l.trim())) { at--; skipBlank(); }
  return [...lines.slice(0, at), line, ...lines.slice(at)];
}

/** Line indexes of every rendered checkbox, in document order (used to map preview clicks → source). */
export function checkboxLines(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null;
  const fm = frontmatterTags(lines);
  for (let i = fm.end; i < lines.length; i++) {
    const f = lines[i].match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    if (ANY_CHECKBOX.test(lines[i])) out.push(i);
  }
  return out;
}

/** The fields that are synced with CalDAV. */
export function taskModel(t) {
  return { title: t.title, done: !!t.done, status: t.status || null, due: t.due || null, priority: t.priority || 0, recur: t.recur || null };
}

export function modelsEqual(a, b) {
  if (!a || !b) return false;
  return a.title === b.title && a.done === b.done && (a.status || null) === (b.status || null) && (a.due || null) === (b.due || null) &&
    (a.priority || 0) === (b.priority || 0) && (a.recur || null) === (b.recur || null);
}

/** Rebuild a checklist line from a parsed task and a (possibly changed) model. */
export function buildTaskLine(task, model, { doneDate = null, extraTags = [] } = {}) {
  const parts = [];
  if (model.title) parts.push(model.title);
  for (const t of [...(task.syncTags || []), ...extraTags]) parts.push('#' + t);
  if (model.priority) parts.push(priorityEmoji(model.priority));
  if (model.recur) parts.push('🔁 ' + describeRecurrence(model.recur));
  if (model.due) parts.push('📅 ' + model.due);
  const dd = model.done && model.status !== 'cancelled' ? (doneDate || task.doneDate) : null;
  if (dd) parts.push('✅ ' + dd);
  if (task.blockId) parts.push('^' + task.blockId);
  return `${task.prefix || ''}${task.bullet || '-'} [${stateChar(model)}] ${parts.join(' ')}`;
}

/**
 * Completing a recurring task: the line stays open with the next date (keeping its block id, so it
 * stays linked to the same CalDAV todo), and a completed copy without the rule goes right below it.
 * Returns { open, openLine, historyLine }, or null if the series is over.
 */
export function advanceRecurring(task, { doneDate, today }) {
  if (!task.recur) return null;
  const when = doneDate || task.doneDate || today;
  const next = nextOccurrence(task.recur, { due: task.due, doneDate: when, today });
  if (!next) return null;
  const model = taskModel(task);
  const open = { ...model, done: false, due: next.due, recur: next.rule };
  return {
    open,
    openLine: buildTaskLine(task, open),
    historyLine: buildTaskLine({ ...task, blockId: null }, { ...model, done: true, recur: null }, { doneDate: when }),
  };
}

/** Toggle the checkbox on a given line of text. Returns the new text (or the same text if not a checkbox). */
export function toggleLine(text, lineNo, { stampDone = true } = {}) {
  const lines = text.split('\n');
  const line = lines[lineNo];
  if (line == null) return text;
  const m = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX/-])(\].*)$/);
  if (!m) return text;
  const nowDone = !STATE[m[2]].done; // to do or in progress → done; done or cancelled → to do
  if (nowDone && stampDone) {
    const tm = line.match(TASK_LINE);
    const t = tm && { prefix: tm[1], bullet: tm[2], done: false, ...parseTaskBody(tm[4]) };
    const a = t?.recur && advanceRecurring(t, { today: localDate(new Date()) });
    if (a) {
      lines.splice(lineNo, 1, a.openLine, a.historyLine);
      return lines.join('\n');
    }
  }
  let rest = m[3];
  if (stampDone) {
    if (nowDone && !DONE_DATE.test(rest)) {
      const today = localDate(new Date());
      const bid = rest.match(BLOCK_ID);
      rest = bid ? `${rest.slice(0, bid.index)} ✅ ${today}${rest.slice(bid.index)}` : `${rest.replace(/\s+$/, '')} ✅ ${today}`;
    } else if (!nowDone) {
      rest = rest.replace(DONE_DATE, '');
    }
  }
  lines[lineNo] = m[1] + (nowDone ? 'x' : ' ') + rest;
  return lines.join('\n');
}

export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function newBlockId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 't';
  for (let i = 0; i < 7; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export const COMPLETE_HEADING = 'Complete';
export const CANCELLED_HEADING = 'Cancelled';
const isFinishedHeading = (name) => sameSection(name, COMPLETE_HEADING) || sameSection(name, CANCELLED_HEADING);

/**
 * Keep finished checklist items out of the way: a checked item (with its indented sub-items) moves to
 * the end of a "Complete" subheading at the end of its section, and a cancelled one ([-]) to a
 * "Cancelled" subheading after it; either heading is added if needed. Switching between done and
 * cancelled moves the item across. An item reopened there moves back up, just above those headings,
 * and an emptied heading goes away. Only top-level items move (not sub-items of another item).
 * Returns the new text, or null if nothing moved.
 */
export function fileCompleted(text, lineNo) {
  let lines = text.split('\n');
  const m = lines[lineNo]?.match(/^((?:[-*+]|\d+[.)])\s+)\[([ xX/-])\]/);
  if (!m) return null;
  const done = STATE[m[2]].done;
  const want = !done ? null : m[2] === '-' ? CANCELLED_HEADING : COMPLETE_HEADING;
  // Headings outside code blocks: [{ i, level, name }]
  const headings = (ls) => {
    const out = [];
    let fence = null;
    for (let i = 0; i < ls.length; i++) {
      const f = ls[i].match(FENCE);
      if (fence) {
        if (i === lineNo && ls === lines) return null; // a checkbox in a code block isn't an item
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        continue;
      }
      if (f) { fence = f[1]; continue; }
      const h = ls[i].match(HEADING);
      if (h) out.push({ i, level: h[1].length, name: sectionName(h[2]) });
    }
    return out;
  };
  let heads = headings(lines);
  if (!heads) return null;
  const end = (h, hs = heads, n = lines.length) => (hs.find((x) => x.i > h.i && x.level <= h.level) || { i: n }).i;
  // The item and its sub-items (more indented lines; blank lines only if more sub-items follow).
  let last = lineNo;
  for (let i = lineNo + 1; i < lines.length; i++) {
    if (/^\s+\S/.test(lines[i])) last = i;
    else if (lines[i].trim()) break;
  }
  const block = lines.slice(lineNo, last + 1);
  const own = [...heads].reverse().find((h) => h.i < lineNo) || null;
  if (want && own && sameSection(own.name, want)) return null; // already filed
  if (!want && !(own && isFinishedHeading(own.name))) return null; // open, and not filed: stays put

  // Take the block out, dropping its old "Complete"/"Cancelled" heading if that leaves it empty.
  let out = [...lines];
  out.splice(lineNo, block.length);
  let parentAt = null; // where a reopened item goes: above the section's finished headings
  if (own && isFinishedHeading(own.name)) {
    const sEnd = end(own) - block.length;
    const left = out.slice(own.i + 1, sEnd).some((l) => l.trim());
    // The finished headings run: this one and any sibling finished headings just before it.
    let first = own;
    for (let k = heads.indexOf(own) - 1; k >= 0; k--) {
      const h = heads[k];
      if (h.level < own.level) break;
      if (h.level === own.level) { if (isFinishedHeading(h.name)) first = h; else break; }
    }
    let at = first.i;
    while (at > 0 && !out[at - 1].trim()) at--;
    if (!left) {
      let from = own.i;
      while (from > 0 && !out[from - 1].trim()) from--;
      out.splice(from, own.i + 1 - from);
      if (first === own) at = from;
    }
    parentAt = at;
  }
  if (!want) {
    out.splice(parentAt, 0, ...block);
    return out.join('\n');
  }

  // File it under the right heading at the end of its (parent) section.
  lines = out;
  heads = headings(lines) || [];
  const parent = own && isFinishedHeading(own.name)
    ? [...heads].reverse().find((h) => h.i < (parentAt ?? 0) && h.level < own.level) || null
    : own && [...heads].reverse().find((h) => h.i < lineNo) || null;
  const lvl = parent ? parent.level : 1;
  const sub = Math.min(lvl + 1, 6);
  const secEnd = parent ? end(parent) : lines.length;
  const inSec = (h) => h.i > (parent ? parent.i : -1) && h.i < secEnd && h.level === sub;
  const trimBack = (at, floor) => { while (at > floor + 1 && !lines[at - 1].trim()) at--; return at; };
  const target = heads.find((h) => inSec(h) && sameSection(h.name, want));
  if (target) {
    const at = trimBack(end(target), target.i);
    return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
  }
  // A new "Complete" goes before an existing "Cancelled"; "Cancelled" goes at the very end.
  const cancelled = want === COMPLETE_HEADING && heads.find((h) => inSec(h) && sameSection(h.name, CANCELLED_HEADING));
  const at = cancelled ? trimBack(cancelled.i, parent ? parent.i : -1) : trimBack(secEnd, parent ? parent.i : -1);
  const heading = `${'#'.repeat(sub)} ${want}`;
  const gap = at > 0 && lines[at - 1].trim() ? [''] : [];
  const after = at < lines.length && lines[at].trim() ? [''] : [];
  return [...lines.slice(0, at), ...gap, heading, ...block, ...after, ...lines.slice(at)].join('\n');
}

/**
 * Add lines at the end of a note's own content: before a "Complete" section that runs to the end of
 * the note (so new tasks don't land among finished ones), otherwise at the very end.
 * `keep` lines at the top are never trimmed (e.g. the blank line under a fresh heading).
 */
export function appendLines(lines, add, { keep = 0 } = {}) {
  const out = [...lines];
  const heads = [];
  let fence = null;
  for (let i = 0; i < out.length; i++) {
    const f = out[i].match(FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = out[i].match(HEADING);
    if (h) heads.push({ i, level: h[1].length, name: sectionName(h[2]) });
  }
  // "Complete" (and/or "Cancelled") headings that end the note.
  const tail = heads.find((h, k) => isFinishedHeading(h.name) &&
    heads.slice(k + 1).every((x) => x.level > h.level || (x.level === h.level && isFinishedHeading(x.name))));
  if (!tail) {
    while (out.length > keep && out.at(-1) === '') out.pop();
    return [...out, ...add];
  }
  let at = tail.i;
  while (at > keep && out[at - 1] === '') at--;
  return [...out.slice(0, at), ...add, '', ...out.slice(tail.i)];
}

/** How many unchecked checkbox sub-items (more indented, directly below) the item on `lineNo` has. */
export function openSubtasks(text, lineNo) {
  const lines = text.split('\n');
  const indent = (l) => l.match(/^[ \t>]*/)[0].replace(/\t/g, '    ').length;
  const base = indent(lines[lineNo] ?? '');
  let open = 0;
  for (let i = lineNo + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= base) break;
    if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ /]\]/.test(l)) open++;
  }
  return open;
}

/**
 * Set the item on `lineNo` to a state character (' ', '/', 'x', '-'). Becoming done goes through
 * toggleLine, so it gets its ✅ date (and a recurring item moves on); leaving done drops the date.
 */
export function setTaskState(text, lineNo, ch) {
  const lines = text.split('\n');
  const m = lines[lineNo]?.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX/-])(\].*)$/);
  if (!m || m[2] === ch || (STATE[m[2]].done && !STATE[m[2]].status && 'xX'.includes(ch))) return text;
  if (ch === 'x' || ch === 'X') {
    if (STATE[m[2]].done) { lines[lineNo] = m[1] + ' ' + m[3]; text = lines.join('\n'); } // cancelled → done
    return toggleLine(text, lineNo);
  }
  let rest = m[3].replace(DONE_DATE, '');
  if (ch === '-') rest = dropRecurrence(rest);
  lines[lineNo] = m[1] + ch + rest;
  return lines.join('\n');
}

/**
 * Cancelling a recurring item cancels the whole series: its 🔁 rule goes, so nothing moves it on
 * to a next date (which would look like completing each occurrence). Keeps the block id.
 */
export function dropRecurrence(rest) {
  const b = rest.match(BLOCK_ID);
  const head = b ? rest.slice(0, b.index) : rest;
  const rc = head.match(RECUR);
  if (!rc || !parseRecurrence(rc[1])) return rest;
  return head.replace(RECUR, '') + (b ? rest.slice(b.index) : '');
}

/** A cancelled task has no recurrence (see dropRecurrence). */
export const endCancelledSeries = (model) => (model.status === 'cancelled' && model.recur ? { ...model, recur: null } : model);

const ITEM_STATE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ xX/-])\]/;

/** Cancel the unfinished checkbox sub-items ([ ] and [/]) of the item on `lineNo`; finished ones stay. */
export function cancelSubtasks(text, lineNo) {
  const lines = text.split('\n');
  const indent = (l) => l.match(/^[ \t>]*/)[0].replace(/\t/g, '    ').length;
  const base = indent(lines[lineNo] ?? '');
  for (let i = lineNo + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indent(lines[i]) <= base) break;
    if (/^[ /]$/.test(lines[i].match(ITEM_STATE)?.[1] ?? '')) text = setTaskState(text, i, '-');
  }
  return text;
}

/**
 * Change a checklist item the way a click or the checkbox menu does: `ch` is the new state
 * (' ', '/', 'x', '-'), or null to toggle (to do / in progress → done, finished → to do).
 * - An item with unchecked sub-items can't be completed: returns { text (unchanged), open: n }.
 * - Cancelling an item cancels its unfinished sub-items too (they aren't needed any more).
 * - With moveCompleted, it's filed under (or back out of) "Complete" / "Cancelled".
 */
export function changeItem(text, lineNo, ch = null, { moveCompleted = true } = {}) {
  const was = (text.split('\n')[lineNo] ?? '').match(ITEM_STATE)?.[1];
  if (was === undefined) return { text, open: 0 };
  const finished = (c) => 'xX-'.includes(c);
  const want = ch ?? (finished(was) ? ' ' : 'x');
  if (want === was || (finished(was) && !STATE[was].status && 'xX'.includes(want))) return { text, open: 0 };
  if ('xX'.includes(want) && !finished(was)) {
    const open = openSubtasks(text, lineNo);
    if (open) return { text, open };
  }
  let next = text;
  if (want === '-') next = cancelSubtasks(next, lineNo);
  // Checking an open item goes through toggleLine: ✅ date, and a recurring one moves on.
  next = 'xX'.includes(want) && !finished(was) ? toggleLine(next, lineNo) : setTaskState(next, lineNo, want);
  const kind = (c) => (c === '-' ? 'cancelled' : 'xX'.includes(c) ? 'done' : 'open');
  if (next === text || !moveCompleted || kind(want) === kind(was)) return { text: next, open: 0 };
  // A recurring item leaves a completed copy on the line below; that's the one to file away.
  const at = next.split('\n').length > text.split('\n').length ? lineNo + 1 : lineNo;
  return { text: fileCompleted(next, at) ?? next, open: 0 };
}
