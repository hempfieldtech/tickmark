import { marked } from './vendor/marked.esm.js';
import { checkboxLines, toggleLine, setTaskState, fileCompleted, openSubtasks, parseTasks, normTag, localDate } from './shared/tasks.js';
import { parseRecurrence, describeRecurrence } from './shared/recur.js';
import { textStats } from './shared/words.js';

// ---------------------------------------------------------------- utilities
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// Per-user keys (notes cache, unsaved edits, settings) are namespaced by the signed-in user, so two
// people sharing a browser never see, or save into, each other's notes. View prefs are per device.
const DEVICE_KEYS = new Set(['view', 'noSidebar']);
const store = {
  user: '',
  key(k) { return 'tickmark:' + (this.user && !DEVICE_KEYS.has(k) ? `u:${this.user}:` : '') + k; },
  get(k, d = null) { try { const v = localStorage.getItem(this.key(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(this.key(k)); } catch {} },
};
const basename = (p) => p.split('/').pop().replace(/\.md$/i, '');
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const mobile = matchMedia('(max-width: 760px)');

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me?.mode === 'multi' && !url.startsWith('/api/auth/')) showLogin('Your session ended. Please sign in again.');
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
  return data;
}

const el = {
  app: $('#app'), tree: $('#tree'), results: $('#search-results'), search: $('#search'),
  editor: $('#editor'), preview: $('#preview'), previewWrap: $('#preview-wrap'), backlinks: $('#backlinks'), wordCount: $('#word-count'),
  empty: $('#empty'), title: $('#title'), crumbs: $('#crumbs'), saveState: $('#save-state'),
  sync: $('#btn-sync'), menu: $('#menu'), toast: $('#toast'),
};

const S = {
  config: store.get('config'),
  files: [], folders: [], inbox: 'Inbox.md',
  path: null, base: '', hash: null,
  saving: null, saveAgain: false,
  view: store.get('view', 'split'),
  mode: 'empty', // empty | note
  openFolders: new Set(store.get('openFolders', [])),
  sync: { state: 'idle' },
  lastSyncAt: 0,
  me: null, // { mode: 'single' } or { mode: 'multi', user, localLogin, sso }
};
const tagOpts = () => ({ itemTags: S.config?.itemTags || ['task'], sectionTags: S.config?.sectionTags || ['sync'] });
const syncConfigured = () => !!S.config?.accounts?.some((a) => a.url && a.calendarUrl);

function toast(msg, action) {
  el.toast.innerHTML = esc(msg) + (action ? ` <button>${esc(action.label)}</button>` : '');
  if (action) el.toast.querySelector('button').onclick = () => { el.toast.classList.remove('show'); action.run(); };
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), action ? 7000 : 3200);
}

function showMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  el.menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { hideMenu(); it.run(); };
    el.menu.append(b);
  }
  el.menu.hidden = false;
  const mw = el.menu.offsetWidth, mh = el.menu.offsetHeight;
  el.menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  el.menu.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
}
const hideMenu = () => { el.menu.hidden = true; };
document.addEventListener('pointerdown', (e) => { if (!el.menu.hidden && !el.menu.contains(e.target)) hideMenu(); });

function ask(label, value = '') {
  const dlg = $('#dlg-prompt'), input = $('#prompt-input');
  $('#prompt-label span').textContent = label;
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((res) => { dlg.onclose = () => res(dlg.returnValue === 'ok' ? input.value.trim() : null); });
}
document.querySelectorAll('dialog [data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close('cancel')));

// ---------------------------------------------------------------- markdown rendering
let cbIndex = 0;
const today = () => localDate(new Date());
function fmtDue(date, time) {
  const d = new Date(date + 'T00:00');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return time ? `${label} ${time}` : label;
}
const dueClass = (date) => (date < today() ? 'overdue' : date === today() ? 'today' : '');
const safeUrl = (u) => !/^\s*(javascript|vbscript|data):/i.test(u || '');

marked.use({
  gfm: true,
  renderer: {
    checkbox({ checked }) { return `<input type="checkbox" class="task-cb" data-i="${cbIndex++}"${checked ? ' checked' : ''}>`; },
    // Raw HTML is shown as text: note content (including task titles synced in from CalDAV) is never executed.
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!safeUrl(href)) return text;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (!safeUrl(href)) return esc(text);
      return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`;
    },
  },
  extensions: [
    {
      name: 'wikilink', level: 'inline',
      start(src) { const i = src.search(/!?\[\[/); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(src);
        if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
      },
      renderer(t) { return `<a href="#" class="wikilink" data-target="${esc(t.target)}">${esc(t.label)}</a>`; },
    },
    {
      name: 'tag', level: 'inline',
      start(src) { const m = /(^|[\s(])#[\p{L}\p{N}_/-]*[\p{L}_/-]/u.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) {
        const m = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u.exec(src);
        if (m) return { type: 'tag', raw: m[0], tag: m[1] };
      },
      renderer(t) {
        const sync = tagOpts().itemTags.map(normTag).includes(normTag(t.tag)) || tagOpts().sectionTags.map(normTag).includes(normTag(t.tag));
        return `<span class="tag${sync ? ' tag-sync' : ''}" role="link" tabindex="0">#${esc(t.tag)}</span>`;
      },
    },
    {
      name: 'due', level: 'inline',
      start(src) { const i = src.search(/📅|due:\d/u); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^(?:📅|due:)\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/u.exec(src);
        if (m) return { type: 'due', raw: m[0], date: m[1], time: m[2] };
      },
      renderer(t) { return `<span class="due ${dueClass(t.date)}" title="Due ${esc(t.date)}${t.time ? ' ' + esc(t.time) : ''}">📅 ${esc(fmtDue(t.date, t.time))}</span>`; },
    },
    {
      name: 'recur', level: 'inline',
      start(src) { const i = src.indexOf('🔁'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^🔁\s*(.+?)(?=\s+(?:📅|due:|✅|⏫|🔼|🔽|🔺|⏬|#[\p{L}_/-]|\^[A-Za-z0-9-]+[ \t]*(?:\n|$))|[ \t]*(?:\n|$))/u.exec(src);
        const rule = m && parseRecurrence(m[1]);
        // Rules Tickmark doesn't understand render as plain text, the same way they sync.
        if (rule) return { type: 'recur', raw: m[0], rule };
      },
      renderer(t) { const d = describeRecurrence(t.rule); return `<span class="due recur" title="Repeats ${esc(d)}">🔁 ${esc(d)}</span>`; },
    },
    {
      name: 'blockid', level: 'inline',
      start(src) { const m = /(^|[ \t])\^[A-Za-z0-9-]+[ \t]*(?:\n|$)/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) { const m = /^\^[A-Za-z0-9-]+(?=[ \t]*(?:\n|$))/.exec(src); if (m) return { type: 'blockid', raw: m[0] }; },
      renderer() { return ''; },
    },
  ],
});

const SYNC_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>';

function renderPreview() {
  if (S.mode !== 'note') return;
  const text = el.editor.value;
  let body = text, head = '';
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (fm) { body = text.slice(fm[0].length); head = `<div class="frontmatter">${esc(fm[1])}</div>`; }
  if (text.includes('\n<<<<<<< this device') || text.startsWith('<<<<<<< this device')) {
    head = '<div class="conflict-banner">This note has a merge conflict: edits made here and on disk touched the same lines. Keep the version you want and delete the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>=======</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers.</div>' + head;
  }
  cbIndex = 0;
  el.preview.innerHTML = head + marked.parse(body);
  // Markdown only knows [ ] and [x]: turn "[/] …" and "[-] …" list items into checkboxes too, then
  // number every checkbox in document order (the order checkboxLines() lists their source lines).
  el.preview.querySelectorAll('li').forEach((li) => {
    const host = li.firstChild?.nodeName === 'P' ? li.firstChild : li;
    const t = host.firstChild;
    const m = t?.nodeType === 3 && /^\[([/-])\]\s/.exec(t.textContent);
    if (!m) return;
    t.textContent = t.textContent.slice(m[0].length);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-cb';
    cb.dataset.state = m[1] === '/' ? 'progress' : 'cancelled';
    if (m[1] === '-') cb.checked = true;
    host.insertBefore(cb, host.firstChild);
  });
  el.preview.querySelectorAll('input.task-cb').forEach((cb, i) => (cb.dataset.i = i));

  const lines = checkboxLines(text);
  const synced = new Set(parseTasks(text, tagOpts()).filter((t) => t.synced).map((t) => t.line));
  el.preview.querySelectorAll('input.task-cb').forEach((cb) => {
    const line = lines[+cb.dataset.i];
    const li = cb.closest('li');
    if (line == null) { cb.disabled = true; return; }
    cb.dataset.line = line;
    if (cb.dataset.state === 'progress') { cb.indeterminate = true; cb.title = 'In progress'; li?.classList.add('progress-item'); }
    if (cb.dataset.state === 'cancelled') { cb.title = 'Cancelled'; li?.classList.add('cancelled-item'); }
    if (cb.checked && li) {
      li.classList.add('done-item');
      li.querySelectorAll(':scope > .due, :scope > p > .due').forEach((d) => d.classList.remove('overdue', 'today'));
    }
    if (synced.has(line)) {
      cb.classList.add('synced');
      cb.title = 'Syncs with your CalDAV task list';
      const mark = document.createElement('span');
      mark.className = 'sync-mark';
      mark.title = 'Syncs with your CalDAV task list';
      mark.innerHTML = SYNC_ICON;
      if (cb.parentElement.tagName === 'P') cb.parentElement.append(mark);
      else li?.insertBefore(mark, li.querySelector(':scope > ul, :scope > ol'));
    }
  });
  el.preview.querySelectorAll('a.wikilink').forEach((a) => { if (!resolveLink(a.dataset.target)) a.classList.add('missing'); });
}
const schedulePreview = (() => { let raf = 0; return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderPreview); }; })();

function renderWordCount() {
  if (S.mode !== 'note') return;
  const { words, chars } = textStats(el.editor.value);
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  el.wordCount.textContent = `${plural(words, 'word')} · ${plural(chars, 'character')}`;
}
const scheduleWordCount = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(renderWordCount, 150); }; })();

