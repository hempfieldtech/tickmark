// Bi-directional sync between tagged checklist items and CalDAV VTODOs.
//
// Each synced line carries a block id (^t1a2b3c4). sync_state remembers, per block id, the
// remote UID/href and the "base" model as of the last successful sync, which enables a
// field-level three-way merge:
//   field changed only locally  → push       field changed only remotely → pull
//   changed on both sides       → local wins
// Deletions propagate both ways, but only when the other side is unchanged since the last
// sync (otherwise the surviving side is recreated so nothing is lost).
//
// Several CalDAV accounts can be configured. Each synced item belongs to exactly one, chosen by
// accountFor(); sync state is kept per account, so retagging an item moves it between accounts.

import { parseTasks, taskModel, modelsEqual, buildTaskLine, newBlockId, localDate, normTag, advanceRecurring, insertInSection, fileCompleted, appendLines, openSubtasks, endCancelledSeries } from '../public/shared/tasks.js';
import { buildTodo, parseICS, findTodo, todoModel, occurrenceCompleted } from './ical.js';
import { CalDAV } from './caldav.js';
import { fingerprint } from './secrets.js';

const FIELDS = ['title', 'done', 'status', 'due', 'priority', 'recur'];
const norm = (k, v) => (k === 'priority' ? v || 0 : k === 'due' || k === 'recur' || k === 'status' ? v || null : v);

function merge(L, R, B) {
  if (!B) return { ...L };
  const out = {};
  for (const k of FIELDS) {
    const lc = norm(k, L[k]) !== norm(k, B[k]);
    const rc = norm(k, R[k]) !== norm(k, B[k]);
    out[k] = lc ? L[k] : rc ? R[k] : L[k];
  }
  return out;
}

const BID_TAIL = /\s+\^[A-Za-z0-9-]+\s*$/;

/** Which account an item syncs to: an item tag wins over a section tag; earlier accounts win ties. */
export function accountFor(task, accounts) {
  for (const tag of task.syncTags || []) {
    const a = accounts.find((x) => x.itemTags.includes(normTag(tag)));
    if (a) return a;
  }
  for (const tag of task.scopeTags || []) {
    const a = accounts.find((x) => x.sectionTags.includes(tag));
    if (a) return a;
  }
  return null;
}

export const TEMPLATES = 'Templates';
export const isTemplate = (p) => p.toLowerCase().startsWith(TEMPLATES.toLowerCase() + '/');

/** Heading for restored tasks whose own heading no longer exists. */
const RESTORED = 'Restored tasks';
const emptyResult = () => ({ pushed: 0, pulled: 0, created: 0, imported: 0, deletedRemote: 0, deletedLocal: 0, trashed: 0, errors: [], importedNotes: [], log: [] });
/** Sync history: how many runs each account keeps, and how many items one run records. */
export const HISTORY_RUNS = 30;
const HISTORY_ITEMS = 200;
const SHOWN = { title: 'title', done: 'done', status: 'status', due: 'due', priority: 'priority', recur: 'repeats' };
/** What differs between two task models, for the sync history: [{ field, from, to }]. */
function changes(from, to) {
  if (!from) return [];
  return FIELDS.filter((k) => norm(k, from[k]) !== norm(k, to[k])).map((k) => ({ field: SHOWN[k], from: norm(k, from[k]), to: norm(k, to[k]) }));
}
const COUNTS = ['pushed', 'pulled', 'created', 'imported', 'deletedRemote', 'deletedLocal', 'trashed'];

export class SyncEngine {
  constructor({ vault, index, getConfig, onStatus = () => {}, log = console.log, owner = null }) {
    Object.assign(this, { vault, index, getConfig, onStatus, log, owner });
    this.status = { state: 'idle', lastRun: null, lastError: null, lastResult: null, needsForce: false };
    this.running = null;
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.onStatus({ ...this.status });
  }

