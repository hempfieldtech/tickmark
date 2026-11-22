// Line-based three-way merge (diff3). Used when the editor saves a note that changed
// on disk in the meantime (e.g. the sync engine rewrote a task line).

function lcsMap(o, x) {
  // Returns an array mapping each index of o to its matched index in x (or -1).
  const map = new Array(o.length).fill(-1);
  let pre = 0;
  while (pre < o.length && pre < x.length && o[pre] === x[pre]) { map[pre] = pre; pre++; }
  let so = o.length, sx = x.length;
  while (so > pre && sx > pre && o[so - 1] === x[sx - 1]) { so--; sx--; map[so] = sx; }
  const n = so - pre, m = sx - pre;
  if (n === 0 || m === 0) return map;
  if (n * m > 8e6) return null; // too large to diff reliably
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = o[pre + i] === x[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (o[pre + i] === x[pre + j]) { map[pre + i] = pre + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return map;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Resolve an "adjacent edits" conflict where one side only inserted lines and the other only
// replaced lines one-for-one (the typical editor-vs-sync case). Returns null if not applicable.
function refine(oc, ac, bc) {
  const tryOne = (ins, rep) => {
    if (rep.length !== oc.length) return null;
    const m = lcsMap(oc, ins);
    if (!m || m.some((x) => x < 0)) return null;
    const out = ins.slice();
    oc.forEach((line, i) => { if (rep[i] !== line) out[m[i]] = rep[i]; });
    return out;
  };
  // Both sides changed lines one-for-one (e.g. two people editing neighbouring lines): take each
  // side's change per line, as long as no single line was changed differently by both.
  const lineByLine = () => {
    if (ac.length !== oc.length || bc.length !== oc.length) return null;
    const out = [];
    for (let i = 0; i < oc.length; i++) {
      if (ac[i] === oc[i] || ac[i] === bc[i]) out.push(bc[i]);
      else if (bc[i] === oc[i]) out.push(ac[i]);
      else return null;
    }
    return out;
  };
  return tryOne(ac, bc) || tryOne(bc, ac) || lineByLine();
}

/** Merge `ours` and `theirs`, both derived from `base`. Returns { text, conflicts }. */
export function merge3(base, ours, theirs) {
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: ours, conflicts: 0 };
  const o = base.split('\n'), a = ours.split('\n'), b = theirs.split('\n');
  const ma = lcsMap(o, a), mb = lcsMap(o, b);
  if (!ma || !mb) return { text: ours, conflicts: 1 };
  const out = [];
  let conflicts = 0;
  let i = 0, ia = 0, ib = 0;
  for (;;) {
    let j = i;
    while (j < o.length && !(ma[j] >= ia && mb[j] >= ib)) j++;
    const ja = j < o.length ? ma[j] : a.length;
    const jb = j < o.length ? mb[j] : b.length;
    const oc = o.slice(i, j), ac = a.slice(ia, ja), bc = b.slice(ib, jb);
    if (same(ac, oc)) out.push(...bc);
    else if (same(bc, oc) || same(ac, bc)) out.push(...ac);
    else if (refine(oc, ac, bc)) out.push(...refine(oc, ac, bc));
    else {
      conflicts++;
      out.push('<<<<<<< this device', ...ac, '=======', ...bc, '>>>>>>> on disk');
    }
    if (j >= o.length) break;
    out.push(o[j]);
    i = j + 1; ia = ja + 1; ib = jb + 1;
  }
  return { text: out.join('\n'), conflicts };
}
