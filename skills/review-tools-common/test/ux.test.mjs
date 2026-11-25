// SS-109: user experience. Branch detection and its errors, the per-repository branch, a run with no config, the local
// ignore rule, the Node/git preflight, `doctor`, the "no supported language" line and plain step errors.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { listBranches, missingBranchMessage, noBaseWarning, suggestBranch } from '../branches.mjs';
import { saveRepoBranch, loadSettings, targetBranchFor } from '../settings.mjs';
import { PlainError, configCommand, doctor, ensureLocalExclude, plainStepError, preflight, prepareRun, renderSummary, runScan } from '../swag-scan.mjs';

const script = fileURLToPath(new URL('../swag-scan.mjs', import.meta.url));
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function temp(context, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A repo whose default branch has the given name, with a feature branch one commit ahead that changes `files`. */
function repoWith(context, { base = 'main', files = { 'app.js': 'export const a = 1;\n' }, changed = { 'app.js': 'export const a = 2;\n' } } = {}) {
  const repo = temp(context, 'swag-ux-');
  git(repo, ['init', '-q', '-b', base]);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature/work']);
  for (const [name, content] of Object.entries(changed)) writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'change']);
  return repo;
}

/** A settings file path inside a temp folder, as an environment for the CLI and the library calls. */
function settingsEnv(context, values) {
  const directory = temp(context, 'swag-ux-config-');
  const file = join(directory, 'settings.json');
  if (values) writeFileSync(file, JSON.stringify(values));
  return { ...process.env, SWAG_SCAN_SETTINGS: file, SWAG_SCAN_TICKET_DIR: '' };
}

const FULL = { ticketSourcePath: '', targetBranch: 'auto', liveDashboard: true, autoFix: false, maxFileLines: 1000 };

test('branch helpers list what exists, never HEAD, and suggest a sensible target', () => {
  const runGit = () => 'refs/heads/feature/x\nrefs/heads/master\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/master\nrefs/remotes/origin/develop\n';
  assert.deepEqual(listBranches(runGit), ['feature/x', 'master', 'develop']);
  assert.deepEqual(listBranches(() => { throw new Error('no git'); }), []);
  assert.equal(suggestBranch(['feature/x', 'master', 'develop'], 'feature/x'), 'develop');
  assert.equal(suggestBranch(['feature/x', 'master'], 'feature/x'), 'master');
  assert.equal(suggestBranch(['feature/x', 'release'], 'feature/x'), 'release');
  assert.equal(suggestBranch(['main'], 'main'), undefined, 'never suggests the branch that is checked out');
});

test('a missing target branch message lists the branches found, suggests one and says how to fix it', () => {
  const message = missingBranchMessage('main', ['feature/x', 'master'], 'feature/x');
  assert.match(message, /could not find a branch named "main"/);
  assert.match(message, /Branches I found: feature\/x, master\./);
  assert.match(message, /Did you mean "master"\?/);
  assert.match(message, /\/swag-scan:config/);
  assert.match(message, /--this-repo/);
  assert.match(missingBranchMessage('main', [], ''), /did not find any other branches/);
  const many = missingBranchMessage('x', Array.from({ length: 12 }, (_, i) => `b${i}`), 'zzz');
  assert.match(many, /and 4 more/);
  assert.match(noBaseWarning(['master'], 'feature/x'), /Did you mean "master"\?/);
});

test('auto-detection finds master, develop and origin-only branches, so a master repo no longer fails', (context) => {
  const master = repoWith(context, { base: 'master' });
  const summary = runScan({ repo: master, base: 'auto' });
  assert.equal(summary.base.ref, 'master');
  assert.equal(summary.base.autoDetected, true);

  // Only origin/main exists: no local main branch.
  const remoteOnly = repoWith(context);
  git(remoteOnly, ['update-ref', 'refs/remotes/origin/main', 'main']);
  git(remoteOnly, ['branch', '-D', 'main']);
  assert.equal(runScan({ repo: remoteOnly, base: 'auto' }).base.ref, 'origin/main');
});

test('an explicit "main" still works when only origin/main exists', (context) => {
  const repo = repoWith(context);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  git(repo, ['branch', '-D', 'main']);
  assert.equal(runScan({ repo, base: 'main' }).base.ref, 'origin/main');
});

