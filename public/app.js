import { marked } from './vendor/marked.esm.js';
import { checkboxLines, toggleLine, setTaskState, fileCompleted, openSubtasks, parseTasks, normTag, localDate } from './shared/tasks.js';
import { parseRecurrence, describeRecurrence } from './shared/recur.js';
import { textStats } from './shared/words.js';
import { parseFrontmatter, writeFrontmatter } from './shared/frontmatter.js';
import { highlight } from './shared/highlight.js';
import { Vim } from './vim.js';

// ---------------------------------------------------------------- utilities
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// Per-user keys (notes cache, unsaved edits, settings) are namespaced by the signed-in user, so two
// people sharing a browser never see, or save into, each other's notes. View prefs are per device.
const DEVICE_KEYS = new Set(['view', 'noSidebar', 'vim', 'lineNumbers', 'sideWidth']);
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

/** A short notice; `action` is { label, run } or a list of them (shown as buttons). */
function toast(msg, action) {
  const actions = action ? [].concat(action) : [];
  el.toast.innerHTML = esc(msg) + actions.map((a) => ` <button>${esc(a.label)}</button>`).join('');
  el.toast.querySelectorAll('button').forEach((b, i) => (b.onclick = () => { el.toast.classList.remove('show'); actions[i].run(); }));
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), action ? 7000 : 3200);
}

/** A menu of { label, run, danger } items. An item with `expand(button)` grows inside the menu instead of closing it. */
function showMenu(anchor, items) {
  el.menu.innerHTML = '';
  el.menu.anchor = anchor;
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { if (it.expand) { it.expand(b); placeMenu(); } else { hideMenu(); it.run(); } };
    el.menu.append(b);
  }
  el.menu.hidden = false;
  placeMenu();
}
function placeMenu() {
  const r = el.menu.anchor.getBoundingClientRect();
  const mw = el.menu.offsetWidth, mh = el.menu.offsetHeight;
  el.menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  el.menu.style.top = Math.max(8, r.bottom + mh + 8 > innerHeight ? Math.min(r.top - mh - 4, innerHeight - mh - 8) : r.bottom + 4) + 'px';
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
    // Fenced code: highlighted for its language, with the language's name on the block.
    code({ text, lang }) {
      const h = highlight(text.replace(/\n$/, ''), lang);
      return `<div class="codeblock" data-family="${esc(h.family)}"${h.label ? ` data-lang="${esc(h.label)}"` : ''}><pre><code>${h.html}</code></pre></div>\n`;
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
      renderer(t) {
        // ![[Note]] (or ![[Note#Heading]]) shows that note inside this one; filled in after rendering.
        if (t.raw.startsWith('!')) return `<span class="embed" data-target="${esc(t.target)}"></span>`;
        return `<a href="#" class="wikilink" data-target="${esc(t.target)}">${esc(t.label)}</a>`;
      },
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

/** Markdown only knows [ ] and [x]: draw "[/] …" (in progress) and "[-] …" (cancelled) items as checkboxes too. */
function drawStates(root) {
  root.querySelectorAll('li').forEach((li) => {
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
}

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
  drawStates(el.preview);
  el.preview.querySelectorAll('input.task-cb').forEach((cb, i) => (cb.dataset.i = i));

  const lines = checkboxLines(text);
  const synced = new Set(isTemplate(S.path) ? [] : parseTasks(text, tagOpts()).filter((t) => t.synced).map((t) => t.line));
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
  applyFolds(true);
  fillEmbeds(el.preview, [S.path]);
}

// ---- embedded notes: ![[Note]] and ![[Note#Heading]], read-only, up to three levels deep
const embedCache = new Map(); // path → { mtime, content }
async function embedText(path) {
  const mtime = S.files.find((f) => f.path === path)?.mtime;
  const hit = embedCache.get(path);
  if (hit && hit.mtime === mtime) return hit.content;
  const f = await api('GET', `/api/file?path=${enc(path)}`);
  embedCache.set(path, { mtime, content: f.content });
  return f.content;
}
/** The part of a note under a heading (to the next heading of the same or a higher level), and its first line. */
function sectionOf(text, heading) {
  const lines = text.split('\n');
  const want = heading.trim().toLowerCase();
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) return { text: lines.slice(start, i).join('\n'), start };
    if (start < 0 && h[2].replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, '').trim().toLowerCase() === want) { start = i; level = h[1].length; }
  }
  return start >= 0 ? { text: lines.slice(start).join('\n'), start } : null;
}
async function fillEmbeds(root, chain) {
  const path0 = S.path;
  for (const box of root.querySelectorAll('span.embed:not([data-done])')) {
    box.dataset.done = '1';
    const [name, heading] = box.dataset.target.split('#');
    const f = resolveLink(name);
    const title = `${f ? basename(f.path) : name}${heading ? ' › ' + heading : ''}`;
    box.innerHTML = `<a href="#" class="embed-title wikilink" data-target="${esc(box.dataset.target)}">${esc(title)}</a><span class="embed-body"></span>`;
    const body = box.querySelector('.embed-body');
    if (!f) { box.classList.add('missing'); body.textContent = 'No such note yet.'; continue; }
    if (chain.includes(f.path) || chain.length > 3) { body.textContent = chain.includes(f.path) ? 'Embeds itself, so it isn\'t shown here.' : 'Nested too deep to show.'; continue; }
    try {
      const full = await embedText(f.path);
      let text, lines;
      if (heading) {
        const sec = sectionOf(full, heading);
        text = sec ? sec.text : `*No heading “${heading}” in ${basename(f.path)}.*`;
        lines = sec ? checkboxLines(sec.text).map((l) => l + sec.start) : [];
      } else {
        text = full.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
        lines = checkboxLines(full); // skips the frontmatter itself, so line numbers are the file's
      }
      if (S.path !== path0) return; // moved on to another note meanwhile
      const save = cbIndex;
      body.innerHTML = marked.parse(text);
      cbIndex = save;
      // Checkboxes in an embed edit the other note's line (a click, or right-click for a state).
      drawStates(body);
      body.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        const li = cb.closest('li');
        cb.className = 'task-cb embed-task';
        if (lines[i] == null) { cb.disabled = true; return; }
        cb.dataset.epath = f.path;
        cb.dataset.line = lines[i];
        cb.title = `In ${basename(f.path)}`;
        if (cb.dataset.state === 'progress') { cb.indeterminate = true; li?.classList.add('progress-item'); }
        if (cb.dataset.state === 'cancelled') li?.classList.add('cancelled-item');
        if (cb.checked) li?.classList.add('done-item');
      });
      body.dataset.foldKey = `fold:${S.path}>${box.dataset.target}`;
      applyFolds(true, body);
      body.querySelectorAll('a.wikilink').forEach((a) => { if (!resolveLink(a.dataset.target)) a.classList.add('missing'); });
      await fillEmbeds(body, [...chain, f.path]);
    } catch (e) { body.textContent = `Couldn't load it: ${e.message}`; }
  }
}

// ---- collapsible headings in the preview (remembered per note, on this device)
const foldKey = (h) => `${h.tagName}:${h.textContent.trim()}`;
/** Where a container's folds are remembered: the note's preview, or an embed inside it. */
const foldStore = (root) => (root === el.preview ? 'fold:' + S.path : root.dataset.foldKey);
/** Hide what's under each collapsed heading, up to the next heading of the same or a higher level. */
function applyFolds(addButtons = false, root = el.preview) {
  const folded = new Set(store.get(foldStore(root), []));
  let hideBelow = 0; // while > 0, hide everything until a heading of this level or higher
  for (const node of root.children) {
    const lvl = /^H([1-6])$/.exec(node.tagName)?.[1];
    if (lvl && addButtons && !node.querySelector(':scope > .fold')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fold';
      b.setAttribute('aria-label', 'Collapse or expand this section');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
      node.prepend(b);
    }
    if (lvl && hideBelow && +lvl <= hideBelow) hideBelow = 0;
    node.classList.toggle('folded-away', !!hideBelow);
    if (lvl && !hideBelow) {
      const closed = folded.has(foldKey(node));
      node.classList.toggle('folded', closed);
      node.querySelector(':scope > .fold')?.setAttribute('aria-expanded', String(!closed));
      if (closed) hideBelow = +lvl;
    }
  }
}
function toggleFold(h) {
  const root = h.parentElement, key = foldStore(root);
  if (!key) return;
  const k = foldKey(h);
  const folded = new Set(store.get(key, []));
  if (folded.has(k)) folded.delete(k); else folded.add(k);
  if (folded.size) store.set(key, [...folded]); else store.del(key);
  applyFolds(false, root);
}

/** Change a line in an embedded note (a checkbox clicked in its embed), then show the result. */
async function editEmbedded(path, fn) {
  try {
    const f = await api('GET', `/api/file?path=${enc(path)}`);
    const next = fn(f.content);
    if (next === f.content) return;
    await api('PUT', `/api/file?path=${enc(path)}`, { content: next, baseContent: f.content });
    embedCache.delete(path);
    renderPreview();
    scheduleSync(1500);
  } catch (e) { toast(`Couldn't change ${basename(path)}: ${e.message}`); }
}
const schedulePreview = (() => { let raf = 0; return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderPreview); }; })();

const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const TASK_STATES = [[' ', 'todo', 'to do'], ['/', 'progress', 'in progress'], ['x', 'done', 'done'], ['-', 'cancelled', 'cancelled']];
/** The bar under the note: words and characters, lines (with line numbers on), its checklist items by state, and its public link. */
function renderWordCount() {
  if (S.mode !== 'note') return;
  const text = el.editor.value;
  const { words, chars } = textStats(text);
  $('#wc-words').textContent = `${plural(words, 'word')} · ${plural(chars, 'character')}`;
  const lines = text.split('\n');
  $('#wc-lines').hidden = !S.lineNumbers;
  if (S.lineNumbers) $('#wc-lines').textContent = plural(lines.length, 'line');
  const count = { ' ': 0, '/': 0, x: 0, '-': 0 };
  for (const ln of checkboxLines(text)) { const ch = lines[ln].match(/\[([ xX/-])\]/)?.[1]; if (ch) count[ch === 'X' ? 'x' : ch]++; }
  const shown = TASK_STATES.filter(([ch]) => count[ch]);
  const tasks = $('#wc-tasks');
  tasks.hidden = !shown.length;
  tasks.innerHTML = shown.map(([ch, cls, name]) => `<span class="st-count" title="${count[ch]} ${name}"><span class="st st-${cls}"></span>${count[ch]} ${name}</span>`).join('');
  tasks.title = 'Checklist items in this note';
  renderShareBadge();
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
  // Filed again when it opens, finishes, or switches between done and cancelled (Complete ⇄ Cancelled).
  const kind = (c) => (c === '-' ? 'cancelled' : 'xX'.includes(c) ? 'done' : 'open');
  if (S.config?.moveCompleted === false || kind(ch) === kind(was)) return next;
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

// ---- [[wikilink]] suggestions: typing [[ lists matching notes; ↑/↓ to pick, Enter or Tab to insert.
const suggest = { box: null, items: [], i: 0, start: 0 };
/** A hidden copy of a textarea's text box (same font, padding and wrapping width), for measuring. */
function textMirror(ta) {
  let m = textMirror.el;
  if (!m) { m = textMirror.el = document.createElement('div'); m.setAttribute('aria-hidden', 'true'); document.body.append(m); }
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textTransform', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) m.style[p] = cs[p];
  // clientWidth leaves out the scrollbar, so lines wrap where the textarea wraps them.
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    wordWrap: 'break-word', boxSizing: 'border-box', border: '0', width: ta.clientWidth + 'px', height: 'auto', overflow: 'hidden' });
  return m;
}
/** Where a position in a textarea is: on screen (x, y), and from the top of its text (top, for scrolling). */
function caretXY(ta, pos) {
  const m = textMirror(ta);
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  m.append(mark);
  const r = ta.getBoundingClientRect();
  return { x: r.left + ta.clientLeft + mark.offsetLeft - ta.scrollLeft, y: r.top + ta.clientTop + mark.offsetTop - ta.scrollTop,
    top: mark.offsetTop, h: parseFloat(getComputedStyle(ta).lineHeight) || 20 };
}
function closeSuggest() { suggest.box?.remove(); suggest.box = null; suggest.items = []; }

