import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], { cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Writes `name` with `lines`, and returns a diff that marks `addedLines` (1-based, default: all) as added. */
function fixture(context, name, lines, addedLines = lines.map((_, index) => index + 1)) {
  const directory = mkdtempSync(join(tmpdir(), 'test-tailor-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'));
  return { path, changes: addedLines.map((line) => ({ side: 'added', line, text: lines[line - 1] })) };
}

const rules = (report, path) => report.candidates.filter((candidate) => candidate.path === path).map((candidate) => candidate.ruleId).sort();

test('JS and TS tests: no assertion, trivial assertions, and a test with real assertions that is left alone', (context) => {
  const file = fixture(context, 'cart.test.ts', [
    "it('runs', () => {",
    '  total(cart);',
    '});',
    "it('exists', () => {",
    '  expect(total(cart)).toBeTruthy();',
    '  expect(total).toBeDefined();',
    '});',
    "it('adds up the prices', () => {",
    '  expect(total([{ price: 2 }, { price: 3 }])).toBe(5);',
    '  expect(total([])).toBe(0);',
    '});',
  ]);
  const report = scan([file]);
  const byTest = (name) => report.candidates.filter((candidate) => candidate.test === name).map((candidate) => candidate.ruleId);

  assert.deepEqual(byTest('runs'), ['TT-101']);
  assert.deepEqual(byTest('exists'), ['TT-102']);
  assert.deepEqual(byTest('adds up the prices'), []);
  const fit = report.tests.find((entry) => entry.name === 'adds up the prices');
  assert.deepEqual([fit.language, fit.assertions, fit.trivialAssertions], ['TypeScript', 2, 0]);
});

test('Python tests: pytest functions and unittest methods, bare asserts, and pytest.raises counting as an assertion', (context) => {
  const file = fixture(context, 'test_cart.py', [
    'def test_runs():',
    '    total(cart)',
    '',
    'def test_exists():',
    '    result = total(cart)',
    '    assert result',
    '',
    'def test_rejects_negative():',
    '    with pytest.raises(ValueError):',
    '        total([-1])',
    '',
    'class TestCart(unittest.TestCase):',
    '    def test_total(self):',
    '        self.assertEqual(total([1, 2]), 3)',
    '',
    '    def test_defined(self):',
    '        self.assertIsNotNone(total([1]))',
  ]);
  const report = scan([file]);
  const byTest = (name) => report.candidates.filter((candidate) => candidate.test === name).map((candidate) => candidate.ruleId);

  assert.deepEqual(byTest('test_runs'), ['TT-101']);
  assert.deepEqual(byTest('test_exists'), ['TT-102']);
  assert.deepEqual(byTest('test_rejects_negative'), []);
  assert.deepEqual(byTest('test_total'), []);
  assert.deepEqual(byTest('test_defined'), ['TT-102']);
  assert.equal(report.tests.length, 5);
});

test('only tests added or edited in the diff are judged, and a new test is compared with the old ones', (context) => {
  const lines = [
    "it('old and weak', () => {",
    '  expect(total(cart)).toBeTruthy();',
    '});',
    "it('old but it checks the price', () => {",
    '  const cart = [{ price: 2 }, { price: 3 }];',
    '  expect(total(cart)).toBe(5);',
    '  expect(count(cart)).toBe(2);',
    '});',
    "it('new copy of the old one', () => {",
    '  const cart = [{ price: 9 }, { price: 1 }];',
    '  expect(total(cart)).toBe(10);',
    '  expect(count(cart)).toBe(2);',
    '});',
  ];
  const file = fixture(context, 'cart.test.js', lines, [9, 10, 11, 12, 13]);
  const report = scan([file]);

  assert.deepEqual(report.tests.map((entry) => entry.name), ['new copy of the old one']);
  assert.deepEqual(rules(report, file.path), ['TT-105'], 'the weak old test is not judged, the copy is flagged as redundant');
  const duplicate = report.candidates.find((candidate) => candidate.ruleId === 'TT-105');
  assert.equal(duplicate.severity, 'excessive');
  assert.equal(duplicate.occurrenceCount, 2);
});

test('three near-identical tests are reported once, as a table-driven candidate', (context) => {
  const body = (name, a, b) => [`it('${name}', () => {`, `  const result = add(${a}, ${b});`, '  expect(result).toBe(' + (a + b) + ');', '  expect(typeof result).toBe("number");', '});'];
  const file = fixture(context, 'add.test.js', [...body('one', 1, 2), ...body('two', 3, 4), ...body('three', 5, 6)]);
  const flagged = scan([file]).candidates.filter((candidate) => candidate.ruleId === 'TT-105');

  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].occurrenceCount, 3);
  assert.match(flagged[0].description, /table-driven/);
});

test('long setup and a very large hook are loose, and a copy-pasted fixture is excessive', (context) => {
  const setup = Array.from({ length: 16 }, (_, index) => `  const value${index} = build(${index});`);
  const hook = Array.from({ length: 26 }, (_, index) => `    seed(${index});`);
  const literal = ['  const user = {', '    id: 1,', "    name: 'Ada',", '  };'];
  const file = fixture(context, 'user.test.ts', [
    'beforeEach(() => {', ...hook, '});',
    "it('has a long setup', () => {", ...setup, '  expect(run(value0)).toBe(1);', '});',
    "it('first', () => {", ...literal, '  expect(greet(user)).toBe("Hi Ada");', '});',
    "it('second', () => {", ...literal, '  expect(shout(user)).toBe("HI ADA");', '});',
  ]);
  const found = rules(scan([file]), file.path);

  assert(found.includes('TT-103'), 'setup before the first assertion');
  assert(found.includes('TT-104'), 'oversized hook');
  assert(found.includes('TT-106'), 'copy-pasted fixture');
});