test('an explicit branch that does not exist stops with the branches found and a suggestion', (context) => {
  const repo = repoWith(context, { base: 'master' });
  assert.throws(() => runScan({ repo, base: 'main' }), (error) => {
    assert(error instanceof PlainError);
    assert.match(error.message, /^I could not find a branch named "main" in this repository\./);
    assert.match(error.message, /Branches I found: feature\/work, master\./);
    assert.match(error.message, /Did you mean "master"\?/);
    assert.doesNotMatch(error.message, /collect-diff|\.mjs|fatal:|Not a valid object name/);
    return true;
  });
});

test('with no branch to compare against at all, the scan still runs and the warning lists what exists', (context) => {
  const repo = repoWith(context, { base: 'trunk' });
  git(repo, ['branch', '-m', 'trunk', 'trunk2']);
  const summary = runScan({ repo, base: 'auto' });
  const warnings = summary.agents.flatMap((agent) => agent.warnings ?? []);
  assert.ok(warnings.some((warning) => /could not find a branch to compare against/.test(warning) && /trunk2/.test(warning)), warnings.join('\n'));
});

test('the target branch is per repository first, then the config, then auto, and --base beats all of them', (context) => {
  const env = settingsEnv(context, { ...FULL, targetBranch: 'develop' });
  const one = repoWith(context);
  const two = repoWith(context);
  const prepared = (repo, options = {}) => prepareRun({ repo, ...options }, { env });
  assert.equal(prepared(one).base, 'develop', 'the config applies everywhere');

  const saved = saveRepoBranch(one, 'staging', env);
  assert.equal(targetBranchFor(saved, one).branch, 'staging');
  assert.equal(targetBranchFor(saved, one).source, 'this repository');
  assert.equal(prepared(one).base, 'staging');
  assert.equal(prepared(two).base, 'develop', 'another repository keeps the config value');
  assert.equal(prepared(one, { base: 'release' }).base, 'release', '--base wins');
  assert.equal(JSON.parse(readFileSync(env.SWAG_SCAN_SETTINGS, 'utf8')).targetBranch, 'develop', 'the other keys are kept');
  assert.equal(loadSettings(env).configured, true, 'an override does not change whether the config is set up');

  saveRepoBranch(one, '', env);
  assert.equal(prepared(one).base, 'develop');
  assert.equal(JSON.parse(readFileSync(env.SWAG_SCAN_SETTINGS, 'utf8')).repoTargetBranches, undefined, 'the empty map is removed');
});

test('config set targetBranch --this-repo saves for this repository only, and show, get and unset follow it', (context) => {
  const env = settingsEnv(context, FULL);
  const repo = repoWith(context);
  const cli = (...args) => spawnSync(process.execPath, [script, 'config', ...args, '--repo', repo], { encoding: 'utf8', env });
  const set = cli('set', 'targetBranch', 'staging', '--this-repo');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /compare against staging/);
  assert.match(set.stdout, /Other repositories keep using auto/);
  assert.equal(cli('get', 'targetBranch', '--this-repo').stdout, 'staging\n');
  assert.equal(cli('get', 'targetBranch').stdout, 'auto\n', 'the plain get is still the global value');
  assert.match(cli('show').stdout, /targetBranch for this repository: staging/);
  assert.equal(JSON.parse(cli('show', '--json').stdout).repoTargetBranch, 'staging');
  assert.equal(cli('unset', 'targetBranch', '--this-repo').status, 0);
  assert.equal(cli('get', 'targetBranch', '--this-repo').stdout, 'auto\n');

  assert.match(cli('set', 'maxFileLines', '5', '--this-repo').stderr, /Usage: config set targetBranch <branch> --this-repo/);
  assert.match(cli('set', 'targetBranch', 'two words', '--this-repo').stderr, /not a branch name/);
  const outside = spawnSync(process.execPath, [script, 'config', 'set', 'targetBranch', 'x', '--this-repo', '--repo', tmpdir()], { encoding: 'utf8', env });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /not a git repository/);
});