// ---- :shortcodes: for task metadata. Typing ":cal" offers 📅 and friends; ":calendar:" turns into it.
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDate(d); };
const SHORTCODES = [
  { code: 'calendar', alias: ['due', 'date'], emoji: '📅', label: 'Due today', text: () => `📅 ${today()}`, select: 'date' },
  { code: 'tomorrow', emoji: '📅', label: 'Due tomorrow', text: () => `📅 ${addDays(1)}`, select: 'date' },
  { code: 'nextweek', emoji: '📅', label: 'Due in a week', text: () => `📅 ${addDays(7)}`, select: 'date' },
  { code: 'recur', alias: ['repeat', 'every'], emoji: '🔁', label: 'Repeats…', text: () => '🔁 every ' },
  { code: 'highest', emoji: '🔺', label: 'Highest priority', text: () => '🔺' },
  { code: 'high', alias: ['priority'], emoji: '⏫', label: 'High priority', text: () => '⏫' },
  { code: 'medium', emoji: '🔼', label: 'Medium priority', text: () => '🔼' },
  { code: 'low', emoji: '🔽', label: 'Low priority', text: () => '🔽' },
  { code: 'lowest', emoji: '⏬', label: 'Lowest priority', text: () => '⏬' },
  { code: 'done', emoji: '✅', label: 'Done today', text: () => `✅ ${today()}`, select: 'date' },
];
const SHORT_RE = /(^|[\s(])(:([a-z]{1,12}))$/i;
function insertShortcode(sc, start, end) {
  const ed = el.editor;
  const t = sc.text(), after = ed.value[end];
  const pad = sc.select || t.endsWith(' ') || after === ' ' ? '' : ' ';
  replaceRange(start, end, t + pad);
  // A date comes out selected, so typing replaces it.
  if (sc.select === 'date') { const d = start + t.lastIndexOf(' ') + 1; ed.setSelectionRange(d, d + 10); }
}
// Typing the closing colon of a full code converts it straight away.
el.editor.addEventListener('input', (e) => {
  if (!e.data?.endsWith(':')) return;
  const ed = el.editor, pos = ed.selectionStart;
  const m = /(^|[\s(]):([a-z]{2,12}):$/i.exec(ed.value.slice(Math.max(0, pos - 16), pos));
  const sc = m && SHORTCODES.find((x) => x.code === m[2].toLowerCase() || x.alias?.includes(m[2].toLowerCase()));
  if (sc) { closeSuggest(); insertShortcode(sc, pos - m[2].length - 2, pos); }
});

function updateSuggest() {
  const ed = el.editor;
  if (ed.selectionStart !== ed.selectionEnd) return closeSuggest();
  const pos = ed.selectionStart;
  const before = ed.value.slice(ed.value.lastIndexOf('\n', pos - 1) + 1, pos);
  const sm = !/\[\[[^\]]*$/.test(before) && SHORT_RE.exec(before);
  if (sm) {
    const q = sm[3].toLowerCase();
    const hits = SHORTCODES.filter((x) => x.code.startsWith(q) || x.alias?.some((a) => a.startsWith(q)));
    if (!hits.length) return closeSuggest();
    suggest.mode = 'code';
    suggest.items = hits;
    suggest.start = pos - sm[2].length;
    suggest.i = Math.min(suggest.i, hits.length - 1);
    renderSuggestBox(hits.map((x) => `${x.emoji} ${esc(x.label)} <span class="dir">:${x.code}:</span>`));
    return;
  }
  const m = /\[\[([^\]|#^\n]*)$/.exec(before);
  if (!m) return closeSuggest();
  const q = m[1].trim().toLowerCase();
  const scored = S.files.filter((f) => f.path !== S.path && !isTemplate(f.path)).map((f) => {
    const name = basename(f.path).toLowerCase(), full = f.path.toLowerCase();
    const score = !q ? 3 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : full.includes(q) ? 2 : -1;
    return { f, score };
  }).filter((x) => x.score >= 0).sort((a, b) => a.score - b.score || basename(a.f.path).localeCompare(basename(b.f.path))).slice(0, 8);
  if (!scored.length) return closeSuggest();
  suggest.mode = 'link';
  suggest.items = scored.map((x) => x.f.path);
  suggest.start = pos - m[1].length;
  suggest.i = Math.min(suggest.i, suggest.items.length - 1);
  renderSuggestBox(suggest.items.map((p) => `${esc(basename(p))}${dirname(p) ? ` <span class="dir">${esc(dirname(p))}</span>` : ''}`));
}
function renderSuggestBox(rows) {
  const ed = el.editor;
  if (!suggest.box) {
    suggest.box = document.createElement('div');
    suggest.box.className = 'menu suggest';
    suggest.box.setAttribute('role', 'listbox');
    suggest.box.addEventListener('mousedown', (e) => { // mousedown, so the editor keeps focus
      const b = e.target.closest('button');
      if (b) { e.preventDefault(); pickSuggest(+b.dataset.i); }
    });
    document.body.append(suggest.box);
  }
  suggest.box.innerHTML = rows.map((html, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === suggest.i}">${html}</button>`).join('');
  const c = caretXY(ed, suggest.start);
  const top = c.y + c.h + 4, below = top + suggest.box.offsetHeight < innerHeight;
  Object.assign(suggest.box.style, { left: `${Math.min(c.x, innerWidth - suggest.box.offsetWidth - 8)}px`, top: `${below ? top : c.y - suggest.box.offsetHeight - 4}px` });
}
function pickSuggest(i) {
  if (suggest.mode === 'code') {
    const sc = suggest.items[i];
    if (sc) { const end = el.editor.selectionStart; closeSuggest(); insertShortcode(sc, suggest.start, end); }
    return;
  }
  const path = suggest.items[i];
  if (!path) return;
  const ed = el.editor, name = basename(path);
  // A name that more than one note has gets its folder too.
  const target = S.files.filter((f) => basename(f.path).toLowerCase() === name.toLowerCase()).length > 1 ? path.replace(/\.md$/i, '') : name;
  const end = ed.selectionStart;
  const closing = ed.value.slice(end, end + 2) === ']]' ? '' : ']]';
  replaceRange(suggest.start, end, target + closing);
  if (!closing) ed.setSelectionRange(suggest.start + target.length + 2, suggest.start + target.length + 2);
  closeSuggest();
}
el.editor.addEventListener('keydown', (e) => {
  if (!suggest.box) return;
  const n = suggest.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { suggest.i = (suggest.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; }
  else if (e.key === 'Enter' || e.key === 'Tab') { pickSuggest(suggest.i); }
  else if (e.key === 'Escape') { closeSuggest(); }
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (suggest.box) updateSuggest();
}, true);
el.editor.addEventListener('input', () => { suggest.i = 0; updateSuggest(); });
el.editor.addEventListener('click', updateSuggest);
el.editor.addEventListener('blur', closeSuggest);
el.editor.addEventListener('scroll', closeSuggest);

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
    const [ls, le] = lineBounds(v, s);
    const line = v.slice(ls, le);
    // A checklist item stops being one (back to the plain line); anything else becomes one.
    const cb = line.match(/^(\s*(?:>\s*)*)(?:[-*+]|\d+[.)])\s+\[[ xX/-]\]\s?/);
    if (cb) replaceRange(ls + cb[1].length, ls + cb[0].length, '');
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

// ---- line numbers (Settings → Editor): a gutter beside the text, one number per line however it wraps
const gutter = $('#gutter'), gutterIn = gutter.firstElementChild;
S.lineNumbers = !!store.get('lineNumbers', false);
function setLineNumbers(on) {
  S.lineNumbers = !!on;
  store.set('lineNumbers', S.lineNumbers);
  el.app.classList.toggle('line-numbers', S.lineNumbers);
  renderGutter();
  renderWordCount();
}
el.app.classList.toggle('line-numbers', S.lineNumbers);
function renderGutter() {
  const ed = el.editor;
  if (!S.lineNumbers || S.mode !== 'note' || effectiveView() === 'read' || ed.hidden) { gutter.hidden = true; return; }
  gutter.hidden = false;
  const cs = getComputedStyle(ed), m = textMirror(ed);
  const lines = ed.value.split('\n');
  m.innerHTML = lines.map((l) => `<div>${esc(l) || ' '}</div>`).join('');
  const heights = [...m.children].map((d) => d.offsetHeight);
  m.textContent = '';
  const padL = parseFloat(cs.paddingLeft), W = 44;
  Object.assign(gutter.style, { top: ed.offsetTop + 'px', left: Math.max(0, ed.offsetLeft + padL - W - 14) + 'px', width: W + 'px', height: ed.clientHeight + 'px' });
  gutterIn.style.paddingTop = cs.paddingTop;
  gutterIn.style.lineHeight = cs.lineHeight;
  gutterIn.innerHTML = heights.map((h, i) => `<div style="height:${h}px">${i + 1}</div>`).join('');
  gutterIn.style.transform = `translateY(${-ed.scrollTop}px)`;
  markGutterLine();
}
function markGutterLine() {
  if (gutter.hidden) return;
  const ln = el.editor.value.slice(0, el.editor.selectionStart).split('\n').length - 1;
  gutterIn.querySelector('.cur')?.classList.remove('cur');
  gutterIn.children[ln]?.classList.add('cur');
}
const scheduleGutter = debounce(renderGutter, 120);
el.editor.addEventListener('scroll', () => { if (!gutter.hidden) gutterIn.style.transform = `translateY(${-el.editor.scrollTop}px)`; renderCursorsSoon(); });
el.editor.addEventListener('input', () => { scheduleGutter(); renderCursorsSoon(); });
document.addEventListener('selectionchange', () => { if (document.activeElement === el.editor) markGutterLine(); });
addEventListener('resize', debounce(() => { renderGutter(); renderCursors(); sizeTitle(); }, 150));

// ---- other people's cursors (live collaboration): a coloured caret with their name, where they are in the text
function renderCursors() {
  const box = $('#cursors');
  const ed = el.editor;
  const others = othersHere().filter((p) => p.line != null);
  if (!others.length || S.mode !== 'note' || effectiveView() === 'read' || ed.hidden) { box.innerHTML = ''; return; }
  const lines = ed.value.split('\n');
  const wr = $('#workspace').getBoundingClientRect(), er = ed.getBoundingClientRect();
  box.innerHTML = others.map((p) => {
    const ln = Math.min(p.line, lines.length - 1);
    let off = 0;
    for (let i = 0; i < ln; i++) off += lines[i].length + 1;
    off += Math.min(p.col ?? 0, lines[ln].length);
    const c = caretXY(ed, off);
    const name = p.name ? `${p.name} · ${p.device}` : p.device;
    // Above or below what's showing: a marker on that edge of the editor instead.
    const edge = c.y < er.top ? 'above' : c.y + c.h > er.bottom ? 'below' : null;
    const top = edge === 'above' ? er.top - wr.top : edge === 'below' ? er.bottom - wr.top - 20 : c.y - wr.top;
    return `<span class="rcursor${edge ? ' edge ' + edge : ''}" style="--h:${hue(p.id)};left:${Math.max(er.left - wr.left, c.x - wr.left)}px;top:${top}px;height:${edge ? 20 : c.h}px">` +
      `<span class="rname">${edge === 'above' ? '↑ ' : edge === 'below' ? '↓ ' : ''}${esc(name)}</span></span>`;
  }).join('');
}
const renderCursorsSoon = (() => { let raf = 0; return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCursors); }; })();

// ---- Vim mode (Settings → Editor, per device)
const vim = new Vim(el.editor, {
  replace: (s0, e0, t) => replaceRange(s0, e0, t),
  save: () => save(),
  quit: () => closeNote(),
  open: (name) => openLink(name),
  help: () => openKeys('vim'),
  prompt: (prefix, value) => vimPrompt(prefix, value),
  onMode: (label) => { const m = $('#vim-mode'); m.hidden = !label; m.textContent = label; m.dataset.mode = vim?.mode || ''; },
  toast: (msg) => toast(msg),
  caretTop: (p) => caretXY(el.editor, p).top,
  lineHeight: () => parseFloat(getComputedStyle(el.editor).lineHeight) || 24,
  setOption: (k, v) => { if (k === 'number') setLineNumbers(v); },
});
S.vim = !!store.get('vim', false);
if (S.vim) vim.enable();
function setVim(on) {
  S.vim = !!on;
  store.set('vim', S.vim);
  if (S.vim) vim.enable(); else vim.disable();
  if (!S.vim) $('#vim-mode').hidden = true;
}
/** The : and / line of Vim mode, in the bottom bar. Resolves with what was typed, or null for Esc. */
function vimPrompt(prefix, value = '') {
  const form = $('#vim-prompt'), input = form.querySelector('input');
  form.querySelector('.vim-prefix').textContent = prefix;
  input.value = value;
  form.hidden = false;
  input.focus();
  return new Promise((res) => {
    const done = (v) => { form.hidden = true; form.onsubmit = input.onkeydown = input.onblur = null; res(v); };
    form.onsubmit = (e) => { e.preventDefault(); done(input.value); };
    input.onkeydown = (e) => {
      if (e.key === 'Escape' || (e.key === 'Backspace' && !input.value)) { e.preventDefault(); e.stopPropagation(); done(null); }
    };
    input.onblur = () => setTimeout(() => { if (!form.hidden) done(null); }, 0);
  });
}

// ---------------------------------------------------------------- preview interaction
// Right-click a checkbox in the preview to pick its state.
el.preview.addEventListener('contextmenu', (e) => {
  const cb = e.target.closest('input.task-cb');
  const line = cb && Number(cb.dataset.line);
  if (!cb || cb.disabled || Number.isNaN(line)) return;
  e.preventDefault();
  const epath = cb.dataset.epath;
  const pick = (ch) => () => (epath ? editEmbedded(epath, (t) => setTaskStateFiled(t, line, ch)) : applyEdit(setTaskStateFiled(el.editor.value, line, ch)));
  showMenu(cb, [
    { label: 'To do  [ ]', run: pick(' ') }, { label: 'In progress  [/]', run: pick('/') },
    { label: 'Done  [x]', run: pick('x') }, { label: 'Cancelled  [-]', run: pick('-') },
  ]);
});
el.preview.addEventListener('click', (e) => {
  const fold = e.target.closest('.fold');
  if (fold) { e.preventDefault(); toggleFold(fold.parentElement); return; }
  const cb = e.target.closest('input.task-cb');
  if (cb) {
    e.preventDefault();
    const line = Number(cb.dataset.line);
    if (Number.isNaN(line)) return;
    if (cb.dataset.epath) editEmbedded(cb.dataset.epath, (t) => toggleTask(t, line));
    else applyEdit(toggleTask(el.editor.value, line));
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
const slowSave = debounce(() => save(), TYPING_PAUSE);
const liveSave = debounce(() => save(), 800); // someone else has the note open: share edits quickly
const scheduleSave = () => (othersHere().length ? liveSave() : slowSave());
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
  else {
    checkForUpdate();
    if (syncConfigured() && Date.now() - S.lastSyncAt > 60000) runSync();
  }
});

// ---- staying current: an installed app (on a phone especially) can sit open for days. When you come
// back to it, ask the server which version it runs, and reload into it if that's not this one.
const BUILD = document.querySelector('meta[name="tickmark-build"]')?.content || 'dev';
async function checkForUpdate() {
  if (BUILD === 'dev' || Date.now() - (checkForUpdate.at || 0) < 30000) return;
  checkForUpdate.at = Date.now();
  let build;
  try { build = (await (await fetch('/api/version', { cache: 'no-store' })).json()).build; } catch { return; } // offline
  if (!build || build === BUILD) return;
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  // Reload once per new version; if the page still comes back old, offer it rather than loop.
  let tried = null;
  try { tried = sessionStorage.getItem('tickmark:reloadedFor'); } catch {}
  if (tried === build) return toast('A new version of Tickmark is available', { label: 'Reload', run: () => location.reload() });
  await flushSave();
  if (S.mode === 'note' && el.editor.value !== S.base) return; // couldn't save (offline): try again later
  try { sessionStorage.setItem('tickmark:reloadedFor', build); } catch {}
  location.reload();
}
addEventListener('pagehide', () => {
  if (S.mode === 'note' && S.path && el.editor.value !== S.base) {
    fetch(`/api/file?path=${enc(S.path)}`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: el.editor.value, baseContent: S.base }),
    }).catch(() => store.set(pendingKey(S.path), { content: el.editor.value, baseContent: S.base }));
  }
});

// ---------------------------------------------------------------- opening notes
async function open(path, { line = null, push = true, find = null } = {}) {
  if (!path) return;
  if (path !== S.path && !closeProps()) return;
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
  sizeTitle();
  el.crumbs.textContent = dirname(path) ? dirname(path).replaceAll('/', ' / ') + ' /' : '';
  document.title = `${basename(path)} · ${S.brand?.name || 'Tickmark'}`;
  vim.reset();
  applyView();
  renderPreview();
  renderWordCount();
  renderTree();
  updateSaveState();
  reportPresence();
  renderPresence();
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
  if (find) revealText(find);
  loadBacklinks();
}

/** Show where `q` (a search) first appears in the open note: selected in the editor, marked in the preview. */
function revealText(q) {
  const v = el.editor.value, lower = v.toLowerCase();
  const terms = [q, ...q.split(/\s+/)].map((t) => t.replace(/^[-+"'(]+|["')*]+$/g, '').trim()).filter((t) => t && !/^(and|or|not|near)$/i.test(t));
  let at = -1, len = 0;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0) { at = i; len = t.length; break; } }
  if (at < 0) return;
  const view = effectiveView();
  if (view !== 'read') {
    if (!mobile.matches) el.editor.focus({ preventScroll: true });
    el.editor.setSelectionRange(at, at + len);
    el.editor.scrollTop = Math.max(0, caretXY(el.editor, at).top - el.editor.clientHeight / 3);
  }
  if (view !== 'edit') {
    const term = lower.slice(at, at + len);
    setTimeout(() => { // after the split view's scroll-sync has moved the preview
      const walk = document.createTreeWalker(el.preview, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) {
        const i = n.data.toLowerCase().indexOf(term);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + term.length);
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        r.surroundContents(mark);
        mark.scrollIntoView({ block: 'center' });
        setTimeout(() => { if (mark.isConnected) mark.replaceWith(...mark.childNodes); }, 2500);
        break;
      }
    }, 80);
  }
}

/** No note open (Vim's :q). */
async function closeNote() {
  if (S.mode !== 'note') return;
  if (!closeProps()) return;
  await flushSave();
  S.path = null; S.mode = 'empty';
  el.title.value = ''; el.crumbs.textContent = '';
  history.pushState(null, '', location.pathname + location.search);
  document.title = S.brand?.name || 'Tickmark';
  applyView(); updateSaveState(); renderTree(); reportPresence();
}

/** The note-name box is as wide as the name (it's also how you rename). */
function sizeTitle() {
  const t = el.title, cs = getComputedStyle(t);
  const ctx = (sizeTitle.ctx ||= document.createElement('canvas').getContext('2d'));
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const w = ctx.measureText(t.value || ' ').width;
  t.style.width = Math.ceil(w + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 6) + 'px';
}
el.title.addEventListener('input', sizeTitle);
document.fonts?.ready.then(sizeTitle);

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
  $('#btn-more').hidden = !note; // its menu is only about the open note
  requestAnimationFrame(() => { renderGutter(); renderCursors(); });
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

// The sidebar's width: drag its right edge (double-click puts it back), or use ← → on the handle.
const SIDE_MIN = 180, SIDE_MAX = 560;
function setSideWidth(w, keep = false) {
  if (w == null) { el.app.style.removeProperty('--side-w'); store.del('sideWidth'); return; }
  w = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w, innerWidth - 320)));
  el.app.style.setProperty('--side-w', w + 'px');
  if (keep) store.set('sideWidth', w);
}
if (store.get('sideWidth')) setSideWidth(store.get('sideWidth'));
{
  const h = $('#side-resize');
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    el.app.classList.add('resizing');
    const move = (ev) => setSideWidth(ev.clientX);
    const up = (ev) => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); el.app.classList.remove('resizing'); setSideWidth(ev.clientX, true); renderGutter(); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
  h.addEventListener('dblclick', () => { setSideWidth(null); renderGutter(); });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSideWidth($('#sidebar').offsetWidth + (e.key === 'ArrowRight' ? 16 : -16), true);
  });
}
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
  updateTrashCount();
  loadShareIndex();
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
  // The Templates folder is managed in Settings → Templates, not the sidebar.
  for (const f of S.folders) if (!isTemplateDir(f)) node(f);
  for (const f of S.files) if (!isTemplate(f.path)) node(dirname(f.path)).files.push(f);
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
      sizeTitle();
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
    toast(`Moved to the trash`, { label: 'Open Trash', run: openTrash });
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
  if (!name || name === basename(S.path)) { el.title.value = basename(S.path); sizeTitle(); return; }
  if (/[/\\]/.test(name)) { toast('Names cannot contain / or \\'); el.title.value = basename(S.path); sizeTitle(); return; }
  await movePath(S.path, joinPath(dirname(S.path), name + '.md'));
}
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.title.blur(); }
  if (e.key === 'Escape') { el.title.value = S.path ? basename(S.path) : ''; sizeTitle(); el.title.blur(); }
});
el.title.addEventListener('blur', commitTitle);

