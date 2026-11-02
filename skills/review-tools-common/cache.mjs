#!/usr/bin/env node
// Result cache keyed by commit: a re-run with no new commits, the same config and the same ticket returns the
// earlier report instead of repeating the review.
//
// Usage:
//   cache.mjs check --tool <name> --config <path> --diff <collector.json> [--context <context.json>] [--repo <dir>] [--fresh]
//   cache.mjs store --tool <name> --key <key> --report <path> [--report <path> ...] [--summary <text>] [--repo <dir>]
//
// `check` prints { hit, cacheable, key, reason, entry }. `store` records a finished run under that key.
// Results are kept in <repo>/.swag-scan/cache/. Nothing is cached when the working tree has uncommitted changes,
// because the cached answer could be stale. Add `.swag-scan/` to .gitignore.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CACHE_SCHEMA = 1;
const MAX_ENTRIES = 50;
const COMMON_DIR = dirname(fileURLToPath(import.meta.url));

const sha = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex');
};

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function filesUnder(directory, skip = () => false) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (skip(entry)) return [];
    return entry.isDirectory() ? filesUnder(path, skip) : [path];
  }).sort();
}

/** Hash of the tool itself (its SKILL.md, scripts and the shared scripts), so a tool upgrade never serves an old result. */
export function toolFingerprint(skillDir) {
  const skip = (entry) => entry.name === 'test' || entry.name === 'node_modules';
  const files = [
    ...filesUnder(skillDir, skip).filter((path) => /(?:SKILL\.md|\.mjs)$/.test(path)),
    ...filesUnder(COMMON_DIR, skip).filter((path) => path.endsWith('.mjs')),
  ];
  return sha(...files.flatMap((path) => [relative(COMMON_DIR, path), readFileSync(path)]));
}

export function cacheKey({ tool, head, baseCommit, configText, ticketText = '', fingerprint }) {
  return sha(CACHE_SCHEMA, tool, head, baseCommit, configText, ticketText, fingerprint).slice(0, 24);
}

function cacheDir(repo) {
  return join(git(repo, ['rev-parse', '--show-toplevel']), '.swag-scan', 'cache');
}

function entryPath(repo, tool, key) {
  return join(cacheDir(repo), `${tool}-${key}.json`);
}

/** True when tracked files differ from HEAD or the collector found untracked files. */
function hasUncommittedChanges(repo, collected) {
  try {
    git(repo, ['diff', '--quiet', 'HEAD']);
  } catch {
    return true;
  }
  return (collected.files ?? []).some((file) => file.status === 'untracked');
}

export function checkCache({ tool, configPath, diffPath, contextPath, repo = process.cwd(), fresh = false }) {
  const collected = JSON.parse(readFileSync(resolve(diffPath), 'utf8'));
  const none = (reason, extra = {}) => ({ hit: false, cacheable: false, key: null, reason, ...extra });
  if (hasUncommittedChanges(repo, collected)) return none('The working tree has uncommitted changes, so results are not cached.');
  if (collected.emptyDiff) return none('The diff is empty, so there is nothing to cache.');

  const head = git(repo, ['rev-parse', 'HEAD']);
  const context = contextPath && existsSync(contextPath) ? JSON.parse(readFileSync(resolve(contextPath), 'utf8')) : {};
  const key = cacheKey({
    tool,
    head,
    baseCommit: collected.baseCommitHash ?? collected.comparisonBase,
    configText: readFileSync(resolve(configPath), 'utf8'),
    ticketText: context.ticket?.found ? context.ticket.content : '',
    fingerprint: toolFingerprint(dirname(resolve(configPath))),
  });
  if (fresh) return { hit: false, cacheable: true, key, reason: 'Fresh run requested.' };

  const path = entryPath(repo, tool, key);
  if (!existsSync(path)) return { hit: false, cacheable: true, key, reason: 'No cached result for this commit.' };
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  const missing = entry.reports.filter((report) => !existsSync(report));
  if (missing.length) return { hit: false, cacheable: true, key, reason: `The cached report was deleted (${missing[0]}).` };
  return {
    hit: true,
    cacheable: true,
    key,
    reason: `Cached result for ${head.slice(0, 7)}: no new commits, same config and ticket.`,
    entry,
  };
}

export function storeCache({ tool, key, reports, summary = '', repo = process.cwd(), now = new Date() }) {
  if (!key) return { stored: false, reason: 'No cache key (the run was not cacheable).' };
  mkdirSync(cacheDir(repo), { recursive: true });
  const entry = {
    schemaVersion: CACHE_SCHEMA,
    tool,
    key,
    head: git(repo, ['rev-parse', 'HEAD']),
    createdAt: now.toISOString(),
    reports: reports.map((report) => resolve(report)),
    summary,
  };
  writeFileSync(entryPath(repo, tool, key), `${JSON.stringify(entry, null, 2)}\n`);
  prune(cacheDir(repo));
  return { stored: true, path: entryPath(repo, tool, key) };
}

function prune(directory) {
  const entries = readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (const { name } of entries.slice(MAX_ENTRIES)) rmSync(join(directory, name), { force: true });
}

function parseArgs(argv) {
  const flags = { report: [] };
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i].replace(/^--/, '');
    if (name === 'fresh') flags.fresh = true;
    else if (name === 'report') flags.report.push(rest[(i += 1)]);
    else flags[name] = rest[(i += 1)];
  }
  return { command, flags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));
    const repo = resolve(flags.repo ?? process.cwd());
    let result;
    if (command === 'check') {
      if (!flags.tool || !flags.config || !flags.diff) throw new Error('Usage: cache.mjs check --tool <name> --config <path> --diff <collector.json>');
      result = checkCache({ tool: flags.tool, configPath: flags.config, diffPath: flags.diff, contextPath: flags.context, repo, fresh: flags.fresh });
    } else if (command === 'store') {
      if (!flags.tool || !flags.key || flags.report.length === 0) throw new Error('Usage: cache.mjs store --tool <name> --key <key> --report <path>');
      result = storeCache({ tool: flags.tool, key: flags.key === 'null' ? null : flags.key, reports: flags.report, summary: flags.summary, repo });
    } else {
      throw new Error('Usage: cache.mjs check|store ...');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
