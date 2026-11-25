// HTML and CSS written in a note, made safe to show in the preview (and on public pages).
//
// Notes may contain raw HTML (a <div style>, <details>, <kbd>, a table…) and <style> blocks. What
// renders is cleaned first: nothing that can run code, load a frame or post a form survives, and a
// note's CSS is wrapped in @scope so it styles only the note, never the app around it.
// The page's Content-Security-Policy (script-src 'self') is a second wall behind this one.

import { safeUrl } from './url.js';

/** Marks the elements Tickmark itself renders (task checkboxes), so they survive cleaning. */
export const OWN = 'tm' + Math.random().toString(36).slice(2, 10);

const DROP = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'LINK',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'NOSCRIPT', 'TEMPLATE', 'DIALOG', 'PORTAL', 'TITLE']);
// Attributes that act on another element by id (a <label for> clicks an app button) or delay loading.
const REMOTE = new Set(['for', 'form', 'formtarget', 'popovertarget', 'popovertargetaction', 'commandfor', 'command',
  'accesskey', 'autofocus', 'loading']);
const URL_ATTRS = /^(href|src|action|formaction|poster|background|cite|data|ping|xlink:href)$/i;

/**
 * Rules whose selector could look at the page outside the note. Inside @scope a plain selector only
 * matches within the note, and `:scope` or `&` at the start of a selector is the note itself. Anything
 * before them (`body:has(…) :scope`, `.x :is(p, :scope)`), or a nested @scope, lets a rule test the app
 * around the note, and a url() in that rule would then leak what it saw.
 */
function reachesOut(r) {
  if (window.CSSScopeRule && r instanceof CSSScopeRule) return true;
  if (!(r instanceof CSSStyleRule)) return false;
  return topLevelParts(r.selectorText).some((part) => {
    const rest = part.trim().replace(/^(:scope|&)/i, '');
    // `:scope:has(+ …)` / `:has(~ …)` looks at the note container's siblings, which are outside it.
    return /:scope|&/i.test(rest) || (rest !== part.trim() && /:has\([^)]*[+~]/i.test(rest));
  });
}
function topLevelParts(sel) { // split a selector list at its own commas, not those inside :is(…) or "…"
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(sel.slice(start, i)); start = i + 1; }
  }
  parts.push(sel.slice(start));
  return parts;
}
function prune(list) { // list: a sheet or a grouping/nested rule; drops reaching rules at any depth
  for (let i = list.cssRules.length - 1; i >= 0; i--) {
    const r = list.cssRules[i];
    if (reachesOut(r)) list.deleteRule(i);
    else if (r.cssRules) prune(r);
  }
}

/**
 * A note's CSS, parsed by the browser and re-serialised inside @scope (`scope`), so it can't leak out.
 * It also stops at `limit` (embedded notes), which carry CSS of their own, scoped to themselves.
 */
export function scopeCss(css, scope, limit = '.embed-body') {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(String(css)); } catch { return ''; } // @import is ignored by replaceSync
  try { prune(sheet); } catch { return ''; }
  const inside = [], outside = [];
  for (const r of sheet.cssRules) {
    // Named things (@keyframes, @font-face, @property) can't go inside @scope; they only matter by name.
    if (r instanceof CSSKeyframesRule || r instanceof CSSFontFaceRule || (window.CSSPropertyRule && r instanceof CSSPropertyRule)) outside.push(r.cssText);
    else if (!(window.CSSImportRule && r instanceof CSSImportRule)) inside.push(r.cssText);
  }
  const out = outside.join('\n') + (inside.length ? `\n@scope (${scope})${limit ? ` to (:scope ${limit})` : ''} {\n${inside.join('\n')}\n}` : '');
  // The browser writes CSS escapes back out as plain characters, so `"\3c/style\3e"` comes back as
  // "</style>", which would end the <style> element early and let the rest through as HTML.
  return out.replace(/<\//g, '<\\/');
}

function cleanOnce(html, scope) {
  const t = document.createElement('template'); // inert: nothing in it loads or runs
  t.innerHTML = html;
  const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_ELEMENT);
  const drop = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const tag = n.tagName.toUpperCase();
    if (n.getAttribute('data-own') === OWN) { n.removeAttribute('data-own'); continue; }
    if (DROP.has(tag) || (n.namespaceURI !== 'http://www.w3.org/1999/xhtml' && /^(script|foreignobject|use|animate|set)$/i.test(n.localName))) { drop.push(n); continue; }
    if (tag === 'STYLE') { n.textContent = scopeCss(n.textContent, scope); continue; }
    // An id the app already uses would confuse it; ids inside the note's own container are fine.
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'name' || REMOTE.has(name) ||
          (URL_ATTRS.test(name) && !safeUrl(a.value)) || (name === 'id' && document.getElementById(a.value)?.closest(scope) === null) ||
          (name === 'class' && /\b(task-cb|pub-cb|embed-task)\b/.test(a.value))) n.removeAttribute(a.name);
    }
  }
  for (const n of drop) n.remove();
  return t.innerHTML;
}

/**
 * Clean rendered markdown (a string of HTML) for showing inside `scope` (a selector for its container).
 * Returns HTML text. That text is parsed again wherever it's shown, and some HTML parses differently
 * the second time (how sanitizer bypasses usually work), so it must come back exactly the same from a
 * second parse; if it doesn't, the note shows as plain text instead.
 */
export function cleanHtml(html, scope) {
  const out = cleanOnce(html, scope);
  const t = document.createElement('template');
  t.innerHTML = out;
  if (t.innerHTML === out) return out;
  const p = document.createElement('pre');
  p.textContent = html;
  return p.outerHTML;
}