function resolveLink(target) {
  const t = target.replace(/[#^].*$/, '').trim().toLowerCase().replace(/\.md$/, '');
  if (!t) return null;
  return S.files.find((f) => f.path.toLowerCase().replace(/\.md$/, '') === t) ||
    S.files.find((f) => basename(f.path).toLowerCase() === t.split('/').pop()) || null;
}

async function openLink(target) {
  const f = resolveLink(target);
  if (f) return open(f.path);
  const name = target.replace(/[#^].*$/, '').trim();
  if (!name) return;
  const file = (/\.md$/i.test(name) ? name : name + '.md');
  // [[Name]] makes the note next to the one linking to it; [[Folder/Name]] and [[/Name]] are from the vault's root.
  const path = /\//.test(file) || !S.path ? file.replace(/^\/+/, '') : joinPath(dirname(S.path), file);
  try { await api('POST', '/api/file', { path, content: '' }); } catch (e) { if (e.status !== 409) return toast(e.message); }
  await loadTree();
  open(path);
}

// ---------------------------------------------------------------- editor
function setEditorText(text) {
  // Replace only the changed span so the cursor and scroll position survive external updates.
  const ed = el.editor, old = ed.value;
  if (old === text) return;
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
  ed.setRangeText(text.slice(a, text.length - b), a, old.length - b, 'preserve');
  scheduleWordCount();
}

/** Set an item's state from the checkbox menu, with the same sub-item rule and "Complete" filing as a click. */
function setTaskStateFiled(text, lineNo, ch) {
  const was = (text.split('\n')[lineNo] || '').match(/\[([ xX/-])\]/)?.[1];
  if (was === undefined || was === ch) return text;
  const finishing = 'xX-'.includes(ch) && !'xX-'.includes(was);
  if (finishing && ch !== '-') return toggleTask(text, lineNo); // a normal check: date, recurrence, filing
  if (finishing) {
    const open = openSubtasks(text, lineNo);
    if (open && parseTasks(text, tagOpts()).some((t) => t.line === lineNo && t.synced)) { toast(`Finish its ${open} sub-item${open === 1 ? '' : 's'} first`); return text; }
  }
  const next = setTaskState(text, lineNo, ch);
  if (S.config?.moveCompleted === false || 'xX-'.includes(ch) === 'xX-'.includes(was)) return next;
  return fileCompleted(next, lineNo) ?? next;
}

/** Check or uncheck an item; with "move completed" on, it also moves under/out of the "Complete" heading. */
function toggleTask(text, lineNo) {
  // A synced task can't be checked while it has unchecked sub-items.
  if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ /]\]/.test(text.split('\n')[lineNo] || '')) {
    const open = openSubtasks(text, lineNo);
    if (open && parseTasks(text, tagOpts()).some((t) => t.line === lineNo && t.synced)) {
      toast(`Finish its ${open} sub-item${open === 1 ? '' : 's'} first`);
      return text;
    }
  }
  const next = toggleLine(text, lineNo);
  if (next === text || S.config?.moveCompleted === false) return next;
  // A recurring item leaves a completed copy on the line below; that's the one to file away.
  const done = next.split('\n').length > text.split('\n').length ? lineNo + 1 : lineNo;
  return fileCompleted(next, done) ?? next;
}

function applyEdit(text) {
  setEditorText(text);
  onEdited({ now: true }); // a click (checkbox, shortcut), not typing: save straight away
}

function replaceRange(start, end, text) {
  const ed = el.editor;
  ed.focus();
  ed.setSelectionRange(start, end);
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (!ok) { ed.setRangeText(text, start, end, 'end'); onEdited(); }
}

function onEdited({ now = false } = {}) {
  if (!now) S.lastInputAt = Date.now();
  updateSaveState();
  if (now) saveSoon(); else scheduleSave();
  schedulePreview();
  scheduleWordCount();
}
el.editor.addEventListener('input', () => onEdited());
// Leaving the editor saves at once rather than waiting for the pause.
el.editor.addEventListener('blur', () => { if (el.editor.value !== S.base) flushSave(); });

function lineBounds(v, pos) {
  const s = v.lastIndexOf('\n', pos - 1) + 1;
  let e = v.indexOf('\n', pos);
  if (e < 0) e = v.length;
  return [s, e];
}

const BID_AFTER = /^\s*\^[A-Za-z0-9-]+\s*$/; // only a block id between the caret and the end of the line
const LIST_RE = /^(\s*(?:>\s*)*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
el.editor.addEventListener('keydown', (e) => {
  const ed = el.editor, mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    let { selectionStart: s, selectionEnd: se, value: v } = ed;
    if (s !== se) return;
    const [ls, le] = lineBounds(v, s);
    // Sync may have added a block id after the caret while you typed; Enter shouldn't split it off.
    const keepId = s < le && BID_AFTER.test(v.slice(s, le));
    if (keepId) s = le;
    const before = v.slice(ls, s);
    const m = before.match(LIST_RE);
    if (!m) { if (keepId) { e.preventDefault(); replaceRange(le, le, '\n'); } return; }
    e.preventDefault();
    if (before.length === m[0].length && !v.slice(s, le).trim()) {
      replaceRange(ls, s, ''); // Enter on an empty item ends the list
      return;
    }
    const bullet = m[3] ? `${+m[3] + 1}${m[4]}` : m[2];
    replaceRange(s, s, '\n' + m[1] + bullet + m[5] + (m[6] ? '[ ] ' : ''));
  } else if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: se, value: v } = ed;
    const [ls] = lineBounds(v, s);
    const [, le] = lineBounds(v, se);
    const block = v.slice(ls, le);
    if (s === se && !e.shiftKey && !LIST_RE.test(block)) { replaceRange(s, s, '\t'); return; }
    const out = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^(\t| {1,4})/, '') : '\t' + l)).join('\n');
    replaceRange(ls, le, out);
    ed.setSelectionRange(s === se ? Math.max(ls, s + out.length - block.length) : ls, s === se ? Math.max(ls, s + out.length - block.length) : ls + out.length);
  } else if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    const { selectionStart: s, value: v } = ed;
    const lineNo = v.slice(0, s).split('\n').length - 1;
    const [ls, le] = lineBounds(v, s);
    const line = v.slice(ls, le);
    if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) applyEdit(toggleTask(v, lineNo));
    else {
      const m = line.match(/^(\s*(?:>\s*)*)([-*+]|\d+[.)])\s+/);
      if (m) replaceRange(ls + m[0].length, ls + m[0].length, '[ ] ');
      else { const ind = line.match(/^\s*/)[0]; replaceRange(ls + ind.length, ls + ind.length, '- [ ] '); }
    }
  }
});

el.editor.addEventListener('scroll', () => {
  if (S.view !== 'split' || mobile.matches) return;
  const ed = el.editor, pw = el.previewWrap;
  const ratio = ed.scrollTop / Math.max(1, ed.scrollHeight - ed.clientHeight);
  pw.scrollTop = ratio * (pw.scrollHeight - pw.clientHeight);
});

// ---------------------------------------------------------------- preview interaction
// Right-click a checkbox in the preview to pick its state.
el.preview.addEventListener('contextmenu', (e) => {
  const cb = e.target.closest('input.task-cb');
  const line = cb && Number(cb.dataset.line);
  if (!cb || Number.isNaN(line)) return;
  e.preventDefault();
  const pick = (ch) => () => applyEdit(setTaskStateFiled(el.editor.value, line, ch));
  showMenu(cb, [
    { label: 'To do  [ ]', run: pick(' ') }, { label: 'In progress  [/]', run: pick('/') },
    { label: 'Done  [x]', run: pick('x') }, { label: 'Cancelled  [-]', run: pick('-') },
  ]);
});
el.preview.addEventListener('click', (e) => {
  const cb = e.target.closest('input.task-cb');
  if (cb) {
    e.preventDefault();
    const line = Number(cb.dataset.line);
    if (!Number.isNaN(line)) applyEdit(toggleTask(el.editor.value, line));
    return;
  }
  const wl = e.target.closest('a.wikilink');
  if (wl) { e.preventDefault(); openLink(wl.dataset.target); return; }
  const tag = e.target.closest('.tag');
  if (tag) { el.search.value = tag.textContent; runSearch(); if (mobile.matches) el.app.classList.add('sidebar-open'); return; }
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (/^https?:|^mailto:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; return; }
    if (!href.startsWith('#') && /\.md(#.*)?$/i.test(href)) {
      e.preventDefault();
      const rel = decodeURI(href.replace(/#.*$/, ''));
      const parts = (rel.startsWith('/') ? rel.slice(1) : joinPath(dirname(S.path || ''), rel)).split('/');
      const stack = [];
      for (const p of parts) { if (p === '..') stack.pop(); else if (p && p !== '.') stack.push(p); }
      open(stack.join('/'));
    }
  }
});
el.preview.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.tag')) e.target.click(); });

// ---------------------------------------------------------------- saving (with offline queue)
const pendingKey = (p) => 'pending:' + p;
function updateSaveState(kind) {
  const s = el.saveState;
  s.className = '';
  if (S.mode !== 'note') { s.textContent = ''; return; }
  if (kind === 'offline' || store.get(pendingKey(S.path))) { s.textContent = 'Offline: saved on this device'; s.className = 'warn'; }
  else if (kind === 'error') { s.textContent = 'Save failed'; s.className = 'err'; }
  else if (S.saving) s.textContent = 'Saving…';
  else s.textContent = savedLabel(S.savedAt);
  s.title = S.savedAt && !s.className ? new Date(S.savedAt).toLocaleString() : '';
}
/** "Saved just now" / "Saved 5 min ago" / "Saved at 9:41 AM" / "Saved Nov 20": when the note last hit the disk. */
function savedLabel(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000, d = new Date(t);
  if (s < 45) return 'Saved just now';
  if (s < 3600) return `Saved ${Math.round(s / 60)} min ago`;
  if (d.toDateString() === new Date().toDateString()) return `Saved at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `Saved ${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) })}`;
}
setInterval(() => { if (!S.saving) updateSaveState(); }, 30000);

// Typing saves once you pause (TYPING_PAUSE), the same pause sync waits for, and sync follows the
// save. One write per pause means the file on disk and the editor don't trade half-typed versions
// with sync. Leaving the note, the editor or the page saves straight away.
const TYPING_PAUSE = 8000;
const scheduleSave = debounce(() => save(), TYPING_PAUSE);
const saveSoon = debounce(() => save(), 300);

async function save() {
  if (S.mode !== 'note' || !S.path) return;
  if (S.saving) { S.saveAgain = true; return S.saving; }
  const path = S.path, content = el.editor.value, baseContent = S.base;
  if (content === baseContent) return updateSaveState();
  S.saving = (async () => {
    updateSaveState();
    try {
      const r = await api('PUT', `/api/file?path=${enc(path)}`, { content, baseContent });
      store.del(pendingKey(path));
      if (S.path !== path) return;
      S.hash = r.hash;
      if (r.merged) {
        if (el.editor.value === content) { S.base = r.content; setEditorText(r.content); schedulePreview(); }
        else S.base = content; // still typing: the next save merges again against the disk copy
        if (r.conflicts) toast('Some edits clashed with changes on disk. Look for the conflict markers in this note.');
      } else {
        S.base = content;
      }
      S.savedAt = Date.now();
      updateSaveState();
      scheduleSync(250);
    } catch (e) {
      if (e.status && e.status !== 401) { updateSaveState('error'); toast(`Couldn't save: ${e.message}`); }
      else { // offline, or signed out: keep the edit on this device until it can be saved
        const prev = store.get(pendingKey(path));
        store.set(pendingKey(path), { content, baseContent: prev?.baseContent ?? baseContent });
        updateSaveState('offline');
      }
    } finally {
      S.saving = null;
      if (S.saveAgain) { S.saveAgain = false; scheduleSave(); }
      else updateSaveState();
    }
  })();
  return S.saving;
}

