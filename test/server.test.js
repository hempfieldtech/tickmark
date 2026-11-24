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

test('public links share a note or folder, read-only, only with a domain-based public URL', async () => {
  const dir = tmp();
  const base = { TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') };
  // An IP address isn't good enough.
  let srv = await startServer({ ...base, TICKMARK_PUBLIC_URL: 'http://192.168.1.5:8087' });
  let c = client(srv.base);
  try {
    await c.call('POST', '/api/file', { path: 'Plan.md', content: '# Plan\n- [ ] Ship #task ^tabc1234\nSee [[Ideas]].\n' });
    await c.call('POST', '/api/file', { path: 'Trip/Packing.md', content: 'Socks, see [[Route]]\n' });
    await c.call('POST', '/api/file', { path: 'Trip/Notes/Route.md', content: 'North <script>alert(1)</script>\n' });
    await c.call('POST', '/api/file', { path: 'Private.md', content: 'secret\n' });
    assert.match((await c.call('GET', '/api/shares')).data.blocker, /local address/);
    assert.equal((await c.call('POST', '/api/shares', { path: 'Plan.md' })).status, 400);
  } finally { await srv.stop(); }

  srv = await startServer({ ...base, TICKMARK_PUBLIC_URL: 'https://notes.example.com/' , TICKMARK_USER: 'me', TICKMARK_PASS: 'pw' });
  c = client(srv.base);
  const auth = { Authorization: 'Basic ' + Buffer.from('me:pw').toString('base64') };
  const call = (m, u, body) => fetch(srv.base + u, { method: m, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const anon = (u) => fetch(srv.base + u).then(async (r) => ({ status: r.status, headers: r.headers, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
  try {
    const note = (await call('POST', '/api/shares', { path: 'Plan.md' })).data;
    assert.equal(note.kind, 'note');
    assert.match(note.url, /^https:\/\/notes\.example\.com\/s\/[\w-]{22}$/);
    assert.equal((await call('POST', '/api/shares', { path: 'Plan.md' })).data.token, note.token, 'sharing again gives the same link');
    const folder = (await call('POST', '/api/shares', { path: 'Trip' })).data;
    assert.equal(folder.kind, 'folder');

    // Anyone can read them, even with Basic auth on everything else.
    assert.equal((await anon('/api/tree')).status, 401);
    const page = await anon(`/s/${note.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(page.data, /share\.js/);
    const n = (await anon(`/api/public/${note.token}`)).data;
    assert.deepEqual([n.kind, n.name, n.content], ['note', 'Plan', '# Plan\n- [ ] Ship #task ^tabc1234\nSee [[Ideas]].\n']);
    const f = (await anon(`/api/public/${folder.token}`)).data;
    assert.deepEqual([f.kind, f.name, f.files], ['folder', 'Trip', ['Notes/Route.md', 'Packing.md']]);
    assert.equal((await anon(`/api/public/${folder.token}?path=Notes%2FRoute.md`)).data.content, 'North <script>alert(1)</script>\n');
    for (const bad of ['../Private.md', 'Notes/../../Private.md', '%2e%2e/Private.md', 'Private.md']) {
      assert.equal((await anon(`/api/public/${folder.token}?path=${encodeURIComponent(bad)}`)).status, 404, bad);
    }
    assert.equal((await anon('/api/public/nope')).status, 404);

    // Links follow renames and stop when the note goes to the trash or sharing stops.
    await call('POST', '/api/rename', { from: 'Trip', to: 'Travel' });
    assert.equal((await anon(`/api/public/${folder.token}`)).data.name, 'Travel');
    const list = (await call('GET', '/api/shares')).data.shares;
    assert.deepEqual(list.map((x) => x.path), ['Plan.md', 'Travel']);
    assert.equal(list[0].owner, undefined, 'owner is not exposed');
    await call('DELETE', '/api/file?path=Plan.md');
    assert.equal((await anon(`/api/public/${note.token}`)).status, 404);
    await call('DELETE', `/api/shares?token=${folder.token}`);
    assert.equal((await anon(`/api/public/${folder.token}`)).status, 404);
    assert.deepEqual((await call('GET', '/api/shares')).data.shares, []);
  } finally { await srv.stop(); }
});

test('note history: versions, differences and restore (git)', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_HISTORY_DELAY_MS: '100' });
  const c = client(srv.base);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await c.call('POST', '/api/file', { path: 'Diary.md', content: 'one\ntwo\nthree\n' });
    await wait(400);
    await c.call('PUT', '/api/file?path=Diary.md', { content: 'one\n2\nthree\nfour\n' });
    fs.mkdirSync(path.join(dir, 'vault', '.trash'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vault', '.trash', 'Old.md'), 'trashed');
    let h = (await c.call('GET', '/api/history?path=Diary.md')).data; // commits pending changes first
    assert.equal(h.available, true);
    assert.equal(h.versions.length, 2);
    const first = h.versions[1].hash;
    const v = (await c.call('GET', `/api/history/version?path=Diary.md&hash=${first}`)).data;
    assert.equal(v.content, 'one\ntwo\nthree\n');
    assert.deepEqual(v.diff.map((d) => d.type + d.line), [' one', '-two', '+2', ' three', '+four', ' ']);
    // History follows a rename.
    await c.call('POST', '/api/rename', { from: 'Diary.md', to: 'Journal/Diary 2026.md' });
    h = (await c.call('GET', '/api/history?path=Journal%2FDiary%202026.md')).data;
    assert.equal(h.versions.length, 3);
    assert.equal((await c.call('GET', `/api/history/version?path=Journal%2FDiary%202026.md&hash=${first}`)).data.content, 'one\ntwo\nthree\n');
    // Restore brings the old text back (and is itself a new version).
    const r = await c.call('POST', '/api/history/restore', { path: 'Journal/Diary 2026.md', hash: first });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'vault', 'Journal', 'Diary 2026.md'), 'utf8'), 'one\ntwo\nthree\n');
    assert.equal((await c.call('GET', '/api/history?path=Journal%2FDiary%202026.md')).data.versions.length, 4);
    // Only notes are kept: nothing from .trash, and the vault itself has no .git.
    const files = execFileSync('git', [`--git-dir=${path.join(dir, 'data', 'history.git')}`, 'ls-files'], { cwd: path.join(dir, 'vault') }).toString();
    assert.equal(files.trim(), 'Journal/Diary 2026.md');
    assert.equal(fs.existsSync(path.join(dir, 'vault', '.git')), false);
    assert.equal((await c.call('GET', `/api/history/version?path=Journal%2FDiary%202026.md&hash=nothex`)).status, 400);
  } finally { await srv.stop(); }
});

/** Read server-sent events until `want` matches one (or time runs out). */
function listenSSE(url) {
  const ctl = new AbortController();
  const events = [];
  const done = fetch(url, { signal: ctl.signal }).then(async (r) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null') });
      }
    }
  }).catch(() => {});
  const until = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 30)); } return null; };
  return { events, until, close: () => { ctl.abort(); return done; } };
}

test('live collaboration: presence, gated by sign-in or a public link, and live public pages', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_PUBLIC_URL: 'https://notes.example.com' });
  const c = client(srv.base);
  const listen = (url) => listenSSE(srv.base + url);
  try {
    await c.call('POST', '/api/file', { path: 'Shared.md', content: 'hello\n' });
    await c.call('POST', '/api/file', { path: 'Private.md', content: 'mine\n' });
    // Single-user mode: only notes with a public link are collaborative.
    assert.deepEqual((await c.call('POST', '/api/presence', { id: 'tab1', path: 'Private.md', line: 0 })).data, { allowed: false });
    const share = (await c.call('POST', '/api/shares', { path: 'Shared.md' })).data;
    const a = listen('/api/events?pid=tab1');
    assert.deepEqual((await c.call('POST', '/api/presence', { id: 'tab1', path: 'Shared.md', line: 3 })).data, { allowed: true });
    const p = await a.until((e) => e.ev === 'presence' && e.data.people.some((x) => x.id === 'tab1'));
    assert.equal(p.data.people.find((x) => x.id === 'tab1').line, 3);
    // A public visitor counts as a viewer, and their page hears about changes.
    const v = listen(`/api/public/${share.token}/events`);
    assert.ok(await a.until((e) => e.ev === 'presence' && e.data.publicViewers['Shared.md'] === 1), 'editors see the visitor');
    await c.call('PUT', '/api/file?path=Shared.md', { content: 'hello again\n' });
    assert.ok(await v.until((e) => e.ev === 'change'), 'the public page is told to reload');
    assert.equal((await fetch(`${srv.base}/api/public/nope/events`)).status, 404);
    await v.close();
    assert.ok(await a.until((e) => e.ev === 'presence' && !e.data.publicViewers['Shared.md']), 'visitor gone');
    // Closing the tab's stream drops its presence.
    const b = listen('/api/events?pid=tab2');
    await a.close();
    assert.ok(await b.until((e) => e.ev === 'presence' && !e.data.people.some((x) => x.id === 'tab1')));
    await b.close();
  } finally { await srv.stop(); }
});

test('trash: list, restore to where it was, delete forever', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  const { call } = client(srv.base);
  try {
    await call('POST', '/api/file', { path: 'Work/Plan.md', content: '# Plan\n' });
    await call('POST', '/api/file', { path: 'Old.md', content: 'x' });
    await call('DELETE', '/api/file?path=Work/Plan.md');
    await call('DELETE', '/api/file?path=Old.md');
    let list = (await call('GET', '/api/trash')).data;
    assert.deepEqual(list.map((t) => t.path).sort(), ['Old.md', 'Work/Plan.md']);
    const plan = list.find((t) => t.path === 'Work/Plan.md');
    await call('POST', '/api/file', { path: 'Work/Plan.md', content: 'a new one' });
    assert.equal((await call('POST', '/api/trash/restore', { name: plan.name })).data.path, 'Work/Plan 2.md', 'taken name: restored beside it');
    assert.equal((await call('GET', '/api/file?path=Work/Plan 2.md')).data.content, '# Plan\n');
    assert.equal((await call('POST', '/api/trash/restore', { name: '../data' })).status, 400, 'nothing outside .trash');
    assert.equal((await call('DELETE', '/api/trash?name=all')).data.deleted, 1);
    assert.deepEqual((await call('GET', '/api/trash')).data, []);
    assert.match((await call('GET', '/api/version')).data.build, /^[0-9a-f]{12}$/);
  } finally { await srv.stop(); }
});

test('public links can let people with the link edit the shared note, and only that', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_PUBLIC_URL: 'https://notes.example.com' });
  const { call } = client(srv.base);
  const anon = client(srv.base).call;
  try {
    await call('POST', '/api/file', { path: 'Shared.md', content: '# Shared\n- [ ] One\n' });
    const sh = (await call('POST', '/api/shares', { path: 'Shared.md' })).data;
    assert.equal(sh.edit, undefined);
    assert.equal((await anon('PUT', `/api/public/${sh.token}`, { content: 'hacked' })).status, 403, 'read-only by default');
    assert.equal((await call('PUT', '/api/shares', { token: sh.token, edit: true })).data.edit, true);
    assert.equal((await anon('GET', `/api/public/${sh.token}`)).data.edit, true);
    // Meanwhile the owner changes another line: the public edit merges with it.
    await call('PUT', '/api/file?path=Shared.md', { content: '# Shared\n- [ ] One\nOwner line\n' });
    const r = (await anon('PUT', `/api/public/${sh.token}`, { content: '# Shared\n- [x] One\n', baseContent: '# Shared\n- [ ] One\n' })).data;
    assert.equal(r.content, '# Shared\n- [x] One\nOwner line\n');
    assert.equal((await call('GET', '/api/file?path=Shared.md')).data.content, '# Shared\n- [x] One\nOwner line\n');
    await call('PUT', '/api/shares', { token: sh.token, edit: false });
    assert.equal((await anon('PUT', `/api/public/${sh.token}`, { content: 'x' })).status, 403, 'read-only again');
  } finally { await srv.stop(); }
});

test('About and sync history', async (t) => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  const c = client(srv.base);
  try {
    await t.test('About lists versions and what is available', async () => {
      const r = await c.call('GET', '/api/about');
      assert.equal(r.status, 200);
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      assert.equal(r.data.version, pkg.version);
      assert.match(r.data.build, /^[0-9a-f]{12}$/);
      assert.equal(r.data.mode, 'single');
      assert.equal(typeof r.data.notes, 'number');
    });
    await t.test('sync history is per account and unknown accounts are refused', async () => {
      assert.equal((await c.call('GET', '/api/sync/history?account=nope')).status, 404);
      const cfg = await c.call('PUT', '/api/config', { accounts: [{ name: 'Down', url: 'http://127.0.0.1:9/', username: 'u', password: 'p', calendarUrl: 'http://127.0.0.1:9/cal/', itemTags: 'task' }] });
      const id = cfg.data.accounts[0].id;
      await c.call('POST', '/api/sync', {});
      const h = await c.call('GET', `/api/sync/history?account=${id}`);
      assert.equal(h.status, 200);
      assert.ok(h.data.length >= 1);
      assert.equal(h.data[0].ok, false, 'an unreachable server is recorded as a failed sync');
      assert.ok(h.data[0].error);
    });
  } finally { await srv.stop(); }
});

test('live collaboration: people editing through an editable link show their caret, and see others', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_PUBLIC_URL: 'https://notes.example.com' });
  const { call } = client(srv.base);
  const anon = client(srv.base).call;
  try {
    await call('POST', '/api/file', { path: 'Shared.md', content: 'one\ntwo\n' });
    const sh = (await call('POST', '/api/shares', { path: 'Shared.md' })).data;
    assert.equal((await anon('POST', `/api/public/${sh.token}/presence`, { id: 'g1', line: 0, col: 0 })).status, 403, 'read-only links have no caret');
    await call('PUT', '/api/shares', { token: sh.token, edit: true });
    const app = listenSSE(srv.base + '/api/events?pid=tab1');
    const guest = listenSSE(`${srv.base}/api/public/${sh.token}/events?pid=g1`);
    await call('POST', '/api/presence', { id: 'tab1', path: 'Shared.md', line: 0, col: 2 });
    assert.equal((await anon('POST', `/api/public/${sh.token}/presence`, { id: 'g1', line: 1, col: 1 })).status, 200);
    const seen = await app.until((e) => e.ev === 'presence' && e.data.people.some((p) => p.id === 'g-g1' && p.line === 1));
    assert.ok(seen, 'the app sees the guest caret');
    assert.equal(seen.data.people.find((p) => p.id === 'g-g1').name, 'Guest');
    assert.ok(!seen.data.publicViewers['Shared.md'], 'an editing guest is not also counted as a viewer');
    const g = await guest.until((e) => e.ev === 'presence' && e.data.people.some((p) => p.id === 'tab1' && p.col === 2));
    assert.ok(g, 'the guest sees the app caret');
    assert.equal(g.data.publicViewers, undefined, 'nothing else of the instance');
    await guest.close();
    assert.ok(await app.until((e) => e.ev === 'presence' && !e.data.people.some((p) => p.id === 'g-g1')), 'guest gone with its page');
    await app.close();
  } finally { await srv.stop(); }
});

/** A raw request, for headers fetch won't let a test set (Host, Origin). */
function raw(base, method, url, { headers = {}, body } = {}) {
  const u = new URL(base + url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => { let data; try { data = JSON.parse(t); } catch { data = t; } resolve({ status: res.statusCode, data, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('forged requests: other sites cannot post forms or text, or send requests from their pages', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  try {
    const body = JSON.stringify({ name: 'evil', password: 'evilevil1' });
    // A form or "simple" request from another site: not JSON, so refused (and no admin is created).
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      assert.equal((await raw(srv.base, 'POST', '/api/setup/admin', { headers: { 'Content-Type': type }, body })).status, 415, type);
    }
    // JSON from another site's page carries its Origin.
    const cross = await raw(srv.base, 'POST', '/api/setup/admin', { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body });
    assert.equal(cross.status, 403);
    assert.equal((await raw(srv.base, 'PUT', '/api/file?path=A.md', { headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: '{"content":"x"}' })).status, 403);
    assert.equal((await client(srv.base).call('GET', '/api/auth/me')).data.mode, 'single', 'still single-user: nobody took over');
    // Its own page (same Origin as Host) works.
    const own = srv.base.replace('http://', '');
    assert.equal((await raw(srv.base, 'POST', '/api/file', { headers: { 'Content-Type': 'application/json', Origin: srv.base, Host: own }, body: '{"path":"A.md","content":"x"}' })).status, 200);
    // DNS rebinding: with no sign-in at all, a name it wasn't given is refused; addresses and local names work.
    assert.equal((await raw(srv.base, 'GET', '/api/tree', { headers: { Host: 'rebind.evil.example' } })).status, 421);
    for (const h of ['192.168.1.20:8087', 'notes.lan', 'nas', '[::1]:8087', 'box.tail1234.ts.net']) assert.equal((await raw(srv.base, 'GET', '/api/tree', { headers: { Host: h } })).status, 200, h);
    // The app page forbids scripts from anywhere else and framing.
    const page = await raw(srv.base, 'GET', '/');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  } finally { await srv.stop(); }
});

test('with several users, only admins can point CalDAV inside the network', async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  addUser(data, 'alex', 'alex password', '--admin');
  addUser(data, 'bob', 'bobs password');
  const srv = await startServer({ TICKMARK_DATA: data, TICKMARK_VAULT: path.join(dir, 'vault') });
  try {
    const bob = client(srv.base), alex = client(srv.base);
    await bob.call('POST', '/api/auth/login', { username: 'bob', password: 'bobs password' });
    await alex.call('POST', '/api/auth/login', { username: 'alex', password: 'alex password' });
    const b = await bob.call('POST', '/api/caldav/discover', { url: 'http://127.0.0.1:1/dav/' });
    assert.equal(b.status, 403);
    assert.match(b.data.error, /inside the network/);
    assert.equal((await bob.call('POST', '/api/caldav/calendars', { url: 'http://10.0.0.1/dav/', name: 'x' })).status, 403);
    const a = await alex.call('POST', '/api/caldav/discover', { url: 'http://127.0.0.1:1/dav/' });
    assert.equal(a.status, 502, 'an admin gets through (and here finds nothing listening)');
    for (const url of ['http://[::ffff:127.0.0.1]:1/dav/', 'http://[::ffff:7f00:1]:1/', 'http://[::127.0.0.1]:1/', 'http://[64:ff9b::7f00:1]:1/', 'http://[2002:7f00:1::]:1/']) {
      assert.equal((await bob.call('POST', '/api/caldav/discover', { url })).status, 403, url);
    }
  } finally { await srv.stop(); }
});

test("a saved CalDAV password is only sent to that account's own server", async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  const seen = [];
  const dav = http.createServer((req, res) => { seen.push(req.headers.authorization || ''); res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end(); });
  await new Promise((r) => dav.listen(0, '127.0.0.1', r));
  const { call } = client(srv.base);
  try {
    const home = `http://127.0.0.1:${dav.address().port}/dav/`;
    const cfg = (await call('PUT', '/api/config', { accounts: [{ url: home, username: 'alex', password: 'real secret', itemTags: 'task' }] })).data;
    const id = cfg.accounts[0].id;
    // Another server: refused before anything is sent.
    const r = await call('POST', '/api/caldav/discover', { accountId: id, url: `http://localhost:${dav.address().port}/elsewhere/` });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /enter the password/);
    assert.ok(!seen.some((a) => a.includes(Buffer.from('alex:real secret').toString('base64'))), 'the password never left');
    // Its own server (another path on it): the saved password is used.
    await call('POST', '/api/caldav/discover', { accountId: id, url: home + 'other/' });
    assert.ok(seen.includes('Basic ' + Buffer.from('alex:real secret').toString('base64')));
    // A password typed in goes wherever the user points it.
    assert.notEqual((await call('POST', '/api/caldav/discover', { accountId: id, url: `http://localhost:${dav.address().port}/x/`, password: 'typed' })).status, 400);
  } finally { await srv.stop(); dav.close(); }
});

test('removing a public link, or making it read-only, ends its open live pages', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_PUBLIC_URL: 'https://notes.example.com' });
  const { call } = client(srv.base);
  const ended = (url) => new Promise((resolve) => {
    fetch(srv.base + url).then(async (r) => { for await (const _ of r.body); resolve(true); }).catch(() => resolve(true));
  });
  try {
    await call('POST', '/api/file', { path: 'Shared.md', content: 'x\n' });
    const sh = (await call('POST', '/api/shares', { path: 'Shared.md' })).data;
    await call('PUT', '/api/shares', { token: sh.token, edit: true });
    // A guest caret needs the page's live stream open.
    assert.equal((await client(srv.base).call('POST', `/api/public/${sh.token}/presence`, { id: 'nobody', line: 0 })).status, 409);
    let done = ended(`/api/public/${sh.token}/events?pid=g1`);
    await new Promise((r) => setTimeout(r, 200));
    await call('PUT', '/api/shares', { token: sh.token, edit: false });
    assert.equal(await Promise.race([done, new Promise((r) => setTimeout(() => r(false), 2000))]), true, 'made read-only: stream ended');
    done = ended(`/api/public/${sh.token}/events`);
    await new Promise((r) => setTimeout(r, 200));
    await call('DELETE', `/api/shares?token=${sh.token}`);
    assert.equal(await Promise.race([done, new Promise((r) => setTimeout(() => r(false), 2000))]), true, 'removed: stream ended');
  } finally { await srv.stop(); }
});

test("admins see everyone's public links by user, and can stop any of them", async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  addUser(data, 'alex', 'alex password', '--admin');
  addUser(data, 'bob', 'bobs password');
  const srv = await startServer({ TICKMARK_DATA: data, TICKMARK_VAULT: path.join(dir, 'vault'), TICKMARK_PUBLIC_URL: 'https://notes.example.com' });
  try {
    const bob = client(srv.base), alex = client(srv.base);
    await bob.call('POST', '/api/auth/login', { username: 'bob', password: 'bobs password' });
    await alex.call('POST', '/api/auth/login', { username: 'alex', password: 'alex password' });
    await bob.call('POST', '/api/file', { path: 'Bob.md', content: 'b\n' });
    await alex.call('POST', '/api/file', { path: 'Alex.md', content: 'a\n' });
    const bs = (await bob.call('POST', '/api/shares', { path: 'Bob.md' })).data;
    await alex.call('POST', '/api/shares', { path: 'Alex.md' });
    assert.equal((await bob.call('GET', '/api/shares/all')).status, 403, 'not for regular users');
    assert.equal((await bob.call('DELETE', `/api/shares/all?token=${bs.token}`)).status, 403);
    const all = (await alex.call('GET', '/api/shares/all')).data;
    assert.deepEqual(all.users.map((g) => [g.owner, g.shares.map((s) => s.path)]), [['alex', ['Alex.md']], ['bob', ['Bob.md']]]);
    assert.match(all.users[1].shares[0].url, /^https:\/\/notes\.example\.com\/s\//);
    assert.equal(all.users[1].shares[0].owner, undefined, 'owner is the group, not repeated');
    assert.equal((await alex.call('DELETE', `/api/shares/all?token=${bs.token}`)).data.ok, true);
    assert.deepEqual((await bob.call('GET', '/api/shares')).data.shares, [], "bob's link is gone");
    assert.equal((await alex.call('GET', `/api/public/${bs.token}`)).status, 404);
  } finally { await srv.stop(); }
});

test('every checklist item across notes, with its state (for About)', async () => {
  const dir = tmp();
  const srv = await startServer({ TICKMARK_DATA: path.join(dir, 'data'), TICKMARK_VAULT: path.join(dir, 'vault') });
  const { call } = client(srv.base);
  try {
    await call('POST', '/api/file', { path: 'Work/Plan.md', content: '# Plan\n- [ ] Write #task 📅 2026-01-02\n- [/] Draft\n- [x] Done thing\n- [-] Dropped\nplain line\n' });
    await call('POST', '/api/file', { path: 'Home.md', content: '* [ ] Milk\n' });
    await call('POST', '/api/file', { path: 'Templates/Day.md', content: '- [ ] Template item\n' });
    const all = (await call('GET', '/api/tasks/all')).data;
    assert.deepEqual(all.map((t) => [t.path, t.line, t.state, t.title]), [
      ['Home.md', 0, 'todo', 'Milk'],
      ['Work/Plan.md', 1, 'todo', 'Write'], ['Work/Plan.md', 2, 'doing', 'Draft'],
      ['Work/Plan.md', 3, 'done', 'Done thing'], ['Work/Plan.md', 4, 'cancelled', 'Dropped'],
    ]);
    const w = all.find((t) => t.title === 'Write');
    assert.equal(w.due, '2026-01-02');
    assert.equal(w.synced, false, 'no CalDAV account, so nothing syncs');
  } finally { await srv.stop(); }
});