// ⋯: things to do with the open note, and only that (A to Z). Renaming is the name box, syncing the
// sync status, themes and templates live in Settings.
$('#btn-more').onclick = (e) => {
  if (S.mode !== 'note') return;
  showMenu(e.currentTarget, [
    { label: 'Apply template…', expand: (b) => expandTemplatePicker(b) },
    { label: 'Deleted tasks…', run: () => openDeleted({ path: S.path }) },
    { label: 'History…', run: () => openHistory() },
    { label: 'Move to trash', danger: true, run: () => trashPath(S.path, false) },
    { label: 'Properties…', run: () => openProps() },
    { label: 'Share…', run: () => openShare(S.path, false) },
  ]);
};
$('#btn-help').onclick = (e) => showMenu(e.currentTarget, [
  { label: 'Help', run: () => openHelp() },
  { label: 'Keybindings', run: () => openKeys() },
]);

// ---------------------------------------------------------------- search
const runSearch = debounce(async () => {
  const q = el.search.value.trim();
  if (!q) { el.results.hidden = true; el.tree.hidden = false; return; }
  const ql = q.toLowerCase();
  const byName = S.files.filter((f) => !isTemplate(f.path) && f.path.toLowerCase().includes(ql)).slice(0, 10);
  let byText = [];
  try { byText = await api('GET', `/api/search?q=${enc(q)}`); } catch {}
  const seen = new Set(byName.map((f) => f.path));
  const items = [
    ...byName.map((f) => ({ path: f.path, snippet: dirname(f.path) ? esc(dirname(f.path)) : '' })),
    ...byText.filter((r) => !seen.has(r.path) && !isTemplate(r.path)).map((r) => ({ path: r.path, snippet: esc(r.snippet).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>') })),
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
// A result opens its note at the first place the search appears.
el.results.addEventListener('click', (e) => { const r = e.target.closest('.sr-item'); if (r) open(r.dataset.path, { find: el.search.value.trim() }); });

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
/** Notes for the quick switcher: fuzzy by name (then path), recent first when nothing is typed, and "Create". */
function noteItems(q, { create = true, prefix = '' } = {}) {
  const files = S.files.filter((f) => !isTemplate(f.path));
  const list = (q
    ? files.map((f) => ({ f, s: fuzzy(q, basename(f.path)) * 2 + Math.max(0, fuzzy(q, f.path)) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.f)
    : [...files].sort((a, b) => b.mtime - a.mtime)).slice(0, 50);
  const items = list.map((f) => ({ label: prefix + basename(f.path), detail: dirname(f.path), run: () => open(f.path) }));
  if (create && q && !files.some((f) => basename(f.path).toLowerCase() === q.toLowerCase())) items.push({ label: `Create “${q}”`, run: () => newNote('', q) });
  return items;
}
/** The picker dialog: a search box over a list of { label, detail, hint, run } from `source(query)`. */
function openPicker(source, placeholder) {
  sw.source = source;
  sw.input.placeholder = placeholder;
  sw.input.value = ''; sw.sel = 0;
  renderSwitcher();
  if (!sw.dlg.open) sw.dlg.showModal();
  sw.input.focus();
}
function renderSwitcher() {
  sw.items = sw.source(sw.input.value.trim());
  sw.sel = Math.min(sw.sel, Math.max(0, sw.items.length - 1));
  sw.list.innerHTML = sw.items.length ? sw.items.map((it, i) => `<li data-i="${i}" class="${i === sw.sel ? 'sel' : ''}"><span class="lbl">${esc(it.label)}</span>` +
    (it.detail ? `<span class="dir">${esc(it.detail)}</span>` : '') + (it.hint ? `<span class="hint">${kbdHtml(it.hint)}</span>` : '') + '</li>').join('')
    : '<li class="none">No matches</li>';
}
function openSwitcher() { openPicker((q) => noteItems(q), 'Jump to note…'); }
function pickSwitcher(i) {
  const it = sw.items[i];
  if (!it) return;
  if (!it.keep) sw.dlg.close();
  if (it.recent) rememberCommand(it.recent);
  it.run();
}
sw.input.addEventListener('input', () => { sw.sel = 0; renderSwitcher(); });
sw.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = sw.items.length;
    sw.sel = (sw.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % Math.max(1, n);
    [...sw.list.children].forEach((li, i) => li.classList.toggle('sel', i === sw.sel));
    sw.list.children[sw.sel]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); pickSwitcher(sw.sel); }
});
sw.list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pickSwitcher(+li.dataset.i); });
sw.dlg.addEventListener('click', (e) => { if (e.target === sw.dlg) sw.dlg.close(); });

// ---- command palette (Ctrl+Shift+P or F1): everything you can do, by name, plus notes to open
const recentCommands = () => store.get('recentCommands', []);
function rememberCommand(id) { store.set('recentCommands', [id, ...recentCommands().filter((x) => x !== id)].slice(0, 8)); }
function commands() {
  const note = S.mode === 'note';
  const view = (v) => () => { S.view = v; store.set('view', v); applyView(); };
  const list = [
    { id: 'goto', label: 'Go to note…', hint: 'Ctrl+P', run: () => setTimeout(openSwitcher) },
    { id: 'new-note', label: 'New note', hint: 'Ctrl+N', run: () => newNote() },
    { id: 'new-folder', label: 'New folder', run: () => newFolder(S.path ? dirname(S.path) : '') },
    { id: 'search', label: 'Search in all notes', hint: 'Ctrl+Shift+F', run: () => { if (mobile.matches) el.app.classList.add('sidebar-open'); el.search.focus(); } },
    ...(note ? [
      { id: 'note-rename', label: 'Note: Rename', run: () => { el.title.focus(); el.title.select(); } },
      { id: 'note-move', label: 'Note: Move to folder…', run: () => moveToFolder(S.path) },
      { id: 'note-template', label: 'Note: Apply template…', run: () => setTimeout(() => openPicker(templateItems, 'Apply template…')) },
      { id: 'note-props', label: 'Note: Properties…', run: () => openProps() },
      { id: 'note-history', label: 'Note: History…', run: () => openHistory() },
      { id: 'note-share', label: 'Note: Share…', run: () => openShare(S.path, false) },
      { id: 'note-deleted', label: 'Note: Deleted tasks…', run: () => openDeleted({ path: S.path }) },
      { id: 'note-link', label: 'Note: Copy link to this note', run: () => copyText(`[[${basename(S.path)}]]`, 'Link copied') },
      { id: 'note-reveal', label: 'Note: Show in the sidebar', run: () => revealInTree(S.path) },
      { id: 'note-close', label: 'Note: Close', run: () => closeNote() },
      { id: 'note-trash', label: 'Note: Move to trash', run: () => trashPath(S.path, false) },
    ] : []),
    { id: 'view-source', label: 'View: Source', hint: 'Ctrl+E', run: view('edit') },
    ...(mobile.matches ? [] : [{ id: 'view-split', label: 'View: Split', hint: 'Ctrl+E', run: view('split') }]),
    { id: 'view-preview', label: 'View: Preview', hint: 'Ctrl+E', run: view('read') },
    { id: 'view-sidebar', label: 'View: Show or hide the sidebar', hint: 'Ctrl+\\', run: () => toggleSidebar() },
    { id: 'view-collapse', label: 'View: Collapse all folders', run: () => { S.openFolders.clear(); store.set('openFolders', []); renderTree(); } },
    { id: 'editor-vim', label: `Editor: ${S.vim ? 'Turn off' : 'Turn on'} Vim mode`, run: () => { setVim(!S.vim); toast(`Vim mode ${S.vim ? 'on' : 'off'}`); } },
    { id: 'editor-lines', label: `Editor: ${S.lineNumbers ? 'Hide' : 'Show'} line numbers`, run: () => setLineNumbers(!S.lineNumbers) },
    { id: 'sync-now', label: 'Sync: Sync now', run: () => runSync({ manual: true }) },
    ...(S.config?.accounts || []).filter((a) => a.id).map((a) => ({ id: 'sync-log-' + a.id, label: `Sync: History of ${a.name}…`, run: () => openSyncLog(a.id, a.name) })),
    { id: 'trash', label: 'Trash…', run: () => openTrash() },
    { id: 'deleted-all', label: 'Deleted tasks (all notes)…', run: () => openSettings('deleted') },
    ...Object.entries(SECTIONS).filter(([k]) => sectionVisible(k)).map(([k, name]) => ({ id: 'set-' + k, label: `Settings: ${name}`, run: () => openSettings(k) })),
    ...THEMES.map(([id, name]) => ({ id: 'theme-' + id, label: `Theme: ${name}`, run: () => { window.tickmarkTheme?.set(id); toast(`Theme: ${name}`); } })),
    { id: 'help', label: 'Help', run: () => openHelp() },
    { id: 'keys', label: 'Keybindings', hint: 'Ctrl+/', run: () => openKeys() },
    ...(isMulti() ? [{ id: 'sign-out', label: 'Sign out', run: () => signOut() }] : []),
  ];
  return list;
}
function commandItems(q) {
  const all = commands().map((c) => ({ ...c, recent: c.id }));
  if (!q) {
    const recent = recentCommands().map((id) => all.find((c) => c.id === id)).filter(Boolean);
    return [...recent.map((c) => ({ ...c, detail: 'recent' })), ...all.filter((c) => !recent.includes(c))];
  }
  const hits = all.map((c) => ({ c, s: fuzzy(q, c.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c);
  return [...hits, ...noteItems(q, { create: false, prefix: 'Open: ' }).slice(0, 8)];
}
function openPalette() { openPicker(commandItems, 'Type a command, or a note to open…'); }
function templateItems(q) {
  const list = templates().filter((f) => !q || templateName(f.path).toLowerCase().includes(q.toLowerCase()));
  return list.length ? list.map((f) => ({ label: templateName(f.path), run: () => applyTemplate(f.path) })) : [];
}
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast(text); }
}
function revealInTree(path) {
  const parts = dirname(path).split('/').filter(Boolean);
  parts.forEach((_, i) => S.openFolders.add(parts.slice(0, i + 1).join('/')));
  store.set('openFolders', [...S.openFolders]);
  el.search.value = ''; el.results.hidden = true; el.tree.hidden = false;
  renderTree();
  if (mobile.matches) el.app.classList.add('sidebar-open');
  else if (el.app.classList.contains('no-sidebar')) toggleSidebar();
  el.tree.querySelector(`.t-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
}

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
  } else if (manual && !trashedCount(r.result) && !r.result.imported) { // new and deleted tasks get their own notice
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
  const hist = box.querySelector('[data-act="history"]');
  hist.hidden = !a.id;
  hist.onclick = () => openSyncLog(a.id, field(box, 'name').value || a.name);
  field(box, 'calendarUrl').addEventListener('change', (e) => {
    if (e.target.value === NEW_LIST) newTaskList(box); else e.target.dataset.last = e.target.value;
  });
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

const NEW_LIST = '__new__';
/** "+ New task list…" in the Task list menu: name it, create it on the server, and pick it. */
async function newTaskList(box) {
  const sel = field(box, 'calendarUrl'), msg = field(box, 'msg');
  const back = () => { sel.value = sel.dataset.last || ''; };
  const name = await ask('Name of the new task list', 'Tickmark');
  if (!name?.trim()) return back();
  msg.className = 'note';
  msg.textContent = `Creating “${name.trim()}”…`;
  try {
    const c = await api('POST', '/api/caldav/calendars', {
      accountId: box.dataset.id || undefined, name: name.trim(),
      url: field(box, 'url').value.trim(), username: field(box, 'username').value.trim(), password: field(box, 'password').value,
    });
    const opt = new Option(c.name, c.url);
    sel.insertBefore(opt, sel.querySelector(`option[value="${NEW_LIST}"]`));
    sel.value = c.url;
    sel.dataset.last = c.url;
    if (!field(box, 'name').value.trim()) field(box, 'name').value = c.name;
    msg.textContent = `Created “${c.name}”. Save to start syncing with it.`;
  } catch (e) { back(); msg.textContent = e.message; msg.className = 'note err'; }
}

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
    sel.innerHTML = calendars.map((c) => `<option value="${esc(c.url)}"${c.url === cur ? ' selected' : ''}>${esc(c.name)}</option>`).join('') +
      `<option value="${NEW_LIST}">+ New task list…</option>`;
    sel.dataset.last = sel.value;
    if (!field(box, 'name').value.trim()) field(box, 'name').value = sel.selectedOptions[0]?.textContent || '';
    msg.textContent = `Found ${calendars.length} task list${calendars.length === 1 ? '' : 's'}.`;
  } catch (e) { msg.textContent = e.message; msg.className = 'note err'; }
}

// The settings pane: a menu of sections. CalDAV accounts and Sync share one form and Save button;
// the others act immediately (account, users) or have their own Save (single sign-on).
const SECTIONS = {
  about: 'About', account: 'Account', appearance: 'Appearance', caldav: 'CalDAV accounts', deleted: 'Deleted tasks', editor: 'Editor',
  shares: 'Public links', sso: 'Single sign-on', templates: 'Templates', users: 'Users',
};
const setDlg = $('#dlg-settings');
const isMulti = () => S.me?.mode === 'multi' && !!S.me.user;
const isAdmin = () => isMulti() && !!S.me.user.admin;

function sectionVisible(sec) {
  if (sec === 'account') return isMulti() && !!S.me.user.hasPassword; // nothing to manage without a password
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
  if (sec === 'appearance') { renderThemes(); renderCssEditor(); renderBranding(); }
  if (sec === 'shares') loadShares();
  if (sec === 'deleted') loadDeleted('set');
  if (sec === 'templates') renderTemplates();
  if (sec === 'about') loadAbout();
  if (sec === 'editor') { $('#opt-vim').checked = S.vim; $('#opt-lines').checked = S.lineNumbers; }
  $('#btn-logout').hidden = !isMulti();
}
$('#opt-vim').onchange = (e) => setVim(e.target.checked);
$('#opt-lines').onchange = (e) => setLineNumbers(e.target.checked);

// ---- Settings → About
async function loadAbout() {
  const dl = $('#about-list');
  let a;
  try { a = await api('GET', '/api/about'); } catch (e) { dl.innerHTML = `<dt class="note err">${esc(e.message)}</dt>`; return; }
  const dur = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const rows = [
    ['Tickmark', a.version],
    ['Server build', a.build],
    ['This app\'s build', BUILD === 'dev' ? 'dev (not served by Tickmark)' : BUILD + (BUILD === a.build ? ' (up to date)' : ' (reload to update)')],
    ['Running on', `Node.js ${a.node} · ${a.os} (${a.arch})${a.docker ? ' · Docker' : ''}`],
    ['Up since', `${new Date(a.startedAt).toLocaleString()} (${dur(a.uptime)})`],
    ['Sign-in', a.mode === 'multi' ? `On${a.users != null ? `, ${plural(a.users, 'user')}` : ''}${a.sso ? ' · SSO' : ''}${a.passwordSignIn === false ? ' · no passwords' : ''}` : 'Off (single user)'],
    ['Public links', a.publicUrl ? 'Available' : 'Need a public URL (TICKMARK_PUBLIC_URL)'],
    ['Note history', a.history ? 'On (git)' : 'Off: git isn\'t installed on the server'],
    ['Your notes', `${plural(a.notes, 'note')} in ${plural(a.folders, 'folder')}`],
    ['CalDAV accounts', a.accounts ? String(a.accounts) : 'None set up'],
    ['This device', `${standalone ? 'Installed app' : 'Browser tab'} · ${navigator.serviceWorker?.controller ? 'works offline' : 'online only'}`],
  ];
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') +
    `<dt>Source</dt><dd><a href="https://github.com/hempfieldtech/tickmark" target="_blank" rel="noopener">github.com/hempfieldtech/tickmark</a></dd>`;
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

// ---- Help (the ? menu): the README, with its contents as a tree on the left
const helpDlg = $('#dlg-help');
async function openHelp() {
  if (!helpDlg.open) helpDlg.showModal();
  await loadReadme();
}
async function loadReadme() {
  const box = $('#readme'), toc = $('#help-toc');
  if (box.dataset.loaded) return;
  try {
    const { markdown } = await api('GET', '/api/readme');
    if (!markdown) { box.innerHTML = '<p class="note">The README isn\'t available on this server.</p>'; return; }
    cbIndex = 0;
    box.innerHTML = marked.parse(markdown);
    box.querySelectorAll('input').forEach((i) => (i.disabled = true));
    const heads = [...box.querySelectorAll('h1, h2, h3')];
    heads.forEach((h) => (h.id = slug(h.textContent)));
    // The tree: ## sections, each opening to its ### subsections.
    let html = '<button type="button" class="toc-toggle" aria-label="Show the contents">Contents</button><input type="search" class="toc-filter" placeholder="Filter" aria-label="Filter the contents" autocomplete="off"><ul class="toc-tree">';
    const h2s = heads.filter((h) => h.tagName === 'H2');
    for (const h of h2s) {
      const subs = [];
      for (let n = h.nextElementSibling; n && n.tagName !== 'H2'; n = n.nextElementSibling) if (n.tagName === 'H3') subs.push(n);
      html += `<li class="${subs.length ? 'has-kids' : ''}"><div class="toc-row">${subs.length ? '<button type="button" class="toc-twist" aria-label="Show subsections" aria-expanded="false">' + CHEV + '</button>' : '<span class="toc-twist"></span>'}` +
        `<a href="#${esc(h.id)}">${esc(h.textContent)}</a></div>` +
        (subs.length ? `<ul hidden>${subs.map((x) => `<li><a href="#${esc(x.id)}">${esc(x.textContent)}</a></li>`).join('')}</ul>` : '') + '</li>';
    }
    toc.innerHTML = html + '</ul>';
    box.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h.startsWith('#')) return;
      if (/^https?:/i.test(h)) { a.target = '_blank'; a.rel = 'noopener'; }
      else a.href = `https://github.com/hempfieldtech/tickmark/blob/master/${h}`;
    });
    box.dataset.loaded = '1';
    markHelpSection();
  } catch (e) { box.innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
}
/** In-page links (the tree, and links inside the README) scroll the README. */
helpDlg.addEventListener('click', (e) => {
  if (e.target.closest('.toc-toggle')) { $('#help-toc').classList.toggle('open'); return; }
  const tw = e.target.closest('button.toc-twist');
  if (tw) { const ul = tw.closest('li').querySelector(':scope > ul'); ul.hidden = !ul.hidden; tw.setAttribute('aria-expanded', String(!ul.hidden)); return; }
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  const id = decodeURIComponent(a.getAttribute('href').slice(1));
  const target = $('#readme').querySelector(`[id="${CSS.escape(id)}"]`) || [...$('#readme').querySelectorAll('h1,h2,h3,h4')].find((x) => slug(x.textContent) === id);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (mobile.matches && a.closest('#help-toc')) $('#help-toc').classList.remove('open');
});
/** Highlight the section being read, and open its branch of the tree. */
function markHelpSection() {
  const box = $('#readme');
  const heads = [...box.querySelectorAll('h2, h3')];
  let cur = null;
  for (const h of heads) { if (h.offsetTop - box.offsetTop <= box.scrollTop + 24) cur = h; else break; }
  const toc = $('#help-toc');
  toc.querySelectorAll('a.cur').forEach((a) => a.classList.remove('cur'));
  if (!cur) return;
  const link = toc.querySelector(`a[href="#${CSS.escape(cur.id)}"]`);
  if (!link) return;
  link.classList.add('cur');
  const branch = link.closest('ul[hidden]');
  if (branch) { branch.hidden = false; branch.closest('li').querySelector('.toc-twist')?.setAttribute('aria-expanded', 'true'); }
  link.scrollIntoView({ block: 'nearest' });
}
$('#readme').addEventListener('scroll', debounce(markHelpSection, 60));
$('#help-toc').addEventListener('input', (e) => {
  if (!e.target.matches('.toc-filter')) return;
  const q = e.target.value.trim().toLowerCase();
  for (const li of $('#help-toc').querySelectorAll('.toc-tree > li')) {
    const kids = [...li.querySelectorAll('ul li')];
    const own = li.querySelector('.toc-row a').textContent.toLowerCase().includes(q);
    kids.forEach((k) => (k.hidden = !!q && !own && !k.textContent.toLowerCase().includes(q)));
    const anyKid = kids.some((k) => !k.hidden);
    li.hidden = !!q && !own && !anyKid;
    const ul = li.querySelector('ul');
    if (ul && q) ul.hidden = !anyKid;
  }
});

// ---- Keybindings (the ? menu): every shortcut, grouped by what it does, with a search
const KEYMAP = [
  { group: 'Notes and navigation', items: [
    ['Ctrl+P', 'Jump to a note (quick switcher); type a new name to create it'], ['Ctrl+O', 'Jump to a note'],
    ['Ctrl+Shift+P', 'Command palette: every action by name, and notes to open'], ['F1', 'Command palette'],
    ['Ctrl+N', 'New note'], ['Ctrl+Shift+F', 'Search the text of all notes'], ['Ctrl+S', 'Save now (it also saves by itself)'],
  ] },
  { group: 'Views and panels', items: [
    ['Ctrl+E', 'Switch between Source, Split and Preview'], ['Ctrl+\\', 'Show or hide the sidebar'],
    ['Ctrl+/', 'These keybindings'], ['Esc', 'Close a dialog, menu or the Properties panel'],
  ] },
  { group: 'Writing', items: [
    ['Enter', 'Continue a list or checklist; on an empty item, end the list'],
    ['Tab', 'Indent the list item (or the selected lines)'], ['Shift+Tab', 'Outdent the list item (or the selected lines)'],
    ['[[', 'Link to a note: suggestions appear; ↑ ↓ to pick, Enter or Tab to insert, Esc to close'],
    [':cal', 'Shortcodes as you type: :calendar: :tomorrow: :nextweek: :recur: :highest: :high: :medium: :low: :lowest: :done:'],
  ] },
  { group: 'Checklists', items: [
    ['Ctrl+L', 'Make the line a checklist item, or a checklist item a plain line again'],
    ['Click', 'A checkbox in the preview: check or uncheck it (embedded notes too)'],
    ['Right-click', 'A checkbox in the preview: pick its state (to do, in progress, done, cancelled)'],
  ] },
  { group: 'Lists and pickers', items: [
    ['↑ / ↓', 'Move through the switcher, palette, suggestions and template search'], ['Enter', 'Pick the highlighted entry'],
    ['Ctrl+S', 'Save the Properties panel or Custom CSS while you\'re in it'],
  ] },
  { group: 'Vim mode (Settings → Editor)', id: 'vim', items: [
    ['Esc / Ctrl+[', 'Back to normal mode'], ['i a I A o O', 'Insert before, after, at line start/end, on a new line below/above'],
    ['h j k l', 'Left, down, up, right (with a count: 5j)'], ['w b e W B E ge', 'Word motions'], ['0 ^ $ g_', 'Line start, first non-blank, line end'],
    ['gg G 42G :42', 'First line, last line, line 42'], ['{ } %', 'Paragraph back/forward, matching bracket'],
    ['f F t T ; ,', 'Find a character on the line, and repeat'], ['/ ? n N * #', 'Search forward/back, next/previous, the word under the cursor'],
    ['d c y', 'Delete, change, yank with a motion or object: dw, c$, y3j, ci", da(, yip'], ['dd cc yy >> <<', 'The whole line (with a count: 3dd)'],
    ['x X s S D C Y', 'Shortcuts for dl dh cl cc d$ c$ yy'], ['p P', 'Put after/before (lines go below/above)'], ['"a "+', 'Use register a, or the clipboard'],
    ['r R ~ J gJ', 'Replace a character, replace mode, toggle case, join lines'], ['g~ gu gU', 'Toggle/lower/upper case with a motion'],
    ['u Ctrl+R .', 'Undo, redo, repeat the last change'], ['v V gv o', 'Visual and visual-line mode, reselect, other end'],
    ['m{a-z} \'{a-z} `{a-z}', 'Set a mark, jump to its line or its exact place'], ['Ctrl+D Ctrl+U Ctrl+F Ctrl+B', 'Half page / page down and up'],
    ['Ctrl+E Ctrl+Y zz zt zb', 'Scroll a line, centre/top/bottom the cursor'], ['Ctrl+A Ctrl+X', 'Add to / subtract from the number at the cursor'],
    [':w :q :wq :x ZZ', 'Save, close the note, both'], [':s/a/b/g :%s :\'<,\'>s', 'Substitute on the line, the note, the selection'],
    [':d :y :sort :noh', 'Delete or yank lines, sort them, clear the search'], [':set nu :set nonu', 'Line numbers on or off'], [':e Name', 'Open (or create) a note'],
  ] },
];
const keysDlg = $('#dlg-keys');
/** "Ctrl+Shift+P" → <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>; "A / B" are alternatives. */
function kbdHtml(keys) {
  return keys.split(' / ').map((alt) => /^[A-Za-z]+\+/.test(alt) && !/\s/.test(alt)
    ? alt.split(/\+(?!$)/).map((k) => `<kbd>${esc(k)}</kbd>`).join('+')
    : alt.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')).join(' <span class="or-key">or</span> ');
}
function renderKeys() {
  const q = $('#keys-search').value.trim().toLowerCase();
  const out = KEYMAP.map((g) => {
    const rows = g.items.filter(([k, d]) => !q || k.toLowerCase().includes(q) || d.toLowerCase().includes(q) || g.group.toLowerCase().includes(q));
    if (!rows.length) return '';
    return `<section${g.id ? ` id="keys-${g.id}"` : ''}><h4>${esc(g.group)}</h4><dl>${rows.map(([k, d]) => `<dt>${kbdHtml(k)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></section>`;
  }).join('');
  $('#keys-list').innerHTML = out || '<p class="note">No shortcuts match.</p>' ;
  if (!q) $('#keys-list').insertAdjacentHTML('afterbegin', '<p class="note">On a Mac, use ⌘ where it says Ctrl.' + (S.vim ? ' Vim mode is on: in the editor\'s normal mode the Vim keys at the end apply, Ctrl+E F B D U Y R A X included.' : '') + '</p>');
}
function openKeys(section) {
  $('#keys-search').value = '';
  renderKeys();
  if (!keysDlg.open) keysDlg.showModal();
  if (section) $(`#keys-${section}`)?.scrollIntoView();
  else $('#keys-search').focus();
}
$('#keys-search').addEventListener('input', renderKeys);

const slug = (t) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

// ---- Properties: the note's frontmatter as a form in a side panel; nothing is written until Save
const props = { el: $('#props'), rows: $('#props-rows'), path: null, hidden: [], start: '' };
const KIND_HINT = { list: 'list', inline: 'list', raw: 'YAML, kept as written' };
function propRow(e = { key: '', kind: 'text', value: '' }) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.dataset.kind = e.kind;
  if (e.indent) row.dataset.indent = e.indent;
  const val = e.kind === 'raw' ? `<textarea class="prop-val" spellcheck="false" aria-label="Value">${esc(e.value)}</textarea>`
    : `<input class="prop-val" aria-label="Value" value="${esc(Array.isArray(e.value) ? e.value.join(', ') : e.value)}" spellcheck="false">`;
  row.innerHTML = `<input class="prop-key" aria-label="Property name" placeholder="name" value="${esc(e.key)}" spellcheck="false">${val}` +
    `<button type="button" class="icon-btn" data-act="del" aria-label="Remove property" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` +
    (KIND_HINT[e.kind] ? `<span class="prop-kind">${KIND_HINT[e.kind]}</span>` : '');
  row.querySelector('[data-act="del"]').onclick = () => { row.remove(); propsState(); };
  // An untouched list keeps its items exactly (an item may contain a comma).
  row.orig = { shown: row.querySelector('.prop-val').value, value: e.value };
  return row;
}
/** The panel's rows as frontmatter entries (comments and blank lines from the file are kept, at the top). */
function propEntries() {
  const out = [...props.hidden];
  for (const row of props.rows.children) {
    const key = row.querySelector('.prop-key').value.trim();
    const raw = row.querySelector('.prop-val').value;
    if (!key) continue;
    const kind = row.dataset.kind;
    const value = kind === 'list' || kind === 'inline'
      ? (raw === row.orig?.shown ? row.orig.value : raw.split(',').map((x) => x.trim()).filter(Boolean))
      : kind === 'raw' ? raw : raw.trim();
    out.push({ key, kind, value, indent: row.dataset.indent });
  }
  return out;
}
const propsSnapshot = () => JSON.stringify(propEntries());
function propsState(msg) {
  const keys = [...props.rows.querySelectorAll('.prop-key')].map((i) => i.value.trim()).filter(Boolean);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  const bad = keys.find((k) => /[:#]/.test(k) || /^-/.test(k));
  $('#props-state').textContent = msg || (dupe ? `“${dupe}” is there twice` : bad ? `“${bad}” can't be a name` : propsSnapshot() !== props.start ? 'Not saved yet' : '');
  $('#btn-props-save').disabled = !!(dupe || bad) || propsSnapshot() === props.start;
}
function openProps() {
  if (S.mode !== 'note') return;
  const fm = parseFrontmatter(el.editor.value);
  props.path = S.path;
  props.hidden = fm.entries.filter((e) => e.key == null && e.value.trim()); // comments
  props.rows.innerHTML = '';
  for (const e of fm.entries.filter((x) => x.key != null)) props.rows.append(propRow(e));
  props.start = propsSnapshot();
  props.el.hidden = false;
  propsState();
  (props.rows.querySelector('.prop-val') || $('#btn-props-add')).focus();
}
function closeProps(force = false) {
  if (props.el.hidden) return true;
  if (!force && propsSnapshot() !== props.start && !confirm('Discard the changes to these properties?')) return false;
  props.el.hidden = true;
  return true;
}
props.rows.addEventListener('input', () => propsState());
$('#btn-props-add').onclick = () => { const r = propRow(); props.rows.append(r); r.querySelector('.prop-key').focus(); propsState(); };
$('#btn-props-close').onclick = () => closeProps();
$('#btn-props-cancel').onclick = () => closeProps(true);
$('#btn-props-save').onclick = () => {
  if (S.path !== props.path) return toast('That note is no longer open');
  // Rebuilt on the note as it is now, so anything typed in the editor meanwhile is kept.
  const body = parseFrontmatter(el.editor.value).body;
  applyEdit(writeFrontmatter(body, propEntries()));
  props.start = propsSnapshot();
  propsState('Saved');
};
props.el.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeProps(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); if (!$('#btn-props-save').disabled) $('#btn-props-save').click(); }
});

// ---- note history (git on the server)
const histDlg = $('#dlg-history');
const hist = { path: null, hash: null };
async function openHistory() {
  await flushSave();
  hist.path = S.path; hist.hash = null;
  $('#history-title').textContent = `History of “${basename(S.path)}”`;
  $('#history-list').innerHTML = '<li class="note">Loading…</li>';
  $('#history-diff').innerHTML = '';
  $('#history-what').textContent = 'Pick a version to see what has changed since.';
  $('#btn-history-restore').disabled = true;
  if (!histDlg.open) histDlg.showModal();
  let r;
  try { r = await api('GET', `/api/history?path=${enc(hist.path)}`); } catch (e) { $('#history-list').innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  if (!r.available) { $('#history-list').innerHTML = '<li class="note">History needs git on the server (the Docker image has it).</li>'; return; }
  if (!r.versions.length) { $('#history-list').innerHTML = '<li class="note">No versions yet. Changes are recorded about 30 seconds after you stop editing.</li>'; return; }
  $('#history-list').innerHTML = r.versions.map((v, i) => {
    const d = new Date(v.date);
    return `<li><button type="button" role="option" data-hash="${esc(v.hash)}" aria-selected="false">` +
      `<span class="when">${esc(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>` +
      `<span class="ago">${i === 0 ? 'latest · ' : ''}${esc(relTime(v.date))}</span></button></li>`;
  }).join('');
}
$('#history-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-hash]');
  if (!b) return;
  $('#history-list').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  hist.hash = b.dataset.hash;
  let r;
  try { r = await api('GET', `/api/history/version?path=${enc(hist.path)}&hash=${enc(hist.hash)}`); } catch (err) { toast(err.message); return; }
  const changes = r.diff.filter((d) => d.type === '+' || d.type === '-').length;
  $('#history-what').textContent = changes ? 'Red: in this version, gone now. Green: added since.' : 'Same as the note now.';
  $('#btn-history-restore').disabled = !changes;
  $('#history-diff').innerHTML = changes ? r.diff.map((d) => d.type === '…' ? '<div class="gap">⋯</div>'
    : `<div class="${d.type === '+' ? 'add' : d.type === '-' ? 'del' : ''}">${esc(d.type === ' ' ? '  ' : d.type + ' ')}${esc(d.line) || ' '}</div>`).join('') : '';
});
$('#btn-history-restore').onclick = async () => {
  if (!hist.hash || !confirm('Put the note back the way it was in this version? The current text stays in its history.')) return;
  try {
    const r = await api('POST', '/api/history/restore', { path: hist.path, hash: hist.hash });
    histDlg.close();
    if (S.path === hist.path) { S.base = r.content; S.hash = r.hash; setEditorText(r.content); renderPreview(); S.savedAt = Date.now(); updateSaveState(); }
    toast('Restored that version');
  } catch (e) { toast(e.message); }
};

// ---- note templates: notes in the Templates folder (their checklist items never sync)
const TEMPLATES = 'Templates';
const isTemplate = (p) => !!p && p.toLowerCase().startsWith(TEMPLATES.toLowerCase() + '/');
const isTemplateDir = (p) => !!p && (p.toLowerCase() === TEMPLATES.toLowerCase() || isTemplate(p));
const templates = () => S.files.filter((f) => isTemplate(f.path)).sort((a, b) => cmp(a.path, b.path));
const templateName = (p) => p.slice(TEMPLATES.length + 1).replace(/\.md$/i, '');

// ---- Settings → Templates: list, create, edit, rename and delete them
const tpl = { editing: null, base: '' }; // editing: the template's path, or '' for a new one
function renderTemplates() {
  const list = templates(), ul = $('#tpl-list');
  const fromNote = $('#btn-tpl-from-note');
  fromNote.hidden = S.mode !== 'note' || isTemplate(S.path);
  if (!fromNote.hidden) fromNote.textContent = `+ From “${basename(S.path)}”`;
  $('#tpl-empty').hidden = list.length > 0;
  ul.hidden = !list.length;
  ul.innerHTML = '';
  for (const f of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="who">${esc(templateName(f.path))}</span>` +
      `<button type="button" class="btn" data-act="edit">Edit</button><button type="button" class="btn danger" data-act="del">Delete</button>`;
    li.querySelector('.who').onclick = li.querySelector('[data-act="edit"]').onclick = () => editTemplate(f.path);
    li.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`Delete the template “${templateName(f.path)}”? It goes to the trash (Settings → Trash).`)) return;
      try { await api('DELETE', `/api/file?path=${enc(f.path)}`); if (tpl.editing === f.path) closeTemplateEditor(); await loadTree(); renderTemplates(); } catch (e) { toast(e.message); }
    };
    ul.append(li);
  }
}
async function editTemplate(path) {
  if (!closeTemplateEditor()) return;
  let content = '';
  if (path) { try { content = (await api('GET', `/api/file?path=${enc(path)}`)).content; } catch (e) { return toast(e.message); } }
  tpl.editing = path; tpl.base = content;
  $('#tpl-name').value = path ? templateName(path) : '';
  $('#tpl-content').value = content;
  $('#tpl-state').textContent = '';
  $('#tpl-edit').hidden = false;
  $('#tpl-edit').scrollIntoView({ block: 'nearest' });
  (path ? $('#tpl-content') : $('#tpl-name')).focus();
}
function closeTemplateEditor() {
  if ($('#tpl-edit').hidden) return true;
  const dirty = $('#tpl-content').value !== tpl.base || (tpl.editing && $('#tpl-name').value.trim() !== templateName(tpl.editing));
  if (dirty && !confirm('Discard the changes to this template?')) return false;
  $('#tpl-edit').hidden = true;
  tpl.editing = null;
  return true;
}
$('#btn-tpl-new').onclick = () => editTemplate('');
$('#btn-tpl-from-note').onclick = async () => { await saveAsTemplate(); renderTemplates(); };
$('#btn-tpl-cancel').onclick = () => { tpl.base = $('#tpl-content').value; tpl.editing && ($('#tpl-name').value = templateName(tpl.editing)); closeTemplateEditor(); };
$('#btn-tpl-save').onclick = async () => {
  const name = $('#tpl-name').value.trim();
  if (!name) return $('#tpl-name').focus();
  if (/[\\/]/.test(name) || name.startsWith('.')) return toast('A template name can\'t contain / or \\ or start with a dot');
  const path = `${TEMPLATES}/${name}.md`, content = $('#tpl-content').value;
  try {
    if (!tpl.editing) await api('POST', '/api/file', { path, content });
    else {
      if (tpl.editing !== path) await api('POST', '/api/rename', { from: tpl.editing, to: path });
      await api('PUT', `/api/file?path=${enc(path)}`, { content, baseContent: tpl.base });
    }
    tpl.editing = path; tpl.base = content;
    $('#tpl-state').textContent = 'Saved';
    await loadTree();
    renderTemplates();
  } catch (e) { toast(e.status === 409 ? `There's already a template called “${name}”` : e.message); }
};
setDlg.addEventListener('cancel', (e) => { if (!closeTemplateEditor()) e.preventDefault(); });
setDlg.addEventListener('close', () => { $('#tpl-edit').hidden = true; tpl.editing = null; });
function fillTemplate(text) {
  const now = new Date();
  const vars = {
    date: localDate(now), time: now.toTimeString().slice(0, 5), title: basename(S.path || ''),
    datetime: `${localDate(now)} ${now.toTimeString().slice(0, 5)}`,
  };
  return text.replace(/\{\{\s*(date|time|datetime|title)\s*\}\}/gi, (_, k) => vars[k.toLowerCase()]);
}
/** ⋯ → Apply template…: the menu item opens into a search box and the matching templates, in the menu itself. */
function expandTemplatePicker(btn) {
  const list = templates();
  const box = document.createElement('div');
  box.className = 'menu-pick';
  if (!list.length) {
    box.innerHTML = `<p class="note">No templates yet. Make one in Settings → Templates.</p>`;
    btn.replaceWith(box);
    return;
  }
  box.innerHTML = `<input type="search" placeholder="Search templates" aria-label="Search templates" autocomplete="off" spellcheck="false"><div class="menu-pick-list" role="listbox"></div>`;
  btn.replaceWith(box);
  const input = box.querySelector('input'), out = box.querySelector('.menu-pick-list');
  let shown = [], sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = list.filter((f) => templateName(f.path).toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    out.innerHTML = shown.length ? shown.map((f, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === sel}">${esc(templateName(f.path))}</button>`).join('')
      : '<p class="note">No match</p>';
    placeMenu();
  };
  const pick = (i) => { const f = shown[i]; if (f) { hideMenu(); applyTemplate(f.path); } };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(1, shown.length); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); hideMenu(); }
  });
  out.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) pick(+b.dataset.i); });
  render();
  input.focus();
}
async function applyTemplate(path) {
  let text;
  try { text = fillTemplate((await api('GET', `/api/file?path=${enc(path)}`)).content); } catch (e) { return toast(e.message); }
  const ed = el.editor, cur = ed.value;
  // An empty note (or one with only its title heading) takes the template whole; otherwise it goes in at the cursor.
  if (!cur.trim() || /^#\s[^\n]*\n*$/.test(cur)) {
    const keepTitle = /^#\s/.test(cur) && !/^#\s/.test(text) ? cur.replace(/\n*$/, '\n\n') : '';
    applyEdit(keepTitle + text);
  } else {
    const at = ed.selectionStart ?? cur.length;
    replaceRange(at, ed.selectionEnd ?? at, text);
  }
  toast(`Applied “${basename(path)}”`);
}
async function saveAsTemplate() {
  const name = await ask('Template name', basename(S.path));
  if (!name?.trim() || /[\\/]/.test(name)) return;
  const path = `${TEMPLATES}/${name.trim()}.md`;
  await flushSave();
  try {
    await api('POST', '/api/file', { path, content: el.editor.value });
  } catch (e) {
    if (e.status !== 409) return toast(e.message);
    if (!confirm(`Replace the template “${name.trim()}”?`)) return;
    try { await api('PUT', `/api/file?path=${enc(path)}`, { content: el.editor.value }); } catch (e2) { return toast(e2.message); }
  }
  await loadTree();
  toast(`Saved as template “${name.trim()}” (Settings → Templates). Use {{date}}, {{time}} or {{title}} in it to fill those in.`);
}

