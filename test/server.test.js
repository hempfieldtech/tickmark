// Server-level tests: single-user mode, the switch to multi-user, password sign-in, isolation
// between users, admin rights, sessions, and SSO against a mock OpenID Connect provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env } });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('Tickmark on')) { clearTimeout(t); resolve(); } };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited (${c}):\n${out}`)); });
  });
  proc.removeAllListeners('exit');
  const base = `http://127.0.0.1:${port}`;
  return { base, log: () => out, stop: () => new Promise((r) => { proc.on('exit', r); proc.kill(); }) };
}

/** A tiny HTTP client with a cookie jar. */
function client(base) {
  const jar = new Map();
  const call = async (method, url, body, { follow = false } = {}) => {
    const r = await fetch(base + url, {
      method, redirect: follow ? 'follow' : 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === '') jar.delete(k.trim()); else jar.set(k.trim(), v);
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  return { call, jar };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tickmark-srv-'));
const addUser = (data, name, pw, ...flags) => execFileSync(process.execPath, ['server/users.js', 'add', name, ...flags],
  { cwd: ROOT, env: { ...process.env, TICKMARK_DATA: data, TICKMARK_NEW_PASSWORD: pw } }).toString();

test('single-user mode, then switching to multi-user', async (t) => {
  const dir = tmp();
  const env = { TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') };

  let srv = await startServer(env);
  let c = client(srv.base);
  await t.test('single-user mode needs no sign-in', async () => {
    assert.deepEqual((await c.call('GET', '/api/auth/me')).data, { mode: 'single', canSetup: true });
    assert.equal((await c.call('POST', '/api/file', { path: 'Hello.md', content: '- [ ] One #task\n' })).status, 200);
    const cfg = await c.call('PUT', '/api/config', { accounts: [{ name: 'Home', url: 'https://dav.example/', username: 'k', password: 'secret1', calendarUrl: 'https://dav.example/c/', itemTags: 'task', sectionTags: 'sync' }] });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.accounts[0].password, undefined, 'password never sent to the browser');
    assert.equal(cfg.data.accounts[0].hasPassword, true);
    assert.equal((await c.call('GET', '/api/users')).status, 404);
  });
  await srv.stop();

  assert.match(addUser(env.TICKMARK_DATA, 'Alex', 'correct horse'), /Added alex \(admin\)/);
  srv = await startServer(env);
  c = client(srv.base);

  await t.test('existing notes and settings move to the first user', async () => {
    assert.ok(fs.existsSync(path.join(dir, 'vault', 'alex', 'Hello.md')));
    assert.ok(fs.existsSync(path.join(dir, 'data', 'users', 'alex', 'config.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'config.json')));
    assert.match(srv.log(), /Moved the single-user settings and 1 vault item/);
  });

  await t.test('data needs a session; wrong passwords are refused', async () => {
    assert.equal((await c.call('GET', '/api/tree')).status, 401);
    assert.equal((await c.call('GET', '/api/events')).status, 401);
    const me = (await c.call('GET', '/api/auth/me')).data;
    assert.equal(me.mode, 'multi');
    assert.equal(me.user, null);
    assert.equal((await c.call('POST', '/api/auth/login', { username: 'alex', password: 'wrong' })).status, 401);
    assert.equal((await c.call('POST', '/api/auth/login', { username: 'nobody', password: 'wrong' })).status, 401);
    // The app shell stays public so the sign-in screen can load.
    assert.equal((await c.call('GET', '/')).status, 200);
  });

  await t.test('signing in gives the user their own notes and settings', async () => {
    const r = await c.call('POST', '/api/auth/login', { username: 'ALEX', password: 'correct horse' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /tm_session=.*HttpOnly; SameSite=Lax/);
    assert.deepEqual((await c.call('GET', '/api/tree')).data.files.map((f) => f.path), ['Hello.md']);
    assert.equal((await c.call('GET', '/api/config')).data.accounts[0].name, 'Home');
    assert.equal((await c.call('GET', '/api/auth/me')).data.user.admin, true);
  });

  const bob = client(srv.base);
  await t.test('admins add users; each user is isolated', async () => {
    assert.equal((await c.call('POST', '/api/users', { name: 'bob', password: 'short' })).status, 400);
    assert.equal((await c.call('POST', '/api/users', { name: 'bob', password: 'bobs password' })).status, 200);
    assert.equal((await c.call('POST', '/api/users', { name: 'bob', password: 'bobs password' })).status, 409);
    assert.equal((await bob.call('POST', '/api/auth/login', { username: 'bob', password: 'bobs password' })).status, 200);
    assert.deepEqual((await bob.call('GET', '/api/tree')).data.files, []);
    assert.equal((await bob.call('GET', '/api/file?path=Hello.md')).status, 404);
    assert.equal((await bob.call('GET', '/api/file?path=../alex/Hello.md')).status, 400);
    assert.equal((await bob.call('GET', '/api/config')).data.accounts.length, 0);
    await bob.call('POST', '/api/file', { path: 'Bob.md', content: 'mine' });
    assert.ok(fs.existsSync(path.join(dir, 'vault', 'bob', 'Bob.md')));
    assert.deepEqual((await c.call('GET', '/api/tree')).data.files.map((f) => f.path), ['Hello.md']);
    assert.deepEqual((await c.call('GET', '/api/search?q=mine')).data, []);
  });

  await t.test('only admins manage users', async () => {
    assert.equal((await bob.call('GET', '/api/users')).status, 403);
    assert.equal((await bob.call('POST', '/api/users', { name: 'eve', password: 'evil password' })).status, 403);
    assert.equal((await c.call('DELETE', '/api/users?name=alex')).status, 400, "can't remove yourself");
    assert.equal((await c.call('PUT', '/api/users', { name: 'alex', admin: false })).status, 400, "can't demote yourself");
    const list = (await c.call('GET', '/api/users')).data;
    assert.deepEqual(list.map((u) => [u.name, u.admin]), [['alex', true], ['bob', false]]);
    assert.equal(list[0].hash, undefined, 'password hashes never leave the server');
  });

  await t.test('changing a password signs out other sessions but keeps this one', async () => {
    const bob2 = client(srv.base);
    await bob2.call('POST', '/api/auth/login', { username: 'bob', password: 'bobs password' });
    assert.equal((await bob.call('PUT', '/api/account/password', { current: 'nope', password: 'new password 1' })).status, 403);
    assert.equal((await bob.call('PUT', '/api/account/password', { current: 'bobs password', password: 'new password 1' })).status, 200);
    assert.equal((await bob.call('GET', '/api/tree')).status, 200);
    assert.equal((await bob2.call('GET', '/api/tree')).status, 401);
  });

  await t.test('removing a user ends their sessions and keeps their files', async () => {
    assert.equal((await c.call('DELETE', '/api/users?name=bob')).status, 200);
    assert.equal((await bob.call('GET', '/api/tree')).status, 401);
    assert.ok(fs.existsSync(path.join(dir, 'vault', 'bob', 'Bob.md')));
  });

  await t.test('sign out', async () => {
    assert.equal((await c.call('POST', '/api/auth/logout')).status, 200);
    assert.equal((await c.call('GET', '/api/tree')).status, 401);
  });

  await t.test('sessions survive a restart', async () => {
    await c.call('POST', '/api/auth/login', { username: 'alex', password: 'correct horse' });
    await srv.stop();
    srv = await startServer(env);
    const again = client(srv.base);
    for (const [k, v] of c.jar) again.jar.set(k, v);
    assert.equal((await again.call('GET', '/api/tree')).status, 200);
  });

  await t.test('repeated wrong passwords are slowed down', async () => {
    const x = client(srv.base);
    for (let i = 0; i < 10; i++) await x.call('POST', '/api/auth/login', { username: 'alex', password: 'guess' + i });
    assert.equal((await x.call('POST', '/api/auth/login', { username: 'alex', password: 'correct horse' })).status, 429);
  });
  await srv.stop();
});

// ---------------------------------------------------------------- mock OpenID provider
async function mockIdp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const st = { codes: new Map(), user: null, key: privateKey, signWith: privateKey, tamperNonce: false };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, st.issuer);
    const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send({ issuer: st.issuer, authorization_endpoint: st.issuer + '/authorize', token_endpoint: st.issuer + '/token',
        jwks_uri: st.issuer + '/jwks', userinfo_endpoint: st.issuer + '/userinfo', token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    }
    if (url.pathname === '/jwks') return send({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      // A real provider would show its login page here; the mock signs in st.user immediately.
      const code = crypto.randomBytes(8).toString('hex');
      st.codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri'), user: st.user });
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = ''; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const c = st.codes.get(p.get('code'));
      if (req.headers.authorization !== 'Basic ' + Buffer.from('tickmark:s3cret').toString('base64')) return send({ error: 'invalid_client' }, 401);
      if (!c || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge || p.get('redirect_uri') !== c.redirect) {
        return send({ error: 'invalid_grant' }, 400);
      }
      st.codes.delete(p.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: st.issuer, aud: 'tickmark', iat: now, exp: now + 300, nonce: st.tamperNonce ? 'x' : c.nonce, sub: c.user.sub, preferred_username: c.user.username, email: c.user.email };
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = crypto.sign('sha256', Buffer.from(`${h}.${b}`), st.signWith).toString('base64url');
      return send({ id_token: `${h}.${b}.${sig}`, access_token: 'at-' + c.user.sub, token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') {
      const sub = (req.headers.authorization || '').replace('Bearer at-', '');
      const u = [st.user].find((x) => x?.sub === sub) || st.lastUsers?.get(sub);
      return send({ sub, groups: u?.groups || [] });
    }
    send({ error: 'not found' }, 404);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.issuer = `http://127.0.0.1:${srv.address().port}`;
  return { st, evil, close: () => srv.close() };
}

/** Run the whole browser flow: Tickmark → provider → callback → Tickmark. Returns the final redirect. */
async function ssoSignIn(c, idp) {
  const start = await c.call('GET', '/auth/oidc/login');
  assert.equal(start.status, 302);
  const authz = new URL(start.headers.get('location'));
  assert.equal(authz.searchParams.get('code_challenge_method'), 'S256');
  const back = await fetch(authz, { redirect: 'manual' });
  const cb = new URL(back.headers.get('location'));
  const r = await c.call('GET', cb.pathname + cb.search);
  return r.headers.get('location');
}

test('SSO sign-in via OpenID Connect', async (t) => {
  const idp = await mockIdp();
  const dir = tmp();
  const srv = await startServer({
    TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'),
    TICKMARK_OIDC_ISSUER: idp.st.issuer, TICKMARK_OIDC_CLIENT_ID: 'tickmark', TICKMARK_OIDC_CLIENT_SECRET: 's3cret',
    TICKMARK_OIDC_ALLOWED_GROUPS: 'notes', TICKMARK_OIDC_ADMIN_GROUPS: 'admins', TICKMARK_OIDC_LABEL: 'Sign in with Authelia',
  });
  idp.st.lastUsers = new Map();
  const as = (u) => { idp.st.user = u; idp.st.lastUsers.set(u.sub, u); };

  try {
    await t.test('OIDC alone turns on multi-user mode', async () => {
      const me = (await client(srv.base).call('GET', '/api/auth/me')).data;
      assert.deepEqual(me.sso, { label: 'Sign in with Authelia' });
      assert.equal(me.mode, 'multi');
    });

    const alex = client(srv.base);
    await t.test('first sign-in creates the user, with admin from groups', async () => {
      as({ sub: 'u-1', username: 'Alex.H', email: 'k@example.com', groups: ['notes', 'admins'] });
      assert.equal(await ssoSignIn(alex, idp), '/');
      const me = (await alex.call('GET', '/api/auth/me')).data.user;
      assert.deepEqual([me.name, me.admin, me.sso, me.hasPassword], ['alex.h', true, true, false]);
      assert.equal((await alex.call('GET', '/api/tree')).status, 200);
    });

    await t.test('the same identity signs in to the same user', async () => {
      const again = client(srv.base);
      as({ sub: 'u-1', username: 'renamed-at-idp', groups: ['notes', 'admins'] });
      await ssoSignIn(again, idp);
      assert.equal((await again.call('GET', '/api/auth/me')).data.user.name, 'alex.h');
    });

    await t.test('a name clash gets a suffix, never someone else’s account', async () => {
      const other = client(srv.base);
      as({ sub: 'u-2', username: 'alex.h', groups: ['notes'] });
      await ssoSignIn(other, idp);
      const me = (await other.call('GET', '/api/auth/me')).data.user;
      assert.deepEqual([me.name, me.admin], ['alex.h-2', false]);
    });

    await t.test('people outside the allowed groups are turned away', async () => {
      const x = client(srv.base);
      as({ sub: 'u-3', username: 'mallory', groups: ['other'] });
      const to = await ssoSignIn(x, idp);
      assert.match(decodeURIComponent(to), /login_error=Your account isn't in a group/);
      assert.equal((await x.call('GET', '/api/tree')).status, 401);
    });

    await t.test('a token signed with the wrong key is rejected', async () => {
      const x = client(srv.base);
      as({ sub: 'u-1', username: 'alex', groups: ['notes'] });
      idp.st.signWith = idp.evil;
      const to = await ssoSignIn(x, idp);
      idp.st.signWith = idp.st.key;
      assert.match(decodeURIComponent(to), /signature is invalid/);
      assert.equal((await x.call('GET', '/api/tree')).status, 401);
    });

    await t.test('a callback without the matching state cookie is rejected', async () => {
      const x = client(srv.base);
      const start = await x.call('GET', '/auth/oidc/login');
      const back = await fetch(start.headers.get('location'), { redirect: 'manual' });
      const cb = new URL(back.headers.get('location'));
      const attacker = client(srv.base); // a different browser, without tm_oidc
      const r = await attacker.call('GET', cb.pathname + cb.search);
      assert.match(decodeURIComponent(r.headers.get('location')), /login_error=Sign-in expired/);
    });

    await t.test('admins can still add password users alongside SSO', async () => {
      assert.equal((await alex.call('POST', '/api/users', { name: 'guest', password: 'guest password' })).status, 200);
      assert.equal((await client(srv.base).call('POST', '/api/auth/login', { username: 'guest', password: 'guest password' })).status, 200);
    });
  } finally {
    await srv.stop();
    idp.close();
  }
});

test('with SSO configured, CalDAV settings are encrypted with the client secret', async (t) => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  const base = { TICKMARK_DATA: data, TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_OIDC_ISSUER: 'http://127.0.0.1:9/never-called', TICKMARK_OIDC_CLIENT_ID: 'tickmark' };
  addUser(data, 'alex', 'correct horse');
  const cfgFile = path.join(data, 'users', 'alex', 'config.json');
  let srv = await startServer({ ...base, TICKMARK_OIDC_CLIENT_SECRET: 'first-secret' });
  const c = client(srv.base);
  await c.call('POST', '/api/auth/login', { username: 'alex', password: 'correct horse' });
  const reconnect = async (env) => { await srv.stop(); srv = await startServer({ ...base, ...env }); const x = client(srv.base); for (const [k, v] of c.jar) x.jar.set(k, v); return x; };

  await t.test('saved settings are unreadable on disk', async () => {
    assert.match(srv.log(), /CalDAV accounts encrypted with the OIDC client secret/);
    const r = await c.call('PUT', '/api/config', { accounts: [{ name: 'Home tasks', url: 'https://dav.example/dav.php', username: 'sam42', password: 'hunter22', calendarUrl: 'https://dav.example/dav.php/calendars/sam42/default/', itemTags: 'task' }] });
    assert.equal(r.status, 200);
    assert.equal(r.data.encrypted, true);
    const raw = fs.readFileSync(cfgFile, 'utf8');
    assert.doesNotMatch(raw, /dav\.example|sam42|hunter22|Home tasks/);
    assert.equal((await c.call('GET', '/api/config')).data.accounts[0].username, 'sam42');
  });

  await t.test('a different secret gives a clear error instead of losing settings', async () => {
    const x = await reconnect({ TICKMARK_OIDC_CLIENT_SECRET: 'rotated-secret' });
    const r = await x.call('GET', '/api/config');
    assert.equal(r.status, 500);
    assert.match(r.data.error, /TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET/);
  });

  await t.test('the previous secret re-encrypts them with the new one', async () => {
    let x = await reconnect({ TICKMARK_OIDC_CLIENT_SECRET: 'rotated-secret', TICKMARK_OIDC_PREVIOUS_CLIENT_SECRET: 'first-secret' });
    assert.equal((await x.call('GET', '/api/config')).data.accounts[0].name, 'Home tasks');
    x = await reconnect({ TICKMARK_OIDC_CLIENT_SECRET: 'rotated-secret' });
    assert.equal((await x.call('GET', '/api/config')).data.accounts[0].name, 'Home tasks', 'works without the old secret now');
  });

  await t.test('turning SSO off (secret still set once) stores them in plain JSON again', async () => {
    const off = { TICKMARK_OIDC_ISSUER: '', TICKMARK_OIDC_CLIENT_ID: '' };
    let x = await reconnect({ ...off, TICKMARK_OIDC_CLIENT_SECRET: 'rotated-secret' });
    assert.equal((await x.call('GET', '/api/config')).data.encrypted, false);
    assert.match(fs.readFileSync(cfgFile, 'utf8'), /sam42/);
    x = await reconnect({ ...off });
    assert.equal((await x.call('GET', '/api/config')).data.accounts[0].name, 'Home tasks');
  });
  await srv.stop();
});

test('turning sign-in on from Settings, without a restart', async () => {
  const dir = tmp();
  const env = { TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') };
  const srv = await startServer(env);
  try {
    const me = client(srv.base), other = client(srv.base);
    await me.call('POST', '/api/file', { path: 'Mine.md', content: 'hello' });
    assert.equal((await me.call('POST', '/api/setup/admin', { name: 'alex', password: 'short' })).status, 400);
    const r = await me.call('POST', '/api/setup/admin', { name: 'Alex', password: 'correct horse' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.admin, true);
    assert.equal(r.headers.get('set-cookie'), null, 'no session: the creator signs in like everyone else');
    // Everyone, including the browser that turned it on, now has to sign in.
    assert.equal((await me.call('GET', '/api/tree')).status, 401);
    assert.equal((await other.call('GET', '/api/tree')).status, 401);
    assert.equal((await me.call('POST', '/api/auth/login', { username: 'alex', password: 'correct horse' })).status, 200);
    assert.deepEqual((await me.call('GET', '/api/tree')).data.files.map((f) => f.path), ['Mine.md']);
    assert.ok(fs.existsSync(path.join(dir, 'vault', 'alex', 'Mine.md')));
    assert.equal((await other.call('POST', '/api/setup/admin', { name: 'eve', password: 'evil password' })).status, 409);
  } finally { await srv.stop(); }
});

test('SSO configured from Settings', async (t) => {
  const idp = await mockIdp();
  idp.st.lastUsers = new Map();
  const dir = tmp();
  const data = path.join(dir, 'data');
  const env = { TICKMARK_DATA: data, TICKMARK_VAULT: path.join(dir, 'vault') };
  addUser(data, 'alex', 'correct horse');
  addUser(data, 'bob', 'bobs password');
  let srv = await startServer(env);
  let c = client(srv.base);
  const restart = async (extra) => { await srv.stop(); srv = await startServer({ ...env, ...extra }); const x = client(srv.base); for (const [k, v] of c.jar) x.jar.set(k, v); c = x; };
  const sso = { TICKMARK_OIDC_ISSUER: idp.st.issuer, TICKMARK_OIDC_CLIENT_ID: 'tickmark', TICKMARK_OIDC_CLIENT_SECRET: 's3cret', TICKMARK_OIDC_LABEL: 'Sign in with Pocket ID' };
  try {
    await c.call('POST', '/api/auth/login', { username: 'alex', password: 'correct horse' });

    await t.test('admins only', async () => {
      const bob = client(srv.base);
      await bob.call('POST', '/api/auth/login', { username: 'bob', password: 'bobs password' });
      assert.equal((await bob.call('GET', '/api/admin/sso')).status, 403);
      assert.equal((await bob.call('PUT', '/api/admin/sso', sso)).status, 403);
      const s = (await c.call('GET', '/api/admin/sso')).data;
      assert.deepEqual([s.enabled, s.masterKey, s.secretSet], [false, false, false]);
      assert.match(s.redirectUri, /\/auth\/oidc\/callback$/);
    });

    await t.test('storing the secret needs a master key in .env', async () => {
      const r = await c.call('PUT', '/api/admin/sso', sso);
      assert.equal(r.status, 400);
      assert.match(r.data.error, /TICKMARK_SECRET_KEY/);
    });

    await restart({ TICKMARK_SECRET_KEY: 'master-key-one' });

    await t.test('test the provider, save, and SSO is on immediately', async () => {
      assert.equal((await c.call('POST', '/api/admin/sso/test', { issuer: idp.st.issuer })).data.ok, true);
      assert.equal((await c.call('POST', '/api/admin/sso/test', { issuer: 'http://127.0.0.1:9' })).data.ok, false);
      const r = await c.call('PUT', '/api/admin/sso', sso);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual([r.data.enabled, r.data.encrypted, r.data.secretSet], [true, true, true]);
      assert.equal(r.data.values.TICKMARK_OIDC_CLIENT_SECRET, undefined, 'the secret never goes back to the browser');
      assert.deepEqual((await client(srv.base).call('GET', '/api/auth/me')).data.sso, { label: 'Sign in with Pocket ID' });
      const raw = fs.readFileSync(path.join(data, 'tickmark.sqlite')).toString('latin1') +
        (fs.existsSync(path.join(data, 'tickmark.sqlite-wal')) ? fs.readFileSync(path.join(data, 'tickmark.sqlite-wal')).toString('latin1') : '');
      assert.ok(!raw.includes('s3cret'), 'secret is encrypted in the database');
    });

    await t.test('CalDAV settings are now encrypted, and SSO sign-in works', async () => {
      await c.call('PUT', '/api/config', { accounts: [{ name: 'Home', url: 'https://dav.example/', username: 'alex', password: 'pw-123', calendarUrl: 'https://dav.example/c/', itemTags: 'task' }] });
      assert.doesNotMatch(fs.readFileSync(path.join(data, 'users', 'alex', 'config.json'), 'utf8'), /dav\.example|pw-123/);
      idp.st.user = { sub: 'alex-sub', username: 'alex-sso', groups: [] };
      idp.st.lastUsers.set('alex-sub', idp.st.user);
      const x = client(srv.base);
      assert.equal(await ssoSignIn(x, idp), '/');
      assert.equal((await x.call('GET', '/api/auth/me')).data.user.name, 'alex-sso');
    });

    await t.test('it survives a restart (secret decrypted with the master key)', async () => {
      await restart({ TICKMARK_SECRET_KEY: 'master-key-one' });
      assert.equal((await c.call('GET', '/api/admin/sso')).data.enabled, true);
      assert.equal((await c.call('GET', '/api/config')).data.accounts[0].name, 'Home');
    });

    await t.test('guards against locking yourself out', async () => {
      let r = await c.call('PUT', '/api/admin/sso', { TICKMARK_LOCAL_LOGIN: 'false' });
      assert.match(r.data.error, /Sign in with SSO once/);
      r = await c.call('PUT', '/api/admin/sso', { TICKMARK_OIDC_ISSUER: '', TICKMARK_LOCAL_LOGIN: 'false' });
      assert.match(r.data.error, /lock everyone out/);
    });

    await t.test('changing the secret keeps CalDAV settings readable', async () => {
      const r = await c.call('PUT', '/api/admin/sso', { TICKMARK_OIDC_CLIENT_SECRET: 'new-secret' });
      assert.equal(r.status, 200);
      assert.equal((await c.call('GET', '/api/config')).data.accounts[0].password, undefined);
      assert.equal((await c.call('GET', '/api/config')).data.accounts[0].name, 'Home');
    });

    await t.test('.env wins and shows as locked', async () => {
      await restart({ TICKMARK_SECRET_KEY: 'master-key-one', TICKMARK_OIDC_LABEL: 'From env' });
      const s = (await c.call('GET', '/api/admin/sso')).data;
      assert.ok(s.locked.includes('TICKMARK_OIDC_LABEL'));
      assert.equal(s.values.TICKMARK_OIDC_LABEL, 'From env');
      await c.call('PUT', '/api/admin/sso', { TICKMARK_OIDC_LABEL: 'ignored' });
      assert.equal((await client(srv.base).call('GET', '/api/auth/me')).data.sso.label, 'From env');
    });

    await t.test('a missing master key is reported, not silently ignored', async () => {
      await restart({});
      assert.match(srv.log(), /TICKMARK_SECRET_KEY is not set/);
      const s = (await c.call('GET', '/api/admin/sso')).data;
      assert.equal(s.enabled, true, 'issuer is still set');
      assert.match(s.problem, /TICKMARK_SECRET_KEY/);
    });

    await t.test('turning SSO off from Settings', async () => {
      await restart({ TICKMARK_SECRET_KEY: 'master-key-one' });
      const r = await c.call('PUT', '/api/admin/sso', { TICKMARK_OIDC_ISSUER: '' });
      assert.equal(r.status, 200);
      assert.equal(r.data.enabled, false);
      assert.equal((await c.call('GET', '/api/config')).data.accounts[0].name, 'Home', 'settings decrypted, not lost');
      assert.match(fs.readFileSync(path.join(data, 'users', 'alex', 'config.json'), 'utf8'), /dav\.example/);
    });
  } finally {
    await srv.stop();
    idp.close();
  }
});

test('renaming a note updates [[links]] to it in other notes', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  const c = client(srv.base);
  try {
    await c.call('POST', '/api/file', { path: 'Ideas.md', content: 'Some ideas\n' });
    await c.call('POST', '/api/file', { path: 'Daily.md', content: 'Read [[Ideas]] and [[Ideas#Later|later]].\n' });
    await c.call('POST', '/api/file', { path: 'Other.md', content: 'No links here\n' });
    const r = await c.call('POST', '/api/rename', { from: 'Ideas.md', to: 'Projects/Someday.md' });
    assert.deepEqual(r.data, { ok: true, updated: ['Daily.md'] });
    assert.equal(fs.readFileSync(path.join(dir, 'vault', 'Daily.md'), 'utf8'), 'Read [[Someday]] and [[Someday#Later|later]].\n');
    assert.deepEqual((await c.call('GET', '/api/backlinks?path=Projects%2FSomeday.md')).data, ['Daily.md']);
  } finally { await srv.stop(); }
});

test('branding: name, logo and favicon for everyone, set by admins', async () => {
  const dir = tmp();
  const env = { TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') };
  let srv = await startServer(env);
  let c = client(srv.base);
  const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64');
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  try {
    assert.deepEqual((await c.call('GET', '/api/branding')).data,
      { name: 'Tickmark', customName: false, logo: '/icons/icon.svg', favicon: '/icons/icon.svg', hasLogo: false, hasFavicon: false });
    const b = (await c.call('PUT', '/api/branding', { name: 'Acme <Notes>', logo: svg, favicon: png })).data;
    assert.equal(b.name, 'Acme <Notes>');
    assert.match(b.logo, /^\/branding\/logo\?v=/);
    assert.match(b.favicon, /^\/branding\/favicon\?v=/);
    const html = (await c.call('GET', '/')).data;
    assert.match(html, /<title>Acme &lt;Notes&gt;<\/title>/);
    assert.match(html, /<span class="brand-name">Acme &lt;Notes&gt;<\/span>/);
    assert.ok(html.includes(`<link rel="icon" href="${b.favicon}" type="image/png">`));
    const logo = await fetch(srv.base + b.logo);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(logo.headers.get('content-security-policy'), /default-src 'none'/, 'SVG scripts never run');
    const m = (await c.call('GET', '/manifest.webmanifest')).data;
    assert.equal(m.name, 'Acme <Notes>');
    assert.equal(m.icons[0].src, b.logo);
    assert.equal((await c.call('PUT', '/api/branding', { logo: 'data:text/html;base64,PGI+' })).status, 400);
    // Back to the defaults; the old files go away.
    await c.call('PUT', '/api/branding', { name: '', logo: null, favicon: null });
    assert.match((await c.call('GET', '/')).data, /<title>Tickmark<\/title>/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data', 'branding')), []);
    await c.call('PUT', '/api/branding', { name: 'Acme' });
  } finally { await srv.stop(); }

  // With sign-in on, only admins can change it, but anyone (even signed out) sees it.
  addUser(env.TICKMARK_DATA, 'boss', 'correct horse');
  srv = await startServer(env);
  try {
    c = client(srv.base);
    assert.equal((await c.call('GET', '/api/branding')).data.name, 'Acme');
    assert.equal((await c.call('PUT', '/api/branding', { name: 'Mine' })).status, 401);
    await c.call('POST', '/api/auth/login', { username: 'boss', password: 'correct horse' });
    await c.call('POST', '/api/users', { name: 'pat', password: 'battery staple' });
    const p = client(srv.base);
    await p.call('POST', '/api/auth/login', { username: 'pat', password: 'battery staple' });
    assert.equal((await p.call('PUT', '/api/branding', { name: 'Mine' })).status, 403);
    assert.equal((await c.call('PUT', '/api/branding', { name: 'Ours' })).data.name, 'Ours');
  } finally { await srv.stop(); }
});
