// Keeping [[wikilinks]] pointing at a note when it's renamed or moved (or its folder is).

const FENCE = /^\s*(`{3,}|~{3,})/;
// [[target#heading|alias]] and ![[embeds]]: target, then the rest (fragment and alias) kept as is.
const WIKILINK = /(!?\[\[)([^\]|#^]+)([^\]]*\]\])/g;

const stem = (p) => p.replace(/\.md$/i, '');
const base = (p) => stem(p).split('/').pop();

/** The note a link target points at, the way the editor resolves it: full path first, then name. */
export function resolveTarget(target, paths) {
  const t = stem(target.trim()).replace(/^\/+/, '').toLowerCase();
  if (!t) return null;
  return paths.find((p) => stem(p).toLowerCase() === t) ||
    paths.find((p) => base(p).toLowerCase() === t.split('/').pop()) || null;
}

/**
 * Every note that moved: `from` → `to` for a note, or each note inside a folder.
 * @param paths the notes before the move
 */
export function movedNotes(from, to, paths) {
  if (/\.md$/i.test(from)) return paths.includes(from) ? new Map([[from, to]]) : new Map();
  const pre = from.replace(/\/+$/, '') + '/';
  return new Map(paths.filter((p) => p.startsWith(pre)).map((p) => [p, to.replace(/\/+$/, '') + '/' + p.slice(pre.length)]));
}

/**
 * Point links at their notes' new paths. A link by name stays a name (a path if the new name is
 * ambiguous); a link by path gets the new path. `.md` and the #heading/|alias parts are kept.
 * Code blocks and inline code are left alone. Returns the new text, or null if nothing changed.
 * @param moved  Map old path → new path
 * @param before every note's path before the move; `after` the same list after it
 */
export function rewriteLinks(text, moved, before, after) {
  let changed = false, fence = null;
  const lines = text.split('\n').map((line) => {
    const f = line.match(FENCE);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return line; }
    if (f) { fence = f[1]; return line; }
    // Split out inline code spans so links inside them aren't touched.
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part.replace(WIKILINK, (all, open, target, rest) => {
      const hit = resolveTarget(target, before);
      const dest = hit && moved.get(hit);
      if (!dest) return all;
      const lead = target.match(/^\s*/)[0], trail = target.match(/\s*$/)[0];
      const t = target.trim();
      const ext = /\.md$/i.test(t) ? t.slice(-3) : '';
      const byPath = t.replace(/^\/+/, '').includes('/');
      // Still finds it (a path must still be the path; a name may resolve by name).
      if (byPath ? stem(t).replace(/^\/+/, '').toLowerCase() === stem(dest).toLowerCase() : resolveTarget(t, after) === dest) return all;
      const name = base(dest);
      const unique = after.filter((p) => base(p).toLowerCase() === name.toLowerCase()).length === 1;
      const next = (byPath || !unique ? (t.startsWith('/') ? '/' : '') + stem(dest) : name) + ext;
      if (next === t) return all;
      changed = true;
      return open + lead + next + trail + rest;
    }))).join('');
  });
  return changed ? lines.join('\n') : null;
}
