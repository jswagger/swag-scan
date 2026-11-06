// The consolidated, decisions-first report. A script renders it from files the earlier steps saved, so it costs no
// model tokens and gives the same answer every time:
//   .swag-scan/run/summary.json            what the scan found (leads, coverage, cache) and which agents ran
//   .swag-scan/run/findings-<agent>.json   each agent's judged findings (see findings.mjs)
//   .swag-scan/run/ticket-report.json      the ticket's acceptance criteria with their status
// It never says a change is "clean": it says what was reported and what could not be checked.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeCache } from './cache.mjs';
import { emit } from './events.mjs';
import { SEVERITIES } from './findings.mjs';
import { renderReportHtml } from './report-html.mjs';

export const REPORT_SCHEMA = 1;

const STATUS_ICONS = { Todo: '🔲 Todo', Done: '✅ Done', Future: '🔮 Future' };
const SEVERITY_ORDER = Object.keys(SEVERITIES);
const tag = (severity) => `${SEVERITIES[severity].icon} ${SEVERITIES[severity].label}`;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

export function loadRun(runDir) {
  const summary = readJson(join(runDir, 'summary.json'));
  if (!summary) throw new Error(`No scan found in ${runDir}. Run "swag-scan run" first.`);
  const findings = {};
  for (const agent of summary.agents) findings[agent.id] = readJson(join(runDir, `findings-${agent.id}.json`));
  return { summary, findings, ticket: readJson(join(runDir, 'ticket-report.json')) };
}

/** What each agent did, in one of five honest states. */
function agentState(agent, report) {
  if (agent.status === 'empty') return { state: 'no-changes', text: 'No changes to check.' };
  if (report) {
    const { counts } = report;
    const total = report.findings.length;
    return { state: 'reviewed', text: `Reviewed: ${plural(total, 'finding')}${total ? ` (${counts.critical} critical, ${counts.design} design, ${counts.minor} minor)` : ''} from ${plural(agent.leads, 'lead')}.` };
  }
  if (agent.cache?.hit) return { state: 'cached', text: `Already reviewed at this commit. Earlier report: ${agent.cache.reports?.[0] ?? 'see the cache'}.` };
  if (agent.leads === 0) return { state: 'no-leads', text: 'No leads, so no model review. This is not a check that the code is sound.' };
  return { state: 'missing', text: `⚠ Did not report: ${plural(agent.leads, 'lead')} found, but no findings were saved. Treat this agent's area as not reviewed.` };
}

export function buildReport({ summary, findings, ticket }, { now = new Date() } = {}) {
  const agents = summary.agents.map((agent) => ({
    id: agent.id, name: agent.name, tool: agent.tool, leads: agent.leads ?? 0,
    ...agentState(agent, findings[agent.id]),
  }));
  const order = summary.agents.map((agent) => agent.id);
  const all = summary.agents.flatMap((agent) => (findings[agent.id]?.findings ?? []).map((finding) => ({ ...finding, agent: agent.id, agentName: agent.name })));
  const byOrder = (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || order.indexOf(a.agent) - order.indexOf(b.agent) || a.id.localeCompare(b.id, undefined, { numeric: true });
  const decisions = all.filter((f) => f.disposition === 'needs-decision').sort(byOrder);
  const fixed = all.filter((f) => f.disposition === 'auto-fixed').sort(byOrder);
  const wouldFix = all.filter((f) => f.disposition === 'would-auto-fix').sort(byOrder);

  const criteria = (ticket?.criteria ?? []).map((row) => ({
    ...row,
    findingIds: all.filter((f) => f.criteria.includes(String(row.id))).sort(byOrder).map((f) => f.id),
  }));

  // One entry per distinct coverage line, naming the agents it applies to.
  const coverageByLine = new Map();
  for (const agent of summary.agents) {
    if (!agent.coverage?.line) continue;
    const line = agent.coverage.line.replace(/^Coverage: /, '');
    coverageByLine.set(line, [...(coverageByLine.get(line) ?? []), agent.name]);
  }
  const coverageLines = [...coverageByLine].map(([line, names]) => ({ agents: names, line }));
  const unchecked = new Map();
  for (const agent of summary.agents) for (const file of agent.coverage?.unchecked ?? []) unchecked.set(file.path, file.language);
  const incomplete = agents.filter((agent) => agent.state === 'missing');

  const counts = {
    needsDecision: decisions.length,
    critical: decisions.filter((f) => f.severity === 'critical').length,
    design: decisions.filter((f) => f.severity === 'design').length,
    minor: decisions.filter((f) => f.severity === 'minor').length,
    autoFixed: fixed.length,
    wouldAutoFix: wouldFix.length,
    uncheckedFiles: unchecked.size,
    agentsNotReported: incomplete.length,
  };

  let nextStep;
  const firstCritical = decisions.find((f) => f.severity === 'critical');
  if (firstCritical) nextStep = `Start with ${firstCritical.id}: ${firstCritical.title}.`;
  else if (decisions.length) nextStep = `Work through the ${plural(decisions.length, 'item')} that need your decision, top to bottom.`;
  else if (incomplete.length || unchecked.size) nextStep = `No findings were reported, but ${incomplete.length ? `${incomplete.map((a) => a.name).join(' and ')} did not report` : `${plural(unchecked.size, 'file')} could not be checked`}. Look at Coverage before you rely on that.`;
  else nextStep = 'No findings from the agents that ran. See Coverage for what they could and could not read.';

  return {
    schemaVersion: REPORT_SCHEMA,
    generatedAt: now.toISOString(),
    branch: summary.branch, head: summary.head, base: summary.base,
    modelTokensInPass1: summary.modelTokens ?? 0,
    ticket: ticket ? { id: ticket.id, source: ticket.source, title: ticket.title } : null,
    agents, counts, decisions, fixed, wouldFix, criteria,
    coverage: { lines: coverageLines, unchecked: [...unchecked].map(([path, language]) => ({ path, language })) },
    nextStep,
  };
}

function location(finding) {
  const first = finding.locations[0];
  if (!first) return '';
  const more = finding.locations.length > 1 ? ` (+${finding.locations.length - 1} more)` : '';
  return `\`${first.file}${first.line ? `:${first.line}` : ''}\`${more}`;
}

function itemCell(finding) {
  return cell([`**${finding.title}**`, location(finding), finding.rule ? `\`${finding.rule}\`` : ''].filter(Boolean).join(' · '));
}

function table(findings) {
  return ['| # | Severity | Item |', '| --- | --- | --- |', ...findings.map((f) => `| ${f.id} | ${tag(f.severity)} | ${itemCell(f)} |`)].join('\n');
}

function fenced(text) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
}

