// The shared findings format. Every agent saves its judged findings in this one shape, so a single report can
// combine them. Facts are plain fields; the agent's voice lives only in the optional `voiceLine`.
//
// Agent input (what the agent writes):
//   { findings: [{ severity, title, file?, line?, locations?, flaggedText?, rule?, evidence?, verify?, recommendation?,
//                  disposition?, criteria?, confidence?, voiceLine?, fixNote? }],
//     clean: [{ area, note? } | "area"], dismissed: [{ rule?, file?, line?, reason }] }
// Saved output: see buildFindingsReport(). Documented for people in the README ("Findings format").

export const FINDINGS_SCHEMA_VERSION = 1;

/** Severity is tool-independent. Each tool maps its own labels onto these three. */
export const SEVERITIES = {
  critical: { icon: '🔴', label: 'Critical' },
  design: { icon: '🟡', label: 'Feature gap / design issue' },
  minor: { icon: '✅', label: 'Cleanup / minor' },
};

/** What happened to the finding. `would-auto-fix` means a safe fix exists but auto-fix was off for this run. */
export const DISPOSITIONS = ['needs-decision', 'auto-fixed', 'would-auto-fix'];

export const CONFIDENCES = ['high', 'medium', 'low'];

const AGENT_PREFIX = { analyst: 'AN', inspector: 'IN', 'security-guard': 'SG' };
/** Report-only agents can never have fixed anything. */
const MAY_FIX = { analyst: false, inspector: true, 'security-guard': false };
const SEVERITY_ORDER = Object.keys(SEVERITIES);

const hasText = (value) => typeof value === 'string' && value.trim() !== '';
const list = (value) => (Array.isArray(value) ? value : []);

function locationsOf(finding) {
  if (Array.isArray(finding.locations) && finding.locations.length) return finding.locations;
  return finding.file ? [{ file: finding.file, line: finding.line ?? null }] : [];
}

/**
 * Checks agent input against the contract and returns a list of problems (empty when valid).
 * A critical finding needs evidence (a concrete failure scenario or proof) and a recommendation or something to verify, a
 * design issue needs the one thing to verify, and a cleanup needs a recommendation. This is the same bar the tools already set.
 */
export function validateAgentFindings(input, { agent, criteriaIds } = {}) {
  const problems = [];
  if (!AGENT_PREFIX[agent]) problems.push(`Unknown agent "${agent}".`);
  if (!input || !Array.isArray(input.findings)) {
    return [...problems, 'Expected an object with a "findings" array (it may be empty).'];
  }
  input.findings.forEach((finding, index) => {
    const label = `findings[${index}]${hasText(finding?.title) ? ` "${finding.title}"` : ''}`;
    const need = (field, why) => { if (!hasText(finding?.[field])) problems.push(`${label}: "${field}" is required${why ? ` (${why})` : ''}.`); };
    if (!hasText(finding?.title)) problems.push(`${label}: "title" is required.`);
    if (!SEVERITY_ORDER.includes(finding?.severity)) {
      problems.push(`${label}: "severity" must be one of ${SEVERITY_ORDER.join(', ')}.`);
    } else if (finding.severity === 'critical') {
      need('evidence', 'a concrete input or state that fails, and the wrong result');
      if (!hasText(finding.recommendation) && !hasText(finding.verify)) problems.push(`${label}: give a "recommendation" or something to "verify".`);
    } else if (finding.severity === 'design') {
      need('verify', 'the one specific thing the developer should check');
    } else {
      need('recommendation');
    }
    const disposition = finding?.disposition ?? 'needs-decision';
    if (!DISPOSITIONS.includes(disposition)) problems.push(`${label}: "disposition" must be one of ${DISPOSITIONS.join(', ')}.`);
    else if (disposition !== 'needs-decision' && !MAY_FIX[agent]) {
      problems.push(`${label}: the ${agent} is report-only, so "${disposition}" is not allowed.`);
    }
    if (disposition === 'auto-fixed') need('fixNote', 'what was changed');
    if (finding?.confidence !== undefined && !CONFIDENCES.includes(finding.confidence)) {
      problems.push(`${label}: "confidence" must be one of ${CONFIDENCES.join(', ')}.`);
    }
    if (finding?.line !== undefined && finding.line !== null && !(Number.isInteger(finding.line) && finding.line > 0)) {
      problems.push(`${label}: "line" must be a positive whole number (the line in the new version of the file).`);
    }
    if (finding?.criteria !== undefined) {
      if (!Array.isArray(finding.criteria)) problems.push(`${label}: "criteria" must be a list of acceptance-criterion ids.`);
      else if (criteriaIds) {
        for (const id of finding.criteria) {
          if (!criteriaIds.includes(String(id))) problems.push(`${label}: criterion "${id}" is not in the ticket (known: ${criteriaIds.join(', ') || 'none'}).`);
        }
      }
    }
  });
  list(input.clean).forEach((entry, index) => {
    if (typeof entry !== 'string' && !hasText(entry?.area)) problems.push(`clean[${index}]: "area" is required.`);
  });
  list(input.dismissed).forEach((entry, index) => {
    if (!hasText(entry?.reason)) problems.push(`dismissed[${index}]: "reason" is required.`);
  });
  return problems;
}

