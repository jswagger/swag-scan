#!/usr/bin/env node
// Gathers optional repository and ticket context for the review agent.
// Usage: collect-diff.mjs ... | gather-context.mjs --config <path> [--ticket <id-or-path>] [--ticket-dir <dir>]
//        [--branch <name>] [--root <dir>]
//
// The ticket is found from --ticket (an ID such as PROJ-123, or a path to a file), else ticketContext.ticketName,
// else the ticket ID in the branch name. A bare ID is looked up in the ticket folder: --ticket-dir,
// $SWAG_SCAN_TICKET_DIR, "ticketFolder" in ~/.swag-scan/settings.json, then ticketContext.path.
// Reviewers receive only the ticket's description and acceptance criteria (see review-tools-common/ticket.mjs).
//
// Repository context searches from each changed file's folder up to the repository root.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findTicketFile, looksLikePath, parseTicket, resolveTicketFolder, ticketIdFromBranch } from '../../review-tools-common/ticket.mjs';
import { isMain, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';

const MAX_REPOSITORY_CONTEXT_FILES = 5;

function readCapped(path, maxLines) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length <= maxLines) return { content: lines.join('\n'), lineCount: lines.length, truncated: false };
  return { content: lines.slice(0, maxLines).join('\n'), lineCount: maxLines, truncated: true };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Folders from the changed file's folder to `root`, without crossing the repository boundary. */
function ancestorFolders(filePath, root) {
  const rootPath = resolve(root);
  let folder = dirname(resolve(rootPath, filePath));
  const folders = [];
  while (true) {
    const fromRoot = relative(rootPath, folder);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) break;
    folders.push(folder);
    if (folder === rootPath) break;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return folders;
}

export function gatherRepositoryContext(changedPaths, settings, root = process.cwd(), alreadyLoaded = new Set()) {
  if (!settings) return { enabled: false, files: [], notes: [] };
  const { fileNames, maxLinesPerFile, maxTotalLines } = settings;
  const rootPath = resolve(root);
  const candidatesByPath = new Map();
  const files = [];
  const notes = [];
  let totalLines = 0;

  for (const changedPath of [...changedPaths].sort()) {
    for (const [distance, folder] of ancestorFolders(changedPath, rootPath).entries()) {
      for (const name of fileNames) {
        const candidate = join(folder, name);
        const key = resolve(candidate);
        if (!isFile(candidate)) continue;
        const existing = candidatesByPath.get(key);
        if (!existing || distance < existing.distance) {
          candidatesByPath.set(key, {
            key,
            path: relative(rootPath, key).replaceAll('\\', '/'),
            forFile: changedPath,
            distance,
          });
        }
      }
    }
  }

  const candidates = [...candidatesByPath.values()].sort((left, right) =>
    left.distance - right.distance || left.path.localeCompare(right.path));
  for (const candidate of candidates) {
    if (alreadyLoaded.has(candidate.key)) {
      notes.push(`Skipped ${candidate.path}: already loaded by the host.`);
      continue;
    }
    if (files.length >= MAX_REPOSITORY_CONTEXT_FILES) {
      notes.push(`Skipped remaining repository context files: maximum of ${MAX_REPOSITORY_CONTEXT_FILES} files reached.`);
      break;
    }
    const remaining = maxTotalLines - totalLines;
    if (remaining <= 0) {
      notes.push(`Skipped remaining repository context files: total context budget of ${maxTotalLines} lines reached.`);
      break;
    }
    const { content, lineCount, truncated } = readCapped(candidate.key, Math.min(maxLinesPerFile, remaining));
    totalLines += lineCount;
    files.push({ path: candidate.path, forFile: candidate.forFile, truncated, content });
  }
  return { enabled: true, files, totalLines, notes };
}

/**
 * Resolves and reads the ticket. `options`: { branch, folderFlag, env, root, userSettings }.
 * Returns the reviewer-safe text in `content`, plus the parsed `acceptanceCriteria` and `repositories`.
 */
export function gatherTicketContext(settings, ticketOverride, options = {}) {
  const { branch, folderFlag, env = process.env, root = process.cwd(), userSettings } = options;
  const maxLines = settings?.maxLines ?? 500;
  const folder = resolveTicketFolder({ flag: folderFlag, env, userSettings, repoPath: settings?.path });

  let source;
  let ticketName = ticketOverride ?? settings?.ticketName;
  if (ticketOverride) source = '--ticket';
  else if (ticketName) source = 'config';
  else {
    ticketName = ticketIdFromBranch(branch);
    if (ticketName) source = 'branch name';
  }

  // Given a path (--ticket C:\\tickets\\PROJ-123.md), the ticket is still called PROJ-123 in the summary and report.
  const shownName = ticketName && looksLikePath(ticketName) ? basename(ticketName.replaceAll('\\', '/'), extname(ticketName)) : ticketName;
  const nothing = (notes) => ({ enabled: Boolean(settings || folder), found: false, ...(ticketName ? { ticketName: shownName } : {}), notes });
  if (!ticketName) {
    // Quiet when the feature is not set up at all; helpful when a folder is configured but no ID could be found.
    return nothing(settings || folder ? ['No ticket given and no ticket ID (like PROJ-123) found in the branch name.'] : []);
  }

  let path;
  if (ticketOverride && looksLikePath(ticketName)) {
    const candidate = isAbsolute(ticketName) ? ticketName : resolve(root, ticketName);
    if (!isFile(candidate)) return nothing([`Ticket file not found: ${candidate}`]);
    path = candidate;
  } else {
    if (/[\\/]/.test(ticketName)) return nothing(['A configured ticket name must not contain path separators.']);
    if (!folder) {
      return nothing([`Cannot look up ${ticketName}: no ticket folder is set. Use --ticket-dir, SWAG_SCAN_TICKET_DIR, "ticketFolder" in ~/.swag-scan/settings.json, or ticketContext.path.`]);
    }
    path = findTicketFile(folder.path, ticketName);
    if (!path) {
      const where = existsSync(folder.path) ? folder.path : `${folder.path} (folder not found)`;
      return nothing([`No ${ticketName}.md or ${ticketName}.txt found in ${where} (folder from ${folder.source}).`]);
    }
  }

  const parsed = parseTicket(readFileSync(path, 'utf8'));
  const lines = parsed.review.split(/\r?\n/);
  const truncated = lines.length > maxLines;
  return {
    enabled: true,
    found: true,
    ticketName: shownName,
    source,
    path,
    title: parsed.title,
    truncated,
    content: (truncated ? lines.slice(0, maxLines) : lines).join('\n'),
    acceptanceCriteria: parsed.acceptanceCriteria,
    repositories: parsed.repositories,
    omittedSections: parsed.omittedSections,
    notes: [
      ...parsed.notes,
      ...(parsed.omittedSections.length ? [`Not passed to reviewers (not requirements): ${parsed.omittedSections.join(', ')}.`] : []),
    ],
  };
}

function currentBranch(root) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    const config = loadConfig(flags.config);
    const collected = await readJsonInput(flags);
    const paths = (collected.files ?? []).filter((file) => file.status !== 'deleted').map((file) => file.path);
    const root = resolve(flags.root ?? process.cwd());
    const result = {
      repository: gatherRepositoryContext(paths, config.repositoryContext, root),
      ticket: gatherTicketContext(config.ticketContext, flags.ticket, {
        branch: flags.branch ?? currentBranch(root),
        folderFlag: flags['ticket-dir'],
        root,
      }),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
