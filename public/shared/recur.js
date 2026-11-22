// Recurring tasks: plain-English rules (Obsidian Tasks style) ⇄ iCalendar RRULE, and next-occurrence math.
// Shared by the server (sync) and the browser (checking an item in the preview).
//
//   🔁 every day | every 3 days | every other week | every weekday | every weekend
//   🔁 every week on Monday, Friday | every Tuesday and Thursday | every 2 weeks on Sat
//   🔁 every month | every month on the 15th | on the 1st and 15th | on the last day | on the last Friday | on the 2nd Tuesday
//   🔁 every year | every year on March 3
//   … until 2027-06-01        (stops after that date)
//   … when done               (next date counts from when you complete it, not from the due date)
//   🔁 FREQ=MONTHLY;BYDAY=-1FR (any raw RRULE; Tickmark computes FREQ/INTERVAL/BYDAY/BYMONTHDAY/BYMONTH/COUNT/UNTIL)
//
// A rule is kept in canonical RRULE form, e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR". "When done" is
// stored as the extra part X-WHEN=DONE, which is written to CalDAV as a separate X- property.

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
const UNITS = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const UNIT_OF = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const KNOWN = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST', 'X-WHEN']);
const PART_ORDER = ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'COUNT', 'UNTIL', 'WKST', 'X-WHEN'];

function dayCode(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 2) return null;
  for (const c of WD_ORDER) if (DAY_NAMES[c].toLowerCase().startsWith(w) && (w.length >= 3 || c.toLowerCase() === w)) return c;
  return null;
}
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ---------------------------------------------------------------- canonical RRULE strings
export function parseRRule(s) {
  const o = {};
  for (const part of String(s || '').replace(/^RRULE:/i, '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim().toUpperCase();
  }
  return o;
}

/** Stable form, so the same rule written by two clients compares equal. */
export function formatRRule(o) {
  const r = { ...o };
  if (r.INTERVAL === '1') delete r.INTERVAL;
  if (r.WKST === 'MO') delete r.WKST;
  if (r.BYDAY) {
    const rank = (d) => { const m = d.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? (m[1] ? +m[1] * 10 : 0) * 10 + WD_ORDER.indexOf(m[2]) : 999; };
    r.BYDAY = r.BYDAY.split(',').filter(Boolean).sort((a, b) => rank(a) - rank(b)).join(',');
  }
  for (const k of ['BYMONTHDAY', 'BYMONTH']) if (r[k]) r[k] = r[k].split(',').map(Number).sort((a, b) => a - b).join(',');
  if (r.UNTIL) r.UNTIL = r.UNTIL.slice(0, 8);
  const keys = Object.keys(r).filter((k) => r[k] !== undefined && r[k] !== '')
    .sort((a, b) => (PART_ORDER.indexOf(a) + 1 || 99) - (PART_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return keys.map((k) => `${k}=${r[k]}`).join(';');
}

export const normalizeRRule = (s) => {
  const o = parseRRule(s);
  return o.FREQ && UNIT_OF[o.FREQ] ? formatRRule(o) : null;
};

// ---------------------------------------------------------------- text → rule
/** Parse the text after 🔁. Returns a canonical rule, or null if it isn't understood. */
export function parseRecurrence(text) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^(rrule:)?freq=/i.test(s)) return normalizeRRule(s.replace(/\s+/g, ''));
  s = s.toLowerCase().replace(/[.,]$/, '');
  const r = {};
  const wd = s.match(/\s+when done$/);
  if (wd) { r['X-WHEN'] = 'DONE'; s = s.slice(0, wd.index); }
  const until = s.match(/\s+until (\d{4})-(\d{2})-(\d{2})$/);
  if (until) { r.UNTIL = until[1] + until[2] + until[3]; s = s.slice(0, until.index); }
  const m = s.match(/^every\s+(.+)$/);
  if (!m) return null;
  let rest = m[1].replace(/^other\s+/, '2 ');

  const days = (list) => {
    const codes = list.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean).map(dayCode);
    return codes.length && codes.every(Boolean) ? codes.join(',') : null;
  };
  if (rest === 'weekday') return formatRRule({ ...r, FREQ: 'WEEKLY', BYDAY: 'MO,TU,WE,TH,FR' });
  if (rest === 'weekend') return formatRRule({ ...r, FREQ: 'WEEKLY', BYDAY: 'SA,SU' });
  const bare = days(rest);
  if (bare) return formatRRule({ ...r, FREQ: 'WEEKLY', BYDAY: bare });

  const u = rest.match(/^(?:(\d+)\s+)?(day|week|month|year)s?(?:\s+on\s+(?:the\s+)?(.+))?$/);
  if (!u) return null;
  const n = u[1] ? parseInt(u[1], 10) : 1;
  if (!(n >= 1 && n <= 999)) return null;
  r.FREQ = UNITS[u[2]];
  if (n > 1) r.INTERVAL = String(n);
  const on = u[3];
  if (!on) return formatRRule(r);

  if (r.FREQ === 'WEEKLY') {
    const d = days(on);
    if (!d) return null;
    r.BYDAY = d;
    return formatRRule(r);
  }
  if (r.FREQ === 'MONTHLY') {
    if (/^last( day)?$/.test(on)) { r.BYMONTHDAY = '-1'; return formatRRule(r); }
    const nth = on.match(/^(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\s+(\w+)$/);
    if (nth && dayCode(nth[2])) { r.BYDAY = ORD[nth[1]] + dayCode(nth[2]); return formatRRule(r); }
    const nums = on.replace(/^day\s+/, '').split(/\s*(?:,|\band\b|&)\s*(?:the\s+)?/).map((x) => x.match(/^(\d{1,2})(?:st|nd|rd|th)?$/));
    if (nums.length && nums.every((x) => x && +x[1] >= 1 && +x[1] <= 31)) { r.BYMONTHDAY = nums.map((x) => +x[1]).join(','); return formatRRule(r); }
    return null;
  }
  if (r.FREQ === 'YEARLY') {
    let mon, day, md;
    if ((md = on.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/))) [mon, day] = [md[1], md[2]];
    else if ((md = on.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/))) [day, mon] = [md[1], md[2]];
    else return null;
    const mi = MONTHS.findIndex((x) => x.startsWith(mon) && mon.length >= 3);
    if (mi < 0 || !(+day >= 1 && +day <= 31)) return null;
    r.BYMONTH = String(mi + 1);
    r.BYMONTHDAY = String(+day);
    return formatRRule(r);
  }
  return null;
}

