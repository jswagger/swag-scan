import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DATA_FILE, DASHBOARD_FILE, PAGE_TEMPLATE, buildState, cleanStaleTemps, renderPage, watchDashboard, writeDashboard } from '../dashboard.mjs';
import { emit } from '../events.mjs';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const ev = (seconds, event) => ({ v: 1, t: new Date(T0 + seconds * 1000).toISOString(), ...event });
const agent = (state, id) => state.agents.find((entry) => entry.id === id);

function folder(context) {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('with no events the dashboard says it is waiting and every agent stands by', () => {
  const state = buildState([], undefined, { now: T0 });
  assert.equal(state.status, 'waiting');
  assert.deepEqual(state.agents.map((entry) => entry.state), ['idle', 'idle', 'idle']);
  assert.equal(state.steps.every((step) => step.state === ''), true);
  assert.equal(state.result, null);
});

test('scan events move the steps and give each agent a fixed line with its real count', () => {
  const state = buildState([
    ev(0, { kind: 'run-started', agent: 'swag-scan', phase: 'scan', steps: 3 }),
    ev(1, { kind: 'started', agent: 'analyst', phase: 'scan', step: 1, steps: 3 }),
    ev(2, { kind: 'progress', agent: 'analyst', phase: 'scan', step: 2, steps: 6, label: 'size-gate' }),
    ev(3, { kind: 'done', agent: 'analyst', phase: 'scan', count: 3 }),
    ev(4, { kind: 'done', agent: 'inspector', phase: 'scan', count: 0 }),
  ], undefined, { now: T0 });
  assert.equal(state.status, 'live');
  assert.deepEqual(state.steps.map((step) => step.state), ['done', 'cur', '', '', '']);
  assert.equal(agent(state, 'analyst').state, 'ready');
  assert.match(agent(state, 'analyst').line, /^3 leads/);
  assert.equal(agent(state, 'inspector').state, 'done');
  assert.doesNotMatch(agent(state, 'inspector').line, /^0 /);
  assert.equal(state.stats.leads, 3);
});

test('a critical finding is flagged in the feed, names only the file, and counts as needing a decision so far', () => {
  const state = buildState([
    ev(0, { kind: 'run-started', agent: 'swag-scan', phase: 'scan' }),
    ev(1, { kind: 'finding', agent: 'security-guard', phase: 'review', id: 'CRIT-101', severity: 'critical', file: 'app.js' }),
    ev(2, { kind: 'finding', agent: 'analyst', phase: 'review', id: 'BUG-1', severity: 'minor', file: 'b.js' }),
  ], undefined, { now: T0 });
  const flagged = state.feed.filter((item) => item.flag);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].text, /app\.js/);
  assert.equal(state.stats.needs, 1);
  assert.equal(state.stats.needsFinal, false);
});

test('Report becomes the current step once every reviewing agent has saved, and run-done finishes everything', () => {
  const review = [
    ev(0, { kind: 'run-started', agent: 'swag-scan' }),
    ev(1, { kind: 'started', agent: 'analyst', phase: 'review' }),
    ev(2, { kind: 'started', agent: 'inspector', phase: 'review' }),
    ev(3, { kind: 'saved', agent: 'analyst', phase: 'review', count: 2 }),
  ];
  assert.equal(buildState(review, undefined).steps[3].state, 'cur');
  const saved = [...review, ev(4, { kind: 'saved', agent: 'inspector', phase: 'review', count: 0 })];
  assert.equal(buildState(saved, undefined).steps[4].state, 'cur');
  const done = buildState([...saved, ev(5, { kind: 'run-done', agent: 'swag-scan', phase: 'report', count: 2 })], undefined, { now: T0 });
  assert.equal(done.status, 'done');
  assert.equal(done.steps.every((step) => step.state === 'done'), true);
  assert.equal(done.stats.needs, 2);
  assert.equal(done.stats.needsFinal, true);
  assert.match(done.result.text, /2 items need your decision/);
  assert.deepEqual(done.agents.map((entry) => entry.state), ['done', 'done', 'idle']);
  assert.equal(agent(done, 'security-guard').line, 'Not part of this run.');
});

