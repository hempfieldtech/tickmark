// Which link targets are safe to put in a page made from note content.

/**
 * Links that can't run code. Browsers drop tabs and newlines inside a URL and control characters
 * before it ("java\tscript:" still runs), so those go before the check, which allows only known schemes.
 */
export function safeUrl(u) {
  const s = String(u || '').replace(/[\x00-\x20\x7f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  return !scheme || /^(https?|mailto|tel|obsidian|tickmark)$/i.test(scheme[1]);
}
