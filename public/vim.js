// Vim mode for the editor (a plain <textarea>): normal, insert, visual (v / V) and replace (R) modes.
//
// Normal mode shows a block cursor by selecting the character under it. Edits go through
// hooks.replace(), which uses the browser's own editing commands, so u / Ctrl-R use the textarea's
// undo history and each command undoes in one step.
//
// Supported (with counts): h j k l w W b B e E ge gE 0 ^ $ g_ gg G { } % f F t T ; , + - _ <CR>
// n N * # / ? ' ` m · operators d c y > < g~ gu gU with any motion or text object (iw aw iW aW
// i" a" i' a' i` a` i( a( ib ab i[ a[ i{ a{ iB aB i< a< ip ap) and doubled (dd cc yy >> << g~~ guu gUU)
// x X s S D C Y p P J gJ r ~ u Ctrl-R . i a I A o O gi R v V gv o (in visual) Ctrl-A Ctrl-X
// Ctrl-D Ctrl-U Ctrl-F Ctrl-B Ctrl-E Ctrl-Y zz zt zb ZZ ZQ, registers ("a-"z, "0, "_ and "+ for
// the clipboard), and : commands (:w :q :wq :x :{line} :$ :s :%s :'<,'>s :d :y :sort :noh
// :set nu / nonu :e {note} :help).

const PENDING = Symbol('pending');
const WORDCH = /[\p{L}\p{N}_]/u;
const cls = (ch) => (ch === undefined ? -1 : /\s/.test(ch) ? 0 : WORDCH.test(ch) ? 1 : 2);
const bigCls = (ch) => (ch === undefined ? -1 : /\s/.test(ch) ? 0 : 1);
const PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
const OBJ_BRACKET = { '(': '(', ')': '(', b: '(', '[': '[', ']': '[', '{': '{', '}': '{', B: '{', '<': '<', '>': '<' };
// Ctrl keys Vim takes over in normal/visual mode; the rest (Ctrl+S, Ctrl+P, …) reach the app.
const VIM_CTRL = new Set(['<C-d>', '<C-u>', '<C-f>', '<C-b>', '<C-e>', '<C-y>', '<C-r>', '<C-a>', '<C-x>', '<C-[>', '<C-c>']);
const CHANGE_CMDS = new Set(['d', 'c', 'x', 'X', 's', 'S', 'D', 'C', 'p', 'P', 'J', 'r', '~', '>', '<', 'o', 'O', 'i', 'a', 'I', 'A', 'R', '<C-a>', '<C-x>', 'g']);

export function keyName(e) {
  const k = e.key;
  if (e.metaKey || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(k)) return null;
  const named = { Escape: 'Esc', Enter: 'CR', Backspace: 'BS', Tab: 'Tab', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Home: 'Home', End: 'End', Delete: 'Del', PageUp: 'PageUp', PageDown: 'PageDown' }[k];
  if (e.ctrlKey) return `<C-${named ? named.toLowerCase() : k.length === 1 ? k.toLowerCase() : k}>`;
  if (named) return `<${named}>`;
  return k.length === 1 ? k : null;
}

export class Vim {
  /**
   * hooks: replace(start, end, text) · save() · quit() · open(name) · help() · prompt(prefix) → Promise<string|null>
   *        onMode(label) · toast(msg) · caretTop(pos) → px from the top of the text · lineHeight() · setOption(name, value)
   */
  constructor(ta, hooks) {
    this.ta = ta; this.h = hooks;
    this.on = false; this.mode = 'normal';
    this.keys = []; this.want = null;
    this.reg = { '"': { text: '', linewise: false } };
    this.marks = {}; this.search = null; this.lastFind = null; this.lastVisual = null; this.lastChange = null;
    this.lastInsertAt = null; this.anchor = 0; this.head = 0;
    ta.addEventListener('keydown', (e) => this.onKey(e), true);
    ta.addEventListener('beforeinput', (e) => {
      if (this.on && !this.editing && this.mode !== 'insert' && this.mode !== 'replace') e.preventDefault();
    });
    ta.addEventListener('mouseup', () => this.onMouse());
    ta.addEventListener('focus', () => { if (this.on && this.mode === 'normal') setTimeout(() => this.onMouse(), 0); });
  }

  // ---------------------------------------------------------------- on / off
  enable() { this.on = true; this.toNormal(this.ta.selectionStart); }
  disable() {
    this.on = false; this.keys = [];
    const p = this.ta.selectionStart; this.ta.setSelectionRange(p, p);
    this.h.onMode('');
  }
  /** The editor got new text (another note opened): back to normal mode, cursor kept in range. */
  reset() { if (this.on) this.toNormal(Math.min(this.ta.selectionStart, this.v.length)); }

  get v() { return this.ta.value; }
  get pos() { return this.mode === 'visual' || this.mode === 'vline' ? this.head : this.ta.selectionStart; }

  // ---------------------------------------------------------------- positions
  ls(p) { return this.v.lastIndexOf('\n', p - 1) + 1; }
  le(p) { const e = this.v.indexOf('\n', p); return e < 0 ? this.v.length : e; }
  lastCh(p) { return Math.max(this.ls(p), this.le(p) - 1); }
  fnb(p) { const v = this.v; let i = this.ls(p); const e = this.le(p); while (i < e && (v[i] === ' ' || v[i] === '\t')) i++; return i; }
  lineNo(p) { let n = 0, i = -1; const v = this.v; while ((i = v.indexOf('\n', i + 1)) >= 0 && i < p) n++; return n; }
  lineCount() { let n = 1, i = -1; while ((i = this.v.indexOf('\n', i + 1)) >= 0) n++; return n; }
  lineAt(n) { const v = this.v; let p = 0; for (let k = 0; k < n; k++) { const i = v.indexOf('\n', p); if (i < 0) return p; p = i + 1; } return p; }
  col(p) { return p - this.ls(p); }
  /** Same column on another line (as far as that line goes), for j / k. */
  atCol(lineStart, col) { const e = this.le(lineStart); return Math.min(lineStart + col, Math.max(lineStart, e - 1)); }
  clampNormal(p) { p = Math.max(0, Math.min(p, this.v.length)); return Math.min(p, this.lastCh(p)); }

