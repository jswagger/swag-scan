import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AGENTS, PlainError, renderSummary, runScan } from '../swag-scan.mjs';

const script = fileURLToPath(new URL('../swag-scan.mjs', import.meta.url));

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const BASE = `export async function getUser(db, id) {
  if (!id) throw new Error('id required');
  try {
    return await db.query('SELECT * FROM users WHERE id = ?', [id]);
  } catch (e) {
    throw new Error('lookup failed');
  }
}
`;
const FEATURE = `export function getUser(db, id) {
  // const old = db.legacy(id);
  // TODO remove
  return db.query("SELECT * FROM users WHERE id = " + id);
}
`;

/** A repo with `main` and a committed feature branch that removes a guard and adds SQL concatenation. */
function fixture(context, { branch = 'feature/PROJ-123', extra } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'swag-scan-'));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  writeFileSync(join(repo, 'app.js'), BASE);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(repo, 'app.js'), FEATURE);
  for (const [name, content] of Object.entries(extra ?? {})) writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'feature']);
  return repo;
}

test('runs every agent in a fixed order, report-only, with no model tokens', (context) => {
  const repo = fixture(context);
  const log = [];
  const summary = runScan({ repo, log: (line) => log.push(line) });

  assert.deepEqual(summary.agents.map((agent) => agent.id), AGENTS.map((agent) => agent.id));
  assert.match(log[0], /Running: Analyst, Inspector, Security Guard · scripts only, report-only, no model tokens/);
  assert.match(log[1], /^\[1\/3\] Analyst · Bug Hunter: \d+ leads? \(/);
  assert.match(log[3], /^\[3\/3\] Security Guard · Security Auditor/);
  assert.equal(summary.modelTokens, 0);
  assert.equal(summary.mode, 'report-only');
  assert.equal(summary.base.ref, 'main');
  assert.equal(summary.base.autoDetected, true);
  assert(summary.agents.find((agent) => agent.id === 'analyst').leads > 0, 'removed guard should be a lead');
  assert(summary.agents.find((agent) => agent.id === 'security-guard').leads > 0, 'SQL concatenation should be a lead');

  assert.equal(git(repo, ['diff', 'HEAD']), '', 'the scan must not edit tracked files');
  assert(existsSync(join(repo, '.swag-scan', 'run', 'summary.json')));
  assert(existsSync(join(repo, '.swag-scan', 'run', 'bug-hunter-packets.json')));
  assert.match(summary.text, /Leads come from scripts and are not verified findings/);
});

test('a second run gives the same answer: the tools do not scan their own output', (context) => {
  const repo = fixture(context);
  const leads = (summary) => summary.agents.map((agent) => [agent.id, agent.leads, agent.scannedCount]);
  const first = runScan({ repo });
  const second = runScan({ repo });
  assert.deepEqual(leads(second), leads(first));
});

test('the ticket is found from the branch name and reported', (context) => {
  const repo = fixture(context);
  const tickets = mkdtempSync(join(tmpdir(), 'swag-tickets-'));
  context.after(() => rmSync(tickets, { recursive: true, force: true }));
  writeFileSync(join(tickets, 'PROJ-123.md'), '## Description\n\nSafe lookups.\n\n## Acceptance Criteria\n\n- Use parameterized queries\n- Keep the id guard\n\n## Dev Log\n\nremoved the guard\n');

  const summary = runScan({ repo, ticketDir: tickets });
  assert.equal(summary.ticket.found, true);
  assert.equal(summary.ticket.id, 'PROJ-123');
  assert.equal(summary.ticket.source, 'branch name');
  assert.equal(summary.ticket.criteria, 2);
  assert.match(summary.text, /Ticket PROJ-123 \(from branch name\): 2 acceptance criteria/);
  const context_ = JSON.parse(readFileSync(join(repo, '.swag-scan', 'run', 'bug-hunter-context.json'), 'utf8'));
  assert.doesNotMatch(context_.ticket.content, /removed the guard/);
});

test('a missing ticket folder is one short line, not a failure', (context) => {
  const repo = fixture(context);
  const summary = runScan({ repo, ticketDir: join(repo, 'nowhere') });
  assert.match(summary.text, /Ticket PROJ-123: No PROJ-123\.md or PROJ-123\.txt found/);
});

test('unsupported languages show as unchecked in the summary', (context) => {
  const repo = fixture(context, { extra: { 'main.go': 'package main\n' } });
  const summary = runScan({ repo });
  assert.match(summary.text, /⚪ Unchecked: 1 file in Go/);
});

test('an empty diff is one sentence per agent with a suggestion', (context) => {
  const repo = fixture(context);
  git(repo, ['checkout', '-q', 'main']);
  const summary = runScan({ repo });
  assert(summary.agents.every((agent) => agent.status === 'empty'));
  assert.match(summary.text, /Analyst \(Bug Hunter\): no changes to check\. Commit or stage/);
});

test('--agents limits who runs, in the fixed order', (context) => {
  const repo = fixture(context);
  const summary = runScan({ repo, agents: ['security-guard', 'analyst'] });
  assert.deepEqual(summary.agents.map((agent) => agent.id), ['analyst', 'security-guard']);
});

test('--base overrides the detected base', (context) => {
  const repo = fixture(context);
  const summary = runScan({ repo, base: 'main' });
  assert.equal(summary.base.autoDetected, false);
});

test('plain errors, never a stack trace', (context) => {
  const notRepo = mkdtempSync(join(tmpdir(), 'swag-norepo-'));
  context.after(() => rmSync(notRepo, { recursive: true, force: true }));
  assert.throws(() => runScan({ repo: notRepo }), (error) => error instanceof PlainError && /is not a git repository/.test(error.message));
  assert.throws(() => runScan({ repo: fixture(context), agents: ['wizard'] }), /Unknown agent "wizard"/);

  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const bad = cli('run', '--repo', notRepo);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^.+ is not a git repository, so there is nothing to scan\.\n$/);
  assert.equal(cli('bogus').status, 1);
  assert.doesNotMatch(cli('run', '--nope').stderr, /at .*\.mjs/);
});

