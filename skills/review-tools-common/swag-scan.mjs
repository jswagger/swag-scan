#!/usr/bin/env node
// Swag Scan orchestrator: one fixed entry point that runs every agent's scripts in a fixed order, with no model
// deciding what to run. Pass 1 is scripts only (no model tokens) and changes no files; its findings are "leads".
//
// Usage: swag-scan.mjs run [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>]
//                          [--agents analyst,inspector,security-guard] [--fresh] [--json]
//        swag-scan.mjs report [--repo <dir>] [--json]     (after the agents have saved their findings)
//        swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]   (the live view page: .swag-scan/dashboard.html)
//
// Results go to <repo>/.swag-scan/run/ (gitignored, replaced on every run): one JSON file per step and summary.json.
// Exit code 0 means the scan ran (even if it found nothing); 1 means it could not run, with one plain sentence why.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCache } from './cache.mjs';
import { emit } from './events.mjs';
import { watchDashboard, writeDashboard } from './dashboard.mjs';
import { writeReport } from './report.mjs';

const COMMON_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = dirname(COMMON_DIR);
export const SUMMARY_SCHEMA = 1;

/** The crew, in the fixed order they run. Each agent carries a tool belt of skills. */
export const AGENTS = [
  { id: 'analyst', name: 'Analyst', tool: 'bug-hunter' },
  { id: 'inspector', name: 'Inspector', tool: 'code-sweeper' },
  { id: 'security-guard', name: 'Security Guard', tool: 'security-auditor' },
];

const TOOL_TITLES = { 'bug-hunter': 'Bug Hunter', 'code-sweeper': 'Code Sweeper', 'security-auditor': 'Security Auditor' };

/** An expected failure: its message is shown to the user as is, never with a stack trace. */
export class PlainError extends Error {}