test('Python: an oversized setUp and a repeated dict fixture', (context) => {
  const seed = Array.from({ length: 26 }, (_, index) => `        self.seed(${index})`);
  const file = fixture(context, 'test_user.py', [
    'class TestUser(unittest.TestCase):',
    '    def setUp(self):', ...seed,
    '',
    '    def test_greets(self):',
    '        user = {',
    '            "id": 1,',
    '            "name": "Ada",',
    '        }',
    '        self.assertEqual(greet(user), "Hi Ada")',
    '',
    '    def test_shouts(self):',
    '        user = {',
    '            "id": 1,',
    '            "name": "Ada",',
    '        }',
    '        self.assertEqual(shout(user), "HI ADA")',
  ]);
  const found = rules(scan([file]), file.path);

  assert(found.includes('TT-104'));
  assert(found.includes('TT-106'));
});

test('tests that mention a ticket are hinted for removal, and look-alikes such as UTF-8 are not', (context) => {
  const file = fixture(context, 'billing.test.ts', [
    "it('SS-108: charges the new fee', () => {",
    '  expect(fee(100)).toBe(3);',
    '});',
    "it('encodes UTF-8 and SHA-256 names', () => {",
    '  expect(encode("é")).toBe("%C3%A9");',
    '});',
    "// acceptance criteria 3 from the ticket",
    "it('rounds up', () => {",
    '  expect(fee(101)).toBe(4);',
    '});',
  ]);
  const hints = scan([file]).candidates.filter((candidate) => candidate.ruleId === 'TT-108');

  assert.deepEqual(hints.map((hint) => hint.test), ['SS-108: charges the new fee']);
  assert.equal(hints[0].severity, 'ticket');
});

test('a test file that mocks the module it tests is a high-priority lead, in JS and in Python', (context) => {
  const js = fixture(context, 'cart.test.ts', ["jest.mock('./cart');", "it('totals', () => {", '  expect(total([1])).toBe(1);', '});']);
  const py = fixture(context, 'test_cart.py', ["@mock.patch('shop.cart.total')", 'def test_totals(m):', '    assert total([1]) == 1']);
  const unrelated = fixture(context, 'mailer.test.ts', ["jest.mock('./smtp');", "it('sends', () => {", '  expect(send()).toBe(true);', '});']);
  const report = scan([js, py, unrelated]);

  assert(rules(report, js.path).includes('TT-109'));
  assert(rules(report, py.path).includes('TT-109'));
  assert.equal(rules(report, unrelated.path).includes('TT-109'), false, 'mocking a dependency is normal');
  assert.equal(report.candidates.find((candidate) => candidate.ruleId === 'TT-109').priority, 'high');
});

test('an assertion swapped for a weaker one is flagged; a deleted assertion or a skipped test is Bug Hunter\'s, not repeated', (context) => {
  const swapped = fixture(context, 'a.test.js', ["it('totals', () => {", '  expect(total(cart)).toBeTruthy();', '});'], [2]);
  swapped.changes.push({ side: 'removed', line: 2, text: '  expect(total(cart)).toEqual(5);' });
  const removedOnly = fixture(context, 'b.test.js', ["it('totals', () => {", '  expect(total(cart)).toBe(5);', '});'], [1]);
  removedOnly.changes.push({ side: 'removed', line: 2, text: '  expect(count(cart)).toBe(2);' });
  const skipped = fixture(context, 'c.test.js', ["it.skip('later', () => {", '  run();', '});']);
  const report = scan([swapped, removedOnly, skipped]);

  assert(rules(report, swapped.path).includes('TT-107'));
  assert.equal(rules(report, removedOnly.path).includes('TT-107'), false);
  assert.equal(rules(report, skipped.path).includes('TT-101'), false, 'a skipped test has no assertions on purpose');
});

test('only test files are read, other languages are listed as unchecked, and C# tests are not judged', (context) => {
  const source = fixture(context, 'cart.ts', ['export const total = (xs: number[]) => xs.length;']);
  const csharp = fixture(context, 'CartTests.cs', ['[Fact]', 'public void Runs() { Total(cart); }']);
  const go = fixture(context, 'cart_test.go', ['func TestRuns(t *testing.T) {}']);
  const report = scan([source, csharp, go]);

  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.tests, []);
  assert(report.coverage.unchecked.some((entry) => entry.path === go.path));
  assert.match(report.coverage.line, /Coverage/);
});

test('scanner keeps the collection metadata and says it never edits anything', (context) => {
  const file = fixture(context, 'a.test.js', ["it('x', () => {", '  expect(1).toBe(1);', '});']);
  const result = spawnSync(process.execPath, [scannerPath], {
    cwd: workspaceRoot, encoding: 'utf8', input: JSON.stringify({ files: [file], baseRef: 'origin/main', baseCommitHash: 'abc123' }),
  });
  const report = JSON.parse(result.stdout);

  assert.equal(report.baseRef, 'origin/main');
  assert.equal(report.baseCommitHash, 'abc123');
  assert.match(report.note, /Only tests added or edited in the diff/);
  assert.equal('autoFixEnabled' in report, false);
});
