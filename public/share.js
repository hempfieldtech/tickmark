// A public link (/s/<token>, or /s/<token>/<note in the shared folder>): read-only, or, when the owner
// allows it, editable (checkboxes in the page, and Edit for the note's markdown).
import { marked } from './vendor/marked.esm.js';
import { checkboxLines, toggleLine, openSubtasks } from './shared/tasks.js';
import { highlight } from './shared/highlight.js';
import { safeUrl } from './shared/url.js';
import { cleanHtml, OWN } from './shared/html.js';
import { lineCol, cursorsHTML } from './shared/caret.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (s) => document.querySelector(s);
const [, , token, ...rest] = location.pathname.split('/');
const base = `/s/${token}`;
let files = [];

const stem = (p) => p.replace(/\.md$/i, '');
const title = (p) => stem(p).split('/').pop();
/** A [[link]] to another note in the shared folder, the way the app resolves it. */
function resolve(target) {
  const t = stem(target.replace(/[#^].*$/, '').trim()).replace(/^\/+/, '').toLowerCase();
  if (!t) return null;
  return files.find((f) => stem(f).toLowerCase() === t) || files.find((f) => title(f).toLowerCase() === t.split('/').pop()) || null;
}
const hrefFor = (file) => `${base}/${file.split('/').map(encodeURIComponent).join('/')}`;

marked.use({
  gfm: true,
  renderer: {
    checkbox({ checked }) { return `<input type="checkbox" class="pub-cb" data-own="${OWN}"${checked ? ' checked' : ''}>`; },
    html({ text }) { return text; }, // the note's own HTML and CSS, cleaned by cleanHtml below
    link({ href, title: t, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!safeUrl(href)) return text;
      const ext = /^(https?:|mailto:)/i.test(href);
      return `<a href="${esc(href)}"${t ? ` title="${esc(t)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
    },
    code({ text, lang }) {
      const h = highlight(text.replace(/\n$/, ''), lang);
      return `<div class="codeblock" data-family="${esc(h.family)}"${h.label ? ` data-lang="${esc(h.label)}"` : ''}><pre><code>${h.html}</code></pre></div>\n`;
    },
    image({ href, title: t, text }) {
      if (!safeUrl(href) || !/^https?:/i.test(href)) return esc(text); // vault-relative images aren't shared
      return `<img src="${esc(href)}" alt="${esc(text)}"${t ? ` title="${esc(t)}"` : ''} loading="lazy" referrerpolicy="no-referrer">`;
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
        // Embedded notes aren't part of a public page: say so rather than leave a gap.
        if (t.raw.startsWith('!')) return `<span class="embed-note" title="Embedded notes aren't shown on public pages">Embedded note “${esc(t.label)}” isn't shown here.</span>`;
        const f = resolve(t.target);
        return f ? `<a href="${esc(hrefFor(f))}" class="wikilink" data-file="${esc(f)}">${esc(t.label)}</a>`
          : `<span class="wikilink missing" title="Not part of this share">${esc(t.label)}</span>`;
      },
    },
    {
      name: 'tag', level: 'inline',
      start(src) { const m = /(^|[\s(])#[\p{L}\p{N}_/-]*[\p{L}_/-]/u.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) {
        const m = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u.exec(src);
        if (m) return { type: 'tag', raw: m[0], tag: m[1] };
      },
      renderer(t) { return `<span class="tag">#${esc(t.tag)}</span>`; },
    },
    {
      name: 'blockid', level: 'inline',
      start(src) { const m = /(^|[ \t])\^[A-Za-z0-9-]+[ \t]*(?:\n|$)/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) { const m = /^\^[A-Za-z0-9-]+(?=[ \t]*(?:\n|$))/.exec(src); if (m) return { type: 'blockid', raw: m[0] }; },
      renderer() { return ''; },
    },
  ],
});

// ---- the note on show, and editing it (when the link allows that)
const doc = { content: '', base: '', name: '', sub: '', edit: false, editing: false, saving: null, again: false };

function render(content, name) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  // Show the note's name as its title unless it starts with its own heading.
  const head = /^\s*#\s/.test(body) ? '' : `<h1 class="share-title">${esc(name)}</h1>`;
  $('#doc').innerHTML = head + (body.trim() ? cleanHtml(marked.parse(body), '#doc') : '<p class="share-empty">This note is empty.</p>');
  // "[/] …" (in progress) and "[-] …" (cancelled) are checkboxes too, so they line up with the source lines.
  $('#doc').querySelectorAll('li').forEach((li) => {
    const host = li.firstChild?.nodeName === 'P' ? li.firstChild : li;
    const t = host.firstChild;
    const m = t?.nodeType === 3 && /^\[([/-])\]\s/.exec(t.textContent);
    if (!m) return;
    t.textContent = t.textContent.slice(m[0].length);
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'pub-cb';
    if (m[1] === '-') { cb.checked = true; li.classList.add('cancelled-item'); } else cb.indeterminate = true;
    host.insertBefore(cb, host.firstChild);
  });
  const lines = checkboxLines(content);
  $('#doc').querySelectorAll('input.pub-cb').forEach((cb, i) => {
    cb.dataset.line = lines[i] ?? '';
    cb.disabled = !doc.edit || lines[i] == null;
    if (cb.checked) cb.closest('li')?.classList.add('done-item');
  });
  $('#doc').classList.toggle('editable', doc.edit);
}

function showNote(content, name, sub) {
  const fresh = sub !== doc.sub || name !== doc.name;
  Object.assign(doc, { name, sub });
  if (doc.editing && !fresh) {
    // Someone else changed it while this page edits: take their version if nothing is unsaved here.
    const ta = $('#editor-pub');
    if (ta.value === doc.base && content !== doc.base) {
      const a = ta.selectionStart, b = ta.selectionEnd;
      ta.value = content;
      ta.setSelectionRange(Math.min(a, content.length), Math.min(b, content.length));
    }
    if (ta.value === doc.base) doc.base = doc.content = content;
    return;
  }
  doc.content = doc.base = content;
  if (fresh) setEditing(false);
  render(content, name);
}

function setEditing(on) {
  doc.editing = on && doc.edit;
  $('#btn-edit').hidden = !doc.edit;
  $('#btn-edit').textContent = doc.editing ? 'Done' : 'Edit';
  $('#btn-edit').setAttribute('aria-pressed', String(doc.editing));
  $('#editor-pub').hidden = !doc.editing;
  $('#doc').hidden = doc.editing;
  if (doc.editing) { $('#editor-pub').value = doc.content; $('#editor-pub').focus(); }
  else if (doc.edit) render(doc.content, doc.name);
  sendPresence();
  renderCursors();
}

// ---- live collaboration: where this page's caret is (while editing), and everyone else's
const PID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let people = [];
const subQuery = () => (doc.sub ? `?path=${encodeURIComponent(doc.sub)}` : '');
let lastSent = '';
async function sendPresence(force = false) {
  if (!doc.edit) return;
  const at = doc.editing ? lineCol($('#editor-pub')) : { line: null, col: null };
  const key = `${doc.sub}|${at.line}|${at.col}`;
  if (key === lastSent && !force) return;
  lastSent = key;
  try {
    await fetch(`/api/public/${encodeURIComponent(token)}/presence${subQuery()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: PID, ...at }),
    });
  } catch {}
}
let presTimer = 0;
const reportPresence = () => { clearTimeout(presTimer); presTimer = setTimeout(sendPresence, 150); };
for (const ev of ['keyup', 'click', 'input']) document.addEventListener(ev, (e) => { if (e.target.id === 'editor-pub') reportPresence(); });
// The server forgets a caret after a minute without news.
setInterval(() => { if (doc.edit && document.visibilityState === 'visible') sendPresence(true); }, 25000);
function renderCursors() {
  const layer = $('#cursors-pub'), ta = $('#editor-pub');
  const others = people.filter((p) => p.id !== 'g-' + PID);
  layer.innerHTML = doc.editing && others.length ? cursorsHTML(ta, layer, others) : '';
}
const renderCursorsSoon = (() => { let raf = 0; return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCursors); }; })();
$('#editor-pub').addEventListener('scroll', renderCursorsSoon);
document.addEventListener('input', (e) => { if (e.target.id === 'editor-pub') renderCursorsSoon(); });
addEventListener('resize', renderCursorsSoon);
addEventListener('scroll', renderCursorsSoon, { passive: true });
new ResizeObserver(renderCursorsSoon).observe($('#editor-pub'));

async function savePub() {
  if (doc.saving) { doc.again = true; return; }
  const content = doc.editing ? $('#editor-pub').value : doc.content;
  if (content === doc.base) return status('');
  status('Saving…');
  doc.saving = (async () => {
    try {
      const r = await fetch(`/api/public/${encodeURIComponent(token)}${doc.sub ? `?path=${encodeURIComponent(doc.sub)}` : ''}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, baseContent: doc.base }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      doc.base = data.content;
      if (!doc.editing) { doc.content = data.content; render(doc.content, doc.name); }
      else if ($('#editor-pub').value === content && data.merged) { $('#editor-pub').value = data.content; }
      doc.content = doc.editing ? $('#editor-pub').value : doc.content;
      status(data.conflicts ? 'Saved, but some edits clashed: look for the conflict markers' : 'Saved');
    } catch (e) { status(`Couldn't save: ${e.message}`, true); }
    finally { doc.saving = null; if (doc.again) { doc.again = false; savePub(); } }
  })();
}
const status = (msg, err = false) => { const el = $('#pub-state'); el.textContent = msg; el.classList.toggle('err', err); };
let saveTimer = 0;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'editor-pub') return;
  status('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePub, 1200);
});
document.addEventListener('focusout', (e) => { if (e.target.id === 'editor-pub') { clearTimeout(saveTimer); savePub(); } });
addEventListener('pagehide', () => {
  if (!doc.edit) return;
  const content = doc.editing ? $('#editor-pub').value : doc.content;
  if (content !== doc.base) fetch(`/api/public/${encodeURIComponent(token)}${doc.sub ? `?path=${encodeURIComponent(doc.sub)}` : ''}`,
    { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, baseContent: doc.base }) });
});
$('#doc').addEventListener('click', (e) => {
  const cb = e.target.closest('input.pub-cb');
  if (!cb) return;
  e.preventDefault();
  if (!doc.edit || cb.dataset.line === '') return;
  const line = Number(cb.dataset.line);
  // Same rule as the app: an item with unchecked sub-items can't be checked yet.
  const open = /\[[ /]\]/.test(doc.content.split('\n')[line] || '') && openSubtasks(doc.content, line);
  if (open) return status(`Finish its ${open} sub-item${open === 1 ? '' : 's'} first`, true);
  doc.content = toggleLine(doc.content, line);
  render(doc.content, doc.name);
  savePub();
});
$('#btn-edit').onclick = async () => {
  if (doc.editing) { clearTimeout(saveTimer); await savePub(); await doc.saving; doc.content = $('#editor-pub').value; }
  setEditing(!doc.editing);
};

