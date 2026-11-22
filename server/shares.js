// Public share links: a note or a folder, readable by anyone with its link, at <public URL>/s/<token>.
// Only offered when the instance has a domain-based public URL (TICKMARK_PUBLIC_URL), so links are
// stable and never point at a LAN address. Stored server-wide in <data>/shares.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

/**
 * Why sharing is unavailable for this public URL, or null if it's fine: it has to be a domain name
 * (notes.example.com, box.tailnet.ts.net), not an IP address or localhost.
 */
export function shareBlocker(publicUrl) {
  if (!publicUrl) return 'Public links need a public URL for this Tickmark with a domain name (TICKMARK_PUBLIC_URL, e.g. https://notes.example.com).';
  let host;
  try { host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, ''); } catch { return `The public URL (${publicUrl}) isn't a valid address.`; }
  if (net.isIP(host) || host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|lan|home\.arpa)$/i.test(host)) {
    return `Public links need a public URL with a domain name; ${host} is a local address.`;
  }
  return null;
}

export class Shares {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'shares.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(token) {
    return typeof token === 'string' && Object.hasOwn(this.data, token) ? { token, ...this.data[token] } : null;
  }

  /** Everything `owner` shares (owner is null in single-user mode). */
  list(owner) {
    return Object.entries(this.data).filter(([, s]) => s.owner === owner).map(([token, s]) => ({ token, ...s }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Share a note or folder; sharing the same thing again returns the existing link. */
  create(owner, rel, kind) {
    const existing = this.list(owner).find((s) => s.path === rel && s.kind === kind);
    if (existing) return existing;
    const token = crypto.randomBytes(16).toString('base64url');
    this.data[token] = { owner, path: rel, kind, created: new Date().toISOString() };
    this.save();
    return { token, ...this.data[token] };
  }

  remove(owner, token) {
    const s = this.get(token);
    if (!s || s.owner !== owner) return false;
    delete this.data[token];
    this.save();
    return true;
  }

  /** A note or folder was renamed or moved: its links (and links to anything inside it) follow it. */
  moved(owner, from, to) {
    let changed = false;
    for (const s of Object.values(this.data)) {
      if (s.owner !== owner) continue;
      if (s.path === from) { s.path = to; changed = true; }
      else if (s.path.startsWith(from + '/')) { s.path = to + s.path.slice(from.length); changed = true; }
    }
    if (changed) this.save();
  }

  /** A note or folder went to the trash: stop sharing it (and anything inside it). */
  removed(owner, rel) {
    let changed = false;
    for (const [token, s] of Object.entries(this.data)) {
      if (s.owner === owner && (s.path === rel || s.path.startsWith(rel + '/'))) { delete this.data[token]; changed = true; }
    }
    if (changed) this.save();
  }

  /** Single-user links become the first user's when sign-in is turned on (they take over the notes). */
  adopt(owner) {
    let changed = false;
    for (const s of Object.values(this.data)) if (s.owner === null) { s.owner = owner; changed = true; }
    if (changed) this.save();
  }

  /** A user was removed: their links stop working. */
  removeOwner(owner) {
    const before = Object.keys(this.data).length;
    for (const [token, s] of Object.entries(this.data)) if (s.owner === owner) delete this.data[token];
    if (Object.keys(this.data).length !== before) this.save();
  }
}
