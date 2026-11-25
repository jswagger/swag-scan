#!/usr/bin/env node
// Swag Scan orchestrator: one fixed entry point that runs every agent's scripts in a fixed order, with no model
// deciding what to run. Pass 1 is scripts only (no model tokens) and changes no files; its findings are "leads".
//
// Usage: swag-scan.mjs run [<ticket-id>] [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>]
//                          [--agents analyst,inspector,security-guard] [--fresh] [--json]
//        swag-scan.mjs config [show|get <key>|set <key> <value>...|unset targetBranch|path] [--this-repo] [--json]   (see settings.mjs)
//        swag-scan.mjs doctor [--repo <dir>] [--json]     (checks Node, git, the base branch, the ticket folder and the ignore rule)
//        swag-scan.mjs report [--repo <dir>] [--json]     (after the agents have saved their findings)
//        swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]   (the live view page: .swag-scan/dashboard.html)
//
// `run` works without a config (it uses the defaults) and reads targetBranch (the base), maxFileLines and autoFix from
// the config from /swag-scan:config when there is one; --base and --ticket-dir stay as one-off overrides.
// Results go to <repo>/.swag-scan/run/ (gitignored, replaced on every run): one JSON file per step and summary.json.
// Exit code 0 means the scan ran (even if it found nothing); 1 means it could not run, with one plain sentence why.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_CANDIDATES, listBranches, missingBranchMessage, noBaseWarning } from './branches.mjs';
import { checkCache } from './cache.mjs';
import { emit, readEvents } from './events.mjs';
import { DASHBOARD_FILE, buildState, watchDashboard, writeDashboard } from './dashboard.mjs';
import { writeReport } from './report.mjs';
import { AUTO_BRANCH, loadSettings, parseSetting, renderSettings, saveRepoBranch, saveSettings, SETTING_KEYS, SettingsError, targetBranchFor } from './settings.mjs';
import { looksLikePath } from './ticket.mjs';

const COMMON_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = dirname(COMMON_DIR);
export const SUMMARY_SCHEMA = 1;

/** The crew, in the fixed order they run. Each agent carries a tool belt of skills. */
export const AGENTS = [
  { id: 'analyst', name: 'Analyst', tool: 'bug-hunter' },
  { id: 'inspector', name: 'Inspector', tool: 'code-sweeper' },
  { id: 'security-guard', name: 'Security Guard', tool: 'security-auditor' },
];

const SUPPORTED_LANGUAGES = 'TypeScript, JavaScript, Python, C#';
const TOOL_TITLES = { 'bug-hunter': 'Bug Hunter', 'code-sweeper': 'Code Sweeper', 'security-auditor': 'Security Auditor' };

/** An expected failure: its message is shown to the user as is, never with a stack trace. */
export class PlainError extends Error {}

// A step that stops with a sentence starting like this has already explained itself: the sentence is shown as is.
const PLAIN_PREFIX = 'Swag Scan: ';
const STEP_NAMES = {
  'collect-diff.mjs': 'read your changes with git',
  'check-diff-size.mjs': 'check how big your change is',
  'gather-context.mjs': 'read the ticket and the code around your change',
  'scan-patterns.mjs': 'scan your changes for leads',
  'find-callers.mjs': 'look up where the changed code is used',
  'build-packets.mjs': 'prepare what the reviewers will read',
};

/** One plain sentence and a next step in place of a script path and its raw error. */
export function plainStepError(script, error) {
  const last = String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (last.startsWith(PLAIN_PREFIX)) return last.slice(PLAIN_PREFIX.length);
  const step = STEP_NAMES[basename(script)] ?? 'finish one of its steps';
  const detail = last.replace(/^Error: /, '').replace(/^Failed to collect diff from \S+: /, '').replace(/^fatal: /, '');
  return `Swag Scan could not ${step}${detail ? ` (it said: ${detail})` : ''}. Nothing was reviewed and no model tokens were spent. `
    + 'Next step: run `swag-scan doctor` to check your setup. If that looks fine, report this at https://github.com/jswagger/swag-scan/issues.';
}

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
    throw new PlainError(plainStepError(script, error));
  }
}

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

/** The git version line, or undefined when git is not installed. */
function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^git version /, '');
  } catch {
    return undefined;
  }
}

export const SUPPORTED_NODE_MAJORS = [22, 24];

