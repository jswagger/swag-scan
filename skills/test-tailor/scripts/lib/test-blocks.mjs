// Finds the test functions in one Python, JavaScript or TypeScript test file and turns what is wrong with the ones
// touched by the diff into leads. Pure: source text in, plain objects out. Only tests that contain an added line are judged.

const language = (path) => (/\.py$/i.test(path) ? 'Python' : /\.[cm]?tsx?$/i.test(path) ? 'TypeScript' : /\.[cm]?jsx?$/i.test(path) ? 'JavaScript' : undefined);

const stripStringsAndComments = (line) => line
  .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
  .replace(/\/\/.*$/, '')
  .replace(/#.*$/, '');

function braceDelta(line) {
  const code = stripStringsAndComments(line);
  return (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
}

const JS_TEST = /^\s*(?:it|test)(?:\.(?:only|skip|concurrent|todo))?(?:\.each\s*(?:\([^)]*\)|`[^`]*`))?\s*\(/;
const JS_HOOK = /^\s*(?:beforeEach|beforeAll|afterEach|afterAll)\s*\(/;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_HOOK_NAME = /^(?:setUp|setUpClass|setup_method|setup_class|setup_function|setup_module)$/;

const firstString = (text) => text.match(/(['"`])((?:\\.|(?!\1).)*)\1/)?.[2];

/** Test and hook blocks of a JS or TS file: { kind, name, startLine, endLine, lines } with 1-based lines. */
function jsBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const isTest = JS_TEST.test(lines[index]);
    const isHook = !isTest && JS_HOOK.test(lines[index]);
    if (!isTest && !isHook) continue;
    let open = index;
    while (open < lines.length && open <= index + 8 && !stripStringsAndComments(lines[open]).includes('{')) open += 1;
    const firstCode = stripStringsAndComments(lines[index]);
    const oneLiner = open > index + 8 || open >= lines.length || (/\)\s*;?\s*$/.test(firstCode.trimEnd()) && !firstCode.includes('{'));
    let end = index;
    if (!oneLiner) {
      let depth = 0;
      for (end = open; end < lines.length; end += 1) {
        depth += braceDelta(lines[end]);
        if (depth <= 0) break;
      }
      end = Math.min(end, lines.length - 1);
    }
    const header = lines.slice(index, Math.min(index + 3, lines.length)).join(' ');
    blocks.push({
      kind: isHook ? 'hook' : 'test',
      name: isHook ? lines[index].trim().split('(')[0] : firstString(header) ?? '(unnamed)',
      startLine: index + 1,
      endLine: end + 1,
      lines: lines.slice(index, end + 1),
    });
    if (!isHook) index = end; // tests do not nest; a describe block holds them, hooks are skipped past too
  }
  return blocks;
}

/** Test functions and setup hooks of a Python file, found by indentation. */
function pythonBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(PY_DEF);
    if (!match) continue;
    const [, indent, name] = match;
    const fixture = lines.slice(Math.max(0, index - 3), index).some((line) => /^\s*@(?:pytest\.)?fixture\b/.test(line));
    const kind = PY_HOOK_NAME.test(name) || fixture ? 'hook' : /^test/.test(name) ? 'test' : undefined;
    if (!kind) continue;
    let end = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim()) continue;
      if (lines[next].length - lines[next].trimStart().length <= indent.length) break;
      end = next;
    }
    blocks.push({ kind, name, startLine: index + 1, endLine: end + 1, lines: lines.slice(index, end + 1) });
    index = end;
  }
  return blocks;
}

