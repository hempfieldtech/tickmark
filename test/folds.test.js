import test from 'node:test';
import assert from 'node:assert/strict';
import { sections, collapse, expand, layout, toReal, toDisplay, headingKey, isDamaged } from '../public/shared/folds.js';

const NOTE = [
  '---', 'title: x', '# not a heading (frontmatter)', '---',
  '# Plan',
  'intro',
  '## Groceries #sync',
  '- [ ] Eggs',
  '```',
  '# not a heading (code)',
  '```',
  '',
  '## Later',
  'one',
  '### Deep',
  'two',
  '',
  '',
  '# Next',
  '## Empty',
].join('\n');

const fold = (real, keys) => {
  const known = new Map();
  let id = 0;
  const display = collapse(real, new Set(keys), known, () => ++id);
  return { display, known };
};

test('sections: headings outside code and frontmatter, to the next same-or-higher heading, trailing blanks visible', () => {
  const s = sections(NOTE.split('\n'));
  assert.deepEqual(s.map((x) => [x.key, x.line, x.end]), [
    ['plan', 4, 16], ['groceries #sync', 6, 11], ['later', 12, 16], ['deep', 14, 16], ['next', 18, 20],
  ], '## Empty has nothing under it, so only # Next (holding it) can fold');
  assert.equal(headingKey('Later  ##'), 'later');
});

test('collapse and expand round-trip, nested folds go with their parent', () => {
  for (const keys of [[], ['later'], ['groceries #sync', 'deep'], ['plan', 'deep'], ['plan', 'later', 'groceries #sync', 'deep']]) {
    const { display, known } = fold(NOTE, keys);
    const x = expand(display, known);
    assert.equal(x.real, NOTE, keys.join());
    assert.deepEqual(x.damaged, []);
  }
  const { display, known } = fold(NOTE, ['groceries #sync', 'deep']);
  const lines = display.split('\n');
  assert.match(lines[7], /^⋯ 4 lines/);
  assert.equal(lines[8], '', 'the blank line before the next heading stays');
  assert.deepEqual([...expand(display, known).keys].sort(), ['deep', 'groceries #sync']);
  // Folding Plan hides everything to "# Next", Deep included: one fold line.
  const top = fold(NOTE, ['plan', 'deep']);
  assert.equal(top.display.split('\n').filter((l) => l.startsWith('⋯')).length, 1);
});

test('positions map both ways; inside a fold has no display position', () => {
  const { display, known } = fold(NOTE, ['later']);
  const segs = layout(display, known);
  const realLater = NOTE.indexOf('## Later'), realOne = NOTE.indexOf('one'), realNext = NOTE.indexOf('# Next');
  const dLater = display.indexOf('## Later'), dFold = display.indexOf('⋯'), dNext = display.indexOf('# Next');
  assert.equal(toReal(segs, dLater), realLater);
  assert.equal(toReal(segs, dNext), realNext);
  assert.equal(toReal(segs, dFold), realOne, 'a fold line stands for the start of its section');
  assert.deepEqual(toDisplay(segs, realNext), { pos: dNext, fold: null });
  assert.deepEqual(toDisplay(segs, realOne), { pos: dFold, fold: null }, 'the very start is the fold line');
  const inside = toDisplay(segs, realOne + 2);
  assert.equal(inside.pos, dFold);
  assert.equal(inside.fold.key, 'later');
});

test('editing around folds: renamed headings keep their fold, damaged fold lines are reported', () => {
  const { display, known } = fold(NOTE, ['later']);
  const renamed = display.replace('## Later', '## Later on');
  const x = expand(renamed, known);
  assert.equal(x.real, NOTE.replace('## Later', '## Later on'));
  assert.deepEqual([...x.keys], ['later on']);
  const marker = display.split('\n').find((l) => l.startsWith('⋯'));
  assert.ok(isDamaged(marker));
  const typed = display.replace(marker, marker + 'x');
  assert.equal(expand(typed, known).damaged.length, 1);
  const gone = display.replace(marker + '\n', '');
  assert.equal(expand(gone, known).real, NOTE.replace(/one\n### Deep\ntwo\n/, ''), 'a fold deleted whole takes its text with it');
});