async function flushPending() {
  let keys = [];
  const prefix = store.key(pendingKey(''));
  try { keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch {}
  for (const k of keys) {
    const path = k.slice(prefix.length);
    const p = store.get(pendingKey(path));
    if (!p) continue;
    try {
      const r = await api('PUT', `/api/file?path=${enc(path)}`, p);
      store.del(pendingKey(path));
      if (path === S.path) S.savedAt = Date.now();
      if (path === S.path && el.editor.value === p.content) {
        S.base = r.merged ? r.content : p.content;
        S.hash = r.hash;
        setEditorText(S.base);
        schedulePreview();
      }
      if (r.conflicts) toast(`Offline edits to ${basename(path)} clashed with other changes. Check the conflict markers.`);
    } catch (e) {
      if (!e.status) return; // still offline
      store.del(pendingKey(path));
      toast(`Couldn't upload offline edits to ${basename(path)}: ${e.message}`);
    }
  }
  updateSaveState();
}
addEventListener('online', flushPending);
setInterval(flushPending, 15000);

async function flushSave() {
  if (S.mode === 'note' && el.editor.value !== S.base) await save();
  if (S.saving) await S.saving;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
  else if (syncConfigured() && Date.now() - S.lastSyncAt > 60000) runSync();
});
addEventListener('pagehide', () => {
  if (S.mode === 'note' && S.path && el.editor.value !== S.base) {
    fetch(`/api/file?path=${enc(S.path)}`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: el.editor.value, baseContent: S.base }),
    }).catch(() => store.set(pendingKey(S.path), { content: el.editor.value, baseContent: S.base }));
  }
});

// ---------------------------------------------------------------- opening notes
async function open(path, { line = null, push = true } = {}) {
  if (!path) return;
  await flushSave();
  let file;
  try { file = await api('GET', `/api/file?path=${enc(path)}`); } catch (e) {
    const pend = store.get(pendingKey(path));
    if (!pend) { toast(e.status === 404 ? `${basename(path)} no longer exists` : `Couldn't open: ${e.message}`); return; }
    file = { path, content: pend.baseContent, hash: null };
  }
  const pend = store.get(pendingKey(path));
  S.path = path;
  S.base = file.content;
  S.hash = file.hash;
  S.savedAt = file.mtime || null;
  S.mode = 'note';
  el.editor.value = pend ? pend.content : file.content;
  store.set('last', path);
  if (push && location.hash !== '#' + enc(path)) history.pushState(null, '', '#' + enc(path));
  el.title.value = basename(path);
  el.title.disabled = false;
  el.crumbs.textContent = dirname(path) ? dirname(path).replaceAll('/', ' / ') + ' /' : '';
  document.title = `${basename(path)} · ${S.brand?.name || 'Tickmark'}`;
  applyView();
  renderPreview();
  renderWordCount();
  renderTree();
  updateSaveState();
  if (mobile.matches) el.app.classList.remove('sidebar-open');
  if (line != null) {
    const v = el.editor.value;
    let pos = 0;
    for (let i = 0; i < line && pos >= 0; i++) pos = v.indexOf('\n', pos) + 1;
    if (effectiveView() === 'read') { S.view = mobile.matches ? 'edit' : 'split'; applyView(); }
    el.editor.focus();
    el.editor.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(el.editor).lineHeight) || 24;
    el.editor.scrollTop = Math.max(0, line * lh - el.editor.clientHeight / 3);
  } else {
    el.editor.scrollTop = 0;
    el.previewWrap.scrollTop = 0;
  }
  loadBacklinks();
}

async function reloadIfClean() {
  if (S.mode !== 'note' || !S.path || S.saving || el.editor.value !== S.base) return;
  try {
    const f = await api('GET', `/api/file?path=${enc(S.path)}`);
    if (el.editor.value !== S.base || f.path !== S.path) return;
    S.base = f.content;
    S.hash = f.hash;
    S.savedAt = f.mtime || S.savedAt;
    setEditorText(f.content);
    renderPreview();
    updateSaveState();
  } catch {}
}

async function loadBacklinks() {
  if (!S.path) return;
  try {
    const list = await api('GET', `/api/backlinks?path=${enc(S.path)}`);
    el.backlinks.innerHTML = list.length ? `<h4>Linked from</h4>` + list.map((p) => `<a href="#" data-path="${esc(p)}">${esc(basename(p))}</a>`).join('') : '';
  } catch { el.backlinks.innerHTML = ''; }
}
el.backlinks.addEventListener('click', (e) => { const a = e.target.closest('a[data-path]'); if (a) { e.preventDefault(); open(a.dataset.path); } });

addEventListener('popstate', () => routeFromHash());
function routeFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h) open(h, { push: false });
}

// ---------------------------------------------------------------- views
const effectiveView = () => (mobile.matches && S.view === 'split' ? 'read' : S.view);
function applyView() {
  const cls = el.app.className.split(' ').filter((c) => !c.startsWith('view-'));
  cls.push(`view-${effectiveView()}`);
  el.app.className = cls.join(' ');
  const note = S.mode === 'note';
  el.editor.hidden = !note;
  el.previewWrap.hidden = !note;
  el.wordCount.hidden = !note;
  el.empty.hidden = S.mode !== 'empty';
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === effectiveView()));
  if (note && effectiveView() !== 'edit') schedulePreview();
}
document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; store.set('view', S.view); applyView(); }));
mobile.addEventListener('change', applyView);

function cycleView() {
  const order = mobile.matches ? ['edit', 'read'] : ['edit', 'split', 'read'];
  S.view = order[(order.indexOf(effectiveView()) + 1) % order.length];
  store.set('view', S.view);
  applyView();
}

function toggleSidebar() {
  if (mobile.matches) el.app.classList.toggle('sidebar-open');
  else { el.app.classList.toggle('no-sidebar'); store.set('noSidebar', el.app.classList.contains('no-sidebar')); }
}
$('#btn-menu').onclick = toggleSidebar;
$('#scrim').onclick = () => el.app.classList.remove('sidebar-open');
if (store.get('noSidebar')) el.app.classList.add('no-sidebar');

// ---------------------------------------------------------------- file tree
async function loadTree() {
  try {
    const t = await api('GET', '/api/tree');
    S.files = t.files;
    S.folders = t.folders;
    S.inbox = t.inbox;
    store.set('tree', t);
  } catch {
    const t = store.get('tree');
    if (t) { S.files = t.files; S.folders = t.folders; }
  }
  renderTree();
}
const scheduleTree = debounce(loadTree, 200);

function buildTree() {
  const root = { folders: new Map(), files: [] };
  const node = (path) => {
    let n = root;
    if (!path) return n;
    for (const part of path.split('/')) {
      if (!n.folders.has(part)) n.folders.set(part, { folders: new Map(), files: [], path: n.path ? `${n.path}/${part}` : part });
      n = n.folders.get(part);
    }
    return n;
  };
  for (const f of S.folders) node(f);
  for (const f of S.files) node(dirname(f.path)).files.push(f);
  return root;
}

const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;color:var(--muted)"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const MORE = '<button class="icon-btn t-more" aria-label="Actions"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></button>';
const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

function renderTree() {
  const html = (n) => {
    let out = '';
    for (const [name, f] of [...n.folders].sort((a, b) => cmp(a[0], b[0]))) {
      const isOpen = S.openFolders.has(f.path);
      out += `<div class="t-row folder${isOpen ? ' open' : ''}" data-folder="${esc(f.path)}" draggable="true">${CHEV}<span class="name">${esc(name)}</span>${MORE}</div>`;
      if (isOpen) out += `<div class="t-children">${html(f)}</div>`;
    }
    for (const f of n.files.sort((a, b) => cmp(a.path, b.path))) {
      out += `<div class="t-row file${f.path === S.path && S.mode === 'note' ? ' active' : ''}" data-path="${esc(f.path)}" draggable="true">${FILE_ICON}<span class="name">${esc(basename(f.path))}</span>${MORE}</div>`;
    }
    return out;
  };
  el.tree.innerHTML = html(buildTree()) || '<p class="note" style="padding:8px">No notes yet. Click + to create one.</p>';
}

el.tree.addEventListener('click', (e) => {
  const row = e.target.closest('.t-row');
  if (!row) return;
  if (e.target.closest('.t-more')) { e.stopPropagation(); return treeMenu(row, e.target.closest('.t-more')); }
  if (row.dataset.folder != null) {
    const p = row.dataset.folder;
    S.openFolders.has(p) ? S.openFolders.delete(p) : S.openFolders.add(p);
    store.set('openFolders', [...S.openFolders]);
    renderTree();
  } else open(row.dataset.path);
});
el.tree.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.t-row');
  if (!row) return;
  e.preventDefault();
  treeMenu(row, row);
});

