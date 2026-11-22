// OpenID Connect sign-in (authorization code flow + PKCE), with no dependencies.
//
// Configured from the environment:
//   TICKMARK_OIDC_ISSUER          https://auth.example.com (or …/application/o/tickmark/ etc.)
//   TICKMARK_OIDC_CLIENT_ID
//   TICKMARK_OIDC_CLIENT_SECRET   omit for a public client (PKCE only)
//   TICKMARK_PUBLIC_URL           https://notes.example.com — the redirect URI is <this>/auth/oidc/callback
//   TICKMARK_OIDC_SCOPES          default "openid profile email" (add "groups" if your provider needs it)
//   TICKMARK_OIDC_USERNAME_CLAIM  default preferred_username (falls back to email, then sub)
//   TICKMARK_OIDC_GROUPS_CLAIM    default groups
//   TICKMARK_OIDC_ALLOWED_GROUPS  comma list; if set, only members may sign in
//   TICKMARK_OIDC_ADMIN_GROUPS    comma list; if set, admin rights follow membership on every sign-in
//   TICKMARK_OIDC_AUTO_CREATE     default true; false = only users an admin added (and linked) may sign in
//   TICKMARK_OIDC_MATCH_USERNAME  default false; true = first SSO sign-in links to an existing local user
//                                 of the same name (only safe if you control usernames at the provider)
//   TICKMARK_OIDC_LABEL           button text, default "Sign in with SSO"

import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const SKEW = 120; // seconds of clock skew tolerated
const ALGS = {
  RS256: ['sha256'], RS384: ['sha384'], RS512: ['sha512'],
  PS256: ['sha256', 'pss'], PS384: ['sha384', 'pss'], PS512: ['sha512', 'pss'],
  ES256: ['sha256', 'ec'], ES384: ['sha384', 'ec'], ES512: ['sha512', 'ec'],
  EdDSA: [null],
};

export class OIDCError extends Error {}

