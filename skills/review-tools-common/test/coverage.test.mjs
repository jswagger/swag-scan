import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isNonCode, renderCoverageLine, summarizeCoverage, supportedLanguage, unsupportedLanguage } from '../coverage.mjs';

const files = (...paths) => paths.map((path) => ({ path, changes: [] }));
const scanner = (skill) => fileURLToPath(new URL(`../../${skill}/scripts/scan-patterns.mjs`, import.meta.url));
const config = (skill) => fileURLToPath(new URL(`../../${skill}/config.json`, import.meta.url));

test('supported languages are JS, TS, C# and Python; everything else is unsupported', () => {
  assert.equal(supportedLanguage('a/b.py'), 'Python');
  assert.equal(supportedLanguage('Service.cs'), 'C#');
  assert.equal(supportedLanguage('x.tsx'), 'TypeScript');
  assert.equal(supportedLanguage('x.mjs'), 'JavaScript');
  assert.equal(supportedLanguage('main.go'), undefined);
  assert.equal(unsupportedLanguage('src/main.go'), 'Go');
  assert.equal(unsupportedLanguage('weird.xyz'), '.xyz');
  assert.equal(unsupportedLanguage('Makefile'), 'Makefile');
});

test('unsupported files are listed as unchecked, never as checked', () => {
  const coverage = summarizeCoverage(files('a.py', 'b.py', 'c.ts', 'main.go', 'lib.rs', 'x.go'));
  assert.deepEqual(coverage.checked, { Python: 2, TypeScript: 1 });
  assert.deepEqual(coverage.unchecked.map((file) => file.path), ['main.go', 'lib.rs', 'x.go']);
  assert.equal(
    renderCoverageLine(coverage),
    'Coverage: Checked: Python (2 files), TypeScript (1 file) · ⚪ Unchecked: 3 files in Go, Rust (not a supported language, so not reviewed).',
  );
});

test('data, docs and images are not source code, so they are never Unchecked', () => {
  assert.equal(isNonCode('data.json'), true);
  assert.equal(isNonCode('docs/README.md'), true);
  assert.equal(isNonCode('logo.PNG'), true);
  assert.equal(isNonCode('main.go'), false);
  assert.equal(isNonCode('Makefile'), false);
  const coverage = summarizeCoverage(files('a.py', 'data.json', 'README.md', 'main.go'));
  assert.deepEqual(coverage.unchecked.map((file) => file.path), ['main.go']);
  assert.equal(coverage.nonCode, 2);
  assert.match(renderCoverageLine(coverage), /2 files of data or docs, not code/);
  assert.doesNotMatch(renderCoverageLine(summarizeCoverage(files('a.py', 'data.json'))), /Unchecked/);
});

test('a diff with only unsupported files says nothing was checked', () => {
  const line = renderCoverageLine(summarizeCoverage(files('main.go')));
  assert.match(line, /Checked: nothing in a supported language/);
  assert.match(line, /⚪ Unchecked: 1 file in Go/);
});

test('with no unsupported files the line has no Unchecked part', () => {
  assert.doesNotMatch(renderCoverageLine(summarizeCoverage(files('a.py'))), /Unchecked/);
});

for (const skill of ['bug-hunter', 'code-sweeper', 'security-auditor']) {
  test(`${skill} scanner output carries the coverage with unchecked files`, () => {
    const input = JSON.stringify({
      files: [
        { path: 'a.js', status: 'modified', changes: [{ side: 'added', line: 1, text: 'const a = 1;' }] },
        { path: 'main.go', status: 'modified', changes: [{ side: 'added', line: 1, text: 'package main' }] },
      ],
    });
    const result = spawnSync(process.execPath, [scanner(skill), ...(skill === 'bug-hunter' ? ['--config', config(skill)] : [])], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { coverage } = JSON.parse(result.stdout);
    assert.deepEqual(coverage.checked, { JavaScript: 1 });
    assert.deepEqual(coverage.unchecked.map((file) => file.path), ['main.go']);
    assert.match(coverage.line, /⚪ Unchecked: 1 file in Go/);
  });
}

test('the Bug Hunter report shows an Unchecked section and the coverage line', async () => {
  const { buildReportJson, renderMarkdown } = await import('../../bug-hunter/scripts/write-report.mjs');
  const coverage = summarizeCoverage(files('a.js', 'main.go'));
  const report = buildReportJson(
    { probable_bugs: [], suspicious: [], clean: [] },
    { scan: { coverage: { ...coverage, line: renderCoverageLine(coverage) } } },
  );
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Coverage: Checked: JavaScript \(1 file\) · ⚪ Unchecked: 1 file in Go/);
  assert.match(markdown, /## ⚪ Unchecked\n\n- `main\.go` \(Go\): not reviewed/);
  assert(markdown.indexOf('⚪ Unchecked\n') < markdown.indexOf('## 🟢 Clean'));
});
