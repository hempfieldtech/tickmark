// Measuring a textarea's caret, and drawing other people's carets over it (live collaboration).
// Used by the app's editor and by an editable public page.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A hidden copy of a textarea's text box (same font, padding and wrapping width), for measuring. */
export function textMirror(ta) {
  let m = textMirror.el;
  if (!m) { m = textMirror.el = document.createElement('div'); m.setAttribute('aria-hidden', 'true'); document.body.append(m); }
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textTransform', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) m.style[p] = cs[p];
  // clientWidth leaves out the scrollbar, so lines wrap where the textarea wraps them.
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    wordWrap: 'break-word', boxSizing: 'border-box', border: '0', width: ta.clientWidth + 'px', height: 'auto', overflow: 'hidden' });
  return m;
}

/** Where a position in a textarea is: on screen (x, y), and from the top of its text (top, for scrolling). */
export function caretXY(ta, pos) {
  const m = textMirror(ta);
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '​';
  m.append(mark);
  const r = ta.getBoundingClientRect();
  return { x: r.left + ta.clientLeft + mark.offsetLeft - ta.scrollLeft, y: r.top + ta.clientTop + mark.offsetTop - ta.scrollTop,
    top: mark.offsetTop, h: parseFloat(getComputedStyle(ta).lineHeight) || 20 };
}

/** The caret as line and column, which survive other people's edits better than an offset. */
export function lineCol(ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  return { line: before.split('\n').length - 1, col: before.length - before.lastIndexOf('\n') - 1 };
}

/** A colour for a person, the same on every screen. */
export const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** A short label for a person: their name and device. */
export const personLabel = (p) => [p.name, p.device].filter(Boolean).join(' · ') || 'Someone';

/**
 * Markup for other people's carets over textarea `ta`, positioned inside `layer` (an absolutely
 * placed box). Someone above or below what's showing gets a marker on that edge instead.
 */
export function cursorsHTML(ta, layer, people) {
  const lines = ta.value.split('\n');
  const wr = layer.getBoundingClientRect(), er = ta.getBoundingClientRect();
  return people.filter((p) => p.line != null).map((p) => {
    const ln = Math.min(p.line, lines.length - 1);
    let off = 0;
    for (let i = 0; i < ln; i++) off += lines[i].length + 1;
    off += Math.min(p.col ?? 0, lines[ln].length);
    const c = caretXY(ta, off);
    const edge = c.y < er.top ? 'above' : c.y + c.h > er.bottom ? 'below' : null;
    const top = edge === 'above' ? er.top - wr.top : edge === 'below' ? er.bottom - wr.top - 20 : c.y - wr.top;
    return `<span class="rcursor${edge ? ' edge ' + edge : ''}" style="--h:${hue(p.id)};left:${Math.max(er.left - wr.left, c.x - wr.left)}px;top:${top}px;height:${edge ? 20 : c.h}px">` +
      `<span class="rname">${edge === 'above' ? '↑ ' : edge === 'below' ? '↓ ' : ''}${esc(personLabel(p))}</span></span>`;
  }).join('');
}
