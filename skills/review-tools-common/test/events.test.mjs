import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crewId, eventFor, handle } from '../../../hooks/events.mjs';
import { EVENTS_FILE, cleanEvent, emit, readEvents, runIsActive } from '../events.mjs';
import { saveFindings } from '../save-findings.mjs';
import { reportScan, runScan } from '../swag-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOK = join(ROOT, 'hooks', 'events.mjs');
const NOW = new Date('2026-11-02T12:00:00.000Z');

function folder(context, prefix = 'events-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('an event keeps only short, known fields, so code and long text cannot get in', () => {
  const event = cleanEvent({
    kind: 'finding', agent: 'security-guard', phase: 'review', id: 'SG-1', severity: 'critical', file: 'app.js',
    title: 'SQL built by concatenation', evidence: 'secret evidence', flaggedText: 'db.query("..." + id)', code: 'const x = 1;',
    label: `line one\nline two ${'x'.repeat(500)}`, step: 2.9, steps: -4, count: 'many',
  }, NOW);
  assert.deepEqual(Object.keys(event).sort(), ['agent', 'file', 'id', 'kind', 'label', 'phase', 'severity', 'step', 'steps', 't', 'v']);
  assert.equal(event.t, '2026-11-02T12:00:00.000Z');
  assert.equal(event.v, 1);
  assert.equal(event.step, 2);
  assert.equal(event.steps, 0, 'negative numbers are clamped');
  assert.equal(event.label.length, 120);
  assert.doesNotMatch(event.label, /\n/);
  assert.doesNotMatch(JSON.stringify(event), /secret evidence|db\.query|const x/);
});

test('bad events are rejected, a missing agent means the run itself, and an unknown phase is dropped', () => {
  assert.equal(cleanEvent({ kind: 'nonsense' }), undefined);
  assert.equal(cleanEvent({}), undefined);
  assert.equal(cleanEvent(null), undefined);
  assert.equal(cleanEvent({ kind: 'done' }, NOW).agent, 'swag-scan');
  assert.equal('phase' in cleanEvent({ kind: 'done', phase: 'lunch' }, NOW), false);
});

test('emit appends one line per event, readEvents returns them, and a damaged line is skipped', (context) => {
  const runDir = folder(context);
  assert.equal(emit(runDir, { kind: 'run-started', steps: 3 }, { now: NOW }), true);
  assert.equal(emit(runDir, { kind: 'started', agent: 'analyst', phase: 'scan' }, { now: NOW }), true);
  appendFileSync(join(runDir, EVENTS_FILE), 'not json\n{"kind":"bogus"}\n{"kind":"done","agent":"ana');
  const events = readEvents(runDir);
  assert.deepEqual(events.map((event) => event.kind), ['run-started', 'started']);
  assert.equal(readFileSync(join(runDir, EVENTS_FILE), 'utf8').split('\n')[0].includes('\n'), false);
  assert.deepEqual(readEvents(join(runDir, 'missing')), []);
});

test('writing events never throws, and can be switched off', (context) => {
  const runDir = folder(context);
  assert.equal(emit(join(runDir, 'no', 'such', 'folder'), { kind: 'done' }), false);
  assert.equal(emit(runDir, { kind: 'nonsense' }), false);
  assert.equal(emit(runDir, { kind: 'done' }, { env: { SWAG_SCAN_EVENTS: 'off' } }), false);
  assert.deepEqual(readEvents(runDir), []);
});

test('a run is active only while its log is fresh and has not ended', (context) => {
  const runDir = folder(context);
  assert.equal(runIsActive(runDir), false, 'no log');
  emit(runDir, { kind: 'run-started' });
  assert.equal(runIsActive(runDir), true);
  emit(runDir, { kind: 'started', agent: 'analyst' });
  assert.equal(runIsActive(runDir), true);
  emit(runDir, { kind: 'run-done' });
  assert.equal(runIsActive(runDir), false, 'finished');

  const failed = folder(context);
  emit(failed, { kind: 'run-started' });
  emit(failed, { kind: 'error', label: 'scan failed' });
  assert.equal(runIsActive(failed), false, 'failed');

  const stale = folder(context);
  emit(stale, { kind: 'run-started' });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(join(stale, EVENTS_FILE), old, old);
  assert.equal(runIsActive(stale), false, 'a scan from two hours ago is not "active"');

  const damaged = folder(context);
  writeFileSync(join(damaged, EVENTS_FILE), '{"kind":"run-started"}\n{"kind":"star');
  assert.equal(runIsActive(damaged), false, 'a half-written last line is treated as not active');
});