test('the first run adds .swag-scan/ to .git/info/exclude once, and leaves a repository that already ignores it alone', (context) => {
  const repo = repoWith(context);
  const log = [];
  runScan({ repo, base: 'main', log: (line) => log.push(line) });
  assert.ok(log.some((line) => /Added \.swag-scan\/ to \.git\/info\/exclude/.test(line)));
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.swag-scan\/$/m);
  assert.equal(git(repo, ['status', '--porcelain']).includes('.swag-scan'), false, 'the folder no longer shows in git status');

  const again = [];
  runScan({ repo, base: 'main', log: (line) => again.push(line) });
  assert.equal(again.some((line) => /Added \.swag-scan/.test(line)), false, 'the second run says nothing');
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/\.swag-scan\//g).length, 1);

  const ignored = repoWith(context);
  writeFileSync(join(ignored, '.gitignore'), '.swag-scan/\n');
  mkdirSync(join(ignored, '.swag-scan', 'run'), { recursive: true });
  assert.equal(ensureLocalExclude(ignored), false);
  assert.equal(/\.swag-scan/.test(readFileSync(join(ignored, '.git', 'info', 'exclude'), 'utf8')), false);

  const noNewline = repoWith(context);
  writeFileSync(join(noNewline, '.git', 'info', 'exclude'), '# mine\n*.tmp');
  mkdirSync(join(noNewline, '.swag-scan', 'run'), { recursive: true });
  assert.equal(ensureLocalExclude(noNewline), true);
  assert.equal(readFileSync(join(noNewline, '.git', 'info', 'exclude'), 'utf8'), '# mine\n*.tmp\n.swag-scan/\n', 'existing lines are kept');
  assert.equal(ensureLocalExclude(tmpdir()), false, 'outside a repository it does nothing');
});

test('preflight stops on Node older than 22 or a missing git, and only warns about other Node versions', () => {
  assert.deepEqual(preflight({ nodeVersion: '22.4.0', git: '2.43.0' }), { problems: [], warnings: [] });
  assert.deepEqual(preflight({ nodeVersion: '24.1.0', git: '2.43.0' }), { problems: [], warnings: [] });
  const old = preflight({ nodeVersion: '20.11.1', git: '2.43.0' });
  assert.equal(old.problems.length, 1);
  assert.match(old.problems[0], /needs Node 22 or 24, and this is Node 20\.11\.1/);
  assert.match(old.problems[0], /nodejs\.org/);
  assert.match(preflight({ nodeVersion: '23.0.0', git: '2.43.0' }).warnings[0], /not one Swag Scan is tested on/);
  assert.equal(preflight({ nodeVersion: '23.0.0', git: '2.43.0' }).problems.length, 0);
  const noGit = preflight({ nodeVersion: '24.0.0', git: null });
  assert.match(noGit.problems[0], /needs git, and it was not found/);
});

test('doctor checks Node, git, the repository, the base branch, the ticket folder and the ignore rule', (context) => {
  const repo = repoWith(context);
  const env = settingsEnv(context, { ...FULL, ticketSourcePath: join(tmpdir(), 'no-such-ticket-folder-ss109') });
  const ok = doctor({ repo }, { env });
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /^Swag Scan doctor: ready to run/);
  assert.match(ok.text, /✅ Node: Node \d+/);
  assert.match(ok.text, /✅ Base branch: auto-detect would consider: main/);
  assert.match(ok.text, /🟡 Ticket folder: .*does not exist/);
  assert.match(ok.text, /\.swag-scan\/ is not ignored yet; the first run adds it/);
  runScan({ repo, base: 'main' });
  assert.match(doctor({ repo }, { env }).text, /\.swag-scan\/ is already ignored by git/);

  const wrong = settingsEnv(context, { ...FULL, targetBranch: 'nope' });
  const bad = doctor({ repo }, { env: wrong });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /🔴 Base branch: nope \(from your config\) does not exist here/);
  assert.match(bad.text, /Next step: I could not find a branch named "nope"/);

  const outside = doctor({ repo: tmpdir() }, { env });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /🔴 Repository: .* is not inside a git repository/);
  assert.match(outside.text, /Next step: Start Claude Code inside the repository/);
});