function normalizeFinding(finding, id) {
  const normalized = {
    id,
    severity: finding.severity,
    disposition: finding.disposition ?? 'needs-decision',
    title: finding.title.trim(),
    ...(hasText(finding.rule) ? { rule: finding.rule.trim() } : {}),
    locations: locationsOf(finding),
    ...(hasText(finding.flaggedText) ? { flaggedText: finding.flaggedText } : {}),
    ...(hasText(finding.evidence) ? { evidence: finding.evidence.trim() } : {}),
    ...(hasText(finding.verify) ? { verify: finding.verify.trim() } : {}),
    ...(hasText(finding.recommendation) ? { recommendation: finding.recommendation.trim() } : {}),
    criteria: list(finding.criteria).map(String),
    ...(finding.confidence ? { confidence: finding.confidence } : {}),
    ...(hasText(finding.fixNote) ? { fixNote: finding.fixNote.trim() } : {}),
    ...(hasText(finding.voiceLine) ? { voiceLine: finding.voiceLine.trim() } : {}),
  };
  return normalized;
}

/** Builds the saved report: validated findings sorted critical first, numbered per agent, with counts and coverage. */
export function buildFindingsReport(input, { agent, tool, coverage, base, head, now = new Date(), criteriaIds } = {}) {
  const problems = validateAgentFindings(input, { agent, criteriaIds });
  if (problems.length) throw new Error(`Invalid findings:\n- ${problems.join('\n- ')}`);

  const sorted = input.findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity) || a.index - b.index)
    .map(({ finding }) => finding);
  const findings = sorted.map((finding, index) => normalizeFinding(finding, `${AGENT_PREFIX[agent]}-${index + 1}`));

  const count = (predicate) => findings.filter(predicate).length;
  return {
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    agent,
    tool,
    generatedAt: now.toISOString(),
    ...(base ? { base } : {}),
    ...(head ? { head } : {}),
    coverage: coverage ?? null,
    counts: {
      critical: count((f) => f.severity === 'critical'),
      design: count((f) => f.severity === 'design'),
      minor: count((f) => f.severity === 'minor'),
      needsDecision: count((f) => f.disposition === 'needs-decision'),
      autoFixed: count((f) => f.disposition === 'auto-fixed'),
      wouldAutoFix: count((f) => f.disposition === 'would-auto-fix'),
    },
    findings,
    clean: list(input.clean).map((entry) => (typeof entry === 'string' ? { area: entry, note: '' } : { area: entry.area, note: entry.note ?? '' })),
    dismissed: list(input.dismissed),
  };
}

/**
 * Converts Bug Hunter's own findings file (probable_bugs, suspicious, clean, dismissed_script_findings) into agent input,
 * so the Analyst can keep using the format Bug Hunter already documents.
 */
export function fromBugHunter(input) {
  const convert = (severity) => (finding) => ({
    severity,
    title: finding.title,
    rule: finding.rule,
    file: finding.file,
    line: finding.line,
    flaggedText: finding.snippet,
    evidence: [finding.summary, finding.scenario].filter(hasText).join(' ') || undefined,
    verify: finding.check,
    recommendation: finding.recommendation,
    disposition: finding.autoFixed ? 'auto-fixed' : 'needs-decision',
    fixNote: finding.fixNote,
    criteria: finding.criteria,
    confidence: finding.confidence,
    voiceLine: finding.voiceLine,
  });
  return {
    findings: [...list(input.probable_bugs).map(convert('critical')), ...list(input.suspicious).map(convert('design'))],
    clean: list(input.clean),
    dismissed: list(input.dismissed_script_findings).map((entry) => ({ ...entry, reason: entry.reason })),
  };
}
