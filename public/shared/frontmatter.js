// A note's frontmatter (the --- block at the top) as editable properties, for the Properties panel.
// Only the shapes people write by hand are taken apart: `key: value`, `key: [a, b]` and a block list
// (`key:` then `  - a` lines). Anything else under a key (nested maps, multi-line text) is kept as raw
// text, and comments and blank lines stay where they were, so saving never loses what it doesn't understand.

const FM = /^---\r?\n([\s\S]*?)\r?\n?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const KEY = /^([^\s#:-][^:]*?)\s*:(?:\s+(.*?))?\s*$/;

/** { has, entries: [{ key, kind: 'text'|'list'|'inline'|'raw'|'other', value, indent }], body } */
export function parseFrontmatter(text) {
  const m = text.match(FM);
  if (!m) return { has: false, entries: [], body: text };
  const lines = m[1] === '' ? [] : m[1].split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(KEY);
    if (!k) { entries.push({ key: null, kind: 'other', value: lines[i] }); continue; }
    const key = k[1], val = k[2] ?? '';
    const sub = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]))) sub.push(lines[++i]);
    if (sub.length && !val && sub.every((l) => /^\s*-\s/.test(l))) {
      entries.push({ key, kind: 'list', value: sub.map((l) => unquote(l.replace(/^\s*-\s+/, ''))), indent: sub[0].match(/^\s*/)[0] });
    } else if (sub.length) {
      entries.push({ key, kind: 'raw', value: [val, ...sub].filter((x, j) => j > 0 || x).join('\n') , first: val });
    } else if (/^\[.*\]$/.test(val)) {
      entries.push({ key, kind: 'inline', value: splitList(val.slice(1, -1)) });
    } else {
      entries.push({ key, kind: 'text', value: val });
    }
  }
  return { has: true, entries, body: text.slice(m[0].length) };
}

/** "a, \"b, c\", d" → ['a', 'b, c', 'd']: commas inside quotes don't split. */
function splitList(s) {
  const out = [];
  for (const m of s.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,]*)\s*(?:,|$)/g)) {
    if (m[0] === '' && m.index >= s.length) break;
    const v = m[1].trim();
    if (v) out.push(/^"/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v.slice(1, -1); } })() : unquote(v));
  }
  return out;
}
const unquote = (s) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);
const quoteItem = (s) => (/[,[\]{}#:]|^\s|\s$|^["']/.test(s) ? JSON.stringify(s) : s);

/** The note's text with its frontmatter rebuilt from `entries` (none left: no frontmatter at all). */
export function writeFrontmatter(body, entries) {
  const out = [];
  for (const e of entries) {
    if (e.key == null) { out.push(e.value); continue; }
    if (e.kind === 'list') {
      if (!e.value.length) out.push(`${e.key}: []`);
      else out.push(`${e.key}:`, ...e.value.map((v) => `${e.indent ?? '  '}- ${quoteItem(v)}`));
    } else if (e.kind === 'inline') out.push(`${e.key}: [${e.value.map(quoteItem).join(', ')}]`);
    else if (e.kind === 'raw') {
      const [first, ...rest] = String(e.value).split('\n');
      // The first line is the text after "key:" if it wasn't indented (as parsed), else the block starts at once.
      if (/^\s/.test(first) || first === '') out.push(`${e.key}:`, ...[first, ...rest].filter((l, j) => j > 0 || l));
      else out.push(`${e.key}: ${first}`, ...rest);
    } else out.push(e.value === '' ? `${e.key}:` : `${e.key}: ${e.value}`);
  }
  while (out.length && out.at(-1).trim() === '') out.pop();
  if (!out.some((l) => l.trim())) return body;
  return `---\n${out.join('\n')}\n---\n${body}`;
}
