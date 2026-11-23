// Code block styling: a small syntax highlighter for ```lang fences, without dependencies.
// It knows each language's comments, strings, numbers and keywords (plus a few language-specific
// tokens), which is what gives ```js and ```python their different looks. Unknown languages are
// shown as plain text with their name on the block.
//
// highlight(code, lang) → { html, label, family } — html is escaped and safe to insert.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words(`async await break case catch class const continue debugger default delete do else export extends finally for from function
  get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as satisfies`);
const JS_LIT = words('true false null undefined NaN Infinity');
const TS_KW = words(`type interface enum implements private protected public readonly abstract declare namespace module keyof infer is unique
  any unknown never string number boolean bigint symbol object`);
const PY_KW = words(`and as assert async await break class continue def del elif else except finally for from global if import in is lambda
  nonlocal not or pass raise return try while with yield match case`);
const PY_LIT = words('True False None self cls');
const PY_BUILTIN = words('print len range str int float list dict set tuple open enumerate zip map filter sorted sum min max isinstance super type any all');
const SH_KW = words(`if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit
  source alias echo printf read cd test set trap eval exec`);
const GO_KW = words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return
  select struct switch type var`);
const GO_LIT = words('true false nil iota string int int64 int32 uint byte rune float64 error bool any');
const RUST_KW = words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return
  static struct super trait type unsafe use where while Self self`);
const RUST_LIT = words('true false None Some Ok Err i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char str String Vec Option Result');
const C_KW = words(`auto break case char const continue default do double else enum extern float for goto if inline int long register return short
  signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected
  virtual override new delete using try catch throw this bool true false nullptr`);
const JAVA_KW = words(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally
  float for if implements import instanceof int interface long native new package private protected public return short static super switch
  synchronized this throw throws transient try void volatile while var record fun val when object companion data sealed override`);
const CS_KW = words(`abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event
  explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator
  out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true
  try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record`);
