import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const collectorPath = fileURLToPath(new URL('../../review-tools-common/collect-diff.mjs', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../config.json', import.meta.url));

const CLEAN_BASE = 'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n';

const MESSY_FEATURE = [
  'export function describe(order, user, flags) {',
  '  const label = order.paid ? (order.shipped ? "done" : order.refunded ? "refunded" : "paid") : "open";',
  '  if (order.paid && order.shipped || user.admin && flags.force || order.refunded && user.owner || flags.debug && flags.verbose) {',
  '    return label;',
  '  }',
  `  // ${'This comment narrates the code in far more words than the code deserves, repeating itself. '.repeat(3)}`,
  '  const raw = JSON.parse(order.payload) as any;',
  '  const veryLongLine = order.items.map((item) => item.price * item.quantity).filter((value) => value > 0).reduce((a, b) => a + b, 0) + order.shippingCost;',
  '  return raw ?? veryLongLine;',
  '}',
  '',
].join('\n');

function git(directory, ...args) {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
}

function sweepFeatureBranch(directory) {
  const collected = spawnSync(process.execPath, [collectorPath, '--config', configPath, 'main'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(collected.status, 0, collected.stderr);
  const scanned = spawnSync(process.execPath, [scannerPath], {
    cwd: directory,
    encoding: 'utf8',
    input: collected.stdout,
  });
  assert.equal(scanned.status, 0, scanned.stderr);
  return JSON.parse(scanned.stdout);
}

test('a messy feature commit is flagged end to end, and a clean one is not', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-e2e-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'Code Sweeper Tests');
  git(directory, 'config', 'user.email', 'code-sweeper-tests@example.invalid');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', 'order.ts'), CLEAN_BASE);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'baseline');
  git(directory, 'checkout', '-qb', 'feature');

  writeFileSync(join(directory, 'src', 'order.ts'), `${CLEAN_BASE}\n${MESSY_FEATURE}`);
  git(directory, 'commit', '-qam', 'messy change');
  const messy = sweepFeatureBranch(directory);
  const flagged = new Set(messy.candidates.map((candidate) => candidate.ruleId));
  for (const ruleId of ['SWEEP-101', 'SWEEP-102', 'SWEEP-103', 'SWEEP-104', 'SWEEP-107']) {
    assert(flagged.has(ruleId), `expected ${ruleId}, got ${[...flagged].join(', ') || 'no candidates'}`);
  }
  assert(messy.candidates.every((candidate) => candidate.path === 'src/order.ts'));

  git(directory, 'checkout', '-q', 'main');
  git(directory, 'checkout', '-qb', 'tidy');
  writeFileSync(join(directory, 'src', 'order.ts'), `${CLEAN_BASE}\nexport const TAX = 0.2;\n`);
  git(directory, 'commit', '-qam', 'tidy change');
  assert.deepEqual(sweepFeatureBranch(directory).candidates, []);
});
