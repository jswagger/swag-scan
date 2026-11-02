import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildFindingsReport, fromBugHunter, validateAgentFindings } from '../findings.mjs';
import { saveFindings } from '../save-findings.mjs';
import { runScan } from '../swag-scan.mjs';

const script = fileURLToPath(new URL('../save-findings.mjs', import.meta.url));
const NOW = new Date('2026-11-02T12:00:00Z');

const critical = (extra = {}) => ({
  severity: 'critical', title: 'SQL built by concatenation', file: 'app.js', line: 4, flaggedText: 'return db.query("SELECT ...")',
  rule: 'CRIT-101', evidence: 'getUser(db, "1 OR 1=1") returns every row.', recommendation: 'Use a parameterized query.', ...extra,
});
const design = (extra = {}) => ({ severity: 'design', title: 'Retry limit changed', file: 'a.js', line: 2, verify: 'Confirm callers still need one retry.', ...extra });
const minor = (extra = {}) => ({ severity: 'minor', title: 'TODO with no owner', file: 'a.js', line: 9, recommendation: 'Remove it or give it an owner.', ...extra });

test('a valid finding set is numbered per agent, sorted critical first, and counted', () => {
  const report = buildFindingsReport(
    { findings: [minor(), design(), critical()], clean: ['src/pay.js totals', { area: 'src/auth.js' }], dismissed: [{ rule: 'X', reason: 'moved' }] },
    { agent: 'inspector', tool: 'code-sweeper', coverage: { line: 'Coverage: x.' }, base: 'main', head: 'abc', now: NOW },
  );
  assert.deepEqual(report.findings.map((f) => [f.id, f.severity]), [['IN-1', 'critical'], ['IN-2', 'design'], ['IN-3', 'minor']]);
  assert.deepEqual(report.counts, { critical: 1, design: 1, minor: 1, needsDecision: 3, autoFixed: 0, wouldAutoFix: 0 });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '2026-11-02T12:00:00.000Z');
  assert.deepEqual(report.findings[0].locations, [{ file: 'app.js', line: 4 }]);
  assert.equal(report.findings[0].flaggedText, 'return db.query("SELECT ...")');
  assert.deepEqual(report.findings[0].criteria, []);
  assert.deepEqual(report.clean, [{ area: 'src/pay.js totals', note: '' }, { area: 'src/auth.js', note: '' }]);
  assert.equal(report.coverage.line, 'Coverage: x.');
});

test('an empty findings list is valid (a clean review is still saved)', () => {
  const report = buildFindingsReport({ findings: [] }, { agent: 'security-guard', tool: 'security-auditor' });
  assert.equal(report.findings.length, 0);
  assert.equal(report.counts.critical, 0);
});

test('each severity has its own required fields, and every problem is listed at once', () => {
  const problems = validateAgentFindings({ findings: [
    { severity: 'critical', title: 'a' },
    { severity: 'design', title: 'b' },
    { severity: 'minor', title: 'c' },
    { severity: 'loud', title: 'd' },
    { severity: 'minor' },
  ] }, { agent: 'inspector' });
  const text = problems.join('\n');
  assert.match(text, /findings\[0\] "a": "evidence" is required/);
  assert.match(text, /findings\[0\] "a": give a "recommendation" or something to "verify"/);
  assert.match(text, /findings\[1\] "b": "verify" is required/);
  assert.match(text, /findings\[2\] "c": "recommendation" is required/);
  assert.match(text, /findings\[3\] "d": "severity" must be one of critical, design, minor/);
  assert.match(text, /findings\[4\]: "title" is required/);
  assert.throws(() => buildFindingsReport({ findings: [{ severity: 'critical', title: 'a' }] }, { agent: 'analyst', tool: 'bug-hunter' }), /Invalid findings/);
});

test('shape errors are caught: no findings array, bad line, bad confidence, unknown agent', () => {
  assert.match(validateAgentFindings({}, { agent: 'analyst' })[0], /"findings" array/);
  assert.match(validateAgentFindings({ findings: [critical({ line: 0 })] }, { agent: 'analyst' }).join(), /"line" must be a positive whole number/);
  assert.match(validateAgentFindings({ findings: [critical({ line: 'four' })] }, { agent: 'analyst' }).join(), /"line" must be a positive whole number/);
  assert.match(validateAgentFindings({ findings: [critical({ confidence: 'sure' })] }, { agent: 'analyst' }).join(), /"confidence" must be one of high, medium, low/);
  assert.match(validateAgentFindings({ findings: [] }, { agent: 'wizard' }).join(), /Unknown agent "wizard"/);
  assert.deepEqual(validateAgentFindings({ findings: [critical({ line: null }), critical({ file: undefined, line: undefined })] }, { agent: 'analyst' }), []);
});

