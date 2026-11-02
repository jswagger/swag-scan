import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cacheKey, checkCache, storeCache, toolFingerprint } from '../cache.mjs';

const collector = fileURLToPath(new URL('../collect-diff.mjs', import.meta.url));
const bugHunterConfig = fileURLToPath(new URL('../../bug-hunter/config.json', import.meta.url));

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repo with `main` and a committed `feature` branch, a copied config, and a helper that collects the diff. */
function fixture(context) {
  const repo = mkdtempSync(join(tmpdir(), 'cache-repo-'));
  const aside = mkdtempSync(join(tmpdir(), 'cache-aside-'));
  context.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });
  });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  writeFileSync(join(repo, 'a.js'), 'export const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature/PROJ-1']);
  writeFileSync(join(repo, 'a.js'), 'export const a = 2;\n');
  git(repo, ['commit', '-qam', 'feature']);

  const config = join(aside, 'config.json');
  copyFileSync(bugHunterConfig, config);
  const diffPath = join(aside, 'diff.json');
  const collect = () => {
    const result = spawnSync(process.execPath, [collector, '--config', config], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(diffPath, result.stdout);
  };
  const report = join(aside, 'report.md');
  writeFileSync(report, '# report');
  collect();
  return { repo, aside, config, diffPath, collect, report, args: { tool: 'bug-hunter', configPath: config, diffPath, repo } };
}

test('a finished run is reused until a new commit, a config change, or a fresh request', (context) => {
  const { repo, args, report, collect, config } = fixture(context);

  const first = checkCache(args);
  assert.equal(first.hit, false);
  assert.equal(first.cacheable, true);
  assert.match(first.reason, /No cached result/);

  assert.equal(storeCache({ tool: 'bug-hunter', key: first.key, reports: [report], summary: '1 probable bug', repo }).stored, true);
  const second = checkCache(args);
  assert.equal(second.hit, true);
  assert.equal(second.key, first.key);
  assert.equal(second.entry.summary, '1 probable bug');
  assert.deepEqual(second.entry.reports, [report]);
  assert.match(second.reason, /no new commits/);

  assert.equal(checkCache({ ...args, fresh: true }).hit, false);

  writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), autoFix: true })}\n`);
  assert.equal(checkCache(args).hit, false, 'a config change must miss');
  copyFileSync(bugHunterConfig, config);
  assert.equal(checkCache(args).hit, true);

  git(repo, ['commit', '--allow-empty', '-qm', 'new commit']);
  collect();
  assert.equal(checkCache(args).hit, false, 'a new commit must miss');
});

test('uncommitted and untracked changes are never cached', (context) => {
  const { repo, args, collect } = fixture(context);
  writeFileSync(join(repo, 'a.js'), 'export const a = 3;\n');
  collect();
  let result = checkCache(args);
  assert.equal(result.cacheable, false);
  assert.match(result.reason, /uncommitted/);

  git(repo, ['checkout', '--', 'a.js']);
  writeFileSync(join(repo, 'new.js'), 'export const b = 1;\n');
  collect();
  result = checkCache(args);
  assert.equal(result.cacheable, false);
});

test('the cache folder does not make the tree look dirty', (context) => {
  const { repo, args, report, collect } = fixture(context);
  const { key } = checkCache(args);
  storeCache({ tool: 'bug-hunter', key, reports: [report], repo });
  collect();
  assert.equal(checkCache(args).hit, true);
});

test('a deleted report is a miss with an explanation', (context) => {
  const { repo, args, report } = fixture(context);
  const { key } = checkCache(args);
  storeCache({ tool: 'bug-hunter', key, reports: [report], repo });
  rmSync(report);
  const result = checkCache(args);
  assert.equal(result.hit, false);
  assert.match(result.reason, /report was deleted/);
});

test('an empty diff is not cacheable', (context) => {
  const { args, diffPath } = fixture(context);
  writeFileSync(diffPath, JSON.stringify({ emptyDiff: true, files: [], baseCommitHash: 'abc' }));
  assert.equal(checkCache(args).cacheable, false);
});

test('the key changes with the commit, base, config, ticket text and tool code', (context) => {
  const base = { tool: 'bug-hunter', head: 'h1', baseCommit: 'b1', configText: '{}', ticketText: 'AC', fingerprint: 'f' };
  const key = cacheKey(base);
  assert.equal(cacheKey({ ...base }), key);
  for (const change of [{ head: 'h2' }, { baseCommit: 'b2' }, { configText: '{ }' }, { ticketText: 'AC2' }, { fingerprint: 'g' }, { tool: 'code-sweeper' }]) {
    assert.notEqual(cacheKey({ ...base, ...change }), key, JSON.stringify(change));
  }

  const skill = mkdtempSync(join(tmpdir(), 'cache-skill-'));
  context.after(() => rmSync(skill, { recursive: true, force: true }));
  mkdirSync(join(skill, 'scripts'));
  writeFileSync(join(skill, 'SKILL.md'), 'one');
  writeFileSync(join(skill, 'scripts', 'x.mjs'), 'a');
  const before = toolFingerprint(skill);
  writeFileSync(join(skill, 'scripts', 'x.mjs'), 'b');
  assert.notEqual(toolFingerprint(skill), before);
});

test('the CLI checks and stores', (context) => {
  const { repo, config, diffPath, report } = fixture(context);
  const script = fileURLToPath(new URL('../cache.mjs', import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args, '--repo', repo], { encoding: 'utf8' }));
  const miss = run('check', '--tool', 'bug-hunter', '--config', config, '--diff', diffPath);
  assert.equal(miss.hit, false);
  assert.equal(run('store', '--tool', 'bug-hunter', '--key', miss.key, '--report', report, '--summary', 'ok').stored, true);
  assert.equal(run('check', '--tool', 'bug-hunter', '--config', config, '--diff', diffPath).hit, true);
  assert.equal(run('store', '--tool', 'bug-hunter', '--key', 'null', '--report', report).stored, false);
});
