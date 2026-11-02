#!/usr/bin/env node
// Generates the Claude Code agent files (agents/<id>.md) from the platform-neutral sources:
//   skills/review-tools-common/personas/<id>.md   who the agent is and how it speaks
//   skills/review-tools-common/personas/voice-rules.md   the shared rules for the voice
//   skills/<tool>/SKILL.md   the tool's own review steps (read by the agent at run time)
// Only the table below is Claude Code specific. Other platforms can be generated from the same sources later.
//
// Usage: node scripts/build-agents.mjs [--check]
//   --check  write nothing; exit 1 if any agents/*.md file is out of date.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTS } from '../skills/review-tools-common/swag-scan.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PERSONAS = join(ROOT, 'skills', 'review-tools-common', 'personas');

/**
 * Claude Code settings per agent. Plugin agents ignore permissionMode, hooks and mcpServers, so the only hard limits
 * available here are `tools` and `disallowedTools` (by tool name). Bash cannot be narrowed to commands in an agent file;
 * hooks/hooks.json blocks risky commands for the whole session.
 */
const SPECS = {
  analyst: {
    role: 'quality assurance: does the change work, and does it do what the ticket asked',
    description: 'Swag Scan Analyst. Judges whether a change works and meets its ticket by reviewing Bug Hunter leads for regressions. Use after the swag-scan command has produced leads.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    color: 'blue',
    canEdit: false,
  },
  inspector: {
    role: 'code quality: is the code clean, tidy and focused',
    description: 'Swag Scan Inspector. Judges code quality by reviewing Code Sweeper leads: long or nested code, duplication, dead code, weak tests. Use after the swag-scan command has produced leads.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit'],
    disallowedTools: ['Write'],
    color: 'orange',
    canEdit: true,
  },
  'security-guard': {
    role: 'security: is anything in the change exploitable or over-permissive',
    description: 'Swag Scan Security Guard. Judges security by reviewing Security Auditor leads, including removed controls. Report-only. Use after the swag-scan command has produced leads.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    color: 'purple',
    canEdit: false,
  },
};

const MODEL = 'sonnet';
const MAX_TURNS = 50;
const TOOL_TITLES = { 'bug-hunter': 'Bug Hunter', 'code-sweeper': 'Code Sweeper', 'security-auditor': 'Security Auditor' };

/** What the orchestrator saved for each tool in .swag-scan/run/ (see skills/review-tools-common/swag-scan.mjs). */
const RUN_FILES = {
  'bug-hunter': 'diff, context (the ticket), scan, callers and packets. Packets are the ranked pieces of the change to review',
  'code-sweeper': 'diff and scan (the scanner output: candidates, changed tests and coverage)',
  'security-auditor': 'diff and scan (the scanner output: candidates and coverage)',
};

const SAVE = '${CLAUDE_PLUGIN_ROOT}/skills/review-tools-common/save-findings.mjs';
const NATIVE_FORMAT = `Write JSON with a Bash heredoc to \`.swag-scan/run/findings-input.json\`: \`{ "findings": [ ... ], "clean": [ { "area", "note" } ], "dismissed": [ { "rule", "file", "line", "reason" } ] }\`. Each finding has: \`severity\` (\`critical\` 🔴, \`design\` 🟡 feature gap or design issue, \`minor\` ✅ cleanup), \`title\`, \`file\` and \`line\` (the line in the new version of the file), \`flaggedText\` (the exact code text on that line, so the finding can be found again after fixes), \`rule\`, \`evidence\` (required for critical: a concrete failing input or state), \`verify\` (required for design: the one thing to check), \`recommendation\` (required for minor), \`disposition\` and \`criteria\`. Then run \`node ${SAVE} --agent AGENT --input .swag-scan/run/findings-input.json\`.`;

/** How each agent hands in its findings, and how its tool's own labels map onto the three severities. */
const SAVE_STEPS = {
  analyst: `Save the Bug Hunter findings file you already wrote (\`.swag-scan/run/findings.json\`) with \`node ${SAVE} --agent analyst --format bug-hunter --input .swag-scan/run/findings.json\`. Probable bugs become critical and suspicious items become design issues. You may add \`criteria\` (the ticket's acceptance-criterion ids, from \`.swag-scan/run/summary.json\` under \`ticket.criteriaIds\`) and \`confidence\` (high, medium or low) to any finding that relates to a criterion. Every disposition is \`needs-decision\` because you are report-only.`,
  inspector: `${NATIVE_FORMAT.replace('AGENT', 'inspector')} Map Code Sweeper's labels: Unclean and Dusty are normally \`minor\`; use \`design\` only for a real design problem (for example business logic repeated in several places). \`disposition\`: \`auto-fixed\` if you edited the file (add \`fixNote\` saying what changed), \`would-auto-fix\` if a safe fix exists but auto-fix was off for this run, and \`needs-decision\` for anything never auto-fixed (such as Dusty items).`,
  'security-guard': `${NATIVE_FORMAT.replace('AGENT', 'security-guard')} Map Security Auditor's labels: High Risk is \`critical\`, Suspicious is \`design\`, and low-impact hardening is \`minor\`. Put the evidence and the impact together in \`evidence\`, and the remediation in \`recommendation\`. Every disposition is \`needs-decision\` because you are report-only.`,
};

