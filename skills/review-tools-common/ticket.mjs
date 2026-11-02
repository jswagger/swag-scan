// Ticket handling shared by the review tools: find the ticket file, parse it tolerantly, and hand reviewers
// only what they should see (the description and the acceptance criteria), never a development log.
// The assumed ticket format is documented in the root README ("Ticket files").

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const TICKET_ID = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TICKET_EXTENSIONS = ['.md', '.txt'];

/** "feature/PROJ-123-add-login" gives "PROJ-123". Jira-style keys only, so "bugfix-2" is not a ticket. */
export function ticketIdFromBranch(branch) {
  return TICKET_ID.exec(branch ?? '')?.[1];
}

function expandHome(path, home) {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path;
}

/** User-level settings live outside the repo: $SWAG_SCAN_SETTINGS, else ~/.swag-scan/settings.json. */
export function loadUserSettings(env = process.env, home = homedir()) {
  const path = env.SWAG_SCAN_SETTINGS ? resolve(env.SWAG_SCAN_SETTINGS) : join(home, '.swag-scan', 'settings.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Ticket folder precedence: --ticket-dir, $SWAG_SCAN_TICKET_DIR, the user settings file, then the repo config. No default path. */
export function resolveTicketFolder({ flag, env = process.env, home = homedir(), userSettings, repoPath } = {}) {
  const settings = userSettings ?? loadUserSettings(env, home);
  const choice = flag ? { path: flag, source: '--ticket-dir' }
    : env.SWAG_SCAN_TICKET_DIR ? { path: env.SWAG_SCAN_TICKET_DIR, source: 'SWAG_SCAN_TICKET_DIR' }
    : settings.ticketFolder ? { path: settings.ticketFolder, source: 'user settings' }
    : repoPath ? { path: repoPath, source: 'repo config' }
    : undefined;
  return choice && { ...choice, path: resolve(expandHome(choice.path, home)) };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Finds `<id>.md` or `<id>.txt` (any letter case), then `<id>-anything.md`. */
export function findTicketFile(folder, id) {
  if (!existsSync(folder)) return undefined;
  const names = readdirSync(folder).sort();
  const wanted = id.toLowerCase();
  const exact = names.find((name) => TICKET_EXTENSIONS.some((extension) => name.toLowerCase() === `${wanted}${extension}`));
  const prefixed = names.find((name) => {
    const lower = name.toLowerCase();
    return lower.startsWith(wanted) && /^[^a-z0-9]/.test(lower.slice(wanted.length)) && TICKET_EXTENSIONS.some((extension) => lower.endsWith(extension));
  });
  const name = exact ?? prefixed;
  return name && join(folder, name);
}

/** Looks like a path rather than a bare ticket name. */
export function looksLikePath(value) {
  return /[\\/]/.test(value) || TICKET_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension));
}

// --- parsing ---------------------------------------------------------------------------------------------

function classify(title) {
  const text = title.toLowerCase();
  if (/acceptance|criteria/.test(text)) return 'criteria';
  if (/repositor|\brepos\b/.test(text)) return 'repositories';
  // A log describes what was built, which biases a review. Never passed on.
  if (/implementation|development|\bdev\b|work log|progress|changelog|\bnotes?\b|\blog\b|status update|history|comments?/.test(text)) return 'log';
  if (/description|summary|overview|background|context|problem|goal|requirement|user stor|details/.test(text)) return 'description';
  return 'other';
}

/** Splits markdown into { title, sections: [{ heading, kind, level, lines }] }. */
export function splitSections(text) {
  const sections = [{ heading: '', kind: 'description', level: 0, lines: [] }];
  let title;
  const parents = [];
  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (!match) {
      sections.at(-1).lines.push(line);
      continue;
    }
    const level = match[1].length;
    const heading = match[2];
    if (!title && level === 1 && sections.length === 1 && sections[0].lines.every((entry) => !entry.trim())) {
      title = heading;
      continue;
    }
    while (parents.length && parents.at(-1).level >= level) parents.pop();
    let kind = classify(heading);
    if (kind === 'other' && parents.length) kind = parents.at(-1).kind; // "### Details" under "## Description"
    const section = { heading, kind, level, lines: [] };
    sections.push(section);
    if (kind !== 'other' || parents.length === 0) parents.push(section);
  }
  return { title, sections };
}

const cleanCell = (cell) => cell.trim().replace(/^`|`$/g, '');

function tableRows(lines) {
  const rows = lines.filter((line) => line.trim().startsWith('|')).map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map(cleanCell));
  if (rows.length < 2) return undefined;
  const header = rows[0].map((cell) => cell.toLowerCase());
  const body = rows.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === ''));
  return { header, body };
}

const COLUMN_NAMES = {
  id: ['#', 'id', 'no', 'no.', 'ac', 'key'],
  title: ['title', 'name', 'summary', 'criterion', 'criteria'],
  description: ['description', 'details', 'detail', 'requirement', 'expected'],
  repository: ['repository', 'repo', 'repositories', 'repos'],
  branch: ['branch', 'feature branch'],
  base: ['base', 'base ref', 'base branch', 'target'],
  status: ['status', 'state'],
};

function columnMap(header) {
  const map = {};
  for (const [field, names] of Object.entries(COLUMN_NAMES)) {
    const index = header.findIndex((cell) => names.includes(cell));
    if (index !== -1) map[field] = index;
  }
  return map;
}

