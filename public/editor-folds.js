// Folding headings in the source editor (see shared/folds.js for how the text is folded).
//
// The textarea shows the folded "display" text. This file overrides value, the selection and
// setRangeText on that one textarea so they speak the real text: the rest of the app (saving, sync,
// live collaboration, task clicks, Vim) reads and edits the real text and never sees a fold line.
// With nothing folded every call goes straight to the textarea, so nothing changes.
//
// Typing on a fold line (or deleting into it) opens the fold instead, and so does putting the caret
// inside folded text from code (a search result, a link to a line).

import { collapse, expand, layout, toReal, toDisplay, sections, headingKey } from './shared/folds.js';

const P = HTMLTextAreaElement.prototype;
const VALUE = Object.getOwnPropertyDescriptor(P, 'value');
const START = Object.getOwnPropertyDescriptor(P, 'selectionStart');
const END = Object.getOwnPropertyDescriptor(P, 'selectionEnd');

/**
 * ta: the editor. store: { get(key, def), set(key, v), del(key) }. path(): the open note.
 * onChange(): a fold opened or closed (redraw the gutter and the like).
 */
export function installFolds(ta, { store, path, onChange = () => {} }) {
  const raw = { get: () => VALUE.get.call(ta), set: (v) => VALUE.set.call(ta, v), start: () => START.get.call(ta), end: () => END.get.call(ta) };
  const known = new Map(); // fold line → hidden text, for this note (kept so undo can bring a fold line back)
  let id = 0;
  const nextId = () => ++id;
  let keys = new Set(), forPath = null;
  let cache = { display: null, segs: null, real: null, folded: null, damaged: null };

  const storeKey = (p) => 'efold:' + p;
  const loadKeys = () => {
    if (path() === forPath) return;
    forPath = path();
    known.clear();
    keys = new Set(forPath ? store.get(storeKey(forPath), []) : []);
  };
  const saveKeys = () => { if (!forPath) return; if (keys.size) store.set(storeKey(forPath), [...keys]); else store.del(storeKey(forPath)); };

  const state = () => {
    const display = raw.get();
    if (cache.display !== display) {
      const x = expand(display, known);
      cache = { display, segs: x.segs, real: x.real, folded: x.keys, damaged: x.damaged };
    }
    return cache;
  };
  const active = () => known.size > 0 && state().folded.size > 0;

  /** Show `real` folded as `keys` says, keeping the caret and scroll where they were in the real text. */
  function redraw(real, selA, selB, dir) {
    const top = ta.scrollTop;
    raw.set(collapse(real, keys, known, nextId));
    const { segs } = state();
    const a = toDisplay(segs, selA).pos, b = toDisplay(segs, selB).pos;
    P.setSelectionRange.call(ta, a, Math.max(a, b), dir);
    ta.scrollTop = top;
  }
  function refold(after) {
    const real = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    after();
    saveKeys();
    redraw(real, a, b);
    onChange();
  }
  /** Open the fold that `seg` (a fold line's segment) stands for, and any folds whose text it overlaps. */
  const openSeg = (seg) => refold(() => { if (seg.key) keys.delete(seg.key); });

  Object.defineProperty(ta, 'value', {
    configurable: true,
    get() { return active() ? state().real : raw.get(); },
    set(v) {
      loadKeys();
      v = String(v ?? '');
      if (!keys.size) { raw.set(v); return; }
      raw.set(collapse(v, keys, known, nextId));
      Promise.resolve().then(onChange);
    },
  });
  Object.defineProperty(ta, 'selectionStart', {
    configurable: true,
    get() { return active() ? toReal(state().segs, raw.start()) : raw.start(); },
    set(v) { ta.setSelectionRange(v, Math.max(v, ta.selectionEnd)); },
  });
  Object.defineProperty(ta, 'selectionEnd', {
    configurable: true,
    get() { return active() ? toReal(state().segs, raw.end(), true) : raw.end(); },
    set(v) { ta.setSelectionRange(Math.min(ta.selectionStart, v), v); },
  });
  ta.setSelectionRange = function (a, b, dir) {
    if (!active()) return P.setSelectionRange.call(ta, a, b, dir);
    let { segs } = state();
    let da = toDisplay(segs, a);
    // Vim's block cursor covers one character: on a fold line that's the fold's first character.
    let db = toDisplay(segs, b);
    if (db.fold && !da.fold && b - a <= 1) db = { pos: da.pos + 1, fold: null };
    if (da.fold || db.fold) {
      for (const s of [da.fold, db.fold]) if (s?.key) keys.delete(s.key);
      saveKeys();
      redraw(state().real, a, b, dir);
      onChange();
      ({ segs } = state());
      da = toDisplay(segs, a); db = toDisplay(segs, b);
    }
    P.setSelectionRange.call(ta, da.pos, Math.max(da.pos, db.pos), dir);
  };
  ta.setRangeText = function (text, start, end, mode = 'preserve') {
    if (!active()) return start === undefined ? P.setRangeText.call(ta, text) : P.setRangeText.call(ta, text, start, end, mode);
    const real = state().real;
    const selA = ta.selectionStart, selB = ta.selectionEnd;
    if (start === undefined) { start = selA; end = selB; mode = 'preserve'; }
    const { segs } = state();
    const ds = toDisplay(segs, start), de = toDisplay(segs, end);
    if (!ds.fold && !de.fold) return P.setRangeText.call(ta, text, ds.pos, de.pos, mode);
    // The change reaches into folded text (sync or a collaborator): change it there, keep it folded.
    const next = real.slice(0, start) + text + real.slice(end);
    const shift = (p) => (p <= start ? p : p >= end ? p + text.length - (end - start) : start);
    let a, b;
    if (mode === 'select') { a = start; b = start + text.length; }
    else if (mode === 'start') a = b = start;
    else if (mode === 'end') a = b = start + text.length;
    else { a = shift(selA); b = shift(selB); }
    redraw(next, a, b);
  };

  /** The fold line the display selection touches, if an edit there would damage it. */
  function touchedFold(inputType) {
    const { segs } = state();
    const s = raw.start(), e = raw.end();
    for (const g of segs) {
      if (!g.fold) continue;
      const ls = g.d, le = g.d + g.dl;
      if (e < ls - 1 || s > le + 1) continue;
      const whole = (s <= ls && e >= le + 1) || (s <= ls - 1 && e >= le); // the whole line goes, with a line break
      if (s !== e && whole) continue;
      if (s === e) {
        if (s === le + 1 && !/^delete.*Backward/.test(inputType)) continue; // typing at the start of the next line
        if (s === ls - 1 && !/^delete.*Forward/.test(inputType)) continue; // typing at the end of the heading
        if (s === le && inputType === 'insertLineBreak') continue; // Enter at the end of a fold line: a new line after the section
      }
      return g;
    }
    return null;
  }
  let before = null;
  ta.addEventListener('beforeinput', (e) => {
    if (!active() || /^history/.test(e.inputType)) { before = null; return; }
    const g = touchedFold(e.inputType);
    if (g) { e.preventDefault(); e.stopImmediatePropagation(); openSeg(g); return; }
    before = { display: raw.get(), a: raw.start(), b: raw.end() };
  }, true);
  // A backstop for edits that get past beforeinput: a damaged fold line is put back, then opened.
  ta.addEventListener('input', (e) => {
    const st = state();
    if (st.damaged.length && before && known.size) {
      e.stopImmediatePropagation();
      raw.set(before.display);
      P.setSelectionRange.call(ta, before.a, before.b);
      const g = state().segs.find((s) => s.fold && raw.end() >= s.d - 1 && raw.start() <= s.d + s.dl + 1);
      if (g) openSeg(g);
      return;
    }
    // Keep the fold list in step with the fold lines (a renamed heading, undo, a fold deleted whole).
    if (known.size && forPath) {
      const now = st.folded;
      if (now.size !== keys.size || [...now].some((k) => !keys.has(k))) { keys = new Set(now); saveKeys(); onChange(); }
    }
  }, true);
  // Copy and cut take the real text, not the fold line.
  const clip = (e, cut) => {
    if (!active()) return;
    const s = raw.start(), en = raw.end();
    if (s === en || !state().segs.some((g) => g.fold && g.d < en && g.d + g.dl > s)) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', state().real.slice(ta.selectionStart, ta.selectionEnd));
    if (cut) document.execCommand('delete');
  };
  ta.addEventListener('copy', (e) => clip(e, false));
  ta.addEventListener('cut', (e) => clip(e, true));
  // A click on a fold line opens it.
  ta.addEventListener('click', () => {
    if (!active() || raw.start() !== raw.end()) return;
    const p = raw.start();
    const g = state().segs.find((s) => s.fold && p >= s.d && p <= s.d + s.dl);
    if (g) openSeg(g);
  });

  const api = {
    /** The text as shown, and a real position in it (inside a fold: the fold line). For measuring. */
    display: () => raw.get(),
    displayPos: (p) => (active() ? toDisplay(state().segs, p).pos : p),
    /** The caret's line in the display text (for the gutter's current-line mark). */
    displayLine: () => raw.get().slice(0, raw.start()).split('\n').length - 1,
    /**
     * Per display line: { n: real line number, fold: 'open' | 'closed' | null, key, lines (hidden) }.
     * Only headings with something under them can fold.
     */
    lines() {
      loadKeys();
      const { segs } = state();
      const real = active() ? state().real : raw.get();
      const foldable = new Set(sections(real.split('\n')).map((s) => s.key));
      let n = 0;
      return segs.map((s, i) => {
        const out = { n, fold: null, key: null, lines: 0 };
        if (s.fold) { out.fold = 'hidden'; out.lines = s.rlines; n += s.rlines; return out; }
        if (s.heading && foldable.has(s.heading)) {
          out.key = s.heading;
          out.fold = segs[i + 1]?.fold ? 'closed' : 'open';
        }
        n++;
        return out;
      });
    },
    toggle(key) { loadKeys(); refold(() => { if (keys.has(key)) keys.delete(key); else keys.add(key); }); },
    /** Whether real position `p` is the start of a folded section (Vim puts its cursor there). */
    foldedAt(p) { return active() && state().segs.some((s) => s.fold && s.r === p); },
    /** If the real range a…b reaches into folded text, open those folds and say so. */
    touches(a, b) {
      if (!active()) return false;
      const { segs } = state();
      const hit = [toDisplay(segs, a).fold, toDisplay(segs, b).fold, ...segs.filter((s) => s.fold && s.r >= a && s.r + s.rl <= b && a < b && b - a < s.rl)];
      const open = hit.filter(Boolean);
      if (!open.length) return false;
      refold(() => { for (const s of open) if (s.key) keys.delete(s.key); });
      return true;
    },
    /** Fold or open the section the caret is in (its nearest heading above). */
    atCaret(want) {
      loadKeys();
      const g = active() && state().segs.find((s) => s.fold && raw.start() >= s.d && raw.start() <= s.d + s.dl);
      if (g) { if (want !== true) openSeg(g); return true; }
      const real = ta.value, ln = real.slice(0, ta.selectionStart).split('\n').length - 1;
      const secs = sections(real.split('\n')).filter((s) => s.line <= ln && (s.end > ln || s.line === ln));
      const s = secs[secs.length - 1];
      if (!s) return false;
      const folded = keys.has(s.key);
      if (want === undefined ? true : want !== folded) {
        refold(() => { if (folded) keys.delete(s.key); else keys.add(s.key); });
        if (!folded) { const d = toDisplay(state().segs, real.split('\n').slice(0, s.line).join('\n').length + (s.line ? 1 : 0)).pos; P.setSelectionRange.call(ta, d, d); }
      }
      return true;
    },
    all(fold) {
      loadKeys();
      refold(() => { keys = fold ? new Set(sections(ta.value.split('\n')).map((s) => s.key)) : new Set(); });
    },
    /** Vim's j / k: the next line from real line `ln`, a whole fold counting as one line. */
    step(ln, d) {
      if (!active()) return ln + d;
      const L = api.lines();
      let i = L.findIndex((x, k) => x.n <= ln && (L[k + 1]?.n ?? Infinity) > ln);
      i = Math.max(0, Math.min(L.length - 1, i + d));
      return L[i].n;
    },
    has: (key) => keys.has(key),
    key: headingKey,
  };
  ta.folds = api;
  return api;
}

export { layout };