test('only the Inspector can have fixed (or be able to fix) anything; the others are report-only', () => {
  const fixed = critical({ disposition: 'auto-fixed', fixNote: 'Parameterized the query.' });
  assert.deepEqual(validateAgentFindings({ findings: [fixed] }, { agent: 'inspector' }), []);
  assert.deepEqual(validateAgentFindings({ findings: [minor({ disposition: 'would-auto-fix' })] }, { agent: 'inspector' }), []);
  for (const agent of ['analyst', 'security-guard']) {
    assert.match(validateAgentFindings({ findings: [fixed] }, { agent }).join(), /report-only, so "auto-fixed" is not allowed/);
    assert.match(validateAgentFindings({ findings: [minor({ disposition: 'would-auto-fix' })] }, { agent }).join(), /report-only/);
  }
  assert.match(validateAgentFindings({ findings: [minor({ disposition: 'auto-fixed' })] }, { agent: 'inspector' }).join(), /"fixNote" is required/);
  assert.match(validateAgentFindings({ findings: [minor({ disposition: 'maybe' })] }, { agent: 'inspector' }).join(), /"disposition" must be one of/);
  const report = buildFindingsReport({ findings: [fixed, minor({ disposition: 'would-auto-fix' }), design()] }, { agent: 'inspector', tool: 'code-sweeper' });
  assert.deepEqual([report.counts.autoFixed, report.counts.wouldAutoFix, report.counts.needsDecision], [1, 1, 1]);
});

test('acceptance-criteria links must exist in the ticket', () => {
  const finding = critical({ criteria: ['1', 2] });
  assert.deepEqual(validateAgentFindings({ findings: [finding] }, { agent: 'analyst', criteriaIds: ['1', '2', '3'] }), []);
  assert.match(validateAgentFindings({ findings: [critical({ criteria: ['9'] })] }, { agent: 'analyst', criteriaIds: ['1'] }).join(), /criterion "9" is not in the ticket \(known: 1\)/);
  assert.match(validateAgentFindings({ findings: [critical({ criteria: 'AC1' })] }, { agent: 'analyst' }).join(), /list of acceptance-criterion ids/);
  assert.deepEqual(buildFindingsReport({ findings: [finding] }, { agent: 'analyst', tool: 'bug-hunter', criteriaIds: ['1', '2'] }).findings[0].criteria, ['1', '2']);
});

test('locations: several places for one finding, and voice stays in its own field', () => {
  const report = buildFindingsReport({ findings: [critical({ file: undefined, line: undefined, locations: [{ file: 'a.js', line: 1 }, { file: 'b.js', line: 2 }], voiceLine: 'Found a loose end.' })] }, { agent: 'inspector', tool: 'code-sweeper' });
  assert.equal(report.findings[0].locations.length, 2);
  assert.equal(report.findings[0].voiceLine, 'Found a loose end.');
  assert.doesNotMatch(report.findings[0].evidence, /loose end/);
});

test('Bug Hunter\'s own findings file converts: probable becomes critical, suspicious becomes design', () => {
  const converted = fromBugHunter({
    probable_bugs: [{ title: 'Null user', file: 'ui.js', line: 42, rule: 'REMOVED_GUARD', summary: 'The guard was removed.', snippet: '- if (user === null) return;', scenario: 'render(null) throws.', recommendation: 'Restore it.', criteria: ['2'] }],
    suspicious: [{ title: 'Retries 3 to 0', file: 'user.js', line: 11, check: 'Is disabling retries intended?' }],
    clean: [{ area: 'src/pay.js', note: 'unchanged' }],
    dismissed_script_findings: [{ rule: 'R', file: 'a.js', line: 3, reason: 'moved' }],
  });
  const report = buildFindingsReport(converted, { agent: 'analyst', tool: 'bug-hunter', criteriaIds: ['2'] });
  assert.deepEqual(report.findings.map((f) => [f.severity, f.disposition]), [['critical', 'needs-decision'], ['design', 'needs-decision']]);
  assert.equal(report.findings[0].evidence, 'The guard was removed. render(null) throws.');
  assert.equal(report.findings[0].flaggedText, '- if (user === null) return;');
  assert.deepEqual(report.findings[0].criteria, ['2']);
  assert.equal(report.findings[1].verify, 'Is disabling retries intended?');
  assert.equal(report.dismissed[0].reason, 'moved');
  // a Bug Hunter finding that was fixed by an earlier agent step keeps its fix note
  const fixed = fromBugHunter({ probable_bugs: [{ title: 'x', scenario: 's', recommendation: 'r', autoFixed: true, fixNote: 'changed' }] });
  assert.equal(fixed.findings[0].disposition, 'auto-fixed');
});