// --- the Claude Code hook ------------------------------------------------------------------------------

test('the hook records only the crew, and permission prompts from anyone', () => {
  for (const type of ['analyst', 'swag-scan:inspector', 'security-guard']) assert(crewId(type), type);
  for (const type of [undefined, '', 'Explore', 'other:analyst', 'analyst2']) assert.equal(crewId(type), undefined, String(type));

  assert.deepEqual(eventFor({ hook_event_name: 'SubagentStart', agent_type: 'swag-scan:analyst' }), { kind: 'started', agent: 'analyst', phase: 'review' });
  assert.deepEqual(eventFor({ hook_event_name: 'SubagentStop', agent_type: 'security-guard' }), { kind: 'done', agent: 'security-guard', phase: 'review' });
  assert.equal(eventFor({ hook_event_name: 'SubagentStart', agent_type: 'Explore' }), undefined, 'another agent');
  assert.equal(eventFor({ hook_event_name: 'SubagentStart' }), undefined);
  assert.equal(eventFor({ hook_event_name: 'PreToolUse', agent_type: 'analyst' }), undefined);
  assert.deepEqual(eventFor({ hook_event_name: 'Notification', agent_type: 'inspector' }), { kind: 'waiting', agent: 'inspector', phase: 'review' });
  assert.deepEqual(eventFor({ hook_event_name: 'Notification' }), { kind: 'waiting', agent: 'swag-scan', phase: 'review' });
  assert.equal(eventFor(null), undefined);
});

test('the hook writes only while a Swag Scan run is active in that project', (context) => {
  const project = folder(context);
  const runDir = join(project, '.swag-scan', 'run');
  const input = { hook_event_name: 'SubagentStart', agent_type: 'swag-scan:analyst', cwd: project };

  assert.equal(handle(input), false, 'no run folder');
  mkdirSync(runDir, { recursive: true });
  assert.equal(handle(input), false, 'no events file: some other project, or no scan');
  assert.deepEqual(readEvents(runDir), []);

  emit(runDir, { kind: 'run-started' });
  assert.equal(handle(input), true);
  assert.equal(handle({ ...input, agent_type: 'Explore' }), false);
  assert.equal(handle({ hook_event_name: 'Notification', cwd: project }), true);
  assert.deepEqual(readEvents(runDir).map((event) => [event.kind, event.agent]), [['run-started', 'swag-scan'], ['started', 'analyst'], ['waiting', 'swag-scan']]);

  emit(runDir, { kind: 'run-done' });
  assert.equal(handle(input), false, 'the run is over');
  assert.equal(handle(input, { env: { SWAG_SCAN_EVENTS: 'off' } }), false);
});

test('the hook process exits 0 and prints nothing, whatever it is given', (context) => {
  const project = folder(context);
  const runDir = join(project, '.swag-scan', 'run');
  mkdirSync(runDir, { recursive: true });
  emit(runDir, { kind: 'run-started' });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });

  const good = run(JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'analyst', cwd: project }));
  assert.equal(good.status, 0);
  assert.equal(good.stdout + good.stderr, '');
  assert.deepEqual(readEvents(runDir).map((event) => event.kind), ['run-started', 'done']);
  for (const bad of ['', 'not json', '[]', 'null', '{"hook_event_name":"SubagentStart"}']) {
    const result = run(bad);
    assert.equal(result.status, 0, bad);
    assert.equal(result.stdout + result.stderr, '', bad);
  }
});

test('hooks.json registers the event hook as asynchronous, and only for permission prompts on Notification', () => {
  const { hooks } = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  for (const name of ['SubagentStart', 'SubagentStop', 'Notification']) {
    const handler = hooks[name][0].hooks[0];
    assert.equal(handler.async, true, `${name} must not delay the session`);
    assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/events.mjs']);
  }
  assert.equal(hooks.Notification[0].matcher, 'permission_prompt');
  assert.equal(hooks.PreToolUse[0].hooks[0].async, undefined, 'the Bash guard stays synchronous');
});

