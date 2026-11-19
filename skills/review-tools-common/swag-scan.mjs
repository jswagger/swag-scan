#!/usr/bin/env node
// Swag Scan orchestrator: one fixed entry point that runs every agent's scripts in a fixed order, with no model
// deciding what to run. Pass 1 is scripts only (no model tokens) and changes no files; its findings are "leads".
//
// Usage: swag-scan.mjs run [<ticket-id>] [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>]
//                          [--agents analyst,inspector,security-guard] [--fresh] [--json]
//        swag-scan.mjs config [show|get <key>|set <key> <value>...|path] [--json]   (the user-level config, see settings.mjs)
//        swag-scan.mjs report [--repo <dir>] [--json]     (after the agents have saved their findings)
//        swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]   (the live view page: .swag-scan/dashboard.html)
//
// `run` needs the config from /swag-scan:config. It reads targetBranch (the base), maxFileLines and autoFix from it;
// --base and --ticket-dir stay as one-off overrides.
// Results go to <repo>/.swag-scan/run/ (gitignored, replaced on every run): one JSON file per step and summary.json.
// Exit code 0 means the scan ran (even if it found nothing); 1 means it could not run, with one plain sentence why.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCache } from './cache.mjs';
import { emit } from './events.mjs';
import { DASHBOARD_FILE, watchDashboard, writeDashboard } from './dashboard.mjs';
import { writeReport } from './report.mjs';
import { loadSettings, parseSetting, renderSettings, saveSettings, SETTING_KEYS, SETUP_MESSAGE, SettingsError } from './settings.mjs';
import { looksLikePath, scopeCriteria } from './ticket.mjs';

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

/**
 * Looks for a file of the same name close to a ticket path that does not exist: in the folders above it and their
 * direct subfolders. This catches a typo such as a missing folder in the middle of the path. Undefined if nothing is close.
 */
export function suggestTicketPath(missing, repo) {
  const target = isAbsolute(missing) ? missing : resolve(repo, missing);
  const name = basename(target);
  let folder = dirname(target);
  for (let level = 0; level < 4; level += 1) {
    try {
      if (existsSync(join(folder, name)) && statSync(join(folder, name)).isFile()) return join(folder, name);
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const candidate = join(folder, entry.name, name);
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
      }
    } catch {
      // not readable: try the next folder up
    }
    if (folder === dirname(folder)) break;
    folder = dirname(folder);
  }
  return undefined;
}

function missingTicketMessage(ticket, note, repo) {
  const reason = (note ?? `Could not find ticket ${ticket}.`).replace(/\.$/, '');
  const guess = looksLikePath(ticket) ? suggestTicketPath(ticket, repo) : undefined;
  return `${reason}. The scan did not start, so nothing was spent on it.${guess ? ` Did you mean ${guess}?` : ''} Check the ticket ID, or run /swag-scan:config if the ticket folder is wrong. Leave the ticket out to scan without one.`;
}

/** How many findings an earlier, reused review had: read from the findings file the cache kept. Undefined if unreadable. */
function cachedFindingCount(reports) {
  try {
    const path = reports.find((report) => /findings-[^\\/]+\.json$/.test(report));
    const list = path ? JSON.parse(readFileSync(path, 'utf8')).findings : undefined;
    return Array.isArray(list) ? list.length : undefined;
  } catch {
    return undefined;
  }
}

/** Runs one tool's script pipeline for a repo. Returns what the summary needs; writes each step's JSON to `runDir`. */
function runTool({ tool, agentId, repo, base, ticket, ticketDir, branch, runDir, fresh, maxFileLines, autoFix }) {
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
    branchDiffCount: diff.branchDiffCount,
    untrackedCount: diff.untrackedCount,
    warnings: diff.warnings ?? [],
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
    // A ticket the user named on purpose that cannot be read stops the run here, before the crew spends a model review
    // on 0 criteria. A ticket guessed from the branch name, or none at all, stays a one-line note.
    if (ticket && !found.found) throw new PlainError(missingTicketMessage(ticket, found.notes?.[0], repo));
    // Reviewers must not see what is already built, so criterion status is kept out of the files the agents read
    // and saved separately for the report: ticket-report.json.
    // Criteria for other repositories stay in the report, marked as such, but findings are never linked to them.
    const statuses = scopeCriteria(found.acceptanceCriteria ?? [], basename(repo)).map(({ id, title, description, repository, status, otherRepo }) => ({ id, title, description, repository, status, otherRepo }));
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
      criteriaIds: statuses.filter((row) => !row.otherRepo).map((row) => String(row.id)),
      otherRepoCriteria: statuses.filter((row) => row.otherRepo).length,
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
    const args = tool === 'code-sweeper' ? ['--no-fix', ...(maxFileLines ? ['--max-file-lines', String(maxFileLines)] : [])] : [];
    result.files.scan = save('scan', node(join(scripts, 'scan-patterns.mjs'), args, { cwd: repo, input: diffText }));
    progress('scan');
    const scan = read('scan');
    result.leads = scan.candidates.length;
    result.coverage = scan.coverage ?? result.coverage;
  }

  try {
    const cache = checkCache({ tool, configPath: config, diffPath: result.files.diff, contextPath, repo, fresh, extraKey: tool === 'code-sweeper' ? JSON.stringify({ maxFileLines, autoFix }) : '' });
    result.cache = { hit: cache.hit, cacheable: cache.cacheable, key: cache.key, reason: cache.reason, ...(cache.hit ? { reports: cache.entry.reports, summary: cache.entry.summary, findings: cachedFindingCount(cache.entry.reports) } : {}) };
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
  const counted = summary.agents.find((agent) => agent.untrackedCount > 0);
  if (counted) lines.push(`Scanned ${plural(counted.scannedCount, 'file')}: ${counted.branchDiffCount} in the branch diff, ${counted.untrackedCount} untracked.`);
  for (const warning of new Set(summary.agents.flatMap((agent) => agent.warnings ?? []))) lines.push(`Warning: ${warning}`);
  const ticket = summary.ticket;
  if (ticket?.found) lines.push(`Ticket ${ticket.id} (from ${ticket.source}): ${plural(ticket.criteria, 'acceptance criterion', 'acceptance criteria')}${ticket.repositories.length ? `, ${plural(ticket.repositories.length, 'repository', 'repositories')}` : ''}`);
  else if (ticket?.notes?.length) lines.push(`Ticket${ticket.id ? ` ${ticket.id}` : ''}: ${ticket.notes[0].replace(/^Cannot look up \S+: /, '').split('. ')[0].replace(/\.$/, '')}.`);
  lines.push(`Leads come from scripts and are not verified findings. Details: ${summary.runDir}`);
  return lines.join('\n');
}

