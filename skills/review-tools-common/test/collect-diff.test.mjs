import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const collectorPath = fileURLToPath(new URL('../collect-diff.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../../security-auditor/config.json', import.meta.url));
const bugHunterConfigPath = fileURLToPath(new URL('../../bug-hunter/config.json', import.meta.url));
const codeSweeperConfigPath = fileURLToPath(new URL('../../code-sweeper/config.json', import.meta.url));

function git(directory, args) {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
}

test('collector parses added, modified, and deleted Git paths', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-diff-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'delete.py'), 'value = 1\n');
  writeFileSync(join(directory, 'modify.py'), 'value = 1\n');
  git(directory, ['add', 'delete.py', 'modify.py']);
  git(directory, ['commit', '-qm', 'baseline']);

  rmSync(join(directory, 'delete.py'));
  writeFileSync(join(directory, 'modify.py'), 'value = 2\n');
  writeFileSync(join(directory, 'added.py'), 'value = 3\n');
  git(directory, ['add', '-A']);

  const result = spawnSync(process.execPath, [collectorPath, '--config', configPath, 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const files = new Map(report.files.map((file) => [file.path, file]));
  assert.equal(files.get('added.py')?.status, 'added');
  assert.equal(files.get('modify.py')?.status, 'modified');
  assert.equal(files.get('delete.py')?.status, 'deleted');
  assert.equal(report.files.some((file) => file.path === 'ev/null'), false);
  assert.deepEqual(files.get('added.py').changes.map((change) => change.side), ['added']);
  assert.deepEqual(files.get('delete.py').changes.map((change) => change.side), ['removed']);
});

test('collector preserves column-zero plus/minus content and subsequent line numbers', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-diff-markers-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'markers.py'), 'head one\nhead two\n-- note about sql\nold();\ntail();\n');
  git(directory, ['add', 'markers.py']);
  git(directory, ['commit', '-qm', 'baseline']);
  writeFileSync(join(directory, 'markers.py'), 'head one\nhead two\n++counter;\nfresh();\nmore();\ntail();\n');

  const result = spawnSync(process.execPath, [collectorPath, '--config', codeSweeperConfigPath, 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const changes = report.files.find((file) => file.path === 'markers.py').changes;
  assert.deepEqual(changes, [
    { side: 'removed', line: 3, text: '-- note about sql' },
    { side: 'removed', line: 4, text: 'old();' },
    { side: 'added', line: 3, text: '++counter;' },
    { side: 'added', line: 4, text: 'fresh();' },
    { side: 'added', line: 5, text: 'more();' },
  ]);
});

test('target refs compare from the merge base and retain working-tree changes', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-merge-base-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'base.py'), 'base_value = 1\n');
  git(directory, ['add', 'base.py']);
  git(directory, ['commit', '-qm', 'baseline']);
  const mergeBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  git(directory, ['branch', 'target']);
  git(directory, ['checkout', '-q', 'target']);
  writeFileSync(join(directory, 'target_only.py'), 'target_value = 1\n');
  git(directory, ['add', 'target_only.py']);
  git(directory, ['commit', '-qm', 'target change']);

  git(directory, ['checkout', '-q', '-b', 'feature', mergeBase]);
  writeFileSync(join(directory, 'feature.py'), 'feature_value = 1\n');
  git(directory, ['add', 'feature.py']);
  git(directory, ['commit', '-qm', 'feature change']);
  writeFileSync(join(directory, 'working.py'), 'working_value = 1\n');

  const result = spawnSync(process.execPath, [collectorPath, '--config', configPath, 'target'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const files = new Map(report.files.map((file) => [file.path, file]));
  assert.equal(report.comparisonBase, mergeBase);
  assert.equal(files.get('feature.py')?.status, 'added');
  assert.equal(files.get('working.py')?.status, 'untracked');
  assert.equal(files.has('target_only.py'), false);
});

function newRepo(context, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  return directory;
}

function commitFile(directory, name, content, message = name) {
  writeFileSync(join(directory, name), content);
  git(directory, ['add', name]);
  git(directory, ['commit', '-qm', message]);
}

function collect(directory, ...extra) {
  return collectWith(configPath, directory, ...extra);
}

function collectWith(config, directory, ...extra) {
  const result = spawnSync(process.execPath, [collectorPath, '--config', config, ...extra], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), stderr: result.stderr };
}