function renderFiles(active) {
  const nav = $('#files');
  nav.hidden = false;
  $('#wrap').classList.remove('single');
  nav.innerHTML = '<h2>Notes</h2>' + (files.length ? files.map((f) => {
    const dir = f.includes('/') ? `<span class="dir">${esc(f.slice(0, f.lastIndexOf('/') + 1))}</span>` : '';
    return `<a href="${esc(hrefFor(f))}" data-file="${esc(f)}"${f === active ? ' class="active" aria-current="page"' : ''}>${dir}${esc(title(f))}</a>`;
  }).join('') : '<p class="share-empty">No notes here yet.</p>');
}

// Live updates: the page re-reads the note when it changes (keeping the scroll position).
let live = null, liveFor = null;
function watch(sub) {
  if (liveFor === sub && live) return;
  live?.close();
  liveFor = sub;
  people = [];
  renderCursors();
  live = new EventSource(`/api/public/${encodeURIComponent(token)}/events?pid=${PID}${sub ? `&path=${encodeURIComponent(sub)}` : ''}`);
  live.addEventListener('change', () => { const y = scrollY; load(false, true).then(() => { scrollTo(0, y); renderCursorsSoon(); }); });
  live.addEventListener('presence', (e) => { people = JSON.parse(e.data).people || []; renderCursors(); });
}

