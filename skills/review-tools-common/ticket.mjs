// Ticket handling shared by the review tools: find the ticket file, parse it tolerantly, and hand reviewers
// only what they should see (the description and the acceptance criteria), never a development log.
// The assumed ticket format is documented in docs/REFERENCE.md ("Ticket files").

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const TICKET_ID = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TICKET_EXTENSIONS = ['.xml', '.csv', '.md', '.txt'];
const UNREADABLE_EXTENSIONS = ['.xls', '.xlsx', '.doc', '.docx'];

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
    : settings.ticketSourcePath ? { path: settings.ticketSourcePath, source: 'user settings' }
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

export function findUnreadableTicket(folder, id) {
  if (!existsSync(folder)) return undefined;
  const wanted = id.toLowerCase();
  return readdirSync(folder).sort().find((name) =>
    UNREADABLE_EXTENSIONS.some((extension) => name.toLowerCase() === `${wanted}${extension}`));
}

export function unreadableTicketMessage(fileName, id) {
  return `${fileName} is a Word or Excel export, which Swag Scan cannot read (it uses no third-party libraries). In Jira, open the ticket, choose Export, then Export XML, and save it as ${id}.xml in the same folder. (A CSV exported from a search works too.)`;
}

/** Looks like a path rather than a bare ticket name. */
export function looksLikePath(value) {
  return /[\\/]/.test(value) || [...TICKET_EXTENSIONS, ...UNREADABLE_EXTENSIONS].some((extension) => value.toLowerCase().endsWith(extension));
}

export class TicketFileError extends Error {}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function parseCsv(text) {
  return parseCsvRows(text);
}

