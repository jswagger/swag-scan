import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RULE_CATALOG, rulesApplied } from '../rule-catalog.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const ids = (source, pattern) => [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort();
const listed = (tool) => RULE_CATALOG[tool].map((rule) => rule.id).sort();

test('the Code Sweeper catalog lists exactly the SWEEP rules its script can report', () => {
  assert.deepEqual(listed('code-sweeper'), ids(read('../../code-sweeper/scripts/scan-patterns.mjs'), /ruleId: '(SWEEP-\d+)'/g));
});

test('the Bug Hunter catalog lists exactly the rules its script can report', () => {
  const source = read('../../bug-hunter/scripts/lib/rules-regression.mjs');
  const found = ids(source, /(?:\brule: |removedFinding\(hunk, line, )'([A-Z_]+)'/g);
  assert.deepEqual(listed('bug-hunter'), found);
});

test('rules are counted for the languages that were scanned', () => {
  assert.equal(rulesApplied('code-sweeper', { checked: { 'C#': 3 } }), 9, 'C# skips the Python and JS/TS-only rules');
  assert.equal(rulesApplied('code-sweeper', { checked: { Python: 1 } }), 10);
  assert.equal(rulesApplied('code-sweeper', { checked: { TypeScript: 1 } }), 11);
  assert.equal(rulesApplied('code-sweeper', { checked: { Python: 1, 'C#': 1, TypeScript: 1 } }), 12, 'a rule counts once, however many languages use it');
  assert.equal(rulesApplied('bug-hunter', { checked: { 'C#': 1 } }), 9);
  assert.equal(rulesApplied('bug-hunter', { checked: { JavaScript: 1 } }), 10);
});

test('Security Auditor counts the distinct rule ids it reported in ruleFamilies', () => {
  const coverage = {
    checked: { Python: 1, 'C#': 1 },
    ruleFamilies: [
      { language: 'python', ran: [{ family: 'A', rules: ['SEC-1', 'PY-1'] }] },
      { language: 'csharp', ran: [{ family: 'A', rules: ['SEC-1', 'CS-1'] }, { family: 'B', rules: ['CS-2'] }] },
    ],
  };
  assert.equal(rulesApplied('security-auditor', coverage), 4);
});

test('nothing is claimed when the count is not known or nothing was scanned', () => {
  assert.equal(rulesApplied('code-sweeper', undefined), undefined);
  assert.equal(rulesApplied('security-auditor', { checked: { Python: 1 } }), undefined);
  assert.equal(rulesApplied('something-else', { checked: { Python: 1 } }), undefined);
  assert.equal(rulesApplied('code-sweeper', { checked: {} }), 0);
});