async function load(push = false, quiet = false) {
  const sub = decodeURIComponent(location.pathname.slice(base.length + 1)) || '';
  let data;
  try {
    const r = await fetch(`/api/public/${encodeURIComponent(token)}${sub ? `?path=${encodeURIComponent(sub)}` : ''}`);
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Not found');
  } catch (e) {
    if (quiet) return; // a live refresh that failed: keep showing what's there
    $('#doc').innerHTML = `<p class="share-error">${esc(e.message)}</p>`;
    document.title = 'Not found';
    return;
  }
  const b = data.brand || {};
  document.querySelectorAll('.brand-name').forEach((x) => (x.textContent = b.name || 'Tickmark'));
  if (b.logo) document.querySelector('.brand img').src = b.logo;
  doc.edit = !!data.edit;
  $('#btn-edit').hidden = !doc.edit;
  if (data.kind === 'note') {
    showNote(data.content, data.name, '');
    document.title = `${data.name} · ${b.name || 'Tickmark'}`;
    watch('');
    return;
  }
  files = data.files;
  // A folder opens on its first note.
  if (!data.path && files.length) { history.replaceState(null, '', hrefFor(files[0])); return load(); }
  renderFiles(data.path);
  $('#crumb').textContent = data.name;
  if (data.path) { showNote(data.content, title(data.path), data.path); watch(data.path); }
  else $('#doc').innerHTML = '<p class="share-empty">This folder has no notes yet.</p>';
  document.title = `${data.path ? title(data.path) + ' · ' : ''}${data.name} · ${b.name || 'Tickmark'}`;
  if (push) scrollTo(0, 0);
}

// Moving between notes of a shared folder without reloading.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-file]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  if (doc.editing) { clearTimeout(saveTimer); savePub(); }
  history.pushState(null, '', a.getAttribute('href'));
  load(true);
});
addEventListener('popstate', () => load());
load();
