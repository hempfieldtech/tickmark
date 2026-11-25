// Folding headings in the source editor, which is a plain textarea and can't hide lines.
//
// A folded heading's section (the lines under it, up to the next heading of the same or a higher
// level) is swapped for one line, "⋯ 12 lines", that ends in an invisible id. The textarea shows
// that "display" text; the real text is the display text with each of those lines put back.
// Everything here is plain text in, plain text out, so it can be tested without a browser.

const BIT = ['​', '‌']; // zero-width space / non-joiner: the id, in binary
const END = '⁠'; // word joiner: ends every fold line, and marks a damaged one

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;

/** What a heading is known by, so a fold survives edits elsewhere: its words, any level, any case. */
export const headingKey = (text) => text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+/g, ' ').trim().toLowerCase();

/**
 * The foldable headings in `lines`: [{ line, level, key, end }], where the section's hidden lines are
 * line+1 … end-1. Headings in code blocks and frontmatter don't count, and blank lines at the end of a
 * section stay visible (so the gap before the next heading does too). Headings with nothing under
 * them aren't listed.
 */
export function sections(lines) {
  const heads = [];
  let fence = null, i = 0;
  if (lines[0] === '---') { // frontmatter
    const close = lines.findIndex((l, k) => k > 0 && (l === '---' || l === '...'));
    if (close > 0) i = close + 1;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.slice(f[0].length).trim()) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = HEADING.exec(l);
    if (h) heads.push({ line: i, level: h[1].length, key: headingKey(h[2]) });
  }
  const out = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].line; break; }
    while (end > h.line + 1 && !lines[end - 1].trim()) end--;
    if (end > h.line + 1) out.push({ ...h, end });
  }
  return out;
}

const encode = (id) => id.toString(2).split('').map((b) => BIT[b]).join('');
const markerText = (n, id) => `⋯ ${n} line${n === 1 ? '' : 's'}${encode(id)}${END}`;
export const isDamaged = (line) => line.includes(END);

/**
 * Fold `real` at the headings whose keys are in `keys`. `known` (a Map of fold line → hidden text)
 * gets every fold line made here; `nextId` gives fresh ids. Returns the display text.
 * A folded heading inside a folded section just goes with it.
 */
export function collapse(real, keys, known, nextId) {
  if (!keys.size) return real;
  const lines = real.split('\n');
  const out = [];
  let i = 0;
  for (const s of sections(lines)) {
    if (s.line < i || !keys.has(s.key)) continue; // inside a fold already, or open
    for (; i <= s.line; i++) out.push(lines[i]);
    const hidden = lines.slice(s.line + 1, s.end).join('\n');
    const m = markerText(s.end - s.line - 1, nextId());
    known.set(m, hidden);
    out.push(m);
    i = s.end;
  }
  for (; i < lines.length; i++) out.push(lines[i]);
  return out.join('\n');
}

/**
 * The display text's layout: per display line, where it starts in both texts and how long it is,
 * and, for fold lines, the heading key it folds. Lines that aren't known fold lines are themselves.
 */
export function layout(display, known) {
  const segs = [];
  let d = 0, r = 0, prev = null;
  for (const line of display.split('\n')) {
    const hidden = known.get(line);
    const fold = hidden !== undefined;
    const h = !fold && HEADING.exec(line);
    const real = fold ? hidden : line;
    segs.push({ d, r, dl: line.length, rl: real.length, fold, key: fold && prev ? prev : null, hidden: fold ? hidden : null,
      heading: h ? headingKey(h[2]) : null, rlines: fold ? hidden.split('\n').length : 1 });
    prev = h ? headingKey(h[2]) : null;
    d += line.length + 1; r += real.length + 1;
  }
  return segs;
}

/** The real text behind a display text, and which headings are folded in it (by their fold lines). */
export function expand(display, known) {
  const segs = layout(display, known);
  const lines = display.split('\n');
  const keys = new Set();
  const damaged = [];
  segs.forEach((s, i) => {
    if (s.fold) { lines[i] = s.hidden; if (s.key) keys.add(s.key); }
    else if (isDamaged(lines[i])) damaged.push(i);
  });
  return { real: lines.join('\n'), keys, damaged, segs };
}

const segAt = (segs, pos, from, len) => {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m][from] <= pos) lo = m; else hi = m - 1; }
  return segs[lo];
};

/** A display position in the real text. Inside a fold line it's the fold's start (or end, for `end`). */
export function toReal(segs, pos, end = false) {
  const s = segAt(segs, pos, 'd');
  const off = Math.min(pos - s.d, s.dl);
  if (!s.fold) return s.r + off;
  return off >= s.dl || (end && off > 0) ? s.r + s.rl : s.r;
}

/**
 * A real position in the display text: { pos, fold }. A position inside hidden text has no place in
 * the display text: `fold` is then that fold's segment and `pos` its fold line's start.
 */
export function toDisplay(segs, pos) {
  const s = segAt(segs, pos, 'r');
  const off = pos - s.r;
  if (!s.fold) return { pos: s.d + Math.min(off, s.dl), fold: null };
  if (off <= 0) return { pos: s.d, fold: null };
  if (off >= s.rl) return { pos: s.d + s.dl, fold: null };
  return { pos: s.d, fold: s };
}
