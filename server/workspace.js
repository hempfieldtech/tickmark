// One person's Tickmark: their vault, search index, settings, sync engine and live-update streams.
// Single-user mode has exactly one; multi-user mode opens one per user on first use.

import fs from 'node:fs';
import path from 'node:path';
import { Vault } from './vault.js';
import { Index } from './db.js';
import { Config } from './config.js';
import { SyncEngine } from './sync.js';

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

    this.vault = new Vault(vaultDir, {
      onWrite: (rel, content) => {
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
      if (changed.length || removed.length) this.broadcast('tree', {});
    }, 250);
  }

  scheduleServerSync() {
    clearInterval(this.serverTimer);
    const mins = this.config.get().serverSyncMinutes;
    const ready = this.config.get().accounts.some((a) => a.url && a.calendarUrl);
    if (mins > 0 && ready) this.serverTimer = setInterval(() => this.sync.run().catch(() => {}), mins * 60000);
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
    clearInterval(this.serverTimer);
    this.watcher?.close();
    for (const res of this.clients) res.end();
    this.clients.clear();
    try { this.index.db.close(); } catch {}
  }
}