function treeMenu(row, anchor) {
  const folder = row.dataset.folder;
  const path = folder ?? row.dataset.path;
  const items = [];
  if (folder != null) {
    items.push({ label: 'New note here', run: () => newNote(folder) });
    items.push({ label: 'New folder here', run: () => newFolder(folder) });
  }
  items.push({ label: 'Rename…', run: () => renamePath(path, folder != null) });
  items.push({ label: 'Move to folder…', run: () => moveToFolder(path) });
  items.push({ label: 'Share…', run: () => openShare(path, folder != null) });
  items.push({ label: 'Move to trash', danger: true, run: () => trashPath(path, folder != null) });
  showMenu(anchor, items);
}

// drag & drop to move notes/folders between folders
let dragPath = null;
el.tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.t-row');
  dragPath = row?.dataset.folder ?? row?.dataset.path ?? null;
  e.dataTransfer.effectAllowed = 'move';
});
el.tree.addEventListener('dragover', (e) => {
  if (!dragPath) return;
  e.preventDefault();
  el.tree.querySelectorAll('.drop').forEach((r) => r.classList.remove('drop'));
  (e.target.closest('.t-row.folder') || el.tree).classList.add('drop');
});
el.tree.addEventListener('dragleave', (e) => { if (!el.tree.contains(e.relatedTarget)) el.tree.querySelectorAll('.drop').forEach((r) => r.classList.remove('drop')); el.tree.classList.remove('drop'); });
el.tree.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.tree.querySelectorAll('.drop').forEach((r) => r.classList.remove('drop'));
  el.tree.classList.remove('drop');
  const target = e.target.closest('.t-row.folder')?.dataset.folder ?? '';
  const from = dragPath;
  dragPath = null;
  if (!from || dirname(from) === target || target === from || target.startsWith(from + '/')) return;
  await movePath(from, joinPath(target, from.split('/').pop()));
});

async function movePath(from, to) {
  try {
    await flushSave();
    const r = await api('POST', '/api/rename', { from, to });
    if (r.updated?.length) toast(`Updated links in ${r.updated.length} note${r.updated.length === 1 ? '' : 's'}`);
    if (S.path === from || S.path?.startsWith(from + '/')) {
      S.path = to + S.path.slice(from.length);
      history.replaceState(null, '', '#' + enc(S.path));
      el.title.value = basename(S.path);
      el.crumbs.textContent = dirname(S.path) ? dirname(S.path).replaceAll('/', ' / ') + ' /' : '';
    }
    if (r.updated?.includes(S.path)) reloadIfClean();
    await loadTree();
  } catch (e) { toast(e.message); }
}

async function moveToFolder(path) {
  const dest = await ask('Move to folder (blank = vault root)', dirname(path));
  if (dest === null) return;
  const dir = dest.replace(/^\/+|\/+$/g, '');
  if (dir === path || dir.startsWith(path + '/')) return toast("A folder can't go inside itself");
  if (dir !== dirname(path)) await movePath(path, joinPath(dir, path.split('/').pop()));
}

async function renamePath(path, isFolder) {
  const name = await ask(isFolder ? 'Rename folder' : 'Rename note', isFolder ? path.split('/').pop() : basename(path));
  if (!name || /[/\\]/.test(name)) return;
  await movePath(path, joinPath(dirname(path), isFolder ? name : name + '.md'));
}

async function trashPath(path, isFolder) {
  if (!confirm(`Move ${isFolder ? 'folder' : 'note'} “${isFolder ? path : basename(path)}” to the vault's .trash folder?`)) return;
  try {
    await api('DELETE', `/api/file?path=${enc(path)}`);
    if (S.path === path || S.path?.startsWith(path + '/')) {
      S.path = null; S.mode = 'empty'; el.title.value = ''; el.crumbs.textContent = '';
      store.del(pendingKey(path));
      applyView(); updateSaveState();
    }
    await loadTree();
  } catch (e) { toast(e.message); }
}

async function newNote(folder = S.path ? dirname(S.path) : '', name) {
  name = name ?? (await ask('New note', 'Untitled'));
  if (!name) return;
  let path = joinPath(folder, name.replace(/\.md$/i, '') + '.md');
  for (let i = 1; S.files.some((f) => f.path.toLowerCase() === path.toLowerCase()); i++) path = joinPath(folder, `${name} ${i}.md`);
  try {
    await api('POST', '/api/file', { path, content: '' });
    if (folder) { S.openFolders.add(folder); store.set('openFolders', [...S.openFolders]); }
    await loadTree();
    if (effectiveView() === 'read') { S.view = mobile.matches ? 'edit' : 'split'; store.set('view', S.view); }
    await open(path);
    el.editor.focus();
  } catch (e) { toast(e.message); }
}

async function newFolder(parent = '') {
  const name = await ask('New folder');
  if (!name) return;
  try {
    const p = joinPath(parent, name);
    await api('POST', '/api/folder', { path: p });
    S.openFolders.add(p);
    if (parent) S.openFolders.add(parent);
    store.set('openFolders', [...S.openFolders]);
    await loadTree();
  } catch (e) { toast(e.message); }
}
$('#btn-new').onclick = () => newNote();
$('#btn-new-folder').onclick = () => newFolder(S.path ? dirname(S.path) : '');

// rename via the title field
async function commitTitle() {
  if (S.mode !== 'note' || !S.path) return;
  const name = el.title.value.trim();
  if (!name || name === basename(S.path)) { el.title.value = basename(S.path); return; }
  if (/[/\\]/.test(name)) { toast('Names cannot contain / or \\'); el.title.value = basename(S.path); return; }
  await movePath(S.path, joinPath(dirname(S.path), name + '.md'));
}
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.title.blur(); }
  if (e.key === 'Escape') { el.title.value = S.path ? basename(S.path) : ''; el.title.blur(); }
});
el.title.addEventListener('blur', commitTitle);

$('#btn-more').onclick = (e) => {
  const note = S.mode === 'note';
  showMenu(e.currentTarget, [
    ...(note ? [
      { label: 'Rename', run: () => { el.title.focus(); el.title.select(); } },
    ] : []),
    ...(note ? [{ label: 'Share…', run: () => openShare(S.path, false) }] : []),
    { label: 'Sync now', run: () => runSync({ manual: true }) },
    ...(note ? [{ label: 'Deleted tasks in this note…', run: () => openDeleted({ path: S.path }) }] : [{ label: 'Deleted tasks…', run: () => openDeleted() }]),
    { label: 'Theme…', run: () => openSettings('appearance') },
    ...(note ? [{ label: 'Move to trash', danger: true, run: () => trashPath(S.path, false) }] : []),
  ]);
};

// ---------------------------------------------------------------- search
const runSearch = debounce(async () => {
  const q = el.search.value.trim();
  if (!q) { el.results.hidden = true; el.tree.hidden = false; return; }
  const ql = q.toLowerCase();
  const byName = S.files.filter((f) => f.path.toLowerCase().includes(ql)).slice(0, 10);
  let byText = [];
  try { byText = await api('GET', `/api/search?q=${enc(q)}`); } catch {}
  const seen = new Set(byName.map((f) => f.path));
  const items = [
    ...byName.map((f) => ({ path: f.path, snippet: dirname(f.path) ? esc(dirname(f.path)) : '' })),
    ...byText.filter((r) => !seen.has(r.path)).map((r) => ({ path: r.path, snippet: esc(r.snippet).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>') })),
  ];
  el.results.innerHTML = items.length
    ? items.map((r) => `<div class="sr-item" data-path="${esc(r.path)}"><div class="p">${esc(basename(r.path))}</div><div class="s">${r.snippet}</div></div>`).join('')
    : '<p class="note" style="padding:8px">No matches</p>';
  el.results.hidden = false;
  el.tree.hidden = true;
}, 150);
el.search.addEventListener('input', runSearch);
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { el.search.value = ''; runSearch(); el.search.blur(); }
  if (e.key === 'Enter') el.results.querySelector('.sr-item')?.click();
});
el.results.addEventListener('click', (e) => { const r = e.target.closest('.sr-item'); if (r) open(r.dataset.path); });

// ---------------------------------------------------------------- quick switcher
const sw = { dlg: $('#dlg-switcher'), input: $('#switcher-input'), list: $('#switcher-list'), items: [], sel: 0 };
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let score = 0, j = 0, streak = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; streak++; score += streak * 2 + (i === 0 || '/ -_'.includes(s[i - 1]) ? 5 : 0); } else streak = 0;
  }
  return j === q.length ? score - s.length * 0.05 : -1;
}
function renderSwitcher() {
  const q = sw.input.value.trim();
  sw.items = (q
    ? S.files.map((f) => ({ f, s: fuzzy(q, basename(f.path)) * 2 + Math.max(0, fuzzy(q, f.path)) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.f)
    : [...S.files].sort((a, b) => b.mtime - a.mtime)).slice(0, 50);
  sw.sel = Math.min(sw.sel, Math.max(0, sw.items.length - 1));
  sw.list.innerHTML = sw.items.map((f, i) => `<li data-i="${i}" class="${i === sw.sel ? 'sel' : ''}">${esc(basename(f.path))}<span class="dir">${esc(dirname(f.path))}</span></li>`).join('') +
    (q && !sw.items.some((f) => basename(f.path).toLowerCase() === q.toLowerCase()) ? `<li data-new="1" class="${sw.items.length ? '' : 'sel'}">Create “${esc(q)}”</li>` : '');
}
function openSwitcher() { sw.input.value = ''; sw.sel = 0; renderSwitcher(); sw.dlg.showModal(); sw.input.focus(); }
function pickSwitcher(i) {
  const q = sw.input.value.trim();
  sw.dlg.close();
  if (sw.items[i]) open(sw.items[i].path);
  else if (q) newNote('', q);
}
sw.input.addEventListener('input', () => { sw.sel = 0; renderSwitcher(); });
sw.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = sw.list.children.length;
    sw.sel = (sw.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % Math.max(1, n);
    [...sw.list.children].forEach((li, i) => li.classList.toggle('sel', i === sw.sel));
    sw.list.children[sw.sel]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); pickSwitcher(sw.items.length ? sw.sel : -1); }
});
sw.list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) pickSwitcher(li.dataset.new ? -1 : +li.dataset.i); });
sw.dlg.addEventListener('click', (e) => { if (e.target === sw.dlg) sw.dlg.close(); });