test('swag-scan doctor prints the report, exits 1 when something is wrong and 0 when not, and has --json', (context) => {
  const repo = repoWith(context);
  const env = settingsEnv(context, FULL);
  const good = spawnSync(process.execPath, [script, 'doctor', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /ready to run/);
  const json = JSON.parse(spawnSync(process.execPath, [script, 'doctor', '--repo', repo, '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(json.ok, true);
  assert.ok(json.checks.every((check) => ['ok', 'warn', 'fail'].includes(check.status)));
  const bad = spawnSync(process.execPath, [script, 'doctor', '--repo', tmpdir()], { encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /something needs fixing first/);
});

test('when no changed file is in a supported language, the summary says so in one line up front', (context) => {
  const repo = repoWith(context, {
    files: { Dockerfile: 'FROM node:22\n', 'main.tf': 'resource "x" "y" {}\n' },
    changed: { Dockerfile: 'FROM node:24\n', 'main.tf': 'resource "x" "z" {}\n', 'appsettings.json': '{ "a": 1 }\n', 'config.yaml': 'a: 1\n' },
  });
  const summary = runScan({ repo, base: 'main' });
  assert.equal(summary.noSupportedLanguage, true);
  const lines = summary.text.split('\n');
  assert.match(lines[1], /^None of your changed files are in a language Swag Scan reviews \(TypeScript, JavaScript, Python, C#\), so no reviewer will run\.$/);
  assert.doesNotMatch(summary.text, /\nNext: /, 'no reviewer is announced');
  assert.match(summary.text, /Unchecked/, 'the coverage line still lists the files that were not read');
});

test('a change with a supported file does not get that line, and the reviewers about to start are named', (context) => {
  const repo = repoWith(context, {
    files: { 'app.js': 'export function a(db, id) { try { return db.q(id); } catch (e) { throw e; } }\n' },
    changed: { 'app.js': 'export function a(db, id) {\n  return db.query("SELECT * FROM t WHERE id = " + id);\n}\n' },
  });
  const summary = runScan({ repo, base: 'main' });
  assert.equal(summary.noSupportedLanguage, undefined);
  assert.doesNotMatch(summary.text, /None of your changed files/);
  assert.match(summary.text, /\nNext: .*will review (?:its|their) leads\. The scripts above used no model tokens; the reviewers do/);
});

test('the summary no longer claims "0 model tokens" for the whole run, and it says when defaults were used', () => {
  const agent = { id: 'analyst', name: 'Analyst', tool: 'bug-hunter', status: 'done', leads: 0, scannedCount: 1, coverage: { checked: { JavaScript: 1 } }, untrackedCount: 0, warnings: [] };
  const base = { branch: 'feature', base: { ref: 'main' }, modelTokens: 0, agents: [agent], runDir: '.swag-scan/run' };
  const plain = renderSummary(base);
  assert.doesNotMatch(plain, /0 model tokens/);
  assert.match(plain.split('\n')[0], /^Swag Scan: feature vs main · report-only$/);
  assert.doesNotMatch(plain, /No config is saved yet/);
  assert.match(renderSummary({ ...base, usedDefaults: true }), /No config is saved yet, so this run used the defaults\. Run \/swag-scan:config/);
  const some = renderSummary({ ...base, noSupportedLanguage: true, totalLeads: 2, agents: [{ ...agent, leads: 2 }] });
  assert.match(some, /only the checks on build files, workflows and secrets can find anything/);
});

test('a step that stops unexpectedly gives a plain sentence and a next step, never a script path', () => {
  const script = '/plugin/skills/review-tools-common/collect-diff.mjs';
  const raw = plainStepError(script, { stderr: 'Failed to collect diff from main: fatal: unable to read tree\n' });
  assert.match(raw, /^Swag Scan could not read your changes with git \(it said: unable to read tree\)\./);
  assert.match(raw, /no model tokens were spent/);
  assert.match(raw, /swag-scan doctor/);
  assert.doesNotMatch(raw, /\.mjs|failed:|fatal:/);
  assert.match(plainStepError('/x/scan-patterns.mjs', { message: 'boom' }), /could not scan your changes for leads \(it said: boom\)/);
  assert.match(plainStepError('/x/unknown.mjs', { stderr: '' }), /could not finish one of its steps\./);
  assert.equal(plainStepError(script, { stderr: 'noise\nSwag Scan: Already plain.\n' }), 'Already plain.');
});

test('run through the CLI in a repository whose default branch is master, with no config, prints a report-ready summary', (context) => {
  const repo = repoWith(context, { base: 'master' });
  const env = settingsEnv(context);
  const result = spawnSync(process.execPath, [script, 'run', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Swag Scan: feature\/work vs master \(auto-detected\) · report-only/);
  assert.equal(existsSync(env.SWAG_SCAN_SETTINGS), false, 'nothing is written to the user config');
});