  // ---------------------------------------------------------------- display
  setBlock(p) {
    const v = this.v;
    p = this.clampNormal(p);
    const end = p < v.length && v[p] !== '\n' ? p + 1 : p;
    this.ta.setSelectionRange(p, end, 'forward');
    if (this.noScroll) this.noScroll = false; else this.scrollTo(p);
  }
  showVisual() {
    const a = Math.min(this.anchor, this.head), b = Math.max(this.anchor, this.head);
    if (this.mode === 'vline') this.ta.setSelectionRange(this.ls(a), this.le(b), this.head < this.anchor ? 'backward' : 'forward');
    else this.ta.setSelectionRange(a, Math.min(this.v.length, b + 1), this.head < this.anchor ? 'backward' : 'forward');
    this.scrollTo(this.head);
  }
  scrollTo(p) {
    const top = this.h.caretTop?.(p);
    if (top == null) return;
    const ta = this.ta, lh = this.h.lineHeight?.() || 24, pad = lh * 2;
    if (top < ta.scrollTop + pad) ta.scrollTop = Math.max(0, top - pad);
    else if (top + lh > ta.scrollTop + ta.clientHeight - pad) ta.scrollTop = top + lh - ta.clientHeight + pad;
  }
  label() {
    const pend = this.keys.join('');
    const m = { normal: 'NORMAL', insert: '-- INSERT --', visual: '-- VISUAL --', vline: '-- VISUAL LINE --', replace: '-- REPLACE --' }[this.mode];
    this.h.onMode(pend && this.mode !== 'insert' ? `${m}  ${pend}` : m);
  }

  // ---------------------------------------------------------------- modes
  toNormal(p) { this.mode = 'normal'; this.keys = []; this.setBlock(p); this.label(); }
  toInsert(p, { record = true } = {}) {
    this.mode = 'insert';
    this.ta.setSelectionRange(p, p);
    if (record && !this.replaying) this.ins = { start: p, after: this.v.length - p, before: this.v.slice(Math.max(0, p - 200), p) };
    this.label();
  }
  leaveInsert() {
    const p = this.ta.selectionStart;
    this.lastInsertAt = p;
    if (this.ins && this.lastChange && !this.replaying) {
      const end = this.v.length - this.ins.after;
      this.lastChange.insert = end >= this.ins.start ? this.v.slice(this.ins.start, end) : '';
    }
    this.ins = null;
    this.toNormal(p > this.ls(p) ? p - 1 : p);
  }
  onMouse() {
    if (!this.on || this.mode === 'insert' || this.mode === 'replace') return;
    const { selectionStart: s, selectionEnd: e } = this.ta;
    if (e - s > 1 && this.mode === 'normal') { this.mode = 'visual'; this.anchor = s; this.head = e - 1; this.showVisual(); this.label(); }
    else if (this.mode === 'normal') this.setBlock(s);
  }

