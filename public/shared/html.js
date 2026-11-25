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
const URL_ATTRS = /^(href|src|action|formaction|poster|background|cite|data|ping|xlink:href)$/i;

/** A note's CSS, parsed by the browser and re-serialised inside @scope (`scope`), so it can't leak out. */
export function scopeCss(css, scope) {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(String(css)); } catch { return ''; } // @import is ignored by replaceSync
  const inside = [], outside = [];
  for (const r of sheet.cssRules) {
    // Named things (@keyframes, @font-face, @property) can't go inside @scope; they only matter by name.
    if (r instanceof CSSKeyframesRule || r instanceof CSSFontFaceRule || (window.CSSPropertyRule && r instanceof CSSPropertyRule)) outside.push(r.cssText);
    else if (!(window.CSSImportRule && r instanceof CSSImportRule)) inside.push(r.cssText);
  }
  return outside.join('\n') + (inside.length ? `\n@scope (${scope}) {\n${inside.join('\n')}\n}` : '');
}

/**
 * Clean rendered markdown (a string of HTML) for showing inside `scope` (a selector for its container).
 * Returns HTML text.
 */
export function cleanHtml(html, scope) {
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
      if (name.startsWith('on') || name === 'srcset' || name === 'name' || name === 'formtarget' ||
          (URL_ATTRS.test(name) && !safeUrl(a.value)) || (name === 'id' && document.getElementById(a.value)?.closest(scope) === null) ||
          (name === 'class' && /\b(task-cb|pub-cb|embed-task)\b/.test(a.value))) n.removeAttribute(a.name);
    }
  }
  for (const n of drop) n.remove();
  return t.innerHTML;
}
