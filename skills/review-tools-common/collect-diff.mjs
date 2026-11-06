#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { renderCoverageLine, summarizeCoverage } from './coverage.mjs';
import { createFileFilters } from './file-filters.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--config' || !args[1] || args.length > 3) {
  process.stderr.write('Usage: collect-diff.mjs --config <config-path> [base-ref]\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
const { isExcluded: isConfigExcluded } = createFileFilters(config.scan);
// The tools' own output (run results, caches, reports) is never part of the change under review.
const isToolOutput = (path) => /^\.(?:swag-scan|bug-hunter)\//.test(path.replaceAll('\\', '/'));
const isExcluded = (path) => isToolOutput(path) || isConfigExcluded(path);
// Untracked files are usually new work, but a folder of test data or snapshots is not, so it is skipped for them only.
const isFixtureFolder = (path) => /(?:^|\/)(?:testdata|fixtures|__snapshots__)\//i.test(path.replaceAll('\\', '/'));
// Warn when the untracked files dwarf the real change: usually a local data folder the team normally ignores.
const UNTRACKED_WARN_MIN = 20;
const UNTRACKED_WARN_RATIO = 5;
const requestedBaseRef = args[2] ?? config.diff.baseRef ?? 'auto';
// 'auto' (and the older 'origin/HEAD' default) means: pick the most likely base branch.
const autoBase = requestedBaseRef === 'auto' || requestedBaseRef === 'origin/HEAD';
let baseRef = requestedBaseRef;
let usedFallbackBase = false;
const BASE_CANDIDATES = [
  'origin/HEAD', 'origin/develop', 'develop', 'origin/test', 'test',
  'origin/main', 'main', 'origin/master', 'master',
];
const maxUntrackedBytes = config.diff.untrackedMaxBytes ?? 100000;

function runGit(gitArgs, options = {}) {
  return execFileSync('git', gitArgs, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseDiff(diffText) {
  const files = [];
  let currentFile;
  let oldFilePath;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of diffText.split('\n')) {
    if (currentFile && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith('-') && oldRemaining > 0) {
        currentFile.changes.push({ side: 'removed', line: oldLine, text: line.slice(1) });
        oldLine += 1;
        oldRemaining -= 1;
        continue;
      }
      if (line.startsWith('+') && newRemaining > 0) {
        currentFile.changes.push({ side: 'added', line: newLine, text: line.slice(1) });
        newLine += 1;
        newRemaining -= 1;
        continue;
      }
      if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        oldLine += 1;
        newLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (line.startsWith('\\')) continue;
    }

    if (line.startsWith('--- ')) {
      oldFilePath = parseDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = parseDiffPath(line.slice(4));
      if (path) {
        currentFile = { path, status: oldFilePath ? 'modified' : 'added', changes: [] };
        files.push(currentFile);
      } else if (oldFilePath) {
        currentFile = { path: oldFilePath, status: 'deleted', changes: [] };
        files.push(currentFile);
      } else {
        currentFile = undefined;
      }
      oldFilePath = undefined;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldRemaining = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? 1);
      continue;
    }
  }

  return files;
}

function refExists(ref) {
  try {
    runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function commitsAhead(ref) {
  try {
    const mergeBase = runGit(['merge-base', ref, 'HEAD']).trim();
    return Number(runGit(['rev-list', '--count', `${mergeBase}..HEAD`]).trim());
  } catch {
    return undefined;
  }
}

// Candidates that exist and share history with HEAD, with their commits-ahead count, in priority order.
function baseCandidates() {
  const seen = new Set();
  const found = [];
  for (const ref of BASE_CANDIDATES) {
    if (!refExists(ref)) continue;
    const commit = runGit(['rev-parse', `${ref}^{commit}`]).trim();
    if (seen.has(commit)) continue; // origin/main and main often point at the same commit
    seen.add(commit);
    const ahead = commitsAhead(ref);
    if (ahead !== undefined) found.push({ ref, ahead });
  }
  return found;
}

// Prefer the closest base that HEAD is actually ahead of; otherwise the first candidate (HEAD is on the base itself).
function pickBase(candidates) {
  const ahead = candidates.filter((candidate) => candidate.ahead > 0);
  if (ahead.length === 0) return candidates[0]?.ref;
  return ahead.reduce((best, candidate) => (candidate.ahead < best.ahead ? candidate : best)).ref;
}

let otherBaseCandidates = [];
if (autoBase) {
  const candidates = baseCandidates();
  const picked = pickBase(candidates);
  if (picked) {
    baseRef = picked;
    otherBaseCandidates = candidates.filter((candidate) => candidate.ref !== picked);
  } else {
    baseRef = 'HEAD';
    usedFallbackBase = true;
  }
}

function parseDiffPath(path) {
  path = path.trimEnd();
  if (path === '/dev/null') return undefined;
  return path.replace(/^[ab]\//, '');
}

function jsTsStem(path) {
  const name = basename(path);
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(name)) return undefined;
  const stem = name.replace(/\.d\.ts$/i, '').replace(/\.(?:[cm]?[jt]sx?)$/i, '');
  return `${path.slice(0, path.length - name.length)}${stem}`.toLowerCase();
}

function collectUntracked(trackedJsTsStems) {
  const paths = runGit(['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const files = [];
  const skipped = [];
  let excludedCount = 0;

  for (const path of paths) {
    if (isExcluded(path) || isFixtureFolder(path)) {
      excludedCount += 1;
      continue;
    }
    if (trackedJsTsStems.has(jsTsStem(path))) {
      skipped.push({ path, reason: 'tracked JavaScript/TypeScript sibling exists' });
      continue;
    }
    try {
      const content = readFileSync(path);
      if (content.length > maxUntrackedBytes || content.includes(0)) {
        skipped.push({ path, reason: content.includes(0) ? 'binary file' : 'file exceeds size limit' });
        continue;
      }
      const text = content.toString('utf8');
      files.push({
        path,
        status: 'untracked',
        changes: text.split(/\r?\n/).map((line, index) => ({ side: 'added', line: index + 1, text: line })),
      });
    } catch (error) {
      skipped.push({ path, reason: `could not read file (${error.code ?? 'unknown error'})` });
    }
  }

  return { files, skipped, excludedCount, total: paths.length };
}

// A base that makes the change look many times bigger than it does against another branch is usually the wrong target.
const BASE_WARN_MIN_EXTRA = 20;
const BASE_WARN_RATIO = 3;

function fileCountAgainst(ref) {
  const base = runGit(['merge-base', ref, 'HEAD']).trim();
  return runGit(['diff', '--name-only', '-z', base, '--']).split('\0').filter((path) => path && !isExcluded(path)).length;
}

function baseWarnings({ comparisonBase, fileCount }) {
  if (baseRef === 'HEAD' || fileCount < BASE_WARN_MIN_EXTRA) return [];
  const warnings = [];
  for (const { ref, ahead } of baseCandidates()) {
    if (ref === baseRef || !ahead) continue;
    let other;
    try {
      if (runGit(['merge-base', ref, 'HEAD']).trim() === comparisonBase) continue;
      other = fileCountAgainst(ref);
    } catch {
      continue;
    }
    if (other < 1 || fileCount - other < BASE_WARN_MIN_EXTRA || other * BASE_WARN_RATIO > fileCount) continue;
    warnings.push(`Against ${baseRef} this change touches ${fileCount} files, but against ${ref} only ${other}. `
      + `If the branch will merge into ${ref}, run again with that base.`);
  }
  return warnings.slice(0, 1);
}

function untrackedWarnings({ branchFiles, untrackedScanned }) {
  if (untrackedScanned <= UNTRACKED_WARN_MIN && untrackedScanned <= branchFiles * UNTRACKED_WARN_RATIO) return [];
  return [`${untrackedScanned} of the scanned files are untracked, but the branch diff has only ${branchFiles}. `
    + 'If those are local files that are not part of this change, add their folder to .git/info/exclude and run again.'];
}

try {
  const trackedJsTsStems = new Set(runGit(['ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .map(jsTsStem)
    .filter(Boolean));
  const comparisonBase = baseRef === 'HEAD'
    ? 'HEAD'
    : runGit(['merge-base', baseRef, 'HEAD']).trim();
  const [baseCommitHash, baseCommitDate] = runGit([
    'show',
    '-s',
    '--format=%H %cI',
    comparisonBase,
  ]).trim().split(' ');
  const diffText = runGit(['diff', '--no-ext-diff', '--unified=0', comparisonBase, '--']);
  const diffFiles = parseDiff(diffText);
  const files = diffFiles.filter((file) => !isExcluded(file.path));
  const untracked = collectUntracked(trackedJsTsStems);
  const changedPaths = new Set(files.map((file) => file.path));
  const excludedCount = diffFiles.length - files.length + untracked.excludedCount;
  const scannedFiles = [...files, ...untracked.files.filter((file) => !changedPaths.has(file.path))];
  const changedCount = diffFiles.length + untracked.total;
  const untrackedScanned = scannedFiles.length - files.length;
  const warnings = [...baseWarnings({ comparisonBase, fileCount: files.length }), ...untrackedWarnings({ branchFiles: files.length, untrackedScanned })];
  const diffBytes = scannedFiles.reduce(
    (sum, file) => sum + file.changes.reduce((fileSum, change) => fileSum + Buffer.byteLength(change.text, 'utf8') + 1, 0),
    0,
  );
  const coverage = summarizeCoverage(scannedFiles);
  const gateBytes = config.diff.maxDiffBytes;
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

  // Empty diff: say so in one sentence and suggest a ref that does have changes, never a silent empty result.
  const emptyDiff = scannedFiles.length === 0;
  let suggestion = null;
  if (emptyDiff) {
    const better = (autoBase ? otherBaseCandidates : baseCandidates().filter((candidate) => candidate.ref !== baseRef))
      .find((candidate) => candidate.ahead > 0);
    suggestion = better
      ? `Try a different base, for example \`${better.ref}\` (HEAD is ${better.ahead} ${better.ahead === 1 ? 'commit' : 'commits'} ahead of it).`
      : 'Commit or stage your changes, or pass a base branch to compare against (for example `main`).';
  }

  process.stderr.write(
    `Diff collector: resolved base ${baseRef} to ${baseCommitHash} (${baseCommitDate})${autoBase ? ', auto-detected' : ''}; `
      + `${excludedCount} excluded ${excludedCount === 1 ? 'file' : 'files'}.\n`
      + `Diff collector: ${changedCount} changed, ${excludedCount} excluded, ${scannedFiles.length} scanned; `
      + `diff ${kb(diffBytes)}${gateBytes ? ` of ${kb(gateBytes)} gate` : ''}.\n`
      + (coverage.unchecked.length ? `Diff collector: ${renderCoverageLine(coverage).replace(/^Coverage: /, '')}\n` : '')
      + warnings.map((warning) => `Diff collector: warning: ${warning}\n`).join('')
      + (emptyDiff ? `Diff collector: no changes found against ${baseRef}. ${suggestion}\n` : ''),
  );

  process.stdout.write(`${JSON.stringify({
    baseRef,
    requestedBaseRef,
    autoDetected: autoBase && !usedFallbackBase,
    comparisonBase,
    baseCommitHash,
    baseCommitDate,
    excludedCount,
    changedCount,
    diffBytes,
    branchDiffCount: files.length,
    untrackedCount: untrackedScanned,
    warnings,
    emptyDiff,
    suggestion,
    coverage: { ...coverage, line: renderCoverageLine(coverage) },
    files: scannedFiles,
    skipped: untracked.skipped,
    note: usedFallbackBase
      ? 'No base branch (origin/HEAD, develop, test, main, master) was found, so diff collection fell back to the working-tree comparison against HEAD and untracked non-ignored text files.'
      : baseRef === 'HEAD'
      ? 'Diff collection is limited to working-tree changes relative to HEAD and untracked non-ignored text files.'
      : 'Diff collection starts at the merge base of the target ref and HEAD, includes working-tree changes, and includes untracked non-ignored text files.',
  }, null, 2)}\n`);
} catch (error) {
  const message = error.stderr?.toString('utf8').trim() || error.message;
  process.stderr.write(`Failed to collect diff from ${basename(baseRef)}: ${message}\n`);
  process.exitCode = 1;
}