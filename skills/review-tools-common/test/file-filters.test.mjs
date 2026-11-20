import assert from 'node:assert/strict';
import test from 'node:test';

import { createFileFilters } from '../file-filters.mjs';

test('exclude patterns match basenames, nested paths, and normalize Windows separators', () => {
  const { isExcluded } = createFileFilters({ exclude: ['*.md', 'dist/**', '**/generated/*.ts'] });

  assert.equal(isExcluded('docs/guide/intro.md'), true);
  assert.equal(isExcluded('dist/a/b.js'), true);
  assert.equal(isExcluded('src\\generated\\api.ts'), true);
  assert.equal(isExcluded('src/generated/deep/api.ts'), false);
  assert.equal(isExcluded('src/dist/a.js'), false);
});

test('regex metacharacters in patterns are literal and ? matches one non-slash character', () => {
  const { isExcluded } = createFileFilters({ exclude: ['app.min.js', 'v?.txt', 'a+b.js'] });

  assert.equal(isExcluded('app.min.js'), true);
  assert.equal(isExcluded('appXminXjs'), false);
  assert.equal(isExcluded('v1.txt'), true);
  assert.equal(isExcluded('v12.txt'), false);
  assert.equal(isExcluded('a+b.js'), true);
  assert.equal(isExcluded('aab.js'), false);
});

test('missing config yields filters that match nothing', () => {
  const { isExcluded, isTestFile } = createFileFilters();

  assert.equal(isExcluded('anything.js'), false);
  assert.equal(isTestFile('anything.test.js'), false);
});

test('readOnlyPaths globs mark files as read-only, and a missing or malformed list marks none', () => {
  const { isReadOnlyPath } = createFileFilters({ readOnlyPaths: ['src/analyze/**', 'reports/*.sql', 42, ''] });
  assert.equal(isReadOnlyPath('src/analyze/run.py'), true);
  assert.equal(isReadOnlyPath('src/analyze/deep/query.py'), true);
  assert.equal(isReadOnlyPath('reports/monthly.sql'), true);
  assert.equal(isReadOnlyPath('src/ingest/run.py'), false);
  assert.equal(createFileFilters({}).isReadOnlyPath('src/analyze/run.py'), false);
  assert.equal(createFileFilters({ readOnlyPaths: 'src/analyze/**' }).isReadOnlyPath('src/analyze/run.py'), false);
});