function node(script, args, { cwd, input } = {}) {
  try {
    return execFileSync(process.execPath, [script, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).at(-1) ?? 'unknown error';
    throw new PlainError(`${relative(SKILLS_DIR, script)} failed: ${detail}`);
  }
}

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Runs one tool's script pipeline for a repo. Returns what the summary needs; writes each step's JSON to `runDir`. */
function runTool({ tool, agentId, repo, base, ticket, ticketDir, branch, runDir, fresh }) {
  const skill = join(SKILLS_DIR, tool);
  const config = join(skill, 'config.json');
  const scripts = join(skill, 'scripts');
  const file = (name) => join(runDir, `${tool}-${name}.json`);
  const save = (name, text) => { writeFileSync(file(name), text); return file(name); };
  const read = (name) => JSON.parse(readFileSync(file(name), 'utf8'));
  const result = { tool, files: {} };
  // One event per finished script, as "step n of m": real counts, never a percentage.
  const totalSteps = tool === 'bug-hunter' ? 6 : 2;
  let stepNumber = 0;
  const progress = (label) => emit(runDir, { kind: 'progress', agent: agentId, phase: 'scan', step: (stepNumber += 1), steps: totalSteps, label });

  const diffText = node(join(COMMON_DIR, 'collect-diff.mjs'), ['--config', config, ...(base ? [base] : [])], { cwd: repo });
  result.files.diff = save('diff', diffText);
  progress('collect');
  const diff = JSON.parse(diffText);
  Object.assign(result, {
    baseRef: diff.baseRef,
    autoDetected: Boolean(diff.autoDetected),
    changedCount: diff.changedCount,
    excludedCount: diff.excludedCount,
    scannedCount: diff.files.length,
    diffBytes: diff.diffBytes,
    coverage: diff.coverage,
    suggestion: diff.suggestion,
  });
  if (diff.emptyDiff) return { ...result, status: 'empty', leads: 0 };

  let contextPath;
  if (tool === 'bug-hunter') {
    const size = JSON.parse(node(join(scripts, 'check-diff-size.mjs'), ['--config', config, '--diff', result.files.diff, '--non-interactive']));
    result.sizeGate = { decision: size.decision, bytes: size.bytes, limit: size.limit, notice: size.notice };
    progress('size-gate');
    contextPath = save('context', node(join(scripts, 'gather-context.mjs'), [
      '--config', config, '--diff', result.files.diff, ...(branch ? ['--branch', branch] : []),
      ...(ticket ? ['--ticket', ticket] : []), ...(ticketDir ? ['--ticket-dir', ticketDir] : []),
    ], { cwd: repo }));
    result.files.context = contextPath;
    const context = read('context');
    const found = context.ticket;
    // Reviewers must not see what is already built, so criterion status is kept out of the files the agents read
    // and saved separately for the report: ticket-report.json.
    const statuses = (found.acceptanceCriteria ?? []).map(({ id, title, description, repository, status }) => ({ id, title, description, repository, status }));
    if (found.acceptanceCriteria) {
      for (const row of found.acceptanceCriteria) delete row.status;
      writeFileSync(file('context'), JSON.stringify(context, null, 2));
    }
    if (found.found) {
      result.files.ticketReport = join(runDir, 'ticket-report.json');
      writeFileSync(result.files.ticketReport, `${JSON.stringify({ id: found.ticketName, source: found.source, title: found.title, criteria: statuses, repositories: found.repositories ?? [] }, null, 2)}\n`);
    }
    progress('ticket');
    result.ticket = {
      found: found.found,
      ...(found.ticketName ? { id: found.ticketName } : {}),
      ...(found.source ? { source: found.source } : {}),
      criteria: statuses.length,
      criteriaIds: statuses.map((row) => String(row.id)),
      repositories: found.repositories ?? [],
      notes: found.notes ?? [],
    };

    result.files.scan = save('scan', node(join(scripts, 'scan-patterns.mjs'), ['--config', config, '--diff', result.files.diff], { cwd: repo }));
    progress('scan');
    result.files.callers = save('callers', node(join(scripts, 'find-callers.mjs'), ['--config', config, '--diff', result.files.diff, '--scan', result.files.scan], { cwd: repo }));
    progress('callers');
    result.files.packets = save('packets', node(join(scripts, 'build-packets.mjs'), [
      '--config', config, '--diff', result.files.diff, '--scan', result.files.scan, '--callers', result.files.callers,
      '--non-interactive', ...(size.decision === 'review-riskiest' ? ['--budget-bytes', String(size.budgetBytes)] : []),
    ], { cwd: repo }));
    progress('packets');
    const scan = read('scan');
    result.leads = scan.script_findings.length;
    result.coverage = scan.coverage ?? result.coverage;
    const packets = read('packets');
    if (packets.omitted?.length) result.omittedPackets = packets.omitted.length;
  } else {
    // Code Sweeper and Security Auditor read the collector JSON on stdin. Code Sweeper never edits here (--no-fix).
    const args = tool === 'code-sweeper' ? ['--no-fix'] : [];
    result.files.scan = save('scan', node(join(scripts, 'scan-patterns.mjs'), args, { cwd: repo, input: diffText }));
    progress('scan');
    const scan = read('scan');
    result.leads = scan.candidates.length;
    result.coverage = scan.coverage ?? result.coverage;
  }

  try {
    const cache = checkCache({ tool, configPath: config, diffPath: result.files.diff, contextPath, repo, fresh });
    result.cache = { hit: cache.hit, cacheable: cache.cacheable, key: cache.key, reason: cache.reason, ...(cache.hit ? { reports: cache.entry.reports, summary: cache.entry.summary } : {}) };
  } catch (error) {
    result.cache = { hit: false, cacheable: false, key: null, reason: `Cache unavailable: ${error.message}` };
  }
  return { ...result, status: 'done' };
}

export function renderSummary(summary) {
  const lines = [];
  const base = summary.base ? `${summary.base.ref}${summary.base.autoDetected ? ' (auto-detected)' : ''}` : 'no base found';
  lines.push(`Swag Scan: ${summary.branch ?? 'detached HEAD'} vs ${base} · report-only · ${summary.modelTokens} model tokens`);
  for (const agent of summary.agents) {
    const title = `${agent.name} (${TOOL_TITLES[agent.tool]})`;
    if (agent.status === 'empty') lines.push(`${title}: no changes to check. ${agent.suggestion ?? ''}`.trim());
    else {
      const extras = [
        agent.cache?.hit ? 'already reviewed at this commit' : '',
        agent.sizeGate?.decision === 'review-riskiest' ? `size limit hit, riskiest first (${plural(agent.omittedPackets ?? 0, 'part')} skipped)` : '',
      ].filter(Boolean);
      lines.push(`${title}: ${plural(agent.leads, 'lead')} in ${plural(agent.scannedCount, 'file')}${extras.length ? ` · ${extras.join(' · ')}` : ''}`);
    }
  }
  const coverage = summary.agents.find((agent) => agent.coverage?.line)?.coverage;
  if (coverage) lines.push(coverage.line);
  const ticket = summary.ticket;
  if (ticket?.found) lines.push(`Ticket ${ticket.id} (from ${ticket.source}): ${plural(ticket.criteria, 'acceptance criterion', 'acceptance criteria')}${ticket.repositories.length ? `, ${plural(ticket.repositories.length, 'repository', 'repositories')}` : ''}`);
  else if (ticket?.notes?.length) lines.push(`Ticket${ticket.id ? ` ${ticket.id}` : ''}: ${ticket.notes[0].replace(/^Cannot look up \S+: /, '').split('. ')[0].replace(/\.$/, '')}.`);
  lines.push(`Leads come from scripts and are not verified findings. Details: ${summary.runDir}`);
  return lines.join('\n');
}

/** Runs the scan. `log` receives one progress line per agent as it finishes. */
export function runScan({ repo = process.cwd(), base, ticket, ticketDir, agents, fresh = false, log = () => {}, now = () => Date.now() } = {}) {
  const started = now();
  const root = git(resolve(repo), ['rev-parse', '--show-toplevel']);
  if (!root) throw new PlainError(`${resolve(repo)} is not a git repository, so there is nothing to scan.`);

  const selected = agents?.length ? agents : AGENTS.map((agent) => agent.id);
  const unknown = selected.filter((id) => !AGENTS.some((agent) => agent.id === id));
  if (unknown.length) throw new PlainError(`Unknown agent "${unknown[0]}". Choose from: ${AGENTS.map((agent) => agent.id).join(', ')}.`);
  const crew = AGENTS.filter((agent) => selected.includes(agent.id));

  const runDir = join(root, '.swag-scan', 'run');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head) throw new PlainError('This repository has no commits yet, so there is nothing to scan.');

  log(`Running: ${crew.map((agent) => agent.name).join(', ')} · scripts only, report-only, no model tokens`);
  emit(runDir, { kind: 'run-started', phase: 'scan', steps: crew.length, label: 'scan' });
  const results = [];
  for (const [index, agent] of crew.entries()) {
    const toolStart = now();
    emit(runDir, { kind: 'started', agent: agent.id, phase: 'scan', step: index + 1, steps: crew.length });
    let result;
    try {
      result = runTool({ tool: agent.tool, agentId: agent.id, repo: root, base, ticket, ticketDir, branch, runDir, fresh });
    } catch (error) {
      emit(runDir, { kind: 'error', agent: agent.id, phase: 'scan', label: error instanceof PlainError ? error.message : 'scan failed' });
      throw error;
    }
    const entry = { ...agent, ...result, durationMs: now() - toolStart };
    results.push(entry);
    emit(runDir, { kind: 'done', agent: agent.id, phase: 'scan', count: entry.leads, label: entry.status === 'empty' ? 'no changes' : undefined });
    log(`[${index + 1}/${crew.length}] ${agent.name} · ${TOOL_TITLES[agent.tool]}: ${entry.status === 'empty' ? 'no changes' : plural(entry.leads, 'lead')} (${seconds(entry.durationMs)})`);
  }

  const first = results.find((entry) => entry.baseRef);
  const withTicket = results.find((entry) => entry.ticket);
  const summary = {
    schemaVersion: SUMMARY_SCHEMA,
    repo: root,
    branch,
    head,
    mode: 'report-only',
    modelTokens: 0,
    base: first ? { ref: first.baseRef, autoDetected: first.autoDetected } : null,
    ticket: withTicket?.ticket,
    agents: results,
    runDir: relative(root, runDir) || '.',
    durationMs: now() - started,
  };
  summary.text = renderSummary(summary);
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  emit(runDir, { kind: 'done', phase: 'scan', count: results.reduce((sum, entry) => sum + (entry.leads ?? 0), 0), steps: crew.length });
  return summary;
}