// ---------------------------------------------------------------- sync
function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
function renderSync() {
  const b = el.sync, st = S.sync;
  b.className = 'sync-btn';
  const label = b.querySelector('.label');
  if (!syncConfigured()) { label.textContent = 'Set up CalDAV sync'; b.title = 'Connect a CalDAV task list'; return; }
  if (st.state === 'syncing') { b.classList.add('syncing'); label.textContent = 'Syncing…'; return; }
  if (st.state === 'error') { b.classList.add('error'); label.textContent = 'Sync problem'; b.title = (st.lastError ? st.lastError + '\n\n' : '') + nextSyncText(); return; }
  b.classList.add('ok');
  label.textContent = st.lastRun ? `Synced ${relTime(st.lastRun)}` : 'Ready to sync';
  const r = st.lastResult;
  const line = (x) => `${x.created} created, ${x.pushed} sent, ${x.pulled} received, ${x.imported} imported, ${x.deletedRemote + x.deletedLocal} deleted`;
  b.title = r ? (r.accounts?.length > 1 ? 'Last sync:\n' + r.accounts.map((a) => `${a.name}: ${a.error || line(a)}`).join('\n') : `Last sync: ${line(r)}`) +
    (r.errors?.length ? `\n${r.errors.length} error(s):\n${r.errors.join('\n')}` : '') : 'Sync now';
  b.title += '\n\n' + nextSyncText();
}
el.sync.addEventListener('mouseenter', renderSync); // so the countdown is current when the tooltip shows
setInterval(renderSync, 30000);

async function runSync({ manual = false, force = false } = {}) {
  if (!syncConfigured()) { if (manual) openSettings(); return; }
  if (S.sync.state === 'syncing' && !manual) return;
  // Background syncs wait until you pause typing, so a task isn't sent (and given its block id)
  // while you're still writing it.
  const typing = Date.now() - (S.lastInputAt || 0);
  if (!manual && typing < TYPING_PAUSE) { scheduleSync(TYPING_PAUSE - typing + 250); return; }
  S.lastSyncAt = Date.now();
  await flushSave();
  let r;
  try { r = await api('POST', '/api/sync', { force }); } catch (e) {
    if (manual) toast(e.status ? e.message : 'Offline, so sync will run when the server is reachable');
    return;
  }
  if (!r.ok) {
    if (r.needsForce) toast(r.error, { label: 'Sync anyway', run: () => runSync({ manual: true, force: true }) });
    else if (manual) toast(r.error);
  } else if (manual && !trashedCount(r.result)) { // recoverable deletions get their own notice
    const x = r.result;
    const n = x.created + x.pushed + x.pulled + x.imported + x.deletedLocal + x.deletedRemote;
    toast(n ? `Synced: ${x.created + x.pushed} sent, ${x.pulled + x.imported} received${x.deletedLocal + x.deletedRemote ? `, ${x.deletedLocal + x.deletedRemote} deleted` : ''}` : 'Everything is up to date');
  }
  if (r.ok && r.result.errors?.length) toast(`${r.result.errors.length} task(s) failed to sync. Hover the sync status for details.`);
}
const scheduleSync = (() => { let t; return (ms = 3000) => { clearTimeout(t); t = setTimeout(() => runSync(), ms); }; })();

el.sync.onclick = (e) => {
  if (!syncConfigured()) return openSettings();
  if (S.sync.state === 'error') {
    return showMenu(e.currentTarget, [
      { label: 'Try again', run: () => runSync({ manual: true }) },
      ...(S.sync.needsForce ? [{ label: 'Sync anyway', danger: true, run: () => runSync({ manual: true, force: true }) }] : []),
      { label: 'Show error', run: () => alert(S.sync.lastError) },
      { label: 'Settings…', run: openSettings },
    ]);
  }
  runSync({ manual: true });
};

let syncInterval = null;
function setupSyncTimer() {
  clearInterval(syncInterval);
  const mins = S.config?.clientSyncMinutes ?? 5;
  S.nextTimerAt = mins > 0 ? Date.now() + mins * 60000 : null;
  if (mins > 0) syncInterval = setInterval(() => {
    S.nextTimerAt = Date.now() + mins * 60000;
    if (document.visibilityState === 'visible') runSync();
  }, mins * 60000);
}
/** "Next sync in about 3 min", for the sync button's tooltip. */
function nextSyncText() {
  if (!S.nextTimerAt) return 'Automatic sync while open is off (Settings → CalDAV accounts); it still syncs after you save.';
  const s = Math.max(0, (S.nextTimerAt - Date.now()) / 1000);
  const when = s < 60 ? 'in under a minute' : `in about ${Math.round(s / 60)} min`;
  return `Next sync ${when}, and after you save.`;
}

// ---------------------------------------------------------------- settings
const form = $('#settings-form');
const accountsEl = $('#accounts');
const field = (box, f) => box.querySelector(`[data-f="${f}"]`);