test('the CLI prints progress on stderr and the summary on stdout, or JSON with --json', (context) => {
  const repo = fixture(context);
  const text = spawnSync(process.execPath, [script, 'run', '--repo', repo], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stderr, /\[3\/3\] Security Guard/);
  assert.match(text.stdout, /^Swag Scan: feature\/PROJ-123 vs main \(auto-detected\)/);

  const json = JSON.parse(spawnSync(process.execPath, [script, 'run', '--repo', repo, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.agents.length, 3);
});

test('a stored review is reported as already reviewed on the next run, until a new commit', (context) => {
  const repo = fixture(context);
  const outside = mkdtempSync(join(tmpdir(), 'swag-reports-'));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  const find = (summary) => summary.agents.find((agent) => agent.id === 'analyst');

  const first = find(runScan({ repo }));
  assert.equal(first.cache.hit, false);
  assert.equal(first.cache.cacheable, true);

  const report = join(outside, 'r.md');
  writeFileSync(report, '# report');
  execFileSync(process.execPath, [fileURLToPath(new URL('../cache.mjs', import.meta.url)), 'store', '--tool', 'bug-hunter', '--key', first.cache.key, '--report', report, '--summary', '1 probable bug', '--repo', repo]);

  const again = runScan({ repo });
  assert.equal(find(again).cache.hit, true);
  assert.equal(find(again).cache.summary, '1 probable bug');
  assert.match(again.text, /Analyst \(Bug Hunter\): \d+ leads? in \d+ files? · already reviewed at this commit/);
  assert.equal(find(runScan({ repo, fresh: true })).cache.hit, false);

  git(repo, ['commit', '--allow-empty', '-qm', 'another']);
  assert.equal(find(runScan({ repo })).cache.hit, false);
});

test('the summary shows the branch-diff versus untracked split and any untracked-flood warning', () => {
  const agent = { name: 'Analyst', tool: 'bug-hunter', status: 'done', leads: 1, scannedCount: 691, branchDiffCount: 3, untrackedCount: 688, warnings: ['688 of the scanned files are untracked, but the branch diff has only 3. Exclude them.'] };
  const text = renderSummary({ branch: 'feature', base: { ref: 'origin/test' }, modelTokens: 0, agents: [agent, { ...agent, name: 'Inspector', tool: 'code-sweeper' }], runDir: '.swag-scan/run' });
  assert.match(text, /Scanned 691 files: 3 in the branch diff, 688 untracked\./);
  assert.equal(text.match(/Warning: 688 of the scanned files are untracked/g).length, 1, 'the same warning is shown once');
  const clean = renderSummary({ branch: 'feature', base: { ref: 'main' }, modelTokens: 0, agents: [{ ...agent, untrackedCount: 0, warnings: [] }], runDir: '.swag-scan/run' });
  assert.doesNotMatch(clean, /untracked|Warning/);
});
