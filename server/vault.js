// Flat-file vault: plain .md files in a folder. All writes are atomic (temp + rename) and
// synchronous, so a read-modify-write can never interleave with another request.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { merge3 } from './merge.js';

export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

export class VaultError extends Error {
  constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); }
}

export class Vault {
  constructor(root, { onWrite = () => {} } = {}) {
    this.root = path.resolve(root);
    this.onWrite = onWrite;
    fs.mkdirSync(this.root, { recursive: true });
  }

  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }

  resolve(rel, { md = false } = {}) {
    if (typeof rel !== 'string' || !rel.trim()) throw new VaultError('Missing path');
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) throw new VaultError('Invalid path');
    if (md && !clean.toLowerCase().endsWith('.md')) throw new VaultError('Only .md files can be written');
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new VaultError('Path escapes vault');
    return abs;
  }

  /** Walk the vault. Returns { files: [{path, mtime, size}], folders: [path] } */
  list() {
    const files = [], folders = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { folders.push(this.rel(abs)); walk(abs); }
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          const st = fs.statSync(abs);
          files.push({ path: this.rel(abs), mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    walk(this.root);
    return { files, folders };
  }

  exists(rel) { return fs.existsSync(this.resolve(rel)); }

  read(rel) {
    const abs = this.resolve(rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') throw new VaultError('Not found', 404);
      throw e;
    }
    return { path: rel, content, hash: sha(content), mtime: fs.statSync(abs).mtimeMs };
  }

  writeRaw(rel, content) {
    const abs = this.resolve(rel, { md: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
    this.onWrite(rel, content);
    return { path: rel, content, hash: sha(content) };
  }

  /**
   * Save from the editor. `baseContent` is what the editor last loaded; if the file changed
   * on disk since then, the edits are three-way merged instead of clobbering the disk copy.
   */
  save(rel, content, { baseContent = null } = {}) {
    const abs = this.resolve(rel, { md: true });
    let disk = null;
    try { disk = fs.readFileSync(abs, 'utf8'); } catch {}
    if (disk !== null && baseContent !== null && disk !== baseContent && disk !== content) {
      const { text, conflicts } = merge3(baseContent, content, disk);
      return { ...this.writeRaw(rel, text), merged: true, conflicts };
    }
    if (disk === content) return { path: rel, content, hash: sha(content), merged: false };
    return { ...this.writeRaw(rel, content), merged: false };
  }

  /** Synchronously read → transform → write. fn returns the new text, or null for no change. */
  modify(rel, fn) {
    let cur = '';
    try { cur = fs.readFileSync(this.resolve(rel), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const next = fn(cur);
    if (next == null || next === cur) return false;
    this.writeRaw(rel, next);
    return true;
  }

  create(rel, content = '') {
    const abs = this.resolve(rel, { md: true });
    if (fs.existsSync(abs)) throw new VaultError('A note with that name already exists', 409);
    return this.writeRaw(rel, content);
  }

  mkdir(rel) { fs.mkdirSync(this.resolve(rel), { recursive: true }); this.onWrite(null); }

  rename(from, to) {
    const a = this.resolve(from), b = this.resolve(to);
    if (fs.statSync(a).isFile() && !to.toLowerCase().endsWith('.md')) throw new VaultError('Notes must end in .md');
    if (fs.existsSync(b)) throw new VaultError('Target already exists', 409);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    this.onWrite(null);
  }

  /** Move to .trash/ inside the vault rather than deleting. */
  trash(rel) {
    const abs = this.resolve(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.root, '.trash', `${stamp}-${path.basename(abs)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    this.onWrite(null);
  }
}