/** Node and git, checked before a run. A problem stops the run with one sentence; a warning is only shown. */
export function preflight({ nodeVersion = process.versions.node, git: gitFound = gitVersion() } = {}) {
  const major = Number(String(nodeVersion).split('.')[0]);
  const problems = [];
  const warnings = [];
  if (!(major >= SUPPORTED_NODE_MAJORS[0])) {
    problems.push(`Swag Scan needs Node 22 or 24, and this is Node ${nodeVersion}. Install Node 24 from https://nodejs.org, restart Claude Code and run it again.`);
  } else if (!SUPPORTED_NODE_MAJORS.includes(major)) {
    warnings.push(`Node ${nodeVersion} is not one Swag Scan is tested on (22 and 24), so it may not behave as expected.`);
  }
  if (!gitFound) problems.push('Swag Scan needs git, and it was not found on your PATH. Install git from https://git-scm.com, restart Claude Code and run it again.');
  return { problems, warnings };
}

/**
 * Keeps the tool's folder out of `git status` by adding `.swag-scan/` to this clone's own .git/info/exclude (local only,
 * never a tracked file). Does nothing when something already ignores it. Returns true when it added the line.
 */
export function ensureLocalExclude(root) {
  try {
    if (git(root, ['check-ignore', '-q', '.swag-scan/run']) !== undefined) return false;
    const relativePath = git(root, ['rev-parse', '--git-path', 'info/exclude']);
    if (!relativePath) return false;
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}.swag-scan/\n`);
    return true;
  } catch {
    return false; // a convenience: never stops a scan
  }
}

/** `swag-scan doctor`: what a run needs, checked one by one, each with a next step when it is not right. */
export function doctor({ repo = process.cwd() } = {}, { env = process.env, home } = {}) {
  const checks = [];
  const add = (status, label, detail, fix) => checks.push({ status, label, detail, ...(fix ? { fix } : {}) });
  const environment = preflight();
  const nodeVersion = process.versions.node;
  if (environment.problems.some((problem) => problem.includes('Node'))) add('fail', 'Node', `Node ${nodeVersion}`, 'Install Node 24 from https://nodejs.org, then restart Claude Code.');
  else if (environment.warnings.length) add('warn', 'Node', `Node ${nodeVersion} (tested on 22 and 24)`);
  else add('ok', 'Node', `Node ${nodeVersion}`);
  const version = gitVersion();
  if (version) add('ok', 'git', `git ${version}`);
  else add('fail', 'git', 'not found on your PATH', 'Install git from https://git-scm.com, then restart Claude Code.');

  const root = version ? git(resolve(repo), ['rev-parse', '--show-toplevel']) : undefined;
  if (!root) {
    add('fail', 'Repository', `${resolve(repo)} is not inside a git repository`, 'Start Claude Code inside the repository you want reviewed.');
  } else {
    add('ok', 'Repository', root);
    if (!git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])) add('fail', 'Commits', 'this repository has no commits yet', 'Make a first commit, then run Swag Scan.');
    const loaded = loadSettings(env, home);
    const runGit = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const exists = (ref) => git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;
    const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '';
    const target = targetBranchFor(loaded, root);
    const from = target.source === 'this repository' ? ' (set for this repository)' : target.source === 'config' ? ' (from your config)' : '';
    if (target.branch === AUTO_BRANCH) {
      const found = BASE_CANDIDATES.filter(exists);
      if (found.length) add('ok', 'Base branch', `auto-detect would consider: ${found.join(', ')}`);
      else add('fail', 'Base branch', noBaseWarning(listBranches(runGit), current), 'Pick the branch your work merges into with /swag-scan:config.');
    } else if (exists(target.branch) || exists(`origin/${target.branch}`)) {
      add('ok', 'Base branch', `${target.branch}${from}`);
    } else {
      add('fail', 'Base branch', `${target.branch}${from} does not exist here`, missingBranchMessage(target.branch, listBranches(runGit), current).slice(PLAIN_PREFIX.length));
    }
    const folder = loaded.values.ticketSourcePath;
    if (!folder) add('ok', 'Ticket folder', 'not set (fine: you can run without a ticket)');
    else if (existsSync(folder)) add('ok', 'Ticket folder', folder);
    else add('warn', 'Ticket folder', `${folder} does not exist`, 'Create the folder, or change it with /swag-scan:config. Runs without a ticket still work.');
    if (git(root, ['check-ignore', '-q', '.swag-scan/run']) !== undefined) add('ok', 'Ignore rule', '.swag-scan/ is already ignored by git');
    else add('ok', 'Ignore rule', '.swag-scan/ is not ignored yet; the first run adds it to .git/info/exclude (this clone only)');
  }
  const ok = checks.every((check) => check.status !== 'fail');
  const mark = { ok: '✅', warn: '🟡', fail: '🔴' };
  const text = [
    `Swag Scan doctor: ${ok ? 'ready to run' : 'something needs fixing first'}`,
    ...checks.map((check) => `${mark[check.status]} ${check.label}: ${check.detail}${check.fix ? `\n   Next step: ${check.fix}` : ''}`),
    ...environment.warnings.map((warning) => `🟡 ${warning}`),
  ].join('\n');
  return { ok, checks, text };
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
    // The ticket's criteria reach the reviewers as context only (see ticket.mjs). Only the ticket's identity is kept
    // for the report header; no criterion or status is saved or reported.
    if (found.found) {
      result.files.ticketReport = join(runDir, 'ticket-report.json');
      writeFileSync(result.files.ticketReport, `${JSON.stringify({ id: found.ticketName, source: found.source, title: found.title, repositories: found.repositories ?? [] }, null, 2)}\n`);
    }
    progress('ticket');
    result.ticket = {
      found: found.found,
      ...(found.ticketName ? { id: found.ticketName } : {}),
      ...(found.source ? { source: found.source } : {}),
      criteria: (found.acceptanceCriteria ?? []).length,
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
  lines.push(`Swag Scan: ${summary.branch ?? 'detached HEAD'} vs ${base} · report-only`);
  if (summary.usedDefaults) lines.push('No config is saved yet, so this run used the defaults. Run /swag-scan:config to choose your own.');
  if (summary.noSupportedLanguage) {
    lines.push(`None of your changed files are in a language Swag Scan reviews (${SUPPORTED_LANGUAGES}), so ${summary.totalLeads ? 'only the checks on build files, workflows and secrets can find anything' : 'no reviewer will run'}.`);
  }
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
  const starting = summary.agents.filter((agent) => agent.status === 'done' && !agent.cache?.hit && agent.leads > 0);
  if (starting.length) {
    const skipped = summary.agents.filter((agent) => !starting.includes(agent));
    const names = (list) => list.map((agent) => agent.name).join(', ');
    lines.push(`Next: ${names(starting)} will review ${starting.length === 1 ? 'its' : 'their'} leads. The scripts above used no model tokens; the reviewers do${skipped.length ? `. Skipped: ${names(skipped)} (nothing to review)` : ''}.`);
  }
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
export function runScan({ repo = process.cwd(), base, ticket, ticketDir, agents, fresh = false, settings, usedDefaults = false, log = () => {}, now = () => Date.now() } = {}) {
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

  if (ensureLocalExclude(root)) log('Added .swag-scan/ to .git/info/exclude (this clone only), so Swag Scan\'s files stay out of git status.');
  if (usedDefaults) log('No config saved yet: using the defaults (branch auto-detected, live view on, auto-fix off). Run /swag-scan:config to choose your own.');
  log(`Scanning with scripts: ${crew.map((agent) => agent.name).join(', ')} · report-only · this step uses no model tokens`);
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
  const scanned = results.filter((entry) => entry.status !== 'empty' && entry.coverage);
  const totalLeads = results.reduce((sum, entry) => sum + (entry.leads ?? 0), 0);
  const noSupportedLanguage = scanned.length > 0 && scanned.every((entry) => Object.keys(entry.coverage.checked ?? {}).length === 0);
  const withTicket = results.find((entry) => entry.ticket);
  const summary = {
    schemaVersion: SUMMARY_SCHEMA,
    repo: root,
    branch,
    head,
    mode: 'report-only',
    modelTokens: 0,
    ...(settings ? { settings } : {}),
    ...(usedDefaults ? { usedDefaults: true } : {}),
    ...(noSupportedLanguage ? { noSupportedLanguage: true } : {}),
    totalLeads,
    base: first ? { ref: first.baseRef, autoDetected: first.autoDetected } : null,
    ticket: withTicket?.ticket,
    agents: results,
    runDir: relative(root, runDir) || '.',
    durationMs: now() - started,
  };
  summary.text = renderSummary(summary);
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  emit(runDir, { kind: 'done', phase: 'scan', count: totalLeads, steps: crew.length });
  return summary;
}

const USAGE = 'Usage: swag-scan.mjs run [<ticket-id>] [--repo <dir>] [--base <ref>] [--ticket <id-or-path>] [--ticket-dir <dir>] [--agents analyst,inspector,security-guard] [--fresh] [--json]\n       swag-scan.mjs report [--repo <dir>] [--json]\n       swag-scan.mjs dashboard [--repo <dir>] [--watch] [--open]\n       swag-scan.mjs config [show|get <key>|set <key> <value>...|unset targetBranch|path] [--this-repo] [--repo <dir>] [--json]\n       swag-scan.mjs doctor [--repo <dir>] [--json]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['run', 'report', 'dashboard', 'config', 'doctor'].includes(command)) throw new PlainError(USAGE);
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
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--this-repo') options.thisRepo = true;
    else if (arg === '--repo') {
      if (i + 1 >= rest.length) throw new PlainError('Missing value for --repo.');
      options.repo = rest[(i += 1)];
    } else if (arg.startsWith('--')) throw new PlainError(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  if (words.length) {
    options.action = words[0];
    options.args = words.slice(1);
  }
  if (!['show', 'get', 'set', 'unset', 'path'].includes(options.action)) throw new PlainError(`Unknown config action "${options.action}". Use show, get <key>, set <key> <value>, unset targetBranch --this-repo, or path.`);
  return options;
}

/**
 * Loads the user's config for a run. Without a saved config the scan still runs, on the defaults (`usedDefaults` says so),
 * so a new user can see a report before any setup. The branch to compare against is, in order: --base, this repository's
 * own override, the config's `targetBranch`, then "auto" (detect origin/HEAD, develop, main or master).
 */
export function prepareRun(options, { env = process.env, home } = {}) {
  const loaded = loadSettings(env, home);
  const root = git(resolve(options.repo ?? process.cwd()), ['rev-parse', '--show-toplevel']);
  const target = targetBranchFor(loaded, root);
  const { liveDashboard, autoFix, maxFileLines } = loaded.values;
  return { ...options, base: options.base ?? target.branch, usedDefaults: !loaded.configured, settings: { targetBranch: target.branch, liveDashboard, autoFix, maxFileLines } };
}

/** `swag-scan config ...`: show, read one value, or save values. Returns the text to print. */
export function configCommand({ action, args, json, thisRepo, repo }, { env = process.env, home } = {}) {
  const loaded = loadSettings(env, home);
  const repoRoot = () => {
    const root = git(resolve(repo ?? process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!root) throw new PlainError(`${resolve(repo ?? process.cwd())} is not a git repository, so there is no repository to set a branch for. Start Claude Code inside the repository.`);
    return root;
  };
  if (action === 'path') return loaded.path;
  if (action === 'get') {
    if (args.length !== 1 || !SETTING_KEYS.includes(args[0])) throw new PlainError(`Usage: config get <key>. Keys: ${SETTING_KEYS.join(', ')}.`);
    if (thisRepo && args[0] === 'targetBranch') return targetBranchFor(loaded, repoRoot()).branch;
    return String(loaded.values[args[0]]);
  }
  if (action === 'unset') {
    if (!thisRepo || args.length !== 1 || args[0] !== 'targetBranch') throw new PlainError('Usage: config unset targetBranch --this-repo');
    const saved = saveRepoBranch(repoRoot(), '', env, home);
    return `Removed the target branch for this repository. It now uses ${saved.values.targetBranch}.`;
  }
  if (action === 'set' && thisRepo) {
    if (args.length !== 2 || args[0] !== 'targetBranch') throw new PlainError('Usage: config set targetBranch <branch> --this-repo (only the target branch can be set for one repository).');
    try {
      const root = repoRoot();
      const saved = saveRepoBranch(root, args[1], env, home);
      return `Saved for ${root}: compare against ${targetBranchFor(saved, root).branch}.\nOther repositories keep using ${saved.values.targetBranch}.`;
    } catch (error) {
      throw error instanceof SettingsError ? new PlainError(error.message) : error;
    }
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
  const root = git(resolve(repo ?? process.cwd()), ['rev-parse', '--show-toplevel']);
  const override = root ? loaded.repoBranches[resolve(root)] : undefined;
  return json
    ? JSON.stringify({ path: loaded.path, configured: loaded.configured, ...loaded.values, ...(override ? { repoTargetBranch: override } : {}) }, null, 2)
    : renderSettings(loaded, override);
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
  // Watching means a scan is about to start. If the run on disk already finished, draw "waiting" first, so the new tab
  // never shows the old run's stats as complete until the new run replaces them.
  const earlier = buildState(readEvents(join(swagDir, 'run')), undefined);
  const { page, state } = writeDashboard({ swagDir, blank: watch && (earlier.status === 'done' || earlier.status === 'error') });
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
    } else if (command === 'doctor') {
      const result = doctor(options);
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'run') {
      const environment = preflight();
      if (environment.problems.length) throw new PlainError(environment.problems.join(' '));
      for (const warning of environment.warnings) process.stderr.write(`Warning: ${warning}\n`);
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