const read = (path) => readFileSync(path, 'utf8').trim();

function job(agent, spec) {
  const title = TOOL_TITLES[agent.tool];
  const editing = spec.canEdit
    ? `You may edit files only if ${title}'s auto-fix setting is on and the fix is clear and low-risk. In every other case report and do not edit.`
    : 'You are report-only. You never edit or create source files.';
  return `## Your job

The scripts have already run. The \`swag-scan\` command scanned this repository with no model and saved the results in \`.swag-scan/run/\`. You judge the leads it found. A lead is a script match, not a verified finding.

1. Read \`.swag-scan/run/summary.json\`. Find your entry (\`id: "${agent.id}"\`): its \`leads\`, \`coverage\`, \`sizeGate\`, \`cache\` and file paths. If \`cache.hit\` is true, say that this commit was already reviewed, point to \`cache.reports\`, and stop. If \`status\` is \`empty\`, say there is nothing to check and stop.
2. Read \`\${CLAUDE_PLUGIN_ROOT}/skills/${agent.tool}/SKILL.md\`. Follow its review steps (triage, deep review, classification and report format). Skip its script block: those scripts already ran, and \`TOOLS\` is \`\${CLAUDE_PLUGIN_ROOT}/skills\`. The results are in \`.swag-scan/run/${agent.tool}-<name>.json\`: ${RUN_FILES[agent.tool]}. Do not run the collector or the scanners again.${agent.id === 'analyst' ? `
   The Bug Hunter report script takes your findings as JSON. You have no Write tool, so save them with a Bash heredoc to \`.swag-scan/run/findings.json\`, then run \`node \${CLAUDE_PLUGIN_ROOT}/skills/bug-hunter/scripts/write-report.mjs --config \${CLAUDE_PLUGIN_ROOT}/skills/bug-hunter/config.json --input .swag-scan/run/findings.json --scan .swag-scan/run/bug-hunter-scan.json --packets .swag-scan/run/bug-hunter-packets.json\`.` : ''}
3. Start your report with the coverage line from your entry, and list every file under Unchecked. Never put an unchecked file under Clean, and never call the whole change clean when files are unchecked.
4. If the size gate hit (\`sizeGate.decision\` is \`review-riskiest\`), say what was skipped. You never ask the user questions. If you cannot decide, report the item as suspicious and say what to verify.
5. ${editing}
6. Save your findings in the shared format, so one report can combine all three agents. ${SAVE_STEPS[agent.id]} It checks your findings and prints every problem if something is missing; fix those and run it again. Do this even when you found nothing (an empty \`findings\` list).
7. Return your report and one line naming where the detailed files are. Do not paste raw JSON.

## Limits

- Stay inside the repository. Never push, delete branches or files, change git history or configuration, or install anything.
- Run only the Swag Scan scripts and plain read-only commands (git status, git diff, git log, file listing). If you need anything else, say what and why instead of running it.
- ${agent.id === 'analyst' ? 'Write only under `.swag-scan/` (your findings file and the report script\'s output).' : spec.canEdit ? 'Write only under `.swag-scan/`, plus the repository files you are allowed to fix (see above).' : 'Write nothing. The scripts save their own results under `.swag-scan/`.'}
- You are one of three agents. Stay in your lane: leave the other agents' areas to them.`;
}

export function buildAgent(agent) {
  const spec = SPECS[agent.id];
  const persona = read(join(PERSONAS, `${agent.id}.md`));
  const voice = read(join(PERSONAS, 'voice-rules.md'));
  const frontmatter = [
    '---',
    `name: ${agent.id}`,
    `description: ${spec.description}`,
    `tools: ${spec.tools.join(', ')}`,
    `disallowedTools: ${spec.disallowedTools.join(', ')}`,
    `model: ${MODEL}`,
    `maxTurns: ${MAX_TURNS}`,
    `color: ${spec.color}`,
    '---',
  ].join('\n');
  return `${frontmatter}

<!-- Generated by scripts/build-agents.mjs from skills/review-tools-common/personas/. Edit those sources, not this file. -->

${persona}

Your area: ${spec.role}.

${voice}

${job(agent, spec)}
`;
}

export function buildAgents() {
  return AGENTS.map((agent) => ({ path: join('agents', `${agent.id}.md`), content: buildAgent(agent) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const { path, content } of buildAgents()) {
    const full = join(ROOT, path);
    const current = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    if (current === content) continue;
    stale.push(path);
    if (!check) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  if (check && stale.length) {
    process.stderr.write(`Out of date: ${stale.join(', ')}. Run: node scripts/build-agents.mjs\n`);
    process.exit(1);
  }
  process.stdout.write(stale.length ? `${check ? 'Out of date' : 'Wrote'}: ${stale.join(', ')}\n` : 'Agents are up to date.\n');
}
