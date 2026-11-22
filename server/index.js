#!/usr/bin/env node
// Tickmark server: serves the PWA, exposes each user's vault over a small JSON API, keeps the
// SQLite index fresh via a file watcher, and runs CalDAV sync.
//
// Modes:
//   single-user  no users.json and no OIDC: one vault at TICKMARK_VAULT (optionally behind
//                TICKMARK_USER/TICKMARK_PASS Basic auth). This is how Tickmark always worked.
//   multi-user   users.json has users, or OIDC is configured: people sign in (password and/or SSO)
//                and each gets <TICKMARK_VAULT>/<name> and <TICKMARK_DATA>/users/<name>.
//
// Single-user becomes multi-user without a restart when the first admin is created in Settings → Users.
// SSO settings come from the environment, or from Settings → Single sign-on (server-settings.js), and
// are re-applied without a restart when an admin saves them.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VaultError } from './vault.js';
import { CalDAV, CalDAVError } from './caldav.js';
import { Workspace } from './workspace.js';
import { UserStore, Sessions, LoginLimiter, AuthError, normName } from './users.js';
import { OIDC, OIDCError } from './oidc.js';
import { settingsCipher } from './secrets.js';
import { ServerSettings, SSO_FIELDS } from './server-settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.TICKMARK_DATA || path.join(ROOT, 'data'));
const VAULT = path.resolve(process.env.TICKMARK_VAULT || path.join(ROOT, 'vault'));
const PORT = Number(process.env.PORT || 8087);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_USER = process.env.TICKMARK_USER;
const AUTH_PASS = process.env.TICKMARK_PASS;
const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'tm_session';

// Fail early with a fix, instead of EACCES on the first save. The usual cause: Docker created a
// missing bind-mount folder as root while the container runs as an unprivileged user.
function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    const uid = process.getuid?.();
    const err = new Error(`Tickmark can't write to ${dir} (${e.code}). It runs as uid ${uid}; ` +
      `give that user the folder, e.g. on the host: sudo chown -R ${uid}:${process.getgid?.()} <folder mounted at ${dir}>`);
    err.status = 500;
    throw err;
  }
}
try { ensureWritable(DATA); ensureWritable(VAULT); } catch (e) { console.error(e.message); process.exit(1); }

const users = new UserStore(DATA);
const serverSettings = new ServerSettings(DATA);
const limiter = new LoginLimiter();
const workspaces = new Map();
let single = null;

// Sign-in state. Rebuilt by applyAuth() when SSO settings change or the first admin is created.
let oidc, cipher, LOCAL_LOGIN, MULTI = false, sessions = null;
function applyAuth() {
  const env = serverSettings.effectiveEnv();
  if (serverSettings.problem) console.error('  ⚠ ' + serverSettings.problem);
  const wasMulti = MULTI;
  oidc = new OIDC(env);
  cipher = settingsCipher(env, { oidcEnabled: oidc.enabled });
  LOCAL_LOGIN = !/^(0|false|no|off)$/i.test(env.TICKMARK_LOCAL_LOGIN || 'true');
  MULTI = oidc.enabled || users.exists();
  if (MULTI && !sessions) sessions = new Sessions(DATA);
  // Open workspaces hold the old encryption key; they reopen with the new one on their next request.
  for (const name of [...workspaces.keys()]) closeWorkspace(name);
  if (MULTI && !wasMulti && single) { single.close(); single = null; }
}
applyAuth();

// ---------------------------------------------------------------- workspaces
if (!MULTI) {
  try { single = new Workspace({ dataDir: DATA, vaultDir: VAULT, cipher }); } catch (e) { console.error(e.message); process.exit(1); }
}

/** The single-user notes and settings become the first multi-user account's. */
function adoptLegacy(u) {
  const legacy = ['config.json', 'index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm'].filter((f) => fs.existsSync(path.join(DATA, f)));
  if (!legacy.length) return;
  const p = users.paths(u, { dataRoot: DATA, vaultRoot: VAULT });
  if (fs.existsSync(path.join(p.data, 'config.json'))) return;
  fs.mkdirSync(p.data, { recursive: true });
  for (const f of legacy) fs.renameSync(path.join(DATA, f), path.join(p.data, f));
  let moved = 0;
  if (!u.vault) {
    fs.mkdirSync(p.vault, { recursive: true });
    const others = new Set(users.list().map((x) => x.name));
    for (const ent of fs.readdirSync(VAULT)) {
      if (others.has(ent)) continue;
      fs.renameSync(path.join(VAULT, ent), path.join(p.vault, ent));
      moved++;
    }
  }
  console.log(`Moved the single-user settings${moved ? ` and ${moved} vault item(s)` : ''} to ${u.name}.`);
}
if (MULTI) {
  const first = users.admins()[0] || users.list()[0];
  if (first) adoptLegacy(first);
}