const PHP_KW = words(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty
  enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include
  instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch
  throw trait try unset use var while yield true false null`);
const RUBY_KW = words(`alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry
  return self super then true undef unless until when while yield require attr_accessor puts`);
const LUA_KW = words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while');
const SQL_KW = words(`select from where and or not insert into values update set delete create table drop alter add column index primary key foreign
  references join inner left right outer full on as group by order having limit offset union all distinct case when then else end null is in
  like between exists count sum avg min max with returning default unique check view trigger begin commit rollback desc asc if replace
  integer int text varchar boolean real date timestamp`);

// Each language: line comment(s), block comment, string quotes, keyword sets, and family (for the CSS accent).
const C_LIKE = { line: ['//'], block: ['/*', '*/'], quotes: `"'`, family: 'c' };
const LANGS = {
  js: { ...C_LIKE, quotes: `"'\``, kw: JS_KW, lit: JS_LIT, label: 'JavaScript', family: 'js', regex: true },
  ts: { ...C_LIKE, quotes: `"'\``, kw: new Set([...JS_KW, ...TS_KW]), lit: JS_LIT, label: 'TypeScript', family: 'ts', regex: true },
  py: { line: ['#'], quotes: `"'`, triple: true, kw: PY_KW, lit: PY_LIT, builtin: PY_BUILTIN, label: 'Python', family: 'py', decorators: true },
  sh: { line: ['#'], quotes: `"'`, kw: SH_KW, label: 'Shell', family: 'sh', vars: true },
  go: { ...C_LIKE, quotes: `"'\``, kw: GO_KW, lit: GO_LIT, label: 'Go', family: 'go' },
  rust: { ...C_LIKE, kw: RUST_KW, lit: RUST_LIT, label: 'Rust', family: 'rust', macros: true },
  c: { ...C_LIKE, kw: C_KW, label: 'C', family: 'c', preproc: true },
  cpp: { ...C_LIKE, kw: C_KW, label: 'C++', family: 'c', preproc: true },
  java: { ...C_LIKE, kw: JAVA_KW, lit: words('true false null'), label: 'Java', family: 'java', decorators: true },
  kotlin: { ...C_LIKE, kw: JAVA_KW, lit: words('true false null'), label: 'Kotlin', family: 'java' },
  cs: { ...C_LIKE, kw: CS_KW, label: 'C#', family: 'cs' },
  php: { line: ['//', '#'], block: ['/*', '*/'], quotes: `"'`, kw: PHP_KW, label: 'PHP', family: 'php', vars: true },
  ruby: { line: ['#'], quotes: `"'`, kw: RUBY_KW, lit: words('true false nil'), label: 'Ruby', family: 'ruby', symbols: true },
  lua: { line: ['--'], quotes: `"'`, kw: LUA_KW, label: 'Lua', family: 'lua' },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: `'"`, kw: SQL_KW, nocase: true, label: 'SQL', family: 'sql' },
  json: { quotes: '"', lit: words('true false null'), label: 'JSON', family: 'json', keys: true },
  yaml: { line: ['#'], quotes: `"'`, lit: words('true false null yes no on off ~'), label: 'YAML', family: 'yaml', yamlKeys: true },
  toml: { line: ['#'], quotes: `"'`, lit: words('true false'), label: 'TOML', family: 'yaml', iniKeys: true },
  ini: { line: [';', '#'], quotes: `"'`, label: 'INI', family: 'yaml', iniKeys: true },
  css: { block: ['/*', '*/'], quotes: `"'`, label: 'CSS', family: 'css', css: true },
  html: { label: 'HTML', family: 'html', markup: true },
  xml: { label: 'XML', family: 'html', markup: true },
  diff: { label: 'Diff', family: 'diff', diff: true },
  md: { label: 'Markdown', family: 'md', md: true },
  dockerfile: { line: ['#'], quotes: `"'`, kw: words('FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'), label: 'Dockerfile', family: 'sh', vars: true },
};
const ALIAS = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', typescript: 'ts', tsx: 'ts', python: 'py', python3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', fish: 'sh', golang: 'go', rs: 'rust', h: 'c', hpp: 'cpp', 'c++': 'cpp', cc: 'cpp',
  csharp: 'cs', 'c#': 'cs', kt: 'kotlin', rb: 'ruby', yml: 'yaml', htm: 'html', svg: 'xml', vue: 'html', patch: 'diff',
  markdown: 'md', scss: 'css', less: 'css', jsonc: 'json', json5: 'json', docker: 'dockerfile', postgres: 'sql', mysql: 'sql', sqlite: 'sql',
};

export function langOf(lang) {
  const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  return ALIAS[l] || (LANGS[l] ? l : null);
}

const span = (cls, text) => `<span class="hl-${cls}">${esc(text)}</span>`;

/** Highlight one block. Returns { html, label, family }; label is the language as written when unknown. */
export function highlight(code, lang) {
  const key = langOf(lang);
  const L = key && LANGS[key];
  const shown = String(lang || '').trim().split(/\s+/)[0];
  if (!L) return { html: esc(code), label: shown || '', family: shown ? 'other' : 'plain' };
  let html;
  try {
    html = L.markup ? markup(code) : L.diff ? diff(code) : L.md ? markdown(code) : generic(code, L);
  } catch { html = esc(code); }
  return { html, label: L.label, family: L.family };
}

