// Version history of a vault's notes, kept with git: a repository in the data folder (history.git)
// whose work tree is the vault, so a vault that is itself a git repo is never touched. Changes are
// committed a little while after they stop (and before history is read). Needs the git binary; without
// it, history just reports itself unavailable.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const QUIET_MS = Number(process.env.TICKMARK_HISTORY_DELAY_MS) || 30_000;

export class History {
  constructor({ dataDir, vaultDir, log = () => {} }) {
    this.gitDir = path.join(dataDir, 'history.git');
    this.vaultDir = vaultDir;
    this.log = log;
    this.timer = null;
    this.queue = Promise.resolve();
    this.ready = null;
  }

  git(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const p = execFile('git', ['-c', 'core.quotepath=off', `--git-dir=${this.gitDir}`, `--work-tree=${this.vaultDir}`, ...args],
        { maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
        (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
      if (input != null) p.stdin.end(input);
    });
  }

  /** Set up the repository on first use. Resolves false when git isn't installed. */
  init() {
    this.ready ??= (async () => {
      try { await new Promise((ok, no) => execFile('git', ['--version'], (e) => (e ? no(e) : ok()))); } catch { return false; }
      if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
        fs.mkdirSync(this.gitDir, { recursive: true });
        await this.git(['init', '--quiet']);
        await this.git(['config', 'user.name', 'Tickmark']);
        await this.git(['config', 'user.email', 'tickmark@localhost']);
        await this.git(['config', 'core.autocrlf', 'false']);
        // Only notes: no dotfiles (.trash, editor temp files), nothing but .md.
        fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
        fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), '*\n!*/\n!*.md\n.*\n');
      }
      return true;
    })();
    return this.ready;
  }

  /** Something in the vault changed: commit it once things have been quiet for a while. */
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.commit().catch((e) => this.log('History commit failed:', e.message)), QUIET_MS);
    this.timer.unref?.();
  }

  /** Commit whatever changed (serialised, so two commits never race). */
  commit() {
    clearTimeout(this.timer);
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!(await this.init())) return false;
      await this.git(['add', '-A', '--', '.']);
      const staged = await this.git(['diff', '--cached', '--name-only']);
      if (!staged.trim()) return false;
      const files = staged.trim().split('\n');
      const msg = files.length === 1 ? files[0] : `${files.length} notes`;
      await this.git(['commit', '--quiet', '--no-verify', '-m', msg]);
      return true;
    });
    return this.queue;
  }

  /** Versions of a note, newest first: [{ hash, date, subject }]. Follows renames. */
  async versions(rel, limit = 100) {
    if (!(await this.init())) return null;
    await this.commit();
    let out = '';
    try { out = await this.git(['log', '--follow', `-n${limit}`, '--format=%H%x09%aI%x09%s', '--', rel]); } catch { return []; }
    return out.trim().split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\t'); return { hash, date, subject }; });
  }

  /** A note as it was at a version (looked up under the name it had then). */
  async contentAt(rel, hash) {
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw Object.assign(new Error('Unknown version'), { status: 400 });
    // The note may have had another name in that version: find it via the rename history.
    const log = await this.git(['log', '--follow', '--name-only', '--format=%H', '--', rel]);
    let name = rel, current = null;
    for (const line of log.split('\n')) {
      if (/^[0-9a-f]{40}$/.test(line)) current = line;
      else if (line.trim() && current === hash) { name = line.trim(); break; }
    }
    try { return await this.git(['show', `${hash}:${name}`]); }
    catch { throw Object.assign(new Error('That version of the note could not be found'), { status: 404 }); }
  }

  close() { clearTimeout(this.timer); }
}

/**
 * A line diff between two texts (Myers-style LCS on lines), as [{ type: ' ' | '-' | '+', line }],
 * trimmed to the changes with `context` unchanged lines around each.
 */
export function lineDiff(a, b, context = 3) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  // LCS table on lines; notes are small enough for O(n·m), but cap it to stay safe.
  if (n * m > 4e6) return [{ type: '-', line: '(too large to compare line by line)' }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const all = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { all.push({ type: ' ', line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) all.push({ type: '-', line: A[i++] });
    else all.push({ type: '+', line: B[j++] });
  }
  while (i < n) all.push({ type: '-', line: A[i++] });
  while (j < m) all.push({ type: '+', line: B[j++] });
  const keep = new Set();
  all.forEach((d, k) => { if (d.type !== ' ') for (let c = k - context; c <= k + context; c++) keep.add(c); });
  const out = [];
  all.forEach((d, k) => {
    if (keep.has(k)) out.push(d);
    else if (out.length && out.at(-1).type !== '…') out.push({ type: '…', line: '' });
  });
  if (out.at(-1)?.type === '…') out.pop();
  return out;
}