// ---------------------------------------------------------------- rule → text
/** Plain-English form of a rule. Falls back to the raw RRULE when there's no simple phrase for it. */
export function describeRecurrence(rule) {
  const r = parseRRule(rule);
  const raw = () => formatRRule(r);
  if (!UNIT_OF[r.FREQ] || r.COUNT || Object.keys(r).some((k) => !KNOWN.has(k))) return raw();
  const n = +(r.INTERVAL || 1);
  const unit = UNIT_OF[r.FREQ];
  let s = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  const byday = r.BYDAY ? r.BYDAY.split(',') : [];
  const plain = byday.every((d) => /^[A-Z]{2}$/.test(d));
  if (r.FREQ === 'DAILY' && (byday.length || r.BYMONTHDAY || r.BYMONTH)) return raw();
  if (r.FREQ === 'WEEKLY') {
    if (r.BYMONTHDAY || r.BYMONTH || !plain) return raw();
    if (n === 1 && r.BYDAY === 'MO,TU,WE,TH,FR') s = 'every weekday';
    else if (n === 1 && r.BYDAY === 'SA,SU') s = 'every weekend';
    else if (byday.length) s += ' on ' + byday.map((d) => DAY_NAMES[d]).join(', ');
  }
  if (r.FREQ === 'MONTHLY') {
    if (r.BYMONTH || (r.BYDAY && r.BYMONTHDAY)) return raw();
    if (r.BYMONTHDAY) {
      const ds = r.BYMONTHDAY.split(',').map(Number);
      if (ds.length === 1 && ds[0] === -1) s += ' on the last day';
      else if (ds.every((d) => d > 0)) s += ' on the ' + ds.map(ordinal).join(' and ');
      else return raw();
    } else if (byday.length) {
      const m = byday.length === 1 && byday[0].match(/^([+-]?\d)([A-Z]{2})$/);
      if (!m || !(+m[1] === -1 || (+m[1] >= 1 && +m[1] <= 5))) return raw();
      s += ` on the ${+m[1] === -1 ? 'last' : ordinal(+m[1])} ${DAY_NAMES[m[2]]}`;
    }
  }
  if (r.FREQ === 'YEARLY') {
    if (r.BYDAY) return raw();
    if (r.BYMONTH || r.BYMONTHDAY) {
      if (!(r.BYMONTH && r.BYMONTHDAY) || r.BYMONTH.includes(',') || r.BYMONTHDAY.includes(',') || +r.BYMONTHDAY < 1) return raw();
      const mon = MONTHS[+r.BYMONTH - 1];
      s += ` on ${mon[0].toUpperCase() + mon.slice(1)} ${+r.BYMONTHDAY}`;
    }
  }
  if (r.UNTIL) s += ` until ${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}`;
  if (r['X-WHEN'] === 'DONE') s += ' when done';
  return s;
}