const isComment = (line) => /^\s*(?:\/\/|\/\*|\*|#)/.test(line);

/** Counts assertions and the trivial ones (they pass for almost any value), by language. */
export function countAssertions(blockLines, lang) {
  let total = 0;
  let trivial = 0;
  for (const line of blockLines) {
    if (isComment(line)) continue;
    if (lang === 'Python') {
      if (/^\s*assert\b/.test(line)) {
        total += 1;
        if (/^\s*assert\s+(?:not\s+)?[\w.]+\s*(?:,.*)?$/.test(line) || /^\s*assert\s+.+\s+is\s+not\s+None\s*(?:,.*)?$/.test(line)) trivial += 1;
      }
      const methods = [...line.matchAll(/\bself\.(assert\w*)\s*\(([^)]*)\)/g)];
      for (const [, name, args] of methods) {
        total += 1;
        if (name === 'assertIsNotNone' || (name === 'assertTrue' && /^\s*[\w.]+\s*$/.test(args))) trivial += 1;
      }
      total += (line.match(/\bpytest\.raises\b|\.assert_\w+\s*\(|\bassertRaises\b/g) ?? []).length;
    } else {
      const expects = (line.match(/\bexpect\s*\(/g) ?? []).length;
      total += expects;
      if (expects && /\)\s*\.\s*(?:not\s*\.\s*)?(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeNull)\s*\(\s*\)/.test(line)) trivial += expects;
      else if (expects && /typeof\s+[^)]+\)\s*\.\s*toBe\s*\(\s*['"]function['"]/.test(line)) trivial += expects;
      const nodeAsserts = (line.match(/\bassert(?:\.\w+)?\s*\(/g) ?? []).length;
      total += nodeAsserts;
      if (nodeAsserts && /\bassert(?:\.ok)?\s*\(\s*[\w.$]+\s*\)/.test(line)) trivial += nodeAsserts;
    }
    total += (line.match(/(?<![.\w])(?:assert|verify|check|expect)[A-Z_]\w*\s*\(/g) ?? []).length; // a helper function that asserts for the test
  }
  return { total, trivial };
}

/** Non-blank, non-comment lines before the first assertion. */
function setupLineCount(blockLines, lang) {
  let count = 0;
  for (const line of blockLines.slice(1)) {
    if (countAssertions([line], lang).total > 0) break;
    if (line.trim() && !isComment(line)) count += 1;
  }
  return count;
}

const normalize = (blockLines) => blockLines.slice(1)
  .filter((line) => !isComment(line))
  .join('\n')
  .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '#')
  .replace(/\b\d+(?:\.\d+)?\b/g, '#')
  .replace(/\s+/g, ' ')
  .trim();

// Words that look like a ticket ID but are not one.
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'MD', 'TLS', 'SSL', 'HTTP', 'TCP', 'UDP', 'RFC', 'ES', 'ECMA', 'IPV', 'X', 'CRC', 'AES', 'RSA', 'BASE', 'UTC', 'GMT', 'PEP', 'COVID']);
function ticketMention(text) {
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) {
    if (!NOT_TICKETS.has(match[1])) return match[0];
  }
  return text.match(/\b(?:ticket|acceptance criteri(?:on|a))\b/i)?.[0];
}

const stem = (path) => path.split('/').pop().replace(/\.(?:test|spec)\.[^.]+$/, '').replace(/^test_/, '').replace(/_test\.py$/, '').replace(/\.[^.]+$/, '');