// --- the scripts that write events during a real run ---------------------------------------------------

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function scannedRepo(context) {
  const repo = folder(context, 'events-repo-');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Tests']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  writeFileSync(join(repo, 'app.js'), 'export async function f(db, id) {\n  if (!id) throw new Error("x");\n  return await db.query("SELECT 1 WHERE id = ?", [id]);\n}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-q', '-b', 'feature/PROJ-5']);
  writeFileSync(join(repo, 'app.js'), 'export function f(db, id) {\n  return db.query("SELECT 1 WHERE id = " + id);\n}\n');
  git(repo, ['commit', '-qam', 'feature']);
  return repo;
}

test('a scan writes its progress as steps, and the log holds no code', (context) => {
  const repo = scannedRepo(context);
  runScan({ repo });
  const runDir = join(repo, '.swag-scan', 'run');
  const events = readEvents(runDir);

  assert.equal(events[0].kind, 'run-started');
  assert.equal(events[0].steps, 3);
  assert.deepEqual(events.filter((e) => e.kind === 'started').map((e) => [e.agent, e.step, e.steps]), [['analyst', 1, 3], ['inspector', 2, 3], ['security-guard', 3, 3]]);
  const analyst = events.filter((e) => e.agent === 'analyst' && e.kind === 'progress');
  assert.deepEqual(analyst.map((e) => [e.step, e.steps, e.label]), [[1, 6, 'collect'], [2, 6, 'size-gate'], [3, 6, 'ticket'], [4, 6, 'scan'], [5, 6, 'callers'], [6, 6, 'packets']]);
  assert.deepEqual(events.filter((e) => e.agent === 'inspector' && e.kind === 'progress').map((e) => e.label), ['collect', 'scan']);
  const done = events.filter((e) => e.kind === 'done' && e.agent !== 'swag-scan');
  assert.deepEqual(done.map((e) => e.agent), ['analyst', 'inspector', 'security-guard']);
  assert(done.every((e) => Number.isInteger(e.count)));
  assert.equal(events.at(-1).kind, 'done');
  assert.equal(events.at(-1).agent, 'swag-scan');
  assert.equal(runIsActive(runDir), true, 'the review is still to come');

  const raw = readFileSync(join(runDir, EVENTS_FILE), 'utf8');
  assert.doesNotMatch(raw, /SELECT|db\.query|export function/);
  assert(events.every((e, i) => i === 0 || e.t >= events[i - 1].t));
});

test('saved findings write their id, severity and file, never their text; the report ends the run', (context) => {
  const repo = scannedRepo(context);
  runScan({ repo });
  const runDir = join(repo, '.swag-scan', 'run');
  saveFindings({
    agent: 'security-guard', runDir,
    text: JSON.stringify({ findings: [
      { severity: 'critical', title: 'Secret title', file: 'app.js', line: 2, flaggedText: 'return db.query("..." + id)', evidence: 'secret evidence', recommendation: 'secret advice' },
      { severity: 'minor', title: 'Another', file: 'b.js', line: 1, recommendation: 'x' },
    ] }),
  });
  const events = readEvents(runDir);
  const findings = events.filter((e) => e.kind === 'finding');
  assert.deepEqual(findings.map((e) => [e.agent, e.id, e.severity, e.file]), [['security-guard', 'SG-1', 'critical', 'app.js'], ['security-guard', 'SG-2', 'minor', 'b.js']]);
  assert.deepEqual(events.filter((e) => e.kind === 'saved').map((e) => [e.agent, e.count]), [['security-guard', 2]]);
  assert.doesNotMatch(readFileSync(join(runDir, EVENTS_FILE), 'utf8'), /Secret title|secret evidence|secret advice|db\.query/);

  assert.equal(runIsActive(runDir), true);
  reportScan({ repo });
  const last = readEvents(runDir).at(-1);
  assert.deepEqual([last.kind, last.phase, last.count], ['run-done', 'report', 2], 'count is the items needing a decision');
  assert.equal(runIsActive(runDir), false);
});

test('a failing scan ends its log with an error event', (context) => {
  const repo = scannedRepo(context);
  assert.throws(() => runScan({ repo, base: 'no-such-ref' }), /collect-diff\.mjs failed/);
  const events = readEvents(join(repo, '.swag-scan', 'run'));
  assert.equal(events.at(-1).kind, 'error');
  assert.equal(events.at(-1).agent, 'analyst');
  assert.equal(runIsActive(join(repo, '.swag-scan', 'run')), false);
});
