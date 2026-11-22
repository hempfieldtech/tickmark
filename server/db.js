// SQLite index over the vault (search, tasks, backlinks) + sync state.
// The .md files are the source of truth; this DB can be deleted and rebuilt at any time
// (except sync_state, which only costs a re-link on the next sync).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { parseTasks } from '../public/shared/tasks.js';
import { sha } from './vault.js';

const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export class Index {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, hash TEXT, title TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, body, tokenize = 'unicode61');
      CREATE TABLE IF NOT EXISTS tasks (
        path TEXT, line INTEGER, block_id TEXT, done INTEGER, title TEXT, due TEXT,
        priority INTEGER, synced INTEGER, section TEXT, raw TEXT);
      CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path);
      CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT);
      CREATE INDEX IF NOT EXISTS links_target ON links(target);
      CREATE TABLE IF NOT EXISTS sync_states (
        account TEXT, block_id TEXT, uid TEXT, href TEXT, etag TEXT, base TEXT, path TEXT, section TEXT,
        PRIMARY KEY (account, block_id));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      -- Synced tasks that sync deleted, kept for a while so they can be restored.
      CREATE TABLE IF NOT EXISTS deleted_tasks (
        id INTEGER PRIMARY KEY, account TEXT, block_id TEXT, title TEXT, model TEXT, line TEXT, path TEXT,
        ics TEXT, href TEXT, source TEXT, deleted_at TEXT, section TEXT);
    `);
    // Columns added after a table first shipped.
    for (const [table, col] of [['sync_states', 'section'], ['deleted_tasks', 'section']]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
    this.tagOpts = { itemTags: ['task'], sectionTags: ['sync'] };
  }

  setTagOptions(opts) {
    const changed = JSON.stringify(opts) !== JSON.stringify(this.tagOpts);
    this.tagOpts = opts;
    return changed;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Index one file's content. Returns true if the content hash changed. */
  indexFile(rel, content, { mtime = Date.now(), size = content.length, force = false } = {}) {
    const hash = sha(content);
    const prev = this.db.prepare('SELECT hash FROM files WHERE path = ?').get(rel);
    if (prev && prev.hash === hash && !force) {
      this.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?').run(mtime, size, rel);
      return false;
    }
    const title = path.basename(rel, '.md');
    const tasks = parseTasks(content, this.tagOpts);
    const lines = content.split('\n');
    this.tx(() => {
      this.db.prepare('INSERT OR REPLACE INTO files (path, mtime, size, hash, title) VALUES (?, ?, ?, ?, ?)').run(rel, mtime, size, hash, title);
      this.db.prepare('DELETE FROM fts WHERE path = ?').run(rel);
      this.db.prepare('INSERT INTO fts (path, title, body) VALUES (?, ?, ?)').run(rel, title, content);
      this.db.prepare('DELETE FROM tasks WHERE path = ?').run(rel);
      const ins = this.db.prepare('INSERT INTO tasks (path, line, block_id, done, title, due, priority, synced, section, raw) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const t of tasks) ins.run(rel, t.line, t.blockId, t.done ? 1 : 0, t.title, t.due, t.priority, t.synced ? 1 : 0, t.section, lines[t.line]);
      this.db.prepare('DELETE FROM links WHERE src = ?').run(rel);
      const li = this.db.prepare('INSERT INTO links (src, target) VALUES (?, ?)');
      const seen = new Set();
      for (const m of content.matchAll(WIKILINK)) {
        const t = m[1].trim().toLowerCase().replace(/\.md$/, '');
        if (!seen.has(t)) { seen.add(t); li.run(rel, t); }
      }
    });
    return true;
  }

  removeFile(rel) {
    this.tx(() => {
      for (const t of ['files', 'fts', 'tasks']) this.db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(rel);
      this.db.prepare('DELETE FROM links WHERE src = ?').run(rel);
    });
  }

  /** Reconcile the index with the vault on disk. Returns the list of changed/removed paths. */
  scan(vault, { force = false } = {}) {
    const { files } = vault.list();
    const known = new Map(this.db.prepare('SELECT path, mtime, size FROM files').all().map((r) => [r.path, r]));
    const changed = [];
    for (const f of files) {
      const k = known.get(f.path);
      known.delete(f.path);
      if (!force && k && k.mtime === f.mtime && k.size === f.size) continue;
      try {
        const { content } = vault.read(f.path);
        if (this.indexFile(f.path, content, { mtime: f.mtime, size: f.size, force })) changed.push(f.path);
      } catch {}
    }
    const removed = [...known.keys()];
    for (const p of removed) this.removeFile(p);
    return { changed, removed };
  }

  search(q, limit = 50) {
    const terms = q.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`);
    if (!terms.length) return [];
    try {
      return this.db.prepare(`SELECT path, snippet(fts, 2, '<mark>', '</mark>', '…', 12) AS snippet
        FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(terms.join(' '), limit);
    } catch { return []; }
  }

  pathsWithSyncedTasks() {
    return this.db.prepare('SELECT DISTINCT path FROM tasks WHERE synced = 1 UNION SELECT DISTINCT path FROM sync_states WHERE path IS NOT NULL').all().map((r) => r.path);
  }

  backlinks(rel) {
    const name = path.basename(rel, '.md').toLowerCase();
    const full = rel.toLowerCase().replace(/\.md$/, '');
    return this.db.prepare('SELECT DISTINCT src FROM links WHERE (target = ? OR target = ?) AND src != ? ORDER BY src').all(name, full, rel).map((r) => r.src);
  }

  allFiles() { return this.db.prepare('SELECT path, title FROM files ORDER BY path').all(); }

  // ---- sync state (per CalDAV account) ----
  getStates(account) {
    return this.db.prepare('SELECT * FROM sync_states WHERE account = ?').all(account).map((r) => ({ ...r, base: r.base ? JSON.parse(r.base) : null }));
  }
  putState(account, s) {
    this.db.prepare('INSERT OR REPLACE INTO sync_states (account, block_id, uid, href, etag, base, path, section) VALUES (?,?,?,?,?,?,?,?)')
      .run(account, s.block_id, s.uid, s.href, s.etag ?? null, JSON.stringify(s.base), s.path ?? null, s.section ?? null);
  }
  /** Older versions stored absolute hrefs (server + user name); keep only the part after the calendar URL. */
  relativizeHrefs(account, calUrl) {
    const r = this.db.prepare('UPDATE sync_states SET href = substr(href, ?) WHERE account = ? AND substr(href, 1, ?) = ?')
      .run(calUrl.length + 1, account, calUrl.length, calUrl);
    if (r.changes) this.scrub();
  }

  /** Rewrite the file so old values are gone from free pages and the write-ahead log, not just the tables. */
  scrub() {
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  deleteState(account, blockId) { this.db.prepare('DELETE FROM sync_states WHERE account = ? AND block_id = ?').run(account, blockId); }
  clearStates(account) { this.db.prepare('DELETE FROM sync_states WHERE account = ?').run(account); }

  /** Forget accounts that no longer exist in the config. */
  pruneAccounts(ids) {
    const known = new Set(ids);
    for (const { account } of this.db.prepare('SELECT DISTINCT account FROM sync_states').all()) {
      if (!known.has(account)) { this.clearStates(account); this.db.prepare('DELETE FROM meta WHERE key = ?').run('calendar:' + account); }
    }
  }

  /** Before multiple accounts, sync state had no account column. It all belonged to the first account. */
  migrateLegacyStates(accountId) {
    const old = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'").get();
    if (!old) return;
    this.tx(() => {
      if (accountId) {
        this.db.prepare(`INSERT OR IGNORE INTO sync_states (account, block_id, uid, href, etag, base, path)
          SELECT ?, block_id, uid, href, etag, base, path FROM sync_state`).run(accountId);
        const cal = this.getMeta('calendar');
        if (cal) this.setMeta('calendar:' + accountId, cal);
      }
      this.db.prepare("DELETE FROM meta WHERE key = 'calendar'").run();
      this.db.exec('DROP TABLE sync_state');
    });
  }

  // ---- recently deleted synced tasks ----
  addDeleted(e) {
    this.db.prepare(`INSERT INTO deleted_tasks (account, block_id, title, model, line, path, ics, href, source, deleted_at, section)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(e.account, e.block_id, e.model.title, JSON.stringify(e.model), e.line ?? null,
      e.path ?? null, e.ics ?? null, e.href ?? null, e.source, new Date().toISOString(), e.section ?? null);
  }
  listDeleted() {
    return this.db.prepare('SELECT id, account, block_id, title, model, line, path, section, href, source, deleted_at, ics IS NOT NULL AS hasCopy FROM deleted_tasks ORDER BY id DESC')
      .all().map((r) => ({ ...r, model: JSON.parse(r.model), hasCopy: !!r.hasCopy }));
  }
  getDeleted(id) {
    const r = this.db.prepare('SELECT * FROM deleted_tasks WHERE id = ?').get(id);
    return r ? { ...r, model: JSON.parse(r.model) } : null;
  }
  removeDeleted(id) { this.db.prepare('DELETE FROM deleted_tasks WHERE id = ?').run(id); }
  clearDeleted() { this.db.prepare('DELETE FROM deleted_tasks').run(); }
  pruneDeleted(days = 30) {
    this.db.prepare('DELETE FROM deleted_tasks WHERE deleted_at < ?').run(new Date(Date.now() - days * 86400000).toISOString());
  }

  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value); }
}
