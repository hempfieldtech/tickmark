// Server-wide settings edited in Settings → Single sign-on, stored in <data>/tickmark.sqlite.
//
// Keys are the environment variable names they stand in for, and the environment always wins: a value
// set in .env shows as locked in the UI. The OIDC client secret is stored encrypted (AES-256-GCM) under
// a master key, TICKMARK_SECRET_KEY, which lives in the environment and never in the data folder. The
// client secret in turn keys the encryption of each user's CalDAV settings (secrets.js), so a copy of
// the data folder alone reveals neither.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { SettingsCipher, SecretsError } from './secrets.js';

/** Everything the SSO pane can set. `secret` values are encrypted and never sent back to the browser. */
export const SSO_FIELDS = [
  { key: 'TICKMARK_OIDC_ISSUER', kind: 'url' },
  { key: 'TICKMARK_OIDC_CLIENT_ID' },
  { key: 'TICKMARK_OIDC_CLIENT_SECRET', secret: true },
  { key: 'TICKMARK_PUBLIC_URL', kind: 'url' },
  { key: 'TICKMARK_OIDC_LABEL' },
  { key: 'TICKMARK_OIDC_SCOPES' },
  { key: 'TICKMARK_OIDC_USERNAME_CLAIM' },
  { key: 'TICKMARK_OIDC_GROUPS_CLAIM' },
  { key: 'TICKMARK_OIDC_ALLOWED_GROUPS' },
  { key: 'TICKMARK_OIDC_ADMIN_GROUPS' },
  { key: 'TICKMARK_OIDC_AUTO_CREATE', kind: 'bool' },
  { key: 'TICKMARK_OIDC_MATCH_USERNAME', kind: 'bool' },
  { key: 'TICKMARK_LOCAL_LOGIN', kind: 'bool' },
];
const PREVIOUS = 'TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET';
const KNOWN = new Map(SSO_FIELDS.map((f) => [f.key, f]));
const AAD = (key) => `tickmark:server-setting:${key}`;

export class ServerSettings {
  constructor(dataDir, env = process.env) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'tickmark.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);
    `);
    this.env = env;
    this.master = new SettingsCipher({ current: env.TICKMARK_SECRET_KEY || null });
    this.problem = null;
  }

  get hasMasterKey() { return this.master.enabled; }

  raw(key) { return this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key)?.value ?? null; }
  put(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO server_settings (key, value, updated) VALUES (?, ?, ?)').run(key, value, new Date().toISOString());
  }
  del(key) { this.db.prepare('DELETE FROM server_settings WHERE key = ?').run(key); }

  readSecret(key) {
    const v = this.raw(key);
    if (v == null) return null;
    if (!this.master.enabled) throw new SecretsError(`The SSO client secret saved in Settings is encrypted, but TICKMARK_SECRET_KEY is not set. Set it in .env again.`);
    try { return this.master.open(JSON.parse(v), AAD(key)).value; } catch {
      throw new SecretsError('The SSO client secret saved in Settings can’t be decrypted: TICKMARK_SECRET_KEY has changed. Restore it, or enter the client secret again.');
    }
  }

  /** Keys set in the real environment (they override, and the UI shows them as locked). */
  locked() { return SSO_FIELDS.map((f) => f.key).filter((k) => (this.env[k] ?? '') !== ''); }

  /** The environment as the rest of Tickmark sees it: real env first, then values saved here. */
  effectiveEnv() {
    const out = { ...this.env };
    this.problem = null;
    for (const key of [...KNOWN.keys(), PREVIOUS]) {
      if ((this.env[key] ?? '') !== '') continue;
      try {
        const v = key === PREVIOUS || KNOWN.get(key)?.secret ? this.readSecret(key) : this.raw(key);
        if (v != null) out[key] = v;
      } catch (e) { this.problem = e.message; }
    }
    return out;
  }

  /** Non-secret values for the UI, plus whether a secret is set and where each value comes from. */
  describe() {
    const values = {};
    for (const f of SSO_FIELDS) {
      if (f.secret) continue;
      values[f.key] = (this.env[f.key] ?? '') !== '' ? this.env[f.key] : (this.raw(f.key) ?? '');
    }
    return {
      values,
      secretSet: (this.env.TICKMARK_OIDC_CLIENT_SECRET ?? '') !== '' || this.raw('TICKMARK_OIDC_CLIENT_SECRET') != null,
      locked: this.locked(),
      masterKey: this.hasMasterKey,
    };
  }

  /**
   * Save from the UI. Empty strings clear a value. A new client secret is encrypted with the master key,
   * and the one it replaces is kept as the previous secret so encrypted CalDAV settings can be re-keyed.
   */
  save(patch) {
    const locked = new Set(this.locked());
    const writes = [];
    for (const [key, value] of Object.entries(patch)) {
      const f = KNOWN.get(key);
      if (!f) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
      if (locked.has(key)) continue; // set in .env, which wins anyway
      if (f.secret) {
        if (value === undefined || value === null) continue;
        if (value === '') {
          // Keep the cleared secret as the previous one: CalDAV settings encrypted with it stay readable
          // (and are rewritten, decrypted, the next time each user's workspace opens).
          const cur = this.raw(key);
          writes.push(() => { if (cur != null) this.put(PREVIOUS, JSON.stringify(this.master.seal(this.readSecret(key), AAD(PREVIOUS)))); this.del(key); });
          continue;
        }
        if (!this.master.enabled) {
          throw Object.assign(new Error('To store the client secret here, set TICKMARK_SECRET_KEY in .env first (for example the output of: openssl rand -base64 32), then restart Tickmark.'), { status: 400 });
        }
        let old = null;
        try { old = this.readSecret(key); } catch {}
        writes.push(() => {
          if (old && old !== value) this.put(PREVIOUS, JSON.stringify(this.master.seal(old, AAD(PREVIOUS))));
          this.put(key, JSON.stringify(this.master.seal(String(value), AAD(key))));
        });
        continue;
      }
      let v = value == null ? '' : String(value).trim();
      if (f.kind === 'bool' && v !== '') v = /^(1|true|yes|on)$/i.test(v) ? 'true' : 'false';
      if (f.kind === 'url' && v) {
        let u;
        try { u = new URL(v); } catch { throw Object.assign(new Error(`${key === 'TICKMARK_PUBLIC_URL' ? 'Public URL' : 'Issuer URL'} isn't a valid URL`), { status: 400 }); }
        if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('URLs must start with https:// (or http:// for testing)'), { status: 400 });
        v = v.replace(/\/+$/, '');
      }
      writes.push(() => (v === '' ? this.del(key) : this.put(key, v)));
    }
    this.db.exec('BEGIN');
    try { for (const w of writes) w(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /**
   * Turn SSO off (the CLI's escape hatch). Only the issuer is removed: the client secret stays, so
   * CalDAV settings encrypted with it can still be read, and are stored decrypted from then on.
   */
  disableSso() { this.del('TICKMARK_OIDC_ISSUER'); }
}