/**
 * A dashboard page left over from an earlier run embeds that run's finished state and would never poll again. If one
 * exists, rewrite it now so it shows the new run. Does not create a page nobody asked for, and never fails the scan.
 */
function refreshDashboardPage(swagDir) {
  try {
    if (existsSync(join(swagDir, DASHBOARD_FILE))) writeDashboard({ swagDir });
  } catch {
    // The dashboard is a convenience; a failed write must not stop a scan.
  }
}

/** Runs the scan. `log` receives one progress line per agent as it finishes. */
export function runScan({ repo = process.cwd(), base, ticket, ticketDir, agents, fresh = false, settings, log = () => {}, now = () => Date.now() } = {}) {
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
  refreshDashboardPage(join(root, '.swag-scan'));
  const results = [];
  for (const [index, agent] of crew.entries()) {
    const toolStart = now();
    emit(runDir, { kind: 'started', agent: agent.id, phase: 'scan', step: index + 1, steps: crew.length });
    let result;
    try {
      result = runTool({ tool: agent.tool, agentId: agent.id, repo: root, base, ticket, ticketDir, branch, runDir, fresh, maxFileLines: settings?.maxFileLines, autoFix: settings?.autoFix });
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
    ...(settings ? { settings } : {}),
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

const USAGE = 'Usage: swag-scan.mjs run [<ticket-id>] [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>] [--agents analyst,inspector,security-guard] [--fresh] [--json]\n       swag-scan.mjs report [--repo <dir>] [--json]\n       swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]\n       swag-scan.mjs config [show|get <key>|set <key> <value>...|path] [--json]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['run', 'report', 'dashboard', 'config'].includes(command)) throw new PlainError(USAGE);
  if (command === 'config') return parseConfigArgs(rest);
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new PlainError(`Missing value for ${arg}.`);
      return rest[(i += 1)];
    };
    if (command === 'run' && i === 0 && !arg.startsWith('-')) options.ticket = arg;
    else if (arg === '--repo') options.repo = value();
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

function parseConfigArgs(rest) {
  const options = { command: 'config', action: 'show', args: [] };
  const words = [];
  for (const arg of rest) {
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--')) throw new PlainError(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  if (words.length) {
    options.action = words[0];
    options.args = words.slice(1);
  }
  if (!['show', 'get', 'set', 'path'].includes(options.action)) throw new PlainError(`Unknown config action "${options.action}". Use show, get <key>, set <key> <value>, or path.`);
  return options;
}

/**
 * Loads the user's config for a run. Without a saved config the scan does not start (and costs nothing). The branch to
 * compare against comes from `targetBranch`, unless --base is given. Returns the options runScan needs.
 */
export function prepareRun(options, { env = process.env, home } = {}) {
  const loaded = loadSettings(env, home);
  if (!loaded.configured) throw new PlainError(SETUP_MESSAGE);
  const { targetBranch, liveDashboard, autoFix, maxFileLines } = loaded.values;
  return { ...options, base: options.base ?? targetBranch, settings: { targetBranch, liveDashboard, autoFix, maxFileLines } };
}

/** `swag-scan config ...`: show, read one value, or save values. Returns the text to print. */
export function configCommand({ action, args, json }, { env = process.env, home } = {}) {
  const loaded = loadSettings(env, home);
  if (action === 'path') return loaded.path;
  if (action === 'get') {
    if (args.length !== 1 || !SETTING_KEYS.includes(args[0])) throw new PlainError(`Usage: config get <key>. Keys: ${SETTING_KEYS.join(', ')}.`);
    return String(loaded.values[args[0]]);
  }
  if (action === 'set') {
    if (!args.length || args.length % 2) throw new PlainError(`Usage: config set <key> <value> [<key> <value> ...]. Keys: ${SETTING_KEYS.join(', ')}.`);
    const updates = {};
    for (let i = 0; i < args.length; i += 2) updates[args[i]] = args[i + 1];
    try {
      for (const [key, value] of Object.entries(updates)) parseSetting(key, value);
      const saved = saveSettings(updates, env, home);
      const lines = [json ? JSON.stringify({ configured: saved.configured, ...saved.values }, null, 2) : `Saved to ${saved.path}\n${renderSettings(saved)}`, ...saved.notes];
      return lines.join('\n');
    } catch (error) {
      throw error instanceof SettingsError ? new PlainError(error.message) : error;
    }
  }
  return json ? JSON.stringify({ path: loaded.path, configured: loaded.configured, ...loaded.values }, null, 2) : renderSettings(loaded);
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
    if (command === 'config') {
      process.stdout.write(`${configCommand({ ...options, json })}\n`);
    } else if (command === 'run') {
      const summary = runScan({ ...prepareRun(options), log: (line) => process.stderr.write(`${line}\n`) });
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
