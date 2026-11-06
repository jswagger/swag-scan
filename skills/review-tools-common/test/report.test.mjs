import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildFindingsReport } from '../findings.mjs';
import { buildReport, renderMarkdown } from '../report.mjs';
import { reportScan, runScan } from '../swag-scan.mjs';
import { saveFindings } from '../save-findings.mjs';

const NOW = new Date('2026-11-02T12:00:00Z');
const cli = fileURLToPath(new URL('../swag-scan.mjs', import.meta.url));

const crew = [
  { id: 'analyst', name: 'Analyst', tool: 'bug-hunter' },
  { id: 'inspector', name: 'Inspector', tool: 'code-sweeper' },
  { id: 'security-guard', name: 'Security Guard', tool: 'security-auditor' },
];
const coverage = (line = 'Coverage: Checked: JavaScript (1 file).', unchecked = []) => ({ checked: { JavaScript: 1 }, unchecked, line });
const agent = (index, extra = {}) => ({ ...crew[index], status: 'done', leads: 2, coverage: coverage(), cache: { hit: false, cacheable: true, key: 'k' }, ...extra });
const summary = (agents) => ({ branch: 'feature/PROJ-1', head: 'abcdef1234567', base: { ref: 'main', autoDetected: true }, modelTokens: 0, agents });

const finding = (extra = {}) => ({
  severity: 'critical', title: 'SQL built by concatenation', file: 'app.js', line: 4, flaggedText: 'db.query("..." + id)',
  rule: 'CRIT-101', evidence: 'id "1 OR 1=1" returns every row.', recommendation: 'Parameterize it.', ...extra,
});
const saved = (agentId, input, criteriaIds) => buildFindingsReport({ findings: [], ...input }, { agent: agentId, tool: crew.find((c) => c.id === agentId).tool, criteriaIds, now: NOW });

test('decisions are sorted critical first across agents, with ids, severity words and locations', () => {
  const report = buildReport({
    summary: summary([agent(0), agent(1), agent(2)]),
    findings: {
      analyst: saved('analyst', { findings: [finding({ severity: 'design', title: 'Retry changed', verify: 'Check callers.', file: 'a.js', line: 2, rule: undefined, evidence: undefined, recommendation: undefined })] }),
      inspector: saved('inspector', { findings: [finding({ severity: 'minor', title: 'TODO with no owner', recommendation: 'Remove it.', evidence: undefined, rule: 'SWEEP-9' })] }),
      'security-guard': saved('security-guard', { findings: [finding()] }),
    },
  }, { now: NOW });
  const markdown = renderMarkdown(report);
  assert.deepEqual(report.decisions.map((f) => f.id), ['SG-1', 'AN-1', 'IN-1']);
  assert.match(markdown, /\*\*3 items need your decision\*\* \(1 critical, 1 design, 1 minor\)/);
  assert.match(markdown, /\| SG-1 \| 🔴 Critical \| \*\*SQL built by concatenation\*\* · `app.js:4` · `CRIT-101` \|/);
  assert.match(markdown, /\| AN-1 \| 🟡 Feature gap \/ design issue \| \*\*Retry changed\*\* · `a.js:2` \|/);
  assert.match(markdown, /\| IN-1 \| ✅ Cleanup \/ minor \|/);
  assert.match(markdown, /\*\*Next:\*\* Start with SG-1: SQL built by concatenation\./);
  assert(markdown.indexOf('| SG-1 |') < markdown.indexOf('| AN-1 |') && markdown.indexOf('| AN-1 |') < markdown.indexOf('| IN-1 |'));
  assert.match(markdown, /pass 1 used 0 model tokens/);
  assert.match(markdown, /commit `abcdef1`/);
});

test('acceptance criteria rows show the ticket status and link the findings that relate to them', () => {
  const ticket = { id: 'PROJ-1', title: 'PROJ-1: Fix lookup', criteria: [
    { id: '1', title: 'Parameterized', repository: 'api', status: 'Done' },
    { id: '2', title: '', description: 'Keep the id guard', repository: 'api', status: 'Todo' },
    { id: '3', title: 'Audit log', repository: 'web', status: 'Future' },
  ] };
  const report = buildReport({
    summary: summary([agent(0), agent(1, { leads: 0 }), agent(2)]),
    findings: {
      analyst: saved('analyst', { findings: [finding({ severity: 'critical', title: 'Guard removed', criteria: ['2'] })] }, ['1', '2', '3']),
      'security-guard': saved('security-guard', { findings: [finding({ criteria: ['1', '2'] })] }, ['1', '2', '3']),
    },
    ticket,
  }, { now: NOW });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| # \| Title \| Repository \| Status \| Findings \|/);
  assert.match(markdown, /\| 1 \| Parameterized \| api \| ✅ Done \| SG-1 🔴 \|/);
  assert.match(markdown, /\| 2 \| Keep the id guard \| api \| 🔲 Todo \| AN-1 🔴, SG-1 🔴 \|/);
  assert.match(markdown, /\| 3 \| Audit log \| web \| 🔮 Future \| None linked \|/);
  assert.match(markdown, /"None linked" means no agent tied a finding to that row, not that the row is verified/);
  assert.match(markdown, /ticket PROJ-1 \(Fix lookup\)/);
  assert.deepEqual(report.criteria.map((row) => row.findingIds), [['SG-1'], ['AN-1', 'SG-1'], []]);
});

