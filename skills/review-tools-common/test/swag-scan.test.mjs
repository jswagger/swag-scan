import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AGENTS, PlainError, configCommand, prepareRun, renderSummary, runScan } from '../swag-scan.mjs';

const script = fileURLToPath(new URL('../swag-scan.mjs', import.meta.url));

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** An environment whose config file (SWAG_SCAN_SETTINGS) is fully set up, so a CLI `run` never reads the real ~/.swag-scan. */
function configuredEnv(context, values = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'swag-config-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  writeFileSync(file, JSON.stringify({ ticketSourcePath: '', targetBranch: 'main', liveDashboard: true, autoFix: false, maxFileLines: 1000, ...values }));
  return { ...process.env, SWAG_SCAN_SETTINGS: file, SWAG_SCAN_TICKET_DIR: '' };
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
  assert.match(summary.text, /Ticket PROJ-123: No PROJ-123\.xml, PROJ-123\.md or PROJ-123\.txt found/);
});

test('unsupported languages show as unchecked in the summary', (context) => {
  const repo = fixture(context, { extra: { 'main.go': 'package main\n' } });
  const summary = runScan({ repo });
  assert.match(summary.text, /⚪ Unchecked: 1 file in Go/);
});

test('an empty diff warns the user to check the checked-out branch and the target branch in their config', (context) => {
  const repo = fixture(context);
  git(repo, ['checkout', '-q', 'main']);
  const summary = runScan({ repo });
  assert(summary.agents.every((agent) => agent.status === 'empty'));
  assert.match(summary.text, /Analyst \(Bug Hunter\): no changes to check\. I'm sorry, no changes against the target branch were found\. Please check your current branch that is checked out, and confirm your target branch is correct in your config\./);
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

  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: configuredEnv(context) });
  const bad = cli('run', '--repo', notRepo);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^.+ is not a git repository, so there is nothing to scan\.\n$/);
  assert.equal(cli('bogus').status, 1);
  assert.doesNotMatch(cli('run', '--nope').stderr, /at .*\.mjs/);
});