function workspaceFor(name) {
  if (!MULTI) return single;
  let ws = workspaces.get(name);
  if (ws) return ws;
  const u = users.get(name);
  if (!u) throw new AuthError('Not signed in', 401);
  const p = users.paths(u, { dataRoot: DATA, vaultRoot: VAULT });
  // A vault must not contain (or be inside) anyone else's, or one user could read another's notes.
  for (const o of users.list()) {
    if (o.name === u.name) continue;
    const ov = users.paths(o, { dataRoot: DATA, vaultRoot: VAULT }).vault;
    if (p.vault === VAULT || p.vault === ov || p.vault.startsWith(ov + path.sep) || ov.startsWith(p.vault + path.sep)) {
      throw Object.assign(new Error(`${u.name}'s vault (${p.vault}) overlaps ${o.name}'s. Give each user a separate folder.`), { status: 500 });
    }
  }
  ensureWritable(p.data);
  ensureWritable(p.vault);
  ws = new Workspace({ name, dataDir: p.data, vaultDir: p.vault, cipher });
  workspaces.set(name, ws);
  return ws;
}

function closeWorkspace(name) {
  workspaces.get(name)?.close();
  workspaces.delete(name);
}

// ---------------------------------------------------------------- helpers
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const redirect = (res, to, headers = {}) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...headers }); res.end(); };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new VaultError('Body too large', 413);
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new VaultError('Invalid JSON'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Bad path' }); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const abs = path.resolve(PUBLIC, '.' + rel);
  if (!abs.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.socket.encrypted || /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) ||
  oidc.publicUrl.startsWith('https:');
function cookie(req, name, value, { maxAge, path: p = '/' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}` +
    (maxAge !== undefined ? `; Max-Age=${maxAge}` : '');
}
const sessionCookie = (req, token) => cookie(req, COOKIE, token, { maxAge: 30 * 86400 });
const clientIp = (req) => req.socket.remoteAddress || '?';
const origin = (req) => `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

/** Basic auth in single-user mode (TICKMARK_USER/PASS). */
function checkBasic(req) {
  if (!AUTH_USER) return true;
  const h = req.headers.authorization || '';
  const [user, ...rest] = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
  const ok = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return !!(h && ok(user, AUTH_USER) && ok(rest.join(':'), AUTH_PASS || ''));
}

/** The signed-in user for a request in multi-user mode, or null. */
function sessionUser(req) {
  const token = cookies(req)[COOKIE];
  const s = sessions.get(token);
  if (!s) return null;
  const u = users.get(s.user);
  if (!u || s.created < (u.sessionsAfter || 0)) return null;
  return u;
}

const publicUser = (u) => ({ name: u.name, admin: !!u.admin, sso: !!u.oidc, hasPassword: !!u.hash, created: u.created });

// ---------------------------------------------------------------- SSO
async function oidcSignIn(claims) {
  const groups = oidc.groups(claims);
  if (oidc.allowedGroups.length && !groups.some((g) => oidc.allowedGroups.includes(g))) {
    throw new OIDCError("Your account isn't in a group that may use Tickmark.");
  }
  const admin = oidc.adminGroups.length ? groups.some((g) => oidc.adminGroups.includes(g)) : undefined;
  const link = { iss: claims.iss, sub: claims.sub };

  let u = users.byOidc(link.iss, link.sub);
  if (!u && oidc.matchUsername) {
    const local = users.get(oidc.username(claims));
    if (local && !local.oidc) u = users.update(local.name, { oidc: link });
  }
  if (!u) {
    if (!oidc.autoCreate) throw new OIDCError(`No Tickmark account is linked to ${claims.email || oidc.username(claims)}. Ask an admin to add you.`);
    const first = users.list().length === 0;
    let name = oidc.username(claims);
    for (let i = 2; users.get(name); i++) name = `${oidc.username(claims).slice(0, 29)}-${i}`;
    u = users.add({ name, admin: admin ?? first, oidc: link });
    if (first) adoptLegacy(u);
    console.log(`Created user ${u.name} from SSO sign-in`);
  } else if (admin !== undefined && admin !== !!u.admin) {
    // Admin rights follow the provider's groups, but never remove the last admin.
    try { users.update(u.name, { admin }); } catch {}
  }
  return u;
}

// ---------------------------------------------------------------- API
// Handlers get (ctx, query, body); ctx = { ws, user, req, res }.
const routes = {
  'GET /api/tree': ({ ws }) => ({ ...ws.vault.list(), inbox: ws.config.get().accounts[0]?.inboxFile || 'Inbox.md' }),
  'GET /api/file': ({ ws }, q) => ws.vault.read(q.get('path')),
  'PUT /api/file': ({ ws }, q, body) => {
    const r = ws.vault.save(q.get('path'), String(body.content ?? ''), { baseContent: body.baseContent ?? null });
    return { path: r.path, hash: r.hash, merged: r.merged, conflicts: r.conflicts || 0, content: r.merged ? r.content : undefined };
  },
  'POST /api/file': ({ ws }, q, body) => {
    const r = ws.vault.create(String(body.path), String(body.content ?? ''));
    return { path: r.path, hash: r.hash };
  },
  'DELETE /api/file': ({ ws }, q) => { ws.vault.trash(q.get('path')); return { ok: true }; },
  'POST /api/rename': ({ ws }, q, body) => ({ ok: true, updated: ws.rename(String(body.from), String(body.to)) }),
  'POST /api/folder': ({ ws }, q, body) => { ws.vault.mkdir(String(body.path)); return { ok: true }; },
  'GET /api/search': ({ ws }, q) => ws.index.search(q.get('q') || ''),
  'GET /api/backlinks': ({ ws }, q) => ws.index.backlinks(q.get('path') || ''),
  'GET /api/config': ({ ws }) => ws.config.public(),
  'PUT /api/config': ({ ws }, q, body) => ws.updateConfig(body),
  'POST /api/caldav/discover': async ({ ws }, q, body) => {
    const saved = body.accountId ? ws.config.account(body.accountId) : null;
    const client = new CalDAV({
      url: body.url || saved?.url,
      username: body.username ?? saved?.username,
      password: body.password || saved?.password,
    });
    return { calendars: await client.discover() };
  },
  // ---- recently deleted synced tasks (kept 30 days)
  'GET /api/deleted': ({ ws }) => {
    const names = new Map(ws.config.get().accounts.map((a) => [a.id, a.name]));
    return ws.index.listDeleted().map(({ line, ...d }) => ({ ...d, accountName: names.get(d.account) || null }));
  },
  'POST /api/deleted/restore': async ({ ws }, q, body) => ws.sync.restore(Number(body.id)),
  'DELETE /api/deleted': ({ ws }, q) => {
    if (q.get('id') === 'all') ws.index.clearDeleted();
    else ws.index.removeDeleted(Number(q.get('id')));
    return { ok: true };
  },
  'GET /api/sync': ({ ws }) => ws.sync.status,
  'POST /api/sync': async ({ ws }, q, body) => {
    try {
      return { ok: true, result: await ws.sync.run({ force: !!body.force }) };
    } catch (e) {
      return { ok: false, error: e.message, needsForce: !!e.needsForce, result: e.result };
    }
  },

  // ---- signed-in user
  'PUT /api/account/password': ({ user, req, res }, q, body) => {
    if (!LOCAL_LOGIN) throw new AuthError('Password sign-in is turned off on this server');
    if (user.hash && !users.verify(user.name, String(body.current || ''))) throw new AuthError('Current password is wrong', 403);
    users.update(user.name, { password: String(body.password || '') }); // signs out every other session…
    res.setHeader('Set-Cookie', sessionCookie(req, sessions.create(user.name))); // …but keeps this one
    return { ok: true };
  },

  // ---- admin: single sign-on
  'GET /api/admin/sso': ({ user, req }) => { admin(user); return ssoState(req); },
  'PUT /api/admin/sso': ({ user, req }, q, body) => {
    admin(user);
    const v = (k) => (body[k] === undefined ? undefined : String(body[k] ?? '').trim());
    // Never leave the admin making the change unable to sign in.
    const issuerOff = v('TICKMARK_OIDC_ISSUER') === '' || (v('TICKMARK_OIDC_ISSUER') === undefined && !oidc.enabled);
    const passwordsOff = /^(0|false|no|off)$/i.test(v('TICKMARK_LOCAL_LOGIN') ?? (LOCAL_LOGIN ? 'true' : 'false'));
    if (passwordsOff && issuerOff) throw new AuthError('Turning off both SSO and password sign-in would lock everyone out');
    if (passwordsOff && !user.oidc) throw new AuthError('Sign in with SSO once before turning off password sign-in, so you can still get in');
    if (issuerOff && oidc.enabled && !user.hash) throw new AuthError('Set a password for yourself (Your account) before turning SSO off, or you couldn’t sign in afterwards');
    const patch = {};
    for (const f of SSO_FIELDS) if (body[f.key] !== undefined) patch[f.key] = body[f.key];
    serverSettings.save(patch);
    applyAuth();
    console.log(`SSO settings changed by ${user.name}: ${oidc.enabled ? `on, via ${oidc.issuer}` : 'off'}`);
    return ssoState(req);
  },
  'POST /api/admin/sso/test': async ({ user }, q, body) => {
    admin(user);
    const probe = new OIDC({ TICKMARK_OIDC_ISSUER: String(body.issuer || '').trim() || oidc.issuer, TICKMARK_OIDC_CLIENT_ID: 'probe' });
    if (!probe.issuer) throw new AuthError('Enter the issuer URL first');
    try {
      const doc = await probe.discover();
      return { ok: true, issuer: doc.issuer, scopes: doc.scopes_supported || null, claims: doc.claims_supported || null };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ---- admin: users
  'GET /api/users': ({ user }) => { admin(user); return users.list().map(publicUser); },
  'POST /api/users': ({ user }, q, body) => {
    admin(user);
    if (!body.password && !oidc.enabled) throw new AuthError('Set a password (SSO is not configured, so it is the only way to sign in)');
    const u = users.add({ name: body.name, password: body.password || null, admin: !!body.admin });
    return publicUser(u);
  },
  'PUT /api/users': ({ user }, q, body) => {
    admin(user);
    const patch = {};
    if (body.admin !== undefined) {
      if (normName(body.name) === user.name && !body.admin) throw new AuthError("You can't remove your own admin rights");
      patch.admin = !!body.admin;
    }
    if (body.password) patch.password = String(body.password);
    if (body.unlinkSso) patch.oidc = null;
    return publicUser(users.update(body.name, patch));
  },
  'DELETE /api/users': ({ user }, q) => {
    admin(user);
    const name = normName(q.get('name'));
    if (name === user.name) throw new AuthError("You can't remove yourself");
    users.remove(name);
    sessions.destroyUser(name);
    closeWorkspace(name);
    return { ok: true };
  },
};
function admin(user) { if (!user?.admin) throw new AuthError('Only admins can do that', 403); }

function ssoState(req) {
  return {
    ...serverSettings.describe(),
    enabled: oidc.enabled,
    encrypted: cipher.enabled,
    redirectUri: oidc.redirectUri(origin(req)),
    suggestedPublicUrl: origin(req),
    problem: serverSettings.problem,
  };
}

// Routes that work without a session.
const authRoutes = {
  'GET /api/auth/me': ({ req }) => {
    if (!MULTI) return { mode: 'single', canSetup: true };
    const u = sessionUser(req);
    return {
      mode: 'multi', user: u ? publicUser(u) : null, localLogin: LOCAL_LOGIN,
      sso: oidc.enabled ? { label: oidc.label } : null,
    };
  },
  'POST /api/auth/login': ({ req, res }, q, body) => {
    if (!MULTI) throw new AuthError('Tickmark is in single-user mode', 404);
    if (!LOCAL_LOGIN) throw new AuthError('Password sign-in is turned off on this server; use SSO', 403);
    const ip = clientIp(req);
    limiter.check(ip);
    const u = users.verify(String(body.username || '').trim(), String(body.password || ''));
    if (!u) { limiter.fail(ip); throw new AuthError('Wrong user name or password', 401); }
    limiter.ok(ip);
    res.setHeader('Set-Cookie', sessionCookie(req, sessions.create(u.name)));
    return { user: publicUser(u) };
  },
  // Turning sign-in on from the browser: the first admin takes over the single-user notes and settings.
  // No session is issued: the browser that did this signs in like everyone else, which also confirms
  // the new password works.
  'POST /api/setup/admin': ({ req }, q, body) => {
    if (MULTI) throw new AuthError('Sign-in is already on', 409);
    if (AUTH_USER && !checkBasic(req)) throw new AuthError('Not signed in', 401);
    const u = users.add({ name: body.name, password: String(body.password || ''), admin: true });
    single?.close();
    single = null;
    adoptLegacy(u);
    applyAuth();
    console.log(`Sign-in turned on: ${u.name} created as admin from Settings`);
    return { user: publicUser(u) };
  },
  'POST /api/auth/logout': ({ req, res }) => {
    if (!MULTI) return { ok: true };
    const token = cookies(req)[COOKIE];
    if (token) sessions.destroy(token);
    res.setHeader('Set-Cookie', cookie(req, COOKIE, '', { maxAge: 0 }));
    return { ok: true };
  },
};

async function handleOidc(req, res, url) {
  const fail = (msg) => redirect(res, '/?login_error=' + encodeURIComponent(msg), { 'Set-Cookie': cookie(req, 'tm_oidc', '', { maxAge: 0, path: '/auth/oidc' }) });
  if (!oidc.enabled) return json(res, 404, { error: 'SSO is not configured' });
  try {
    if (url.pathname === '/auth/oidc/login') {
      const { url: to, state } = await oidc.start(origin(req));
      return redirect(res, to, { 'Set-Cookie': cookie(req, 'tm_oidc', state, { maxAge: 600, path: '/auth/oidc' }) });
    }
    if (url.pathname === '/auth/oidc/callback') {
      const claims = await oidc.finish(url.searchParams, cookies(req).tm_oidc);
      const u = await oidcSignIn(claims);
      return redirect(res, '/', { 'Set-Cookie': [sessionCookie(req, sessions.create(u.name)), cookie(req, 'tm_oidc', '', { maxAge: 0, path: '/auth/oidc' })] });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof OIDCError) && !(e instanceof AuthError)) console.error('SSO sign-in failed:', e);
    else console.warn('SSO sign-in failed:', e.message);
    return fail(e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!MULTI && !checkBasic(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tickmark"' });
    return res.end('Authentication required');
  }
  if (url.pathname.startsWith('/auth/oidc/')) return handleOidc(req, res, url);
  // The app shell is public in multi-user mode (it shows the sign-in screen); data is not.
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const key = `${req.method} ${url.pathname}`;
  try {
    if (authRoutes[key]) {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return json(res, 200, await authRoutes[key]({ req, res }, url.searchParams, body));
    }
    const user = MULTI ? sessionUser(req) : null;
    if (MULTI && !user) return json(res, 401, { error: 'Not signed in' });

    if (url.pathname === '/api/events') {
      const ws = workspaceFor(user?.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: sync\ndata: ${JSON.stringify(ws.sync.status)}\n\n`);
      ws.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { ws.clients.delete(res); clearInterval(ping); });
      return;
    }
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'Unknown endpoint' });
    if (!MULTI && /^\/api\/(users|account|admin)/.test(url.pathname)) {
      return json(res, 404, { error: 'Tickmark is in single-user mode' });
    }
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    // The workspace opens on first use, so admin pages still work if a user's settings can't be
    // decrypted (that's exactly when an admin needs to fix the SSO settings).
    const ctx = { user, req, res, get ws() { return workspaceFor(user?.name); } };
    json(res, 200, await handler(ctx, url.searchParams, body));
  } catch (e) {
    const status = e instanceof CalDAVError ? 502 : Number.isInteger(e.status) ? e.status : 500;
    if (status === 500) console.error(e);
    json(res, status, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tickmark on http://${HOST}:${PORT}`);
  console.log(`  vault: ${VAULT}${MULTI ? '/<user>' : ''}`);
  console.log(`  data:  ${DATA}`);
  if (MULTI) {
    console.log(`  multi-user: ${users.list().length} user(s)${oidc.enabled ? `, SSO via ${oidc.issuer}` : ''}${LOCAL_LOGIN ? '' : ', password sign-in off'}`);
    if (AUTH_USER) console.warn('  TICKMARK_USER/TICKMARK_PASS are ignored in multi-user mode');
    if (cipher.enabled) console.log('  settings: CalDAV accounts encrypted with the OIDC client secret');
    else if (oidc.enabled) console.warn('  ⚠ settings are not encrypted: SSO has no client secret (public client)');
    if (oidc.enabled && !oidc.publicUrl) console.warn('  TICKMARK_PUBLIC_URL is not set; the SSO redirect URI is guessed from each request');
    if (oidc.enabled && !users.list().length && !oidc.adminGroups.length && !oidc.allowedGroups.length) {
      console.warn('  ⚠ no users yet: the first person to sign in with SSO becomes admin. Set TICKMARK_OIDC_ALLOWED_GROUPS or _ADMIN_GROUPS to control this.');
    }
  } else if (!AUTH_USER && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('  ⚠ listening beyond localhost without sign-in (set TICKMARK_USER/TICKMARK_PASS, or add users)');
  }
});
