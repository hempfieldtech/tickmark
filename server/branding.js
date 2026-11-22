// Server-wide branding (Settings → Branding): the app's name, a logo, and a favicon. Stored in
// <data>/branding.json with the images beside it in <data>/branding/. The defaults are Tickmark's own.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_NAME = 'Tickmark';
const DEFAULT_ICON = '/icons/icon.svg';
const MAX_IMAGE = 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
const IMAGES = ['logo', 'favicon'];

export class BrandingError extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Branding {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'branding.json');
    this.dir = path.join(dataDir, 'branding');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  get name() { return this.data.name || DEFAULT_NAME; }

  /** What the browser needs: the name and image URLs (defaults when nothing is set). */
  public() {
    const url = (k) => (this.data[k] ? `/branding/${k}?v=${this.data[k].v}` : null);
    const logo = url('logo');
    return {
      name: this.name,
      customName: !!this.data.name,
      logo: logo || DEFAULT_ICON,
      favicon: url('favicon') || logo || DEFAULT_ICON,
      hasLogo: !!logo,
      hasFavicon: !!this.data.favicon,
    };
  }

  /**
   * @param patch { name?, logo?, favicon? }: name '' resets it; an image is a data: URL, or null to remove it.
   */
  update(patch) {
    const next = { ...this.data };
    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').replace(/\s+/g, ' ').trim();
      if (name.length > 40) throw new BrandingError('Keep the name to 40 characters or fewer');
      if (name && name !== DEFAULT_NAME) next.name = name; else delete next.name;
    }
    const writes = [];
    for (const k of IMAGES) {
      if (patch[k] === undefined) continue;
      if (patch[k] === null || patch[k] === '') { delete next[k]; continue; }
      const m = String(patch[k]).match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
      const ext = m && TYPES[m[1].toLowerCase()];
      if (!ext) throw new BrandingError('Images must be PNG, SVG, JPEG, WebP, GIF or ICO');
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw new BrandingError('That image is empty');
      if (buf.length > MAX_IMAGE) throw new BrandingError('Images must be 1 MB or smaller');
      next[k] = { type: m[1].toLowerCase(), ext, v: Date.now().toString(36) };
      writes.push([k, ext, buf]);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    for (const [k, ext, buf] of writes) fs.writeFileSync(path.join(this.dir, `${k}.${ext}`), buf);
    // Drop image files that are no longer used.
    for (const f of fs.readdirSync(this.dir)) {
      const [k, ext] = f.split('.');
      if (IMAGES.includes(k) && next[k]?.ext !== ext) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    this.data = next;
    return this.public();
  }

  /** Serve /branding/logo or /branding/favicon. Returns false if there's no such image. */
  serve(kind, res) {
    const img = IMAGES.includes(kind) && this.data[kind];
    if (!img) return false;
    let buf;
    try { buf = fs.readFileSync(path.join(this.dir, `${kind}.${img.ext}`)); } catch { return false; }
    res.writeHead(200, {
      'Content-Type': img.type,
      'Cache-Control': 'public, max-age=31536000, immutable', // the URL changes (?v=) with the image
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened on its own must not run scripts on this origin.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    });
    res.end(buf);
    return true;
  }

  /** The app shell with the name and icons filled in, so there's no flash of the defaults. */
  html(src) {
    const b = this.public();
    if (!b.customName && !b.hasLogo && !b.hasFavicon) return src;
    const favType = this.data.favicon?.type || this.data.logo?.type || 'image/svg+xml';
    return src
      .replace('<title>Tickmark</title>', `<title>${esc(b.name)}</title>`)
      // The default PNG icon goes: browsers would otherwise prefer it over a custom favicon.
      .replace(/\s*<link rel="icon" href="\/icons\/icon-192\.png"[^>]*>/, '')
      .replace(/<link rel="icon" href="[^"]*" type="[^"]*">/, `<link rel="icon" href="${esc(b.favicon)}" type="${esc(favType)}">`)
      .replace(/<link rel="apple-touch-icon" href="[^"]*">/, `<link rel="apple-touch-icon" href="${esc(b.hasLogo ? b.logo : '/icons/icon-192.png')}">`)
      .replace(/<span class="brand"><img src="[^"]*"/g, `<span class="brand"><img src="${esc(b.logo)}"`)
      .replaceAll('<span class="brand-name">Tickmark</span>', `<span class="brand-name">${esc(b.name)}</span>`);
  }

  /** The web app manifest with the name and logo. */
  manifest(src) {
    const b = this.public();
    if (!b.customName && !b.hasLogo) return src;
    const m = JSON.parse(src);
    m.name = m.short_name = b.name;
    if (b.hasLogo) {
      const type = this.data.logo.type;
      m.icons = [{ src: b.logo, sizes: type === 'image/svg+xml' ? 'any' : '512x512', type, purpose: 'any' }];
    }
    return JSON.stringify(m, null, 2);
  }
}