// ---------------------------------------------------------------- next occurrence
const toD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromD = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Days of month m (0-based) in year y that match BYMONTHDAY / BYDAY; `fallbackDay` when neither is set. */
function monthDays(y, m, r, fallbackDay) {
  const len = dim(y, m);
  const out = [];
  if (r.BYMONTHDAY) {
    for (const n of r.BYMONTHDAY.split(',').map(Number)) {
      const d = n > 0 ? n : len + n + 1;
      if (d >= 1 && d <= len) out.push(d);
    }
  } else if (r.BYDAY) {
    for (const spec of r.BYDAY.split(',')) {
      const mm = spec.match(/^([+-]?\d+)?([A-Z]{2})$/);
      if (!mm) continue;
      const wd = WD.indexOf(mm[2]);
      const all = [];
      for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d);
      if (!mm[1]) out.push(...all);
      else { const k = +mm[1]; const d = k > 0 ? all[k - 1] : all[all.length + k]; if (d) out.push(d); }
    }
  } else {
    // "every month" from the 31st lands on the last day of shorter months.
    out.push(Math.min(fallbackDay, len));
  }
  return out.sort((a, b) => a - b);
}

function nextDate(r, base, anchorDay) {
  const n = +(r.INTERVAL || 1);
  const byday = r.BYDAY ? r.BYDAY.split(',').map((d) => d.slice(-2)) : null;
  if (r.FREQ === 'DAILY') {
    if (!byday) return addDays(base, n);
    for (let k = 1; k <= 366 * 7; k++) { const d = addDays(base, k * n); if (byday.includes(WD[d.getUTCDay()])) return d; }
    return null;
  }
  if (r.FREQ === 'WEEKLY') {
    if (!byday) return addDays(base, 7 * n);
    const weekStart = (d) => addDays(d, -((d.getUTCDay() + 6) % 7)).getTime();
    for (let k = 1; k <= 7 * n + 7; k++) {
      const d = addDays(base, k);
      const weeks = Math.round((weekStart(d) - weekStart(base)) / (7 * 86400000));
      if (weeks % n === 0 && byday.includes(WD[d.getUTCDay()])) return d;
    }
    return null;
  }
  const y0 = base.getUTCFullYear(), m0 = base.getUTCMonth();
  if (r.FREQ === 'MONTHLY') {
    for (let k = 0; k <= 120; k++) {
      const mi = m0 + k * n, y = y0 + Math.floor(mi / 12), m = ((mi % 12) + 12) % 12;
      for (const d of monthDays(y, m, r, anchorDay)) { const c = new Date(Date.UTC(y, m, d)); if (c > base) return c; }
    }
    return null;
  }
  if (r.FREQ === 'YEARLY') {
    const months = r.BYMONTH ? r.BYMONTH.split(',').map((x) => +x - 1) : [m0];
    for (let k = 0; k <= 50; k++) {
      const y = y0 + k * n;
      for (const m of months) {
        const ds = r.BYMONTHDAY || r.BYDAY ? monthDays(y, m, r, anchorDay) : [Math.min(anchorDay, dim(y, m))];
        for (const d of ds) { const c = new Date(Date.UTC(y, m, d)); if (c > base) return c; }
      }
    }
  }
  return null;
}

/**
 * The occurrence after this one. `due` is "YYYY-MM-DD[ HH:MM]" or null; `doneDate` is the completion
 * date (used for "when done" rules, and when there's no due date). Returns { due, rule } with the
 * rule updated (COUNT counts down), or null when the series is over or the rule can't be computed.
 */
export function nextOccurrence(rule, { due = null, doneDate = null, today }) {
  const r = parseRRule(rule);
  if (!UNIT_OF[r.FREQ] || Object.keys(r).some((k) => !KNOWN.has(k))) return null;
  if (r.COUNT && +r.COUNT <= 1) return null;
  const time = due && due.includes(' ') ? due.slice(11) : null;
  const fromDone = r['X-WHEN'] === 'DONE' || !due;
  const baseStr = fromDone ? (doneDate || today) : due.slice(0, 10);
  const base = toD(baseStr);
  const next = nextDate(r, base, (due ? toD(due.slice(0, 10)) : base).getUTCDate());
  if (!next) return null;
  if (r.UNTIL && fromD(next).replace(/-/g, '') > r.UNTIL.slice(0, 8)) return null;
  if (r.COUNT) r.COUNT = String(+r.COUNT - 1);
  return { due: fromD(next) + (time ? ' ' + time : ''), rule: formatRRule(r) };
}
