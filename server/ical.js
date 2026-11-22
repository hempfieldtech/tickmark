// Minimal iCalendar (RFC 5545) reader/writer focused on VTODO.
// Remote todos are patched field-by-field so properties written by other clients
// (alarms, descriptions, timezones, X- props…) survive a round trip.

import { localDate } from '../public/shared/tasks.js';
import { normalizeRRule, parseRRule, formatRRule } from '../public/shared/recur.js';

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = '', q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (c === sep && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseProp(line) {
  let q = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...ps] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params = {};
  for (const p of ps) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1), raw: line };
}

export function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const root = { name: '#root', props: [], components: [] };
  const stack = [root];
  for (const line of lines) {
    if (!line.trim()) continue;
    const up = line.toUpperCase();
    if (up.startsWith('BEGIN:')) {
      const c = { name: up.slice(6).trim(), props: [], components: [] };
      stack.at(-1).components.push(c);
      stack.push(c);
    } else if (up.startsWith('END:')) {
      if (stack.length > 1) stack.pop();
    } else {
      const p = parseProp(line);
      if (p) stack.at(-1).props.push(p);
    }
  }
  return root;
}

function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function serializeICS(root) {
  const lines = [];
  const walk = (c) => {
    lines.push(`BEGIN:${c.name}`);
    for (const p of c.props) lines.push(p.raw);
    for (const sub of c.components) walk(sub);
    lines.push(`END:${c.name}`);
  };
  for (const c of root.components) walk(c);
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
export const unescapeText = (s) => String(s).replace(/\\([nN]|[\\;,])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

const p2 = (n) => String(n).padStart(2, '0');
function utcStamp(d = new Date()) {
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

/** Convert an iCal DATE / DATE-TIME value into our "YYYY-MM-DD[ HH:MM]" form (local time). */
function icalToLocal(value, params = {}) {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (params.VALUE === 'DATE' || !m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return `${localDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  // Floating or TZID-qualified: keep the wall-clock time as written.
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function localToProp(name, val) {
  const [date, time] = val.split(' ');
  const d = date.replace(/-/g, '');
  if (!time) return `${name};VALUE=DATE:${d}`;
  return `${name}:${d}T${time.replace(':', '')}00`;
}

const getProp = (c, name) => c.props.find((p) => p.name === name);

const calOf = (root) => root.components.find((c) => c.name === 'VCALENDAR') || root;

/** The todo itself: for a recurring todo, the master rather than a per-occurrence exception. */
export function findTodo(root) {
  const todos = calOf(root).components.filter((c) => c.name === 'VTODO');
  return todos.find((c) => !getProp(c, 'RECURRENCE-ID')) || todos[0] || null;
}

/**
 * Some clients complete one occurrence of a recurring todo by adding an exception (RECURRENCE-ID)
 * marked COMPLETED instead of moving the todo on. True if that happened to the current occurrence.
 */
export function occurrenceCompleted(root, master) {
  const due = getProp(master, 'DUE') || getProp(master, 'DTSTART');
  const cur = due ? icalToLocal(due.value, due.params)?.slice(0, 10) : null;
  return calOf(root).components.some((c) => {
    if (c.name !== 'VTODO' || c === master) return false;
    const rid = getProp(c, 'RECURRENCE-ID');
    const st = getProp(c, 'STATUS')?.value?.toUpperCase();
    const at = rid && icalToLocal(rid.value, rid.params)?.slice(0, 10);
    return at && st === 'COMPLETED' && (!cur || at >= cur);
  });
}

/** Extract our task model from a VTODO component. */
export function todoModel(vtodo) {
  const summary = getProp(vtodo, 'SUMMARY');
  const status = getProp(vtodo, 'STATUS')?.value?.toUpperCase();
  const completed = getProp(vtodo, 'COMPLETED');
  const pct = getProp(vtodo, 'PERCENT-COMPLETE');
  const due = getProp(vtodo, 'DUE');
  const prio = parseInt(getProp(vtodo, 'PRIORITY')?.value || '0', 10) || 0;
  const done = status === 'COMPLETED' || (!status && (!!completed || pct?.value === '100'));
  const rr = getProp(vtodo, 'RRULE');
  let recur = rr ? normalizeRRule(rr.value) : null;
  if (recur && /^DONE$/i.test(getProp(vtodo, 'X-TICKMARK-WHEN')?.value || '')) recur = formatRRule({ ...parseRRule(recur), 'X-WHEN': 'DONE' });
  return {
    model: {
      title: summary ? unescapeText(summary.value).replace(/\s+/g, ' ').trim() : '',
      done,
      due: due ? icalToLocal(due.value, due.params) : null,
      priority: prio,
      recur,
    },
    uid: getProp(vtodo, 'UID')?.value,
    doneDate: completed ? icalToLocal(completed.value, completed.params)?.slice(0, 10) : null,
    tickmarkId: getProp(vtodo, 'X-TICKMARK-ID')?.value || null,
    cancelled: status === 'CANCELLED',
  };
}

const prop = (raw) => parseProp(raw);

/**
 * Build the ICS for a todo. If `existing` (ICS text) is given, only the fields that
 * differ from it are rewritten.
 */
export function buildTodo({ existing = null, uid, model, tickmarkId, description, doneDate }) {
  let root, vtodo, prev = null;
  const now = utcStamp();
  if (existing) {
    root = parseICS(existing);
    vtodo = findTodo(root);
    if (vtodo) prev = todoModel(vtodo).model;
  }
  if (!vtodo) {
    root = { name: '#root', props: [], components: [] };
    const cal = { name: 'VCALENDAR', components: [], props: [prop('VERSION:2.0'), prop('PRODID:-//Tickmark//Markdown Tasks//EN')] };
    vtodo = { name: 'VTODO', components: [], props: [prop(`UID:${uid}`), prop(`CREATED:${now}`)] };
    if (description) vtodo.props.push(prop(`DESCRIPTION:${escapeText(description)}`));
    cal.components.push(vtodo);
    root.components.push(cal);
  }
  const drop = (...names) => { vtodo.props = vtodo.props.filter((p) => !names.includes(p.name)); };
  const add = (raw) => vtodo.props.push(prop(raw));

  if (!prev || prev.title !== model.title) { drop('SUMMARY'); add(`SUMMARY:${escapeText(model.title)}`); }
  if (!prev || prev.done !== model.done) {
    drop('STATUS', 'COMPLETED', 'PERCENT-COMPLETE');
    if (model.done) {
      add('STATUS:COMPLETED');
      add('PERCENT-COMPLETE:100');
      add(`COMPLETED:${doneDate ? doneDate.replace(/-/g, '') + 'T120000Z' : now}`);
    } else {
      add('STATUS:NEEDS-ACTION');
    }
  }
  if (!prev || (prev.due || null) !== (model.due || null)) {
    drop('DUE');
    if (model.due) {
      add(localToProp('DUE', model.due));
      // Keep the todo valid: DTSTART must not be after DUE.
      const ds = getProp(vtodo, 'DTSTART');
      if (ds && (icalToLocal(ds.value, ds.params) || '') > model.due) drop('DTSTART');
    }
  }
  const recurChanged = !prev || (prev.recur || null) !== (model.recur || null);
  if (recurChanged) {
    drop('RRULE', 'X-TICKMARK-WHEN');
    if (model.recur) {
      const r = parseRRule(model.recur);
      const whenDone = r['X-WHEN'] === 'DONE';
      delete r['X-WHEN'];
      // UNTIL must match DTSTART's type: a date, or (for a timed todo) a floating date-time.
      if (r.UNTIL && model.due?.includes(' ')) r.UNTIL = r.UNTIL.slice(0, 8) + 'T235959';
      add(`RRULE:${formatRRule(r)}`);
      if (whenDone) add('X-TICKMARK-WHEN:DONE');
    }
  }
  if (model.recur && (recurChanged || !prev || (prev.due || null) !== (model.due || null))) {
    // A recurrence is anchored at DTSTART; keep it on the current occurrence.
    if (model.due) { drop('DTSTART'); add(localToProp('DTSTART', model.due)); }
    else if (!getProp(vtodo, 'DTSTART')) add(localToProp('DTSTART', localDate(new Date())));
    // Exceptions for earlier occurrences no longer apply once the todo has moved on.
    const cal = calOf(root);
    cal.components = cal.components.filter((c) => c === vtodo || c.name !== 'VTODO' || !getProp(c, 'RECURRENCE-ID'));
  }
  if (!prev || (prev.priority || 0) !== (model.priority || 0)) {
    drop('PRIORITY');
    if (model.priority) add(`PRIORITY:${model.priority}`);
  }
  if (tickmarkId) { drop('X-TICKMARK-ID'); add(`X-TICKMARK-ID:${tickmarkId}`); }
  const seq = parseInt(getProp(vtodo, 'SEQUENCE')?.value || '-1', 10);
  drop('DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE');
  add(`DTSTAMP:${now}`);
  add(`LAST-MODIFIED:${now}`);
  add(`SEQUENCE:${seq + 1}`);
  return serializeICS(root);
}