const USAGE = 'Usage: swag-scan.mjs run [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>] [--agents analyst,inspector,security-guard] [--fresh] [--json]\n       swag-scan.mjs report [--repo <dir>] [--json]\n       swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['run', 'report', 'dashboard'].includes(command)) throw new PlainError(USAGE);
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new PlainError(`Missing value for ${arg}.`);
      return rest[(i += 1)];
    };
    if (arg === '--repo') options.repo = value();
    else if (arg === '--json') options.json = true;
    else if (command === 'dashboard' && arg === '--watch') options.watch = true;
    else if (command === 'dashboard' && arg === '--open') options.open = true;
    else if (command === 'run' && arg === '--base') options.base = value();
    else if (command === 'run' && arg === '--ticket') options.ticket = value();
    else if (command === 'run' && arg === '--ticket-dir') options.ticketDir = value();
    else if (command === 'run' && arg === '--agents') options.agents = value().split(',').map((id) => id.trim()).filter(Boolean);
    else if (command === 'run' && arg === '--fresh') options.fresh = true;
    else throw new PlainError(`Unknown option ${arg}.`);
  }
  return options;
}

/** Builds the consolidated report from the run folder. Writes report.md and report.json and returns the text. */
export function reportScan({ repo = process.cwd() } = {}) {
  const root = git(resolve(repo), ['rev-parse', '--show-toplevel']);
  if (!root) throw new PlainError(`${resolve(repo)} is not a git repository, so there is no scan to report on.`);
  try {
    return writeReport({ runDir: join(root, '.swag-scan', 'run'), repo: root });
  } catch (error) {
    throw new PlainError(error.message);
  }
}

