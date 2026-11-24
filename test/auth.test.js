// CalDAV client auth: Digest (RFC 7616 vectors + live handshake) and Basic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { CalDAV, digestHeader, parseChallenges } from '../server/caldav.js';

const RFC = {
  username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1,
  cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
};
const rfcChallenge = (algorithm) => parseChallenges(
  `Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=${algorithm}, ` +
  'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"')[0];

test('RFC 7616 §3.9.1 digest vectors', () => {
  assert.match(digestHeader({ ...RFC, challenge: rfcChallenge('MD5') }), /response="8ca523f5e9506fed4657c9700eebdbec"/);
  assert.match(digestHeader({ ...RFC, challenge: rfcChallenge('SHA-256') }),
    /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
});

test('parses several joined challenges', () => {
  const c = parseChallenges('Basic realm="x", Digest realm="y, z", nonce=abc, qop="auth", Digest realm="y", nonce="n2", algorithm=SHA-256');
  assert.deepEqual(c.map((x) => x.scheme), ['basic', 'digest', 'digest']);
  assert.equal(c[1].params.realm, 'y, z');
  assert.equal(c[2].params.algorithm, 'SHA-256');
});

/** Minimal server: requires Digest (independent verifier), or Basic when mode === 'basic'. */
function server(mode) {
  let nonce = crypto.randomBytes(8).toString('hex');
  const seen = [];
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const s = http.createServer((req, res) => {
    const a = req.headers.authorization || '';
    seen.push(a.split(' ')[0] || 'none');
    let okAuth = false;
    if (mode === 'basic') okAuth = a === 'Basic ' + Buffer.from('alex:s3cret').toString('base64');
    else if (a.startsWith('Digest ')) {
      const p = Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      const ha1 = md5(`alex:tick:s3cret`), ha2 = md5(`${req.method}:${req.url}`);
      okAuth = p.nonce === nonce && p.uri === req.url &&
        p.response === md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    }
    if (!okAuth) {
      const stale = a.startsWith('Digest ') && a.includes('nonce="old"') ? ', stale=true' : '';
      res.writeHead(401, { 'WWW-Authenticate': mode === 'basic' ? 'Basic realm="tick"'
        : `Digest realm="tick", qop="auth", nonce="${nonce}", opaque="xyz"${stale}` });
      return res.end();
    }
    req.resume().on('end', () => { res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end('<d:multistatus xmlns:d="DAV:"/>'); });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}/cal/`, rotate: () => { nonce = crypto.randomBytes(8).toString('hex'); } })));
}

test('digest handshake, reuse, and nonce rotation', async () => {
  const srv = await server('digest');
  try {
    const c = new CalDAV({ url: srv.url, username: 'alex', password: 's3cret' });
    await c.propfind(srv.url, '<d:displayname/>');
    assert.deepEqual(srv.seen, ['Basic', 'Digest']); // Basic up front on loopback, then the challenge
    // A fresh client (as each sync makes) reuses the learned challenge: no extra 401.
    await new CalDAV({ url: srv.url, username: 'alex', password: 's3cret' }).propfind(srv.url, '<d:displayname/>');
    assert.deepEqual(srv.seen.slice(2), ['Digest']);
    srv.rotate(); // server expires the nonce → one 401, then success with the new one
    await c.propfind(srv.url, '<d:displayname/>');
    assert.deepEqual(srv.seen.slice(3), ['Digest', 'Digest']);
    await assert.rejects(new CalDAV({ url: srv.url, username: 'alex', password: 'wrong' }).propfind(srv.url, '<d:displayname/>'), { status: 401 });
  } finally { srv.s.close(); }
});

test('plain HTTP to another host waits for the challenge', () => {
  const c = new CalDAV({ url: 'http://dav.example.net/', username: 'alex', password: 's3cret' });
  assert.equal(c.authorization('PROPFIND', 'http://dav.example.net/cal/'), null);
  assert.match(new CalDAV({ url: 'https://dav.example.net/', username: 'alex', password: 'x' }).authorization('GET', 'https://dav.example.net/'), /^Basic /);
});

test('basic still works', async () => {
  const srv = await server('basic');
  try {
    await new CalDAV({ url: srv.url, username: 'alex', password: 's3cret' }).propfind(srv.url, '<d:displayname/>');
    assert.deepEqual(srv.seen, ['Basic']);
    await assert.rejects(new CalDAV({ url: srv.url, username: 'alex', password: 'nope' }).propfind(srv.url, '<d:displayname/>'), { status: 401 });
  } finally { srv.s.close(); }
});

test('private addresses: IPv4 written inside IPv6 is still private', async () => {
  const { isPrivateAddress } = await import('../server/caldav.js');
  const host = (u) => new URL(u).hostname.replace(/^\[|\]$/g, '');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.187.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1', '::ffff:c0a8:bb05', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:0101::1',
    host('http://[::ffff:127.0.0.1]/'), host('http://[::ffff:10.0.0.1]/'), 'nonsense']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '172.67.165.110', '2606:4700:3036::ac43:a56e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('guarded requests check the address when connecting (no DNS rebinding)', async () => {
  const { destinationPolicy } = await import('../server/caldav.js');
  const srv = http.createServer((req, res) => res.writeHead(207).end('<d:multistatus xmlns:d="DAV:"/>'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${srv.address().port}/dav/`;
  const saved = { ...destinationPolicy };
  try {
    // Pretend the up-front check was fooled (a name answering "public" first): the connection still refuses.
    destinationPolicy.check = null;
    destinationPolicy.guard = () => true;
    await assert.rejects(new CalDAV({ url, owner: 'bob' }).request('PROPFIND', url, { depth: 0 }), (e) => e.status === 403 && /inside the network/.test(e.message));
    // Unguarded (admins), and the guarded path's response handling, still work.
    destinationPolicy.guard = () => false;
    assert.equal((await new CalDAV({ url }).request('PROPFIND', url, { depth: 0 })).status, 207);
  } finally { Object.assign(destinationPolicy, saved); srv.close(); }
});
