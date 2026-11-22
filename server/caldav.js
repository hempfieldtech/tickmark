// Small CalDAV client (RFC 4791) — discovery, VTODO listing, conditional PUT/DELETE.
// Auth: answers the server's 401 challenge with Digest (RFC 7616, MD5/SHA-256, -sess) or Basic.

import crypto from 'node:crypto';

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
  if (e === 'lt') return '<';
  if (e === 'gt') return '>';
  if (e === 'amp') return '&';
  if (e === 'quot') return '"';
  if (e === 'apos') return "'";
  return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const local = (n) => n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;

export function parseXML(str) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<\s*([^\s>/]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of str.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      for (const a of (m[4] || '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decode(a[2] ?? a[3]);
      const node = { name: local(m[3]).toLowerCase(), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root;
}

const find = (n, name) => {
  for (const c of n.children) {
    if (c.name === name) return c;
    const r = find(c, name);
    if (r) return r;
  }
  return null;
};
const findAll = (n, name, out = []) => {
  for (const c of n.children) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
};
const text = (n) => (n ? (n.text + n.children.map(text).join('')).trim() : '');

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

/** Parse a WWW-Authenticate value (possibly several challenges joined by commas). */
export function parseChallenges(header) {
  const out = [];
  const re = /\s*,?\s*([!#$%&'*+.^_`|~\w-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*))?/g;
  let m;
  while ((m = re.exec(header || '')) && m[0]) {
    if (m[2] === undefined) out.push({ scheme: m[1].toLowerCase(), params: {} });
    else if (out.length) {
      const v = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2];
      out.at(-1).params[m[1].toLowerCase()] = v;
    }
  }
  return out;
}

const DIGEST_ALGS = { 'MD5': 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256' };

/** Build a Digest Authorization header value for one request. */
export function digestHeader({ username, password, method, uri, challenge, nc, cnonce }) {
  const p = challenge.params;
  const algorithm = (p.algorithm || 'MD5').toUpperCase();
  const H = (s) => crypto.createHash(DIGEST_ALGS[algorithm]).update(s).digest('hex');
  const qop = p.qop ? (p.qop.split(/\s*,\s*/).includes('auth') ? 'auth' : null) : undefined;
  if (qop === null) throw new CalDAVError('Server requires Digest qop=auth-int, which is not supported', 401);
  let ha1 = H(`${username}:${p.realm ?? ''}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const ncs = nc.toString(16).padStart(8, '0');
  const response = qop ? H(`${ha1}:${p.nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
  const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
  const parts = [`username=${q(username)}`, `realm=${q(p.realm ?? '')}`, `nonce=${q(p.nonce)}`, `uri=${q(uri)}`,
    `algorithm=${p.algorithm || 'MD5'}`, `response=${q(response)}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncs}`, `cnonce=${q(cnonce)}`);
  if (p.opaque !== undefined) parts.push(`opaque=${q(p.opaque)}`);
  return 'Digest ' + parts.join(', ');
}

// What each server asked for last time, so later clients (one per sync) skip the extra 401 round trip.
// Key: origin + username. Value: { scheme: 'basic' } or { scheme: 'digest', challenge, nc }.
const learned = new Map();

export class CalDAVError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export class CalDAV {
  constructor({ url, username, password }) {
    this.url = url;
    this.username = username || '';
    this.password = password || '';
  }

  authKey(url) { return `${new URL(url).origin}|${this.username}`; }

  authorization(method, url) {
    if (!this.username) return null;
    let a = learned.get(this.authKey(url));
    if (!a) {
      // Until the server says which scheme it wants, send Basic only where the password can't be
      // sniffed (HTTPS or this machine). Servers that answer anonymous requests with 403/404
      // instead of a 401 challenge need credentials up front.
      const u = new URL(url);
      const safe = u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (!safe) return null;
      a = { scheme: 'basic' };
    }
    if (a.scheme === 'basic') return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const u = new URL(url);
    return digestHeader({ username: this.username, password: this.password, method, uri: u.pathname + u.search,
      challenge: a.challenge, nc: ++a.nc, cnonce: crypto.randomBytes(16).toString('hex') });
  }

  /** On a 401, remember the server's preferred scheme. Returns true if retrying could help. */
  learn(res, url, sent) {
    if (!this.username) return false;
    const all = parseChallenges(res.headers.get('www-authenticate'));
    const digests = all.filter((c) => c.scheme === 'digest' && c.params.nonce && DIGEST_ALGS[(c.params.algorithm || 'MD5').toUpperCase()]);
    const digest = digests.find((c) => /^sha-256/i.test(c.params.algorithm || '')) || digests[0];
    const key = this.authKey(url);
    if (digest) {
      // A rejected digest is worth a retry only if the nonce went stale (flagged, or simply replaced).
      const prev = learned.get(key);
      if (sent?.startsWith('Digest') && !/^true$/i.test(digest.params.stale || '') &&
        prev?.challenge?.params.nonce === digest.params.nonce) return false;
      learned.set(key, { scheme: 'digest', challenge: digest, nc: 0 });
      return true;
    }
    if (all.some((c) => c.scheme === 'basic') && !sent?.startsWith('Basic')) {
      learned.set(key, { scheme: 'basic' });
      return true;
    }
    return false;
  }

  async request(method, url, { body, depth, headers = {}, ok = [200, 201, 204, 207] } = {}) {
    let res, txt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = { ...headers };
      const auth = this.authorization(method, url);
      if (auth) h.Authorization = auth;
      if (depth !== undefined) h.Depth = String(depth);
      if (body && !h['Content-Type']) h['Content-Type'] = 'application/xml; charset=utf-8';
      try {
        res = await fetch(url, { method, headers: h, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      } catch (e) {
        throw new CalDAVError(`Could not reach ${new URL(url).host}: ${e.cause?.code || e.message}`, 0);
      }
      txt = await res.text();
      if (res.status !== 401 || !this.learn(res, url, auth)) break;
    }
    if (!ok.includes(res.status)) {
      const hint = res.status === 401 ? ' (check username/password)' : res.status === 412 ? ' (changed on the server)' : '';
      throw new CalDAVError(`${method} ${new URL(url).pathname} → ${res.status} ${res.statusText}${hint}`, res.status);
    }
    return { status: res.status, headers: res.headers, text: txt, url: res.url || url };
  }

  async propfind(url, props, depth = 0) {
    const r = await this.request('PROPFIND', url, {
      depth,
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`,
    });
    return this.responses(r.text, r.url);
  }

  /** Parse a multistatus body into [{ href, url, props: <prop node> }] (only 200 propstats). */
  responses(xml, base) {
    const doc = parseXML(xml);
    return findAll(doc, 'response').map((r) => {
      const href = text(find(r, 'href'));
      const props = { name: 'prop', children: [], text: '' };
      for (const ps of findAll(r, 'propstat')) {
        const st = text(find(ps, 'status'));
        if (st && !/\s2\d\d\s/.test(st + ' ')) continue;
        const p = find(ps, 'prop');
        if (p) props.children.push(...p.children);
      }
      return { href, url: new URL(href, base).href, props };
    });
  }

  /** Find calendars that can hold todos, starting from any URL (server root, principal, home or calendar). */
  async discover() {
    const { home, calendar } = await this.findHome();
    if (calendar) return [calendar];
    const list = await this.propfind(home,
      '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><ic:calendar-color/>', 1);
    return list.map((r) => this.describe(r)).filter(Boolean);
  }

  /**
   * Make a new task list (a calendar for VTODOs) in the user's calendar home. Returns { url, name }.
   * If the account URL points straight at a calendar, the new one goes next to it.
   */
  async createCalendar(name) {
    name = String(name || '').trim();
    if (!name) throw new CalDAVError('Give the new task list a name', 400);
    const { home, calendar } = await this.findHome();
    const parent = calendar ? new URL('..', calendar.url.replace(/\/?$/, '/')).href : home.replace(/\/?$/, '/');
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tasks';
    const url = new URL(`${slug}-${crypto.randomUUID().slice(0, 8)}/`, parent).href;
    const xml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
    await this.request('MKCALENDAR', url, {
      body: '<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
        `<d:displayname>${xml(name)}</d:displayname>` +
        '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
    });
    return { url, name };
  }

  /** The user's calendar home URL, or (when the account URL is itself a calendar) that calendar. */
  async findHome() {
    const start = this.url;
    const first = await this.propfind(start,
      '<d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/>').catch(async (e) => {
      if (e.status === 404 || e.status === 405) {
        const wk = new URL('/.well-known/caldav', start).href;
        return this.propfind(wk, '<d:resourcetype/><d:current-user-principal/><c:calendar-home-set/>');
      }
      throw e;
    });
    const me = first[0];
    if (me && find(find(me.props, 'resourcetype') || { children: [] }, 'calendar')) {
      const calendar = this.describe(me);
      if (calendar) return { calendar };
    }
    let home = me && text(find(find(me.props, 'calendar-home-set') || { children: [] }, 'href'));
    if (!home) {
      let principal = me && text(find(find(me.props, 'current-user-principal') || { children: [] }, 'href'));
      if (!principal) {
        const wk = await this.propfind(new URL('/.well-known/caldav', start).href, '<d:current-user-principal/>').catch(() => []);
        principal = wk[0] && text(find(wk[0].props, 'href'));
      }
      if (!principal) throw new CalDAVError('Could not find a CalDAV principal at that URL', 0);
      const pr = await this.propfind(new URL(principal, start).href, '<c:calendar-home-set/>');
      home = pr[0] && text(find(pr[0].props, 'href'));
      if (!home) throw new CalDAVError('Server did not report a calendar-home-set', 0);
    }
    return { home: new URL(home, start).href };
  }

  describe(r) {
    const rt = find(r.props, 'resourcetype');
    if (!rt || !find(rt, 'calendar')) return null;
    const set = find(r.props, 'supported-calendar-component-set');
    const comps = set ? findAll(set, 'comp').map((c) => (c.attrs.name || '').toUpperCase()) : [];
    const todos = comps.length === 0 || comps.includes('VTODO');
    if (!todos) return null;
    return {
      url: r.url,
      name: text(find(r.props, 'displayname')) || decodeURIComponent(r.url.replace(/\/$/, '').split('/').pop()),
      color: text(find(r.props, 'calendar-color')) || null,
      components: comps,
    };
  }

  /** All VTODOs in a calendar: [{ href, url, etag, ics }] */
  async listTodos(calUrl) {
    const r = await this.request('REPORT', calUrl, {
      depth: 1,
      body: `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
        '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>',
    });
    return this.responses(r.text, r.url)
      .map((x) => ({ href: x.href, url: x.url, etag: text(find(x.props, 'getetag')), ics: text(find(x.props, 'calendar-data')) }))
      .filter((x) => x.ics);
  }

  async put(url, ics, { etag, create } = {}) {
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (create) headers['If-None-Match'] = '*';
    else if (etag) headers['If-Match'] = etag;
    const r = await this.request('PUT', url, { body: ics, headers, ok: [200, 201, 204] });
    return { etag: r.headers.get('etag') || null };
  }

  async delete(url, etag) {
    const headers = etag ? { 'If-Match': etag } : {};
    await this.request('DELETE', url, { headers, ok: [200, 204, 404] });
  }
}