/** Opens a file in the default browser. Only ever called when the user passed --open. */
function openInBrowser(path) {
  const [command, args] = process.platform === 'darwin' ? ['open', [path]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]] : ['xdg-open', [path]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The path is printed either way.
  }
}

/** Writes the live view page. With `watch`, keeps its data fresh until the run ends. Returns the page path and final state. */
export async function dashboardScan({ repo = process.cwd(), watch = false, open = false, log = () => {} } = {}) {
  const root = git(resolve(repo), ['rev-parse', '--show-toplevel']);
  if (!root) throw new PlainError(`${resolve(repo)} is not a git repository, so there is no scan to show.`);
  const swagDir = join(root, '.swag-scan');
  const { page, state } = writeDashboard({ swagDir });
  log(`Live view: ${page}`);
  if (open) openInBrowser(page);
  if (!watch) return { page, state };
  log(state.status === 'live' ? 'Watching the scan. This stops when it finishes.' : 'Watching for the next scan. Press Ctrl-C to stop.');
  return { page, state: await watchDashboard({ swagDir }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, json, ...options } = parseArgs(process.argv.slice(2));
    if (command === 'run') {
      const summary = runScan({ ...options, log: (line) => process.stderr.write(`${line}\n`) });
      process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `${summary.text}\n`);
    } else if (command === 'dashboard') {
      const { page, state } = await dashboardScan({ ...options, log: (line) => process.stderr.write(`${line}\n`) });
      process.stdout.write(json ? `${JSON.stringify(state, null, 2)}\n` : `${page}\n`);
    } else {
      const result = reportScan(options);
      process.stdout.write(json ? `${JSON.stringify(result.report, null, 2)}\n` : result.markdown);
      process.stderr.write(`Report saved: ${relative(process.cwd(), result.kept.markdown) || result.kept.markdown}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof PlainError ? error.message : `Swag Scan could not finish: ${error.message}`}\n`);
    process.exit(1);
  }
}