// ---- public links
/** Which notes and folders are shared (for the bottom bar's "Public link"). */
async function loadShareIndex() {
  try { S.shares = (await api('GET', '/api/shares')).shares || []; } catch { return; }
  renderShareBadge();
}
const shareOf = (path) => (S.shares || []).find((x) => (x.kind === 'note' && x.path === path) || (x.kind === 'folder' && (path || '').startsWith(x.path + '/')));
function renderShareBadge() {
  const b = $('#wc-share'), sh = S.mode === 'note' ? shareOf(S.path) : null;
  b.hidden = !sh;
  if (!sh) return;
  const folder = sh.kind === 'folder';
  b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>` +
    `Public link${sh.edit ? ' · anyone can edit' : ''}${folder ? ` · via folder ${esc(sh.path.split('/').pop())}` : ''}`;
  b.title = `${folder ? `The folder “${sh.path}” is` : 'This note is'} shared: ${sh.url}`;
  b.onclick = () => openShare(sh.path, folder);
}
const shareDlg = $('#dlg-share');
const shareState = { path: null, folder: false, share: null };
async function openShare(path, folder) {
  Object.assign(shareState, { path, folder, share: null });
  const name = folder ? path.split('/').pop() : basename(path);
  $('#share-title').textContent = `Share “${name}”`;
  shareWhat();
  $('#share-off').hidden = $('#share-on').hidden = true;
  $('#share-blocked').hidden = true;
  if (!shareDlg.open) shareDlg.showModal();
  let r;
  try { r = await api('GET', '/api/shares'); } catch (e) { toast(e.message); return; }
  if (r.blocker) { $('#share-blocked').textContent = r.blocker; $('#share-blocked').hidden = false; return; }
  shareState.share = r.shares.find((x) => x.path === path && x.kind === (folder ? 'folder' : 'note')) || null;
  renderShare();
}
function shareWhat() {
  const edit = !!shareState.share?.edit, folder = shareState.folder;
  $('#share-what').textContent = folder
    ? `Anyone with the link can read${edit ? ' and edit' : ''} every note in this folder, including notes added later. ${edit ? 'They can\'t create, rename or delete notes, or' : 'They can\'t change anything or'} see your other notes.`
    : `Anyone with the link can read${edit ? ' and edit' : ''} this note. ${edit ? 'Their edits merge with yours as they type. They can\'t' : 'They can\'t change it or'} see your other notes.`;
}
function renderShare() {
  const sh = shareState.share;
  $('#share-off').hidden = !!sh;
  $('#share-on').hidden = !sh;
  if (sh) { $('#share-url').value = sh.url; $('#share-open').href = sh.url; $('#share-edit').checked = !!sh.edit; }
  shareWhat();
}
$('#share-edit').onchange = async (e) => {
  const want = e.target.checked;
  try {
    shareState.share = await api('PUT', '/api/shares', { token: shareState.share.token, edit: want });
    renderShare();
    loadShareIndex();
    toast(want ? 'People with the link can now edit' : 'The link is read-only again');
  } catch (err) { e.target.checked = !want; toast(err.message); }
};
$('#btn-share-create').onclick = async () => {
  try {
    shareState.share = await api('POST', '/api/shares', { path: shareState.path });
    renderShare();
    loadShareIndex();
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
  try { await api('DELETE', `/api/shares?token=${enc(shareState.share.token)}`); shareState.share = null; renderShare(); loadShareIndex(); toast('No longer shared'); } catch (e) { toast(e.message); }
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
    li.innerHTML = `<span class="who"><b>${esc(label)}</b>${sh.edit ? '<span class="badge">can edit</span>' : ''}<span class="shares-list-url">${esc(sh.url)}</span></span>` +
      `<button type="button" class="btn" data-act="copy">Copy</button><button type="button" class="btn danger" data-act="stop">Stop</button>`;
    li.querySelector('[data-act="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(sh.url); toast('Link copied'); } catch { toast(sh.url); } };
    li.querySelector('[data-act="stop"]').onclick = async () => {
      if (!confirm(`Stop sharing “${label}”? The link stops working.`)) return;
      try { await api('DELETE', `/api/shares?token=${enc(sh.token)}`); loadShares(); loadShareIndex(); } catch (e) { toast(e.message); }
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
  $('#branding-wrap').hidden = !editable; // only admins see (and change) branding
  $('#brand-admin-note').hidden = editable;
  for (const x of document.querySelectorAll('.brand-pane input, .brand-pane button')) x.disabled = !editable;
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
const cssBox = $('#custom-css-input');
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
      calendarUrl: sel.value === NEW_LIST ? '' : sel.value, calendarName: sel.value && sel.value !== NEW_LIST ? sel.selectedOptions[0]?.textContent || '' : '',
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

// ---------------------------------------------------------------- sync history (per account)
const logDlg = $('#dlg-synclog');
const PRIO = { 1: '🔺 high', 5: '🔼 medium', 9: '🔽 low' };
function showValue(field, v) {
  if (v == null || v === '' || v === 0) return field === 'done' ? 'not done' : '—';
  if (field === 'done') return v ? 'done' : 'not done';
  if (field === 'priority') return PRIO[v] || String(v);
  if (field === 'repeats') return describeRecurrence(v);
  if (field === 'title') return `“${v}”`;
  return String(v);
}
async function openSyncLog(id, name) {
  logDlg.dataset.id = id;
  $('#synclog-title').textContent = `Sync history · ${name}`;
  $('#synclog-list').innerHTML = '<li class="note">Loading…</li>';
  if (!logDlg.open) logDlg.showModal();
  try { logDlg.runs = await api('GET', `/api/sync/history?account=${enc(id)}`); } catch (e) { $('#synclog-list').innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  renderSyncLog();
}
function renderSyncLog() {
  const only = $('#synclog-changes').checked;
  const changed = (r) => r.error || r.errors?.length || Object.values(r.counts || {}).some(Boolean);
  const runs = (logDlg.runs || []).filter((r) => !only || changed(r));
  const ul = $('#synclog-list');
  if (!runs.length) { ul.innerHTML = `<li class="note">${only ? 'No syncs changed anything lately.' : 'No syncs yet. They show up here from now on.'}</li>`; return; }
  ul.innerHTML = runs.map((r) => {
    const c = r.counts || {};
    const sent = (c.created || 0) + (c.pushed || 0) + (c.deletedRemote || 0), got = (c.pulled || 0) + (c.imported || 0) + (c.deletedLocal || 0);
    const summary = r.error ? esc(r.error) : sent || got || r.errors?.length
      ? [sent && `↑ ${sent} sent`, got && `↓ ${got} received`, r.errors?.length && `${r.errors.length} failed`].filter(Boolean).join(' · ')
      : 'No changes';
    const items = (r.items || []).map((it) => {
      const what = { created: 'new task', updated: 'changed', deleted: 'deleted', new: 'new task' }[it.kind] || it.kind;
      const ch = (it.changes || []).map((x) => `${esc(x.field)}: ${esc(showValue(x.field, x.from))} → ${esc(showValue(x.field, x.to))}`).join('; ');
      return `<li class="${it.dir}"><span class="arrow" title="${it.dir === 'sent' ? 'Sent to the server' : 'Received from the server'}">${it.dir === 'sent' ? '↑' : '↓'}</span>` +
        `<span><b>${esc(it.title || '(untitled)')}</b> <span class="meta">${esc(what)}${it.path ? ` · ${esc(basename(it.path))}` : ''}</span>${ch ? `<span class="chg">${ch}</span>` : ''}</span></li>`;
    }).join('') + (r.more ? `<li class="note">…and ${r.more} more</li>` : '') + (r.errors || []).map((e) => `<li class="err"><span class="arrow">!</span><span>${esc(e)}</span></li>`).join('');
    const d = new Date(r.at);
    return `<li class="run ${r.error ? 'bad' : changed(r) ? 'changed' : 'quiet'}"><details${items ? '' : ' class="no-items"'}><summary>` +
      `<span class="dot"></span><span class="when" title="${esc(d.toLocaleString())}">${esc(d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span>` +
      `<span class="sum">${summary}</span></summary>${items ? `<ul class="items">${items}</ul>` : ''}</details></li>`;
  }).join('');
}
$('#synclog-changes').onchange = renderSyncLog;

// ---------------------------------------------------------------- deleted tasks
const SOURCE = { notes: 'removed from your notes', remote: 'deleted in a task app', both: 'deleted in both places' };

/** Tasks a sync put in Deleted tasks. Removing a tag deletes the todo but keeps the line, so it isn't counted. */
const trashedCount = (r) => (r ? r.trashed ?? r.deletedLocal + r.deletedRemote : 0);
/**
 * After any sync (this device's, another's, or the server's timer) that brought in new tasks or
 * deleted some, say so, with a way to look: open the note they arrived in, or Deleted tasks.
 */
function noticeDeletions(st) {
  const r = st.lastResult;
  const gone = trashedCount(r), added = r?.imported || 0;
  if ((!gone && !added) || !st.lastRun || st.lastRun === S.deletionsNoticed) return;
  S.deletionsNoticed = st.lastRun;
  if (Date.now() - new Date(st.lastRun) > 60000) return; // an old result replayed on connect
  const notes = r.importedNotes || [];
  const parts = [], actions = [];
  if (added) {
    parts.push(`${added} new task${added === 1 ? '' : 's'}${notes.length === 1 ? ` in ${basename(notes[0])}` : ''}`);
    if (notes.length) actions.push({ label: gone ? 'Review new' : 'Review', run: () => openNewTasks(notes) });
  }
  if (gone) {
    parts.push(`${gone} synced task${gone === 1 ? ' was' : 's were'} deleted`);
    actions.push({ label: added ? 'Review deleted' : 'Review', run: () => openSettings('deleted') });
  }
  toast(parts.join(' · '), actions);
}
/** Open the note new tasks arrived in (a menu to pick one if they went to several). */
function openNewTasks(notes) {
  if (notes.length === 1) return open(notes[0]);
  showMenu(el.sync, notes.map((p) => ({ label: basename(p), run: () => open(p) })));
}

const delDlg = $('#dlg-deleted');
/** The Deleted tasks dialog: every note's, or (with `path`) just the tasks deleted from that note. */
function openDeleted({ path = null } = {}) {
  S.deletedScope = path;
  loadDeleted();
  if (!delDlg.open) delDlg.showModal();
}

/** The Deleted tasks list, in its dialog ('dlg', which can be one note's) or in Settings ('set'). */
const DEL_VIEWS = {
  dlg: { ul: '#deleted-list', empty: '#deleted-empty', btn: '#btn-empty-deleted' },
  set: { ul: '#set-deleted-list', empty: '#set-deleted-empty', btn: '#btn-set-empty-deleted' },
};
async function loadDeleted(view = 'dlg') {
  const v = DEL_VIEWS[view];
  const ul = $(v.ul);
  let list;
  try { list = await api('GET', '/api/deleted'); } catch (e) { ul.innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  const scope = view === 'dlg' ? S.deletedScope : null;
  if (scope) list = list.filter((d) => d.path === scope);
  if (view === 'dlg') {
    const scopeEl = $('#deleted-scope');
    scopeEl.hidden = !scope;
    if (scope) scopeEl.querySelector('b').textContent = basename(scope);
  }
  $(v.empty).textContent = scope ? 'Nothing deleted from this note recently.' : 'Nothing deleted recently.';
  $(v.empty).hidden = list.length > 0;
  $(v.btn).hidden = !list.length || !!scope;
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
        loadDeleted(view);
        if (r.path === S.path) reloadIfClean();
        if (syncConfigured()) scheduleSync(1500);
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    };
    li.querySelector('[data-act="forget"]').onclick = async () => {
      if (!confirm(`Delete “${d.title}” forever? It can't be restored after this.`)) return;
      try { await api('DELETE', `/api/deleted?id=${d.id}`); loadDeleted(view); } catch (err) { toast(err.message); }
    };
    ul.append(li);
  }
}
$('#btn-deleted-all').onclick = () => { S.deletedScope = null; loadDeleted(); };
for (const [view, v] of Object.entries(DEL_VIEWS)) {
  $(v.btn).onclick = async () => {
    if (!confirm("Delete everything in Deleted tasks forever? None of it can be restored after this.")) return;
    try { await api('DELETE', '/api/deleted?id=all'); loadDeleted(view); } catch (e) { toast(e.message); }
  };
}

