#!/usr/bin/env node
// Tickmark users and login sessions.
//
// With no users.json, Tickmark is single-user (optionally behind TICKMARK_USER/PASS Basic auth).
// Once a user exists, or OIDC is configured, every person signs in and gets their own vault
// and settings. Users are added from Settings (admins), by signing in with SSO, or here:
//
//   node server/users.js add <name> [--admin] [--vault /path/to/notes]
//   node server/users.js passwd <name>
//   node server/users.js remove <name>
//   node server/users.js list
//   node server/users.js sso-off      turn off SSO set up in Settings (if it ever locks you out)
//
// The password is read from the terminal, or from TICKMARK_NEW_PASSWORD for scripts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// ---- passwords (scrypt, stored as scrypt$N$r$p$salt$hash)
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, want);
}
// Same work as a real check, so a missing user can't be told apart by timing.
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));

export const normName = (s) => String(s || '').trim().toLowerCase();

function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class UserStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.mtime = -1;
    this.users = [];
    this.reload();
  }

  /** Re-read users.json if it changed on disk (e.g. the CLI added someone). */
  reload() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.users = []; this.mtime = -1; return; }
    if (st.mtimeMs === this.mtime) return;
    this.mtime = st.mtimeMs;
    try { this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || []; } catch (e) {
      throw new Error(`Can't read ${this.file}: ${e.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJSON(this.file, { users: this.users });
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  exists() { return fs.existsSync(this.file) && this.list().length > 0; }
  list() { this.reload(); return this.users; }
  get(name) { return this.list().find((u) => u.name === normName(name)) || null; }
  byOidc(iss, sub) { return this.list().find((u) => u.oidc?.iss === iss && u.oidc?.sub === sub) || null; }
  admins() { return this.list().filter((u) => u.admin); }

  add({ name, password = null, admin = false, vault = null, oidc = null }) {
    name = normName(name);
    if (!NAME_RE.test(name)) throw new AuthError('User names are 1-32 characters: a-z, 0-9, dot, dash, underscore, starting with a letter or digit');
    if (this.get(name)) throw new AuthError(`User “${name}” already exists`, 409);
    if (password != null && String(password).length < 8) throw new AuthError('Passwords need at least 8 characters');
    const u = { name, admin: !!admin, created: new Date().toISOString() };
    if (password != null) u.hash = hashPassword(password);
    if (vault) u.vault = vault;
    if (oidc) u.oidc = oidc;
    this.users.push(u);
    this.save();
    return u;
  }

  update(name, patch) {
    const u = this.get(name);
    if (!u) throw new AuthError('No such user', 404);
    if (patch.password !== undefined) {
      if (patch.password === null) delete u.hash;
      else {
        if (String(patch.password).length < 8) throw new AuthError('Passwords need at least 8 characters');
        u.hash = hashPassword(patch.password);
      }
      u.sessionsAfter = Date.now(); // signs out every existing session, including in a running server
    }
    if (patch.admin !== undefined) {
      if (!patch.admin && u.admin && this.admins().length === 1) throw new AuthError('Tickmark needs at least one admin');
      u.admin = !!patch.admin;
    }
    if (patch.oidc !== undefined) u.oidc = patch.oidc;
    this.save();
    return u;
  }

  remove(name) {
    const u = this.get(name);
    if (!u) throw new AuthError('No such user', 404);
    if (u.admin && this.admins().length === 1) throw new AuthError('Tickmark needs at least one admin');
    this.users = this.users.filter((x) => x !== u);
    this.save();
  }

  /** Returns the user, or null. Always does the same amount of work. */
  verify(name, password) {
    const u = this.get(name);
    const ok = checkPassword(password, u?.hash || DUMMY);
    return ok && u?.hash ? u : null;
  }

  /** Where a user's notes and settings live. */
  paths(u, { dataRoot, vaultRoot }) {
    return {
      data: path.join(dataRoot, 'users', u.name),
      vault: u.vault ? path.resolve(vaultRoot, u.vault) : path.join(vaultRoot, u.name),
    };
  }
}

/** Login sessions: random tokens in a cookie; only their SHA-256 is stored. */
export class Sessions {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'sessions.json');
    this.map = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(k, v); } catch {}
    this.dirty = false;
    setInterval(() => this.flush(), 60_000).unref();
  }

  static key(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

  create(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.map.set(Sessions.key(token), { user, created: Date.now(), seen: Date.now() });
    this.flush(true);
    return token;
  }

  get(token) {
    if (!token) return null;
    const k = Sessions.key(token);
    const s = this.map.get(k);
    if (!s) return null;
    if (Date.now() - s.seen > SESSION_DAYS * 86400_000) { this.map.delete(k); this.dirty = true; return null; }
    if (Date.now() - s.seen > 3600_000) { s.seen = Date.now(); this.dirty = true; }
    return s;
  }

  destroy(token) { if (this.map.delete(Sessions.key(token))) this.flush(true); }
  destroyUser(user) {
    for (const [k, s] of this.map) if (s.user === user) this.map.delete(k);
    this.flush(true);
  }

  flush(force = false) {
    if (!force && !this.dirty) return;
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.seen > SESSION_DAYS * 86400_000) this.map.delete(k);
    try { writeJSON(this.file, Object.fromEntries(this.map)); this.dirty = false; } catch (e) { console.error('Could not save sessions:', e.message); }
  }
}

/** Slows down password guessing: 10 failures per IP in 15 minutes locks that IP out for the rest of the window. */
export class LoginLimiter {
  constructor() { this.map = new Map(); }
  check(ip) {
    const e = this.map.get(ip);
    if (e && Date.now() - e.start < 15 * 60_000 && e.n >= 10) throw new AuthError('Too many failed sign-ins. Try again in a few minutes.', 429);
  }
  fail(ip) {
    const e = this.map.get(ip);
    if (!e || Date.now() - e.start > 15 * 60_000) this.map.set(ip, { start: Date.now(), n: 1 });
    else e.n++;
  }
  ok(ip) { this.map.delete(ip); }
}

// ---------------------------------------------------------------- CLI
async function readPassword(prompt) {
  if (process.env.TICKMARK_NEW_PASSWORD) return process.env.TICKMARK_NEW_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No terminal: set TICKMARK_NEW_PASSWORD (in Docker, use docker exec -it)');
  const ask = (q) => new Promise((resolve, reject) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); return reject(new Error('Cancelled')); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', on);
  });
  const a = await ask(prompt);
  const b = await ask('Again: ');
  if (a !== b) throw new Error("Passwords don't match");
  return a;
}

async function cli(argv) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const DATA = path.resolve(process.env.TICKMARK_DATA || path.join(ROOT, 'data'));
  const store = new UserStore(DATA);
  const [cmd, name, ...rest] = argv;
  const flag = (f) => rest.includes(f);
  const opt = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
  const wasEmpty = !store.exists();
  switch (cmd) {
    case 'add': {
      if (!name) throw new Error('Usage: users.js add <name> [--admin] [--vault /path]');
      const pw = await readPassword(`Password for ${normName(name)}: `);
      // The first user is always an admin and inherits the existing single-user notes and settings.
      const u = store.add({ name, password: pw, admin: flag('--admin') || wasEmpty, vault: opt('--vault') });
      console.log(`Added ${u.name}${u.admin ? ' (admin)' : ''}.`);
      if (wasEmpty) {
        console.log('Tickmark is now multi-user. Restart it to switch over (docker compose restart).');
        console.log(`Your existing notes and settings will move to ${u.name} on the next start.`);
      }
      break;
    }
    case 'passwd': {
      if (!store.get(name)) throw new Error(`No user “${name}”`);
      store.update(name, { password: await readPassword(`New password for ${normName(name)}: `) });
      console.log('Password changed; existing sessions were signed out.');
      break;
    }
    case 'remove':
      store.remove(name);
      console.log(`Removed ${normName(name)}. Their notes and settings were left on disk.`);
      break;
    case 'sso-off': {
      const { ServerSettings } = await import('./server-settings.js');
      new ServerSettings(DATA).disableSso();
      console.log('SSO set up in Settings is off (settings in .env, if any, still apply). Restart Tickmark; password sign-in works as before.');
      break;
    }
    case 'list':
      for (const u of store.list()) console.log(`${u.name}${u.admin ? '  admin' : ''}${u.oidc ? '  sso' : ''}${u.hash ? '' : '  (no password)'}`);
      if (!store.list().length) console.log('No users: Tickmark is in single-user mode.');
      break;
    default:
      console.log('Usage: users.js add <name> [--admin] [--vault /path] | passwd <name> | remove <name> | list | sso-off');
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