export function csvToTicketMarkdown(text, id) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new TicketFileError('This CSV has no ticket data.');
  const headers = rows.shift().map((value) => value.trim());
  const keyIndex = headers.findIndex((value) => /^issue key$/i.test(value));
  let record = rows[0];
  if (id && keyIndex >= 0) record = rows.find((row) => (row[keyIndex] ?? '').trim().toLowerCase() === id.toLowerCase()) ?? record;
  if (!record) throw new TicketFileError(`No issue matching ${id} was found in this CSV.`);
  const value = (name) => record[headers.findIndex((header) => new RegExp(`^${name}$`, 'i').test(header))] ?? '';
  const summary = value('summary').trim();
  const description = value('description').trim();
  const acceptanceHeader = headers.findIndex((header) => /acceptance/i.test(header));
  const acceptance = acceptanceHeader >= 0 ? (record[acceptanceHeader] ?? '').trim() : '';
  const key = keyIndex >= 0 ? (record[keyIndex] ?? '').trim() : id ?? '';
  const lines = [`# ${[key, summary].filter(Boolean).join(': ') || 'Ticket'}`];
  if (description) lines.push('', '## Description', '', description);
  if (acceptance) {
    const bullets = acceptance.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((line) => `- ${line.replace(/^(?:[*#-]|\d+[.)])\s*/, '')}`);
    lines.push('', '## Acceptance Criteria', '', ...bullets);
  }
  return lines.join('\n');
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, decimal, hex, name) => {
    if (decimal || hex) {
      const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html) {
  const lists = [];
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n### ')
    .replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (_, close, tag) => {
      const name = tag.toLowerCase();
      if (name === 'li') {
        if (close) return '\n';
        const list = lists.at(-1);
        if (!list) return '\n- ';
        list.count += 1;
        return `\n${' '.repeat(lists.length - 1)}${list.ordered ? `${list.count}. ` : '- '}`;
      }
      if (!close) {
        lists.push({ ordered: name === 'ol', count: 0 });
        return '\n';
      }
      lists.pop();
      return lists.length ? '\n' : '\n\n';
    })
    .replace(/<\/(?:p|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<\/(?:div|tr|table|pre)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^(\s*(?:- |\d+\. ).*)\n\n(?=\s*(?:- |\d+\. ))/gm, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function richText(raw = '') {
  const trimmed = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(trimmed);
  if (cdata) return htmlToText(cdata[1]);
  if (/<[a-z/]/i.test(trimmed)) return htmlToText(trimmed);
  return htmlToText(decodeEntities(trimmed));
}

const elementText = (block, name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block)?.[1];
const IGNORED_BLOCKS = /<(comments|customfields|attachments|issuelinks|subtasks|labels|components|fixVersion|version)\b[\s\S]*?<\/\1>/gi;

function markAcceptanceHeading(text) {
  return text.split('\n').map((line) =>
    /^\W*acceptance criteria\W*$/i.test(line) ? '\n### Acceptance Criteria\n' : line
  ).join('\n').replace(/\n{3,}/g, '\n\n');
}

function toBullet(line) {
  return `- ${line.replace(/^(?:[*#-]|\d+[.)])\s*/, '').trim()}`;
}

function criteriaLines(text) {
  const out = [];
  let seenList = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = /^(\s*)(?:- |\d+\. )(.*)$/.exec(line);
    if (item) {
      seenList = true;
      out.push(item[1] ? `${item[1]}- ${item[2]}` : toBullet(line));
    } else if (seenList && /:\s*$/.test(line) && line.length < 60) {
      const title = line.replace(/^\W+|[:\s]+$/g, '');
      out.push(`\n## ${title}\n`);
    } else {
      out.push(toBullet(line));
    }
  }
  return out;
}

export function jiraXmlToTicketMarkdown(text, id) {
  const items = text.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  if (!items.length) throw new TicketFileError('This does not look like a Jira XML export (no issue found in it). In Jira, open the ticket and choose Export, then Export XML.');
  const keyOf = (item) => decodeEntities((elementText(item.replace(IGNORED_BLOCKS, ''), 'key') ?? '').trim());
  let item = id ? items.find((entry) => keyOf(entry).toLowerCase() === id.toLowerCase()) : undefined;
  if (!item && items.length === 1) [item] = items;
  if (!item) throw new TicketFileError(`${id} is not in this XML, which holds ${items.length} issues. Check the ticket ID or export just that ticket.`);

  const head = item.replace(IGNORED_BLOCKS, '');
  const key = keyOf(item) || id || '';
  const titleText = decodeEntities((elementText(head, 'title') ?? '').trim()).replace(/^\[[^\]]*\]\s*/, '');
  const summary = decodeEntities((elementText(head, 'summary') ?? '').trim()) || titleText;
  const description = markAcceptanceHeading(richText(elementText(head, 'description')));
  const criteria = [];
  for (const field of item.match(/<customfield\b[\s\S]*?<\/customfield>/gi) ?? []) {
    if (!/acceptance/i.test(decodeEntities(elementText(field, 'customfieldname') ?? ''))) continue;
    for (const value of field.match(/<customfieldvalue\b[\s\S]*?<\/customfieldvalue>/gi) ?? []) {
      criteria.push(...criteriaLines(richText(elementText(value, 'customfieldvalue'))));
    }
  }
  const lines = [`# ${[key, summary].filter(Boolean).join(': ') || 'Ticket'}`];
  if (description) lines.push('', '## Description', '', description);
  if (criteria.length) lines.push('', '## Acceptance Criteria', '', ...criteria);
  return lines.join('\n');
}

export function readTicketText(path) {
  const extension = extname(path).toLowerCase();
  const id = TICKET_ID.exec(basename(path))?.[1];
  if (UNREADABLE_EXTENSIONS.includes(extension)) {
    throw new TicketFileError(unreadableTicketMessage(basename(path), id ?? basename(path, extname(path))));
  }
  const text = readFileSync(path, 'utf8');
  if (extension === '.xml') return jiraXmlToTicketMarkdown(text, id);
  if (extension === '.csv') return csvToTicketMarkdown(text, id);
  return text;
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

/** Splits lines into runs of table rows. Each table has its own header, so two tables are never read as one. */
function tableBlocks(lines) {
  const blocks = [];
  let current;
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      if (!current) blocks.push((current = []));
      current.push(line);
    } else if (line.trim()) current = undefined; // text between tables ends a table; blank lines do not
  }
  return blocks;
}

/** Table rows (any column order, any subset of columns), else bullets, numbered items and checkboxes. */
export function parseCriteria(lines) {
  const fromTables = tableBlocks(lines).flatMap((block) => {
    const table = tableRows(block);
    const columns = table && columnMap(table.header);
    if (!columns || (columns.title === undefined && columns.description === undefined)) return [];
    return table.body.map((row, index) => ({
      id: row[columns.id] || String(index + 1),
      title: row[columns.title] ?? '',
      description: row[columns.description] ?? '',
      repository: row[columns.repository] || undefined,
      status: columns.status !== undefined ? normalizeStatus(row[columns.status]) : 'Todo',
    }));
  });
  if (fromTables.length) return fromTables;
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

const simplify = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Splits criteria into those for the repository being scanned and those for other repositories. A criterion with no
 * repository applies everywhere. When no criterion names this repository, nothing is filtered: we cannot tell which are ours.
 */
export function scopeCriteria(criteria, repoName) {
  const mine = simplify(repoName);
  const matches = (row) => {
    const theirs = simplify(row.repository);
    return Boolean(mine && theirs && (theirs.includes(mine) || mine.includes(theirs)));
  };
  const nameThisRepo = criteria.some((row) => row.repository && matches(row));
  return criteria.map((row) => ({ ...row, otherRepo: Boolean(nameThisRepo && row.repository && !matches(row)) }));
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