test('without a ticket there is no criteria section; without repositories no Repository column', () => {
  assert.doesNotMatch(renderMarkdown(buildReport({ summary: summary([agent(0)]), findings: {} }, { now: NOW })), /Acceptance criteria/);
  const markdown = renderMarkdown(buildReport({
    summary: summary([agent(0)]), findings: {}, ticket: { id: 'PROJ-1', criteria: [{ id: '1', title: 'T', status: 'Todo' }] },
  }, { now: NOW }));
  assert.match(markdown, /\| # \| Title \| Status \| Findings \|/);
  assert.doesNotMatch(markdown, /Repository/);
});

test('fixed items go under Done for you, and report-only runs list would-have-fixed items with a safe-fix note', () => {
  const report = buildReport({
    summary: summary([agent(0), agent(1), agent(2)]),
    findings: { inspector: saved('inspector', { findings: [
      finding({ severity: 'minor', title: 'Dead code', evidence: undefined, disposition: 'auto-fixed', fixNote: 'Removed 3 lines.' }),
      finding({ severity: 'minor', title: 'Unused import', evidence: undefined, disposition: 'would-auto-fix' }),
      finding({ severity: 'design', title: 'Repeated block', evidence: undefined, verify: 'Share it?' }),
    ] }) },
  }, { now: NOW });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\*\*1 item needs your decision\*\*/);
  assert.match(markdown, /1 fixed for you\. 1 would have been fixed with auto-fix on\./);
  assert.match(markdown, /## Done for you\n\n\| # \| Severity \| Item \|[\s\S]*Dead code/);
  assert.match(markdown, /## Would have been fixed \(auto-fix was off\)\n\nLow-risk items with a safe fix\. Nothing was changed\./);
  assert.match(markdown, /\*\*Changed:\*\* Removed 3 lines\./);
  const needs = markdown.slice(markdown.indexOf('## Needs your decision'), markdown.indexOf('## Done for you'));
  assert.match(needs, /Repeated block/);
  assert.doesNotMatch(needs, /Dead code|Unused import/);
});

test('each agent is described honestly: reviewed, no leads, already reviewed, no changes, or did not report', () => {
  const report = buildReport({
    summary: summary([
      agent(0, { leads: 4 }),
      agent(1, { leads: 0 }),
      agent(2, { leads: 3, cache: { hit: true, reports: ['/r/report.md'] } }),
    ]),
    findings: {},
  }, { now: NOW });
  assert.deepEqual(report.agents.map((entry) => entry.state), ['missing', 'no-leads', 'cached']);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| Analyst \| ⚠ Did not report: 4 leads found, but no findings were saved\./);
  assert.match(markdown, /\| Inspector \| No leads, so no model review\. This is not a check that the code is sound\. \|/);
  assert.match(markdown, /\| Security Guard \| Already reviewed at this commit\. Earlier report: \/r\/report\.md\./);
  assert.match(markdown, /Analyst did not report/);

  const empty = buildReport({ summary: summary([agent(0, { status: 'empty', leads: 0 })]), findings: {} }, { now: NOW });
  assert.equal(empty.agents[0].state, 'no-changes');
});

test('the report never claims the code is clean', () => {
  const none = renderMarkdown(buildReport({ summary: summary([agent(0, { leads: 0 }), agent(1, { leads: 0 }), agent(2, { leads: 0 })]), findings: {} }, { now: NOW }));
  assert.match(none, /\*\*Nothing needs your decision\.\*\* This is not a statement that the code is clean: see Coverage\./);
  assert.match(none, /No findings from the agents that ran\. See Coverage/);
  assert.doesNotMatch(none.replace('This is not a statement that the code is clean', ''), /is clean\b|all clean|looks clean|no issues/i);

  const unchecked = [{ path: 'main.go', language: 'Go' }];
  const withUnchecked = renderMarkdown(buildReport({ summary: summary([agent(0, { leads: 0, coverage: coverage('Coverage: Checked: JavaScript (1 file) · ⚪ Unchecked: 1 file in Go (not a supported language, so not reviewed).', unchecked) })]), findings: {} }, { now: NOW }));
  assert.match(withUnchecked, /No findings were reported, but 1 file could not be checked\. Look at Coverage/);
  assert.match(withUnchecked, /⚪ \*\*Unchecked\*\* \(no verdict either way\):\n- `main\.go` \(Go\)/);
});

test('coverage is shown once when it is the same for all agents, and per agent when it differs', () => {
  const same = renderMarkdown(buildReport({ summary: summary([agent(0), agent(1)]), findings: {} }, { now: NOW }));
  assert.match(same, /## Coverage\n\n- Checked: JavaScript \(1 file\)\.\n/);
  const differs = renderMarkdown(buildReport({ summary: summary([agent(0), agent(1, { coverage: coverage('Coverage: Checked: Python (2 files).') })]), findings: {} }, { now: NOW }));
  assert.match(differs, /- Analyst: Checked: JavaScript \(1 file\)\./);
  assert.match(differs, /- Inspector: Checked: Python \(2 files\)\./);
});

test('details carry the voice line apart from the facts, and code with backticks is fenced safely', () => {
  const markdown = renderMarkdown(buildReport({
    summary: summary([agent(0)]),
    findings: { analyst: saved('analyst', { findings: [finding({ voiceLine: 'Four leads, two real.', flaggedText: 'const s = `a ${b}`; // | pipe', title: 'Template | pipe' })] }) },
  }, { now: NOW }));
  assert.match(markdown, /> \*\*Analyst:\*\* Four leads, two real\./);
  assert.match(markdown, /```\nconst s = `a \$\{b\}`; \/\/ \| pipe\n```/);
  assert.match(markdown, /\| AN-1 \| 🔴 Critical \| \*\*Template \\\| pipe\*\*/);
  const four = renderMarkdown(buildReport({ summary: summary([agent(0)]), findings: { analyst: saved('analyst', { findings: [finding({ flaggedText: 'x ```y``` z' })] }) } }, { now: NOW }));
  assert.match(four, /````\nx ```y``` z\n````/);
});

// --- end to end: a real scan, saved findings, the report, and a re-run that recognises the review -----------

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repoWithFeature(context) {
  const repo = mkdtempSync(join(tmpdir(), 'report-'));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  writeFileSync(join(repo, 'app.js'), 'export async function f(db, id) {\n  if (!id) throw new Error("x");\n  return await db.query("SELECT 1 WHERE id = ?", [id]);\n}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature/PROJ-9']);
  writeFileSync(join(repo, 'app.js'), 'export function f(db, id) {\n  return db.query("SELECT 1 WHERE id = " + id);\n}\n');
  git(repo, ['commit', '-qam', 'feature']);
  return repo;
}

test('end to end: scan, save findings, build the report, and the next scan knows it was reviewed', (context) => {
  const repo = repoWithFeature(context);
  const runDir = join(repo, '.swag-scan', 'run');
  const first = runScan({ repo });
  assert.equal(first.agents.find((a) => a.id === 'security-guard').cache.hit, false);

  saveFindings({ agent: 'security-guard', runDir, text: JSON.stringify({ findings: [finding({ file: 'app.js', line: 2 })] }) });
  const result = reportScan({ repo });
  assert.match(result.markdown, /\| SG-1 \| 🔴 Critical \|/);
  assert.match(result.markdown, /⚠ Did not report/, 'the Analyst had leads but saved nothing');
  assert(existsSync(join(runDir, 'report.md')) && existsSync(join(runDir, 'report.json')));
  assert.equal(JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')).counts.critical, 1);
  assert(existsSync(result.kept.markdown) && existsSync(join(repo, '.swag-scan', 'reports', result.report.head.slice(0, 7), 'findings-security-guard.json')));
  assert.deepEqual(result.cached, ['security-guard']);

  // a new scan wipes the run folder, but the kept copy survives and the cache points at it
  const second = runScan({ repo });
  const guard = second.agents.find((a) => a.id === 'security-guard');
  assert.equal(guard.cache.hit, true);
  assert.equal(guard.cache.reports[0], result.kept.markdown);
  assert(existsSync(guard.cache.reports[0]));
  assert.equal(second.agents.find((a) => a.id === 'analyst').cache.hit, false, 'only reviewed agents are remembered');
  assert.match(second.text, /Security Guard \(Security Auditor\): \d+ leads? in \d+ files? · already reviewed at this commit/);
});

test('the report command: markdown on stdout, a plain error without a scan, JSON on request', (context) => {
  const repo = repoWithFeature(context);
  const none = spawnSync(process.execPath, [cli, 'report', '--repo', repo], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No scan found in .+\. Run "swag-scan run" first\.\n$/);

  runScan({ repo });
  const text = spawnSync(process.execPath, [cli, 'report', '--repo', repo], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^# Swag Scan report: feature\/PROJ-9 vs main \(auto-detected\)/);
  assert.match(text.stderr, /Report saved: /);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'report', '--repo', repo, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(json.schemaVersion, 1);
  assert.equal(spawnSync(process.execPath, [cli, 'report', '--fresh'], { encoding: 'utf8' }).status, 1);
});

test('criteria for other repositories read "Other repo", not "None linked", and blank repositories read "(all)"', () => {
  const ticket = { id: 'PROJ-1', criteria: [
    { id: '1', title: 'Everywhere', status: 'Todo' },
    { id: '2', title: 'Mine', repository: 'web', status: 'Todo' },
    { id: '3', title: 'Not mine', repository: 'api', status: 'Todo', otherRepo: true },
  ] };
  const markdown = renderMarkdown(buildReport({ summary: summary([agent(0)]), findings: {}, ticket }, { now: NOW }));
  assert.match(markdown, /\| 1 \| Everywhere \| \(all\) \| 🔲 Todo \| None linked \|/);
  assert.match(markdown, /\| 3 \| Not mine \| api \| 🔲 Todo \| Other repo, not scanned \|/);
});