test('the CLI prints progress on stderr and the summary on stdout, or JSON with --json', (context) => {
  const repo = fixture(context);
  const env = configuredEnv(context);
  const text = spawnSync(process.execPath, [script, 'run', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stderr, /\[3\/3\] Security Guard/);
  assert.match(text.stdout, /^Swag Scan: feature\/PROJ-123 vs main · /);

  const json = JSON.parse(spawnSync(process.execPath, [script, 'run', '--repo', repo, '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.settings, { targetBranch: 'main', liveDashboard: true, autoFix: false, maxFileLines: 1000 });
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

test('an explicit --ticket path that does not exist stops the run and suggests the real path', (context) => {
  const repo = fixture(context);
  const tickets = mkdtempSync(join(tmpdir(), 'swag-tickets-'));
  context.after(() => rmSync(tickets, { recursive: true, force: true }));
  mkdirSync(join(tickets, 'sprint-4'), { recursive: true });
  writeFileSync(join(tickets, 'sprint-4', 'PROJ-456.md'), '## Acceptance Criteria\n\n- One thing\n');
  const typo = join(tickets, 'PROJ-456.md');
  assert.throws(() => runScan({ repo, ticket: typo }), (error) => {
    assert.ok(error instanceof PlainError);
    assert.match(error.message, /Ticket file not found/);
    assert.match(error.message, /did not start/);
    assert.ok(error.message.includes(join(tickets, 'sprint-4', 'PROJ-456.md')), 'suggests the real file');
    return true;
  });
});

test('an explicit --ticket ID that cannot be found also stops the run, but a branch-name ticket stays a note', (context) => {
  const repo = fixture(context);
  assert.throws(() => runScan({ repo, ticket: 'PROJ-999', ticketDir: join(repo, 'nowhere') }), PlainError);
  assert.doesNotThrow(() => runScan({ repo, ticketDir: join(repo, 'nowhere') }));
});

test('run asks for the config first, and starts nothing', (context) => {
  const repo = fixture(context);
  const empty = join(mkdtempSync(join(tmpdir(), 'swag-noconfig-')), 'settings.json');
  context.after(() => rmSync(join(empty, '..'), { recursive: true, force: true }));
  const env = { ...process.env, SWAG_SCAN_SETTINGS: empty };
  const result = spawnSync(process.execPath, [script, 'run', 'PROJ-123', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Please set up your config file first. Run /swag-scan:config to get started.\n');
  assert.equal(existsSync(join(repo, '.swag-scan')), false, 'no scan folder is created');

  // A file with only the older ticketFolder key is not a finished setup either.
  writeFileSync(empty, JSON.stringify({ ticketFolder: '/tickets' }));
  assert.throws(() => prepareRun({}, { env }), /Please set up your config file first/);
});

test('prepareRun takes the base branch from the config, and --base still overrides it', (context) => {
  const env = configuredEnv(context, { targetBranch: 'develop', maxFileLines: 800, autoFix: true });
  const prepared = prepareRun({ ticket: 'PROJ-1' }, { env });
  assert.equal(prepared.base, 'develop');
  assert.equal(prepared.ticket, 'PROJ-1');
  assert.deepEqual(prepared.settings, { targetBranch: 'develop', liveDashboard: true, autoFix: true, maxFileLines: 800 });
  assert.equal(prepareRun({ base: 'origin/main' }, { env }).base, 'origin/main');
});

test('a ticket ID typed after run is the ticket, and the config base is used', (context) => {
  const repo = fixture(context);
  const tickets = mkdtempSync(join(tmpdir(), 'swag-tickets-'));
  context.after(() => rmSync(tickets, { recursive: true, force: true }));
  writeFileSync(join(tickets, 'PROJ-123.md'), '# PROJ-123: Fix lookup\n\n## Acceptance Criteria\n\n1. Lookups are parameterized\n');
  const env = configuredEnv(context, { ticketSourcePath: tickets });
  const result = spawnSync(process.execPath, [script, 'run', 'PROJ-123', '--repo', repo, '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.base.ref, 'main');
  assert.equal(summary.base.autoDetected, false);
  assert.equal(summary.ticket.id, 'PROJ-123');
});

test('maxFileLines from the config reaches the Code Sweeper', (context) => {
  const lines = (count) => Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const repo = fixture(context, { extra: { 'big.js': lines(700) } });
  const sweeper = (limit) => runScan({ repo, base: 'main', fresh: true, settings: { maxFileLines: limit, autoFix: false } }).agents.find((agent) => agent.id === 'inspector');
  const rules = (agent) => JSON.parse(readFileSync(agent.files.scan, 'utf8')).candidates.map((candidate) => candidate.ruleId);
  assert.ok(rules(sweeper(500)).includes('SWEEP-111'), 'a 700-line file is over a 500-line limit');
  assert.ok(!rules(sweeper(1000)).includes('SWEEP-111'), 'and under a 1000-line limit');
});

test('config show, get and set work through the CLI and keep other keys', (context) => {
  const env = configuredEnv(context, { somethingElse: 'kept' });
  const cli = (...args) => spawnSync(process.execPath, [script, 'config', ...args], { encoding: 'utf8', env });
  assert.match(cli().stdout, /targetBranch: main[\s\S]*maxFileLines: 1000/);
  assert.equal(cli('get', 'liveDashboard').stdout, 'true\n');
  const saved = cli('set', 'targetBranch', 'develop', 'autoFix', 'true', 'maxFileLines', '1200');
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(cli('get', 'targetBranch').stdout, 'develop\n');
  const file = JSON.parse(readFileSync(env.SWAG_SCAN_SETTINGS, 'utf8'));
  assert.deepEqual([file.autoFix, file.maxFileLines, file.somethingElse], [true, 1200, 'kept']);
  const bad = cli('set', 'maxFileLines', 'lots');
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, 'maxFileLines must be a whole number of lines, such as 1000.\n');
  assert.equal(cli('nope').status, 1);
  assert.equal(JSON.parse(readFileSync(env.SWAG_SCAN_SETTINGS, 'utf8')).maxFileLines, 1200, 'a bad value changes nothing');
  assert.match(configCommand({ action: 'path', args: [] }, { env }), /settings\.json$/);
});

test('any branch name works: the checked-out branch is scanned and no naming convention is required', (context) => {
  for (const branch of ['wip/my_changes', 'JeremyStuff', 'no-ticket-id-here']) {
    const repo = fixture(context, { branch });
    const summary = runScan({ repo });
    assert.equal(summary.branch, branch);
    assert(summary.agents.every((agent) => agent.status === 'done'), `${branch} was scanned`);
    assert.equal(summary.ticket?.found ?? false, false, 'no ticket ID in the name means no ticket, not an error');
  }
});

test('a branch with the same name as the target branch has no diff, so the user gets the warning', (context) => {
  const repo = fixture(context, { branch: 'develop' });
  const summary = runScan({ repo, base: 'develop' });
  assert(summary.agents.every((agent) => agent.status === 'empty'));
  assert.match(summary.text, /no changes against the target branch were found/);
  assert.match(summary.text, /confirm your target branch is correct in your config/);
});

test('the repository can live on GitHub, Bitbucket or anywhere else: only local git is used', (context) => {
  for (const url of ['git@github.com:acme/app.git', 'https://bitbucket.org/acme/app.git', 'git@bitbucket.example.com:acme/app.git', 'ssh://git.internal.example/acme/app.git']) {
    const repo = fixture(context);
    git(repo, ['remote', 'add', 'origin', url]);
    const summary = runScan({ repo });
    assert(summary.agents.every((agent) => agent.status === 'done'), `${url} was scanned`);
  }
});

test('the report has no acceptance-criteria section and findings carry no criteria links', (context) => {
  const repo = fixture(context);
  const tickets = mkdtempSync(join(tmpdir(), 'swag-tickets-'));
  context.after(() => rmSync(tickets, { recursive: true, force: true }));
  writeFileSync(join(tickets, 'PROJ-123.md'), '## Description\n\nSafe lookups.\n\n## Acceptance Criteria\n\n| # | Title | Status |\n|---|---|---|\n| 1 | Parameterized queries | Done |\n');
  const summary = runScan({ repo, ticketDir: tickets });
  assert.equal(existsSync(join(repo, '.swag-scan', 'run', 'ticket-report.json')), true, 'the header still names the ticket');
  const saved = JSON.parse(readFileSync(join(repo, '.swag-scan', 'run', 'ticket-report.json'), 'utf8'));
  assert.equal('criteria' in saved, false);
  assert.equal('criteriaIds' in summary.ticket, false);
  const reviewerText = JSON.parse(readFileSync(join(repo, '.swag-scan', 'run', 'bug-hunter-context.json'), 'utf8')).ticket.content;
  assert.match(reviewerText, /Parameterized queries/, 'the criteria text still reaches the reviewers as context');
  assert.doesNotMatch(reviewerText, /Done/);
});