test('a permission prompt nudges, and an error stops the run with its plain sentence', () => {
  const waiting = buildState([ev(0, { kind: 'run-started', agent: 'swag-scan' }), ev(1, { kind: 'waiting', agent: 'inspector', phase: 'review' })], undefined);
  assert.equal(agent(waiting, 'inspector').state, 'alert');
  assert.deepEqual(waiting.waiting.map((entry) => entry.agent), ['inspector']);
  const failed = buildState([ev(0, { kind: 'run-started', agent: 'swag-scan' }), ev(1, { kind: 'error', agent: 'analyst', phase: 'scan', label: 'No commits ahead of main.' })], undefined);
  assert.equal(failed.status, 'error');
  assert.equal(failed.result.text, 'No commits ahead of main.');
  assert.equal(agent(failed, 'analyst').state, 'error');
});

test('the page embeds the snapshot, and text cannot break out of the script', () => {
  const state = buildState([ev(0, { kind: 'run-started', agent: 'swag-scan' })], { branch: '</script><img src=x onerror=alert(1)>' }, { now: T0 });
  const page = renderPage(state);
  assert.equal(page.includes('</script><img'), false);
  assert.match(page, /var data = \{"v":1/);
  assert.equal(page.includes('__SWAG_SCAN_DATA__'), false);
  assert.equal(/https?:\/\//.test(page.replace(/<!--[\s\S]*?-->/g, '').replace(/xmlns="[^"]*"/g, '')), false, 'no network references');
});

test('writeDashboard draws "waiting" when no run exists, and never throws', (context) => {
  const swagDir = join(folder(context), '.swag-scan');
  const { page, data, state } = writeDashboard({ swagDir });
  assert.equal(state.status, 'waiting');
  assert.ok(readFileSync(page, 'utf8').includes('Swag Scan Live View'));
  assert.match(readFileSync(data, 'utf8'), /^window\.SWAG_SCAN_DATA = \{/);
  assert.ok(page.endsWith(DASHBOARD_FILE) && data.endsWith(DATA_FILE));
});

test('watching ends when the run ends, and a leftover finished run does not end it early', async (context) => {
  const swagDir = join(folder(context), '.swag-scan');
  const runDir = join(swagDir, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(ev(0, { kind: 'run-started', agent: 'swag-scan' }))}\n${JSON.stringify(ev(1, { kind: 'run-done', agent: 'swag-scan', count: 9 }))}\n`);
  const watching = watchDashboard({ swagDir, intervalMs: 20 });
  let settled = false;
  watching.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, false, 'the old run is ignored');
  // A new run replaces the folder, as swag-scan run does.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  emit(runDir, { kind: 'run-started' });
  emit(runDir, { kind: 'run-done', phase: 'report', count: 1 });
  const final = await watching;
  assert.equal(final.status, 'done');
  assert.equal(final.stats.needs, 1);
});

test('a finished run links to its report only when the report exists; an error never links', (context) => {
  const swagDir = join(folder(context), '.swag-scan');
  const runDir = join(swagDir, 'run');
  mkdirSync(runDir, { recursive: true });
  emit(runDir, { kind: 'run-started' });
  emit(runDir, { kind: 'run-done', phase: 'report', count: 0 });
  assert.equal(writeDashboard({ swagDir }).state.result.href, undefined, 'no report file yet');
  writeFileSync(join(runDir, 'report.md'), '# Report\n');
  assert.equal(writeDashboard({ swagDir }).state.result.href, 'run/report.md');
  writeFileSync(join(runDir, 'report.html'), '<!doctype html>');
  assert.equal(writeDashboard({ swagDir }).state.result.href, 'run/report.html', 'the web page is preferred over raw Markdown');
  assert.match(readFileSync(join(swagDir, 'dashboard.html'), 'utf8'), /Open the full report/);
});

test('a failed write does not end the watcher: it keeps trying and finishes when the run does', async (context) => {
  const swagDir = join(folder(context), '.swag-scan');
  const runDir = join(swagDir, 'run');
  mkdirSync(runDir, { recursive: true });
  // A non-empty folder where the data file belongs makes every write fail, like a file the OS will not replace.
  const blocker = join(swagDir, DATA_FILE);
  mkdirSync(blocker, { recursive: true });
  writeFileSync(join(blocker, 'keep'), 'x');
  const watching = watchDashboard({ swagDir, intervalMs: 20 });
  let settled = false;
  watching.then(() => { settled = true; });
  emit(runDir, { kind: 'run-started' });
  emit(runDir, { kind: 'run-done', phase: 'report', count: 2 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, 'writes are failing, so the watcher keeps waiting instead of crashing');
  rmSync(blocker, { recursive: true, force: true });
  const final = await watching;
  assert.equal(final.status, 'done');
  assert.match(readFileSync(join(swagDir, DATA_FILE), 'utf8'), /SWAG_SCAN_DATA/);
});

test('an agent whose review was reused says so, and its earlier findings count in the Findings tile', () => {
  const summary = { agents: [
    { id: 'analyst', cache: { hit: false } },
    { id: 'inspector', cache: { hit: true, findings: 4 } },
  ] };
  const state = buildState([
    ev(0, { kind: 'run-started', agent: 'swag-scan', phase: 'scan', steps: 3 }),
    ev(1, { kind: 'done', agent: 'inspector', phase: 'scan', count: 15 }),
    ev(2, { kind: 'started', agent: 'analyst', phase: 'review' }),
    ev(3, { kind: 'saved', agent: 'analyst', phase: 'review', count: 2 }),
    ev(4, { kind: 'run-done', agent: 'swag-scan', phase: 'report', count: 2 }),
  ], summary, { now: T0 });
  assert.equal(agent(state, 'inspector').state, 'done');
  assert.match(agent(state, 'inspector').line, /^Reused the earlier review/);
  assert.doesNotMatch(agent(state, 'inspector').line, /lead|closer look/);
  assert.equal(state.stats.findings, 6);
  assert.equal(state.stats.reused, 4);
  assert.equal(state.feed.some((entry) => /closer look/.test(entry.text)), false);
});

test('without a cache hit nothing is marked as reused', () => {
  const state = buildState([ev(0, { kind: 'run-started', agent: 'swag-scan' })], { agents: [{ id: 'analyst', cache: { hit: false } }] }, { now: T0 });
  assert.equal(state.stats.reused, 0);
  assert.equal(agent(state, 'analyst').reused, null);
});

test('the watcher rewrites the page file when a new run starts, so a finished page does not stay frozen', async (context) => {
  const swagDir = join(folder(context), '.swag-scan');
  const runDir = join(swagDir, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(ev(0, { kind: 'run-started', agent: 'swag-scan' }))}\n${JSON.stringify(ev(1, { kind: 'run-done', agent: 'swag-scan', count: 9 }))}\n`);
  const watching = watchDashboard({ swagDir, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(readFileSync(join(swagDir, DASHBOARD_FILE), 'utf8'), /"status":"done"/, 'the page starts out holding the old finished run');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  emit(runDir, { kind: 'run-started' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const page = readFileSync(join(swagDir, DASHBOARD_FILE), 'utf8');
  assert.match(page, /"status":"live"/);
  assert.doesNotMatch(page, /"status":"done"/);
  emit(runDir, { kind: 'run-done', phase: 'report', count: 1 });
  await watching;
});

test('stale temp files from a cut-off write are removed, fresh ones and other files are kept', (context) => {
  const swagDir = folder(context);
  const old = join(swagDir, 'dashboard-data.js.1234.tmp');
  const fresh = join(swagDir, 'dashboard-data.js.5678.tmp');
  const other = join(swagDir, 'notes.tmp');
  for (const file of [old, fresh, other]) writeFileSync(file, 'x');
  utimesSync(old, new Date(T0), new Date(T0));
  const removed = cleanStaleTemps(swagDir, { now: T0 + 10 * 60 * 1000 });
  assert.deepEqual(removed, ['dashboard-data.js.1234.tmp']);
  assert.equal(existsSync(old), false);
  utimesSync(fresh, new Date(T0 + 10 * 60 * 1000), new Date(T0 + 10 * 60 * 1000));
  assert.deepEqual(cleanStaleTemps(swagDir, { now: T0 + 10 * 60 * 1000 }), []);
  assert.equal(existsSync(other), true);
});

test('a finished page keeps a slow poll, so an old browser tab notices a newer run', () => {
  const page = readFileSync(PAGE_TEMPLATE, 'utf8');
  assert.match(page, /DONE_POLL_MS/);
  assert.doesNotMatch(page, /if \(data\.status === 'live' \|\| data\.status === 'waiting'\) timer/);
});
