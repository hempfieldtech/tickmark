// Demo mode (TICKMARK_DEMO=true): a public try-it-out instance.
//
// Every visitor gets a sandbox of their own (a cookie names it): a copy of the sample vault plus its
// own settings, wiped after a while without use. No one sees anyone else's notes, nothing reaches a
// CalDAV server, and the server's own settings (users, SSO, branding, public links) can't be changed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workspace } from './workspace.js';

const env = process.env;
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : d; };

export const DEMO = /^(1|true|yes|on)$/i.test(env.TICKMARK_DEMO || '');
const COOKIE = 'tm_demo';

/** Routes a demo visitor can't use: anything that talks to CalDAV or changes the server for everyone. */
const BLOCKED = [
  /^POST \/api\/caldav\//, /^POST \/api\/sync$/, /^(GET|POST|PUT|DELETE) \/api\/shares/, /^PUT \/api\/branding$/,
  /^\w+ \/api\/admin\//, /^\w+ \/api\/users/, /^\w+ \/api\/account\//, /^POST \/api\/setup\//,
  /^POST \/api\/auth\/(login|logout)$/,
];
export const demoBlocked = (key) => BLOCKED.some((r) => r.test(key));

export class DemoSessions {
  constructor({ dataRoot, seedDir }) {
    this.root = path.join(dataRoot, 'demo');
    this.seed = path.resolve(env.TICKMARK_DEMO_SEED || seedDir);
    this.idleMinutes = num(env.TICKMARK_DEMO_IDLE_MINUTES, 60, 5, 7 * 24 * 60);
    this.max = Math.round(num(env.TICKMARK_DEMO_MAX_SESSIONS, 50, 1, 10_000));
    this.maxBytes = num(env.TICKMARK_DEMO_MAX_MB, 5, 1, 1024) * 1024 * 1024;
    this.open = new Map(); // id → { ws, seen }
    // Sandboxes left over from a previous run are stale: their cookies point nowhere useful now.
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(this.seed)) console.warn(`  ⚠ demo: no sample vault at ${this.seed}; sandboxes start empty`);
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** The visitor's sandbox, made on first use. Sets the cookie on `res` when it's new. */
  get(req, res) {
    const id = /(?:^|;\s*)tm_demo=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1];
    let s = id && this.open.get(id);
    if (!s) s = this.create(res);
    s.seen = Date.now();
    return s.ws;
  }

  create(res) {
    while (this.open.size >= this.max) this.drop(this.oldest()); // full: the longest-idle sandbox goes
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(this.root, id);
    const vaultDir = path.join(dir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    if (fs.existsSync(this.seed)) fs.cpSync(this.seed, vaultDir, { recursive: true });
    const ws = new Workspace({ name: `demo-${id.slice(0, 8)}`, dataDir: path.join(dir, 'data'), vaultDir });
    const s = { id, ws, dir, seen: Date.now() };
    this.open.set(id, s);
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.idleMinutes * 60}`);
    return s;
  }

  oldest() { let o = null; for (const s of this.open.values()) if (!o || s.seen < o.seen) o = s; return o; }

  drop(s) {
    if (!s) return;
    this.open.delete(s.id);
    try { s.ws.close(); } catch {}
    fs.rmSync(s.dir, { recursive: true, force: true });
  }

  sweep() {
    const cutoff = Date.now() - this.idleMinutes * 60_000;
    for (const s of [...this.open.values()]) if (s.seen < cutoff && !s.ws.clients.size) this.drop(s);
  }

  /** Refuse a write that would grow the sandbox's vault past the limit. */
  checkSize(ws) {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
        if (total > this.maxBytes) return;
      }
    };
    try { walk(ws.vault.root); } catch {}
    if (total > this.maxBytes) throw Object.assign(new Error(`This demo is limited to ${Math.round(this.maxBytes / 1048576)} MB of notes`), { status: 413 });
  }

  info() { return { idleMinutes: this.idleMinutes }; }
}