test('auto base picks origin/HEAD when configured, and main on a committed feature branch', (context) => {
  const directory = newRepo(context, 'collect-auto-base-');
  commitFile(directory, 'base.py', 'value = 1\n');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  git(directory, ['checkout', '-q', '-b', 'feature/PROJ-1']);
  commitFile(directory, 'feature.py', 'value = 2\n');

  const { report, stderr } = collect(directory);
  assert.equal(report.requestedBaseRef, 'auto');
  assert.equal(report.baseRef, 'main');
  assert.equal(report.autoDetected, true);
  assert.equal(report.comparisonBase, head);
  assert.equal(report.emptyDiff, false);
  assert.deepEqual(report.files.map((file) => file.path), ['feature.py']);
  assert.match(stderr, /resolved base main to [a-f0-9]{40} \(\d{4}-\d\d-\d\dT[^)]*\), auto-detected/);
  assert.match(stderr, /1 changed, 0 excluded, 1 scanned; diff 0\.0 KB/);

  git(directory, ['update-ref', 'refs/remotes/origin/main', head]);
  git(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const detected = collect(directory).report;
  assert.equal(detected.baseRef, 'origin/HEAD');
  assert.equal(detected.comparisonBase, head);
  assert.deepEqual(detected.files.map((file) => file.path), ['feature.py']);
});

test('auto base prefers the closest branch the work was cut from', (context) => {
  const directory = newRepo(context, 'collect-closest-base-');
  commitFile(directory, 'base.py', 'value = 1\n');
  git(directory, ['checkout', '-q', '-b', 'develop']);
  commitFile(directory, 'develop.py', 'value = 2\n');
  git(directory, ['checkout', '-q', '-b', 'feature/PROJ-2']);
  commitFile(directory, 'feature.py', 'value = 3\n');

  const { report } = collect(directory);
  assert.equal(report.baseRef, 'develop');
  assert.deepEqual(report.files.map((file) => file.path), ['feature.py']);
});

test('auto base falls back to HEAD when no base branch exists', (context) => {
  const directory = newRepo(context, 'collect-no-base-');
  git(directory, ['checkout', '-q', '-b', 'work']);
  commitFile(directory, 'base.py', 'value = 1\n');
  const { report } = collect(directory);
  assert.equal(report.baseRef, 'HEAD');
  assert.equal(report.autoDetected, false);
  assert.match(report.note, /No base branch/);
});

test('an empty diff is reported in one sentence with a suggested ref', (context) => {
  const directory = newRepo(context, 'collect-empty-');
  commitFile(directory, 'base.py', 'value = 1\n');
  git(directory, ['checkout', '-q', '-b', 'feature/PROJ-3']);
  commitFile(directory, 'feature.py', 'value = 2\n');

  // Explicit HEAD base on a committed branch: nothing uncommitted, so the diff is empty.
  const { report, stderr } = collect(directory, 'HEAD');
  assert.equal(report.emptyDiff, true);
  assert.equal(report.files.length, 0);
  assert.match(report.suggestion, /`main`.*1 commit ahead/);
  assert.match(stderr, /no changes found against HEAD\. Try a different base, for example `main`/);

  git(directory, ['checkout', '-q', 'main']);
  const onMain = collect(directory).report;
  assert.equal(onMain.emptyDiff, true);
  assert.match(onMain.suggestion, /Commit or stage your changes/);
});

test('the summary reports changed, excluded and scanned counts with the gate size', (context) => {
  const directory = newRepo(context, 'collect-summary-');
  commitFile(directory, 'base.py', 'value = 1\n');
  git(directory, ['checkout', '-q', '-b', 'feature/PROJ-4']);
  writeFileSync(join(directory, 'feature.py'), 'value = 2\n');
  writeFileSync(join(directory, 'notes.md'), '# notes\n');
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-qm', 'feature']);

  const { report, stderr } = collectWith(bugHunterConfigPath, directory);
  assert.equal(report.changedCount, 2);
  assert.equal(report.excludedCount, 1);
  assert.equal(report.diffBytes, 'value = 2'.length + 1);
  assert.match(stderr, /2 changed, 1 excluded, 1 scanned; diff 0\.0 KB of 100\.0 KB gate/);
});