function generic(src, L) {
  let out = '', i = 0;
  const n = src.length;
  const at = (s) => src.startsWith(s, i);
  let lineStart = true; // only whitespace so far on this line
  while (i < n) {
    const c = src[i];
    // comments
    const lc = L.line?.find(at);
    if (lc && !(lc === '#' && L.css)) {
      let e = src.indexOf('\n', i); if (e < 0) e = n;
      out += span('com', src.slice(i, e)); i = e; continue;
    }
    if (L.block && at(L.block[0])) {
      let e = src.indexOf(L.block[1], i + L.block[0].length); e = e < 0 ? n : e + L.block[1].length;
      out += span('com', src.slice(i, e)); i = e; continue;
    }
    // preprocessor (#include) and decorators (@name)
    if (L.preproc && c === '#' && lineStart) { let e = src.indexOf('\n', i); if (e < 0) e = n; out += span('meta', src.slice(i, e)); i = e; continue; }
    if (L.decorators && c === '@' && /[A-Za-z_]/.test(src[i + 1] || '')) { const m = /^@[\w.]+/.exec(src.slice(i)); out += span('meta', m[0]); i += m[0].length; lineStart = false; continue; }
    // strings
    if (L.quotes?.includes(c)) {
      const triple = L.triple && src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n && !src.startsWith(q, j)) { if (src[j] === '\\') j++; else if (!triple && c !== '`' && src[j] === '\n') break; j++; }
      j = Math.min(n, j + (src.startsWith(q, j) ? q.length : 0));
      const s = src.slice(i, j);
      // JSON / YAML: a string followed by a colon is a key
      const key = (L.keys || L.yamlKeys) && /^\s*:/.test(src.slice(j, j + 40));
      out += span(key ? 'attr' : 'str', s); i = j; lineStart = false; continue;
    }
    // YAML keys and INI/TOML keys and [sections]
    if ((L.yamlKeys || L.iniKeys) && lineStart) {
      const m = /^(-\s+)?([\w.$-][\w .$/-]*?)(\s*[:=])(?=\s|$)/.exec(src.slice(i));
      if (m && !/\n/.test(m[0])) { out += esc(m[1] || '') + span('attr', m[2]) + esc(m[3]); i += m[0].length; lineStart = false; continue; }
      const sec = L.iniKeys && /^\[[^\]\n]+\]/.exec(src.slice(i));
      if (sec) { out += span('type', sec[0]); i += sec[0].length; lineStart = false; continue; }
    }
    // shell and PHP variables
    if (L.vars && c === '$') { const m = /^\$(\{[^}\n]*\}|[\w@#?*!-]+)/.exec(src.slice(i)); if (m) { out += span('var', m[0]); i += m[0].length; lineStart = false; continue; } }
    if (L.symbols && c === ':' && /[A-Za-z_]/.test(src[i + 1] || '') && !/\w/.test(src[i - 1] || '')) { const m = /^:\w+[?!]?/.exec(src.slice(i)); out += span('lit', m[0]); i += m[0].length; continue; }
    // CSS: at-rules, properties, colours, units
    if (L.css) {
      const r = cssToken(src, i);
      if (r) { out += r.html; i = r.end; lineStart = false; continue; }
    }
    // numbers
    if (/[0-9]/.test(c) && !/[\w$]/.test(src[i - 1] || '')) {
      const m = /^(0x[\da-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?)[a-z%]*/i.exec(src.slice(i));
      out += span('num', m[0]); i += m[0].length; lineStart = false; continue;
    }
    // words
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*[?!]?/.exec(src.slice(i)) || [c];
      const w = m[0], lw = L.nocase ? w.toLowerCase() : w;
      const next = src.slice(i + w.length).match(/^\s*(\(|!)/);
      let cls = null;
      if (L.kw?.has(lw)) cls = 'kw';
      else if (L.lit?.has(L.nocase ? lw : w)) cls = 'lit';
      else if (L.builtin?.has(w)) cls = 'fn';
      else if (L.macros && next?.[1] === '!') cls = 'fn';
      else if (next?.[1] === '(') cls = 'fn';
      else if (/^[A-Z][a-z0-9]\w*$/.test(w) && !L.nocase && !L.yamlKeys) cls = 'type';
      out += cls ? span(cls, w) : esc(w);
      i += w.length; lineStart = false; continue;
    }
    if (c === '\n') lineStart = true;
    else if (!/\s/.test(c)) lineStart = false;
    out += esc(c); i++;
  }
  return out;
}

function cssToken(src, i) {
  const rest = src.slice(i, i + 200);
  let m;
  if ((m = /^@[\w-]+/.exec(rest))) return { html: span('kw', m[0]), end: i + m[0].length };
  if ((m = /^#[\da-f]{3,8}\b/i.exec(rest)) && /[:\s,(]/.test(src[i - 1] || ' ')) return { html: span('num', m[0]), end: i + m[0].length };
  if ((m = /^(--[\w-]+|[a-z-]+)(\s*:)(?!:)/i.exec(rest)) && !/[\w-]/.test(src[i - 1] || '') && /[{;\s]/.test(src.slice(0, i).trimEnd().slice(-1) || '{')) {
    // a property inside a rule (not a selector like a:hover)
    const before = src.slice(0, i);
    if (before.lastIndexOf('{') > before.lastIndexOf('}')) return { html: span('attr', m[1]) + esc(m[2]), end: i + m[0].length };
  }
  if ((m = /^-?\d*\.?\d+(px|em|rem|%|vh|vw|dvh|s|ms|deg|fr|ch|pt)?\b/.exec(rest)) && !/[\w-]/.test(src[i - 1] || '')) return { html: span('num', m[0]), end: i + m[0].length };
  if ((m = /^[a-z-]+(?=\()/i.exec(rest))) return { html: span('fn', m[0]), end: i + m[0].length };
  if ((m = /^!important/.exec(rest))) return { html: span('kw', m[0]), end: i + m[0].length };
  // selectors: .class, #id and element names outside a rule
  const before = src.slice(0, i);
  if (before.lastIndexOf('{') <= before.lastIndexOf('}') && (m = /^[.#]?[a-z_][\w-]*/i.exec(rest)) && !/[\w-]/.test(src[i - 1] || '')) return { html: span(m[0][0] === '.' || m[0][0] === '#' ? 'type' : 'kw', m[0]), end: i + m[0].length };
  return null;
}

function markup(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { let e = src.indexOf('-->', i); e = e < 0 ? src.length : e + 3; out += span('com', src.slice(i, e)); i = e; continue; }
    if (src[i] === '<' && /[A-Za-z!/?]/.test(src[i + 1] || '')) {
      let e = src.indexOf('>', i); e = e < 0 ? src.length : e + 1;
      const tag = src.slice(i, e);
      const m = /^(<[/!?]?)([\w:.-]*)/.exec(tag);
      let rest = tag.slice(m[0].length), body = '';
      const re = /([\w:.@-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?|(\s+)|([^\w\s]+)/g;
      let x;
      while ((x = re.exec(rest))) {
        if (x[1]) body += span('attr', x[1]) + (x[2] ? esc(x[2]) : '') + (x[3] ? span('str', x[3]) : '');
        else body += esc(x[0]);
      }
      out += esc(m[1]) + span('kw', m[2]) + body;
      i = e; continue;
    }
    if (src[i] === '&') { const m = /^&[#\w]+;/.exec(src.slice(i)); if (m) { out += span('lit', m[0]); i += m[0].length; continue; } }
    out += esc(src[i]); i++;
  }
  return out;
}

function diff(src) {
  return src.split('\n').map((l) => {
    if (/^(\+\+\+|---)\s/.test(l) || /^(diff|index) /.test(l)) return span('meta', l);
    if (l.startsWith('@@')) return span('fn', l);
    if (l.startsWith('+')) return span('add', l);
    if (l.startsWith('-')) return span('del', l);
    return esc(l);
  }).join('\n');
}

function markdown(src) {
  return src.split('\n').map((l) => {
    if (/^#{1,6}\s/.test(l)) return span('kw', l);
    if (/^\s*>/.test(l)) return span('com', l);
    return esc(l)
      .replace(/^(\s*)([-*+]|\d+[.)])(\s)/, (_, a, b, c) => `${a}<span class="hl-lit">${b}</span>${c}`)
      .replace(/(`[^`]+`)/g, '<span class="hl-str">$1</span>')
      .replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, '<span class="hl-type">$1</span>')
      .replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="hl-fn">$1</span>');
  }).join('\n');
}
