import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SettingsCipher, isSealed } from './secrets.js';

// One CalDAV account = one server login + one task list + the tags that route items to it.
const ACCOUNT_DEFAULTS = {
  name: '', url: '', username: '', password: '', calendarUrl: '', calendarName: '',
  itemTags: ['task'], sectionTags: ['sync'], inboxFile: 'Inbox.md',
};

const DEFAULTS = {
  accounts: [],
  // Client-triggered sync runs on save/focus; this is an optional server-side timer (0 = off).
  serverSyncMinutes: 0,
  clientSyncMinutes: 5,
  // Checked items move under a "Complete" heading at the end of their section.
  moveCompleted: true,
  // Your own CSS, applied on top of the theme on every device you use.
  customCss: '',
  // Themes made in Settings → Appearance → Theme editor: [{ id, name, dark, colors: { bg, panel, … } }].
  customThemes: [],
};

export const THEME_COLORS = ['bg', 'panel', 'surface', 'line', 'text', 'muted', 'accent', 'accentSoft', 'danger', 'warn', 'mark', 'codeBg'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
/** Check and tidy the custom themes a client sent; anything odd is refused rather than stored. */
export function cleanThemes(list) {
  if (!Array.isArray(list)) throw bad('Themes must be a list');
  if (list.length > 30) throw bad('You can keep up to 30 themes');
  const ids = new Set();
  return list.map((t) => {
    const id = String(t?.id || '');
    if (!/^my-[a-z0-9]{4,16}$/.test(id) || ids.has(id)) throw bad('A theme has a bad id');
    ids.add(id);
    const name = String(t.name || '').trim().slice(0, 40) || 'My theme';
    const colors = {};
    for (const k of THEME_COLORS) {
      const c = String(t.colors?.[k] || '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(c)) throw bad(`“${name}” has a bad colour for ${k}`);
      colors[k] = c;
    }
    return { id, name, dark: t.dark === true, colors };
  });
}

const tagList = (v) => [...new Set((typeof v === 'string' ? v.split(/[,\s]+/) : v || [])
  .map((t) => String(t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean))];

const mdPath = (v, fallback) => {
  let p = String(v || fallback).replace(/^\/+/, '').trim() || fallback;
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  return p;
};

/** Older configs had a single `caldav` object with tags at the top level. */
function migrate(saved) {
  if (saved.accounts || !saved.caldav) return saved;
  const { caldav, itemTags, sectionTags, inboxFile, ...rest } = saved;
  const hasAccount = caldav.url || caldav.calendarUrl;
  return {
    ...rest,
    accounts: hasAccount ? [{
      id: 'a1', ...caldav, name: caldav.calendarName || 'CalDAV',
      itemTags: itemTags ?? ACCOUNT_DEFAULTS.itemTags, sectionTags: sectionTags ?? ACCOUNT_DEFAULTS.sectionTags,
      inboxFile: inboxFile || 'Inbox.md',
    }] : [],
  };
}

export class Config {
  /**
   * @param cipher  encrypts the CalDAV accounts at rest when enabled (see secrets.js)
   * @param owner   binds the encrypted blob to this user, so it can't be moved to another
   */
  constructor(dataDir, { cipher = new SettingsCipher(), owner = '' } = {}) {
    this.file = path.join(dataDir, 'config.json');
    this.cipher = cipher;
    this.aad = `tickmark:accounts:${owner}`;
    fs.mkdirSync(dataDir, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    let rewrite = false;
    if (isSealed(saved.accounts)) {
      const { value, stale } = cipher.open(saved.accounts, this.aad); // throws a clear error if it can't
      saved = { ...saved, accounts: value };
      rewrite = stale || !cipher.enabled; // re-encrypt with the new secret, or store plain again if SSO was turned off
    } else if (cipher.enabled && (saved.accounts?.length || saved.caldav)) {
      rewrite = true; // SSO was just turned on: encrypt what's there
    }
    const m = migrate(saved);
    this.data = { ...DEFAULTS, ...m, accounts: (m.accounts || []).map((a) => ({ ...ACCOUNT_DEFAULTS, ...a })) };
    if (m !== saved || rewrite) this.write();
  }

  get encrypted() { return this.cipher.enabled; }

  get() { return this.data; }

  /** Every tag that syncs somewhere (the index and the editor only need to know "synced or not"). */
  allTags() {
    const acc = this.data.accounts;
    return { itemTags: [...new Set(acc.flatMap((a) => a.itemTags))], sectionTags: [...new Set(acc.flatMap((a) => a.sectionTags))] };
  }

  account(id) { return this.data.accounts.find((a) => a.id === id) || null; }

  /** Config safe to send to the browser (no passwords). */
  public() {
    return {
      ...this.data,
      ...this.allTags(),
      encrypted: this.cipher.enabled,
      accounts: this.data.accounts.map(({ password, ...a }) => ({ ...a, hasPassword: !!password })),
    };
  }

  update(patch) {
    const next = { ...this.data };
    if (patch.accounts) {
      const prev = new Map(this.data.accounts.map((a) => [a.id, a]));
      const owner = new Map(); // tag → index of the account that has it, to reject a tag routed to two accounts
      const calendars = new Map(); // calendar URL → account name
      next.accounts = patch.accounts.map((p, i) => {
        const old = prev.get(p.id);
        // Only the first account gets the default tags and inbox; later ones would just clash with it.
        const defaults = i === 0 ? ACCOUNT_DEFAULTS : { ...ACCOUNT_DEFAULTS, itemTags: [], sectionTags: [], inboxFile: '' };
        const a = { ...defaults, ...(old || {}), ...p, id: old ? old.id : 'a' + crypto.randomBytes(4).toString('hex') };
        // An empty password field from the UI means "unchanged".
        if (!p.password) a.password = old?.password || '';
        for (const k of ['url', 'username', 'calendarUrl', 'calendarName']) a[k] = String(a[k] || '').trim();
        a.name = String(a.name || '').trim() || a.calendarName || `Account ${i + 1}`;
        a.itemTags = tagList(a.itemTags);
        a.sectionTags = tagList(a.sectionTags);
        if (!a.itemTags.length && !a.sectionTags.length) throw Object.assign(new Error(`“${a.name}” needs at least one tag, or nothing would sync to it`), { status: 400 });
        for (const t of [...a.itemTags, ...a.sectionTags]) {
          if (owner.has(t) && owner.get(t) !== i) {
            throw Object.assign(new Error(`#${t} is used by both “${patch.accounts[owner.get(t)].name || `Account ${owner.get(t) + 1}`}” and “${a.name}”. Each tag can go to one account.`), { status: 400 });
          }
          owner.set(t, i);
        }
        if (a.calendarUrl) {
          const key = a.calendarUrl.replace(/\/?$/, '/');
          if (calendars.has(key)) throw Object.assign(new Error(`“${calendars.get(key)}” and “${a.name}” sync the same task list. Pick a different list for one of them.`), { status: 400 });
          calendars.set(key, a.name);
        }
        a.inboxFile = mdPath(a.inboxFile, i === 0 ? 'Inbox.md' : `Inbox (${a.name}).md`);
        return a;
      });
      const inboxes = next.accounts.map((a) => a.inboxFile.toLowerCase());
      const dup = inboxes.find((x, i) => inboxes.indexOf(x) !== i);
      if (dup) throw Object.assign(new Error(`Two accounts use the same inbox note (${dup}). Give each its own.`), { status: 400 });
    }
    for (const k of ['serverSyncMinutes', 'clientSyncMinutes']) {
      if (patch[k] !== undefined) next[k] = Math.max(0, Number(patch[k]) || 0);
    }
    if (patch.customCss !== undefined) {
      const css = String(patch.customCss ?? '');
      if (css.length > 100_000) throw Object.assign(new Error('Custom CSS is limited to 100 KB'), { status: 400 });
      next.customCss = css;
    }
    if (patch.customThemes !== undefined) next.customThemes = cleanThemes(patch.customThemes);
    if (patch.moveCompleted !== undefined) next.moveCompleted = patch.moveCompleted === true || patch.moveCompleted === 'true';
    this.data = next;
    this.write();
    return this.data;
  }

  write() {
    const out = this.cipher.enabled ? { ...this.data, accounts: this.cipher.seal(this.data.accounts, this.aad) } : this.data;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