function addAccountBox(a = {}) {
  const box = $('#tpl-account').content.firstElementChild.cloneNode(true);
  box.dataset.id = a.id || '';
  const first = !accountsEl.children.length;
  field(box, 'name').value = a.name || '';
  field(box, 'url').value = a.url || '';
  field(box, 'username').value = a.username || '';
  field(box, 'password').placeholder = a.hasPassword ? '•••••• (unchanged)' : '';
  field(box, 'calendarUrl').innerHTML = a.calendarUrl
    ? `<option value="${esc(a.calendarUrl)}">${esc(a.calendarName || a.calendarUrl)}</option>`
    : '<option value="">— find calendars first —</option>';
  // New accounts after the first get no default tags, so they never steal #task from the first one.
  field(box, 'itemTags').value = (a.itemTags || (first ? ['task'] : [])).join(', ');
  field(box, 'sectionTags').value = (a.sectionTags || (first ? ['sync'] : [])).join(', ');
  field(box, 'inboxFile').value = a.inboxFile || (first ? 'Inbox.md' : '');
  field(box, 'inboxFile').placeholder = first ? 'Inbox.md' : 'Inbox (name).md';
  box.querySelector('[data-act="discover"]').onclick = () => discover(box);
  box.querySelector('[data-act="remove"]').onclick = () => {
    if (box.dataset.id && !confirm(`Remove “${field(box, 'name').value || 'this account'}”? Its tasks stay in your notes and on the server; they just stop syncing.`)) return;
    box.remove();
  };
  accountsEl.append(box);
  return box;
}
$('#btn-add-account').onclick = () => {
  const box = addAccountBox({ name: '' });
  field(box, 'name').focus();
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

async function discover(box) {
  const msg = field(box, 'msg');
  msg.className = 'note';
  msg.textContent = 'Looking for task lists…';
  try {
    const { calendars } = await api('POST', '/api/caldav/discover', {
      accountId: box.dataset.id || undefined,
      url: field(box, 'url').value.trim(), username: field(box, 'username').value.trim(), password: field(box, 'password').value,
    });
    if (!calendars.length) { msg.textContent = 'No calendars that support tasks (VTODO) were found at that URL.'; msg.className = 'note err'; return; }
    const sel = field(box, 'calendarUrl');
    const cur = sel.value;
    sel.innerHTML = calendars.map((c) => `<option value="${esc(c.url)}"${c.url === cur ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    if (!field(box, 'name').value.trim()) field(box, 'name').value = sel.selectedOptions[0]?.textContent || '';
    msg.textContent = `Found ${calendars.length} task list${calendars.length === 1 ? '' : 's'}.`;
  } catch (e) { msg.textContent = e.message; msg.className = 'note err'; }
}

// The settings pane: a menu of sections. CalDAV accounts and Sync share one form and Save button;
// the others act immediately (account, users) or have their own Save (single sign-on).
const SECTIONS = { caldav: 'CalDAV accounts', account: 'Your account', users: 'Users', sso: 'Single sign-on', appearance: 'Appearance', branding: 'Branding', shares: 'Public links' };
const setDlg = $('#dlg-settings');
const isMulti = () => S.me?.mode === 'multi' && !!S.me.user;
const isAdmin = () => isMulti() && !!S.me.user.admin;

function sectionVisible(sec) {
  if (sec === 'account') return isMulti();
  if (sec === 'users' || sec === 'sso') return !isMulti() || isAdmin(); // single-user: offers turning sign-in on
  return true;
}

function showSection(sec) {
  if (!SECTIONS[sec] || !sectionVisible(sec)) sec = 'caldav';
  S.settingsSection = sec;
  store.set('settingsSection', sec);
  $('#set-title').textContent = SECTIONS[sec];
  setDlg.querySelectorAll('.set-nav [data-sec]').forEach((b) => {
    b.hidden = !sectionVisible(b.dataset.sec);
    b.classList.toggle('active', b.dataset.sec === sec);
    b.setAttribute('aria-current', b.dataset.sec === sec ? 'page' : 'false');
  });
  form.hidden = sec !== 'caldav';
  form.querySelectorAll(':scope > section').forEach((x) => (x.hidden = x.dataset.sec !== sec));
  setDlg.querySelectorAll('.set-main > [data-sec]').forEach((x) => (x.hidden = x.dataset.sec !== sec));
  if (sec === 'users') loadUsers();
  if (sec === 'sso') loadSso();
  if (sec === 'appearance') { renderThemes(); renderCssEditor(); }
  if (sec === 'branding') renderBranding();
  if (sec === 'shares') loadShares();
}
setDlg.querySelectorAll('.set-nav [data-sec]').forEach((b) => (b.onclick = () => showSection(b.dataset.sec)));
setDlg.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showSection(g.dataset.goto); } });

function openSettings(sec) {
  const c = S.config || {};
  accountsEl.innerHTML = '';
  for (const a of c.accounts || []) addAccountBox(a);
  if (!accountsEl.children.length) addAccountBox({ name: 'CalDAV' });
  $('#enc-note').hidden = !c.encrypted;
  form.clientSyncMinutes.value = c.clientSyncMinutes ?? 5;
  form.moveCompleted.checked = c.moveCompleted !== false;
  form.serverSyncMinutes.value = c.serverSyncMinutes ?? 0;
  renderMe();
  showSection(typeof sec === 'string' ? sec : store.get('settingsSection', 'caldav'));
  if (!setDlg.open) setDlg.showModal();
  setDlg.querySelector('.set-nav .active')?.focus({ focusVisible: false });
}
$('#btn-settings').onclick = () => openSettings();

// ---------------------------------------------------------------- appearance
const THEMES = [
  ['system', 'System', 'Light or dark, following your device'],
  ['light', 'Light'], ['dark', 'Dark'], ['sepia', 'Sepia'],
  ['solarized-light', 'Solarized Light'], ['solarized-dark', 'Solarized Dark'],
  ['nord', 'Nord'], ['dracula', 'Dracula'],
  ['catppuccin-latte', 'Catppuccin Latte'], ['catppuccin-frappe', 'Catppuccin Frappé'],
  ['catppuccin-macchiato', 'Catppuccin Macchiato'], ['catppuccin-mocha', 'Catppuccin Mocha'],
  ['midnight', 'Midnight', 'Pure black, for OLED screens'],
  ['terminal', 'Terminal', 'Green phosphor console'],
];
const swatch = (t) => `<span class="sw" data-theme="${t}"><span class="sw-side"></span><span class="sw-main">` +
  `<span class="sw-line"></span><span class="sw-line short"></span><span class="sw-dot"></span></span></span>`;
function renderThemes() {
  const cur = window.tickmarkTheme?.get() || 'system';
  $('#themes').innerHTML = THEMES.map(([id, name, hint]) =>
    `<button type="button" role="radio" class="theme-opt" data-id="${id}" aria-checked="${id === cur}"${hint ? ` title="${esc(hint)}"` : ''}>` +
    `<span class="sw-wrap">${id === 'system' ? swatch('light') + swatch('dark') : swatch(id)}</span>` +
    `<span class="theme-name">${esc(name)}</span></button>`).join('');
}
$('#themes').addEventListener('click', (e) => {
  const b = e.target.closest('.theme-opt');
  if (!b) return;
  window.tickmarkTheme?.set(b.dataset.id);
  renderThemes();
  $(`#themes .theme-opt[data-id="${b.dataset.id}"]`)?.focus();
});

// ---- public links
const shareDlg = $('#dlg-share');
const shareState = { path: null, folder: false, share: null };
async function openShare(path, folder) {
  Object.assign(shareState, { path, folder, share: null });
  const name = folder ? path.split('/').pop() : basename(path);
  $('#share-title').textContent = `Share “${name}”`;
  $('#share-what').textContent = folder
    ? 'Anyone with the link can read every note in this folder, including notes added later. They can\'t change anything or see your other notes.'
    : 'Anyone with the link can read this note. They can\'t change it or see your other notes.';
  $('#share-off').hidden = $('#share-on').hidden = true;
  $('#share-blocked').hidden = true;
  if (!shareDlg.open) shareDlg.showModal();
  let r;
  try { r = await api('GET', '/api/shares'); } catch (e) { toast(e.message); return; }
  if (r.blocker) { $('#share-blocked').textContent = r.blocker; $('#share-blocked').hidden = false; return; }
  shareState.share = r.shares.find((x) => x.path === path && x.kind === (folder ? 'folder' : 'note')) || null;
  renderShare();
}
function renderShare() {
  const sh = shareState.share;
  $('#share-off').hidden = !!sh;
  $('#share-on').hidden = !sh;
  if (sh) { $('#share-url').value = sh.url; $('#share-open').href = sh.url; }
}
$('#btn-share-create').onclick = async () => {
  try {
    shareState.share = await api('POST', '/api/shares', { path: shareState.path });
    renderShare();
    $('#share-url').select();
    try { await navigator.clipboard.writeText(shareState.share.url); toast('Link created and copied'); } catch { toast('Link created'); }
  } catch (e) { toast(e.message); }
};
$('#btn-share-copy').onclick = async () => {
  $('#share-url').select();
  try { await navigator.clipboard.writeText($('#share-url').value); toast('Link copied'); } catch { document.execCommand('copy'); toast('Link copied'); }
};
$('#btn-share-stop').onclick = async () => {
  if (!confirm('Stop sharing? The link stops working, and sharing again makes a new one.')) return;
  try { await api('DELETE', `/api/shares?token=${enc(shareState.share.token)}`); shareState.share = null; renderShare(); toast('No longer shared'); } catch (e) { toast(e.message); }
};

async function loadShares() {
  const ul = $('#shares-list');
  let r;
  try { r = await api('GET', '/api/shares'); } catch (e) { ul.innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  $('#shares-blocked').hidden = !r.blocker;
  $('#shares-blocked').textContent = r.blocker || '';
  $('#shares-empty').hidden = !!r.blocker || r.shares.length > 0;
  ul.hidden = !r.shares.length;
  ul.innerHTML = '';
  for (const sh of r.shares) {
    const li = document.createElement('li');
    const label = sh.kind === 'folder' ? `📁 ${sh.path}` : basename(sh.path) + (dirname(sh.path) ? ` (${dirname(sh.path)})` : '');
    li.innerHTML = `<span class="who"><b>${esc(label)}</b><span class="shares-list-url">${esc(sh.url)}</span></span>` +
      `<button type="button" class="btn" data-act="copy">Copy</button><button type="button" class="btn danger" data-act="stop">Stop</button>`;
    li.querySelector('[data-act="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(sh.url); toast('Link copied'); } catch { toast(sh.url); } };
    li.querySelector('[data-act="stop"]').onclick = async () => {
      if (!confirm(`Stop sharing “${label}”? The link stops working.`)) return;
      try { await api('DELETE', `/api/shares?token=${enc(sh.token)}`); loadShares(); } catch (e) { toast(e.message); }
    };
    ul.append(li);
  }
}

// ---- branding: server-wide name, logo and favicon
/** Show the server's branding everywhere it appears (the server also fills it into the page it sends). */
function applyBranding(b) {
  if (!b) return;
  S.brand = b;
  document.querySelectorAll('.brand-name').forEach((x) => (x.textContent = b.name));
  document.querySelectorAll('.brand img').forEach((x) => (x.src = b.logo));
  const fav = document.querySelector('link[rel="icon"]');
  if (fav && fav.getAttribute('href') !== b.favicon) { fav.removeAttribute('type'); fav.href = b.favicon; }
  document.title = S.mode === 'note' && S.path ? `${basename(S.path)} · ${b.name}` : b.name;
}
const brandDraft = {}; // kind → data: URL, or null to go back to the default
const canBrand = () => !isMulti() || isAdmin();
function renderBranding() {
  const b = S.brand || { name: 'Tickmark', logo: '/icons/icon.svg', favicon: '/icons/icon.svg' };
  for (const k of Object.keys(brandDraft)) delete brandDraft[k];
  $('#brand-name').value = b.customName ? b.name : '';
  const editable = canBrand();
  $('#brand-admin-note').hidden = editable;
  for (const x of document.querySelectorAll('[data-sec="branding"] input, [data-sec="branding"] button')) x.disabled = !editable;
  renderBrandImages();
  $('#btn-brand-reset').disabled = !editable || !(b.customName || b.hasLogo || b.hasFavicon);
  $('#brand-state').textContent = '';
}
function renderBrandImages() {
  const b = S.brand || {};
  for (const card of document.querySelectorAll('.brand-img')) {
    const k = card.dataset.kind;
    const draft = brandDraft[k];
    const logo = brandDraft.logo !== undefined ? brandDraft.logo || '/icons/icon.svg' : b.logo || '/icons/icon.svg';
    card.querySelector('.brand-preview').src = draft !== undefined ? draft || (k === 'favicon' ? logo : '/icons/icon.svg')
      : k === 'favicon' ? (b.hasFavicon ? b.favicon : logo) : b.logo || '/icons/icon.svg';
    const custom = draft !== undefined ? !!draft : k === 'logo' ? !!b.hasLogo : !!b.hasFavicon;
    card.querySelector('[data-act="clear"]').disabled = !custom || !canBrand();
  }
}
for (const card of document.querySelectorAll('.brand-img')) {
  const input = card.querySelector('input[type=file]');
  card.querySelector('[data-act="pick"]').onclick = () => input.click();
  card.querySelector('[data-act="clear"]').onclick = () => { brandDraft[card.dataset.kind] = null; renderBrandImages(); };
  input.onchange = () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    if (f.size > 1024 * 1024) return toast('Images must be 1 MB or smaller');
    const r = new FileReader();
    r.onload = () => { brandDraft[card.dataset.kind] = r.result; renderBrandImages(); };
    r.readAsDataURL(f);
  };
}
$('#btn-brand-reset').onclick = async () => {
  if (!confirm('Put back the Tickmark name, logo and favicon for everyone?')) return;
  try {
    applyBranding(await api('PUT', '/api/branding', { name: '', logo: null, favicon: null }));
    renderBranding();
    $('#brand-state').textContent = 'Back to the defaults';
  } catch (e) { toast(e.message); }
};
$('#btn-brand-save').onclick = async () => {
  try {
    const b = await api('PUT', '/api/branding', { name: $('#brand-name').value, ...brandDraft });
    applyBranding(b);
    renderBranding();
    $('#brand-state').textContent = 'Saved';
  } catch (e) { toast(e.message); }
};

// ---- custom CSS: live while typing, saved per user (follows them to every device)
const cssBox = $('#custom-css');
const savedCss = () => S.config?.customCss || '';
function applyCustomCss() { window.tickmarkCss?.apply(savedCss()); }
function renderCssEditor() {
  cssBox.value = savedCss();
  cssState();
}
function cssState(msg) {
  const dirty = cssBox.value !== savedCss();
  $('#btn-css-save').disabled = !dirty;
  $('#btn-css-revert').disabled = !dirty;
  $('#css-state').textContent = msg || (window.tickmarkCss?.disabled ? 'Not applied: the page was opened with ?nocss' : dirty ? 'Not saved yet' : '');
}
cssBox.addEventListener('input', debounce(() => { window.tickmarkCss?.apply(cssBox.value, { save: false }); cssState(); }, 200));
cssBox.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); cssBox.setRangeText('  ', cssBox.selectionStart, cssBox.selectionEnd, 'end'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btn-css-save').click(); }
});
$('#btn-css-save').onclick = async () => {
  try {
    S.config = await api('PUT', '/api/config', { customCss: cssBox.value });
    store.set('config', S.config);
    applyCustomCss();
    cssState('Saved');
  } catch (e) { toast(e.message); }
};
$('#btn-css-revert').onclick = () => { cssBox.value = savedCss(); applyCustomCss(); cssState(); };
// Leaving Settings with unsaved CSS puts the saved styles back.
setDlg.addEventListener('close', () => { if (cssBox.value !== savedCss()) { cssBox.value = savedCss(); applyCustomCss(); } });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const accounts = [...accountsEl.children].map((box) => {
    const sel = field(box, 'calendarUrl');
    return {
      id: box.dataset.id || undefined,
      name: field(box, 'name').value.trim(),
      url: field(box, 'url').value.trim(), username: field(box, 'username').value.trim(), password: field(box, 'password').value,
      calendarUrl: sel.value, calendarName: sel.value ? sel.selectedOptions[0]?.textContent || '' : '',
      itemTags: field(box, 'itemTags').value, sectionTags: field(box, 'sectionTags').value, inboxFile: field(box, 'inboxFile').value,
    };
  // An untouched blank account box is not an account.
  }).filter((a) => a.id || a.url || a.calendarUrl);
  const body = { accounts, clientSyncMinutes: form.clientSyncMinutes.value, serverSyncMinutes: form.serverSyncMinutes.value, moveCompleted: form.moveCompleted.checked };
  try {
    S.config = await api('PUT', '/api/config', body);
    store.set('config', S.config);
    // Re-render the account boxes so new accounts pick up their saved ids.
    openSettings(S.settingsSection);
    toast('Settings saved');
    setupSyncTimer();
    renderSync();
    renderPreview();
    if (syncConfigured()) runSync({ manual: true });
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- deleted tasks
const SOURCE = { notes: 'removed from your notes', remote: 'deleted in a task app', both: 'deleted in both places' };

/** Tasks a sync put in Deleted tasks. Removing a tag deletes the todo but keeps the line, so it isn't counted. */
const trashedCount = (r) => (r ? r.trashed ?? r.deletedLocal + r.deletedRemote : 0);
/** After any sync (this device's, another's, or the server's timer) that deleted tasks, offer a way back. */
function noticeDeletions(st) {
  const r = st.lastResult;
  const n = trashedCount(r);
  if (!n || !st.lastRun || st.lastRun === S.deletionsNoticed) return;
  S.deletionsNoticed = st.lastRun;
  if (Date.now() - new Date(st.lastRun) > 60000) return; // an old result replayed on connect
  toast(`${n} synced task${n === 1 ? ' was' : 's were'} deleted`, { label: 'Review', run: () => openDeleted() });
}

const delDlg = $('#dlg-deleted');
/** The Deleted tasks dialog: every note's, or (with `path`) just the tasks deleted from that note. */
function openDeleted({ path = null } = {}) {
  S.deletedScope = path;
  loadDeleted();
  if (!delDlg.open) delDlg.showModal();
}

async function loadDeleted() {
  const ul = $('#deleted-list');
  let list;
  try { list = await api('GET', '/api/deleted'); } catch (e) { ul.innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  const scope = S.deletedScope;
  if (scope) list = list.filter((d) => d.path === scope);
  const scopeEl = $('#deleted-scope');
  scopeEl.hidden = !scope;
  if (scope) scopeEl.querySelector('b').textContent = basename(scope);
  $('#deleted-empty').textContent = scope ? 'Nothing deleted from this note recently.' : 'Nothing deleted recently.';
  $('#deleted-empty').hidden = list.length > 0;
  $('#btn-empty-deleted').hidden = !list.length || !!scope;
  ul.hidden = !list.length;
  ul.innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li');
    const account = d.accountName && S.config?.accounts?.length > 1 ? d.accountName : null;
    // Where it was: the note, and the heading it sat under, so similar tasks are easy to tell apart.
    // (A note's own title heading, like "# Work" in Work.md, adds nothing.)
    const section = d.section && d.section.toLowerCase() !== basename(d.path || '').toLowerCase() ? d.section : null;
    const where = d.path ? `<span class="where">${esc(basename(d.path))}${section ? ` <span class="sep">›</span> <span class="section">${esc(section)}</span>` : ''}</span>` : '';
    li.innerHTML = `<span class="what"><b class="${d.model.done ? 'done-title' : ''}">${esc(d.title || '(untitled)')}</b>` +
      (where ? `<span class="meta">${where}</span>` : '') +
      `<span class="meta">${esc(SOURCE[d.source] || 'deleted')} ${esc(relTime(d.deleted_at))}${account ? ' · ' + esc(account) : ''}</span></span>` +
      `<span class="acts"><button type="button" class="btn" data-act="restore">Restore</button>` +
      `<button type="button" class="icon-btn" data-act="forget" aria-label="Delete ${esc(d.title)} forever" title="Delete forever">` +
      `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`;
    li.querySelector('[data-act="restore"]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api('POST', '/api/deleted/restore', { id: d.id });
        const into = r.section && r.section.toLowerCase() !== basename(r.path).toLowerCase() ? ` › ${r.section}` : '';
        toast(`Restored “${d.title}” to ${basename(r.path)}${into}`, { label: 'Open', run: () => { delDlg.close(); if (setDlg.open) setDlg.close(); open(r.path); } });
        loadDeleted();
        if (syncConfigured()) scheduleSync(1500);
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    };
    li.querySelector('[data-act="forget"]').onclick = async () => {
      if (!confirm(`Delete “${d.title}” forever? It can't be restored after this.`)) return;
      try { await api('DELETE', `/api/deleted?id=${d.id}`); loadDeleted(); } catch (err) { toast(err.message); }
    };
    ul.append(li);
  }
}
$('#btn-deleted-all').onclick = () => { S.deletedScope = null; loadDeleted(); };
$('#nav-deleted').onclick = () => openDeleted();
$('#btn-empty-deleted').onclick = async () => {
  if (!confirm("Delete everything in Deleted tasks forever? None of it can be restored after this.")) return;
  try { await api('DELETE', '/api/deleted?id=all'); loadDeleted(); } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- your account & users (multi-user mode)
function renderMe() {
  const multi = isMulti();
  $('#setup-admin').hidden = multi;
  $('#users-admin').hidden = !isAdmin();
  if (!multi) return;
  const u = S.me.user;
  $('#me-name').textContent = u.name;
  $('#me-badges').innerHTML = (u.admin ? '<span class="badge">admin</span>' : '') + (u.sso ? '<span class="badge">SSO</span>' : '');
  $('#me-password').hidden = !S.me.localLogin;
  $('#me-password-title').textContent = u.hasPassword ? 'Change password' : 'Set a password';
  $('#me-current-wrap').hidden = !u.hasPassword;
  $('#me-current').value = $('#me-new').value = '';
  $('#btn-change-password').textContent = u.hasPassword ? 'Change' : 'Set password';
  $('#new-user-password').placeholder = S.me.sso ? 'optional with SSO' : '';
  $('#users-note').textContent = 'Each user gets their own notes and CalDAV accounts.' +
    (S.me.sso ? ' People who sign in with SSO get an account automatically, unless the server is set up otherwise.' : '');
}

$('#btn-logout').onclick = async () => {
  if (!confirm('Sign out of Tickmark on this device?')) return;
  await flushSave();
  try { await api('POST', '/api/auth/logout'); } catch {}
  await clearApiCache();
  location.replace('/');
};

$('#btn-change-password').onclick = async () => {
  const pw = $('#me-new').value;
  if (pw.length < 8) return toast('Use at least 8 characters');
  try {
    await api('PUT', '/api/account/password', { current: $('#me-current').value, password: pw });
    S.me.user.hasPassword = true;
    renderMe();
    toast('Password changed. Other devices were signed out.');
  } catch (e) { toast(e.message); }
};

async function loadUsers() {
  if (!S.me?.user?.admin) return;
  const ul = $('#users-list');
  let list;
  try { list = await api('GET', '/api/users'); } catch (e) { ul.innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  ul.innerHTML = '';
  for (const u of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="who">${esc(u.name)}${u.admin ? '<span class="badge">admin</span>' : ''}${u.sso ? '<span class="badge">SSO</span>' : ''}` +
      `${!u.hasPassword && !u.sso ? ' <span class="note">(no password)</span>' : ''}</span>` +
      `<button type="button" class="icon-btn" aria-label="Actions for ${esc(u.name)}"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg></button>`;
    const self = u.name === S.me.user.name;
    li.querySelector('button').onclick = (e) => showMenu(e.currentTarget, [
      ...(self ? [] : [{ label: u.admin ? 'Remove admin rights' : 'Make admin', run: () => userAction('PUT', { name: u.name, admin: !u.admin }) }]),
      ...(S.me.localLogin ? [{ label: u.hasPassword ? 'Reset password…' : 'Set password…', run: async () => {
        const pw = await ask(`New password for ${u.name} (at least 8 characters)`);
        if (pw) userAction('PUT', { name: u.name, password: pw }, `${u.name}'s password was changed and their sessions signed out.`);
      } }] : []),
      ...(u.sso && !self ? [{ label: 'Unlink SSO identity', run: () => userAction('PUT', { name: u.name, unlinkSso: true }) }] : []),
      ...(self ? [] : [{ label: 'Remove user…', danger: true, run: () => {
        if (confirm(`Remove ${u.name}? They can no longer sign in. Their notes and settings stay on the server's disk.`)) userAction('DELETE', { name: u.name });
      } }]),
    ]);
    ul.append(li);
  }
}
async function userAction(method, body, done) {
  try {
    if (method === 'DELETE') await api('DELETE', `/api/users?name=${enc(body.name)}`);
    else await api(method, '/api/users', body);
    if (done) toast(done);
    loadUsers();
  } catch (e) { toast(e.message); }
}
$('#btn-add-user').onclick = async () => {
  const name = $('#new-user-name').value.trim(), password = $('#new-user-password').value;
  if (!name) return $('#new-user-name').focus();
  try {
    await api('POST', '/api/users', { name, password: password || undefined, admin: $('#new-user-admin').checked });
    $('#new-user-name').value = $('#new-user-password').value = '';
    $('#new-user-admin').checked = false;
    toast(`Added ${name.toLowerCase()}`);
    loadUsers();
  } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- turning sign-in on (single-user mode)
$('#btn-setup-admin').onclick = async () => {
  const name = $('#setup-name').value.trim(), pw = $('#setup-password').value;
  if (!name) return $('#setup-name').focus();
  if (pw.length < 8) return toast('Use at least 8 characters for the password');
  if (pw !== $('#setup-password2').value) return toast("The passwords don't match");
  if (!confirm(`Turn on sign-in with “${name.toLowerCase()}” as admin? Everyone, including you, will need to sign in from now on, starting right after this.`)) return;
  await flushSave();
  try {
    const { user } = await api('POST', '/api/setup/admin', { name, password: pw });
    // Start over at the sign-in screen, as everyone else will.
    try {
      sessionStorage.setItem('tickmark:notice', `Sign-in is on. Sign in as ${user.name} to continue.`);
      sessionStorage.setItem('tickmark:username', user.name);
    } catch {}
    await clearApiCache();
    location.replace('/');
  } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- single sign-on (admins)
const ssoForm = $('#sso-form');
const ssoFields = () => [...ssoForm.querySelectorAll('[data-k]')];
let ssoState = null;

async function loadSso() {
  $('#sso-needs-admin').hidden = isMulti();
  $('#sso-body').hidden = $('#sso-foot').hidden = !isAdmin();
  if (!isAdmin()) return;
  try { ssoState = await api('GET', '/api/admin/sso'); } catch (e) { toast(e.message); return; }
  renderSso();
}

function renderSso() {
  const st = ssoState;
  const locked = new Set(st.locked);
  $('#sso-status').innerHTML = `<span class="dot${st.enabled ? ' on' : ''}"></span>` + (st.enabled
    ? `SSO is on, via <b>${esc(st.values.TICKMARK_OIDC_ISSUER)}</b>. ${st.encrypted ? 'CalDAV settings are stored encrypted with the client secret.' : 'No client secret, so CalDAV settings are not encrypted.'}`
    : 'SSO is off. Fill in your provider’s details and save to turn it on.');
  $('#sso-problem').hidden = !st.problem;
  $('#sso-problem').textContent = st.problem || '';
  $('#sso-redirect').value = st.redirectUri;
  $('#btn-sso-off').hidden = !st.enabled || locked.has('TICKMARK_OIDC_ISSUER');
  for (const el of ssoFields()) {
    const k = el.dataset.k;
    const isLocked = locked.has(k);
    if (el.type === 'checkbox') {
      const v = st.values[k];
      el.checked = v ? /^(1|true|yes|on)$/i.test(v) : el.dataset.default === 'true';
    } else if (k === 'TICKMARK_OIDC_CLIENT_SECRET') {
      el.value = '';
      el.placeholder = st.secretSet ? '•••••• (unchanged)' : '';
    } else {
      el.value = st.values[k] || '';
    }
    if (k === 'TICKMARK_PUBLIC_URL') el.placeholder = st.suggestedPublicUrl;
    el.disabled = isLocked || (k === 'TICKMARK_OIDC_CLIENT_SECRET' && !st.masterKey);
    const label = el.closest('label');
    label.querySelector('.locked-tag')?.remove();
    if (isLocked) label.insertAdjacentHTML(el.type === 'checkbox' ? 'beforeend' : 'afterbegin', '<span class="locked-tag" title="Set in Tickmark’s environment (.env)">.env</span>');
  }
  $('#sso-locked-note').hidden = !locked.size;
  $('#sso-secret-note').textContent = locked.has('TICKMARK_OIDC_CLIENT_SECRET') ? ''
    : st.masterKey ? 'Stored encrypted in Tickmark’s database, with TICKMARK_SECRET_KEY from .env as the key. It also becomes the key for everyone’s CalDAV settings.'
    : 'To save a client secret here, first set TICKMARK_SECRET_KEY in .env (for example the output of: openssl rand -base64 32) and restart Tickmark.';
  $('#sso-test-msg').textContent = '';
}

$('#btn-copy-redirect').onclick = async () => {
  try { await navigator.clipboard.writeText($('#sso-redirect').value); toast('Redirect URI copied'); }
  catch { $('#sso-redirect').select(); }
};

$('#btn-sso-test').onclick = async () => {
  const msg = $('#sso-test-msg');
  msg.className = 'note';
  msg.textContent = 'Contacting the provider…';
  try {
    const r = await api('POST', '/api/admin/sso/test', { issuer: ssoForm.querySelector('[data-k="TICKMARK_OIDC_ISSUER"]').value });
    if (r.ok) {
      msg.textContent = `✓ Found the provider (${r.issuer}).` + (r.scopes?.includes('groups') ? ' It offers a “groups” scope; add it under Advanced if groups don’t come through.' : '');
    } else { msg.className = 'note err'; msg.textContent = r.error; }
  } catch (e) { msg.className = 'note err'; msg.textContent = e.message; }
};

async function saveSso(patch, done) {
  try {
    ssoState = await api('PUT', '/api/admin/sso', patch);
    renderSso();
    S.me = await api('GET', '/api/auth/me');
    store.set('me', S.me);
    renderMe();
    toast(done);
  } catch (e) { toast(e.message); }
}

ssoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of ssoFields()) {
    if (el.disabled) continue;
    if (el.type === 'checkbox') patch[el.dataset.k] = el.checked ? 'true' : 'false';
    else if (el.dataset.k === 'TICKMARK_OIDC_CLIENT_SECRET') { if (el.value) patch[el.dataset.k] = el.value; }
    else patch[el.dataset.k] = el.value.trim();
  }
  if (!patch.TICKMARK_OIDC_ISSUER && !ssoState.enabled && !ssoState.locked.includes('TICKMARK_OIDC_ISSUER')) return toast('Enter the issuer URL');
  saveSso(patch, ssoState.enabled || patch.TICKMARK_OIDC_ISSUER ? 'SSO settings saved and applied' : 'Saved');
});