function detail(finding) {
  const lines = [`### ${finding.id} ${SEVERITIES[finding.severity].icon} ${finding.title}`, ''];
  if (finding.voiceLine) lines.push(`> **${finding.agentName}:** ${finding.voiceLine}`, '');
  const facts = [location(finding), finding.rule ? `\`${finding.rule}\`` : '', finding.confidence ? `confidence ${finding.confidence}` : '', finding.criteria.length ? `criteria ${finding.criteria.join(', ')}` : ''].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '), '');
  if (finding.flaggedText) lines.push(fenced(finding.flaggedText), '');
  if (finding.evidence) lines.push(`**Evidence:** ${finding.evidence}`, '');
  if (finding.verify) lines.push(`**Verify:** ${finding.verify}`, '');
  if (finding.recommendation) lines.push(`**Recommendation:** ${finding.recommendation}`, '');
  if (finding.fixNote) lines.push(`**Changed:** ${finding.fixNote}`, '');
  return lines.join('\n').trimEnd();
}

export function renderMarkdown(report) {
  const out = [];
  const base = report.base ? `${report.base.ref}${report.base.autoDetected ? ' (auto-detected)' : ''}` : 'no base found';
  out.push(`# Swag Scan report: ${report.branch ?? 'detached HEAD'} vs ${base}`, '');
  out.push([report.head ? `commit \`${report.head.slice(0, 7)}\`` : '', report.ticket ? `ticket ${report.ticket.id}${report.ticket.title && !report.ticket.title.startsWith(report.ticket.id) ? ` (${report.ticket.title})` : report.ticket.title ? ` (${report.ticket.title.slice(report.ticket.id.length).replace(/^[:\s-]+/, '')})` : ''}` : 'no ticket', `pass 1 used ${report.modelTokensInPass1} model tokens`].filter(Boolean).join(' · '), '');

  const { counts } = report;
  out.push(counts.needsDecision
    ? `**${plural(counts.needsDecision, 'item')} ${counts.needsDecision === 1 ? 'needs' : 'need'} your decision** (${counts.critical} critical, ${counts.design} design, ${counts.minor} minor).${counts.autoFixed ? ` ${counts.autoFixed} fixed for you.` : ''}${counts.wouldAutoFix ? ` ${counts.wouldAutoFix} would have been fixed with auto-fix on.` : ''}`
    : `**Nothing needs your decision.**${counts.autoFixed ? ` ${counts.autoFixed} fixed for you.` : ''} This is not a statement that the code is clean: see Coverage.`, '');
  out.push(`**Next:** ${report.nextStep}`, '');

  out.push('## Needs your decision', '');
  out.push(report.decisions.length ? table(report.decisions) : 'None reported.', '');

  if (report.fixed.length) out.push('## Done for you', '', table(report.fixed), '');
  if (report.wouldFix.length) out.push('## Would have been fixed (auto-fix was off)', '', 'Low-risk items with a safe fix. Nothing was changed.', '', table(report.wouldFix), '');

  if (report.criteria.length) {
    const showRepo = report.criteria.some((row) => row.repository);
    out.push('## Acceptance criteria', '');
    out.push(`| # | Title | ${showRepo ? 'Repository | ' : ''}Status | Findings |`, `| --- | --- | ${showRepo ? '--- | ' : ''}--- | --- |`);
    const severityOf = new Map([...report.decisions, ...report.fixed, ...report.wouldFix].map((f) => [f.id, f.severity]));
    for (const row of report.criteria) {
      const linked = row.otherRepo ? 'Other repo, not scanned'
        : row.findingIds.length ? row.findingIds.map((id) => `${id} ${SEVERITIES[severityOf.get(id)].icon}`).join(', ') : 'None linked';
      out.push(`| ${row.id} | ${cell(row.title || row.description || '')} | ${showRepo ? `${cell(row.repository ?? '(all)')} | ` : ''}${STATUS_ICONS[row.status] ?? STATUS_ICONS.Todo} | ${linked} |`);
    }
    out.push('', `_Status comes from the ticket.${report.criteria.some((row) => !row.otherRepo && !row.findingIds.length) ? ' "None linked" means no agent tied a finding to that row, not that the row is verified.' : ''}_`, '');
  }

  out.push('## Who looked at what', '', '| Agent | Result |', '| --- | --- |', ...report.agents.map((agent) => `| ${agent.name} | ${cell(agent.text)} |`), '');

  out.push('## Coverage', '');
  const sameForAll = report.coverage.lines.length === 1;
  out.push(...(report.coverage.lines.length
    ? report.coverage.lines.map(({ agents, line }) => `- ${sameForAll ? '' : `${agents.join(', ')}: `}${line}`)
    : ['- No coverage information.']));
  if (report.coverage.unchecked.length) {
    out.push('', '⚪ **Unchecked** (no verdict either way):', ...report.coverage.unchecked.map((file) => `- \`${file.path}\` (${file.language})`));
  }
  out.push('');

  const detailed = [...report.decisions, ...report.fixed, ...report.wouldFix];
  if (detailed.length) out.push('## Details', '', detailed.map(detail).join('\n\n'), '');
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Writes report.md, report.html and report.json to the run folder, keeps a copy in .swag-scan/reports/<commit>/ that survives the next
 * scan, and records each reviewed agent in the result cache so an identical re-run is recognised.
 */
export function writeReport({ runDir, repo, now = new Date() }) {
  const run = loadRun(runDir);
  const report = buildReport(run, { now });
  const markdown = renderMarkdown(report);

  const keepDir = join(repo, '.swag-scan', 'reports', (run.summary.head ?? 'unknown').slice(0, 7));
  mkdirSync(keepDir, { recursive: true });
  const files = { markdown: join(runDir, 'report.md'), html: join(runDir, 'report.html'), json: join(runDir, 'report.json') };
  writeFileSync(files.markdown, markdown);
  writeFileSync(files.html, renderReportHtml(markdown)); // the page the dashboard opens: tables and bold text, not raw Markdown
  writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`);

  const kept = { markdown: join(keepDir, 'report.md'), html: join(keepDir, 'report.html'), json: join(keepDir, 'report.json') };
  copyFileSync(files.markdown, kept.markdown);
  copyFileSync(files.html, kept.html);
  copyFileSync(files.json, kept.json);
  const cached = [];
  for (const agent of run.summary.agents) {
    const findingsPath = join(runDir, `findings-${agent.id}.json`);
    if (!existsSync(findingsPath)) continue;
    const keptFindings = join(keepDir, `findings-${agent.id}.json`);
    copyFileSync(findingsPath, keptFindings);
    if (agent.cache?.cacheable && agent.cache.key) {
      const state = report.agents.find((entry) => entry.id === agent.id);
      storeCache({ tool: agent.tool, key: agent.cache.key, reports: [kept.markdown, keptFindings], summary: `${agent.name}: ${state.text}`, repo, now });
      cached.push(agent.id);
    }
  }
  emit(runDir, { kind: 'run-done', phase: 'report', count: report.counts.needsDecision });
  return { report, markdown, files, kept, cached };
}