export function normalizeStatus(value = '') {
  const text = value.toLowerCase();
  if (value.includes('✅') || /\b(done|complete|completed|finished|closed)\b/.test(text)) return 'Done';
  if (value.includes('🔮') || /\b(future|later|backlog|deferred|out of scope)\b/.test(text)) return 'Future';
  if (value.includes('🔲') || /\b(todo|to do|open|not started|pending)\b/.test(text) || value === '') return 'Todo';
  return 'Todo';
}

/** Table rows (any column order, any subset of columns), else bullets, numbered items and checkboxes. */
export function parseCriteria(lines) {
  const table = tableRows(lines);
  if (table) {
    const columns = columnMap(table.header);
    if (columns.title !== undefined || columns.description !== undefined) {
      return table.body.map((row, index) => ({
        id: row[columns.id] || String(index + 1),
        title: row[columns.title] ?? '',
        description: row[columns.description] ?? '',
        repository: row[columns.repository] || undefined,
        status: columns.status !== undefined ? normalizeStatus(row[columns.status]) : 'Todo',
      }));
    }
  }
  const items = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
    if (!match) continue;
    const text = match[1].trim();
    const labelled = /^(?:\*\*)?([A-Za-z]{1,4}-?\d+)(?:\*\*)?\s*[:.)-]\s*(.+)$/.exec(text);
    items.push({
      id: labelled?.[1] ?? String(items.length + 1),
      title: '',
      description: labelled?.[2] ?? text,
      repository: undefined,
      status: /\[[xX]\]/.test(line) ? 'Done' : 'Todo',
    });
  }
  return items;
}

/** One entry per repository: name, plus optional branch and base ref. Tolerates tables, bullets and "name (branch, base x)". */
export function parseRepositories(lines) {
  const table = tableRows(lines);
  if (table) {
    const columns = columnMap(table.header);
    if (columns.repository !== undefined || columns.title !== undefined) {
      const nameIndex = columns.repository ?? columns.title;
      return table.body.filter((row) => row[nameIndex]).map((row) => ({
        name: row[nameIndex],
        ...(row[columns.branch] ? { branch: row[columns.branch] } : {}),
        ...(row[columns.base] ? { baseRef: row[columns.base] } : {}),
      }));
    }
  }
  const repositories = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
    if (!match) continue;
    const text = match[1].trim().replace(/`/g, '').replace(/\*\*/g, '');
    let name = text;
    let rest;
    let found;
    if ((found = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(text))) [, name, rest] = found;
    else if ((found = /^(.+?)\s+(?:@|->|→)\s+(.+)$/.exec(text))) [, name, rest] = found;
    else if ((found = /^([^\s:]+)\s*:\s+(.+)$/.exec(text))) [, name, rest] = found;
    const entry = { name: name.trim() };
    if (rest) {
      const base = /\bbase(?:\s*ref)?\s*[:=]?\s*(\S+)/i.exec(rest);
      if (base) entry.baseRef = base[1].replace(/[,;]$/, '');
      const branch = rest.replace(/\bbase(?:\s*ref)?\s*[:=]?\s*\S+/i, '').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/^branch\s*[:=]?\s*/i, '');
      if (branch) entry.branch = branch;
    }
    repositories.push(entry);
  }
  return repositories;
}

const withoutBlank = (lines) => lines.join('\n').trim();

/**
 * Parses a ticket file. `review` is the only text reviewers receive: title, description and acceptance
 * criteria. Anything else (implementation or development logs, notes, other sections) is dropped and listed
 * in `omittedSections`. A file with no recognizable headings is passed whole, with a note.
 */
export function parseTicket(text) {
  const { title, sections } = splitSections(text);
  const kinds = new Set(sections.slice(1).map((section) => section.kind));
  const recognized = kinds.has('criteria') || kinds.has('description') || kinds.has('repositories') || kinds.has('log');
  const notes = [];

  if (!recognized && sections.length === 1) {
    notes.push('The ticket has no recognizable headings, so the whole file is passed on as the requirements.');
    return { title, description: text.trim(), acceptanceCriteria: parseCriteria(text.split(/\r?\n/)), repositories: [], omittedSections: [], review: text.trim(), notes };
  }

  const pick = (kind) => sections.filter((section) => section.kind === kind);
  // A subsection that inherited "description" from its parent keeps its own heading as a label.
  const describe = (section) => (section.heading && classify(section.heading) !== 'description' ? `${section.heading}\n` : '') + withoutBlank(section.lines);
  const description = pick('description').map(describe).filter((entry) => entry.trim()).join('\n\n');
  const criteriaSections = pick('criteria');
  const acceptanceCriteria = criteriaSections.flatMap((section) => parseCriteria(section.lines));
  const criteriaText = criteriaSections.map((section) => withoutBlank(section.lines)).filter(Boolean).join('\n\n');
  const repositories = pick('repositories').flatMap((section) => parseRepositories(section.lines));
  const omittedSections = sections.slice(1).filter((section) => section.kind === 'log' || section.kind === 'other').map((section) => section.heading);

  // Status is deliberately not passed on: it says what was already built, which biases a review.
  const criteriaLines = acceptanceCriteria.length
    ? acceptanceCriteria.map((row) => `- AC ${row.id}${row.title ? ` ${row.title}` : ''}${row.description ? `: ${row.description}` : ''}${row.repository ? ` (repository: ${row.repository})` : ''}`).join('\n')
    : criteriaText;
  const review = [
    title ? `# ${title}` : '',
    description ? `## Description\n\n${description}` : '',
    criteriaLines ? `## Acceptance criteria\n\n${criteriaLines}` : '',
  ].filter(Boolean).join('\n\n');
  if (!description && !criteriaLines) notes.push('The ticket has no description or acceptance criteria section.');
  return { title, description, acceptanceCriteria, repositories, omittedSections, review, notes };
}