$('#btn-sso-off').onclick = () => {
  if (!confirm('Turn off single sign-on? People who only sign in with SSO won’t be able to get in until it’s back on. The client secret is kept, so encrypted settings stay readable.')) return;
  saveSso({ TICKMARK_OIDC_ISSUER: '' }, 'SSO is off');
};

// ---------------------------------------------------------------- sign-in
async function clearApiCache() {
  try {
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith('/api/')) await c.delete(req);
    }
  } catch {}
}

let loginWaiter = null;
function showLogin(message = '', kind = 'err') {
  const me = S.me || {};
  $('#login-local').hidden = me.localLogin === false;
  $('#login-sso').hidden = !me.sso;
  $('#login-sso').textContent = me.sso?.label || 'Sign in with SSO';
  $('#login-or').hidden = me.localLogin === false || !me.sso;
  $('#login-msg').textContent = message;
  $('#login-msg').className = `note ${kind}`;
  $('#login').hidden = false;
  if (me.localLogin !== false) setTimeout(() => $('#login-form').username.focus(), 50);
  return loginWaiter || (loginWaiter = new Promise((res) => { showLogin.done = res; }));
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  $('#login-msg').textContent = '';
  try {
    const { user } = await api('POST', '/api/auth/login', { username: f.username.value.trim(), password: f.password.value });
    f.password.value = '';
    // Signing in as someone else mid-session: start clean rather than mix two people's state.
    if (S.me?.user && S.me.user.name !== user.name) { await clearApiCache(); return location.replace('/'); }
    S.me = { ...S.me, user };
    // Session ended mid-use: reload so live updates reconnect and edits held on the device get saved.
    if (S.booted) return location.reload();
    $('#login').hidden = true;
    loginWaiter = null;
    showLogin.done?.(user);
  } catch (err) { $('#login-msg').textContent = err.message; }
});

