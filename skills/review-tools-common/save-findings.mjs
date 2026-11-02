#!/usr/bin/env node
// Validates an agent's findings and saves them in the shared format to <run-dir>/findings-<agent>.json.
// Usage: save-findings.mjs --agent <analyst|inspector|security-guard> [--input <file>] [--format native|bug-hunter]
//                          [--run-dir <dir>]      (input defaults to stdin; run-dir defaults to .swag-scan/run)
//
// Reads <run-dir>/summary.json (written by swag-scan.mjs) for the agent's tool, coverage, base and the ticket's
// criterion ids, so the agent only supplies its findings. Prints one JSON line with the path and counts.
// On invalid input it prints every problem and exits 1 so the agent can fix and retry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFindingsReport, fromBugHunter } from './findings.mjs';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}.`);
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}.`);
    flags[argv[i].slice(2)] = argv[(i += 1)];
  }
  return flags;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

export function saveFindings({ agent, text, format = 'native', runDir, now = new Date() }) {
  if (!['native', 'bug-hunter'].includes(format)) throw new Error('--format must be native or bug-hunter.');
  const summaryPath = join(runDir, 'summary.json');
  if (!existsSync(summaryPath)) throw new Error(`No summary found at ${summaryPath}. Run "swag-scan run" first.`);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const entry = summary.agents.find((candidate) => candidate.id === agent);
  if (!entry) throw new Error(`Agent "${agent}" was not part of this scan. It ran: ${summary.agents.map((a) => a.id).join(', ')}.`);

  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(`The findings are not valid JSON (${error.message}).`);
  }
  if (format === 'bug-hunter') input = fromBugHunter(input);

  const report = buildFindingsReport(input, {
    agent,
    tool: entry.tool,
    coverage: entry.coverage ? { checked: entry.coverage.checked, unchecked: entry.coverage.unchecked, line: entry.coverage.line } : null,
    base: summary.base?.ref,
    head: summary.head,
    criteriaIds: summary.ticket?.criteriaIds,
    now,
  });
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `findings-${agent}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return { path, counts: report.counts, findings: report.findings.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (!flags.agent) throw new Error('Usage: save-findings.mjs --agent <analyst|inspector|security-guard> [--input <file>] [--format native|bug-hunter]');
    const text = flags.input ? readFileSync(resolve(flags.input), 'utf8') : readStdin();
    const result = saveFindings({ agent: flags.agent, text, format: flags.format, runDir: resolve(flags['run-dir'] ?? '.swag-scan/run') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