test('collector skips JS/TS generated artifacts and untracked files with tracked siblings', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-generated-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  mkdirSync(join(directory, 'src'), { recursive: true });
  mkdirSync(join(directory, 'config'), { recursive: true });
  writeFileSync(join(directory, 'src', 'module.ts'), 'export const value = 1;\n');
  git(directory, ['add', 'src/module.ts']);
  git(directory, ['commit', '-qm', 'baseline']);

  writeFileSync(join(directory, 'src', 'module.js'), 'export const value = 1;\n');
  writeFileSync(join(directory, 'src', 'notes.py'), 'value = 1\n');
  writeFileSync(join(directory, 'src', 'module.d.ts'), 'export declare const value: number;\n');
  writeFileSync(join(directory, 'config', 'generated.js'), 'module.exports = {};\n');
  writeFileSync(join(directory, 'build.tsbuildinfo'), '{}\n');

  const result = spawnSync(process.execPath, [collectorPath, '--config', codeSweeperConfigPath, 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const collectedPaths = report.files.map((file) => file.path);
  assert(collectedPaths.includes('src/notes.py'));
  assert.equal(collectedPaths.includes('src/module.js'), false);
  assert.equal(collectedPaths.includes('src/module.d.ts'), false);
  assert.equal(collectedPaths.includes('config/generated.js'), false);
  assert.equal(collectedPaths.includes('build.tsbuildinfo'), false);
  assert.equal(report.excludedCount, 3);
  assert.match(result.stderr, /resolved base HEAD to [a-f0-9]{40} \(\d{4}-\d\d-\d\dT/);
  assert.match(result.stderr, /3 excluded files/);
  assert(report.skipped.some((file) => file.path === 'src/module.js' && /tracked.*sibling/.test(file.reason)));
});
test('the tools\' own output folders are never part of the diff', (context) => {
  const directory = newRepo(context, 'collect-tool-output-');
  commitFile(directory, 'base.py', 'value = 1\n');
  git(directory, ['checkout', '-q', '-b', 'feature/PROJ-5']);
  mkdirSync(join(directory, '.swag-scan', 'run'), { recursive: true });
  mkdirSync(join(directory, '.bug-hunter', 'reports'), { recursive: true });
  writeFileSync(join(directory, '.swag-scan', 'run', 'scan.py'), 'leak = 1\n');
  writeFileSync(join(directory, '.bug-hunter', 'reports', 'report.py'), 'leak = 2\n');
  writeFileSync(join(directory, 'real.py'), 'value = 2\n');

  const { report } = collect(directory);
  assert.deepEqual(report.files.map((file) => file.path), ['real.py']);
  assert.equal(report.excludedCount, 2);
});

test('collector skips fixture folders for untracked files and warns when untracked files dwarf the branch diff', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-untracked-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'app.py'), 'value = 1\n');
  git(directory, ['add', 'app.py']);
  git(directory, ['commit', '-qm', 'baseline']);
  writeFileSync(join(directory, 'app.py'), 'value = 2\n');

  mkdirSync(join(directory, 'tests', 'testdata'), { recursive: true });
  mkdirSync(join(directory, 'local-data'), { recursive: true });
  for (let index = 0; index < 25; index += 1) {
    writeFileSync(join(directory, 'tests', 'testdata', `case${index}.py`), 'x = 1\n');
    writeFileSync(join(directory, 'local-data', `row${index}.py`), 'x = 1\n');
  }

  const result = spawnSync(process.execPath, [collectorPath, '--config', codeSweeperConfigPath, 'HEAD'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const paths = report.files.map((file) => file.path);
  assert.equal(paths.some((path) => path.includes('testdata/')), false, 'fixture folders are skipped');
  assert.equal(report.branchDiffCount, 1);
  assert.equal(report.untrackedCount, 25);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /25 of the scanned files are untracked, but the branch diff has only 1/);
  assert.match(report.warnings[0], /\.git\/info\/exclude/);
  assert.match(result.stderr, /warning: 25 of the scanned files are untracked/);

  rmSync(join(directory, 'local-data'), { recursive: true });
  const quiet = JSON.parse(spawnSync(process.execPath, [collectorPath, '--config', codeSweeperConfigPath, 'HEAD'], { cwd: directory, encoding: 'utf8' }).stdout);
  assert.deepEqual(quiet.warnings, [], 'no warning without a flood of untracked files');
});

test('collector warns when another base branch makes the same change much smaller', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-base-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const commitAll = (message) => { git(directory, ['add', '-A']); git(directory, ['commit', '-qm', message]); };

  git(directory, ['init', '-q', '-b', 'develop']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'seed.py'), 'x = 1\n');
  commitAll('seed');
  // "test" is a later branch that already holds 30 files that develop does not.
  git(directory, ['checkout', '-q', '-b', 'test']);
  for (let index = 0; index < 30; index += 1) writeFileSync(join(directory, `other${index}.py`), 'y = 1\n');
  commitAll('other work');
  git(directory, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(directory, 'mine.py'), 'z = 1\n');
  commitAll('my change');

  const run = (base) => JSON.parse(spawnSync(process.execPath, [collectorPath, '--config', codeSweeperConfigPath, base], { cwd: directory, encoding: 'utf8' }).stdout);
  const wrong = run('develop');
  assert.equal(wrong.changedCount, 31);
  assert.equal(wrong.warnings.length, 1);
  assert.match(wrong.warnings[0], /Against develop this change touches 31 files, but against test only 1\./);
  assert.deepEqual(run('test').warnings, [], 'the right base gets no warning');
});
