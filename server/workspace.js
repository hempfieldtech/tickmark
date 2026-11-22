// One person's Tickmark: their vault, search index, settings, sync engine and live-update streams.
// Single-user mode has exactly one; multi-user mode opens one per user on first use.

import fs from 'node:fs';
import path from 'node:path';
import { Vault } from './vault.js';
import { Index } from './db.js';
import { Config } from './config.js';
import { SyncEngine } from './sync.js';
import { movedNotes, rewriteLinks } from './links.js';
import { History } from './history.js';

/** How long after a file changes outside Tickmark to sync it (editors often write in several steps). */
const EXTERNAL_SYNC_DELAY = Number(process.env.TICKMARK_EXTERNAL_SYNC_MS) || 3000;

export class Workspace {
  constructor({ name = null, dataDir, vaultDir, cipher }) {
    this.name = name;
    this.dataDir = dataDir;
    this.vaultDir = vaultDir;
    this.clients = new Set();
    this.config = new Config(dataDir, { cipher, owner: name || '' });
    this.index = new Index(path.join(dataDir, 'index.sqlite'));
    this.index.migrateLegacyStates(this.config.get().accounts[0]?.id);
    this.index.setTagOptions(this.config.allTags());

    this.history = new History({ dataDir, vaultDir, log: (...a) => console.warn(name ? `[${name}]` : '', ...a) });
    this.vault = new Vault(vaultDir, {
      onWrite: (rel, content) => {
        this.history.changed();
        if (rel && content != null) {
          if (this.index.indexFile(rel, content)) this.broadcast('file', { path: rel, hash: this.hashOf(rel) });
        } else this.scheduleScan();
        this.broadcast('tree', {});
      },
    });

    this.scanTimer = null;
    this.index.scan(this.vault);
    try {
      this.watcher = fs.watch(vaultDir, { recursive: true }, (_e, file) => {
        if (file && (/(^|\/)\./.test(file) || file.endsWith('.tmp'))) return;
        this.scheduleScan();
      });
    } catch (e) {
      console.warn(`File watching unavailable for ${vaultDir}, external edits need a reload:`, e.message);
    }

    this.sync = new SyncEngine({
      vault: this.vault, index: this.index,
      getConfig: () => this.config.get(),
      onStatus: (s) => this.broadcast('sync', s),
      log: (...a) => console.log(name ? `[${name}]` : '', ...a),
    });
    this.serverTimer = null;
    this.scheduleServerSync();
    this.history.changed(); // record the vault as it is at start (edits made while Tickmark was off)
  }

  hashOf(rel) { return this.index.db.prepare('SELECT hash FROM files WHERE path=?').get(rel)?.hash; }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  scheduleScan() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      const { changed, removed } = this.index.scan(this.vault);
      for (const p of changed) this.broadcast('file', { path: p, hash: this.hashOf(p) });
      if (changed.length || removed.length) {
        this.broadcast('tree', {});
        this.history.changed();
        // In-app saves are indexed as they're written, so anything the scan finds was changed outside
        // Tickmark (another editor, a file sync tool): sync it too, rather than waiting for the next save.
        this.scheduleExternalSync();
      }
    }, 250);
  }

  scheduleExternalSync(ms = EXTERNAL_SYNC_DELAY) {
    if (!this.config.get().accounts.some((a) => a.url && a.calendarUrl)) return;
    clearTimeout(this.externalSyncTimer);
    this.history.close();
    this.externalSyncTimer = setTimeout(() => {
      // A sync already under way may have read the files before this change: go again once it's done.
      if (this.sync.running) return this.sync.running.catch(() => {}).finally(() => this.scheduleExternalSync(500));
      this.sync.run().catch(() => {});
    }, ms);
  }

  scheduleServerSync() {
    clearInterval(this.serverTimer);
    const mins = this.config.get().serverSyncMinutes;
    const ready = this.config.get().accounts.some((a) => a.url && a.calendarUrl);
    if (mins > 0 && ready) this.serverTimer = setInterval(() => this.sync.run().catch(() => {}), mins * 60000);
  }

  /**
   * Rename or move a note or folder, and update [[links]] to the notes that moved.
   * Returns the notes whose links were rewritten (at their new paths).
   */
  rename(from, to) {
    const before = this.vault.list().files.map((f) => f.path);
    const moved = movedNotes(from, to, before);
    // Notes that link anywhere, per the index (brought up to date first, in case of external edits).
    this.index.scan(this.vault);
    const linking = this.index.db.prepare('SELECT DISTINCT src FROM links').all().map((r) => r.src);
    this.vault.rename(from, to);
    if (!moved.size) return [];
    const after = before.map((p) => moved.get(p) || p);
    const updated = [];
    for (const src of linking) {
      const p = moved.get(src) || src;
      try {
        if (this.vault.modify(p, (text) => rewriteLinks(text, moved, before, after))) updated.push(p);
      } catch (e) { console.warn(`Couldn't update links in ${p}:`, e.message); }
    }
    return updated;
  }

  /** Apply a settings change; re-index if the set of synced tags changed. */
  updateConfig(body) {
    this.config.update(body);
    if (this.index.setTagOptions(this.config.allTags())) {
      this.index.scan(this.vault, { force: true });
      this.broadcast('tree', {});
    }
    this.scheduleServerSync();
    return this.config.public();
  }

  close() {
    clearTimeout(this.scanTimer);
    clearTimeout(this.externalSyncTimer);
    clearInterval(this.serverTimer);
    this.watcher?.close();
    for (const res of this.clients) res.end();
    this.clients.clear();
    try { this.index.db.close(); } catch {}
  }
}