  run(opts = {}) {
    if (this.running) {
      // The sync under way read the notes before whatever prompted this call (a save, Vim's :w…), so
      // run once more when it ends. Every call that arrives meanwhile shares that one follow-up.
      this.nextForce ||= !!opts.force;
      this.next ||= this.running.catch(() => {}).then(() => {
        const force = this.nextForce;
        this.next = null; this.nextForce = false;
        return this.run({ ...opts, force });
      });
      return this.next;
    }
    this.running = this._run(opts)
      .then((r) => {
        const failed = r.accounts.filter((a) => a.error);
        if (failed.length) {
          const e = new Error(failed.map((a) => (r.accounts.length > 1 ? `${a.name}: ${a.error}` : a.error)).join('\n'));
          e.needsForce = failed.some((a) => a.needsForce);
          e.status = e.needsForce ? 409 : 502;
          e.result = r;
          throw e;
        }
        this.setStatus({ state: 'idle', lastRun: new Date().toISOString(), lastError: null, lastResult: r, needsForce: false });
        return r;
      })
      .catch((e) => {
        this.setStatus({ state: 'error', lastRun: new Date().toISOString(), lastError: e.message, needsForce: !!e.needsForce,
          ...(e.result ? { lastResult: e.result } : {}) });
        throw e;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async _run({ force = false } = {}) {
    const cfg = this.getConfig();
    const accounts = (cfg.accounts || []).filter((a) => a.url && a.calendarUrl);
    if (!accounts.length) throw Object.assign(new Error('CalDAV is not configured (Settings → CalDAV accounts)'), { status: 400 });
    this.setStatus({ state: 'syncing' });
    const tagOpts = {
      itemTags: [...new Set(accounts.flatMap((a) => a.itemTags))],
      sectionTags: [...new Set(accounts.flatMap((a) => a.sectionTags))],
    };
    this.index.pruneAccounts(cfg.accounts.map((a) => a.id));

    // ---- 1. Local: make sure the index is current, move completed recurring items on to their next
    //         date, then give every synced item a unique block id.
    this.index.scan(this.vault);
    // Notes in the Templates folder are blueprints: their checklist items never sync.
    const paths = this.index.pathsWithSyncedTasks().filter((p) => !isTemplate(p) && this.vault.exists(p)).sort();
    const seen = new Set();
    const today = localDate(new Date());
    for (const p of paths) {
      this.vault.modify(p, (text) => {
        let lines = text.split('\n');
        let changed = false;
        // Bottom-up, because each one inserts a history line below itself.
        for (const t of parseTasks(text, tagOpts).reverse()) {
          if (!t.synced || !t.done || !t.recur || t.status === 'cancelled') continue; // cancelled ends the series
          const a = advanceRecurring(t, { today });
          if (!a) continue; // series over: it stays completed
          lines.splice(t.line, 1, a.openLine, a.historyLine);
          changed = true;
        }
        for (const t of parseTasks(lines.join('\n'), tagOpts)) {
          if (!t.synced) { if (t.blockId) seen.add(t.blockId); continue; }
          // Already done before it ever synced (including recurring history lines): keep it local.
          if (t.done && !t.blockId) continue;
          if (t.blockId && !seen.has(t.blockId)) { seen.add(t.blockId); continue; }
          let id;
          do id = newBlockId(); while (seen.has(id));
          seen.add(id);
          lines[t.line] = lines[t.line].replace(BID_TAIL, '').replace(/\s+$/, '') + ' ^' + id;
          changed = true;
        }
        return changed ? lines.join('\n') : null;
      });
    }
    const local = new Map(accounts.map((a) => [a.id, new Map()])); // account → blockId → { path, task, model }
    const claimed = new Set();
    for (const p of paths) {
      const { content } = this.vault.read(p);
      for (const t of parseTasks(content, tagOpts)) {
        if (!t.synced || !t.blockId || claimed.has(t.blockId)) continue;
        const a = accountFor(t, accounts);
        if (!a) continue;
        claimed.add(t.blockId);
        local.get(a.id).set(t.blockId, { path: p, task: t, model: taskModel(t), openSubtasks: openSubtasks(content, t.line) });
      }
    }

    // ---- 2-8 per account. One account failing (offline server, bad password) doesn't stop the others.
    const { log: _, ...blank } = emptyResult();
    const total = { ...blank, accounts: [] };
    for (const a of accounts) {
      const r = emptyResult();
      const entry = { id: a.id, name: a.name };
      try {
        await this.syncAccount(a, local.get(a.id), { force, tagOpts, result: r, present: seen });
      } catch (e) {
        entry.error = e.message;
        if (e.needsForce) entry.needsForce = true;
      }
      const { log, ...counts } = r;
      Object.assign(entry, counts);
      total.accounts.push(entry);
      this.recordHistory(a.id, { at: new Date().toISOString(), ok: !entry.error, error: entry.error || null, needsForce: !!entry.needsForce,
        counts: Object.fromEntries(COUNTS.map((k) => [k, r[k]])), errors: r.errors, items: log.slice(0, HISTORY_ITEMS), more: Math.max(0, log.length - HISTORY_ITEMS) });
      for (const k of COUNTS) total[k] += r[k];
      total.importedNotes = [...new Set([...total.importedNotes, ...r.importedNotes])];
      total.errors.push(...r.errors.map((x) => (accounts.length > 1 ? `${a.name}: ${x}` : x)));
    }
    this.index.pruneDeleted();
    if (total.errors.length) this.log('[sync] errors:', total.errors);
    return total;
  }

  /** Keep one run in an account's sync history (newest first, HISTORY_RUNS of them). */
  recordHistory(accountId, run) {
    try {
      const list = this.syncHistory(accountId);
      list.unshift(run);
      this.index.setMeta('synclog:' + accountId, JSON.stringify(list.slice(0, HISTORY_RUNS)));
    } catch (e) { this.log('[sync] could not record history:', e.message); }
  }

  syncHistory(accountId) {
    try { return JSON.parse(this.index.getMeta('synclog:' + accountId) || '[]'); } catch { return []; }
  }

  /**
   * Put a deleted task back: its line goes back into its note (or the account's inbox if the note is
   * gone), and, when the server's copy was kept, that exact todo goes back on the server. The next sync
   * links the two up again (by X-TICKMARK-ID), or creates a fresh todo if there was no copy.
   */
  async restore(id) {
    await this.running?.catch(() => {}); // never interleave with a sync
    const e = this.index.getDeleted(id);
    if (!e) throw Object.assign(new Error('That task is no longer in Recently deleted'), { status: 404 });
    const cfg = this.getConfig();
    const acct = (cfg.accounts || []).find((a) => a.id === e.account) || null;
    const allTags = { itemTags: [...new Set((cfg.accounts || []).flatMap((a) => a.itemTags))], sectionTags: [...new Set((cfg.accounts || []).flatMap((a) => a.sectionTags))] };

    // Reuse the block id unless something in the notes has it now.
    this.index.scan(this.vault);
    const taken = new Set();
    for (const { path } of this.index.allFiles()) {
      try { for (const t of parseTasks(this.vault.read(path).content, allTags)) if (t.blockId) taken.add(t.blockId); } catch {}
    }
    const bid = taken.has(e.block_id) ? newBlockId() : e.block_id;
    const tag = acct?.itemTags[0] || cfg.accounts?.[0]?.itemTags[0];
    // The original line when sync removed it; otherwise rebuilt from the task, first without a tag
    // (its heading's section tag may be what synced it) and with the item tag only if that's needed.
    const candidates = e.line
      ? [e.line.replace(BID_TAIL, '').replace(/\s+$/, '') + ' ^' + bid]
      : [buildTaskLine({ blockId: bid }, e.model), ...(tag ? [buildTaskLine({ blockId: bid, syncTags: [tag] }, e.model)] : [])];

    const target = e.path && this.vault.exists(e.path) ? e.path : (acct?.inboxFile || cfg.accounts?.[0]?.inboxFile || 'Inbox.md');
    let section = null;
    this.vault.modify(target, (text) => {
      const lines = text ? text.replace(/\n+$/, '').split('\n') : ['# Inbox', ''];
      for (const [i, line] of candidates.entries()) {
        // Back under its heading if that's still there. If the heading is gone (or so is the note),
        // under a "Restored tasks" heading, so it's easy to find; tasks that had no heading go at the end.
        let placed = target === e.path && e.section ? insertInSection(lines, e.section, line) : null, into = e.section;
        if (!placed && e.section) {
          into = RESTORED;
          placed = insertInSection(lines, RESTORED, line);
          if (!placed) placed = appendLines(lines, ['', `## ${RESTORED}`, line]);
        }
        const out = placed || appendLines(lines, [line]);
        const last = i === candidates.length - 1;
        if (last || parseTasks(out.join('\n'), allTags).some((t) => t.blockId === bid && t.synced)) {
          section = placed ? into : null;
          return out.join('\n') + '\n';
        }
      }
    });

    let server = 'next-sync';
    if (e.ics && acct?.url && acct.calendarUrl && bid === e.block_id) {
      const calUrl = acct.calendarUrl.endsWith('/') ? acct.calendarUrl : acct.calendarUrl + '/';
      try {
        await new CalDAV({ ...acct, owner: this.owner }).put(new URL(e.href || encodeURIComponent(e.block_id) + '.ics', calUrl).href, e.ics, { create: true });
        server = 'restored';
      } catch { /* offline or already there: the next sync re-links or recreates it */ }
    }
    this.index.removeDeleted(id);
    return { path: target, section, server };
  }

  /**
   * @param present every block id still in the notes, synced or not. A task whose line still exists
   *                (tag removed, moved to another account) isn't recorded as deleted.
   */
  async syncAccount(acct, local, { force, tagOpts, result, present = new Set() }) {
    const client = new CalDAV({ ...acct, owner: this.owner });
    const calUrl = acct.calendarUrl.endsWith('/') ? acct.calendarUrl : acct.calendarUrl + '/';
    const A = acct.id;

    // Switching calendars invalidates every mapping; X-TICKMARK-ID re-links what it can.
    // The index keeps only a fingerprint of the calendar URL and hrefs relative to it, so it doesn't
    // reveal the server or user name (the settings may be encrypted; the index isn't).
    const mark = this.index.getMeta('calendar:' + A);
    if (mark !== fingerprint(calUrl)) {
      if (mark !== calUrl) this.index.clearStates(A); // older versions stored the URL itself
      this.index.setMeta('calendar:' + A, fingerprint(calUrl));
      if (mark === calUrl) this.index.scrub();
    }
    this.index.relativizeHrefs(A, calUrl);
    const rel = (url) => (url.startsWith(calUrl) ? url.slice(calUrl.length) : url);

    // ---- 2. Remote
    const remote = new Map(); // uid → todo
    for (const r of await client.listTodos(calUrl)) {
      const root = parseICS(r.ics);
      const vt = findTodo(root);
      if (!vt) continue;
      const info = todoModel(vt);
      if (!info.uid) continue;
      if (info.cancelled) Object.assign(info.model, { done: true, status: 'cancelled' });
      if (info.model.recur && !info.model.done && occurrenceCompleted(root, vt)) info.model.done = true;
      remote.set(info.uid, { ...r, ...info });
    }

    // ---- 3. Pair everything up
    const states = new Map(this.index.getStates(A).map((s) => [s.block_id, s]));
    const uidToBlock = new Map([...states.values()].map((s) => [s.uid, s.block_id]));
    const pairs = new Map(); // blockId → { L, R, S }
    const newRemote = [];
    for (const [bid, s] of states) pairs.set(bid, { S: s, L: local.get(bid), R: remote.get(s.uid) });
    for (const [bid, l] of local) if (!pairs.has(bid)) pairs.set(bid, { L: l });
    for (const [uid, r] of remote) {
      if (uidToBlock.has(uid)) continue;
      const p = r.tickmarkId && pairs.get(r.tickmarkId);
      if (p && !p.R && !p.S) p.R = r; // re-link (state lost, or calendar switched)
      else newRemote.push(r);
    }

    // ---- 4. Safety net against mass deletion (wrong calendar, server hiccup, bad file edit)
    if (!force && states.size >= 5) {
      const goneRemote = [...pairs.values()].filter((p) => p.S && p.L && !p.R).length;
      const goneLocal = [...pairs.values()].filter((p) => p.S && !p.L && p.R).length;
      if (goneRemote / states.size > 0.5 || goneLocal / states.size > 0.5) {
        const e = new Error(`Refusing to sync: ${Math.max(goneRemote, goneLocal)} of ${states.size} tasks look deleted on the ` +
          `${goneRemote >= goneLocal ? 'CalDAV server' : 'notes side'}. Check your settings, then use “Sync anyway”.`);
        e.needsForce = true;
        e.status = 409;
        throw e;
      }
    }

    // ---- 5. Decide and push remote changes
    const localOps = new Map(); // path → [op]
    const addOp = (path, op) => { if (!localOps.has(path)) localOps.set(path, []); localOps.get(path).push(op); };
    const stateWrites = []; // applied after local edits succeed
    const trash = []; // deleted tasks, kept so they can be restored
    const keep = (bid, e) => { if (!present.has(bid)) trash.push({ account: A, block_id: bid, ...e }); };
    const today = localDate(new Date());
    const createRemote = async (bid, l) => {
      const uid = `${bid}-${crypto.randomUUID()}@tickmark`;
      const url = calUrl + encodeURIComponent(uid) + '.ics';
      const ics = buildTodo({ uid, model: l.model, tickmarkId: bid, description: `From note: ${l.path}`, doneDate: l.task.doneDate });
      const { etag } = await client.put(url, ics, { create: true });
      result.created++;
      result.log.push({ dir: 'sent', kind: 'created', title: l.model.title, path: l.path });
      return { block_id: bid, uid, href: rel(url), etag, base: l.model, path: l.path, section: l.task.section };
    };

    for (const [bid, { L, R, S }] of pairs) {
      try {
        if (L && !S && !R) {
          stateWrites.push({ set: await createRemote(bid, L) });
        } else if (L && R) {
          const base = S?.base || null;
          // A cancelled recurring todo (here or in the other app) ends its series on both sides.
          let m = endCancelledSeries(merge(L.model, R.model, base));
          // Not done while it has unchecked sub-items in the note: completing it elsewhere is undone.
          if (m.done && !L.model.done && L.openSubtasks) m = { ...m, done: false };
          // Completed elsewhere: a recurring todo moves on to its next date on both sides, and the
          // note keeps a completed copy as history.
          let history = null;
          if (m.done && m.recur && !L.model.done) {
            const a = advanceRecurring({ ...L.task, ...m }, { doneDate: R.doneDate || today, today });
            if (a) { m = a.open; history = a.historyLine; }
          }
          let etag = R.etag;
          const moved = R.fromNote && R.fromNote !== L.path; // the note was renamed or moved
          if (!modelsEqual(m, R.model) || R.tickmarkId !== bid || moved) {
            const ics = buildTodo({ existing: R.ics, uid: R.uid, model: m, tickmarkId: bid, doneDate: L.task.doneDate, fromNote: moved ? L.path : null });
            etag = (await client.put(R.url, ics, { etag: R.etag })).etag;
            if (!modelsEqual(m, R.model)) {
              result.pushed++;
              result.log.push({ dir: 'sent', kind: 'updated', title: m.title, path: L.path, changes: changes(R.model, m) });
            }
          }
          const st = { block_id: bid, uid: R.uid, href: rel(R.url), etag, base: m, path: L.path, section: L.task.section };
          if (!modelsEqual(m, L.model) || history) {
            addOp(L.path, { type: 'update', bid, expect: L.model, model: m, doneDate: m.done ? (R.doneDate || today) : null, history, state: st });
          } else stateWrites.push({ set: st });
        } else if (L && S && !R) {
          if (modelsEqual(L.model, S.base)) {
            addOp(L.path, { type: 'delete', bid, expect: L.model, state: { del: bid }, trash: { source: 'remote', model: L.model, path: L.path, section: L.task.section } });
          }
          else stateWrites.push({ set: await createRemote(bid, L) }); // edited locally after remote delete → keep it
        } else if (!L && S && R) {
          if (modelsEqual(R.model, S.base)) {
            await client.delete(R.url, R.etag);
            result.deletedRemote++;
            result.log.push({ dir: 'sent', kind: 'deleted', title: R.model.title, path: S.path });
            stateWrites.push({ del: bid });
            // Keep the server's copy: restoring puts back exactly this todo, alarms and all.
            keep(bid, { source: 'notes', model: R.model, ics: R.ics, href: rel(R.url), path: S.path, section: S.section });
          } else {
            // Changed remotely after the line was removed locally → bring it back.
            newRemote.push({ ...R, reuseBid: bid });
          }
        } else if (!L && S && !R) {
          stateWrites.push({ del: bid });
          keep(bid, { source: 'both', model: S.base, path: S.path, section: S.section });
        }
      } catch (e) {
        result.errors.push(`${L?.model.title || R?.model.title || bid}: ${e.message}`);
      }
    }

    // ---- 6. Import todos created on the CalDAV side
    const inbox = acct.inboxFile || 'Inbox.md';
    const tag = acct.itemTags[0];
    // A todo that says which note it came from ("From note: Work/Plan.md", as Tickmark writes them)
    // goes back to that note, creating it (and its folders) if it doesn't exist. A folder or note
    // that differs only in case ("projects/" for "Projects/") counts as existing. Everything else
    // goes to the inbox.
    const noteFor = (r) => {
      const p = r.fromNote?.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!p || p.split('/').some((x) => x === '..' || x.startsWith('.'))) return inbox;
      try { return this.vault.matchPath(p); } catch { return inbox; }
    };
    for (const r of newRemote) {
      if (r.model.done && !r.reuseBid) continue; // don't flood the inbox with old completed todos
      const bid = r.reuseBid || newBlockId();
      try {
        let etag = r.etag;
        if (r.tickmarkId !== bid) {
          etag = (await client.put(r.url, buildTodo({ existing: r.ics, uid: r.uid, model: r.model, tickmarkId: bid }), { etag: r.etag })).etag;
        }
        const line = buildTaskLine({ blockId: bid, syncTags: tag ? [tag] : [] }, r.model, { doneDate: r.doneDate });
        const note = noteFor(r);
        addOp(note, { type: 'append', line, state: { block_id: bid, uid: r.uid, href: rel(r.url), etag, base: r.model, path: note } });
      } catch (e) {
        result.errors.push(`${r.model.title}: ${e.message}`);
      }
    }

    // ---- 7. Apply local edits (synchronously per file, against the file as it is *now*)
    for (const [path, ops] of localOps) {
      const applied = [];
      this.vault.modify(path, (text) => {
        let lines = text.split('\n');
        if (!text) {
          lines = [`# ${path === inbox ? 'Inbox' : path.split('/').pop().replace(/\.md$/i, '')}`, ''];
          if (!tag && acct.sectionTags[0]) lines.push(`## From calendar #${acct.sectionTags[0]}`, '');
        }
        const keep = text ? 0 : lines.length; // don't trim the blank line under a fresh heading
        const tasks = new Map(parseTasks(lines.join('\n'), tagOpts).filter((t) => t.blockId).map((t) => [t.blockId, t]));
        const remove = new Set();
        const insertAfter = new Map(); // line → extra line (recurring history)
        const appends = [];
        for (const op of ops) {
          if (op.type === 'append') { // added after the other edits, which go by line number
            appends.push(op.line);
            applied.push(op);
            result.imported++;
            result.log.push({ dir: 'received', kind: 'new', title: op.state.base.title, path });
            if (!result.importedNotes.includes(path)) result.importedNotes.push(path);
            continue;
          }
          const t = tasks.get(op.bid);
          // Skip if the line moved or was edited while we were talking to the server; next run picks it up.
          if (!t || !modelsEqual(taskModel(t), op.expect)) continue;
          if (op.type === 'update') {
            lines[t.line] = buildTaskLine(t, op.model, { doneDate: op.doneDate || t.doneDate });
            if (op.history) insertAfter.set(t.line, op.history);
            result.pulled++;
            result.log.push({ dir: 'received', kind: 'updated', title: op.model.title, path, changes: changes(op.expect, op.model) });
          } else if (op.type === 'delete') {
            remove.add(t.line);
            result.deletedLocal++;
            result.log.push({ dir: 'received', kind: 'deleted', title: op.expect.title, path });
            op.trash.line = lines[t.line];
          }
          applied.push(op);
        }
        if (remove.size || insertAfter.size) {
          lines = lines.flatMap((l, i) => (remove.has(i) ? [] : insertAfter.has(i) ? [l, insertAfter.get(i)] : [l]));
        }
        if (appends.length) lines = appendLines(lines, appends, { keep });
        if (!applied.length) return null;
        let out = lines.join('\n');
        // Checked or unchecked in a task app: file it under (or back out of) the "Complete" heading,
        // like checking it in the editor does.
        if (this.getConfig().moveCompleted !== false) {
          for (const op of applied) {
            const cancelled = (x) => x.status === 'cancelled';
            if (op.type !== 'update' || op.history || (!!op.expect.done === !!op.model.done && cancelled(op.expect) === cancelled(op.model))) continue;
            const at = out.split('\n').findIndex((l) => l.trimEnd().endsWith(' ^' + op.bid));
            if (at >= 0) out = fileCompleted(out, at) ?? out;
          }
        }
        if (!out.endsWith('\n')) out += '\n';
        return out;
      });
      for (const op of applied) {
        stateWrites.push(op.state.del ? { del: op.state.del } : { set: op.state });
        // Sync itself removed this line (deleted in the task app), so it was in the notes until now.
        if (op.trash) trash.push({ account: A, block_id: op.bid, ...op.trash });
      }
    }

    // ---- 8. Persist sync state
    this.index.tx(() => {
      for (const w of stateWrites) {
        if (w.del) this.index.deleteState(A, w.del);
        else this.index.putState(A, w.set);
      }
      for (const t of trash) this.index.addDeleted(t);
    });
    // What landed in Deleted tasks (a removed tag deletes the todo but leaves the line: nothing to restore).
    result.trashed += trash.length;
  }
}