function overMockedLines(lines, lang, path, added) {
  const under = stem(path);
  const leads = [];
  lines.forEach((line, index) => {
    if (!added.has(index + 1)) return;
    const target = lang === 'Python'
      ? line.match(/\bpatch(?:\.object)?\s*\(\s*['"]([\w.]+)['"]/)?.[1]
      : line.match(/\b(?:jest|vi)\.mock\s*\(\s*['"]([^'"]+)['"]/)?.[1];
    if (!target || !under) return;
    const segments = target.split(lang === 'Python' ? '.' : '/').map((segment) => segment.replace(/\.[cm]?[jt]sx?$/, ''));
    const hit = lang === 'Python' ? segments.slice(0, -1).includes(under) : segments.at(-1) === under;
    if (!hit) return;
    leads.push({
      ruleId: 'TT-109',
      severity: 'loose',
      path,
      line: index + 1,
      priority: 'high',
      description: `The test file mocks the module it tests (${under}); the test may only be checking the mock`,
      evidence: line.trim().slice(0, 240),
    });
  });
  return leads;
}

function duplicateLiterals(lines, lang, path, added, minLines) {
  const seen = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:(?:const|let|var)\s+)?[\w$]+\s*(?::[^=]+)?=\s*[{[]\s*$/.test(lines[index])) continue;
    let depth = 0;
    let end = index;
    for (; end < lines.length; end += 1) {
      const code = stripStringsAndComments(lines[end]);
      depth += (code.match(/[{[(]/g) ?? []).length - (code.match(/[}\])]/g) ?? []).length;
      if (depth <= 0) break;
    }
    if (end >= lines.length || end - index + 1 < minLines) continue;
    const text = lines.slice(index + 1, end + 1).map((line) => line.trim()).join(' ');
    const entry = seen.get(text) ?? { starts: [], touched: false, text };
    entry.starts.push(index + 1);
    for (let line = index + 1; line <= end + 1; line += 1) if (added.has(line)) entry.touched = true;
    seen.set(text, entry);
    index = end;
  }
  return [...seen.values()].filter((entry) => entry.starts.length >= 2 && entry.touched).map((entry) => ({
    ruleId: 'TT-106',
    severity: 'excessive',
    path,
    line: entry.starts[0],
    occurrenceCount: entry.starts.length,
    description: `The same ${entry.text.length > 0 ? 'fixture' : 'literal'} is written out ${entry.starts.length} times in this test file; share one`,
    evidence: entry.text.slice(0, 240),
  }));
}

/**
 * @returns {{ language?: string, tests: object[], leads: object[] }} `tests` lists every test the diff touched, with its
 * assertion counts, so the reviewing agent can tell the good ones from the weak ones. `leads` are the candidates.
 */
export function analyzeTestFile({ path, source, addedLines, thresholds = {} }) {
  const lang = language(path);
  if (!lang) return { language: undefined, tests: [], leads: [] };
  const lines = source.split(/\r?\n/);
  const blocks = lang === 'Python' ? pythonBlocks(lines) : jsBlocks(lines);
  const touches = (block) => [...addedLines].some((line) => line >= block.startLine && line <= block.endLine);
  const leads = [];
  const tests = [];
  const maxSetup = thresholds.maxSetupLines ?? 15;
  const maxHook = thresholds.maxHookLines ?? 25;
  const lead = (block, ruleId, severity, description, evidence, extra = {}) => leads.push({
    ruleId, severity, path, line: block.startLine, test: block.name, description, evidence: evidence.slice(0, 240), ...extra,
  });

  for (const block of blocks.filter((candidate) => candidate.kind === 'hook' && touches(candidate))) {
    const size = block.lines.filter((line) => line.trim() && !isComment(line)).length;
    if (size > maxHook) lead(block, 'TT-104', 'loose', `Setup hook "${block.name}" is ${size} lines; every test pays for it, so check each test needs all of it`, block.lines[0].trim());
  }

  const touched = blocks.filter((block) => block.kind === 'test' && touches(block));
  for (const block of touched) {
    const { total, trivial } = countAssertions(block.lines, lang);
    const setup = setupLineCount(block.lines, lang);
    tests.push({ path, language: lang, name: block.name, line: block.startLine, endLine: block.endLine, assertions: total, trivialAssertions: trivial, setupLines: setup });
    const skipped = /\.(?:skip|todo)\b|@(?:pytest\.mark\.skip|unittest\.skip)/.test(block.lines[0]);
    if (total === 0 && !skipped) lead(block, 'TT-101', 'loose', 'Test has no assertion, so it passes unless the code throws', block.lines.slice(0, 3).join(' ').trim());
    else if (total > 0 && trivial === total) lead(block, 'TT-102', 'loose', 'Every assertion only checks that a value exists or is truthy; assert the actual behavior', block.lines.filter((line) => /expect|assert/.test(line)).join(' ').trim());
    if (setup > maxSetup) lead(block, 'TT-103', 'loose', `${setup} lines of setup before the first assertion; most of it may not matter to what is checked`, block.lines[0].trim(), { setupLines: setup });
    const mention = ticketMention(block.lines.join('\n'));
    if (mention) lead(block, 'TT-108', 'ticket', `The test mentions "${mention}"; if it only verifies one ticket's work, it may not be worth keeping after the ticket ships`, block.lines.slice(0, 2).join(' ').trim());
  }

  // A new test is compared with every test in the file, so a copy of an old one is found too.
  const groups = new Map();
  for (const block of blocks.filter((candidate) => candidate.kind === 'test')) {
    const body = normalize(block.lines);
    if (body.length < 40) continue;
    groups.set(body, [...(groups.get(body) ?? []), block]);
  }
  for (const group of groups.values()) {
    const changed = group.find(touches);
    if (group.length < 2 || !changed) continue;
    lead(changed, 'TT-105', 'excessive', group.length >= 3
      ? `${group.length} tests have near-identical bodies; condense them into one table-driven test`
      : 'Another test in this file has the same shape and checks; merge them or drop one', changed.lines.slice(0, 3).join(' ').trim(), { occurrenceCount: group.length });
  }

  leads.push(...duplicateLiterals(lines, lang, path, addedLines, thresholds.minDuplicateLiteralLines ?? 3));
  leads.push(...overMockedLines(lines, lang, path, addedLines));
  return { language: lang, tests, leads };
}
