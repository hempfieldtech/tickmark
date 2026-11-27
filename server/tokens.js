// Personal API tokens (Settings → API): scripts send `Authorization: Bearer tm_…` to /api/v1/*.
// Stored in <data>/api-tokens.json as SHA-256 hashes; the token itself is shown once, when it's made.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_PER_OWNER = 20;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export class TokenError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export class Tokens {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'api-tokens.json');
    try { this.list_ = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list_ = []; }
    if (!Array.isArray(this.list_)) this.list_ = [];
    this.dirty = false;
    // Last-used times are written at most once a minute, not on every request.
    this.timer = setInterval(() => this.flush(), 60_000);
    this.timer.unref?.();
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.list_, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  flush() { if (this.dirty) try { this.save(); } catch {} }

  /** The tokens `owner` (a user name, or null in single-user mode) has made, without their secrets. */
  list(owner) { return this.list_.filter((t) => t.owner === owner).map(({ hash, owner: _, ...t }) => t); }

  /** Make a token. Returns { token, ...info }; the token is never available again. */
  create(owner, { name, scope = 'write', days = null }) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new TokenError('Give the token a name, so you know what it is for later');
    if (!['read', 'write'].includes(scope)) throw new TokenError('Scope is read or write');
    if (this.list_.filter((t) => t.owner === owner).length >= MAX_PER_OWNER) throw new TokenError(`You can have up to ${MAX_PER_OWNER} tokens; delete one first`);
    const d = days == null || days === '' ? null : Number(days);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 3650)) throw new TokenError('Expiry is 1 to 3650 days, or never');
    const token = 'tm_' + crypto.randomBytes(24).toString('base64url');
    const t = {
      id: crypto.randomBytes(6).toString('hex'), owner, name, scope, hash: sha(token), hint: token.slice(0, 7) + '…' + token.slice(-4),
      created: new Date().toISOString(), expires: d ? new Date(Date.now() + d * 86400000).toISOString() : null, lastUsed: null,
    };
    this.list_.push(t);
    this.save();
    const { hash, owner: _, ...info } = t;
    return { token, ...info };
  }

  remove(owner, id) {
    const before = this.list_.length;
    this.list_ = this.list_.filter((t) => !(t.owner === owner && t.id === id));
    if (this.list_.length === before) throw new TokenError('No such token', 404);
    this.save();
  }
  removeOwner(owner) {
    const before = this.list_.length;
    this.list_ = this.list_.filter((t) => t.owner !== owner);
    if (this.list_.length !== before) this.save();
  }

  /** The token record for `Authorization: Bearer …`, or null. */
  check(header) {
    const m = String(header || '').match(/^Bearer\s+(tm_[A-Za-z0-9_-]{20,})\s*$/i);
    if (!m) return null;
    const h = sha(m[1]);
    const t = this.list_.find((x) => x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!t || (t.expires && Date.parse(t.expires) < Date.now())) return null;
    t.lastUsed = new Date().toISOString();
    this.dirty = true;
    return t;
  }
}
