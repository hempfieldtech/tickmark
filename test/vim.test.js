import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vim } from '../public/vim.js';

// A stand-in for the editor <textarea>: just its text and selection.
function setup(text, cursor = 0) {
  const ta = {
    value: text, selectionStart: cursor, selectionEnd: cursor, scrollTop: 0, clientHeight: 400,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b ?? a; },
    addEventListener() {}, focus() {},
  };
  const toasts = [];
  const vim = new Vim(ta, {
    replace(s, e, t) { ta.value = ta.value.slice(0, s) + t + ta.value.slice(e); ta.setSelectionRange(s + t.length, s + t.length); },
    onMode() {}, toast: (m) => toasts.push(m), save() {}, quit() {},
    prompt: async () => null,
  });
  vim.enable();
  const keys = (seq) => { for (const k of seq.match(/<[^>]+>|./gu)) vim.feed(k); };
  const type = (s) => { // insert mode: the browser types it
    const p = ta.selectionStart;
    ta.value = ta.value.slice(0, p) + s + ta.value.slice(ta.selectionEnd);
    ta.setSelectionRange(p + s.length, p + s.length);
  };
  return { ta, vim, keys, type, toasts, get pos() { return ta.selectionStart; } };
}

test('motions', () => {
  const t = setup('one two three\nfour five\n\nsix');
  t.keys('w'); assert.equal(t.pos, 4);
  t.keys('e'); assert.equal(t.pos, 6);
  t.keys('$'); assert.equal(t.pos, 12);
  t.keys('0'); assert.equal(t.pos, 0);
  t.keys('j'); assert.equal(t.pos, 14);
  t.keys('2w'); assert.equal(t.pos, 24, 'w stops on an empty line');
  t.keys('G'); assert.equal(t.pos, 25);
  t.keys('gg'); assert.equal(t.pos, 0);
  t.keys('fe'); assert.equal(t.pos, 2);
  t.keys(';'); assert.equal(t.pos, 11);
  t.keys('2G'); assert.equal(t.pos, 14);
  t.keys('}'); assert.equal(t.pos, 24);
});

test('a block cursor in normal mode, a caret in insert mode', () => {
  const t = setup('abc');
  assert.deepEqual([t.ta.selectionStart, t.ta.selectionEnd], [0, 1]);
  t.keys('a');
  assert.equal(t.vim.mode, 'insert');
  assert.deepEqual([t.ta.selectionStart, t.ta.selectionEnd], [1, 1]);
  t.type('X');
  t.keys('<Esc>');
  assert.equal(t.ta.value, 'aXbc');
  assert.equal(t.pos, 1, 'Esc steps back onto the last typed character');
});

test('operators with motions, counts and doubling', () => {
  let t = setup('one two three four');
  t.keys('dw'); assert.equal(t.ta.value, 'two three four');
  t.keys('2dw'); assert.equal(t.ta.value, 'four');
  t = setup('one two three');
  t.keys('cwONE'.slice(0, 2)); t.type('ONE'); t.keys('<Esc>');
  assert.equal(t.ta.value, 'ONE two three', 'cw changes to the end of the word, not the space');
  t = setup('a\nb\nc\nd');
  t.keys('2dd'); assert.equal(t.ta.value, 'c\nd');
  t.keys('yyp'); assert.equal(t.ta.value, 'c\nc\nd');
  t.keys('G'); t.keys('dd'); assert.equal(t.ta.value, 'c\nc', 'deleting the last line takes the newline before it');
  t = setup('keep last');
  t.keys('wdw'); assert.equal(t.ta.value, 'keep ');
  t = setup('x = 1\ny = 2');
  t.keys('dj'); assert.equal(t.ta.value, '');
});

test('text objects', () => {
  let t = setup('call(foo, "bar baz") done', 12);
  t.keys('ci"'); t.type('q'); t.keys('<Esc>');
  assert.equal(t.ta.value, 'call(foo, "q") done');
  t.keys('di(');
  assert.equal(t.ta.value, 'call() done');
  t = setup('one two three', 5);
  t.keys('daw'); assert.equal(t.ta.value, 'one three');
  t = setup('p1\np1b\n\np2', 0);
  t.keys('dap'); assert.equal(t.ta.value, 'p2');
});

test('x, p, J, r, ~, counts, . repeat', () => {
  let t = setup('abcdef');
  t.keys('3x'); assert.equal(t.ta.value, 'def');
  t.keys('p'); assert.equal(t.ta.value, 'dabcef');
  t = setup('a\n  b\nc');
  t.keys('J'); assert.equal(t.ta.value, 'a b\nc');
  t.keys('lrZ'); assert.equal(t.ta.value, 'a Z\nc', 'J leaves the cursor on the joining space');
  t.keys('0~'); assert.equal(t.ta.value, 'A Z\nc');
  t = setup('one two three four');
  t.keys('dw.'); assert.equal(t.ta.value, 'three four');
  t = setup('a\nb\nc');
  t.keys('A'); t.type('!'); t.keys('<Esc>');
  t.keys('j.'); assert.equal(t.ta.value, 'a!\nb!\nc', '. repeats the typed text too');
  t = setup('item 9');
  t.keys('<C-a>'); assert.equal(t.ta.value, 'item 10');
  t.keys('5<C-x>'); assert.equal(t.ta.value, 'item 5');
});

test('visual mode', () => {
  let t = setup('hello world');
  t.keys('vey'); assert.equal(t.vim.reg['"'].text, 'hello');
  t.keys('wviwd'); assert.equal(t.ta.value, 'hello ');
  t = setup('a\nb\nc');
  t.keys('Vjd'); assert.equal(t.ta.value, 'c');
  t = setup('a\nb');
  t.keys('Vj>'); assert.equal(t.ta.value, '\ta\n\tb');
  t = setup('MiXed');
  t.keys('v$u'); assert.equal(t.ta.value, 'mixed');
});

test('o, O, indentation and registers', () => {
  const t = setup('\tlist');
  t.keys('o'); t.type('next'); t.keys('<Esc>');
  assert.equal(t.ta.value, '\tlist\n\tnext');
  t.keys('"ayy'); t.keys('gg"ap');
  assert.equal(t.ta.value, '\tlist\n\tnext\n\tnext');
  t.keys('>>'); assert.equal(t.ta.value, '\tlist\n\t\tnext\n\tnext');
  t.keys('<<'); assert.equal(t.ta.value, '\tlist\n\tnext\n\tnext');
});

test(': substitute and line jumps', async () => {
  const t = setup('cat cat\ndog cat');
  await t.vim.runEx('%s/cat/cow/g', 0);
  assert.equal(t.ta.value, 'cow cow\ndog cow');
  await t.vim.runEx('s/cow/pig/', 0);
  assert.equal(t.ta.value, 'pig cow\ndog cow');
  await t.vim.runEx('2', 0);
  assert.equal(t.pos, 8);
  await assert.rejects(() => t.vim.runEx('bogus', 0), /Not an editor command/);
});
