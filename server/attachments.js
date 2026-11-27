// Files pasted or dropped into notes (images, PDFs…): kept in the vault's hidden .attachments folder
// (hidden from the sidebar, search and note history, like .trash) and linked from the note as
// /attachments/<name>. Settings → Attachments lists them and which notes use them.

import fs from 'node:fs';
import path from 'node:path';

export const ATTACH_DIR = '.attachments';
const MAX_MB = Math.max(1, Number(process.env.TICKMARK_ATTACHMENT_MAX_MB) || 10);
export const MAX_ATTACHMENT = MAX_MB * 1024 * 1024;

// What the browser may show inline. Anything else downloads (and never runs: see headers()).
const INLINE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
};
const IMAGE = /^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/;

export class AttachmentError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ext = (name) => (path.extname(name).slice(1) || '').toLowerCase();
/** A safe file name: letters, digits, dot, dash, underscore; no leading dot. */
export function cleanName(name) {
  const base = path.basename(String(name || '')).normalize('NFKC');
  const e = ext(base).replace(/[^a-z0-9]/g, '').slice(0, 10);
  let stem = base.slice(0, base.length - (path.extname(base).length)).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  if (!stem) stem = 'file';
  return e ? `${stem}.${e}` : stem;
}

export class Attachments {
  constructor(vaultDir) { this.dir = path.join(vaultDir, ATTACH_DIR); this.vaultDir = vaultDir; }

  // Which note each file was pasted into (.attachments/.index.json). A public link serves only files
  // that came from the notes it shares, so a guest who can edit a shared note can't pull in others.
  meta() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, '.index.json'), 'utf8')); } catch { return {}; } }
  setMeta(m) {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = path.join(this.dir, '.index.json'), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
    fs.renameSync(tmp, f);
  }
  origin(name) { return this.meta()[name]?.note || null; }
  /** Notes were renamed or moved: their attachments' origins follow. `moved`: [[from, to]]. */
  notesMoved(moved) {
    const m = this.meta();
    let changed = false;
    for (const v of Object.values(m)) for (const [from, to] of moved) if (v.note === from) { v.note = to; changed = true; }
    if (changed) this.setMeta(m);
  }

  file(name) {
    const n = path.basename(String(name || ''));
    if (!n || n !== name || n.startsWith('.')) throw new AttachmentError('No such attachment', 404);
    return path.join(this.dir, n);
  }

  /** Save `data` (a Buffer) as `name`, numbered if that's taken, from `note`. Returns { name, url, size, image }. */
  add(name, data, { note = null } = {}) {
    if (!data.length) throw new AttachmentError('That file is empty');
    if (data.length > MAX_ATTACHMENT) throw new AttachmentError(`Attachments can be up to ${MAX_MB} MB (TICKMARK_ATTACHMENT_MAX_MB)`, 413);
    fs.mkdirSync(this.dir, { recursive: true });
    const clean = cleanName(name);
    const e = path.extname(clean), stem = clean.slice(0, clean.length - e.length);
    let n = clean;
    for (let i = 1; fs.existsSync(path.join(this.dir, n)); i++) n = `${stem}-${i}${e}`;
    const tmp = path.join(this.dir, `.${n}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, path.join(this.dir, n));
    if (note) { const m = this.meta(); m[n] = { note }; this.setMeta(m); }
    return this.info(n);
  }

  info(n, st = fs.statSync(path.join(this.dir, n))) {
    return { name: n, url: `/attachments/${encodeURIComponent(n)}`, size: st.size, modified: new Date(st.mtimeMs).toISOString(), image: IMAGE.test(ext(n)) };
  }

  /** Every attachment, newest first, with the notes that link to it (`notes`: [{ path, content }]). */
  list(notes = []) {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => !n.startsWith('.')); } catch {}
    const out = [];
    for (const n of names) {
      let st;
      try { st = fs.statSync(path.join(this.dir, n)); } catch { continue; }
      if (!st.isFile()) continue;
      const needles = [`/attachments/${encodeURIComponent(n)}`, `/attachments/${n}`];
      out.push({ ...this.info(n, st), usedIn: notes.filter((x) => needles.some((s) => x.content.includes(s))).map((x) => x.path) });
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  remove(name) {
    try { fs.rmSync(this.file(name)); } catch (e) { if (e.code === 'ENOENT') throw new AttachmentError('No such attachment', 404); throw e; }
    const m = this.meta();
    if (m[name]) { delete m[name]; this.setMeta(m); }
  }

  rename(from, to) {
    const a = this.file(from);
    if (!fs.existsSync(a)) throw new AttachmentError('No such attachment', 404);
    let n = cleanName(to);
    if (ext(n) !== ext(from) && ext(from)) n = `${n.replace(/\.[^.]*$/, '')}.${ext(from)}`; // keep the type
    if (n === from) return this.info(n);
    if (fs.existsSync(path.join(this.dir, n))) throw new AttachmentError('An attachment with that name exists', 409);
    fs.renameSync(a, path.join(this.dir, n));
    const m = this.meta();
    if (m[from]) { m[n] = m[from]; delete m[from]; this.setMeta(m); }
    return this.info(n);
  }

  /** Send one. Only known media types show inline; nothing served from here can run scripts. */
  serve(name, res, { download = false } = {}) {
    let abs, st;
    try { abs = this.file(name); st = fs.statSync(abs); } catch { return false; }
    if (!st.isFile()) return false;
    const type = INLINE[ext(name)];
    res.writeHead(200, {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `${type && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // Sandboxed, so an SVG or HTML file opened on its own can't run scripts on this origin. (A PDF
      // can't be sandboxed or the browser's viewer won't open it; that viewer runs apart from the page.)
      ...(ext(name) === 'pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  }
}
