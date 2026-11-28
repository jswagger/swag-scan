#!/usr/bin/env node
// Test Tailor scanner: finds leads about the long-term value of unit tests that were added or edited in the diff.
// Reads the collector JSON on stdin, prints JSON. Python, JavaScript and TypeScript tests. No model, no network.
// A lead is a script match, not a verdict: the agent reads the test and decides.

import { readFileSync } from 'node:fs';
import { renderCoverageLine, summarizeCoverage } from '../../review-tools-common/coverage.mjs';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { analyzeTestFile } from './lib/test-blocks.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { isExcluded, isTestFile } = createFileFilters(config.scan);
const thresholds = config.scan?.thresholds ?? {};

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

let report;
try {
  report = JSON.parse(input);
  if (!report || !Array.isArray(report.files)) throw new Error('Expected a JSON object with a files array.');
} catch (error) {
  process.stderr.write(`Invalid diff JSON: ${error.message}\n`);
  process.exit(1);
}

const candidates = [];
const tests = [];
const addCandidate = (candidate) => candidates.push(candidate);

function sourceOf(file) {
  try {
    return readFileSync(file.path, 'utf8');
  } catch {
    return undefined; // a deleted or unreadable file: only its removed lines can be judged
  }
}

/**
 * An existing assertion replaced by a weaker one in the same edit (toEqual to toBeTruthy, assertEqual to a bare assert).
 * Deleted assertions and disabled tests are Bug Hunter's (REMOVED_TEST_ASSERTION, TEST_DISABLED), so they are not repeated here.
 */
const STRONG = /\b(?:toEqual|toStrictEqual|toBe|toMatch|toContain|toHaveLength|toThrow|toHaveBeenCalledWith|assertEqual|assertEquals|assertDictEqual|assertListEqual|deepEqual|deepStrictEqual|strictEqual|equal)\b/;
const WEAK = /\b(?:toBeTruthy|toBeFalsy|toBeDefined|assertTrue|assertIsNotNone)\b|\.not\.toBe(?:Null|Undefined)\b|^\s*assert\s+[\w.]+\s*$|assert\s+[\w.]+\s+is\s+not\s+None\s*$/;

function loosenedMatcherLeads(path, added, removed) {
  const leads = [];
  const strongRemoved = removed.filter((change) => STRONG.test(change.text));
  const weakAdded = added.filter((change) => WEAK.test(change.text) && !STRONG.test(change.text));
  const pairs = Math.min(strongRemoved.length, weakAdded.length);
  for (let index = 0; index < pairs; index += 1) {
    leads.push({
      ruleId: 'TT-107',
      severity: 'loose',
      path,
      line: weakAdded[index].line,
      description: 'An assertion was replaced by a weaker one in this edit; check the test still fails when the code is wrong',
      evidence: `was: ${strongRemoved[index].text.trim().slice(0, 110)} | now: ${weakAdded[index].text.trim().slice(0, 110)}`,
    });
  }
  return leads;
}

for (const file of report.files) {
  if (isExcluded(file.path) || !isTestFile(file.path)) continue;
  const changes = file.changes ?? [];
  const added = changes.filter((change) => change.side === 'added');
  const removed = changes.filter((change) => change.side === 'removed');
  const source = sourceOf(file);
  if (source === undefined && removed.length === 0) continue;
  const result = source === undefined
    ? { language: undefined, tests: [], leads: [] }
    : analyzeTestFile({ path: file.path, source, addedLines: new Set(added.map((change) => change.line)), thresholds });
  for (const test of result.tests) tests.push(test);
  for (const lead of result.leads) addCandidate(lead);
  for (const lead of loosenedMatcherLeads(file.path, added, removed)) addCandidate(lead);
}

const coverage = summarizeCoverage(report.files);
process.stdout.write(`${JSON.stringify({
  candidates,
  tests,
  coverage: { checked: coverage.checked, unchecked: coverage.unchecked, line: renderCoverageLine(coverage) },
  skipped: report.skipped ?? [],
  baseRef: report.baseRef,
  requestedBaseRef: report.requestedBaseRef,
  comparisonBase: report.comparisonBase,
  baseCommitHash: report.baseCommitHash,
  baseCommitDate: report.baseCommitDate,
  excludedCount: report.excludedCount ?? 0,
  note: 'Heuristic leads only. Read each test and its code before judging it. Only tests added or edited in the diff are listed.',
}, null, 2)}\n`);
process.stderr.write(`Test Tailor: ${tests.length.toLocaleString()} changed tests, ${candidates.length.toLocaleString()} leads.\n`);
