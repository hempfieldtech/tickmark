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

export const TASK_LINE = /^(\s*(?:>\s*)*)([-*+]|\d+[.)])\s+\[([ xX])\](?:\s+(.*))?$/;
export const ANY_CHECKBOX = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/;
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
    const synced = t.syncTags.length > 0 || scopeTags.length > 0;
    out.push({
      line: i,
      prefix: m[1],
      bullet: m[2],
      done: m[3] !== ' ',
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

/**
 * Insert `line` at the end of the section under the heading named `section` (as in a task's `section`),
 * before any trailing blank lines. Returns the new lines, or null if no such heading exists.
 */
export function insertInSection(lines, section, line) {
  let fence = null, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = lines[i].match(HEADING);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) {
      let at = i;
      while (at > start + 1 && lines[at - 1].trim() === '') at--;
      return [...lines.slice(0, at), line, ...lines.slice(at)];
    }
    if (start < 0 && sectionName(h[2]) === section) { start = i; level = h[1].length; }
  }
  if (start < 0) return null;
  let at = lines.length;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
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
  return { title: t.title, done: !!t.done, due: t.due || null, priority: t.priority || 0, recur: t.recur || null };
}

export function modelsEqual(a, b) {
  if (!a || !b) return false;
  return a.title === b.title && a.done === b.done && (a.due || null) === (b.due || null) &&
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
  const dd = model.done ? (doneDate || task.doneDate) : null;
  if (dd) parts.push('✅ ' + dd);
  if (task.blockId) parts.push('^' + task.blockId);
  return `${task.prefix || ''}${task.bullet || '-'} [${model.done ? 'x' : ' '}] ${parts.join(' ')}`;
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
  const m = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/);
  if (!m) return text;
  const nowDone = m[2] === ' ';
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