// ---------------------------------------------------------------- trash (the sidebar's Trash button)
const trashDlg = $('#dlg-trash');
function openTrash() { loadTrash(); if (!trashDlg.open) trashDlg.showModal(); }
$('#btn-trash').onclick = () => openTrash();
/** How many things are in the trash, beside the sidebar's Trash button. */
async function updateTrashCount() {
  try { const n = (await api('GET', '/api/trash')).length; $('#trash-count').textContent = n ? String(n) : ''; } catch {}
}
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function loadTrash() {
  const ul = $('#trash-list');
  let list;
  try { list = await api('GET', '/api/trash'); } catch (e) { ul.innerHTML = `<li class="note err">${esc(e.message)}</li>`; return; }
  $('#trash-count').textContent = list.length ? String(list.length) : '';
  $('#trash-empty').hidden = list.length > 0;
  $('#btn-trash-empty').hidden = !list.length;
  ul.hidden = !list.length;
  ul.innerHTML = '';
  for (const t of list) {
    const li = document.createElement('li');
    const name = t.folder ? t.path.split('/').pop() : basename(t.path);
    const where = dirname(t.path);
    li.innerHTML = `<span class="what"><b>${t.folder ? '📁 ' : ''}${esc(name)}</b>` +
      `<span class="meta">${where ? `from <span class="where">${esc(where)}</span> · ` : ''}deleted ${esc(relTime(t.deletedAt))} · ` +
      `${t.folder ? `${t.notes} note${t.notes === 1 ? '' : 's'}, ` : ''}${fmtSize(t.size)}</span></span>` +
      `<span class="acts"><button type="button" class="btn" data-act="restore">Restore</button>` +
      `<button type="button" class="icon-btn" data-act="forget" aria-label="Delete ${esc(name)} forever" title="Delete forever">` +
      `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`;
    li.querySelector('[data-act="restore"]').onclick = async () => {
      try {
        const r = await api('POST', '/api/trash/restore', { name: t.name });
        await loadTree();
        loadTrash();
        toast(`Restored ${t.folder ? 'folder' : ''} “${name}”${r.path !== t.path ? ` as ${r.path}` : ''}`,
          t.folder ? undefined : { label: 'Open', run: () => { trashDlg.close(); open(r.path); } });
      } catch (e) { toast(e.message); }
    };
    li.querySelector('[data-act="forget"]').onclick = async () => {
      if (!confirm(`Delete “${name}” forever? It can't be restored after this.`)) return;
      try { await api('DELETE', `/api/trash?name=${enc(t.name)}`); loadTrash(); } catch (e) { toast(e.message); }
    };
    ul.append(li);
  }
}
$('#btn-trash-empty').onclick = async () => {
  if (!confirm('Delete everything in the trash forever? None of it can be restored after this.')) return;
  try { await api('DELETE', '/api/trash?name=all'); loadTrash(); } catch (e) { toast(e.message); }
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

async function signOut() {
  if (!confirm('Sign out of Tickmark on this device?')) return;
  await flushSave();
  try { await api('POST', '/api/auth/logout'); } catch {}
  await clearApiCache();
  location.replace('/');
}
$('#btn-logout').onclick = () => signOut();

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
  const es = new EventSource(`/api/events?pid=${enc(PID)}`);
  es.addEventListener('file', (e) => {
    const d = JSON.parse(e.data);
    if (d.path !== S.path || d.hash === S.hash) return;
    // Someone else changed the note. Collaborating: send our edits now, and the server's merge comes back.
    if (othersHere().length && el.editor.value !== S.base) flushSave();
    else reloadIfClean();
  });
  es.addEventListener('presence', (e) => { S.presence = JSON.parse(e.data); renderPresence(); });
  es.addEventListener('tree', () => scheduleTree());
  es.addEventListener('sync', (e) => {
    S.sync = JSON.parse(e.data);
    renderSync();
    noticeDeletions(S.sync);
  });
  es.onopen = () => flushPending();
}

