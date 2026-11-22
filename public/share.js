// Read-only view of a public link (/s/<token>, or /s/<token>/<note in the shared folder>).
import { marked } from './vendor/marked.esm.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => !/^\s*(javascript|vbscript|data):/i.test(u || '');
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
    checkbox({ checked }) { return `<input type="checkbox" disabled${checked ? ' checked' : ''}>`; },
    html({ text }) { return esc(text); }, // raw HTML shows as text, never runs
    link({ href, title: t, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!safeUrl(href)) return text;
      const ext = /^(https?:|mailto:)/i.test(href);
      return `<a href="${esc(href)}"${t ? ` title="${esc(t)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
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

function render(content, name) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  // Show the note's name as its title unless it starts with its own heading.
  const head = /^\s*#\s/.test(body) ? '' : `<h1 class="share-title">${esc(name)}</h1>`;
  $('#doc').innerHTML = head + (body.trim() ? marked.parse(body) : '<p class="share-empty">This note is empty.</p>');
  $('#doc').querySelectorAll('li').forEach((li) => { if (li.querySelector(':scope > input[checked], :scope > p > input[checked]')) li.classList.add('done-item'); });
}

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
  live = new EventSource(`/api/public/${encodeURIComponent(token)}/events${sub ? `?path=${encodeURIComponent(sub)}` : ''}`);
  live.addEventListener('change', () => { const y = scrollY; load(false, true).then(() => scrollTo(0, y)); });
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
  if (data.kind === 'note') {
    render(data.content, data.name);
    document.title = `${data.name} · ${b.name || 'Tickmark'}`;
    watch('');
    return;
  }
  files = data.files;
  // A folder opens on its first note.
  if (!data.path && files.length) { history.replaceState(null, '', hrefFor(files[0])); return load(); }
  renderFiles(data.path);
  $('#crumb').textContent = data.name;
  if (data.path) { render(data.content, title(data.path)); watch(data.path); }
  else $('#doc').innerHTML = '<p class="share-empty">This folder has no notes yet.</p>';
  document.title = `${data.path ? title(data.path) + ' · ' : ''}${data.name} · ${b.name || 'Tickmark'}`;
  if (push) scrollTo(0, 0);
}

// Moving between notes of a shared folder without reloading.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-file]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  load(true);
});
addEventListener('popstate', () => load());
load();
