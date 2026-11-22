// Encryption of sensitive settings at rest, keyed by the OIDC client secret.
//
// When SSO is configured with a client secret, each user's CalDAV accounts (server URLs, user names,
// passwords, task lists, tags) are stored encrypted in their config.json. Without SSO, nothing changes:
// settings stay plain JSON (mode 600), as before.
//
// This protects the data folder on its own: a backup, a copied folder, another container mounting it.
// It does not protect against someone who can also read the environment (.env) on the same machine.
//
// Rotating the client secret: put the old one in TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET for one start.
// Settings are read with it and re-encrypted with the new secret as each user signs in.
//
// Format (JSON, in place of the plain value): { "enc": "v1", "salt", "iv", "tag", "data" } — AES-256-GCM,
// key = scrypt(secret, salt), with additional data binding the blob to its user, so blobs can't be swapped.

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class SecretsError extends Error {
  constructor(msg) { super(msg); this.status = 500; }
}

export const isSealed = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && v.enc === 'v1');

export class SettingsCipher {
  /**
   * @param current  secret used to encrypt (null = store settings in plain JSON)
   * @param readable more secrets that may decrypt existing settings (e.g. the previous client secret)
   */
  constructor({ current = null, readable = [] } = {}) {
    this.current = current || null;
    this.readable = [...new Set([current, ...readable].filter(Boolean))];
    this.keys = new Map(); // secret+salt → key (scrypt is deliberately slow)
  }

  get enabled() { return !!this.current; }

  key(secret, salt) {
    const id = crypto.createHash('sha256').update(secret).update(salt).digest('base64');
    let k = this.keys.get(id);
    if (!k) { k = crypto.scryptSync(secret, salt, 32, SCRYPT); this.keys.set(id, k); }
    return k;
  }

  seal(value, aad) {
    if (!this.current) throw new SecretsError('No encryption secret configured');
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(this.current, salt), iv);
    c.setAAD(Buffer.from(String(aad)));
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    const b = (x) => x.toString('base64');
    return { enc: 'v1', salt: b(salt), iv: b(iv), tag: b(c.getAuthTag()), data: b(data) };
  }

  /** Decrypt. Returns { value, stale } — stale when it was encrypted with a secret other than the current one. */
  open(blob, aad) {
    if (!isSealed(blob)) throw new SecretsError('Not an encrypted value');
    if (!this.readable.length) {
      throw new SecretsError('These settings are encrypted with the OIDC client secret, but TICKMARK_OIDC_CLIENT_SECRET is not set. ' +
        'Set it again to read them.');
    }
    const [salt, iv, tag, data] = ['salt', 'iv', 'tag', 'data'].map((k) => Buffer.from(blob[k] || '', 'base64'));
    for (const secret of this.readable) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.key(secret, salt), iv);
        d.setAAD(Buffer.from(String(aad)));
        d.setAuthTag(tag);
        const value = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
        return { value, stale: secret !== this.current };
      } catch {}
    }
    throw new SecretsError("These settings are encrypted with a different OIDC client secret. If you changed it at your provider, " +
      'put the old one in TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET for one start and they will be re-encrypted with the new one.');
  }
}

/**
 * Settings are encrypted when SSO is configured with a client secret. The client secret (even with SSO
 * turned off) and the previous one stay usable for reading, so turning SSO off or rotating the secret
 * can decrypt and rewrite what's there.
 */
export function settingsCipher(env = process.env, { oidcEnabled }) {
  const secret = env.TICKMARK_OIDC_CLIENT_SECRET || '';
  const previous = env.TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET || '';
  return new SettingsCipher({ current: oidcEnabled && secret ? secret : null, readable: [secret, previous] });
}

/** A stable, non-reversible stand-in for a URL that only needs comparing (e.g. "which calendar was this"). */
export const fingerprint = (s) => 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