// ---------------------------------------------------------------- live collaboration (presence)
// Each tab says which note it has open (and the cursor's line). When others are on the same note,
// edits save within a second and theirs merge in as they arrive; chips show who's there.
const PID = Math.random().toString(36).slice(2) + Date.now().toString(36);
S.presence = { people: [], publicViewers: {} };
const othersHere = () => (S.mode === 'note' && S.collab ? S.presence.people.filter((p) => p.path === S.path && p.id !== PID) : []);
/** The caret as line and column, which survive other people's edits better than an offset. */
function cursorAt() {
  const before = el.editor.value.slice(0, el.editor.selectionStart);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, col: before.length - nl - 1 };
}
async function sendPresence() {
  const path = S.mode === 'note' ? S.path : null;
  const at = path ? cursorAt() : { line: null, col: null };
  if (path && path === sendPresence.path && at.line === sendPresence.line && at.col === sendPresence.col && Date.now() - sendPresence.at < 20000) return;
  Object.assign(sendPresence, { path, ...at, at: Date.now() });
  try {
    const r = await api('POST', '/api/presence', { id: PID, path, ...at });
    if (S.collab !== r.allowed) { S.collab = r.allowed; renderPresence(); }
  } catch {}
}
const slowPresence = debounce(sendPresence, 600), quickPresence = debounce(sendPresence, 150);
// With someone else in the note, cursors move for them within a moment.
const reportPresence = () => (othersHere().length ? quickPresence() : slowPresence());
setInterval(() => { if (document.visibilityState === 'visible' && S.mode === 'note') reportPresence(); }, 25000);
el.editor.addEventListener('keyup', () => reportPresence());
el.editor.addEventListener('click', () => reportPresence());
el.editor.addEventListener('input', () => reportPresence());
addEventListener('pagehide', () => { fetch(`/api/presence?id=${enc(PID)}`, { method: 'DELETE', keepalive: true }).catch(() => {}); });
const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function renderPresence() {
  const box = $('#presence');
  const others = othersHere();
  const watching = S.collab && S.mode === 'note' ? S.presence.publicViewers?.[S.path] || 0 : 0;
  box.innerHTML = others.map((p) => {
    const who = p.name || 'You';
    const label = `${who} · ${p.device}${p.line != null ? ` · line ${p.line + 1}` : ''}`;
    return `<span class="pchip" style="--h:${hue(p.id)}" title="${esc(label)}">${esc((p.name || p.device || '?')[0].toUpperCase())}</span>`;
  }).join('') + (watching ? `<span class="pchip watch" title="${watching} ${watching === 1 ? 'person is' : 'people are'} viewing through the public link">👁 ${watching}</span>` : '');
  box.title = others.length ? 'Also editing this note: edits are shared within a second' : '';
  renderCursors();
}

// ---------------------------------------------------------------- global shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') { e.preventDefault(); openPalette(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); save(); }
  else if (k === 'p' && e.shiftKey) { e.preventDefault(); openPalette(); }
  else if (k === 'p' || k === 'o') { e.preventDefault(); openSwitcher(); }
  else if (k === '/' || k === '?') { e.preventDefault(); openKeys(); }
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
  checkForUpdate();
  if (syncConfigured()) setTimeout(() => runSync(), 1500);
}
boot();