// --- the save script, against a real orchestrated run -------------------------------------------------

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function scannedRepo(context) {
  const repo = mkdtempSync(join(tmpdir(), 'save-findings-'));
  const tickets = mkdtempSync(join(tmpdir(), 'save-tickets-'));
  context.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(tickets, { recursive: true, force: true }); });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  writeFileSync(join(repo, 'app.js'), 'export async function f(db, id) {\n  if (!id) throw new Error("x");\n  return await db.query("SELECT 1 WHERE id = ?", [id]);\n}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature/PROJ-7']);
  writeFileSync(join(repo, 'app.js'), 'export function f(db, id) {\n  return db.query("SELECT 1 WHERE id = " + id);\n}\n');
  git(repo, ['commit', '-qam', 'feature']);
  writeFileSync(join(tickets, 'PROJ-7.md'), '## Description\n\nSafe lookups.\n\n## Acceptance Criteria\n\n| # | Title | Description | Repository | Status |\n|---|---|---|---|---|\n| 1 | Parameterized | Use bound parameters | api | ✅ Done |\n| 2 | Guard | Keep the id guard | api | 🔲 Todo |\n');
  const summary = runScan({ repo, ticketDir: tickets });
  return { repo, summary, runDir: join(repo, '.swag-scan', 'run') };
}

test('the orchestrator keeps criterion status out of the files the agents read', (context) => {
  const { summary, runDir } = scannedRepo(context);
  assert.deepEqual(summary.ticket.criteriaIds, ['1', '2']);
  const agentVisible = readFileSync(join(runDir, 'bug-hunter-context.json'), 'utf8') + readFileSync(join(runDir, 'summary.json'), 'utf8');
  assert.doesNotMatch(agentVisible, /"status": "(Done|Todo|Future)"/);
  assert.doesNotMatch(agentVisible, /Done|Todo/);
  const forReport = JSON.parse(readFileSync(join(runDir, 'ticket-report.json'), 'utf8'));
  assert.deepEqual(forReport.criteria.map((row) => [row.id, row.status]), [['1', 'Done'], ['2', 'Todo']]);
});

test('save-findings fills in tool, coverage, base and ids from the scan summary', (context) => {
  const { runDir } = scannedRepo(context);
  const result = saveFindings({
    agent: 'security-guard', runDir, now: NOW,
    text: JSON.stringify({ findings: [critical({ criteria: ['1'] })], clean: [] }),
  });
  assert.equal(result.path, join(runDir, 'findings-security-guard.json'));
  const saved = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(saved.tool, 'security-auditor');
  assert.equal(saved.base, 'main');
  assert.match(saved.coverage.line, /^Coverage: Checked: JavaScript/);
  assert.equal(saved.findings[0].id, 'SG-1');
  assert.deepEqual(saved.findings[0].criteria, ['1']);
  assert.equal(result.counts.critical, 1);
});

test('save-findings accepts Bug Hunter\'s format for the Analyst', (context) => {
  const { runDir } = scannedRepo(context);
  const text = JSON.stringify({ probable_bugs: [{ title: 'Guard removed', file: 'app.js', line: 2, scenario: 'f(db, 0) queries anyway.', recommendation: 'Restore the guard.', criteria: ['2'] }], suspicious: [], clean: [] });
  const result = saveFindings({ agent: 'analyst', runDir, text, format: 'bug-hunter' });
  assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).findings[0].id, 'AN-1');
});

test('save-findings gives plain errors, and writes nothing when the findings are invalid', (context) => {
  const { runDir, repo } = scannedRepo(context);
  assert.throws(() => saveFindings({ agent: 'analyst', runDir, text: 'not json' }), /not valid JSON/);
  assert.throws(() => saveFindings({ agent: 'analyst', runDir, text: JSON.stringify({ findings: [critical({ criteria: ['9'] })] }) }), /criterion "9" is not in the ticket \(known: 1, 2\)/);
  assert.throws(() => saveFindings({ agent: 'wizard', runDir, text: '{"findings":[]}' }), /Agent "wizard" was not part of this scan/);
  assert.throws(() => saveFindings({ agent: 'analyst', runDir: join(repo, 'nowhere'), text: '{}' }), /Run "swag-scan run" first/);
  assert.equal(existsSync(join(runDir, 'findings-analyst.json')), false);

  const cli = spawnSync(process.execPath, [script, '--agent', 'inspector', '--run-dir', runDir], { input: '{"findings":[{"severity":"critical","title":"t"}]}', encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Invalid findings:\n- findings\[0\] "t": "evidence" is required/);
  const ok = spawnSync(process.execPath, [script, '--agent', 'inspector', '--run-dir', runDir], { input: '{"findings":[]}', encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).findings, 0);
});