// ---------------------------------------------------------------- live updates from the server
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('file', (e) => {
    const d = JSON.parse(e.data);
    if (d.path === S.path && d.hash !== S.hash) reloadIfClean();
  });
  es.addEventListener('tree', () => scheduleTree());
  es.addEventListener('sync', (e) => {
    S.sync = JSON.parse(e.data);
    renderSync();
    noticeDeletions(S.sync);
  });
  es.onopen = () => flushPending();
}

// ---------------------------------------------------------------- global shortcuts
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); save(); }
  else if (k === 'p' || k === 'o') { e.preventDefault(); openSwitcher(); }
  else if (k === 'e') { e.preventDefault(); cycleView(); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newNote(); }
  else if (k === '\\') { e.preventDefault(); toggleSidebar(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); if (mobile.matches) el.app.classList.add('sidebar-open'); el.search.focus(); }
});

// ---------------------------------------------------------------- boot
async function boot() {
  api('GET', '/api/branding').then(applyBranding).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { S.me = await api('GET', '/api/auth/me'); store.set('me', S.me); } catch { S.me = store.get('me'); /* offline */ }
  if (S.me?.mode === 'multi') {
    const err = new URLSearchParams(location.search).get('login_error');
    if (err) history.replaceState(null, '', location.pathname + location.hash);
    if (!S.me.user) {
      await clearApiCache();
      // Just turned sign-in on (Settings → Users): say so, and fill in the new admin's name.
      let notice = null, name = null;
      try {
        notice = sessionStorage.getItem('tickmark:notice'); name = sessionStorage.getItem('tickmark:username');
        sessionStorage.removeItem('tickmark:notice'); sessionStorage.removeItem('tickmark:username');
      } catch {}
      if (name) $('#login-form').username.value = name;
      const waiting = showLogin(err || notice || '', err ? 'err' : 'ok');
      if (name && !err) setTimeout(() => $('#login-form').password.focus(), 60);
      await waiting;
    }
    store.user = S.me.user.name;
    store.set('me', S.me);
    // Re-read per-user state now that we know whose it is.
    S.config = store.get('config');
    S.openFolders = new Set(store.get('openFolders', []));
  }
  try { S.config = await api('GET', '/api/config'); store.set('config', S.config); } catch {}
  if (S.config) applyCustomCss();
  try { S.sync = await api('GET', '/api/sync'); } catch {}
  await loadTree();
  connectEvents();
  setupSyncTimer();
  renderSync();
  applyView();
  if (location.hash.length > 1) routeFromHash();
  else {
    const last = store.get('last');
    if (last && S.files.some((f) => f.path === last)) open(last, { push: false });
  }
  flushPending();
  S.booted = true;
  if (syncConfigured()) setTimeout(() => runSync(), 1500);
}
boot();