export class OIDC {
  constructor(env = process.env) {
    this.issuer = (env.TICKMARK_OIDC_ISSUER || '').trim();
    this.clientId = (env.TICKMARK_OIDC_CLIENT_ID || '').trim();
    this.clientSecret = env.TICKMARK_OIDC_CLIENT_SECRET || '';
    this.publicUrl = (env.TICKMARK_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    this.scopes = env.TICKMARK_OIDC_SCOPES || 'openid profile email';
    this.usernameClaim = env.TICKMARK_OIDC_USERNAME_CLAIM || 'preferred_username';
    this.groupsClaim = env.TICKMARK_OIDC_GROUPS_CLAIM || 'groups';
    this.allowedGroups = list(env.TICKMARK_OIDC_ALLOWED_GROUPS);
    this.adminGroups = list(env.TICKMARK_OIDC_ADMIN_GROUPS);
    this.autoCreate = !/^(0|false|no|off)$/i.test(env.TICKMARK_OIDC_AUTO_CREATE || 'true');
    this.matchUsername = /^(1|true|yes|on)$/i.test(env.TICKMARK_OIDC_MATCH_USERNAME || '');
    this.label = env.TICKMARK_OIDC_LABEL || 'Sign in with SSO';
    this.pending = new Map(); // state → { verifier, nonce, created }
    this.meta = null;
    this.keys = null;
  }

  get enabled() { return !!(this.issuer && this.clientId); }

  redirectUri(reqOrigin) { return `${this.publicUrl || reqOrigin}/auth/oidc/callback`; }

  async fetchJSON(url, opts = {}) {
    let r;
    try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); } catch (e) {
      throw new OIDCError(`Could not reach the sign-in provider (${new URL(url).host}): ${e.cause?.code || e.message}`);
    }
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new OIDCError(`${new URL(url).pathname} returned ${r.status} with no JSON`); }
    if (!r.ok) throw new OIDCError(`${new URL(url).pathname} → ${r.status}: ${data.error_description || data.error || text.slice(0, 200)}`);
    return data;
  }

  async discover() {
    if (this.meta && Date.now() - this.meta.at < 3600_000) return this.meta.doc;
    const base = this.issuer.replace(/\/+$/, '');
    const doc = await this.fetchJSON(`${base}/.well-known/openid-configuration`);
    if (doc.issuer?.replace(/\/+$/, '') !== base) throw new OIDCError(`Provider says its issuer is ${doc.issuer}, not ${this.issuer}`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!doc[k]) throw new OIDCError(`Provider metadata has no ${k}`);
    this.meta = { doc, at: Date.now() };
    return doc;
  }

  async jwks(force = false) {
    if (!force && this.keys && Date.now() - this.keys.at < 3600_000) return this.keys.list;
    const doc = await this.discover();
    const { keys = [] } = await this.fetchJSON(doc.jwks_uri);
    this.keys = { list: keys, at: Date.now() };
    return keys;
  }

  /** Start sign-in: returns the provider URL to redirect to, and the state to bind in a cookie. */
  async start(reqOrigin) {
    const doc = await this.discover();
    for (const [k, v] of this.pending) if (Date.now() - v.created > 600_000) this.pending.delete(k);
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    this.pending.set(state, { verifier, nonce, created: Date.now(), redirectUri: this.redirectUri(reqOrigin) });
    const u = new URL(doc.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri(reqOrigin), scope: this.scopes,
      state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    });
    return { url: u.href, state };
  }

  /** Finish sign-in from the callback. Returns the verified claims (ID token + userinfo). */
  async finish(params, cookieState) {
    if (params.get('error')) throw new OIDCError(params.get('error_description') || params.get('error'));
    const state = params.get('state');
    const p = state && this.pending.get(state);
    if (!p || state !== cookieState) throw new OIDCError('Sign-in expired or was started in another browser. Please try again.');
    this.pending.delete(state);
    const doc = await this.discover();

    const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code') || '', redirect_uri: p.redirectUri, code_verifier: p.verifier });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const methods = doc.token_endpoint_auth_methods_supported || ['client_secret_basic'];
    if (this.clientSecret && methods.includes('client_secret_basic')) {
      headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64');
    } else {
      body.set('client_id', this.clientId);
      if (this.clientSecret) body.set('client_secret', this.clientSecret);
    }
    const tok = await this.fetchJSON(doc.token_endpoint, { method: 'POST', headers, body });
    if (!tok.id_token) throw new OIDCError('Provider returned no ID token (is the "openid" scope allowed?)');
    const claims = await this.verifyIdToken(tok.id_token, p.nonce);

    // Groups and usernames are often only in userinfo.
    if (doc.userinfo_endpoint && tok.access_token && (!claims[this.groupsClaim] || !claims[this.usernameClaim])) {
      try {
        const info = await this.fetchJSON(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
        if (info.sub === claims.sub) for (const [k, v] of Object.entries(info)) if (claims[k] === undefined) claims[k] = v;
      } catch {}
    }
    return claims;
  }

  async verifyIdToken(jwt, nonce) {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OIDCError('Malformed ID token');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch { throw new OIDCError('Malformed ID token'); }
    const alg = ALGS[header.alg];
    if (!alg) throw new OIDCError(`ID token uses unsupported algorithm ${header.alg}`);

    const pick = (keys) => keys.filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
    let candidates = pick(await this.jwks());
    if (!candidates.length) candidates = pick(await this.jwks(true)); // provider rotated its keys
    if (!candidates.length) throw new OIDCError('No matching signing key from the provider');

    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const ok = candidates.some((jwk) => {
      try {
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const [hash, kind] = alg;
        const k = kind === 'pss' ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }
          : kind === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key;
        return crypto.verify(hash, data, k, sig);
      } catch { return false; }
    });
    if (!ok) throw new OIDCError('ID token signature is invalid');

    const now = Date.now() / 1000;
    const aud = [].concat(claims.aud || []);
    if (String(claims.iss).replace(/\/+$/, '') !== this.issuer.replace(/\/+$/, '')) throw new OIDCError('ID token is from a different issuer');
    if (!aud.includes(this.clientId)) throw new OIDCError('ID token is for a different client');
    if (aud.length > 1 && claims.azp && claims.azp !== this.clientId) throw new OIDCError('ID token is for a different client');
    if (!(claims.exp > now - SKEW)) throw new OIDCError('ID token has expired (check the server clock)');
    if (claims.iat && claims.iat > now + SKEW) throw new OIDCError('ID token is from the future (check the server clock)');
    if (claims.nonce !== nonce) throw new OIDCError('ID token nonce mismatch');
    if (!claims.sub) throw new OIDCError('ID token has no subject');
    return claims;
  }

  groups(claims) {
    const g = claims[this.groupsClaim];
    return Array.isArray(g) ? g.map(String) : typeof g === 'string' ? list(g) : [];
  }

  /** A Tickmark user name derived from the claims (sanitised; uniqueness is up to the caller). */
  username(claims) {
    const raw = claims[this.usernameClaim] || (claims.email ? String(claims.email).split('@')[0] : '') || claims.sub;
    const n = String(raw).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32);
    return n || 'user';
  }
}