  // ---------------------------------------------------------------- keys
  onKey(e) {
    if (!this.on || e.isComposing) return;
    const k = keyName(e);
    if (!k) return;
    if (this.mode === 'insert') {
      if (k === '<Esc>' || k === '<C-[>' || k === '<C-c>') { e.preventDefault(); e.stopImmediatePropagation(); this.leaveInsert(); }
      return; // everything else types as usual (lists continue on Enter, and so on)
    }
    if (this.mode === 'replace') {
      if (k === '<Esc>' || k === '<C-[>' || k === '<C-c>') { e.preventDefault(); e.stopImmediatePropagation(); this.leaveInsert(); return; }
      if (k.length === 1) {
        e.preventDefault(); e.stopImmediatePropagation();
        const p = this.ta.selectionStart, v = this.v;
        this.edit(p, p < v.length && v[p] !== '\n' ? p + 1 : p, k);
        this.ta.setSelectionRange(p + 1, p + 1);
      } else if (k === '<BS>') { e.preventDefault(); e.stopImmediatePropagation(); const p = Math.max(this.ls(this.ta.selectionStart), this.ta.selectionStart - 1); this.ta.setSelectionRange(p, p); }
      return;
    }
    if (e.ctrlKey && !VIM_CTRL.has(k)) return; // the app's own shortcuts (Ctrl+S, Ctrl+P, …)
    if (e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.feed(k);
  }

  feed(k) {
    if (this.mode === 'insert' || this.mode === 'replace') { if (k === '<Esc>' || k === '<C-[>' || k === '<C-c>') this.leaveInsert(); return; }
    this.keys.push(k);
    let r;
    try { r = this.run(this.keys); } catch (err) {
      if (err === PENDING) { this.label(); return; }
      this.keys = []; this.label(); this.h.toast?.(err.message || String(err)); return;
    }
    if (r === PENDING) { this.label(); return; }
    this.keys = [];
    if (this.mode === 'normal') this.setBlock(this.ta.selectionStart);
    this.label();
  }

  run(K) {
    let i = 0;
    const need = () => { if (i >= K.length) throw PENDING; return K[i++]; };
    const count = () => {
      let s = '';
      while (i < K.length && /[0-9]/.test(K[i]) && !(s === '' && K[i] === '0')) s += K[i++];
      if (i >= K.length && s) throw PENDING;
      return s ? Number(s) : 0;
    };
    let reg = null;
    if (K[0] === '"') { i = 1; reg = need(); }
    const n = count();
    const k = need();
    const visual = this.mode === 'visual' || this.mode === 'vline';
    const ctx = { K, n, reg, need, count, start: this.pos };
    const done = visual ? this.visualCmd(k, ctx) : this.normalCmd(k, ctx);
    if (done === false) { this.keys = []; return; }
    return done;
  }

  // ---------------------------------------------------------------- motions
  /** A motion from `p`. Returns { to, linewise, inclusive, word } or null if `k` isn't one. */
  motion(k, n, need, p, { forOp = false } = {}) {
    const v = this.v, N = v.length, c = n || 1;
    const lines = (d) => {
      const ln = this.lineNo(p), last = this.lineCount() - 1;
      const t = Math.max(0, Math.min(last, ln + d));
      if (this.want == null) this.want = this.col(p);
      return this.lineAt(t);
    };
    switch (k) {
      case 'h': case '<Left>': case '<BS>': return { to: Math.max(this.ls(p), p - c) };
      case 'l': case '<Right>': case ' ': return { to: Math.min(forOp ? this.le(p) : this.lastCh(p), p + c) };
      case 'j': case '<Down>': case '<C-n>': { const s = lines(c); return { to: this.atCol(s, this.want === Infinity ? 1e9 : this.want), linewise: true, keepWant: true }; }
      case 'k': case '<Up>': case '<C-p>': { const s = lines(-c); return { to: this.atCol(s, this.want === Infinity ? 1e9 : this.want), linewise: true, keepWant: true }; }
      case '+': case '<CR>': return { to: this.fnb(lines(c)), linewise: true };
      case '-': return { to: this.fnb(lines(-c)), linewise: true };
      case '_': return { to: this.fnb(lines(c - 1)), linewise: true };
      case '0': case '<Home>': return { to: this.ls(p) };
      case '^': return { to: this.fnb(p) };
      case '$': case '<End>': { const s = c > 1 ? lines(c - 1) : p; this.want = Infinity; return { to: forOp ? this.le(s) : this.lastCh(s), inclusive: !forOp, keepWant: true }; }
      case '|': return { to: Math.min(this.ls(p) + c - 1, this.lastCh(p)) };
      case 'w': case 'W': { let t = p; for (let x = 0; x < c; x++) t = this.wordStart(t, k === 'W'); return { to: t, word: true }; }
      case 'b': case 'B': { let t = p; for (let x = 0; x < c; x++) t = this.wordBack(t, k === 'B'); return { to: t }; }
      case 'e': case 'E': { let t = p; for (let x = 0; x < c; x++) t = this.wordEnd(t, k === 'E'); return { to: t, inclusive: true }; }
      case 'G': return { to: this.fnb(n ? this.lineAt(n - 1) : this.lineAt(this.lineCount() - 1)), linewise: true, jump: true };
      case '}': { let t = p; for (let x = 0; x < c; x++) t = this.para(t, 1); return { to: t, jump: true }; }
      case '{': { let t = p; for (let x = 0; x < c; x++) t = this.para(t, -1); return { to: t, jump: true }; }
      case '%': { const t = this.matchBracket(p); return t == null ? { to: p, fail: true } : { to: t, inclusive: true, jump: true }; }
      case 'f': case 'F': case 't': case 'T': {
        const ch = need();
        this.lastFind = { k, ch };
        return this.find(k, ch, c, p);
      }
      case ';': case ',': {
        if (!this.lastFind) return { to: p, fail: true };
        const flip = { f: 'F', F: 'f', t: 'T', T: 't' };
        const fk = k === ';' ? this.lastFind.k : flip[this.lastFind.k];
        return this.find(fk, this.lastFind.ch, c, p, true);
      }
      case 'n': case 'N': {
        if (!this.search) return { to: p, fail: true };
        const dir = (k === 'n') === (this.search.dir > 0) ? 1 : -1;
        let t = p;
        for (let x = 0; x < c; x++) { const f = this.findText(this.search.re, t, dir); if (f == null) return { to: p, fail: true, msg: `Pattern not found: ${this.search.src}` }; t = f; }
        return { to: t, jump: true };
      }
      case '*': case '#': {
        const w = this.wordUnder(p);
        if (!w) return { to: p, fail: true };
        this.search = { re: new RegExp(`(?<![\\p{L}\\p{N}_])${w.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu'), src: w.text, dir: k === '*' ? 1 : -1 };
        const t = this.findText(this.search.re, k === '*' ? w.end - 1 : w.start, this.search.dir);
        return { to: t ?? p, jump: true };
      }
      case "'": case '`': {
        const m = need();
        const at = m === "'" || m === '`' ? this.marks["'"] : this.marks[m];
        if (at == null) return { to: p, fail: true, msg: 'Mark not set' };
        const t = Math.min(at, N);
        return k === "'" ? { to: this.fnb(t), linewise: true, jump: true } : { to: t, jump: true };
      }
      case 'g': {
        const g = need();
        if (g === 'g') return { to: this.fnb(this.lineAt(n ? n - 1 : 0)), linewise: true, jump: true };
        if (g === 'e' || g === 'E') { let t = p; for (let x = 0; x < c; x++) t = this.wordEndBack(t, g === 'E'); return { to: t, inclusive: true }; }
        if (g === '_') { const s = c > 1 ? lines(c - 1) : p; let e = this.le(s) - 1; while (e > this.ls(s) && /[ \t]/.test(v[e])) e--; return { to: Math.max(this.ls(s), e), inclusive: true }; }
        if (g === 'j' || g === 'k') return this.motion(g, n, need, p, { forOp });
        if (g === '0') return { to: this.ls(p) };
        if (g === '$') return this.motion('$', n, need, p, { forOp });
        return null;
      }
      default: return null;
    }
  }

  find(k, ch, c, p, repeat = false) {
    const v = this.v, s = this.ls(p), e = this.le(p);
    let t = p;
    for (let x = 0; x < c; x++) {
      if (k === 'f' || k === 't') {
        let from = t + 1;
        if (k === 't' && repeat && x === 0 && v[t + 1] === ch) from = t + 2; // ; after t: don't stick before the same char
        const i = v.indexOf(ch, from);
        if (i < 0 || i >= e) return { to: p, fail: true };
        t = i;
      } else {
        let from = t - 1;
        if (k === 'T' && repeat && x === 0 && v[t - 1] === ch) from = t - 2;
        const i = from < 0 ? -1 : v.lastIndexOf(ch, from);
        if (i < s) return { to: p, fail: true };
        t = i;
      }
    }
    if (k === 't') t--;
    if (k === 'T') t++;
    return { to: t, inclusive: k === 'f' || k === 't' };
  }

  wordStart(p, big) {
    const v = this.v, n = v.length, c = big ? bigCls : cls;
    const t = c(v[p]);
    if (t > 0) while (p < n && c(v[p]) === t) p++;
    while (p < n && c(v[p]) === 0) { p++; if (v[p - 1] === '\n' && v[p] === '\n') return p; }
    return p;
  }
  wordEnd(p, big) {
    const v = this.v, n = v.length, c = big ? bigCls : cls;
    p++;
    while (p < n && c(v[p]) === 0) p++;
    const t = c(v[p]);
    while (p + 1 < n && c(v[p + 1]) === t) p++;
    return Math.min(p, Math.max(0, n - 1));
  }
  wordBack(p, big) {
    const v = this.v, c = big ? bigCls : cls;
    if (p <= 0) return 0;
    p--;
    while (p > 0 && c(v[p]) === 0) { if (v[p] === '\n' && v[p - 1] === '\n') return p; p--; }
    const t = c(v[p]);
    while (p > 0 && c(v[p - 1]) === t) p--;
    return p;
  }
  wordEndBack(p, big) {
    const v = this.v, c = big ? bigCls : cls;
    const t = c(v[p]);
    if (t > 0) while (p > 0 && c(v[p]) === t) p--;
    while (p > 0 && c(v[p]) === 0) p--;
    return p;
  }
  para(p, dir) {
    const blank = (ls) => this.le(ls) === ls || /^\s*$/.test(this.v.slice(ls, this.le(ls)));
    let ln = this.lineNo(p);
    const last = this.lineCount() - 1;
    if (blank(this.lineAt(ln))) ln += dir; // from a blank line, start with the next paragraph
    while (ln >= 0 && ln <= last && blank(this.lineAt(ln))) ln += dir;
    while (ln >= 0 && ln <= last && !blank(this.lineAt(ln))) ln += dir;
    if (ln < 0) return 0;
    if (ln > last) return this.v.length;
    return this.lineAt(ln);
  }
  matchBracket(p) {
    const v = this.v, e = this.le(p);
    let i = p;
    while (i < e && !'()[]{}'.includes(v[i])) i++;
    if (i >= e) return null;
    const open = '([{'.includes(v[i]);
    const a = v[i], b = open ? PAIRS[a] : Object.keys(PAIRS).find((x) => PAIRS[x] === a);
    let depth = 0;
    for (let j = i; open ? j < v.length : j >= 0; j += open ? 1 : -1) {
      if (v[j] === a) depth++;
      else if (v[j] === b && --depth === 0) return j;
    }
    return null;
  }
  wordUnder(p) {
    const v = this.v;
    let s = p;
    while (s < this.le(p) && cls(v[s]) !== 1) s++;
    if (cls(v[s]) !== 1) return null;
    let a = s, b = s;
    while (a > 0 && cls(v[a - 1]) === 1) a--;
    while (b < v.length && cls(v[b]) === 1) b++;
    return { start: a, end: b, text: v.slice(a, b) };
  }
  findText(re, from, dir) {
    const v = this.v;
    if (dir > 0) {
      re.lastIndex = from + 1;
      let m = re.exec(v);
      if (!m) { re.lastIndex = 0; m = re.exec(v); }
      return m ? m.index : null;
    }
    let last = null, lastAny = null;
    re.lastIndex = 0;
    for (let m; (m = re.exec(v));) {
      if (m.index < from) last = m.index;
      lastAny = m.index;
      if (m[0] === '') re.lastIndex++;
    }
    return last ?? lastAny;
  }

  // ---------------------------------------------------------------- text objects
  textObject(kind, ch, p) {
    const v = this.v;
    if (ch === 'w' || ch === 'W') {
      const c = ch === 'W' ? bigCls : cls;
      const t = c(v[p]);
      let a = p, b = p + 1;
      while (a > this.ls(p) && c(v[a - 1]) === t) a--;
      while (b < this.le(p) && c(v[b]) === t) b++;
      if (kind === 'a') {
        if (t !== 0 && b < this.le(p) && /[ \t]/.test(v[b])) { while (b < this.le(p) && /[ \t]/.test(v[b])) b++; }
        else if (t === 0) { const t2 = c(v[b]); while (b < this.le(p) && c(v[b]) === t2) b++; }
        else while (a > this.ls(p) && /[ \t]/.test(v[a - 1])) a--;
      }
      return { start: a, end: b };
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const s = this.ls(p), e = this.le(p), line = v.slice(s, e), col = p - s;
      const qs = [];
      for (let i = 0; i < line.length; i++) if (line[i] === ch && line[i - 1] !== '\\') qs.push(i);
      let pair = null;
      for (let i = 0; i + 1 < qs.length; i += 2) if (col >= qs[i] && col <= qs[i + 1]) { pair = [qs[i], qs[i + 1]]; break; }
      if (!pair) for (let i = 0; i + 1 < qs.length; i += 2) if (qs[i] > col) { pair = [qs[i], qs[i + 1]]; break; }
      if (!pair) return null;
      if (kind === 'i') return { start: s + pair[0] + 1, end: s + pair[1] };
      let b = s + pair[1] + 1;
      while (b < e && /[ \t]/.test(v[b])) b++;
      return { start: s + pair[0], end: b };
    }
    if (OBJ_BRACKET[ch]) {
      const open = OBJ_BRACKET[ch], close = PAIRS[open];
      let depth = 0, a = -1;
      for (let i = v[p] === close ? p - 1 : p; i >= 0; i--) {
        if (v[i] === close) depth++;
        else if (v[i] === open) { if (depth === 0) { a = i; break; } depth--; }
      }
      if (a < 0) return null;
      depth = 0;
      let b = -1;
      for (let i = a + 1; i < v.length; i++) {
        if (v[i] === open) depth++;
        else if (v[i] === close) { if (depth === 0) { b = i; break; } depth--; }
      }
      if (b < 0) return null;
      if (kind === 'a') return { start: a, end: b + 1 };
      let s = a + 1, e = b;
      if (v[s] === '\n') s++;
      if (this.ls(e) > s && /^\s*$/.test(v.slice(this.ls(e), e))) e = this.ls(e) - 1; // a block's own lines
      return { start: s, end: Math.max(s, e) };
    }
    if (ch === 'p') {
      const blank = (ls) => /^\s*$/.test(v.slice(ls, this.le(ls)));
      let ln = this.lineNo(p);
      const last = this.lineCount() - 1, isBlank = blank(this.lineAt(ln));
      let a = ln, b = ln;
      while (a > 0 && blank(this.lineAt(a - 1)) === isBlank) a--;
      while (b < last && blank(this.lineAt(b + 1)) === isBlank) b++;
      if (kind === 'a') while (b < last && blank(this.lineAt(b + 1)) !== isBlank) b++;
      return { start: this.lineAt(a), end: this.lineAt(b), linewise: true };
    }
    return null;
  }

  // ---------------------------------------------------------------- editing
  edit(start, end, text) {
    if (start === end && !text) return;
    this.editing = true;
    try { this.h.replace(start, end, text); } finally { this.editing = false; }
  }
  setReg(name, text, linewise, { yank = false } = {}) {
    if (name === '_') return;
    const r = { text, linewise };
    if (name && /[a-z]/.test(name)) this.reg[name] = r;
    else if (name && /[A-Z]/.test(name)) { const o = this.reg[name.toLowerCase()]; this.reg[name.toLowerCase()] = o ? { text: o.text + text, linewise: o.linewise || linewise } : r; }
    if (name === '+' || name === '*') navigator.clipboard?.writeText(text).catch(() => {});
    this.reg['"'] = r;
    if (yank) this.reg['0'] = r;
  }
  /** A register's contents; the clipboard ("+ and "*) is read asynchronously, so `then` gets it. */
  withReg(name, then) {
    if (name === '+' || name === '*') {
      navigator.clipboard.readText().then((t) => then({ text: t, linewise: t.endsWith('\n') }), () => then(this.reg['"']));
      return;
    }
    then(this.reg[(name || '"').toLowerCase()] || null);
  }
  /** Turn a motion or object range into the text span an operator works on. */
  span(start, end, linewise) {
    const v = this.v;
    if (linewise) {
      const a = this.ls(Math.min(start, end)), b = this.le(Math.max(start, end));
      return { s: a, e: b, linewise: true };
    }
    return { s: Math.min(start, end), e: Math.max(start, end), linewise: false, len: v.length };
  }
  operate(op, s, e, linewise, reg, times = 1) {
    const v = this.v;
    const lineText = () => v.slice(s, e) + '\n';
    switch (op) {
      case 'y': {
        this.setReg(reg, linewise ? lineText() : v.slice(s, e), linewise, { yank: true });
        return linewise ? null : s;
      }
      case 'd': {
        this.setReg(reg, linewise ? lineText() : v.slice(s, e), linewise);
        if (linewise) {
          let a = s, b = e + 1;
          if (b > v.length) { b = v.length; a = Math.max(0, s - 1); }
          this.edit(a, b, '');
          return this.fnb(Math.min(a === s ? a : this.ls(a), this.v.length));
        }
        this.edit(s, e, '');
        return s;
      }
      case 'c': {
        this.setReg(reg, linewise ? lineText() : v.slice(s, e), linewise);
        if (linewise) {
          const indent = v.slice(s, this.fnb(s));
          this.edit(s, e, indent);
          this.toInsert(s + indent.length);
        } else {
          this.edit(s, e, '');
          this.toInsert(s);
        }
        return 'insert';
      }
      case '>': case '<': {
        const a = this.ls(s), b = this.le(e);
        let out = v.slice(a, b);
        for (let x = 0; x < times; x++) out = out.split('\n').map((l) => (op === '>' ? (l.trim() ? '\t' + l : l) : l.replace(/^(\t| {1,4})/, ''))).join('\n');
        this.edit(a, b, out);
        return this.fnb(a);
      }
      case 'g~': case 'gu': case 'gU': {
        const t = v.slice(s, e);
        const out = op === 'gu' ? t.toLowerCase() : op === 'gU' ? t.toUpperCase() : [...t].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('');
        if (out !== t) this.edit(s, e, out);
        return s;
      }
      default: return null;
    }
  }

  // ---------------------------------------------------------------- normal mode
  normalCmd(k, ctx) {
    const { n, need, reg } = ctx;
    const p = this.ta.selectionStart, v = this.v, c = n || 1;
    const change = () => { if (!this.replaying) this.lastChange = { keys: [...ctx.K], insert: null }; };

    // Operators: d c y > < and g~ gu gU
    let op = ['d', 'c', 'y', '<', '>'].includes(k) ? k : null;
    if (k === 'g') {
      const g = need();
      if (g === '~' || g === 'u' || g === 'U') op = 'g' + g;
      else return this.gCmd(g, ctx, p);
    }
    if (op) return this.operatorCmd(op, ctx, p, change);

    const mv = this.motion(k, n, need, p);
    if (mv) {
      if (mv.msg) this.h.toast?.(mv.msg);
      if (mv.fail) return;
      if (mv.jump) this.marks["'"] = p;
      if (!mv.keepWant) this.want = null;
      this.ta.setSelectionRange(mv.to, mv.to);
      return;
    }

    switch (k) {
      case '<Esc>': case '<C-[>': case '<C-c>': return;
      case 'i': change(); return this.toInsert(p);
      case 'a': change(); return this.toInsert(v[p] === '\n' || p >= v.length ? p : p + 1);
      case 'I': change(); return this.toInsert(this.fnb(p));
      case 'A': change(); return this.toInsert(this.le(p));
      case 'o': case 'O': {
        change();
        const indent = v.slice(this.ls(p), this.fnb(p));
        if (k === 'o') { const e = this.le(p); this.edit(e, e, '\n' + indent); return this.toInsert(e + 1 + indent.length); }
        const s = this.ls(p); this.edit(s, s, indent + '\n'); return this.toInsert(s + indent.length);
      }
      case 'R': change(); this.mode = 'replace'; this.ta.setSelectionRange(p, p); this.ins = { start: p, after: v.length - p }; return;
      case 'v': case 'V':
        this.mode = k === 'v' ? 'visual' : 'vline'; this.anchor = p; this.head = p; this.showVisual(); return PENDING_OK;
      case 'x': case '<Del>': case 'X': case 's': case 'S': case 'D': case 'C': case 'Y': {
        const alias = { x: 'dl', '<Del>': 'dl', X: 'dh', s: 'cl', S: 'cc', D: 'd$', C: 'c$', Y: 'yy' }[k];
        if ((k === 'x' || k === '<Del>' || k === 's') && (v[p] === '\n' || p >= v.length) && k !== 's') return;
        return this.normalAlias(alias, ctx);
      }
      case 'p': case 'P': change(); return this.put(k, c, reg, p);
      case 'J': {
        change();
        const lines = Math.max(2, c);
        let s = this.le(p), out = p;
        for (let x = 1; x < lines; x++) {
          if (s >= this.v.length) break;
          let e = s + 1; while (e < this.v.length && /[ \t]/.test(this.v[e])) e++;
          const next = this.v[e];
          const sep = next === undefined || next === '\n' || next === ')' || /[ \t]$/.test(this.v.slice(this.ls(s), s)) ? '' : ' ';
          this.edit(s, e, sep);
          out = s; s = this.le(s + sep.length);
        }
        this.ta.setSelectionRange(out, out);
        return;
      }
      case 'r': {
        const ch = need();
        const e = this.le(p);
        if (p + c > e) return;
        change();
        const rep = ch === '<CR>' ? '\n' : ch.length === 1 ? ch.repeat(c) : null;
        if (rep == null) return;
        this.edit(p, p + c, rep);
        this.ta.setSelectionRange(ch === '<CR>' ? p + 1 : p + c - 1, ch === '<CR>' ? p + 1 : p + c - 1);
        return;
      }
      case '~': {
        change();
        const e = Math.min(this.le(p), p + c);
        const t = v.slice(p, e), out = [...t].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('');
        if (out !== t) this.edit(p, e, out);
        this.ta.setSelectionRange(Math.min(e, this.lastCh(p)), Math.min(e, this.lastCh(p)));
        return;
      }
      case 'u': case '<C-r>':
        this.editing = true;
        try { for (let x = 0; x < c; x++) document.execCommand(k === 'u' ? 'undo' : 'redo'); } finally { this.editing = false; }
        this.afterUndo();
        return;
      case '.': return this.repeat(n);
      case 'm': { const m = need(); if (/[a-zA-Z]/.test(m)) this.marks[m] = p; return; }
      case ':': this.ex(n ? `.,.+${n - 1}` : ''); return;
      case '/': case '?': this.searchPrompt(k); return;
      case 'z': {
        const z = need();
        const top = this.h.caretTop?.(p) ?? 0, ta = this.ta, lh = this.h.lineHeight?.() || 24;
        if (z === 'z' || z === '.') ta.scrollTop = Math.max(0, top - ta.clientHeight / 2 + lh / 2);
        else if (z === 't' || z === '<CR>') ta.scrollTop = Math.max(0, top - lh);
        else if (z === 'b' || z === '-') ta.scrollTop = Math.max(0, top - ta.clientHeight + lh * 2);
        this.ta.setSelectionRange(z === '<CR>' || z === '.' || z === '-' ? this.fnb(p) : p, z === '<CR>' || z === '.' || z === '-' ? this.fnb(p) : p);
        this.noScroll = true;
        return;
      }
      case 'Z': { const z = need(); if (z === 'Z') { this.h.save(); this.h.quit(); } else if (z === 'Q') this.h.quit(); return; }
      case '<C-d>': case '<C-u>': case '<C-f>': case '<C-b>': case '<PageDown>': case '<PageUp>': {
        const lh = this.h.lineHeight?.() || 24, page = Math.max(1, Math.floor(this.ta.clientHeight / lh));
        const half = k === '<C-d>' || k === '<C-u>';
        const d = (half ? Math.max(1, Math.floor(page / 2)) : Math.max(1, page - 2)) * (n || 1) * (k === '<C-u>' || k === '<C-b>' || k === '<PageUp>' ? -1 : 1);
        this.ta.scrollTop += d * lh;
        const ln = Math.max(0, Math.min(this.lineCount() - 1, this.lineNo(p) + d));
        const t = this.fnb(this.lineAt(ln));
        this.ta.setSelectionRange(t, t);
        return;
      }
      case '<C-e>': case '<C-y>': {
        const lh = this.h.lineHeight?.() || 24;
        this.ta.scrollTop += (k === '<C-e>' ? 1 : -1) * c * lh;
        this.noScroll = true;
        return;
      }
      case '<C-a>': case '<C-x>': {
        const s = this.ls(p), e = this.le(p), line = v.slice(s, e);
        const re = /-?\d+/g;
        let m;
        while ((m = re.exec(line))) if (s + m.index + m[0].length > p) break;
        if (!m) return;
        change();
        const num = String(Number(m[0]) + (k === '<C-a>' ? c : -c));
        this.edit(s + m.index, s + m.index + m[0].length, num);
        this.ta.setSelectionRange(s + m.index + num.length - 1, s + m.index + num.length - 1);
        return;
      }
      default: return;
    }
  }

  gCmd(g, ctx, p) {
    const v = this.v;
    switch (g) {
      case 'i': if (!this.replaying) this.lastChange = { keys: [...ctx.K], insert: null }; return this.toInsert(Math.min(this.lastInsertAt ?? p, v.length));
      case 'J': {
        if (!this.replaying) this.lastChange = { keys: [...ctx.K], insert: null };
        const s = this.le(p);
        if (s < v.length) this.edit(s, s + 1, '');
        this.ta.setSelectionRange(s, s);
        return;
      }
      case 'v': {
        if (!this.lastVisual) return;
        Object.assign(this, { mode: this.lastVisual.mode, anchor: this.lastVisual.anchor, head: this.lastVisual.head });
        this.showVisual();
        return PENDING_OK;
      }
      case 'p': case 'P': return this.put(g, ctx.n || 1, ctx.reg, p, { after: true });
      default: {
        const mv = this.motion('g', ctx.n, () => g, p);
        if (mv && !mv.fail) { if (!mv.keepWant) this.want = null; this.ta.setSelectionRange(mv.to, mv.to); }
      }
    }
  }

  normalAlias(seq, ctx) {
    // x = dl, D = d$ … run through the operator path with the same count and register.
    const K = [...(ctx.reg ? ['"', ctx.reg] : []), ...(ctx.n ? String(ctx.n).split('') : []), ...seq.split('')];
    const r = this.run(K);
    if (!this.replaying) this.lastChange = { keys: ctx.K.slice(), insert: null };
    return r;
  }

  operatorCmd(op, ctx, p, change) {
    const { n, need, count, reg } = ctx;
    const n2 = count();
    const c = (n || 1) * (n2 || 1);
    const mk = need();
    const g2 = mk === 'g' ? need() : null; // gg, ge … or the second half of g~g~ / gugu
    change();
    // Doubled: dd, cc, yy, >>, <<, g~~ / g~g~, guu, gUU — whole lines.
    const doubled = mk === op || (op.length === 2 && (mk === op[1] || g2 === op[1]));
    if (doubled) {
      const last = Math.min(this.lineCount() - 1, this.lineNo(p) + c - 1);
      const sp = this.span(p, this.lineAt(last), true);
      const r = this.operate(op, sp.s, sp.e, true, reg);
      if (r === 'insert') return;
      if (op === 'y') { if (c > 1) this.h.toast?.(`${c} lines yanked`); return; }
      if (r != null) this.ta.setSelectionRange(r, r);
      return;
    }
    // Text objects: iw, a(, ip …
    if (mk === 'i' || mk === 'a') {
      const ch = need();
      const o = this.textObject(mk, ch, p);
      if (!o) return;
      const r = this.operate(op, o.linewise ? this.ls(o.start) : o.start, o.linewise ? this.le(o.end) : o.end, !!o.linewise, reg);
      if (r !== 'insert' && r != null) this.ta.setSelectionRange(r, r);
      return;
    }
    let mv;
    // cw on a word acts like ce (Vim's special case).
    if (op === 'c' && (mk === 'w' || mk === 'W') && cls(this.v[p]) !== 0) {
      const big = mk === 'W', C = big ? bigCls : cls;
      let t = C(this.v[p + 1]) === C(this.v[p]) ? this.wordEnd(p, big) : p;
      for (let x = 1; x < c; x++) t = this.wordEnd(t, big);
      mv = { to: t, inclusive: true };
    } else {
      mv = this.motion(mk, c > 1 ? c : n2 || n, mk === 'g' ? () => g2 : need, p, { forOp: true });
    }
    if (!mv || mv.fail) { if (mv?.msg) this.h.toast?.(mv.msg); return; }
    let to = mv.to;
    // dw on the last word of a line stops at the end of that line.
    if (mv.word && this.lineNo(to) > this.lineNo(p) && p !== to) {
      to = this.le(p);
      if (to === p) to = mv.to; // already at the end: take the newline
    }
    const linewise = !!mv.linewise;
    const sp = this.span(p, mv.inclusive ? (to >= p ? to + 1 : to) : to, linewise);
    if (!linewise && mv.inclusive && to < p) sp.e = p + 1;
    const r = this.operate(op, sp.s, sp.e, linewise, reg);
    if (r !== 'insert' && r != null) this.ta.setSelectionRange(r, r);
  }

  put(k, c, reg, p, opts) { this.withReg(reg, (r) => this.putText(r, k, c, p, opts)); }
  putText(r, k, c, p, { after = false } = {}) {
    if (!r || !r.text) return;
    const v = this.v;
    if (r.linewise) {
      const body = r.text.endsWith('\n') ? r.text : r.text + '\n';
      const text = body.repeat(c);
      if (k === 'P') { const s = this.ls(p); this.edit(s, s, text); this.setBlock(after ? s + text.length : this.fnb(s)); }
      else {
        const e = this.le(p);
        const ins = '\n' + text.slice(0, -1);
        this.edit(e, e, ins);
        this.setBlock(after ? Math.min(this.v.length, e + ins.length + 1) : this.fnb(e + 1));
      }
    } else {
      const text = r.text.repeat(c);
      const at = k === 'p' && p < v.length && v[p] !== '\n' ? p + 1 : p;
      this.edit(at, at, text);
      this.setBlock(after ? at + text.length : at + text.length - 1);
    }
    this.label();
  }

  afterUndo() {
    const p = this.ta.selectionStart;
    this.ta.setSelectionRange(p, p);
  }

  repeat(n) {
    const lc = this.lastChange;
    if (!lc) return;
    if (lc.visual) { this.h.toast?.("A change made in visual mode can't be repeated with ."); return; }
    let keys = lc.keys;
    if (n) { // a new count replaces the old one
      let i = keys[0] === '"' ? 2 : 0;
      const head = keys.slice(0, i);
      while (/[0-9]/.test(keys[i] || '') && !(i === head.length && keys[i] === '0')) i++;
      keys = [...head, ...String(n).split(''), ...keys.slice(i)];
    }
    this.replaying = true;
    try {
      this.keys = [];
      try { this.run(keys); } catch (e) { if (e !== PENDING) throw e; return; }
      if ((this.mode === 'insert' || this.mode === 'replace') && lc.insert != null) {
        const p = this.ta.selectionStart;
        if (this.mode === 'replace') { const e = Math.min(this.le(p), p + lc.insert.length); this.edit(p, e, lc.insert); }
        else this.edit(p, p, lc.insert);
        const end = p + lc.insert.length;
        this.ta.setSelectionRange(end, end);
        this.mode = 'insert';
        this.leaveInsert();
      }
    } finally { this.replaying = false; }
  }

  // ---------------------------------------------------------------- visual mode
  visualCmd(k, ctx) {
    const { n, need, reg } = ctx;
    const v = this.v, c = n || 1;
    const a = Math.min(this.anchor, this.head), b = Math.max(this.anchor, this.head);
    const line = this.mode === 'vline';
    const range = () => (line ? { s: this.ls(a), e: this.le(b), linewise: true } : { s: a, e: Math.min(v.length, b + 1), linewise: false });
    const exit = (p) => { this.lastVisual = { mode: this.mode, anchor: this.anchor, head: this.head }; this.marks['<'] = a; this.marks['>'] = b; this.toNormal(p); };
    const change = () => { if (!this.replaying) this.lastChange = { keys: [...ctx.K], insert: null, visual: true }; };

    if (k === 'i' || k === 'a') {
      const o = this.textObject(k, need(), this.head);
      if (o) {
        if (o.linewise) { this.mode = 'vline'; this.anchor = o.start; this.head = this.le(o.end); }
        else { this.anchor = o.start; this.head = Math.max(o.start, o.end - 1); }
        this.showVisual();
      }
      return PENDING_OK;
    }
    const mv = this.motion(k, n, need, this.head);
    if (mv) {
      if (!mv.fail) { if (!mv.keepWant) this.want = null; this.head = Math.min(mv.to, Math.max(0, v.length - 1)); }
      this.showVisual();
      return PENDING_OK;
    }
    switch (k) {
      case '<Esc>': case '<C-[>': case '<C-c>': exit(this.head); return;
      case 'v': case 'V': {
        const want = k === 'v' ? 'visual' : 'vline';
        if (this.mode === want) { exit(this.head); return; }
        this.mode = want; this.showVisual(); return PENDING_OK;
      }
      case 'o': case 'O': [this.anchor, this.head] = [this.head, this.anchor]; this.showVisual(); return PENDING_OK;
      case 'd': case 'x': case '<Del>': case 'X': case 'D': case 'y': case 'Y': case 'c': case 's': case 'C': case 'S': case 'R': {
        const linewiseCmd = 'XDYCSR'.includes(k);
        const r = linewiseCmd ? { s: this.ls(a), e: this.le(b), linewise: true } : range();
        const op = 'dxX<Del>D'.includes(k) || k === '<Del>' ? 'd' : 'yY'.includes(k) ? 'y' : 'c';
        exit(a);
        if (op !== 'y') change();
        const res = this.operate(op, r.s, r.e, r.linewise, reg);
        if (res !== 'insert') this.setBlock(res ?? (r.linewise ? this.ls(r.s) : r.s));
        return;
      }
      case '>': case '<': { const r = range(); exit(a); change(); this.operate(k, r.s, r.e, true, reg, c); this.setBlock(this.fnb(this.ls(r.s))); return; }
      case '~': case 'u': case 'U': { const r = range(); exit(a); change(); this.operate(k === '~' ? 'g~' : k === 'u' ? 'gu' : 'gU', r.s, r.e, false, reg); this.setBlock(r.s); return; }
      case 'r': {
        const ch = need(); const r = range(); exit(a);
        if (ch.length !== 1) return;
        change();
        this.edit(r.s, r.e, v.slice(r.s, r.e).replace(/[^\n]/g, ch));
        this.setBlock(r.s);
        return;
      }
      case 'J': {
        const r = range(); exit(a); change();
        const lines = v.slice(this.ls(r.s), this.le(r.e - (r.linewise ? 0 : 1)));
        const joined = lines.split('\n').map((l, i) => (i ? l.trimStart() : l)).filter((l, i) => i === 0 || l).join(' ');
        this.edit(this.ls(r.s), this.ls(r.s) + lines.length, joined);
        return;
      }
      case 'p': case 'P': {
        const r = range(); exit(a);
        this.withReg(reg, (rg) => {
          if (!rg) return;
          const old = this.v.slice(r.s, r.e);
          let text = rg.text;
          if (r.linewise && !rg.linewise) text = text.replace(/\n$/, '');
          if (!r.linewise && rg.linewise) text = '\n' + text.replace(/\n$/, '') + '\n';
          if (r.linewise && rg.linewise) text = text.replace(/\n$/, '');
          this.edit(r.s, r.e, text);
          if (k === 'p') this.setReg(reg, old, r.linewise);
          this.setBlock(r.s);
          this.label();
        });
        return;
      }
      case ':': exit(a); this.ex("'<,'>"); return;
      case '*': case '#': return PENDING_OK;
      default: return PENDING_OK;
    }
  }

  // ---------------------------------------------------------------- / ? and :
  async searchPrompt(k) {
    const pat = await this.h.prompt(k);
    this.ta.focus();
    if (pat == null) return this.reset();
    const src = pat || this.search?.src;
    if (!src) return this.reset();
    this.search = { re: toRegex(src), src, dir: k === '/' ? 1 : -1 };
    const p = this.ta.selectionStart;
    const t = this.findText(this.search.re, p, this.search.dir);
    if (t == null) { this.h.toast?.(`Pattern not found: ${src}`); return this.reset(); }
    this.marks["'"] = p;
    this.toNormal(t);
  }

  async ex(prefill) {
    const cmd = await this.h.prompt(':', prefill);
    this.ta.focus();
    const p = this.ta.selectionStart;
    if (cmd == null) return this.toNormal(p);
    try { await this.runEx(cmd.trim(), p); } catch (e) { this.h.toast?.(e.message); }
    if (this.mode === 'normal') this.toNormal(this.ta.selectionStart);
  }

  /** Parse a :range (., $, %, 'a, '<,'>, numbers, +n / -n) into [first, last] line numbers. */
  parseRange(s, p) {
    const cur = this.lineNo(p), last = this.lineCount() - 1;
    let i = 0;
    const addr = () => {
      let base = null;
      const m = /^(\d+|\.|\$|'[a-z<>])/.exec(s.slice(i));
      if (m) {
        i += m[0].length;
        if (m[0] === '.') base = cur;
        else if (m[0] === '$') base = last;
        else if (m[0][0] === "'") { const at = this.marks[m[0][1]]; if (at == null) throw new Error('Mark not set'); base = this.lineNo(at); }
        else base = Number(m[0]) - 1;
      }
      const off = /^([+-]\d*)/.exec(s.slice(i));
      if (off) { i += off[0].length; base = (base ?? cur) + (off[0].length === 1 ? (off[0] === '+' ? 1 : -1) : Number(off[0])); }
      return base;
    };
    if (s[0] === '%') return { from: 0, to: last, rest: s.slice(1), given: true };
    const a = addr();
    let b = a;
    if (s[i] === ',') { i++; b = addr(); }
    const clamp = (x) => Math.max(0, Math.min(last, x));
    return { from: clamp(a ?? cur), to: clamp(b ?? a ?? cur), rest: s.slice(i), given: a != null };
  }

  async runEx(cmd, p) {
    if (!cmd) return;
    const { from, to, rest, given } = this.parseRange(cmd, p);
    const c = rest.trim();
    const lineRange = () => ({ s: this.lineAt(Math.min(from, to)), e: this.le(this.lineAt(Math.max(from, to))) });
    if (!c && given) { this.marks["'"] = p; this.toNormal(this.fnb(this.lineAt(to))); return; }
    let m;
    if ((m = /^s(?:ubstitute)?([^\w\s])(.*)$/.exec(c))) return this.substitute(m[1], m[2], given ? lineRange() : { s: this.ls(p), e: this.le(p) });
    if (/^(w|write)!?$/.test(c)) return this.h.save();
    if (/^(wq|x|xit|exit|wq!|x!)$/.test(c)) { await this.h.save(); return this.h.quit(); }
    if (/^(q|quit|q!|quit!|close)$/.test(c)) return this.h.quit();
    if (/^(noh|nohlsearch)$/.test(c)) { this.search = null; return; }
    if (/^(d|delete)$/.test(c)) { const r = lineRange(); this.operate('d', r.s, r.e, true, null); return; }
    if (/^(y|yank)$/.test(c)) { const r = lineRange(); this.operate('y', r.s, r.e, true, null); return; }
    if ((m = /^sort(!)?\s*(i)?$/.exec(c))) {
      const r = given ? lineRange() : { s: 0, e: this.v.length };
      const lines = this.v.slice(r.s, r.e).split('\n');
      const cmp = m[2] ? (x, y) => x.toLowerCase().localeCompare(y.toLowerCase()) : (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      lines.sort(cmp); if (m[1]) lines.reverse();
      this.edit(r.s, r.e, lines.join('\n'));
      return;
    }
    if ((m = /^set?\s+(no)?(nu|number|rnu|relativenumber)$/.exec(c))) return this.h.setOption?.('number', !m[1]);
    if ((m = /^(e|edit|o|open)\s+(.+)$/.exec(c))) return this.h.open?.(m[2].trim());
    if (/^h(elp)?$/.test(c)) return this.h.help?.();
    if (/^\d+$/.test(c)) { this.toNormal(this.fnb(this.lineAt(Number(c) - 1))); return; }
    throw new Error(`Not an editor command: ${c}`);
  }

  substitute(delim, body, { s, e }) {
    // pattern / replacement / flags, with \<delim> escapes
    const parts = [];
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && body[i + 1] === delim) { cur += delim; i++; }
      else if (body[i] === delim && parts.length < 2) { parts.push(cur); cur = ''; }
      else cur += body[i];
    }
    parts.push(cur);
    const [pat, rep = '', flags = ''] = parts;
    const src = pat || this.search?.src;
    if (!src) throw new Error('No previous search pattern');
    const re = toRegex(src, flags.includes('g') ? 'g' : '', flags.includes('i'));
    this.search = { re: toRegex(src), src, dir: 1 };
    // Vim's replacement: \1 … \9, & (whole match), \& (a literal &), \n (new line), \t
    const jsRep = rep.replace(/\\(\d)|\\&|&|\\n|\\t|\$/g, (x, d) => (d ? `$${d}` : x === '\\&' ? '&' : x === '&' ? '$&' : x === '\\n' ? '\n' : x === '\\t' ? '\t' : '$$'));
    const block = this.v.slice(s, e);
    let hits = 0;
    const out = block.split('\n').map((l) => { re.lastIndex = 0; if (!re.test(l)) return l; hits++; re.lastIndex = 0; return l.replace(re, jsRep); }).join('\n');
    if (!hits) throw new Error(`Pattern not found: ${src}`);
    this.edit(s, e, out);
    this.toNormal(this.fnb(Math.min(s, this.v.length)));
    if (hits > 1) this.h.toast?.(`${hits} lines changed`);
  }
}

// Returned by commands that stay in visual mode (the cursor shouldn't become a block yet).
const PENDING_OK = undefined;

/** A Vim-ish search pattern as a RegExp: \c ignores case, \< \> are word edges; invalid ones are taken literally. */
function toRegex(src, extra = 'g', ignore = false) {
  let s = src, flags = extra.includes('g') ? 'g' : '';
  if (/\\c/.test(s)) { s = s.replace(/\\c/g, ''); ignore = true; }
  if (/\\C/.test(s)) s = s.replace(/\\C/g, '');
  s = s.replace(/\\</g, '\\b').replace(/\\>/g, '\\b');
  if (ignore) flags += 'i';
  try { return new RegExp(s, flags); } catch { return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
}
